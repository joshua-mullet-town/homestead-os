import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
// Transport-agnostic message-history store (closes the RCS on-demand thread-read gap).
// Plain-JS CommonJS module; require() keeps it usable by both this TS route and the
// plain-JS backstop cron (check-notifications.js) without a build step.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const messageHistory = require('@/lib/message-history-store');
// Sender -> suggested-steward routing (SUGGEST-CONFIRM). Annotates the notification with
// a `suggested_steward` HINT off Alfred's live-read routing table before this route
// walkies Alfred; Alfred still confirms + forwards. Never auto-forwards, never drops,
// never changes target_session. Fail-open: null suggestion leaves it unannotated.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { suggestSteward } = require('@/lib/routing-suggester');
// Atomic temp+rename writer — the same one every queue.json writer uses. The
// notification-check state file is shared with the check-notifications cron, so
// a non-atomic write here can be read half-written by that other process.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { writeJsonAtomicSync } = require('@/lib/atomic-write');
const { localStamp } = require('@/lib/local-stamp');

/**
 * Notification Ingest (Phase 1 — real-time push)
 *
 * Receives ONE phone notification pushed on-arrival by the Homestead mobile app
 * (HomesteadNotificationListener.onNotificationPosted -> POST here), applies the
 * same ignore-filter + dedupe the 5-min backstop cron (check-notifications.js)
 * uses, and walkies holler-alfred IMMEDIATELY for relevant ones.
 *
 * Architecture (Josh-approved 2026-07-02, Option B):
 *   phone onNotificationPosted -> POST /api/notification-ingest -> filter+dedupe -> walkie Alfred
 *   Alfred owns read/route/identity. Rooster owns this wiring.
 *   The 5-min cron (check-notifications.js) stays as the BACKSTOP; shared dedupe
 *   by notification `key` makes push+backstop double-delivery a no-op.
 *
 * Contract pinned to Homestead 2026-07-02 (queue id 1783021134118-mygycy):
 *   body = phone NotificationData serialized as-is + { source: 'phone-push' }.
 *
 * Filtering posture: MINIMAL mechanical filter (ignored apps / Tire-Rack Slack)
 * mirroring check-notifications.js. Alfred is the brain; ingest only drops the
 * obvious noise the phone shouldn't even bother relaying. (Filter-amount / whether
 * to unify with the configurable notification-filters.json is a SEPARATE cleanup
 * pending Homestead Scribe's ruling — kept factored here so it's a one-spot change.)
 */

// Live walkie queue the dispatcher reads every 10s (queue-dispatcher.js:28).
// NOTE: this is ~/.homestead/queue.json — NOT ~/.homestead/stewards/queue.json.
const QUEUE_FILE = join(homedir(), '.homestead', 'queue.json');

// SHARED dedupe store — the SAME `phone_seen_keys` the 5-min backstop cron
// (check-notifications.js) reads/writes. This is what makes push+backstop
// double-delivery an actual no-op: push pre-seeds a notification's key here,
// so the next cron sweep sees it already-seen and skips it (instead of
// re-delivering).
//
// PATH IS LOAD-BEARING (2026-07-02, second bug): the cron's STATE_FILE is
// `process.cwd()/data/notification-check-state.json` (check-notifications.js:17),
// and the scheduler runs it with cwd=~/code/homestead → the cron's real file is
// ~/code/homestead/data/notification-check-state.json. An EARLIER attempt pointed
// this at ~/.homestead/notification-check-state.json — a DIFFERENT file the cron
// never reads — so push's writes went to a dead file and the cron still
// double-delivered (Alfred's <<REPLACE: a family contact>> test caught it). This MUST resolve to the
// cron's actual file. Anchored to the Homestead app root (this route runs from
// ~/code/homestead), matching the cron's process.cwd()/data.
const STATE_FILE = join(process.cwd(), 'data', 'notification-check-state.json');
// Rolling cap. MUST match SEEN_MAX in lib/check-notifications.js — both
// processes write this one ledger, so a disagreement lets one truncate the other.
const SEEN_MAX = 4000;

