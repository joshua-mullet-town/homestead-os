/**
 * Message History Store (transport-agnostic thread persistence)
 *
 * PURPOSE — close the RCS/Google-Messages on-demand THREAD-READ gap.
 *
 * The SMS reader tools (`receive_text_messages` -> /sms/inbox, `read_sms`) read
 * the Android SMS *content provider* only. RCS / Google-Messages threads are NOT
 * written to the SMS DB, so those readers return ZERO for RCS — a real triage
 * miss already happened (contact Nate, +16164068841).
 *
 * The notification TRAY (`/notifications`) IS transport-agnostic (RCS bodies show
 * up there), which is how real-time ingest already covers RCS at arrival. But the
 * tray holds only the CURRENT notification per conversation and gets cleared on
 * read — so it cannot reconstruct thread HISTORY after the fact.
 *
 * This module persists messaging-app notification bodies as they flow through the
 * real-time ingest path (`POST /api/notification-ingest`) and the 5-min backstop
 * cron (`check-notifications.js`). Because both source from the TRAY, the store is
 * transport-agnostic: SMS and RCS land the same way. A read tool then queries the
 * store by contact number/name and returns chronological thread history.
 *
 * Storage layout: one JSON file per conversation thread under
 *   ~/code/homestead/data/message-history/<thread-key>.json
 * Each file: { threadKey, title, contactHint, messages: [ {text, bigText, ts,
 * notifKey, packageName, capturedAt} ... ] } — messages appended chronologically,
 * rolling-capped per thread.
 *
 * DEDUPE: keyed on message CONTENT (text + timestamp + sender), NOT the notification
 * `key`. Android reuses the same notification key across rapid same-thread updates,
 * so key-based dedupe dropped the 2nd of two quick messages as a "duplicate" of the
 * 1st ("sent 2, saw 1"). Content-keying fixes that and makes the full-list resend
 * (below) idempotent — re-observing the same body via the backstop cron is a no-op.
 *
 * RAPID-FIRE CAPTURE: messaging apps rebuild the FULL recent-message list (Android
 * caps ~25) on every notification update. The phone sends that whole list in
 * `messages[]` (MessagingStyle EXTRA_MESSAGES); the store records each message by
 * content. So even if the notification for msg #1 is superseded before we read it,
 * the notification for msg #2 still carries msg #1 in its list, and both get stored.
 *
 * OUTGOING CAPTURE (Phase 2, 2026-08-21): notification-tray bodies are RECEIVED-only —
 * Android's MessagingStyle extras never carry the user's OWN sends, so every stored
 * message above is incoming. That blind spot caused a wrong-day scheduling bug (Alfred
 * couldn't see Josh's "want to play tomorrow?" outgoing text). `recordOutgoingMessages`
 * closes it: it ingests rows from the phone bridge's SMS `sent` box (/sms/sent — the
 * Android Telephony content provider's sent table) and appends them to the SAME
 * per-thread file, keyed by the recipient number so they interleave chronologically
 * with the incoming messages for that contact. Each message now carries a `direction`
 * ('incoming' | 'outgoing') so enrichment can show who said what. Records written
 * before Phase 2 have no `direction` field and are treated as 'incoming' at read time.
 *
 * COVERAGE / HONEST LIMIT: the sent box is the SMS content provider only. RCS sends
 * (Google-Messages chat bubbles) are NOT written to that table — the same RCS-vs-SMS
 * gap that motivated this store for the INCOMING side. So outgoing SMS is fully
 * captured; outgoing RCS is NOT. There is no lock-independent on-device source for
 * RCS-sent (reading it would need an accessibility screen-scrape, which can't
 * distinguish sent-vs-received reliably and needs the phone unlocked). Documented,
 * not silently dropped.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Anchor the store to the Homestead app root's data/ dir — the SAME dir the ingest
// route + backstop cron already use for notification-check-state.json.
//
// __dirname is NOT reliable here: when this module is require()'d from a Next.js
// App Router route it gets WEBPACK-BUNDLED, and `path.join(__dirname, '..', 'data')`
// then resolves to `.next/server/app/api/data/...` (a bundle-relative path) instead
// of the real source tree — so the route's writes landed in a phantom .next dir the
// cron/CLI never read (caught during acceptance testing 2026-07-10). Anchor to the
// Homestead root explicitly so every caller — route (bundled), cron (plain node),
// MCP reads via HTTP — agrees on ONE store dir. Override with MESSAGE_HISTORY_DIR.
const HOMESTEAD_ROOT =
  process.env.HOMESTEAD_ROOT || path.join(os.homedir(), 'code', 'homestead');
const STORE_DIR =
  process.env.MESSAGE_HISTORY_DIR || path.join(HOMESTEAD_ROOT, 'data', 'message-history');
const PER_THREAD_CAP = 500; // rolling cap of messages kept per thread

// Messaging apps whose notifications carry conversation bodies we want to persist.
// Google Messages (RCS + SMS fallback) is the primary target; the stock SMS app and
// common OEM messaging packages are included so the store stays transport- and
// app-agnostic. NOT a general notification log — messaging apps only.
const MESSAGING_PACKAGES = new Set([
  'com.google.android.apps.messaging', // Google Messages (RCS + SMS)
  'com.android.messaging',             // AOSP Messaging
  'com.samsung.android.messaging',     // Samsung Messages
  'com.textra',                        // Textra
  'com.p1.chompsms',                   // Chomp SMS
]);

// Foreground-service / system status posts a messaging app emits about ITSELF
// (not a conversation): e.g. Google Messages' "Messages is doing work in the
// background" (null title, category "service", isOngoing). These match the package
// but carry no conversation — they'd land in a junk `unknown` thread. Drop them.
// (Auditor-flagged 2026-07-10; mirrors the ingest route's service-notice filter.)
const SERVICE_NOTICE_TEXT = /\bdoing work in the background\b|\brunning\b.*\bbackground\b/i;

function isServiceNotice(n) {
  if (n.category === 'service') return true;
  if (n.isOngoing && !(n.title && n.title.trim())) return true;
  if (SERVICE_NOTICE_TEXT.test(n.text || '') && !(n.title && n.title.trim())) return true;
  return false;
}

function isMessagingNotification(n) {
  if (!n) return false;
  if (isServiceNotice(n)) return false;
  const pkg = n.packageName || n.appName || '';
  if (MESSAGING_PACKAGES.has(pkg)) return true;
  // Category-based fallback: Android tags conversation posts category "msg".
  if (n.category === 'msg' && !n.isGroupSummary) return true;
  return false;
}

// Normalize a phone number to its trailing 10 digits (US) for matching.
// "(616) 406-8841", "+16164068841", "616-406-8841" all collapse to "6164068841".
function normalizeNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  if (digits.length > 0) return digits;
  return null;
}

// Derive a stable thread key from a notification title.
// If the title is a phone number, key by its normalized digits (so the same
// contact always maps to the same thread regardless of formatting). Otherwise key
// by a slugified display name / conversation title (group threads, named contacts).
function threadKeyFromTitle(title) {
  const t = (title || '').trim();
  if (!t) return 'unknown';
  const num = normalizeNumber(t);
  // A title that is essentially just a phone number → key by number.
  // (Heuristic: stripping phone punctuation leaves only digits.)
  const stripped = t.replace(/[\s()+\-.]/g, '');
  if (num && /^\d+$/.test(stripped) && stripped.length >= 7) {
    return `num_${num}`;
  }
  const slug = t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return slug || 'unknown';
}

function threadFilePath(threadKey) {
  return path.join(STORE_DIR, `${threadKey}.json`);
}

function ensureDir() {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  } catch (err) {
    console.error('[MsgHistory] failed to create store dir:', err);
  }
}

function loadThread(threadKey) {
  try {
    const p = threadFilePath(threadKey);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    console.error(`[MsgHistory] failed to read thread ${threadKey}:`, err);
  }
  return null;
}

function writeThread(threadKey, thread) {
  try {
    ensureDir();
    fs.writeFileSync(threadFilePath(threadKey), JSON.stringify(thread, null, 2));
  } catch (err) {
    console.error(`[MsgHistory] failed to write thread ${threadKey}:`, err);
  }
}

// Content-dedupe key shared by BOTH writers (incoming recordNotification + outgoing
// recordOutgoingMessages). NUL-delimited so it can't be spoofed by a body that itself
// contains the delimiter. Direction is part of the key on purpose: an outgoing text
// that echoes an incoming line (or an SMS the tray ALSO captured) must not collapse the
// two into one. Records written before Phase 2 have no `direction` → treated 'incoming',
// which matches how they were stored, so old files stay idempotent.
const contentKey = (m) =>
  `${m.direction || 'incoming'} ${m.text} ${m.ts || ''} ${m.sender || ''}`;

/**
 * Persist one messaging notification body into its thread.
 * No-op (returns {stored:false, reason}) if it's not a messaging notification or
 * has no readable body text. Idempotent on notifKey.
 *
 * @returns {{stored: boolean, threadKey?: string, reason?: string}}
 */
