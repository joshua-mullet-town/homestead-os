/**
 * Notification Checker (Layer 1)
 *
 * Lightweight script — no Claude, no MCP. Hits Gmail/Slack/phone APIs directly.
 * Runs every 5 min via scheduler. If nothing new, exits silently.
 * If new notifications found, sends them to the Rooster via walkie-talkie.
 *
 * State file: data/notification-check-state.json
 * Config: data/notification-config.json (VIP list, watched channels, etc.)
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync, writeJsonAtomicSync } = require('./atomic-write');
const http = require('http');
const https = require('https');
// Transport-agnostic message-history store (closes the RCS on-demand thread-read gap).
// The backstop sweep persists messaging bodies too, so RCS/SMS thread history is
// captured even when the real-time ingest push misses (server down, app not pushing).
const messageHistory = require('./message-history-store');
// Sender -> suggested-steward routing (SUGGEST-CONFIRM). Annotates each notification
// with a `suggested_steward` HINT off Alfred's live-read routing table BEFORE it reaches
// Alfred; Alfred still confirms + forwards. Never auto-forwards, never drops. Fail-open:
// suggestSteward returns null (no annotation) if the table is missing/malformed.
const { suggestSteward } = require('./routing-suggester');

const STATE_FILE = path.join(process.cwd(), 'data', 'notification-check-state.json');
// Shared with the real-time push path (app/api/notification-ingest/route.ts) so
// the two cannot drift -- both emit checked_at to the same steward's eye.
const { localStamp } = require('./local-stamp');
// Rolling cap on phone_seen_keys. MUST match SEEN_MAX in
// app/api/notification-ingest/route.ts — the two writers share this one ledger,
// so a disagreement about the bound would let one of them silently truncate the
// other's entries.
const SEEN_MAX = 4000;
const QUEUE_FILE = path.join(require('os').homedir(), '.homestead', 'queue.json');
const GMAIL_CREDS = path.join(require('os').homedir(), '.gmail-mcp', 'credentials.json');
const GMAIL_KEYS = path.join(require('os').homedir(), '.gmail-mcp', 'gcp-oauth.keys.json');
const PHONE_BASE_URL = process.env.PHONE_API_URL || 'http://<<REPLACE: your Tailscale IP>>:8888';
// Short per-endpoint timeout for the PHONE fetch specifically. Josh's phone is on
// flaky cellular, so :8888 can HANG (socket connects but the body never arrives)
// rather than cleanly refuse. The whole job has a 30s SIGKILL budget; a hung phone
// eating the default 10s (plus Gmail's own time) risked the job getting killed →
// job_failure_alert + Gmail also skipped as collateral. Capping the phone fetch at
// 6s means a hung phone is skipped gracefully (returns []) while Gmail still runs.
const PHONE_FETCH_TIMEOUT_MS = Number(process.env.PHONE_FETCH_TIMEOUT_MS) || 6000;
// How many rows of the SMS sent box to sweep per run (Phase 2 outgoing capture). The
// content provider returns newest-first; the store dedupes by content, so re-reading
// the same recent window each run is a cheap no-op after the first pass. 50 covers a
// dense day of sends while keeping the request small.
const SMS_SENT_SWEEP_DEPTH = Number(process.env.SMS_SENT_SWEEP_DEPTH) || 50;

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [NotifCheck] ${msg}`);
}

// Apps to completely ignore (work stuff + system + social noise)
const IGNORED_APPS = new Set([
  'com.microsoft.office.outlook',
  'com.microsoft.teams',
  'com.homestead.mobile',        // Internal Homestead build/system notifications
  'com.tailscale.ipn',           // Tailscale connection status
  'com.snapchat.android',        // Social — personal noise
  'com.facebook.orca',           // Messenger — personal noise
  'com.google.android.googlequicksearchbox',  // Weather/search widgets
  'com.sirma.mobile.bible.android',           // Bible verse of the day
  'com.google.android.calendar', // Calendar reminders — Joshua sees these on his phone
  'com.google.android.apps.weather',  // Weather
  'com.google.android.apps.maps',     // Navigation
  'com.google.android.dialer',        // Ongoing calls — Joshua knows he's on a call
  'com.google.android.gms',           // Google Play Services (sign-in alerts, etc.)
  'com.google.android.odad',          // Play Protect "Running checks on apps" — routine bg security scans, never actionable (all shapes). MUST match ingest route.ts IGNORED_APPS. (Alfred-flagged 2026-07-04.)
  'com.chase.sig.android',            // Chase banking transaction alerts
  'com.google.android.deskclock',     // Alarm clock
  'com.nanit.baby',                   // Baby monitor
  'com.android.systemui',             // System UI (battery, etc.)
  'android',                          // System notifications (USB, charging, data warnings)
  'com.spotify.music',                // Music playback
  'com.linkedin.android',             // LinkedIn notifications
  'com.google.android.permissioncontroller', // Android permission reviews
  'com.android.chrome',              // Chrome video/media notifications
]);

// Slack channel patterns to ignore (<<REPLACE: your employer>> work channels)
const IGNORED_SLACK_PATTERNS = [
  /traci-/i,
  /<<REPLACE: your-employer>>/i,
  /trmi-/i,
  /mi_basecamp/i,
  /treadware/i,
  /^Jira \(bot\)$/i,
  /TRAC-\d+/i,
];

// Stable dedupe key for a phone notification. The Android notification key
// (`n.key`, e.g. "0|com.Slack|25045789|null|1010285") is per-post unique + stable
// = the notification's identity. The OLD key appended `::${text.substring(0,50)}`
// to detect content-reuse — but slicing UTF-8/emoji text by JS char-count produces
// UNSTABLE bytes run-to-run (the phone re-encodes emoji sequences like 🇺🇸 differently
// each pull → mid-grapheme truncation → the composed key drifts → the SAME message
// re-fires every 5 min forever). Fix (Alfred-flagged 2026-07-04): when the android
// key exists, key on it ALONE (stable identity; a genuine content update posts a NEW
// key anyway). Only for the keyless fallback (`pkg:title`) do we add a content signal,
// and we use text LENGTH (byte-stable) not an emoji-sliceable substring.
// MESSAGING EXCEPTION (2026-09-02). The reasoning above holds for ordinary
// notifications but is FALSE for conversations: "a genuine content update posts a
// NEW key anyway" is not true of messaging apps, which reuse ONE notification key
// per thread and update it in place. So keying on the android key alone meant the
// FIRST message in a thread was relayed and every later message in that same thread
// was treated as a duplicate and silently dropped.
//
// That was previously MASKED: the cron overwrote phone_seen_keys from the tray each
// sweep, so a thread's key was evicted within ~5 minutes and the next message got
// through. Making the ledger durable (the merge fix, same day) removed the masking,
// which turns a ~5-minute blind spot into one bounded only by SEEN_MAX — roughly
// SEVEN WEEKS at observed volume. A message never delivered is worse than one
// delivered twice, so the durable ledger must not ship without this.
//
// WHY `timestamp` AND NOT A CONTENT HASH: hashing the text would re-open exactly the
// bug the comment above describes. The phone re-encodes emoji sequences differently
// between pulls, so ANY function of the text — a hash included — drifts run-to-run
// and re-fires the same message forever. `timestamp` is the phone's own per-message
// integer: stable across pulls, and genuinely different for each message in a
// thread. It carries the content signal we need without ever touching the bytes.
//
// SCOPE is deliberately narrow — only notifications the phone itself labels
// `category === 'msg'`. Status-style notifications that legitimately re-post
// identical text keep their bare-key dedupe, which is the behaviour they want.
// Using the phone's own category beats a hardcoded package list: it covers any
// conversation app without needing to enumerate them.
//
// DEGRADES SAFELY: with no usable timestamp we fall through to the bare key, i.e.
// exactly today's behaviour. Never worse than before.
function phoneDedupeKey(n) {
  if (n.key) {
    if (isConversationNotification(n)) {
      const ts = messageStamp(n);
      if (ts) return `${n.key}::msg${ts}`;
    }
    return n.key;
  }
  const baseKey = `${n.packageName || n.app}:${n.title}`;
  return `${baseKey}::len${(n.text || '').length}`;
}

// A conversation notification, per the phone's OWN category field. The tray sends
// category 'msg' for SMS/RCS/chat and 'email' for mail, so this needs no package
// list. Defensive: the field is a string 'None' when absent on some payloads.
function isConversationNotification(n) {
  return (n.category || '') === 'msg';
}

// The phone's per-message timestamp, as a stable string, or null when unusable.
// Values arrive as either a number or a stringified number ('None' when absent).
function messageStamp(n) {
  const raw = n.timestamp;
  if (raw === undefined || raw === null) return null;
  const str = String(raw);
  if (!/^\d+$/.test(str)) return null; // 'None', '', or anything non-numeric
  return str;
}

function isIgnoredNotification(notif) {
  if (IGNORED_APPS.has(notif.app || notif.packageName)) return true;
  // Slack: ignore <<REPLACE: your employer>> workspace channels
  if ((notif.app || notif.packageName) === 'com.Slack') {
    const title = notif.title || '';
    if (IGNORED_SLACK_PATTERNS.some(p => p.test(title))) return true;
  }
  // Generic background-service-status class (Alfred-flagged 2026-07-03): Android
  // foreground-service status posts (e.g. "Messages is doing work in the background",
  // Play Protect "Running checks on apps") are category:"service" + isOngoing + no
  // title — never actionable. Drops the whole class without enumerating each package.
  // MUST stay consistent with app/api/notification-ingest/route.ts isIgnored (the
  // real-time push path) — same rule lives there. (The phone /notifications payload
  // carries category + isOngoing per HomesteadNotificationListener NotificationData.)
  if (notif.category === 'service' && notif.isOngoing && !(notif.title && notif.title.trim())) {
    return true;
  }
  return false;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return {
    gmail_last_check: null,
    gmail_last_history_id: null,
    phone_last_check: null,
    last_run: null,
  };
}

function saveState(state) {
  state.last_run = new Date().toISOString();
  // ATOMIC (2026-09-02): temp+rename. This file is written by TWO processes —
  // this cron and the :3005 notification-ingest route — so a plain writeFileSync
  // can be read half-written by the other. A torn read here is silently
  // destructive: loadState()'s try/catch swallows the parse error and returns
  // defaults, which means an EMPTY phone_seen_keys, which means every
  // notification currently in the tray looks unseen and gets relayed again.
  // (Same reasoning that made every queue.json writer atomic; see atomic-write.js.)
  writeJsonAtomicSync(STATE_FILE, state);
}

// ─── HTTP helpers ────────────────────────────────────────────────────

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.request(url, { timeout: 10000, ...options }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

// ─── Gmail ───────────────────────────────────────────────────────────

// Decode a Gmail payload into readable text. Walks the MIME tree (multipart mail
// keeps real content in nested parts), strips tags and the zero-width padding
// marketing senders use, and collapses whitespace.
function extractGmailBody(payload) {
  const out = [];
  (function walk(part) {
    if (!part) return;
    if (part.body && part.body.data) {
      try { out.push(Buffer.from(part.body.data, 'base64').toString('utf-8')); } catch {}
    }
    (part.parts || []).forEach(walk);
  })(payload);
  return out.join('\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getGmailAccessToken() {
  try {
    const creds = JSON.parse(fs.readFileSync(GMAIL_CREDS, 'utf-8'));
    const keys = JSON.parse(fs.readFileSync(GMAIL_KEYS, 'utf-8'));
    const result = await postForm('https://oauth2.googleapis.com/token', {
      client_id: keys.installed.client_id,
      client_secret: keys.installed.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    });
    if (result.data.access_token) return result.data.access_token;
    log(`Gmail token refresh failed: ${JSON.stringify(result.data)}`, 'ERROR');
    return null;
  } catch (err) {
    log(`Gmail auth error: ${err.message}`, 'ERROR');
    return null;
  }
}

async function checkGmail(state) {
  const token = await getGmailAccessToken();
  if (!token) return [];

  // Build query: emails since last check, in inbox
  const since = state.gmail_last_check
    ? new Date(state.gmail_last_check)
    : new Date(Date.now() - 5 * 60 * 1000); // Default: last 5 min

  const afterDate = `${since.getFullYear()}/${(since.getMonth() + 1).toString().padStart(2, '0')}/${since.getDate().toString().padStart(2, '0')}`;
  // NO `is:unread`: read-state must NOT gate the sweep. Alfred marks emails read as
  // part of triage, so `is:unread` would drop already-triaged mail AND — worse — any
  // email Josh reads on his phone before the sweep runs. A per-message-id dedup Set
  // (gmail_seen_ids, below) stops re-relay instead. (Fixes the unread-gate bug.)
  const query = encodeURIComponent(`in:inbox after:${afterDate}`);

  try {
    const listResult = await fetchJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=10`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!listResult.data.messages || listResult.data.messages.length === 0) {
      return [];
    }

    // Per-message-id dedup (mirrors phone_seen_keys). Since we no longer gate on
    // `is:unread`, the SAME email would re-appear in every sweep inside the after:
    // window; this Set is what stops the re-relay. Gmail message ids are stable.
    const seenIds = new Set(state.gmail_seen_ids || []);
    const observedIds = [];

    // Fetch message details
    const notifications = [];
    for (const msg of listResult.data.messages.slice(0, 10)) {
      try {
        const detail = await fetchJson(
          // format=full, NOT metadata. `metadata` returns headers plus Gmail's
          // ~200-char `snippet` and NO BODY — and the snippet keeps the marketing
          // VOICE while cutting the ACCOUNT IDENTIFIER that decides classification.
          // Worked example (Alfred-flagged 2026-09-18, Gmail 1a0b1b77e1d991fc): a
          // Stripe mail whose snippet read "Increase global conversion and reduce
          // costs" (pure marketing) was an automatic pricing change to
          // acct_1Ax142Fucad7KVAh — GiveGrove PRODUCTION checkout. Measured on that
          // exact message: snippet 201 chars, NO acct_; format=full body 13681
          // chars, acct_ PRESENT. Many senders are two-class (Stripe marketing vs
          // account, Cloud promos vs billing) and the discriminator sits just past
          // where the snippet ends, because marketing framing comes first.
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        const headers = detail.data.payload?.headers || [];
        const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
        const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        // Skip if this message is older than our last check (Gmail after: is date-level, not time-level)
        const msgDate = new Date(date);
        if (state.gmail_last_check && msgDate < new Date(state.gmail_last_check)) {
          continue;
        }

        // Every message we actually inspected this sweep is "observed" — record it so
        // it's written to gmail_seen_ids regardless of whether it's new or a dedupe hit.
        observedIds.push(msg.id);

        // Dedup: already relayed in a prior sweep → skip (no double-relay).
        if (seenIds.has(msg.id)) {
          continue;
        }

        notifications.push({
          source: 'gmail',
          id: msg.id,
          from,
          subject,
          date,
          snippet: detail.data.snippet || '',
          // Decoded body, so a two-class sender can be told apart. Capped at 4000
          // chars: enough to carry an account line past the snippet, without
          // pushing a 13KB marketing email through the walkie.
          body: extractGmailBody(detail.data.payload).slice(0, 4000),
        });
      } catch (err) {
        log(`Failed to fetch email ${msg.id}: ${err.message}`, 'WARN');
      }
    }

    // Persist the ids observed this sweep — SAME "write current observed set" shape as
    // phone_seen_keys. The listing is bounded by after: (date-level) + maxResults, so it
    // covers the whole in-window set each run; writing observedIds keeps the seen set
    // scoped to the window (no unbounded growth) while blocking same-message re-relay.
    state.gmail_seen_ids = observedIds;

    return notifications;
  } catch (err) {
    log(`Gmail check error: ${err.message}`, 'ERROR');
    return [];
  }
}

// ─── Phone notifications ─────────────────────────────────────────────

async function checkPhoneNotifications(state) {
  try {
    // Tight per-endpoint timeout so a HUNG phone (cellular flap: socket connects but
    // body stalls) is skipped gracefully instead of eating the whole 30s job budget
    // and triggering a SIGKILL. On timeout, fetchJson's req.on('timeout') destroys the
    // socket and rejects → the catch below returns [] (same as the unreachable path).
    const result = await fetchJson(`${PHONE_BASE_URL}/notifications`, { timeout: PHONE_FETCH_TIMEOUT_MS });
    if (!result.data?.data || !Array.isArray(result.data.data)) return [];

    const notifications = result.data.data;
    if (notifications.length === 0) return [];

    // Persist messaging-app bodies (RCS + SMS) to the transport-agnostic history
    // store BEFORE dedupe/filter — thread history should be complete regardless of
    // triage relevance. Idempotent on notification key, so re-observing the same tray
    // entry every sweep is a no-op. No-op for non-messaging notifications.
    try {
      messageHistory.recordNotifications(notifications);
    } catch (err) {
      log(`message-history persist failed: ${err.message}`, 'WARN');
    }

    // Deduplicate and filter ignored apps
    const seenKeys = new Set(state.phone_seen_keys || []);
    const newNotifications = [];

    for (const n of notifications) {
      // Skip ignored apps (<<REPLACE: your employer>> work stuff)
      if (isIgnoredNotification(n)) continue;

      // Stable dedupe key (android-key alone when present; see phoneDedupeKey).
      // Was `${baseKey}::${text.substring(0,50)}` — emoji-unstable, re-fired forever.
      const key = phoneDedupeKey(n);
      if (!seenKeys.has(key)) {
        newNotifications.push({
          source: 'phone',
          app: n.packageName || n.app || 'unknown',
          title: n.title || '',
          text: n.text || '',
          key,
        });
      }
    }

    // Update seen keys — SAME phoneDedupeKey helper as the dedup check above,
    // so the written key and the checked key can never drift.
    //
    // MERGE, NOT ASSIGN (2026-09-02). This used to be a straight assignment of
    // the keys present in the tray THIS sweep, which made the ledger a snapshot
    // of the tray rather than a record of what we have already relayed. The
    // consequence: Josh dismisses a notification, its key is gone from the tray,
    // the next sweep evicts it from the ledger — and if that notification ever
    // re-appears (an app re-posting or updating the same android key) it passes
    // the `!seenKeys.has(key)` check above again and gets relayed a SECOND time.
    // The assignment also silently discarded everything the real-time ingest
    // route had appended via its own markSeen (notification-ingest/route.ts),
    // every five minutes.
    //
    // Union-then-cap keeps the ledger a genuine "already relayed" set. SEEN_MAX
    // matches the ingest route's cap so the two writers agree on the bound; the
    // slice keeps the NEWEST keys, since the oldest are the least likely to
    // re-fire.
    const sweepKeys = notifications
      .filter(n => !isIgnoredNotification(n))
      .map(n => phoneDedupeKey(n));
    state.phone_seen_keys = [
      ...new Set([...(state.phone_seen_keys || []), ...sweepKeys]),
    ].slice(-SEEN_MAX);

    return newNotifications;
  } catch (err) {
    // Phone might be unreachable — not an error worth logging every 5 min
    return [];
  }
}

// ─── Phone OUTGOING sweep (Phase 2) ──────────────────────────────────
//
// Josh's OWN sent messages never appear in the notification tray (Android's
// MessagingStyle extras carry received messages only), so the incoming sweep above
// stores an incoming-only picture — the blind spot behind the wrong-day scheduling
// bug. This sweep reads the phone bridge's SMS sent box and persists Josh's outgoing
// texts into the SAME per-thread files, keyed by recipient number so they interleave
// chronologically with the incoming ones. Alfred's enrichment then shows the real
// back-and-forth.
//
// This does NOT produce Alfred notifications — outgoing sends aren't triage items. It
// only populates the history store (like the incoming persist, which also happens
// before the triage filter). Idempotent: re-sweeping the sent box each run only appends
// messages not already stored.
//
// COVERAGE: SMS sent box only. RCS sends are not in the content provider — outgoing RCS
// is NOT captured (documented in message-history-store.js).
async function sweepPhoneSent() {
  try {
    // Same tight per-endpoint timeout as the incoming phone fetch: a hung phone is
    // skipped gracefully rather than eating the job's SIGKILL budget.
    const result = await fetchJson(`${PHONE_BASE_URL}/sms/sent?limit=${SMS_SENT_SWEEP_DEPTH}`, {
      timeout: PHONE_FETCH_TIMEOUT_MS,
    });
    const rows = Array.isArray(result.data?.data) ? result.data.data : [];
    if (rows.length === 0) return { stored: 0, skipped: 0, threads: 0 };
    const r = messageHistory.recordOutgoingMessages(rows);
    if (r.stored > 0) {
      log(`Outgoing sweep: stored ${r.stored} sent message(s) across ${r.threads} thread(s)`);
    }
    return r;
  } catch (err) {
    // Phone unreachable / bridge down — same graceful skip as the incoming sweep.
    return { stored: 0, skipped: 0, threads: 0, error: err.message };
  }
}

// ─── Walkie-talkie to Rooster ────────────────────────────────────────

// Bundle recent thread history onto each MESSAGING notification before Alfred triages
// it. Ingest-side enrichment is deliberate: deterministic, survives Alfred restarts,
// off Alfred's critical path, and the store already lives in the Homestead data dir.
// DEFENSIVE by contract — if the store has no thread or throws, the notification goes
// through UNCHANGED (thread_context omitted). Never block a notification on enrichment.
// Only phone notifications carry a title/conversation; gmail entries pass through as-is.
// Attach the sender->steward routing HINT to one notification (SUGGEST-CONFIRM).
// Returns the notification with `suggested_steward`/`suggested_topic`/`suggested_note`
// added ONLY when the routing table produced a match. No match (or missing/malformed
// table) → the notification is returned unchanged. Never throws, never forwards, never
// changes target_session — Alfred still owns the forward call.
function annotateRouting(n) {
  try {
    const hint = suggestSteward(n);
    if (hint && hint.suggested_steward) {
      return {
        ...n,
        suggested_steward: hint.suggested_steward,
        suggested_topic: hint.topic || null,
        suggested_note: hint.note || null,
        suggested_rule_id: hint.matched_rule_id || null,
      };
    }
  } catch (err) {
    log(`routing-suggest failed for "${(n.title || n.subject || '').slice(0, 40)}": ${err.message}`, 'WARN');
  }
  return n;
}

function enrichWithThreadContext(notifications) {
  const THREAD_CONTEXT_LIMIT = 10; // last ~10 messages
  return (notifications || []).map((n) => {
    if (!n) return n;
    // Sender -> steward routing HINT (SUGGEST-CONFIRM). Runs for ALL notification
    // shapes — phone AND gmail — because CI-failure emails (github_repo match) are
    // gmail entries with no title. Annotation only; Alfred still confirms + forwards.
    // Fail-open: null suggestion leaves the notification unannotated.
    n = annotateRouting(n);
    if (n.source !== 'phone' || !n.title) return n;
    try {
      const r = messageHistory.readThreadForNotification(n, THREAD_CONTEXT_LIMIT);
      if (r && r.found && Array.isArray(r.messages) && r.messages.length > 0) {
        return {
          ...n,
          thread_context: {
            thread_key: r.threadKey,
            title: r.title || null,
            contact_hint: r.contactHint || null,
            message_count: r.count,
            // Chronological, oldest→newest, INTERLEAVED both directions. Each message
            // carries a `direction`: 'incoming' (received) or 'outgoing' (Josh's own
            // sends, Phase 2 — captured from the SMS sent box). Outgoing RCS sends are
            // NOT captured (not in the SMS content provider), so a thread that is
            // purely RCS may still show incoming-only — see note.
            messages: r.messages,
            note: 'interleaved incoming + outgoing; outgoing is SMS-sent-box only — outgoing RCS (chat-bubble) sends are not captured',
          },
        };
      }
    } catch (err) {
      log(`thread-context enrich failed for "${(n.title || '').slice(0, 40)}": ${err.message}`, 'WARN');
    }
    return n; // no history (or error) → send the notification as-is
  });
}

function sendToRooster(notifications) {
  try {
    // Attach recent thread history to messaging notifications (defensive; see above).
    notifications = enrichWithThreadContext(notifications);

    const queue = fs.existsSync(QUEUE_FILE)
      ? JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'))
      : [];

    const id = `${Date.now()}-notif`;
    const entry = {
      id,
      // Notification triage endpoint moved to Alfred 2026-07-02 (Josh-approved).
      // This 5-min cron is now the BACKSTOP sweep; real-time push-on-arrival is
      // the primary path (phone onNotificationPosted -> Homestead ingest -> Alfred).
      // Alfred owns read/route/identity; Rooster owns this wiring.
      target_session: 'holler-alfred',
      type: 'action',
      message: JSON.stringify({
        type: 'action',
        trigger: 'notification_triage',
        from: 'notification-checker',
        notifications,
        // LOCAL time with offset, deliberately NOT toISOString(). This value is
        // read by STEWARDS, not parsed by machines, and a bare ...Z reads as local
        // at a glance -- Alfred misread this exact field for ~73 entries on
        // 2026-09-14/15: 14:08Z became "14:08" in his log while the event happened
        // at 10:08 local. NOTE the offset is NOT a constant -- this machine runs
        // America/Indiana/Indianapolis, -4 in summer and -5 after the November DST
        // flip -- so localStamp() DERIVES it from the date and never hardcodes it.
        // He reasons about Josh's day from this field: desk,
        // dinner, asleep, card-now-or-morning. Local-with-offset is unambiguous
        // read either way. (2026-09-15)
        checked_at: localStamp(),
      }),
      status: 'pending',
      created_at: new Date().toISOString(),
      attempts: 0,
    };

    queue.push(entry);
    writeFileAtomicSync(QUEUE_FILE, JSON.stringify(queue, null, 2)); // atomic (torn-read fix 2026-08-25)
    log(`Sent ${notifications.length} notification(s) to Alfred (queue id: ${id})`);
  } catch (err) {
    log(`Failed to queue for Alfred: ${err.message}`, 'ERROR');
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const state = loadState();
  const allNotifications = [];

  // Check Gmail
  const gmailNotifs = await checkGmail(state);
  if (gmailNotifs.length > 0) {
    log(`Gmail: ${gmailNotifs.length} new email(s)`);
    allNotifications.push(...gmailNotifs);
  }

  // Check phone notifications
  const phoneNotifs = await checkPhoneNotifications(state);
  if (phoneNotifs.length > 0) {
    log(`Phone: ${phoneNotifs.length} notification(s)`);
    allNotifications.push(...phoneNotifs);
  }

  // Phase 2: sweep Josh's OUTGOING SMS sent box into the thread store so Alfred's
  // enrichment sees the real back-and-forth. Populates the store only — never adds
  // triage notifications. Best-effort: phone-down is a silent no-op.
  await sweepPhoneSent();

  // Update state
  state.gmail_last_check = new Date().toISOString();
  state.phone_last_check = new Date().toISOString();
  saveState(state);

  // If nothing new, exit quietly
  if (allNotifications.length === 0) {
    log('No new notifications');
    console.log(JSON.stringify({ triggered: false, reason: 'no_new_notifications' }));
    return;
  }

  // Send to Rooster for triage
  sendToRooster(allNotifications);
  console.log(JSON.stringify({
    triggered: true,
    count: allNotifications.length,
    gmail: gmailNotifs.length,
    phone: phoneNotifs.length,
  }));
}

main().catch(err => {
  log(`Fatal error: ${err.message}`, 'ERROR');
  process.exit(1);
});