// Compute the dedupe key EXACTLY as check-notifications.js phoneDedupeKey() does,
// so a key written by push matches the key the cron derives for the same
// notification (shared phone_seen_keys store — MUST stay in lockstep with the cron).
// Android key alone when present (stable per-post identity); else pkg:title::len<N>.
// Was `${baseKey}::${text.substring(0,50)}` — emoji-unstable, re-fired forever
// (Alfred-flagged 2026-07-04). If you change this, change check-notifications.js's
// phoneDedupeKey to match.
// MESSAGING EXCEPTION (2026-09-02) — MUST stay identical to phoneDedupeKey() in
// lib/check-notifications.js; the two derive keys for the SAME shared ledger.
// Conversation apps reuse one android key per thread and update it in place, so
// keying on the android key alone dropped every message after the first in a
// thread. Differentiate by the phone's own per-message `timestamp` — NOT a content
// hash, which would re-open the emoji-instability bug described above (the phone
// re-encodes emoji between pulls, so any function of the text drifts and re-fires
// forever). Scope is `category === 'msg'` only, so status-style notifications keep
// bare-key dedupe. Falls back to the bare key when no usable timestamp exists.
function dedupeKey(n: NotificationData): string {
  if (n.key) {
    if ((n.category || '') === 'msg') {
      const ts = messageStamp(n);
      if (ts) return `${n.key}::msg${ts}`;
    }
    return n.key;
  }
  const baseKey = `${n.packageName || n.appName}:${n.title}`;
  return `${baseKey}::len${(n.text || '').length}`;
}

// The phone's per-message timestamp as a stable string, or null when unusable.
// Arrives as a number or a stringified number ('None' when absent).
function messageStamp(n: NotificationData): string | null {
  const raw = n.timestamp as unknown;
  if (raw === undefined || raw === null) return null;
  const str = String(raw);
  if (!/^\d+$/.test(str)) return null;
  return str;
}

// --- Mechanical ignore filter (mirrors check-notifications.js IGNORED_APPS) ---
const IGNORED_APPS = new Set<string>([
  'com.microsoft.office.outlook',
  'com.microsoft.teams',
  'com.homestead.mobile',
  'com.tailscale.ipn',
  'com.snapchat.android',
  'com.facebook.orca',
  'com.google.android.googlequicksearchbox',
  'com.sirma.mobile.bible.android',
  'com.google.android.calendar',
  'com.google.android.apps.weather',
  'com.google.android.apps.maps',
  'com.google.android.dialer',
  'com.google.android.gms',
  'com.google.android.odad', // Play Protect "Running checks on apps" — routine background security scans, never actionable. Emits ≥2 shapes (service/ongoing AND titled/clearable); explicit-package drop covers ALL shapes (Alfred-flagged 2026-07-04, the generic service rule only catches the ongoing shape).
  'com.chase.sig.android',
  'com.google.android.deskclock',
  'com.nanit.baby',
  'com.android.systemui',
  'android',
  'com.spotify.music',
  'com.linkedin.android',
  'com.google.android.permissioncontroller',
  'com.android.chrome',
]);

const IGNORED_SLACK_PATTERNS: RegExp[] = [
  /traci-/i,
  /<<REPLACE: your-employer>>/i,
  /trmi-/i,
  /mi_basecamp/i,
  /treadware/i,
  /^Jira \(bot\)$/i,
  /TRAC-\d+/i,
];

interface NotificationData {
  key: string;
  packageName: string;
  appName: string;
  title: string | null;
  text: string | null;
  bigText?: string | null;
  subText?: string | null;
  timestamp: number;
  isOngoing?: boolean;
  isClearable?: boolean;
  category?: string | null;
  actions?: string[];
  groupKey?: string | null;
  isGroupSummary?: boolean;
  source?: string;
}

function isIgnored(n: NotificationData): boolean {
  const app = n.packageName || n.appName;
  if (IGNORED_APPS.has(app)) return true;
  if (app === 'com.Slack') {
    const title = n.title || '';
    if (IGNORED_SLACK_PATTERNS.some(p => p.test(title))) return true;
  }
  // Generic background-service-status class (Alfred-flagged 2026-07-03): Android
  // foreground-service status posts (e.g. "Messages is doing work in the background",
  // Play Protect "Running checks on apps") are category:"service" + isOngoing + no
  // title — never actionable. Drop the whole class here instead of enumerating each
  // package in IGNORED_APPS. MUST stay consistent with check-notifications.js
  // isIgnoredNotification (the backstop cron) — same rule lives there.
  if (n.category === 'service' && n.isOngoing && !(n.title && n.title.trim())) {
    return true;
  }
  return false;
}

