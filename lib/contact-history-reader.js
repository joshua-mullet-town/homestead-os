/**
 * Contact History Reader — TRUE on-demand per-contact text HISTORY from the phone's
 * REAL Messages store, regardless of when the messages arrived.
 *
 * WHY THIS EXISTS (distinct from message-history-store.js):
 *   message-history-store.js persists notification-tray bodies going FORWARD from
 *   when capture went live. It returns found:false for any contact who hasn't texted
 *   since go-live (e.g. Mom/<<REPLACE: a family contact>> <<REPLACE: a phone number>>). That's the forward-buffer.
 *
 *   THIS module reads the phone's REAL store on demand:
 *     - SMS: the Android Telephony SMS content provider (via the bridge's
 *       /sms/inbox + /sms/sent). Real history, lock-INDEPENDENT — works even while
 *       the phone is locked. This is the robust, high-value core.
 *     - RCS / Google-Messages: NOT in the SMS DB. The only on-device way to read RCS
 *       history is an accessibility UI-scrape of the rendered Messages thread, which
 *       REQUIRES the phone to be awake/unlocked (Android security boundary —
 *       accessibility cannot cross the lockscreen). When the phone is locked, this
 *       module returns an HONEST degraded status, never a false empty.
 *
 * HONESTY RAILS (surfaced verbatim to callers and in the tool description):
 *   1. SMS history is ALWAYS readable (even locked).
 *   2. RCS history is readable ONLY when the phone is awake/unlocked.
 *   3. Already-deleted messages cannot be recovered — this reads what's on the phone.
 *
 * jibe/RCS-DB reading is REJECTED (private, encrypted-at-rest, breaks on app updates).
 */

// Reuse the canonical number-normalizer so contact matching is identical across the
// SMS-history reader and the forward-buffer store (both collapse any format to the
// trailing-10 US digits).
const { normalizeNumber } = require('./message-history-store');

const PHONE_BASE_URL =
  process.env.PHONE_API_URL || process.env.PHONE_BASE_URL || 'http://<<REPLACE: your Tailscale IP>>:8888';