function recordNotification(n) {
  if (!isMessagingNotification(n)) return { stored: false, reason: 'not_messaging' };

  // Candidate messages to persist from THIS notification post.
  //
  // Preferred source: the MessagingStyle EXTRA_MESSAGES list the phone now sends in
  // `n.messages[]` (each {text, time, sender}). Messaging apps rebuild the FULL recent
  // list on every update, so a single surviving notification carries the earlier
  // messages of a rapid-fire burst — this is what recovers the "sent 2, saw 1" drop.
  //
  // Fallback (older APK, or a non-MessagingStyle post): the single latest body line.
  // This keeps every existing caller — the backstop cron, older phones — working
  // unchanged.
  const candidates = [];
  if (Array.isArray(n.messages) && n.messages.length > 0) {
    for (const m of n.messages) {
      const text = (m && (m.text || '')).toString().trim();
      if (!text) continue;
      candidates.push({
        text,
        ts: m.time || n.timestamp || null,
        sender: (m.sender && String(m.sender).trim()) || null,
      });
    }
  } else {
    const body = (n.text || n.bigText || '').trim();
    if (body) candidates.push({ text: body, ts: n.timestamp || null, sender: null });
  }
  if (candidates.length === 0) return { stored: false, reason: 'no_body' };

  const threadKey = threadKeyFromTitle(n.title);
  const thread = loadThread(threadKey) || {
    threadKey,
    title: n.title || null,
    contactHint: normalizeNumber(n.title) || null,
    messages: [],
  };

  // Keep the most recent human-readable title (group thread names can rotate; a
  // number-keyed thread may later gain a display name once the contact is saved).
  if (n.title && n.title.trim()) thread.title = n.title.trim();
  if (!thread.contactHint) thread.contactHint = normalizeNumber(n.title) || null;

  const notifKey = n.key || null;
  const packageName = n.packageName || n.appName || null;
  const capturedAt = new Date().toISOString();

  // Dedupe on message CONTENT (text + timestamp + sender), NOT the notification
  // identity. Android REUSES the same notification `key` across rapid same-thread
  // updates, so keying on notifKey dropped msg #2 of a burst as a "duplicate" of
  // msg #1 (the exact "sent 2, saw 1" bug). Content-keying is also what makes the
  // full-EXTRA_MESSAGES resend idempotent: re-sending the whole recent list on every
  // post only appends messages we haven't already stored.
  const seen = new Set(thread.messages.map(contentKey));

  let stored = 0;
  for (const c of candidates) {
    const rec = {
      text: c.text,
      bigText: null,
      ts: c.ts,
      sender: c.sender,
      direction: 'incoming', // tray / MessagingStyle bodies are received-only
      notifKey,
      packageName,
      capturedAt,
    };
    if (seen.has(contentKey(rec))) continue;
    seen.add(contentKey(rec));
    thread.messages.push(rec);
    stored++;
  }

  if (stored === 0) return { stored: false, threadKey, reason: 'duplicate' };

  // Chronological order + rolling cap.
  thread.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (thread.messages.length > PER_THREAD_CAP) {
    thread.messages = thread.messages.slice(-PER_THREAD_CAP);
  }

  writeThread(threadKey, thread);
  return { stored: true, threadKey, count: stored };
}

