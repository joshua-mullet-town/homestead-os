'use strict';

/**
 * potato-tracker.js — dropped-message accountability tracker (PURE-CODE close).
 *
 * ═══ WHAT A POTATO IS ═══
 * Every message JOSH originates becomes a POTATO. Josh's premise for killing the
 * 5-min babysit cron: "if a message is ever dropped, that steward gets rung." A
 * potato is the durable record of that guarantee — an OWED RESPONSE, recorded
 * TRACKER-SIDE against the steward Josh addressed. Invariant: a potato must
 * EVENTUALLY be answered by its holder (the holder sends SOMETHING) or the
 * corrections officer rings it. It CANNOT silently die.
 *
 * ═══ PURE-CODE CLOSE (the redesign — Josh REJECTED the envelope-storage model) ═══
 * The owed-response is NOT stored in the message envelope. No minted potato_id is
 * injected into any walkie. Instead:
 *   • BIRTH  — a Josh-originated message records a tracker-side owed-response keyed
 *     to the HOLDER (the steward Josh addressed). See recordBirthFromQueueItem.
 *   • CLOSE  — the loop closes on the HOLDER's NEXT OUTBOUND to ANYONE WHATSOEVER,
 *     observed at the enqueue() chokepoint via `envelope.from === holder`. The
 *     holder answered someone → the accountability loop is satisfied → close. No
 *     second card, no potato_id echo, no _queue_id guessing. This is the entire
 *     point: kill the redundant-card noise.
 *
 * ⚠️ CORRECTIONS-OFFICER RING MUST NEVER CLOSE (Top-mandated invariant).
 * The corrections officer's ring/raise post from a STATIC identity
 * `potato-corrections-officer` (NOT a real session). Close-match is on
 * `envelope.from === holder` AND explicitly EXCLUDES that static identity — a ring
 * can never close its own potato. Only the holder steward's OWN send closes. All
 * real steward sends use getTmuxSessionId() → from === exact session name, so the
 * from-match is reliable.
 *
 * ═══ WHERE A POTATO IS BORN (verified anchors) ═══
 * A potato is born ONLY for Josh-originated messages. Two entry paths:
 *   1. Bottom-bar fresh send — server.js → queueDispatcher.enqueue() with envelope
 *      {type:'action', from:'josh-presenter', instruction}. Discriminator:
 *      from === 'josh-presenter'.
 *   2. Card reply feedback — presenter-queue.js writeFeedbackToQueue() with
 *      envelope {type:'feedback', source:'presenter', …}. Discriminator:
 *      source === 'presenter'.
 * Ordinary steward↔steward traffic (from === '<session>') is NOT a birth — but it
 * IS the CLOSE trigger when that <session> holds an open potato.
 *
 * ═══ DURABILITY ═══
 * The ledger lives in ~/.homestead/potato-tracker.json — a SEPARATE store from
 * queue.json, which drains terminal items to a dated archive after 60s. Potato
 * history must survive that drain, so it lives here, keyed by potato_id.
 *
 * ═══ HEARTBEAT / CORRECTIONS OFFICER ═══
 * A watchdog periodically asks "who holds each open potato, and are they working?"
 * The is_working signal comes from /tmp/claude-session-<name>-activity.json (the
 * SAME signal lib/check-stalled-workers.js reads). This module implements the
 * heartbeat READ + the two-strike suspicion state machine, the pane re-confirm,
 * the ring, and the Rooster raise. NONE of these close a potato.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const HOMESTEAD_DIR = path.join(os.homedir(), '.homestead');
// Durable ledger — deliberately NOT queue.json (which drains after 60s).
const LEDGER_FILE = process.env.POTATO_LEDGER_FILE || path.join(HOMESTEAD_DIR, 'potato-tracker.json');

// Josh-origin discriminators — a potato is born only when a queued item's parsed
// envelope carries one of these. Verified against the two real entry paths above.
const JOSH_FROM = 'josh-presenter';           // path 1: bottom-bar fresh send
const PRESENTER_SOURCE = 'presenter';          // path 2: card reply feedback

// ── ack-set (birth suppression for terminal acknowledgments) ─────────────────
// A Josh card-reply whose button is a pure ACK ("Good" / 👍 / "Dismiss") AND whose
// text field is EMPTY is Josh CLOSING a loop, not opening one — nothing is owed
// back, so it must NOT birth a potato (else the corrections officer nags a steward
// whose correct move is internal-only, sending nothing). See isPureAcknowledgment.
//
// TIGHT EXPLICIT ALLOWLIST — co-owned with Rooster (officer-adjacent doctrine),
// birth logic is SM's lane. Matched case-insensitively against the trimmed button.
// DO NOT convert to a fuzzy/regex/LLM heuristic: the failure mode of a false
// POSITIVE (suppressing a birth that was actually owed) is a silently-dropped Josh
// message — the exact failure the whole tracker exists to prevent. Fail toward
// BIRTHING on any doubt. Grow this list only by explicit addition.
// NOTE: 'ok'/'okay' deliberately EXCLUDED (Rooster ruling 2026-07-24, list co-owner):
// "OK" is ambiguous — it can mean "OK, proceed/do it" (an action IS owed), so
// suppressing it risks a false-negative (dropped Josh instruction). 'thanks' kept —
// it almost never carries a hidden instruction.
const ACK_BUTTONS = new Set([
  'good', 'perfect', 'got it', 'gotit', 'great', 'thanks', 'thank you',
  'dismiss', 'acknowledged', 'ack', 'nice', 'awesome', '👍',
]);

// ── ack-TEXT set (the Voice Response shape) ─────────────────────────────────
// SHAPE MISMATCH, NOT A WIDER POLICY (Rooster ruling 2026-09-10, list co-owner).
// 'thank you' was ALREADY an ack and the tracker ALREADY suppressed it — but only
// when it arrived as the BUTTON with text empty. Josh's Voice Response puts what he
// SAID into the free `text` field under a generic button label ("Voice Response"),
// so the existing rule literally cannot see it: the envelope reads as a typed reply,
// and any typed text is an owed response by design. Live miss:
// origin_q=1789006085498-7732b0 (2026-09-10T02:08Z) — Josh said only "Thank you."
// and the holder (a GiveGrove worker) got rung over a bare thanks into an EMPTY deck.
//
// SEPARATE SET FROM ACK_BUTTONS ON PURPOSE. ACK_BUTTONS holds UI verbs Josh would
// never SAY out loud — 'dismiss', 'ack', 'acknowledged'. Spoken text is a different
// channel with different content, so it gets its own explicit list. Same doctrine as
// above applies with full force: TIGHT EXPLICIT ALLOWLIST, no fuzzy/regex/LLM
// heuristic, grow only by explicit addition, FAIL TOWARD BIRTHING on any doubt.
//
// SIZED AGAINST REAL TRAFFIC BEFORE SHIPPING, twice, by two parties independently
// (me over the September queue archives, then Rooster by a different method — split,
// collapse, whole-content match). Of 282 September card-replies carrying text, this
// rule suppresses EXACTLY 2 — 2026-09-07T21:34 and 2026-09-10T02:08, both literally
// "Thank you." — with ZERO ambiguous hits. The floor for changing this list is
// re-running that corpus, not an argument.
const ACK_TEXT = new Set([
  'thank you', 'thanks', 'thank you so much', 'thanks so much',
  'thank you very much', 'thanks a lot', 'thankyou',
  'good', 'perfect', 'great', 'nice', 'awesome', 'got it', 'gotit',
  'sounds good', 'looks good', 'perfect thank you', 'great thank you',
  'nice work', 'good work', 'well done', 'love it',
]);
// Deliberately EXCLUDED from ACK_TEXT, mirroring the ACK_BUTTONS ruling of
// 2026-07-24: 'ok' / 'okay' / 'sure' / 'yes' / 'yep' / 'do it' — every one of them
// can mean "OK, PROCEED" (an action IS owed). Suppressing those risks a false
// negative, i.e. a silently-dropped Josh instruction, which is strictly worse than
// a spurious potato. Also excluded: the UI verbs from ACK_BUTTONS ('dismiss',
// 'ack', 'acknowledged') — Josh does not say those, so a transcript containing them
// is more likely real content than an ack.

// Static identity the corrections officer rings/raises FROM (ringHolder /
// raiseRooster below). A ring is the TRACKER's own notification — NOT the holder's
// send — so an envelope from this identity MUST NEVER close a potato (Top-mandated
// invariant). recordCloseFromQueueItem explicitly excludes it.
const CORRECTIONS_OFFICER_FROM = 'potato-corrections-officer';

// Heartbeat cadence (settled spec: "TWO checks 5s apart"). The corrections
// officer only escalates suspicion after TWO consecutive not-working reads
// STRIKE_INTERVAL_MS apart. Env-overridable for tests.
const STRIKE_INTERVAL_MS = parseInt(process.env.POTATO_STRIKE_INTERVAL_MS || '5000', 10);
// A potato is only a heartbeat candidate once it's been open at least this long —
// avoids ringing a holder in the first seconds after a pass, before they've had a
// chance to pick up the walkie. Env-overridable for tests.
const HEARTBEAT_GRACE_MS = parseInt(process.env.POTATO_HEARTBEAT_GRACE_MS || '15000', 10);
// An activity file older than this is considered STALE (the session may be asleep
// or its hooks aren't firing) — we do not treat a stale file as "working".
const ACTIVITY_STALE_MS = parseInt(process.env.POTATO_ACTIVITY_STALE_MS || '120000', 10);
// After a SILENT STAND-DOWN (false alarm — holder turned out to be working at the
// pane re-confirm), don't re-strike the same potato for this long. Prevents the
// corrections officer from re-flagging a working-but-briefly-idle holder every
// pass. Env-overridable for tests.
const STANDDOWN_COOLDOWN_MS = parseInt(process.env.POTATO_STANDDOWN_COOLDOWN_MS || '30000', 10);

// ── ESCALATION FLOORS (false-alarm fix, measured 2026-08-31) ────────────────
// MEASURED ROOT CAUSE (confirmed independently across the whole ledger: all 131
// potatoes carrying both a ring and a raise): the ring→raise window was min 4.8s,
// MEDIAN 9.995s, max 778s — 126/131 escalated in UNDER 30 SECONDS, 122/131 under
// 15s. Birth→raise was worse: MEDIAN 34s, with 86/131 raises firing under a minute
// from birth. Ten seconds is LESS THAN ONE TOOL CALL. A steward that reads Josh's
// card and starts working gets raised to Rooster before it can finish a single Bash
// call. Live case: holler-homestead was rung + raised while actively re-laning ten
// cards and spawning a worker off Josh's own instruction — doing exactly what the
// potato wanted, flagged as stuck.
//
// WHY THIS IS LOAD-BEARING: flagging working stewards trains everyone (stewards AND
// Rooster) to read DROPPED-MESSAGE ALERTS as background static. That's alert
// fatigue — the flag stops carrying information precisely when a REAL dropped
// message needs it. The gates below cut false alarms WITHOUT ever silencing a
// genuine drop: they suppress only on POSITIVE EVIDENCE OF WORK (a real outbound,
// or a live pane working-marker), never by blanket-suppressing.
//
// SIZED FROM OUTCOMES, NOT FROM THE GAP (re-measured 2026-09-03 over 137 raises).
// The earlier 90s/45s floors were derived from how fast the officer fired. That was
// the wrong question. The right one is how long a holder actually takes to answer:
// of 137 raised potatoes, 133 WERE ANSWERED BY THEIR HOLDER AFTER THE RAISE, median
// 191s later — the holders were never dark, the officer just asked too early. Birth
// ->answer runs p25 178s / MEDIAN 310s / p75 617s, so a 90s raise floor suppressed
// only 8 of those 133 false alarms (6%). At 10 minutes it suppresses 99 (74%) while
// still catching a genuinely dark holder well inside Josh's tolerance. The floors
// DELAY a raise, never cancel one: a truly dropped message still escalates on a
// later pass, just after the window where "quiet" mostly means "still typing".
// A raise to Rooster is the loud, expensive step, so it carries the higher floor.
const RAISE_FLOOR_MS = parseInt(process.env.POTATO_RAISE_FLOOR_MS || '600000', 10);
// The ring is the cheap, in-band nudge to the holder itself (not an alert to a third
// party), so it gets a lower floor — but still far above one tool call.
const RING_FLOOR_MS = parseInt(process.env.POTATO_RING_FLOOR_MS || '180000', 10);

// Where the outbound-evidence scan looks. The live queue holds in-flight items; the
// dated archive holds everything drained out of it (queue.json drains terminal items
// after 60s, so recent history lives ONLY in the archive).
// Env-overridable so tests can point the outbound scan at a fixture dir instead of
// the live fleet queue (mirrors POTATO_LEDGER_FILE).
const QUEUE_DIR = process.env.POTATO_QUEUE_DIR || HOMESTEAD_DIR;
const QUEUE_FILE = path.join(QUEUE_DIR, 'queue.json');

// Homestead API base — the corrections officer rings the holder and raises Rooster
// through the SAME /api/queue path steward walkies use (so a ring is an ordinary
// single-holder walkie, no new surface). Overridable for tests.
const HOMESTEAD_URL = process.env.HOMESTEAD_URL || 'http://localhost:3005';

// Rooster is the escalation target for a genuinely-stuck holder. Per GATE-B:
// the corrections officer RAISES Rooster with the stuck potato; Rooster owns the
// card-to-Josh decision (his notification-triage lane). The officer never cards
// Josh directly.
const ROOSTER_SESSION = process.env.POTATO_ROOSTER_SESSION || 'holler-rooster';

// ── ledger persistence ───────────────────────────────────────────────────────

/**
 * Read the durable ledger. Shape:
 *   { potatoes: { <potato_id>: <PotatoRecord>, … } }
 * Missing / unparsable file => empty ledger (fail-open toward "no potatoes",
 * never crash a caller on the hot path).
 */