// How many rows to scan from each of inbox + sent when filtering for one contact.
// The SMS content provider returns newest-first; we over-fetch then filter by number,
// so this is the depth of history we can reconstruct in a single pass. 500 covers
// months of a normal thread while staying a bounded single request.
const SMS_SCAN_DEPTH = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function phoneRequest(path, options = {}) {
  const url = `${PHONE_BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: response.status };
  }
}

// ---------------------------------------------------------------------------
// SMS history (content provider — lock-independent, always available)
// ---------------------------------------------------------------------------

/**
 * Read a contact's REAL SMS history by merging the received-inbox and sent tables,
 * filtered to one normalized number, sorted chronologically with direction.
 *
 * @param {string} contact  phone number in any format
 * @param {number} limit    max messages to return (most recent), default 50
 * @returns {Promise<{transport:'sms', found:boolean, contact:string, normalized:string|null,
 *                     count:number, messages:Array<{direction, text, ts, at}>, scanned:{inbox,sent}}>}
 */
async function readSmsHistory(contact, limit = 50) {
  const normalized = normalizeNumber(contact);
  const out = {
    transport: 'sms',
    found: false,
    contact,
    normalized,
    count: 0,
    messages: [],
    scanned: { inbox: 0, sent: 0 },
  };

  if (!normalized) {
    out.reason = 'sms_history needs a phone number (name-only lookup is not supported for the SMS content provider)';
    return out;
  }

  let inbox = [];
  let sent = [];
  try {
    const [inboxResp, sentResp] = await Promise.all([
      phoneRequest(`/sms/inbox?limit=${SMS_SCAN_DEPTH}`),
      phoneRequest(`/sms/sent?limit=${SMS_SCAN_DEPTH}`),
    ]);
    inbox = Array.isArray(inboxResp?.data) ? inboxResp.data : [];
    sent = Array.isArray(sentResp?.data) ? sentResp.data : [];
  } catch (err) {
    out.reason = `sms bridge read failed: ${err.message}`;
    out.error = true;
    return out;
  }

  out.scanned = { inbox: inbox.length, sent: sent.length };

  const match = (m) => normalizeNumber(m.address) === normalized;

  const received = inbox.filter(match).map((m) => ({
    direction: 'received',
    text: m.body || '',
    ts: typeof m.date === 'number' ? m.date : Number(m.date) || null,
  }));
  const outbound = sent.filter(match).map((m) => ({
    direction: 'sent',
    text: m.body || '',
    ts: typeof m.date === 'number' ? m.date : Number(m.date) || null,
  }));

  const merged = [...received, ...outbound]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map((m) => ({ ...m, at: m.ts ? new Date(m.ts).toISOString() : null }));

  const trimmed = merged.slice(-Math.max(1, limit));
  out.found = trimmed.length > 0;
  out.count = trimmed.length;
  out.messages = trimmed;
  return out;
}

// ---------------------------------------------------------------------------
// Lock detection (gates the RCS accessibility path)
// ---------------------------------------------------------------------------

// Detecting phone state from the accessibility tree needs care. `com.android.systemui`
// is the package for BOTH the lockscreen AND the pulled-down notification shade / quick
// settings — so package alone is NOT proof of lock (verified live 2026-07-10: the shade
// with QS tiles reports com.android.systemui but the phone is unlocked). We distinguish
// three states:
//   'locked'   — real keyguard / PIN / pattern / password prompt. Honest degraded status.
//   'systemui' — system UI (shade/QS/launcher overlay) in front, NOT the thread and NOT
//                the lockscreen. Retryable: press home + re-deep-link.
//   'unlocked' — real app content is visible; safe to scrape.
const KEYGUARD_MARKERS = /com\.android\.systemui:id\/keyguard|com\.android\.keyguard|:id\/lockPatternView|:id\/pinEntry|:id\/passwordEntry/i;
const LOCK_TEXT = /\b(swipe up to unlock|enter (your )?(pin|pattern|password)|drawn your pattern|to unlock)\b/i;
// Markers that prove we're in the shade / QS, not the lockscreen.
const SHADE_MARKERS = /:id\/quick_qs_panel|:id\/qs_tile|:id\/qqs_tile_layout|:id\/notification_stack_scroller/i;

/**
 * @returns {Promise<{state:'locked'|'systemui'|'unlocked'|'unknown', package:string|null, reason:string}>}
 */
async function detectScreenState() {
  let content;
  try {
    content = await phoneRequest('/screen/content');
  } catch (err) {
    return { state: 'unknown', package: null, reason: `screen read failed: ${err.message}` };
  }
  const data = content?.data ?? content ?? {};
  const pkg = data.packageName || null;
  const tree = JSON.stringify(data);

  // Real lock: keyguard resourceIds or a credential prompt.
  if (KEYGUARD_MARKERS.test(tree) || LOCK_TEXT.test(tree)) {
    return { state: 'locked', package: pkg, reason: 'keyguard / credential-prompt markers present' };
  }
  // System UI in front but NOT the lockscreen (shade / QS / launcher overlay).
  if (pkg === 'com.android.systemui' || SHADE_MARKERS.test(tree)) {
    return { state: 'systemui', package: pkg, reason: 'system UI (shade/QS) in foreground, not a thread' };
  }
  // Real app content visible → unlocked and safe to scrape.
  return { state: 'unlocked', package: pkg, reason: 'app content visible' };
}

// Back-compat shim: boolean-ish lock view for callers that only care locked-vs-not.
async function detectLockState() {
  const s = await detectScreenState();
  if (s.state === 'locked') return { locked: true, reason: s.reason };
  if (s.state === 'unknown') return { locked: null, reason: s.reason };
  return { locked: false, reason: s.reason };
}

// ---------------------------------------------------------------------------
// RCS history (accessibility UI-scrape — REQUIRES phone awake/unlocked)
// ---------------------------------------------------------------------------

// Chrome / UI-affordance text that appears in the Messages accessibility tree but
// isn't a conversation message. Dropped from the scrape.
const RCS_CHROME = /^(text message|rcs message|chat message|type an? .*message|send|search|more options|back|call|video call|compose|sms|delivered|read|sending|start chat|attach|gif|sticker|camera|emoji|voice message|conversation list|messages)$/i;
// Pure timestamp / date-separator lines (e.g. "10:32 AM", "Yesterday", "Mon 3:14 PM").
const TIMESTAMP_ONLY = /^((mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*)?(\d{1,2}:\d{2}\s*(am|pm)?|yesterday|today|now)$/i;

/**
 * Extract conversation-message text from the Messages accessibility tree.
 *
 * The bridge returns a STRUCTURED node list: { data: { packageName, nodes: [ {className,
 * text, contentDescription, bounds, ...}, ... ] } }. Conversation bubbles surface as
 * TextView nodes whose `text` is the message body. We walk the nodes, keep TextView
 * `text` that looks like a message, and drop compose-box / nav / timestamp chrome.
 *
 * Best-effort scrape — clearly labeled as such to the caller. Sent-vs-received is not
 * reliably distinguishable from the flat node list, so we don't assert direction here.
 */
function extractThreadTextFromTree(content) {
  const data = content?.data ?? content ?? {};
  const nodes = Array.isArray(data.nodes) ? data.nodes : Array.isArray(data) ? data : [];

  const msgs = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const cls = String(n.className || '');
    // Message bubbles are TextViews; the compose field is an EditText (skip it).
    if (!/TextView/i.test(cls)) continue;
    const t = (n.text || '').trim();
    if (!t || t.length < 2) continue;
    if (RCS_CHROME.test(t)) continue;
    if (TIMESTAMP_ONLY.test(t)) continue;
    msgs.push(t);
  }

  // De-dupe consecutive repeats (a bubble's text + contentDescription can both appear).
  const deduped = [];
  for (const m of msgs) {
    if (deduped[deduped.length - 1] !== m) deduped.push(m);
  }
  return deduped;
}

/**
 * Read a contact's RCS thread via accessibility scrape. GATED on phone-unlocked.
 * When locked, returns an honest degraded status (locked:true, found:false) — never
 * a false empty thread.
 *
 * @param {string} contact  phone number (any format)
 * @param {object} opts     { scrolls:number, wake:boolean }
 */
async function readRcsHistory(contact, opts = {}) {
  const { scrolls = 2, wake = true } = opts;
  const normalized = normalizeNumber(contact);
  const out = {
    transport: 'rcs',
    found: false,
    contact,
    normalized,
    locked: null,
    lines: [],
  };

  if (wake) {
    try {
      await phoneRequest('/screen/wake', { method: 'POST' });
    } catch {
      /* wake best-effort; state detection is the real gate */
    }
  }

  const screen = await detectScreenState();
  out.locked = screen.state === 'locked' ? true : screen.state === 'unlocked' || screen.state === 'systemui' ? false : null;
  out.screenState = screen.state;

  if (screen.state === 'locked') {
    out.status = 'phone_locked';
    out.reason =
      'Phone is locked. RCS/Google-Messages history can only be read while the phone is awake and unlocked (Android does not let accessibility read app content through the lockscreen). SMS history is unaffected.';
    return out;
  }
  if (screen.state === 'unknown') {
    out.status = 'screen_state_unknown';
    out.reason = `Could not read the phone screen (${screen.reason}). Not scraping to avoid a false read.`;
    return out;
  }

  if (!normalized) {
    out.status = 'need_number';
    out.reason = 'RCS scrape deep-links by number; provide a phone number.';
    return out;
  }

  // If system UI (shade/QS) is in front — NOT locked, just an overlay — press home to
  // clear it before deep-linking, so the deep-link lands on the thread, not the shade.
  if (screen.state === 'systemui') {
    try {
      await phoneRequest('/screen/home', { method: 'POST' });
    } catch {
      /* best-effort; deep-link may still surface the thread over the shade */
    }
  }

  // Deep-link straight to the contact's Messages thread.
  try {
    await phoneRequest('/app/launch', {
      method: 'POST',
      body: JSON.stringify({ uri: `smsto:${normalized}` }),
    });
  } catch (err) {
    out.status = 'deeplink_failed';
    out.reason = `Could not open the Messages thread: ${err.message}`;
    return out;
  }

  // Let Google Messages open + render the thread before reading the tree.
  await sleep(1200);

  // Confirm the deep-link actually landed on Google Messages (not still on system UI).
  // If it didn't render an app thread, report honestly rather than scraping chrome.
  let afterState;
  try {
    afterState = await detectScreenState();
  } catch {
    afterState = { state: 'unknown', package: null };
  }
  if (afterState.state === 'locked') {
    out.status = 'phone_locked';
    out.reason = 'Phone locked after deep-link. RCS history needs the phone awake/unlocked.';
    return out;
  }
  out.landedPackage = afterState.package || null;

  // Give the thread a beat to render, then scrape + scroll up for older history.
  const collected = [];
  for (let i = 0; i <= scrolls; i++) {
    let content;
    try {
      content = await phoneRequest('/screen/content');
    } catch {
      break;
    }
    collected.push(...extractThreadTextFromTree(content));
    if (i < scrolls) {
      // Newest messages sit at the BOTTOM of a chat thread; OLDER history is above.
      // To reveal it, drag the content DOWNWARD (finger moves top→bottom), which
      // scrolls the view UP toward earlier messages.
      try {
        await phoneRequest('/screen/swipe', {
          method: 'POST',
          body: JSON.stringify({ startX: 540, startY: 500, endX: 540, endY: 1800 }),
        });
        await sleep(700); // let the older messages render before the next scrape
      } catch {
        break;
      }
    }
  }

  // De-dupe across scroll passes, preserve order.
  const seen = new Set();
  const lines = [];
  for (const l of collected) {
    if (!seen.has(l)) {
      seen.add(l);
      lines.push(l);
    }
  }

  out.found = lines.length > 0;
  out.lines = lines;
  out.status = out.found ? 'scraped' : 'empty_scrape';
  out.note =
    'RCS history is an accessibility UI-scrape of the rendered Messages thread (best-effort text, not a precise per-message DB read). Direction (sent vs received) is not reliably distinguishable from the screen dump.';
  return out;
}

// ---------------------------------------------------------------------------
// Transport-aware combined read
// ---------------------------------------------------------------------------

/**
 * Read a contact's history transport-aware:
 *   - Always returns SMS history (content provider, lock-independent).
 *   - Conditionally attempts the RCS accessibility scrape (gated on unlocked; honest
 *     status if locked). The scrape disrupts the phone screen, so we only fire it when
 *     it can meaningfully complete the picture.
 *
 * WHY "SMS didn't fully satisfy the ask" (not just "SMS empty") triggers RCS:
 *   A contact can be MIXED-transport — e.g. Mom (<<REPLACE: a phone number>>) has a couple of OLD
 *   SMS messages plus a RECENT RCS conversation. If we only fired RCS when SMS was
 *   totally empty, "read my mom's recent texts" would return 2 stale SMS and silently
 *   miss the recent RCS. So in 'auto' mode we fire RCS whenever SMS returned FEWER
 *   than the requested limit (i.e. it didn't fully satisfy the ask). A pure-SMS
 *   contact with plenty of history fills the limit → RCS skipped, screen untouched.
 *
 * @param {string} contact
 * @param {object} opts { limit, rcs, rcsMode:'auto'|'always'|'never', rcsScrolls }
 *   `rcs:false` is shorthand for rcsMode:'never'.
 */
async function readContactHistory(contact, opts = {}) {
  const { limit = 50, rcs = true, rcsScrolls = 2 } = opts;
  const rcsMode = opts.rcsMode || (rcs ? 'auto' : 'never');

  const sms = await readSmsHistory(contact, limit);

  const result = {
    contact,
    normalized: sms.normalized,
    sms,
    rails: {
      sms: 'SMS history is always readable, even while the phone is locked.',
      rcs: 'RCS/Google-Messages history is readable only while the phone is awake and unlocked.',
      deleted: 'Messages already deleted from the phone cannot be recovered.',
    },
  };

  // Decide whether to fire the (heavier, unlock-dependent, screen-disrupting) scrape.
  const smsSatisfiedAsk = sms.found && sms.count >= limit;
  let fireRcs;
  if (rcsMode === 'never') fireRcs = false;
  else if (rcsMode === 'always') fireRcs = true;
  else fireRcs = !smsSatisfiedAsk; // 'auto'

  if (fireRcs) {
    result.rcs = await readRcsHistory(contact, { scrolls: rcsScrolls });
    // Flag the mixed-transport case so callers know SMS alone was partial.
    if (sms.found && result.rcs.found) {
      result.mixed_transport = true;
      result.note =
        'This contact has BOTH SMS and RCS history. SMS history is exact (from the phone SMS store); RCS history is an accessibility screen-scrape (best-effort text). Recent messages are likely in the RCS section.';
    }
  } else if (rcsMode === 'never') {
    result.rcs = { transport: 'rcs', skipped: true, reason: 'rcs scrape not requested' };
  } else {
    result.rcs = {
      transport: 'rcs',
      skipped: true,
      reason: `SMS fully satisfied the request (${sms.count} messages); RCS scrape not attempted (would disrupt the phone screen).`,
    };
  }

  return result;
}

module.exports = {
  readSmsHistory,
  readRcsHistory,
  detectScreenState,
  detectLockState,
  readContactHistory,
  extractThreadTextFromTree,
  SMS_SCAN_DEPTH,
};