/**
 * Batch helper — persist an array of notifications (used by the 5-min cron sweep).
 * @returns {{stored: number, skipped: number}}
 */
function recordNotifications(list) {
  let stored = 0;
  let skipped = 0;
  for (const n of list || []) {
    const r = recordNotification(n);
    if (r.stored) stored++;
    else skipped++;
  }
  return { stored, skipped };
}

/**
 * Persist Josh's OWN OUTGOING messages into the per-thread files (Phase 2).
 *
 * Input rows come from the phone bridge's SMS sent box (GET /sms/sent), each shaped
 * { id, address, body, date } — `address` is the RECIPIENT number, `body` the text,
 * `date` the epoch-ms send time. We key each row by num_<recipient-10-digits> — the
 * SAME thread key incoming messages for that contact use — so a sent + a received
 * message to/from one person land in ONE file and interleave chronologically by `ts`.
 *
 * Direction-tagged 'outgoing'. Content-deduped with the same key the incoming writer
 * uses, so re-sweeping the sent box every cron run is idempotent (a message already
 * stored is skipped). No-op for rows with no recipient number or empty body.
 *
 * Only number-addressed threads are written — a sent SMS always has a recipient number,
 * so unlike incoming (which can be a named group title) outgoing always keys to num_*.
 *
 * COVERAGE: SMS sent box only. RCS sends are not in the content provider (see the
 * module header) — outgoing RCS is NOT captured here.
 *
 * @param {Array<{id?, address?, body?, date?}>} rows  /sms/sent data array
 * @returns {{stored: number, skipped: number, threads: number}}
 */