// Messaging apps whose notifications post in TWO phases: an EMPTY shell first
// (onNotificationPosted with null title+text while the RCS/SMS message is still
// being fetched/decrypted), then an UPDATE ~seconds later carrying the real sender
// + text. Google Messages is the confirmed offender (Alfred-flagged 2026-08-29:
// three empty pushes in 16 min, one of which was a real time-boxed invitation that
// nearly got silently dropped). The phone listener pushes on the FIRST post, so an
// empty shell reaches ingest and — un-guarded — gets walkied to Alfred as a
// contentless envelope (it READS like a truncated payload: only the _queue_id/
// _confirm tail is non-empty). Guard: suppress a messaging notification that has NO
// title AND NO text AND NO bigText — there is nothing to triage. The populated
// UPDATE re-posts with content and pushes then (different content → different dedupe
// key), and the 5-min backstop cron carries anything the update somehow misses.
// The DURABLE root-cause fix (debounce the empty shell on the phone) is routed to
// Homestead's notification listener; this ingest-side guard is the fast backstop so
// Alfred never receives a hollow envelope in the meantime.
const TWO_PHASE_MESSAGING_APPS = new Set<string>([
  'com.google.android.apps.messaging',
]);

function isEmptyMessagingShell(n: NotificationData): boolean {
  const app = n.packageName || n.appName;
  if (!TWO_PHASE_MESSAGING_APPS.has(app)) return false;
  const hasTitle = !!(n.title && n.title.trim());
  const hasText = !!(n.text && n.text.trim());
  const hasBigText = !!(n.bigText && n.bigText.trim());
  return !hasTitle && !hasText && !hasBigText;
}

// Read the SHARED phone_seen_keys the cron owns (from notification-check-state.json).
// Returns the raw JSON state object so markSeen can write back without clobbering
// the cron's other fields (gmail_last_check, phone_last_check, last_run, etc.).
function loadState(): { phone_seen_keys?: string[]; [k: string]: unknown } {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return {};
}

function loadSeen(): string[] {
  const s = loadState();
  return Array.isArray(s.phone_seen_keys) ? s.phone_seen_keys : [];
}

// Append `key` to the SHARED phone_seen_keys ledger without dropping the cron's
// other state fields. Rolling-capped.
//
// ON THE CONCURRENCY (comment corrected 2026-09-02). This used to say the
// read-modify-write was "racy vs the cron, but the cost of a lost write is at
// worst one extra double-delivery — not worth a lock." That reasoned about the
// wrong failure. The cron was not racing us for a key; it ASSIGNED the whole
// phone_seen_keys array from its current tray sweep, so on the ordinary path it
// discarded every entry this function had written, every five minutes. A stomp,
// not an occasional lost write — and the eventual double-delivery was routine
// rather than rare. The cron now MERGES instead (check-notifications.js), which
// is what actually makes this append durable.
//
// A genuine interleave is still possible (both processes read-modify-write this
// file), but with both sides now merging and writing atomically, the worst case
// really is one lost append — which IS acceptable for a safety-net dedupe, and
// is the claim the old comment was making without having earned it.
function unmarkSeen(key: string) {
  try {
    const state = loadState();
    const keys: string[] = Array.isArray(state.phone_seen_keys) ? state.phone_seen_keys : [];
    state.phone_seen_keys = keys.filter((k) => k !== key);
    writeJsonAtomicSync(STATE_FILE, state);
  } catch (err) {
    console.error('[NotifIngest] failed to unmark seen key:', err);
  }
}

function markSeen(key: string) {
  try {
    const state = loadState();
    const keys: string[] = Array.isArray(state.phone_seen_keys) ? state.phone_seen_keys : [];
    if (!keys.includes(key)) keys.push(key);
    state.phone_seen_keys = keys.slice(-SEEN_MAX);
    // ATOMIC (2026-09-02): temp+rename, so the cron can never read this
    // half-written. A torn read there is silently destructive — the reader's
    // try/catch swallows the parse error and falls back to an EMPTY ledger,
    // which re-relays everything currently in the tray.
    writeJsonAtomicSync(STATE_FILE, state);
  } catch (err) {
    console.error('[NotifIngest] failed to persist seen key to shared state:', err);
  }
}