function readLedger() {
  try {
    if (!fs.existsSync(LEDGER_FILE)) return { potatoes: {} };
    const obj = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8'));
    if (!obj || typeof obj !== 'object' || typeof obj.potatoes !== 'object') {
      return { potatoes: {} };
    }
    return obj;
  } catch {
    return { potatoes: {} };
  }
}

function writeLedger(ledger) {
  try {
    const dir = path.dirname(LEDGER_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
    return true;
  } catch (e) {
    console.error('[PotatoTracker] Failed to write ledger:', e.message);
    return false;
  }
}

// ── identity ─────────────────────────────────────────────────────────────────

function generatePotatoId() {
  return `potato-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── envelope classification ──────────────────────────────────────────────────

/**
 * Parse a queue item's `message` field (a JSON string envelope) into an object.
 * Returns null on non-JSON (some legacy items wrap raw text) — a null envelope is
 * never a potato birth or pass, so callers safely skip it.
 */
function parseEnvelope(message) {
  if (message && typeof message === 'object') return message;
  if (typeof message !== 'string') return null;
  try {
    const obj = JSON.parse(message);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * PURE. Is this envelope a JOSH-ORIGINATED message (=> births a potato)?
 * Josh's two real entry paths are the only truthy cases; ordinary steward↔steward
 * traffic (from === '<session>') returns false so it never becomes a rock.
 */
function isJoshOriginated(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.from === JOSH_FROM) return true;                 // bottom-bar send
  if (envelope.source === PRESENTER_SOURCE) return true;        // card reply feedback
  return false;
}

/**
 * PURE. Is this envelope a TERMINAL ACKNOWLEDGMENT that owes no response, so it
 * must NOT birth a potato? True ONLY for a card-reply (source='presenter') where
 * the pressed button is in the tight ACK_BUTTONS allowlist AND the text field is
 * empty. Anything else — a non-ack button, an ack button WITH typed text (the text
 * is itself an owed response), a bottom-bar fresh send, an unknown/ambiguous
 * button — returns false so the caller BIRTHS. Birth-on-doubt: a spurious potato is
 * cheap noise; a suppressed real one is a silently-dropped Josh message.
 */
function isPureAcknowledgment(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  // Only card-replies can be acks. A bottom-bar fresh send is always owed.
  if (envelope.source !== PRESENTER_SOURCE) return false;

  const text = envelope.text;
  if (text != null && typeof text !== 'string') return false;   // odd shape → birth

  if (typeof text === 'string' && text.trim() !== '') {
    // TEXT-CARRIED ACK (the Voice Response shape). Josh SAID a bare thanks; it
    // landed in free text under a generic button. Suppress ONLY when the ENTIRE
    // collapsed content is an ack — see isPureAckText, which fails toward birthing.
    return isPureAckText(text);
  }

  // EMPTY text → fall back to the original button-carried ack path.
  // Button must be a known ack. Unknown/missing/ambiguous → birth (fail-safe).
  const button = envelope.button;
  if (typeof button !== 'string') return false;
  return ACK_BUTTONS.has(button.trim().toLowerCase());
}

/**
 * Is this free-text card-reply body a PURE acknowledgment and nothing else?
 *
 * Written for Josh's Voice Response transcripts, which arrive with a heavy Whisper
 * stutter: the live miss was "Thank you." repeated 20x, and the September archives
 * carry a 137x repeat. So we COLLAPSE consecutive duplicate utterances before
 * judging — 20 thank-yous are one thank-you, not twenty pieces of content.
 *
 * TWO NON-NEGOTIABLE CONSTRAINTS (Rooster, 2026-09-10 — the failure direction is
 * asymmetric: a false suppression is a silently-dropped Josh message, the exact
 * thing this whole tracker exists to prevent):
 *   1. The ENTIRE collapsed content must be the ack. NO prefix/suffix matching.
 *      "Thank you, and can you also..." MUST birth a potato.
 *   2. FAIL TOWARD BIRTHING on any parse error or uncertainty.
 *
 * @param {string} raw the envelope's `text` field (non-empty)
 * @returns {boolean} true ONLY if the whole body is a bare ack → safe to suppress
 */
function isPureAckText(raw) {
  try {
    if (typeof raw !== 'string') return false;

    // Guard the collapse against pathological input before doing string work.
    // A genuinely long body is real content, not a bare thanks — birth it. (The
    // 137x stutter of a 50-char line is ~7KB, so this ceiling is far above the
    // real stutter range while still bounding the work.)
    if (raw.length > 20000) return false;

    // Split into utterances on newlines AND sentence terminators. Josh's stutter
    // repeats either as separate lines or as run-on sentences, so we handle both.
    const parts = raw
      .split(/[\n\r.!?;]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (parts.length === 0) return false;                        // nothing parsed → birth

    // Normalize for comparison: lowercase, strip everything but letters/spaces
    // (kills stray punctuation and the '*sad music*' style Whisper artifacts'
    // asterisks), collapse internal whitespace.
    const norm = (s) => s
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Collapse CONSECUTIVE duplicates (the stutter), then dedupe the whole set —
    // "Thank you. Thanks. Thank you." is still just an ack.
    const utterances = [];
    for (const p of parts) {
      const n = norm(p);
      if (n === '') continue;                                    // punctuation-only fragment
      if (utterances.length === 0 || utterances[utterances.length - 1] !== n) {
        utterances.push(n);
      }
    }
    if (utterances.length === 0) return false;                   // nothing left → birth

    const distinct = new Set(utterances);

    // CONSTRAINT 1, enforced literally: EVERY distinct utterance must itself be a
    // whole-string member of the allowlist. One non-ack utterance anywhere — a
    // question, an instruction, a trailing "and can you also..." — births.
    for (const u of distinct) {
      if (!ACK_TEXT.has(u)) return false;
    }
    return true;
  } catch (_err) {
    // CONSTRAINT 2: any parse error → birth. Never suppress on a throw.
    return false;
  }
}

// ── birth ────────────────────────────────────────────────────────────────────

/**
 * Record the birth of a potato (a tracker-side OWED RESPONSE) for a Josh-originated
 * queue item, if the item is in fact Josh-originated. Idempotent by queue item id:
 * re-observing the same enqueue (dispatcher re-reads the queue every tick) will NOT
 * create a duplicate potato — we guard on origin_queue_id.
 *
 * The holder is the steward Josh addressed. The loop closes on that holder's NEXT
 * outbound to anyone (recordCloseFromQueueItem) — the owed-response is recorded
 * HERE, tracker-side, never injected into the envelope.
 *
 * @param {object} p
 * @param {string} p.queueItemId  the queue.json item id (idempotency key)
 * @param {string} p.targetSession the holder (who Josh addressed)
 * @param {object|string} p.message the envelope (object or JSON string)
 * @returns {object|null} the created PotatoRecord, or null if not Josh-originated
 *          / already recorded.
 */
function recordBirthFromQueueItem({ queueItemId, targetSession, message }) {
  const envelope = parseEnvelope(message);
  if (!isJoshOriginated(envelope)) return null;
  if (!targetSession || typeof targetSession !== 'string') return null;

  // Terminal-ack suppression: a pure ack card-reply (ACK_BUTTONS + empty text) owes
  // no response — don't birth, else the corrections officer nags a holder whose
  // correct move is internal-only. Card-reply path only; birth-on-doubt everywhere
  // else. Co-owned ack-set with Rooster (officer engine confirmed safe 2026-07-24).
  if (isPureAcknowledgment(envelope)) {
    const ackShape = (typeof envelope.text === 'string' && envelope.text.trim() !== '')
      ? `text "${envelope.text.trim().slice(0, 40).replace(/\s+/g, ' ')}"`
      : `button "${envelope.button}"`;
    console.log(`[PotatoTracker] SUPPRESS-BIRTH (pure ack ${ackShape}) holder=${targetSession} origin_q=${queueItemId}`);
    return null;
  }

  const ledger = readLedger();

  // Idempotency: if any potato already records this origin queue item, skip.
  for (const rec of Object.values(ledger.potatoes)) {
    if (rec && rec.origin_queue_id === queueItemId) return null;
  }

  const now = new Date().toISOString();
  const id = generatePotatoId();
  const record = {
    potato_id: id,
    status: 'open',                       // 'open' | 'closed'
    origin_queue_id: queueItemId || null, // idempotency guard only — NOT used to close
    origin_surface: envelope.source === PRESENTER_SOURCE ? 'card-reply' : 'bottom-bar',
    // The holder owes a response. Set at birth to who Josh addressed; the loop
    // closes on this holder's next outbound to anyone.
    holder: targetSession,
    born_at: now,
    updated_at: now,
    // Provenance chain — birth + close, for forensics + "point to the source".
    chain: [{ holder: targetSession, at: now, via: 'birth' }],
    // Heartbeat / corrections-officer bookkeeping.
    suspicion: null,                      // { first_strike_at, last_check_at, strikes }
    closed_at: null,
    closed_by: null,                      // the holder whose send closed the loop
    closing_queue_id: null,               // the enqueue that closed it
  };
  ledger.potatoes[id] = record;
  writeLedger(ledger);
  console.log(`[PotatoTracker] BORN ${id} holder=${targetSession} surface=${record.origin_surface} origin_q=${queueItemId}`);
  return record;
}

// ── close (holder's next outbound to anyone) ─────────────────────────────────

/**
 * PURE-CODE CLOSE. Observed at the enqueue() chokepoint for EVERY outbound queue
 * item. If the item's envelope `from` is a steward that currently holds one or more
 * OPEN potatoes, close each of those potatoes — the holder answered someone, so the
 * accountability loop is satisfied. This is Josh's "next outbound to ANYONE
 * whatsoever" close, and it needs no potato_id echo, no card, no _queue_id guessing.
 *
 * INVARIANTS (Top-mandated):
 *   • A Josh-originated envelope (birth) is NEVER a close — a birth and a close are
 *     mutually exclusive per item, and the birth's own holder set-up runs elsewhere.
 *   • The corrections officer's ring/raise post from the STATIC identity
 *     `potato-corrections-officer` (never a real session). That MUST NEVER close a
 *     potato — a ring is the tracker's own notification, not the holder's send. We
 *     explicitly exclude it, so a ring can't close the very potato it's about.
 *   • Only a real steward's OWN send closes: match on `envelope.from === holder`.
 *     Real steward sends use getTmuxSessionId() → from === exact session name.
 *
 * A holder may owe several potatoes at once (Josh sent several to the same steward);
 * one outbound from that holder closes ALL of them — the holder demonstrably came
 * back to life and is sending, which is the whole signal we care about.
 *
 * Idempotent by queueItemId: re-observing the same enqueue (dispatcher re-reads the
 * queue every tick before it's dispatched) won't matter — the potato is already
 * `closed` after the first observation, and a closed potato is skipped.
 *
 * @param {object} p
 * @param {string} p.queueItemId    the closing enqueue's id (forensics)
 * @param {string} [p.senderSession] explicit sender; falls back to envelope.from
 * @param {object|string} p.message  the envelope (object or JSON string)
 * @returns {object[]} the list of PotatoRecords closed by this send (possibly []).
 */
function recordCloseFromQueueItem({ queueItemId, senderSession, message }) {
  const envelope = parseEnvelope(message);
  // A birth is never a close — mutually exclusive per item.
  if (isJoshOriginated(envelope)) return [];
  // The sender: prefer explicit arg, else envelope.from.
  const sender = senderSession || (envelope && envelope.from) || null;
  if (!sender || typeof sender !== 'string') return [];
  // INVARIANT: the corrections officer's ring/raise must NEVER close a potato.
  if (sender === CORRECTIONS_OFFICER_FROM) return [];

  const ledger = readLedger();
  const closed = [];
  const now = new Date().toISOString();

  for (const rec of Object.values(ledger.potatoes)) {
    if (!rec || rec.status !== 'open') continue;
    if (rec.holder !== sender) continue;

    rec.status = 'closed';
    rec.closed_at = now;
    rec.closed_by = sender;
    rec.closing_queue_id = queueItemId || null;
    rec.updated_at = now;
    rec.suspicion = null;
    rec.chain.push({ holder: sender, at: now, via: 'close', queue_id: queueItemId || null });
    closed.push(rec);
    console.log(`[PotatoTracker] CLOSED ${rec.potato_id} by=${sender} (next-outbound) q=${queueItemId}`);
  }

  if (closed.length) writeLedger(ledger);
  return closed;
}

// ── heartbeat READ (corrections officer, up to the reversal seam) ────────────

/**
 * Read a session's is_working signal from its activity file — the SAME source
 * lib/check-stalled-workers.js and lib/queue-dispatcher.js use. Returns:
 *   { working: boolean, fresh: boolean, updated_ms: number|null, exists: boolean }
 * `fresh` is false when the file is missing or older than ACTIVITY_STALE_MS. A
 * stale/absent file is NOT treated as "working" (working:false) — but `fresh`
 * lets the caller distinguish "actively idle" from "we can't tell".
 */
function readHolderActivity(sessionName, nowMs = Date.now()) {
  const f = `/tmp/claude-session-${sessionName}-activity.json`;
  if (!fs.existsSync(f)) {
    return { working: false, fresh: false, updated_ms: null, exists: false };
  }
  let activity;
  try {
    activity = JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch {
    return { working: false, fresh: false, updated_ms: null, exists: true };
  }
  const updatedMs = parseActivityTimestamp(activity.updated_at);
  const fresh = updatedMs != null && (nowMs - updatedMs) <= ACTIVITY_STALE_MS;
  return {
    working: activity.is_working === true,
    fresh,
    updated_ms: updatedMs,
    exists: true,
    current_tool: activity.current_tool || null,
  };
}

/**
 * Parse the activity-writer's ISO-ish timestamp (offset optional; UTC when
 * absent). Mirrors check-stalled-workers.js:parseActivityTimestamp so the two
 * readers agree byte-for-byte on the same file. Returns ms or null.
 */
function parseActivityTimestamp(s) {
  if (!s || typeof s !== 'string') return null;
  const withZ = /[Z+-]/.test(s.slice(10)) ? s : `${s}Z`;
  const ms = Date.parse(withZ);
  return Number.isFinite(ms) ? ms : null;
}

// Mid-compose / actively-working pane signals — the SAME ground-truth surface
// Rooster's pane-classifier + lib/check-stale-sessions.js treat as "working".
// FLAG-SIDE HARDENING (Rooster live field data 2026-07-23): the ~2-check-5s-apart
// strike window is TIGHTER than legitimate compose-time for a substantive reply, so
// the strike counter climbs on the brief idle GAPS between a working session's
// turns/tool-calls. A false ring/raise injects stale text into a WORKING pane and
// pulls Top into a GATE-B ruling on a non-stuck session. The pane re-confirm is the
// gate that stops that — but `esc to interrupt` alone can scroll out of the tail
// mid-stream, so we ALSO treat the live streaming token-counter timer as working:
//   "(42s · ↓ 669 tokens)"  /  "(12s · ↑ 1.2k tokens · esc to interrupt)"
// If EITHER marker is present the holder is demonstrably mid-compose → NOT stuck.
const PANE_WORKING_PATTERNS = [
  /esc to interrupt/i,                       // canonical active-work bottom-bar marker
  /\(\s*\d+s\s*·[^)]*tokens?/i,              // live streaming timer w/ token count → mid-stream
];

/**
 * TMUX-PANE RE-CONFIRM (the GATE-B refinement — Rooster's ruling 2026-07-21;
 * hardened 2026-07-23 with the streaming-token-counter signal).
 *
 * The reversal is READ-ONLY on is_working. When a potato hits 2-strike SUSPECT,
 * before ringing OR raising we re-confirm the holder against the SAME authoritative
 * surface Rooster's pane-classifier treats as ground truth: the live pane bottom
 * status. A holder that is mid-compose MUST NOT be flagged (that's the Rooster trap).
 *
 *   - `esc to interrupt` OR a live streaming token-counter timer present in the pane
 *     tail → genuinely WORKING / mid-compose. False-alarm branch: STAND DOWN
 *     silently (no ring, no accuse), and the caller records a per-potato cooldown so
 *     we don't immediately re-strike on the next between-turns gap.
 *   - a bordered idle ❯-box / `shift+tab to cycle` WITHOUT any working marker
 *     → genuinely IDLE-with-rock (or dropped to a local picker Josh can't see)
 *     → proceed to RING/RAISE.
 *
 * Using the same discriminators the watchdog uses means the two detectors can
 * never disagree on "working" — no is_working write, no hold-flag, no snooze
 * coordination needed. Returns:
 *   { working: boolean, captured: boolean }
 * `captured:false` means we couldn't read the pane (session gone / tmux error) —
 * the caller treats an uncapturable pane as NOT working (a holder whose pane we
 * can't even read is not demonstrably working — err toward ringing so a real
 * stall is never silently excused).
 */
function paneReconfirmWorking(sessionName) {
  // EXISTENCE PROBE FIRST (Steward Manager, 2026-09-12). capture-pane exits 1 for a
  // session that does not exist, which threw into the catch below and returned the
  // BYTE-IDENTICAL shape to a real-but-quiet pane. The officer then reported "pane
  // confirms idle" to Rooster about sessions that were GONE — twice. A torn-down
  // holder is not an idle holder; only has-session tells them apart (verified:
  // capture-pane exit 1 for both a missing session and some error states, has-session
  // exit 1 ONLY when the target is absent).
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { timeout: 3000 });
  } catch {
    return { working: false, captured: false, exists: false };
  }

  let cap;
  try {
    // Bare session name (capture-pane rejects the '=' exact-match anchor). Worker
    // session names are fully-qualified so a bare -t is already exact in practice.
    cap = execSync(`tmux capture-pane -t "${sessionName}" -p 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
  } catch {
    // Session EXISTS (probe above passed) but we could not read it — a real tmux
    // error, not a missing target. exists:true keeps this distinct from a gone holder.
    return { working: false, captured: false, exists: true };
  }
  if (!cap) return { working: false, captured: false, exists: true };
  const tail = cap.split('\n').slice(-25).join('\n');
  // Working if ANY mid-compose marker is present in the pane tail — the same
  // ground-truth signals Rooster's classify-grid and check-stale-sessions use.
  const working = PANE_WORKING_PATTERNS.some((re) => re.test(tail));
  return { working, captured: true, exists: true };
}