function recordOutgoingMessages(rows) {
  let stored = 0;
  let skipped = 0;
  // Group rows by recipient thread key so each file is loaded/written once per batch.
  const byThread = new Map();
  for (const row of rows || []) {
    const text = (row && (row.body || '')).toString().trim();
    const num = normalizeNumber(row && row.address);
    if (!text || !num) {
      skipped++;
      continue;
    }
    const ts =
      typeof row.date === 'number' ? row.date : Number(row.date) || null;
    const threadKey = `num_${num}`;
    if (!byThread.has(threadKey)) byThread.set(threadKey, { num, rows: [] });
    byThread.get(threadKey).rows.push({ text, ts });
  }

  for (const [threadKey, { num, rows: threadRows }] of byThread) {
    const thread = loadThread(threadKey) || {
      threadKey,
      title: null,
      contactHint: num,
      messages: [],
    };
    if (!thread.contactHint) thread.contactHint = num;

    const seen = new Set(thread.messages.map(contentKey));
    const capturedAt = new Date().toISOString();
    let threadStored = 0;

    for (const r of threadRows) {
      const rec = {
        text: r.text,
        bigText: null,
        ts: r.ts,
        sender: 'me',
        direction: 'outgoing',
        notifKey: null,
        packageName: 'sms-sent-box',
        capturedAt,
      };
      if (seen.has(contentKey(rec))) {
        skipped++;
        continue;
      }
      seen.add(contentKey(rec));
      thread.messages.push(rec);
      threadStored++;
      stored++;
    }

    if (threadStored === 0) continue;

    // Same chronological sort + rolling cap the incoming writer uses — outgoing rows
    // slot into their real time position among the incoming ones.
    thread.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (thread.messages.length > PER_THREAD_CAP) {
      thread.messages = thread.messages.slice(-PER_THREAD_CAP);
    }
    writeThread(threadKey, thread);
  }

  return { stored, skipped, threads: byThread.size };
}