// ASYNC + serialized (event-loop wedge fix): append through the dispatcher's
// mutateQueue() lock instead of a per-request sync readFileSync+writeFileSync of
// the whole queue.json. The dispatcher is a cached require in this same Node
// process (custom server.js), so this shares the SAME single-flight lock as the
// roger-that / enqueue paths — no cross-writer race, no loop block. The item
// shape (extra `type`/`attempts` fields, no walkie:enqueued socket emit) differs
// from enqueue(), so we push it ourselves inside the critical section.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const queueDispatcher = require('@/lib/queue-dispatcher');

// Bundle recent thread history onto a MESSAGING notification before Alfred triages it.
// DEFENSIVE by contract: if the store has no thread or throws, return the notification
// UNCHANGED (thread_context omitted) — never block the walkie on enrichment. Hard no-op
// for non-messaging notifications: readThreadForNotification gates on
// isMessagingNotification (the same predicate the write path uses) and returns
// {found:false, reason:'not_messaging'}. It did NOT before 2026-09-01 — an email post's
// bare-first-name title could substring-match an unrelated SMS thread and attach it.
const THREAD_CONTEXT_LIMIT = 10; // last ~10 messages
function enrichWithThreadContext(n: NotificationData): NotificationData & { thread_context?: unknown } {
  if (!n || !n.title) return n;
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
          // sends, Phase 2 — captured from the SMS sent box by the backstop cron).
          // Outgoing RCS sends are NOT captured (not in the SMS content provider), so a
          // purely-RCS thread may still show incoming-only — see note.
          messages: r.messages,
          note: 'interleaved incoming + outgoing; outgoing is SMS-sent-box only — outgoing RCS (chat-bubble) sends are not captured',
        },
      };
    }
  } catch (err) {
    console.error('[NotifIngest] thread-context enrich failed:', err);
  }
  return n; // no history (or error) → send the notification as-is
}

// Attach the sender->steward routing HINT (SUGGEST-CONFIRM). Adds suggested_steward/
// _topic/_note ONLY when the live routing table matched; no match (or missing/malformed
// table) → unchanged. Never throws, never forwards, never changes target_session.
function annotateRouting(
  n: NotificationData & { thread_context?: unknown }
): NotificationData & {
  thread_context?: unknown;
  suggested_steward?: string;
  suggested_topic?: string | null;
  suggested_note?: string | null;
  suggested_rule_id?: string | null;
} {
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
    console.error('[NotifIngest] routing-suggest failed:', err);
  }
  return n;
}

async function walkieAlfred(notification: NotificationData) {
  const id = `${Date.now()}-notif-push`;
  const enriched = annotateRouting(enrichWithThreadContext(notification));
  await queueDispatcher.mutateQueue((queue: unknown[]) => {
    queue.push({
      id,
      target_session: 'holler-alfred',
      type: 'action',
      message: JSON.stringify({
        type: 'action',
        trigger: 'notification_triage',
        from: 'notification-ingest', // distinguishes real-time push from the backstop cron ('notification-checker')
        notifications: [enriched], // single-notification envelope; same shape as the cron's batch, length 1
        // LOCAL time with offset, matching the cron backstop. This rides in the
        // walkie body to a steward's eye and is never machine-parsed, so fleet
        // doctrine (Steward Manager 2026-09-15, as amended: the test is WHO READS
        // the value, not which file it sits in) says convert and stamp the zone.
        // Both emitters share lib/local-stamp so this field cannot mean two
        // different things depending on which path fired.
        checked_at: localStamp(),
      }),
      status: 'pending',
      created_at: new Date().toISOString(),
      attempts: 0,
    });
    return queue;
  });
  return id;
}