/**
 * NO-OUTBOUND-SINCE-BIRTH — the strong "is this steward actually dark?" gate.
 *
 * Returns TRUE when the holder has sent NOTHING since the potato was born, i.e.
 * escalation is still permitted. Returns FALSE the moment we find any outbound from
 * the holder timestamped after rec.born_at — a steward that has SENT ANYTHING (any
 * walkie, any card, to anyone whatsoever) is DEMONSTRABLY not stuck. It's working,
 * just not on this exact thread yet. That distinction — "working but hasn't answered
 * THIS card" vs "genuinely dark" — is the whole discriminator.
 *
 * Scans the live queue.json AND today's queue-archive (items drain from the live
 * queue into the dated archive after ~60s, so a recent send is often ONLY in the
 * archive; checking just one file would miss it and produce a false escalation).
 *
 * RELATIONSHIP TO THE CLOSE PATH — read before deleting this as redundant.
 * recordCloseFromQueueItem already closes a potato on the holder's next outbound,
 * so in the happy path a potato with an outbound is closed and never reaches the
 * heartbeat at all. Measured against all 131 historical raises, this gate would have
 * suppressed ZERO of them — every raise fired before its holder's first post-birth
 * send (earliest 72.8s, median 3051s). It is therefore NOT the noise cut (the time
 * floors are); it is the BACKSTOP for when the close path misses: an envelope whose
 * `from` doesn't exactly equal the holder's session name, a worker-name variant, or
 * an enqueue that raced the archive drain. In those cases the potato stays open while
 * the holder is visibly sending, and this gate stops the false raise. Cheap
 * (two small JSON reads, only on an already-suspect potato), and it fails OPEN.
 *
 * FAIL-OPEN IS DELIBERATE: on any read/parse error we return TRUE (escalation
 * allowed). An unreadable queue file must never become a silent excuse that swallows
 * a genuinely dropped Josh message — the safety direction is to keep escalating
 * unless we have POSITIVE evidence of work.
 *
 * @returns {{ noOutbound: boolean, foundAt: string|null }}
 */