/**
 * Read a thread's history by contact number OR display-name substring.
 * Transport-agnostic: returns SMS + RCS bodies alike (both persisted from the tray).
 *
 * Matching order:
 *   1. Exact number match — normalize `contact` to trailing-10-digits, look up num_<digits>.
 *   2. contactHint match — any thread whose stored contactHint matches the number.
 *   3. Title substring — case-insensitive substring against stored thread titles.
 *
 * @param {string} contact  phone number (any format) or display-name substring
 * @param {number} limit    max messages to return (most recent), default 50
 * @returns {{ found: boolean, threadKey?: string, title?: string, contactHint?: string,
 *             count?: number, messages?: Array, candidates?: Array }}
 */
function readThread(contact, limit = 50) {
  ensureDir();
  const q = (contact || '').trim();
  if (!q) return { found: false, reason: 'empty_query' };

  const files = (() => {
    try {
      return fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  })();

  const num = normalizeNumber(q);

  // 1. Direct number-keyed thread.
  if (num) {
    const direct = loadThread(`num_${num}`);
    if (direct) return formatThread(direct, limit);
  }

  // Load all threads once for hint/title matching.
  const threads = files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(STORE_DIR, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // 2. contactHint match (a named thread whose participant number matches).
  //
  // A NUMBER is an exact identity signal. When it matches more than one thread it's
  // almost never "which person?" ambiguity — it's the SAME conversation fragmented
  // across files. Android's MessagingStyle group title is "<participants>: <who-just-
  // spoke>", and the trailing speaker rotates, so one logical group thread slugs into
  // several files (e.g. the 4 "Hallie/Nicole/Ryan" files all carry contactHint
  // 5133706100). Old behavior bailed to candidates[] here — handing Alfred a list of
  // thread stubs instead of the messages. That's the "returns candidate thread-lists
  // not bodies" flakiness. Fix: a number-exact match ALWAYS resolves to bodies. When
  // several threads share the number, pick the one with the most recent activity
  // (the live conversation) deterministically rather than bailing.
  if (num) {
    const byHint = threads.filter((t) => normalizeNumber(t.contactHint) === num);
    if (byHint.length === 1) return formatThread(byHint[0], limit);
    if (byHint.length > 1) return formatThread(mostRecentThread(byHint), limit);
  }

  // 3. Title substring (case-insensitive).
  //
  // This path is a genuine NAME lookup ("nicole", "cari") — here >1 match IS real
  // ambiguity (different people can share a substring), so keep the candidates[]
  // contract for callers that want to disambiguate. The ingest-side ENRICHMENT never
  // relies on this branch to be unambiguous: it goes through readThreadForNotification
  // below, which resolves the notification's own number first and collapses any title
  // ambiguity to the most-recent thread so Alfred always gets bodies-or-nothing.
  const ql = q.toLowerCase();
  const byTitle = threads.filter((t) => (t.title || '').toLowerCase().includes(ql));
  if (byTitle.length === 1) return formatThread(byTitle[0], limit);
  if (byTitle.length > 1) return { found: false, candidates: byTitle.map(threadSummary) };

  return { found: false, reason: 'no_match', candidates: [] };
}

// Pick the thread with the most recent message (fallback: most messages, then first).
// Used to collapse number-exact collisions (same conversation fragmented across files)
// to a single deterministic winner so a real contact resolves to bodies, not candidates.
function mostRecentThread(list) {
  const lastTs = (t) => {
    const ms = t.messages || [];
    let max = 0;
    for (const m of ms) {
      const v = Number(m.ts) || 0;
      if (v > max) max = v;
    }
    return max;
  };
  return list.slice().sort((a, b) => {
    const d = lastTs(b) - lastTs(a);
    if (d !== 0) return d;
    return (b.messages || []).length - (a.messages || []).length;
  })[0];
}

/**
 * Resolve the best thread for a NOTIFICATION and return its recent bodies — the
 * enrichment entry point used by the ingest route + backstop cron. Unlike readThread,
 * this NEVER returns candidates[]: enrichment must be deterministic (Alfred gets the
 * messages or an empty context, never a stub list to disambiguate).
 *
 * Resolution order, most-specific first:
 *   1. The notification title as a phone number → num_<digits> direct thread, then
 *      contactHint match (readThread step 1/2, which now collapses collisions).
 *   2. The notification title as a name/group-title substring → if it resolves to
 *      exactly one thread, use it; if it's ambiguous, collapse to the most-recent
 *      matching thread rather than giving up.
 *
 * @param {{title?: string|null}} n  a notification (cron entry or raw ingest payload)
 * @param {number} limit             max recent messages to return (default 10)
 * @returns {{found: boolean, threadKey?: string, title?: string, contactHint?: string,
 *            count?: number, messages?: Array}}  — never includes candidates[]
 */
function readThreadForNotification(n, limit = 10) {
  // GATE (2026-09-01): enrichment is for MESSAGING notifications ONLY — symmetric with
  // the write side (recordNotification gates on this exact same predicate).
  //
  // Without it, ANY app's notification title was run through the name matcher. A Gmail
  // post carrying a GitHub email (com.google.android.gm — not a MESSAGING_PACKAGE,
  // category not "msg") titled with a bare first name ("Michael") substring-matched an
  // unrelated SMS thread ("DTMI IT Requests: Michael Hugill"), and step 2 below then
  // collapsed the ambiguity to the most-recent match — cementing a wrong attachment.
  // Triaging off that context would have read a GiveGrove PR approval as a Tire Rack IT
  // access request (Alfred-flagged, reproduced). Gating here kills the whole class:
  // a non-messaging app can never acquire a messaging thread_context, and no sender
  // allowlist is needed. Legitimate SMS/RCS name lookups are untouched.
  if (!isMessagingNotification(n)) return { found: false, reason: 'not_messaging' };

  const title = (n && n.title) ? String(n.title).trim() : '';
  if (!title) return { found: false, reason: 'no_title' };

  // 1. Try the title as a contact query. If it's a number (or a group whose
  //    participant number is known) readThread already resolves to bodies.
  // A NUMBER title is an exact identity signal — readThread steps 1/2 resolve it by
  // digits, never by name substring, so the token rule below must NOT be applied to it
  // (e.g. "(555) 000-0001" tokenizes differently than the thread title "5550000001").
  const isNumberQuery = !!normalizeNumber(title) && /^[\d\s()+\-.]+$/.test(title);

  const r = readThread(title, limit);
  if (r.found) {
    if (isNumberQuery) return r;
    // Defense in depth: readThread's single-match title branch is a raw substring, so a
    // bare one-word title ("Mike") resolves to a LONGER unrelated title ("Mike Johnson")
    // whenever that's the only substring hit — a messaging-vs-messaging collision the
    // gate above can't catch. Require a token-boundary match for enrichment. Scoped HERE
    // rather than in readThread on purpose: readThread also backs the /api/message-history
    // contact lookup, where a human typing a partial name SHOULD match fuzzily.
    if (titleTokenMatch(title, r.title)) return r;
    const strict = strictTitleMatches(title);
    if (strict.length > 0) return formatThread(mostRecentThread(strict), limit);
    return { found: false, reason: 'no_token_match' };
  }

  // 2. readThread returned candidates[] (ambiguous NAME/title substring). Collapse to
  //    the most-recent matching thread so enrichment still yields bodies. We re-load
  //    the candidate threads (candidates carry only summaries) and pick the freshest.
  //    Token-filter first so a bare first name can't win an unrelated longer title.
  if (Array.isArray(r.candidates) && r.candidates.length > 0) {
    const full = r.candidates
      .map((c) => loadThread(c.threadKey))
      .filter(Boolean);
    const tokenOk = full.filter((t) => titleTokenMatch(title, t.title));
    if (tokenOk.length > 0) return formatThread(mostRecentThread(tokenOk), limit);
    return { found: false, reason: 'no_token_match' };
  }

  return { found: false, reason: r.reason || 'no_match' };
}

// Token-boundary title match used by ENRICHMENT only (see readThreadForNotification).
//
// Matches on whole title TOKENS instead of a raw substring. The rule is deliberately
// asymmetric in the number of query tokens:
//
//   - Group MessagingStyle titles are "<participants>: <who-just-spoke>", and a
//     notification title for the group is itself that full string, so an exact/subset
//     query must still resolve. We therefore allow the QUERY's tokens to be a subset of
//     the TITLE's tokens ONLY when the query has 2+ tokens (a real name or group name).
//   - A SINGLE-token query ("Mike", "Michael") must be the ENTIRE title — never merely
//     a prefix of a longer name ("Mike Johnson") nor one participant of a group title.
//     That is the bare-first-name collision this exists to stop, and it is deliberately
//     strict: a lone first name is too weak a signal to pick among several threads, so
//     enrichment yields no context rather than a confidently wrong one.
function titleTokenMatch(query, title) {
  const qTokens = tokenize(query);
  const tTokens = tokenize(title);
  if (qTokens.length === 0 || tTokens.length === 0) return false;
  if (qTokens.length === 1) {
    // Whole title is exactly that one token, e.g. query "ZZMike" vs title "ZZMike".
    return tTokens.length === 1 && tTokens[0] === qTokens[0];
  }
  // Multi-token query: every token must appear as a whole token of the title.
  return qTokens.every((q) => tTokens.includes(q));
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// All stored threads whose title token-matches the query (enrichment-only helper).
function strictTitleMatches(query) {
  let files = [];
  try {
    files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(STORE_DIR, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((t) => titleTokenMatch(query, t.title));
}

function threadSummary(t) {
  return {
    threadKey: t.threadKey,
    title: t.title || null,
    contactHint: t.contactHint || null,
    messageCount: (t.messages || []).length,
  };
}

function formatThread(t, limit) {
  // Chronological slice. Messages are already time-sorted on write, but outgoing rows
  // and incoming rows arrive in separate sweeps, so re-sort here defensively before the
  // tail-slice — otherwise the last N could miss an outgoing message that sorts earlier.
  const ordered = (t.messages || [])
    .slice()
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const msgs = ordered.slice(-Math.max(1, limit)).map((m) => ({
    text: m.bigText && m.bigText.length > (m.text || '').length ? m.bigText : m.text,
    // Direction lets Alfred see the real back-and-forth: 'outgoing' = Josh's own sends
    // (Phase 2, SMS sent box), 'incoming' = received. Legacy records w/o direction → incoming.
    direction: m.direction || 'incoming',
    ts: m.ts,
    at: m.ts ? new Date(m.ts).toISOString() : null,
  }));
  return {
    found: true,
    threadKey: t.threadKey,
    title: t.title || null,
    contactHint: t.contactHint || null,
    count: msgs.length,
    messages: msgs,
  };
}

module.exports = {
  STORE_DIR,
  isMessagingNotification,
  normalizeNumber,
  threadKeyFromTitle,
  recordNotification,
  recordNotifications,
  recordOutgoingMessages,
  readThread,
  readThreadForNotification,
};