export async function POST(request: NextRequest) {
  let n: NotificationData;
  try {
    n = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  if (!n || typeof n.key !== 'string' || !n.key) {
    // key is REQUIRED (dedupe id per contract). Reject cleanly so the phone can log it.
    return NextResponse.json({ ok: false, error: 'missing required field: key' }, { status: 400 });
  }

  // 0. Persist messaging-app bodies to the transport-agnostic history store BEFORE
  //    dedupe/ignore-filter. Thread history should be COMPLETE regardless of whether
  //    a given message is triage-relevant (a filtered/duplicate notification is still
  //    part of the conversation Alfred may want to read later). RCS + SMS both land
  //    here identically (tray-sourced). No-op for non-messaging notifications. Never
  //    blocks the walkie path — failures are swallowed inside the store.
  try {
    messageHistory.recordNotification(n);
  } catch (err) {
    console.error('[NotifIngest] message-history persist failed:', err);
  }

  // Composite dedupe key — SAME format the backstop cron derives (check-notifications.js:223-224),
  // so push and cron agree on identity for the same notification. This + the SHARED
  // phone_seen_keys store is what makes push+backstop double-delivery an actual no-op.
  const dkey = dedupeKey(n);

  // 1. Dedupe against the SHARED ledger (push OR a prior cron sweep already delivered it).
  const seen = loadSeen();
  if (seen.includes(dkey)) {
    console.log(`[NotifIngest] duplicate ${n.appName || n.packageName} "${(n.title || '').slice(0, 40)}"`);
    return NextResponse.json({ ok: true, action: 'duplicate' });
  }

  // 1.5. Two-phase messaging EMPTY-SHELL guard (Alfred-flagged 2026-08-29; ordering
  //    corrected 2026-08-29 after Homestead caught the hole below). A Google Messages
  //    notification pushed with no title/text/bigText is the pre-populated shell of an
  //    RCS/SMS message — nothing to triage yet, and relaying it hands Alfred a hollow
  //    envelope (which reads like a truncated payload).
  //
  //    ⚠️ THIS MUST RUN BEFORE isIgnored. An empty shell often carries
  //    category:"service"+isOngoing, which isIgnored() (line ~144) matches and then
  //    markSeen()s. And dedupeKey() returns the stable Android n.key (identical across
  //    a notification's shell→populated update), so a shell that gets marked seen makes
  //    the REAL populated update fail the step-1 dedupe and get dropped as "duplicate"
  //    — the exact near-miss this guard exists to prevent. So: skip the shell HERE,
  //    WITHOUT markSeen, before isIgnored can mark the shared key. The populated update
  //    (same n.key, never marked) then passes dedupe and walkies normally; the backstop
  //    cron remains a safety net. NOT a permanent drop — deliberately does NOT markSeen.
  if (isEmptyMessagingShell(n)) {
    console.log(`[NotifIngest] skipped empty messaging shell ${n.appName || n.packageName} (key ${n.key.slice(0, 24)}) — awaiting populated update`);
    return NextResponse.json({ ok: true, action: 'empty-shell-skip' });
  }

  // 2. Mechanical ignore-filter (obvious noise the phone shouldn't relay).
  if (isIgnored(n)) {
    // Mark seen in the shared ledger so the cron sweep also skips it.
    markSeen(dkey);
    console.log(`[NotifIngest] filtered ${n.appName || n.packageName} "${(n.title || '').slice(0, 40)}"`);
    return NextResponse.json({ ok: true, action: 'filtered' });
  }

  // 3. Relevant → walkie Alfred immediately + mark seen in the SHARED ledger
  //    (so the next cron sweep sees it already-delivered and does NOT re-carry it).
  // CLAIM THE KEY BEFORE THE AWAIT (double-emit fix, Alfred-flagged 2026-09-06).
  // markSeen() is atomic per write, but the CHECK at step 1 and the mark below
  // used to sit on opposite sides of `await walkieAlfred(n)`. Two pushes of the
  // SAME notification arriving milliseconds apart (observed: 2ms) both read a
  // ledger that lacked the key, both passed the dedupe gate, and both enqueued —
  // one real notification, two queue items, costing Alfred an extra roger each.
  // Claiming the key first closes the check-then-act window: the second request
  // now loses at step 1. On failure we UNCLAIM so the backstop cron still
  // catches it, preserving the original "do not mark seen on failure" contract.
  markSeen(dkey);
  try {
    const queueId = await walkieAlfred(n);
    console.log(`[NotifIngest] pushed ${n.appName || n.packageName} -> Alfred (queue ${queueId})`);
    return NextResponse.json({ ok: true, action: 'walkied', queueId });
  } catch (err) {
    console.error('[NotifIngest] failed to walkie Alfred:', err);
    // Do NOT leave it marked seen on failure — let the backstop cron catch it.
    unmarkSeen(dkey);
    return NextResponse.json({ ok: false, error: 'walkie failed' }, { status: 500 });
  }
}

// Health/debug: GET returns route liveness + seen-count so the phone Worker can
// verify the endpoint is up before/after the APK reinstall.
export async function GET() {
  return NextResponse.json({
    ok: true,
    route: '/api/notification-ingest',
    live: true,
    seen_count: loadSeen().length,
    target: 'holler-alfred',
  });
}