function hasNoOutboundSinceBirth(rec, nowMs = Date.now()) {
  const bornMs = Date.parse(rec && rec.born_at ? rec.born_at : '');
  if (!Number.isFinite(bornMs)) return { noOutbound: true, foundAt: null };
  const holder = rec.holder;
  if (!holder) return { noOutbound: true, foundAt: null };

  // Archive selection: DISCOVER the dated files by scanning the directory rather than
  // computing a filename. The dispatcher names archives from an ISO timestamp
  // (`ts.slice(0, 10)`), i.e. by UTC DATE, but this function previously rebuilt that
  // name from LOCAL date parts. Josh runs at UTC-4, so for every event between 20:00
  // and midnight local the two disagree and the scan opened the wrong file — a
  // four-hour blind window every night in which a holder's sends were invisible and
  // the gate reported a false "no outbound". The yesterday-fallback did not rescue it
  // (it shifts the same window rather than covering it). Scanning is also what the
  // dispatcher's own archive readers do, so this now matches the rest of the codebase
  // and survives any future change to the naming convention.
  // Newest-first, capped: recent archives are all that can hold a post-birth send.
  let archives = [];
  try {
    archives = fs.readdirSync(QUEUE_DIR)
      .filter((f) => /^queue-archive-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse()
      .slice(0, 3)
      .map((f) => path.join(QUEUE_DIR, f));
  } catch {
    archives = []; // unreadable dir → live queue only; fail-open still applies
  }
  const files = [QUEUE_FILE, ...archives];

  for (const f of files) {
    let arr;
    try {
      if (!fs.existsSync(f)) continue;
      arr = JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch {
      continue; // unreadable/torn file → fail open, keep scanning the others
    }
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const sentMs = Date.parse(item.created_at || '');
      // Window is HALF-OPEN: (bornMs, nowMs]. The upper bound is essential — without
      // it the scan sees sends that happen AFTER the moment being judged, so the gate
      // "passes" on evidence from the future. That made this function useless as a
      // live gate (it excused a holder using a card it had not written yet) and, worse,
      // silently corrupted every historical backtest run through it: replaying an old
      // escalation always saw the holder's later sends and concluded the gate would
      // have suppressed nothing. Both failures trace to this one missing comparison.
      if (!Number.isFinite(sentMs) || sentMs <= bornMs || sentMs > nowMs) continue;
      const env = parseEnvelope(item.message);
      if (!env || env.from !== holder) continue;
      // A Josh-originated envelope is never the holder's own send, and the
      // corrections officer's own ring/raise must never count as holder evidence
      // (it would let a ring excuse the very potato it's about — the same trap the
      // close path guards with the CORRECTIONS_OFFICER_FROM exclusion).
      if (isJoshOriginated(env)) continue;
      if (env.from === CORRECTIONS_OFFICER_FROM) continue;
      return { noOutbound: false, foundAt: item.created_at };
    }
  }
  return { noOutbound: true, foundAt: null };
}

// ── SILENT-ACTION EVIDENCE (the silent-compliance false positive, 2026-09-18) ──
// Completed, post-birth tool calls required before we treat a holder as having
// demonstrably worked on Josh's behalf. TWO, not one: a single call is a plausible
// incidental read (a steward glancing at a file while genuinely ignoring its rock);
// two completed calls is a worked task. Env-overridable for tests.
const SILENT_WORK_MIN_TOOLS = parseInt(process.env.POTATO_SILENT_WORK_MIN_TOOLS || '2', 10);

// Activity entries that are NOT evidence of work on Josh's behalf.
//   'thinking'  — the model musing; not an action taken for Josh.
//   'response'  — the steward TALKING. Counting it would let a holder that merely
//                 emitted prose stand itself down, which is the idle case we must
//                 still catch.
const NON_WORK_ACTIVITY_TOOLS = new Set(['thinking', 'response']);

/**
 * SILENT-ACTION EVIDENCE ACCUMULATOR — did the holder do real, non-message WORK?
 *
 * ═══ THE DEFECT THIS FIXES (measured, GiveGrove 2026-09-18) ═══
 * A card can ask for SILENT execution. Josh's card 537b010ecf8a read verbatim:
 * "Press approve and I'll do it silently — no comment, just the approval." GiveGrove
 * approved PR #1639 with an empty body — EXACTLY as asked — and deliberately sent no
 * "done!" card, per the standing rule that such a card is noise. Timeline, settled by
 * GitHub's own clock (submitted_at on .../pulls/1639/reviews) plus the queue archive:
 *
 *   02:08:47.899Z  potato born (card-reply "Approve it")
 *   02:09:04Z      APPROVAL SUBMITTED — 17s after birth, work COMPLETE
 *   02:11:51.929Z  ring fired — 2m47s AFTER the work was already done
 *   02:14:20Z      closed, by the report the ring pressured out of the steward
 *
 * ⭐ recordCloseFromQueueItem() closes ONLY on an outbound. Correct compliance
 * produced ZERO outbounds, so the potato could not close, and the ring extracted
 * EXACTLY THE MESSAGE JOSH SAID NOT TO SEND. The alert manufactured the noise it
 * exists to prevent. Structurally: OBEYING a silent instruction was unfalsifiable
 * innocence — the only way to clear the potato was to disobey.
 *
 * ═══ WHY THE EXISTING GATES DON'T CATCH IT ═══
 * hasNoOutboundSinceBirth() looks for MESSAGES — silent work has none by definition.
 * paneReconfirmWorking() samples ONE INSTANT, and a steward that approved a PR in 17s
 * is genuinely not mid-compose 3 minutes later when the officer looks. Both gates are
 * blind to "did work, said nothing, finished".
 *
 * ═══ 🚨 WHY THIS ACCUMULATES INSTEAD OF READING AT RING TIME ═══
 * The obvious implementation — at ring time, scan activities[] for post-birth tool
 * calls — DOES NOT WORK, and the reason is the single most important fact about this
 * substrate. `activities[]` IS A 20-ENTRY RING BUFFER, NOT A TIME WINDOW
 * (writer: hooks/tool_activity.py, `activity["activities"][-20:]`).
 *
 * MEASURED ACROSS THE LIVE FLEET 2026-09-18 — buffer spans of 74s, 129s, 149s
 * (holler-givegrove / holler-homestead / holler-rooster). Every one is SHORTER THAN
 * THE 180s RING FLOOR, and far shorter than the 600s raise floor. On the live case
 * itself, birth→ring was 2m47s against a ~34s buffer: THE EVIDENCE OF THE APPROVAL
 * WAS ALREADY EVICTED BY THE TIME THE RING FIRED. A ring-time read would have
 * suppressed nothing and "fixed" the case only in a test written seconds after the
 * action — data that would never exist in production timing.
 * (Caveat raised by holler-givegrove, who hold the only known instance; independently
 * re-measured here before acting on it.)
 *
 * ⭐ THE FIX: the heartbeat already runs every 5s over every open potato. So we
 * SAMPLE CONTINUOUSLY and PERSIST what we saw into the durable ledger — converting a
 * perishable ring buffer into a durable cursor. Evidence is captured while it is
 * still in the buffer, minutes before the ring needs it. No new timer.
 *
 * Per-potato state lives on `rec.work` and is the accumulator:
 *   { tools, last_at, last_seen_ms, sample[] }
 * Each pass counts only entries NEWER than `last_seen_ms` (the cursor), so a tool
 * call that lingers in the buffer across many passes is counted ONCE, never inflated
 * into a false quorum by repeated sampling.
 *
 * Counted only when ALL hold:
 *   • phase === 'complete' — a STARTED-but-unfinished call is exactly what a hung
 *     holder looks like, so a start alone is never evidence.
 *   • tool is a real tool — 'thinking' and 'response' excluded (see the set above).
 *   • the LATER of (completed_at, timestamp) falls in (cursor, nowMs]. ⚠️ TWO TRAPS:
 *       – Judging on `timestamp` alone counts a long tool call that STARTED BEFORE
 *         Josh's message as work done in response to it. Work must post-date the
 *         potato to excuse it; the cursor starts at bornMs for exactly this reason.
 *       – The nowMs upper bound mirrors the fix documented on
 *         hasNoOutboundSinceBirth: without it a historical replay sees evidence from
 *         the FUTURE and silently reports that this gate would suppress everything.
 *
 * ═══ WHY THIS CANNOT SILENCE A GENUINELY DROPPED MESSAGE ═══
 * The asymmetry governing this file — a false negative is a silently-dropped Josh
 * message, strictly worse than a spurious potato — is preserved three ways:
 *   1. SUPPRESSES ONLY ON POSITIVE EVIDENCE, never by blanket-excusing. A genuinely
 *      idle holder accumulates no completed tool calls and is rung exactly as before.
 *   2. FAILS TOWARD ESCALATING on every uncertainty: missing file, unparsable JSON,
 *      absent/!Array activities[], unparsable timestamps → nothing accumulates.
 *      An evicted buffer likewise yields no evidence rather than a false excuse.
 *   3. STAND-DOWN, NOT CLOSE — deliberately; see the call site in processSuspects.
 *
 * MUTATES `rec` in place (the caller owns the ledger write).
 * @returns {{ hasWork: boolean, toolCount: number, lastAt: string|null, sample: string[], added: number }}
 */
function accumulateSilentWork(rec, nowMs = Date.now()) {
  const bornMs = Date.parse(rec && rec.born_at ? rec.born_at : '');
  const prior = (rec && rec.work) || null;
  const priorTools = prior && Number.isFinite(prior.tools) ? prior.tools : 0;
  const result = {
    hasWork: priorTools >= SILENT_WORK_MIN_TOOLS,
    toolCount: priorTools,
    lastAt: (prior && prior.last_at) || null,
    sample: (prior && Array.isArray(prior.sample)) ? prior.sample : [],
    added: 0,
  };
  if (!Number.isFinite(bornMs)) return result;        // unparsable birth → no evidence
  const holder = rec && rec.holder;
  if (!holder) return result;

  // Cursor: only entries strictly newer than what we've already counted. Starts at
  // birth so pre-birth work can never excuse a potato.
  const cursor = (prior && Number.isFinite(prior.last_seen_ms))
    ? Math.max(prior.last_seen_ms, bornMs)
    : bornMs;

  const f = `/tmp/claude-session-${holder}-activity.json`;
  let activity;
  try {
    if (!fs.existsSync(f)) return result;             // no file → no evidence
    activity = JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch {
    return result;                                    // torn/unparsable → no evidence
  }
  if (!activity || !Array.isArray(activity.activities)) return result;

  let added = 0;
  let maxMs = cursor;
  const sample = result.sample.slice();
  for (const act of activity.activities) {
    if (!act || typeof act !== 'object') continue;
    if (act.phase !== 'complete') continue;           // started ≠ finished
    const tool = typeof act.tool === 'string' ? act.tool : '';
    if (!tool || NON_WORK_ACTIVITY_TOOLS.has(tool)) continue;

    // The LATER of start/end — work must post-date the potato to excuse it.
    const startMs = parseActivityTimestamp(act.timestamp);
    const endMs = parseActivityTimestamp(act.completed_at);
    const atMs = Math.max(
      Number.isFinite(startMs) ? startMs : -Infinity,
      Number.isFinite(endMs) ? endMs : -Infinity,
    );
    if (!Number.isFinite(atMs)) continue;             // no usable time → not evidence
    if (atMs <= cursor || atMs > nowMs) continue;     // half-open (cursor, now]

    added++;
    if (atMs > maxMs) maxMs = atMs;
    if (sample.length < 3) sample.push(tool);
  }

  const tools = priorTools + added;
  // Persist the cursor EVERY pass, even when nothing was added: advancing
  // last_seen_ms is what makes repeated sampling of a lingering buffer idempotent.
  rec.work = {
    tools,
    last_at: added > 0 ? new Date(maxMs).toISOString() : result.lastAt,
    last_seen_ms: maxMs,
    sample: sample.slice(0, 3),
  };
  return {
    hasWork: tools >= SILENT_WORK_MIN_TOOLS,
    toolCount: tools,
    lastAt: rec.work.last_at,
    sample: rec.work.sample,
    added,
  };
}

/**
 * RING THE HOLDER (settled step 1) — an EXPLICIT single-holder walkie. NOT a
 * broadcast (there is no auto-broadcast to steward walkies). Posts the SAME
 * /api/queue envelope steward walkies use, so a ring is an ordinary walkie with
 * zero new surface. The body tells the holder it's holding a dropped Josh potato
 * and must either pass it on or card Josh (carrying the potato_id) to close it.
 *
 * Returns a promise resolving to { ok, queue_id } (ok:false on transport error —
 * never throws, so a ring failure can't crash the heartbeat).
 */
function ringHolder(rec) {
  // ⚠️ DO NOT TELL THE HOLDER TO REPLY TO THE SENDER (fixed 2026-09-18).
  // This ring posts from `potato-corrections-officer`, a STATIC IDENTITY and NOT a
  // real tmux session (see CORRECTIONS_OFFICER_FROM). The previous body ended "If
  // you're genuinely stuck, say so and I'll raise it" — an instruction that CANNOT
  // SUCCEED: there is nobody at that address. Worse, /api/queue ACCEPTS a post to a
  // nonexistent target (verified 2026-09-18: HTTP 200, item queued pending) rather
  // than rejecting it, so a holder that complied got no error — the reply simply sat
  // undelivered forever while the potato stayed open and escalated anyway.
  // The genuine-stuck path is Rooster, who IS a real session. Name him, or say nothing.
  //
  // The silent-compliance line is equally load-bearing: a card may explicitly ask for
  // SILENT execution, and the old body's "send your next message to anyone" told the
  // holder to speak in order to clear itself — which is how this alert once extracted
  // exactly the message Josh had said not to send. Completed work now clears the
  // escalation on its own (see accumulateSilentWork), so the ring must stop demanding
  // speech as the price of innocence.
  const instruction =
    `⛔ DROPPED-MESSAGE ALERT (corrections officer). You owe Josh a response but you've ` +
    `been idle (2 checks 5s apart, pane confirms idle). Josh's message must be answered. ` +
    `Just DO the work — if the task needs a message, send it (that clears this ` +
    `immediately); if Josh asked you to act SILENTLY, do the work and send nothing, ` +
    `your completed tool calls clear the escalation on their own. Do NOT reply to this ` +
    `alert: it comes from a static identity, not a session, so a reply goes nowhere. ` +
    `If you are genuinely stuck, walkie ${ROOSTER_SESSION}. ` +
    `Origin: ${rec.origin_surface}, born ${rec.born_at}.`;
  // NB: from='potato-corrections-officer' is EXCLUDED from close-matching, so this
  // ring can never close the potato it's about — only the holder's own send can.
  const envelope = JSON.stringify({ type: 'action', from: CORRECTIONS_OFFICER_FROM, instruction, potato_id: rec.potato_id });
  return postQueue({ target_session: rec.holder, message_override: envelope, type: 'action' });
}

/**
 * RAISE ROOSTER (settled step 3) — a genuinely-stuck holder. Per GATE-B, the
 * corrections officer RAISES Rooster (never cards Josh directly); Rooster owns
 * the card-to-Josh decision after cross-checking his own watchdog + Auditor. We
 * hand Rooster everything he needs: potato_id, holder, and the FULL chain[] for
 * the "point to the source" escalation.
 *
 * Returns a promise resolving to { ok, queue_id }.
 */
function raiseRooster(rec) {
  const payload = {
    trigger: 'potato_stuck_holder',
    potato_id: rec.potato_id,
    holder: rec.holder,
    origin_surface: rec.origin_surface,
    born_at: rec.born_at,
    chain: rec.chain || [],
    raised_at: new Date().toISOString(),
  };
  const instruction =
    `POTATO STUCK — corrections-officer raise. Holder ${rec.holder} owes Josh a response on ` +
    `potato ${rec.potato_id} and is genuinely stuck (2 strikes 5s apart + pane-confirmed idle + ` +
    `a ring produced no outbound). Per GATE-B you own the card-to-Josh decision. Full potato ` +
    `context (JSON): ${JSON.stringify(payload)}`;
  const envelope = JSON.stringify({ type: 'action', from: CORRECTIONS_OFFICER_FROM, instruction, potato: payload });
  return postQueue({ target_session: ROOSTER_SESSION, message_override: envelope, type: 'action' });
}

/**
 * Minimal POST to /api/queue (the same enqueue endpoint steward walkies use).
 * Promise-based, never throws — resolves { ok, queue_id } | { ok:false, error }.
 */
function postQueue({ target_session, message_override, type }) {
  return new Promise((resolve) => {
    let body;
    try {
      body = JSON.stringify({ target_session, message_override, type: type || 'action' });
    } catch (e) {
      resolve({ ok: false, error: `serialize: ${e.message}` });
      return;
    }
    let url;
    try {
      url = new URL(`${HOMESTEAD_URL}/api/queue`);
    } catch (e) {
      resolve({ ok: false, error: `bad url: ${e.message}` });
      return;
    }
    const req = http.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let id = null;
            try { const p = JSON.parse(data); id = p?.item?.id || p?.id || null; } catch {}
            resolve({ ok: true, queue_id: id });
          } else {
            resolve({ ok: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

/**
 * ONE heartbeat pass over every OPEN potato — the READ half of the corrections
 * officer. For each open potato past its grace window, read the holder's
 * is_working signal and advance a two-strike suspicion counter:
 *
 *   - holder WORKING (fresh) → clear any suspicion; nothing to worry about.
 *   - holder NOT working →
 *       • first observation: record a first strike (timestamp).
 *       • second observation ≥ STRIKE_INTERVAL_MS after the first, STILL not
 *         working → the potato is SUSPECT (holder-has-rock-but-not-working, two
 *         checks 5s apart). This is the trigger point for the corrections
 *         officer's next action.
 *
 * ⚠️ This function ONLY reads + advances the suspicion state machine and RETURNS
 * the suspects. It does NOT ring the holder, does NOT flip is_working back, and
 * does NOT raise Rooster. Those are the DEFERRED actions gated behind Rooster's
 * GATE-B review (the is_working reconciliation). Wiring the returned suspects to
 * an action is intentionally NOT done here yet — see the stub note below.
 *
 * @returns {{ suspects: object[], checked: number }}
 *   suspects = potatoes that just crossed the two-strike threshold this pass.
 */
function heartbeatPass(nowMs = Date.now()) {
  const ledger = readLedger();
  const suspects = [];
  let checked = 0;
  let changed = false;

  for (const rec of Object.values(ledger.potatoes)) {
    if (!rec || rec.status !== 'open') continue;
    if (!rec.holder) continue;

    // Grace window: don't suspect a holder in the first moments after a pass.
    const bornOrMovedMs = Date.parse(rec.updated_at || rec.born_at || '') || 0;
    if (nowMs - bornOrMovedMs < HEARTBEAT_GRACE_MS) continue;

    // Stand-down cooldown: a potato we just silently stood down on (false alarm)
    // is not re-struck until its cooldown expires.
    if (rec.suspicion && rec.suspicion.cooldown_until && nowMs < rec.suspicion.cooldown_until) continue;

    checked++;
    const act = readHolderActivity(rec.holder, nowMs);

    // SILENT-WORK ACCUMULATION (2026-09-18). Runs on EVERY pass for EVERY open
    // potato, before any suspicion branching — and that placement is the whole point.
    // activities[] is a 20-ENTRY RING BUFFER measured at 74-149s of live span, well
    // under the 180s ring floor, so evidence of a silent action is EVICTED before the
    // officer would ever think to look for it. Sampling here, every 5s, captures it
    // into the durable ledger while it still exists. Cheap: one small JSON read on a
    // file readHolderActivity just opened anyway, and only for open potatoes.
    if (accumulateSilentWork(rec, nowMs).added > 0) changed = true;

    // Holder is actively working (fresh signal) → clear suspicion. This is the
    // "no false alarm" branch: a working holder is never a suspect. (The Josh-
    // loved REVERSAL — flipping a wrongly-suspected holder BACK to working — is a
    // SEPARATE, deferred action; here we simply never suspect a working holder.)
    if (act.working && act.fresh) {
      if (rec.suspicion) { rec.suspicion = null; changed = true; }
      continue;
    }

    // Holder not working (or stale/absent signal). Advance the strike counter.
    if (!rec.suspicion) {
      rec.suspicion = { first_strike_at: nowMs, last_check_at: nowMs, strikes: 1 };
      changed = true;
      continue;
    }

    // Already have a first strike. Only count a SECOND strike once ≥ interval has
    // elapsed since the first — enforcing "two checks 5s apart".
    if (nowMs - rec.suspicion.first_strike_at >= STRIKE_INTERVAL_MS) {
      rec.suspicion.strikes = (rec.suspicion.strikes || 1) + 1;
      rec.suspicion.last_check_at = nowMs;
      changed = true;
      if (rec.suspicion.strikes >= 2 && !rec.suspicion.reported) {
        rec.suspicion.reported = true;      // mark so we don't re-flag every pass
        suspects.push(rec);
        console.log(`[PotatoTracker] SUSPECT ${rec.potato_id} holder=${rec.holder} (2 strikes, not working)`);
      }
    } else {
      rec.suspicion.last_check_at = nowMs;
      changed = true;
    }

    // RE-SURFACE for the RAISE. `reported` stops us re-flagging (re-ringing) every
    // pass — but a potato that was RUNG and is STILL stuck must come back to
    // processSuspects so the ring→raise escalation can fire. The heartbeat feeds a
    // suspect to processSuspects exactly ONCE per report; the raise needs a SECOND
    // visit after ring-grace. Without this, a rung holder that ignores the ring is
    // never escalated to Rooster — the accountability guarantee silently breaks.
    // (Regression: caught by the live prod smoke 2026-07-21; the isolated proof had
    // hand-called processSuspects twice and masked it.) Re-push once ring-grace has
    // elapsed and we haven't raised yet; processSuspects re-confirms working/pane
    // before raising, so a since-recovered holder still won't be wrongly escalated.
    if (rec.suspicion.rang_at && !rec.suspicion.raised &&
        (nowMs - rec.suspicion.rang_at) >= STRIKE_INTERVAL_MS &&
        !suspects.includes(rec)) {
      suspects.push(rec);
      console.log(`[PotatoTracker] RE-SURFACE ${rec.potato_id} holder=${rec.holder} (rung, still stuck past ring-grace → raise pass)`);
    }

    // RE-SURFACE for a FLOOR-HELD potato. ⚠️ LOAD-BEARING — without this the time
    // floors would introduce a FALSE NEGATIVE that silences a real dropped message,
    // which is strictly worse than the false alarms they fix. A suspect held below
    // RING_FLOOR_MS gets `reported = true` but NEVER gets `rang_at` stamped, so the
    // re-surface branch above (which requires rang_at) can never fire for it — the
    // potato would be flagged once, held, and then sit silent forever. Same dead-end
    // shape as the 2026-07-21 prod-smoke regression, just entered through the floor.
    // So: an already-reported, never-rung, still-open suspect is re-fed every pass
    // once it has aged past the ring floor. processSuspects re-runs the activity
    // check, the pane re-confirm AND the outbound gate before acting, so a holder
    // that recovered in the meantime still stands down rather than being rung.
    if (rec.suspicion.reported && !rec.suspicion.rang_at && !rec.suspicion.raised &&
        !suspects.includes(rec)) {
      const ageMs = nowMs - (Date.parse(rec.born_at || '') || nowMs);
      if (ageMs >= RING_FLOOR_MS) {
        suspects.push(rec);
        console.log(`[PotatoTracker] RE-SURFACE ${rec.potato_id} holder=${rec.holder} (floor-held, now aged ${Math.round(ageMs / 1000)}s → ring pass)`);
      }
    }
  }

  if (changed) writeLedger(ledger);

  // `suspects` = potatoes whose holder has-rock-but-not-working across two checks
  // 5s apart. The REVERSAL (re-confirm → stand-down-or-ring → raise) is handled by
  // processSuspects(), called separately so the READ pass stays synchronous +
  // easily unit-tested. server.js's heartbeat interval awaits processSuspects on
  // the suspects this pass returns.
  return { suspects, checked };
}

/**
 * THE REVERSAL — GATE-B-cleared spec (Rooster, 2026-07-21): Option (A) never write
 * is_working; re-confirm on read + silent stand-down, with a tmux-pane fallback.
 *
 * For each SUSPECT potato, in order:
 *   1. RE-CONFIRM: re-read the activity file once more (freshest is_working). If
 *      the holder now reads working+fresh → false alarm, silent STAND DOWN.
 *   2. PANE FALLBACK: if still not-working/stale, capture the holder's pane. If
 *      `esc to interrupt` is present → genuinely working → silent STAND DOWN +
 *      record a per-potato cooldown (STANDDOWN_COOLDOWN_MS) so we don't re-strike
 *      immediately. NO ring, NO accuse. (This is the Josh-loved "corrections
 *      officer fixes false alarms, not a barker" behavior — expressed as a
 *      read-only stand-down, never an is_working write.)
 *   3. RING: pane confirms idle-with-rock → ring the current holder (single-holder
 *      walkie). Record that we rang + when.
 *   4. RAISE: if we already rang this potato ≥ RING_GRACE ago and it's STILL
 *      suspect (holder never passed/carded/answered) → raise Rooster with the full
 *      chain[]. Rooster owns the card-to-Josh.
 *
 * NEVER writes is_working. All reconciliation is by re-confirming against the
 * authoritative pane surface — the same discriminator Rooster's watchdog uses, so
 * the two detectors structurally can't disagree.
 *
 * @param {object[]} suspects  records returned by heartbeatPass (this pass's new
 *        2-strike suspects). We re-load each from the ledger to act on fresh state.
 * @returns {Promise<{ stoodDown: string[], rang: string[], raised: string[] }>}
 */
async function processSuspects(suspects, nowMs = Date.now()) {
  const stoodDown = [];
  const orphanedHolders = [];   // holders whose tmux session no longer exists
  const rang = [];
  const raised = [];
  if (!Array.isArray(suspects) || suspects.length === 0) {
    return { stoodDown, orphanedHolders, rang, raised };
  }

  for (const suspect of suspects) {
    // Re-load fresh from ledger — the potato may have closed/passed since the READ.
    const ledger = readLedger();
    const rec = ledger.potatoes[suspect.potato_id];
    if (!rec || rec.status !== 'open') continue;

    // Step 1: RE-CONFIRM via the activity file once more.
    const act = readHolderActivity(rec.holder, nowMs);
    if (act.working && act.fresh) {
      standDown(rec, nowMs, 'activity-reconfirm-working');
      stoodDown.push(rec.potato_id);
      continue;
    }

    // Step 2: PANE FALLBACK re-confirm (Rooster's ground-truth surface).
    const pane = paneReconfirmWorking(rec.holder);
    if (pane.captured && pane.working) {
      standDown(rec, nowMs, 'pane-reconfirm-working');
      stoodDown.push(rec.potato_id);
      continue;
    }

    // Step 2a: HOLDER SESSION IS GONE (Steward Manager, 2026-09-12).
    // A torn-down holder is NOT an idle holder. Ringing it is undeliverable (there
    // is no session to receive the walkie) and raising it tells Rooster "pane
    // confirms idle" about something that does not exist — a true escalation with a
    // FALSE justification attached, which is the part that misleads. The potato is
    // genuinely orphaned: its holder was torn down without discharging it. Record it
    // distinctly so the officer's report says what actually happened.
    if (pane.exists === false) {
      standDown(rec, nowMs, 'holder-session-gone');
      stoodDown.push(rec.potato_id);
      orphanedHolders.push({ potato_id: rec.potato_id, holder: rec.holder });
      continue;
    }

    // ── Step 2b: NO-OUTBOUND-SINCE-BIRTH gate (applies to BOTH ring and raise) ──
    // The pane re-confirm above catches a holder mid-stream, but it samples a single
    // instant: a steward mid-multi-step-turn has many brief moments where neither
    // working marker is in the tail (just after a tool result renders, before the
    // next spinner) and the snapshot can land in one of those. This gate is the
    // durable counterpart — evidence over a WINDOW rather than an instant. If the
    // holder has sent anything at all since birth, it is provably alive and we stand
    // down instead of accusing it.
    const outbound = hasNoOutboundSinceBirth(rec, nowMs);
    if (!outbound.noOutbound) {
      standDown(rec, nowMs, `outbound-since-birth@${outbound.foundAt}`);
      stoodDown.push(rec.potato_id);
      continue;
    }

    // ── Step 2b-bis: SILENT-ACTION gate (the silent-compliance false positive) ──
    // The outbound gate above asks "did the holder SAY anything?". A card can ask for
    // SILENT execution, in which case correct compliance says nothing BY DESIGN and
    // that gate can never pass — the defect this fixes. This gate asks the other half
    // of the question: "did the holder DO anything?" Evidence was accumulated into the
    // ledger by heartbeatPass every 5s (see accumulateSilentWork for why it cannot be
    // read here directly: the buffer has already evicted it by ring time).
    //
    // STAND-DOWN, NOT CLOSE — deliberately, and this is the constraint that governs
    // the shape of the whole fix.
    //
    // ⭐ NOTE FOR REVIEWERS: this adds NO new primitive. standDown() already backs
    // four paths — activity-reconfirm-working, pane-reconfirm-working,
    // holder-session-gone, outbound-since-birth. Silent-work is simply a FIFTH member
    // of that existing category: another way of saying "we have positive evidence this
    // holder is fine, so withhold the escalation". An auto-CLOSE, by contrast, would
    // have been the ONLY path in this file that terminates a potato WITHOUT an answer
    // — a genuinely new and dangerous state. (Framing due to holler-givegrove, who
    // reviewed the shipped code and made this argument better than the original.) The top-of-file invariant is that a potato must
    // EVENTUALLY be answered and CANNOT silently die. Auto-CLOSING on tool calls would
    // make every busy steward's potato evaporate untouched — converting a fix for a
    // false POSITIVE into exactly the false NEGATIVE the tracker exists to prevent.
    // So the potato stays OPEN and visible in the ledger; only the spurious escalation
    // — the part that actually reaches a human and pressures them into speaking — is
    // withheld. The stand-down arms a cooldown, so a holder that does work and THEN
    // genuinely goes dark still escalates on a later pass.
    const work = accumulateSilentWork(rec, nowMs);
    if (work.hasWork) {
      standDown(rec, nowMs, `silent-work@${work.lastAt} tools=${work.toolCount} [${work.sample.join(',')}]`);
      stoodDown.push(rec.potato_id);
      continue;
    }

    // ── Step 2c: TIME FLOORS ─────────────────────────────────────────────────
    // Age of the accountability loop itself, measured from BIRTH (not from the last
    // ledger touch) — the honest "how long has Josh been waiting?" clock.
    const ageMs = nowMs - (Date.parse(rec.born_at || '') || nowMs);

    // Genuinely idle-with-rock (pane shows no `esc to interrupt`, or uncapturable).
    // Step 4 first: if we ALREADY rang and it's still stuck past the ring grace,
    // escalate to Rooster.
    if (rec.suspicion && rec.suspicion.rang_at) {
      const sinceRing = nowMs - rec.suspicion.rang_at;
      // RAISE FLOOR: the loud step. Never pull Rooster in on a potato that hasn't
      // even been open RAISE_FLOOR_MS — that window was the 10s-median bug. We do
      // NOT stand down here (no cooldown): the potato stays suspect and simply waits,
      // so a holder that really is dark still raises on a later pass. This delays a
      // genuine raise, it never cancels one.
      if (ageMs < RAISE_FLOOR_MS) {
        console.log(`[PotatoTracker] RAISE-HELD ${rec.potato_id} holder=${rec.holder} age=${Math.round(ageMs / 1000)}s < floor ${Math.round(RAISE_FLOOR_MS / 1000)}s`);
        continue;
      }
      if (sinceRing >= STRIKE_INTERVAL_MS && !rec.suspicion.raised) {
        const r = await raiseRooster(rec);
        rec.suspicion.raised = true;
        rec.suspicion.raised_at = nowMs;
        rec.suspicion.raise_queue_id = r.queue_id || null;
        rec.chain.push({ holder: rec.holder, at: new Date().toISOString(), via: 'raise-rooster', queue_id: r.queue_id || null });
        writeLedger(ledger);
        raised.push(rec.potato_id);
        console.log(`[PotatoTracker] RAISED ${rec.potato_id} to Rooster (holder ${rec.holder} stuck after ring) ok=${r.ok}`);
      }
      continue; // already rang; don't re-ring
    }

    // RING FLOOR: even the cheap in-band nudge shouldn't fire inside one tool call.
    // Same shape as the raise floor — hold, don't stand down, so a real stall still
    // rings once it's genuinely old.
    if (ageMs < RING_FLOOR_MS) {
      console.log(`[PotatoTracker] RING-HELD ${rec.potato_id} holder=${rec.holder} age=${Math.round(ageMs / 1000)}s < floor ${Math.round(RING_FLOOR_MS / 1000)}s`);
      continue;
    }

    // Step 3: RING the holder (first action on a genuinely-idle-with-rock holder).
    const rung = await ringHolder(rec);
    rec.suspicion = rec.suspicion || {};
    rec.suspicion.rang_at = nowMs;
    rec.suspicion.ring_queue_id = rung.queue_id || null;
    rec.chain.push({ holder: rec.holder, at: new Date().toISOString(), via: 'ring-holder', queue_id: rung.queue_id || null });
    writeLedger(ledger);
    rang.push(rec.potato_id);
    console.log(`[PotatoTracker] RANG ${rec.potato_id} holder=${rec.holder} ok=${rung.ok} q=${rung.queue_id}`);
  }

  return { stoodDown, orphanedHolders, rang, raised };
}

/**
 * SILENT STAND-DOWN — false alarm. Clear the reported/rang suspicion flags and
 * arm a cooldown so this potato isn't immediately re-struck while the holder is
 * (briefly) idle between tool calls. NEVER writes is_working. Records the reason
 * for forensics. Persists via the caller's ledger write? No — writes here itself
 * so a stand-down is durable even if the caller returns early.
 */
function standDown(rec, nowMs, reason) {
  const ledger = readLedger();
  const live = ledger.potatoes[rec.potato_id];
  if (!live) return;
  live.suspicion = { cooldown_until: nowMs + STANDDOWN_COOLDOWN_MS, last_standdown_reason: reason, last_standdown_at: nowMs };
  // CARRY THE SILENT-WORK ACCUMULATOR ACROSS (2026-09-18). standDown re-reads the
  // ledger from disk, so the `work` cursor that accumulateSilentWork just advanced on
  // the caller's in-memory `rec` would otherwise be silently DISCARDED here — the
  // cursor would never advance through this path, and the same buffer entries could
  // be re-counted on a later pass. Copy it forward so the accumulator stays monotonic.
  if (rec && rec.work) live.work = rec.work;
  live.updated_at = new Date().toISOString();
  writeLedger(ledger);
  console.log(`[PotatoTracker] STAND-DOWN ${rec.potato_id} holder=${rec.holder} reason=${reason} (cooldown ${STANDDOWN_COOLDOWN_MS}ms)`);
}

// ── read helpers (for tests / API / UI) ──────────────────────────────────────

function getPotato(potatoId) {
  const ledger = readLedger();
  return ledger.potatoes[potatoId] || null;
}

function listOpenPotatoes() {
  const ledger = readLedger();
  return Object.values(ledger.potatoes).filter((r) => r && r.status === 'open');
}

function listPotatoesForHolder(sessionName) {
  const ledger = readLedger();
  return Object.values(ledger.potatoes).filter((r) => r && r.holder === sessionName);
}

module.exports = {
  // constants (env-overridable) exposed for tests
  LEDGER_FILE,
  STRIKE_INTERVAL_MS,
  HEARTBEAT_GRACE_MS,
  ACTIVITY_STALE_MS,
  JOSH_FROM,
  PRESENTER_SOURCE,
  CORRECTIONS_OFFICER_FROM,
  // persistence
  readLedger,
  writeLedger,
  // pure classifiers
  parseEnvelope,
  isJoshOriginated,
  isPureAcknowledgment,
  isPureAckText,
  ACK_TEXT,
  ACK_BUTTONS,
  parseActivityTimestamp,
  // lifecycle
  recordBirthFromQueueItem,
  recordCloseFromQueueItem,
  // reversal (GATE-B cleared)
  processSuspects,
  paneReconfirmWorking,
  PANE_WORKING_PATTERNS,
  ringHolder,
  raiseRooster,
  standDown,
  STANDDOWN_COOLDOWN_MS,
  // escalation floors + outbound gate (false-alarm fix)
  hasNoOutboundSinceBirth,
  accumulateSilentWork,
  SILENT_WORK_MIN_TOOLS,
  NON_WORK_ACTIVITY_TOOLS,
  RAISE_FLOOR_MS,
  RING_FLOOR_MS,
  ROOSTER_SESSION,
  // heartbeat READ (up to reversal seam)
  readHolderActivity,
  heartbeatPass,
  // reads
  getPotato,
  listOpenPotatoes,
  listPotatoesForHolder,
  generatePotatoId,
};
