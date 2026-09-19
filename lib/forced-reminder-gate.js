/**
 * Forced-Reminder Gate — card-quality enforcement on the Josh-facing card path.
 *
 * LINEAGE: this is the active-enforcement descendant of the passive `_reminder`
 * trailer at lib/presenter-queue.js:523. That trailer fires on every card REPLY
 * with no LLM decision, teaching "reply through the card, not the terminal."
 * This gate fires on every card SEND and BLOCKS the first attempt, echoing the
 * canonical card-quality rules so the sender is forced to pause and read them
 * before Joshua ever sees the card.
 *
 * THE REDESIGN (Josh, 2026-07-21 — supersedes the old every-vs-burst policy):
 * The unlock timestamp is an OPTIONAL + UNDOCUMENTED argument. Nothing in any
 * creed or steward instruction tells a steward the argument exists. A steward
 * who tries to talk to Joshua just walkies him (recipient "josh") with no stamp
 * — and TRIPS THIS GATE ON PURPOSE. The block they get back IS THE RULES: the
 * complete, CEO-mode card-quality doctrine, plus the one line telling them how
 * to prove they read it (a fresh timestamp within 10s). This error payload is
 * the ONLY place the rule text lives for a steward. That is the whole design:
 * intentional trip -> read the rules in the error -> comply.
 *
 * MECHANISM:
 *   1. A card SEND arrives at addItem(). shouldEnforce() decides if the gate is
 *      armed for this sender (scope knob below; STAGED until Josh blesses
 *      fleet-wide, per the tool-live-precedes-creed-flip sequencing invariant).
 *   2. If armed and the send carries NO fresh unlock stamp -> BLOCK: throw with
 *      the full card-quality rules + how to unlock. The sender sees the rules.
 *   3. The sender re-sends, this time including reminder_ack.timestamp = the
 *      CURRENT wall-clock time in ms (proof they paused to read). If that stamp
 *      is within UNLOCK_WINDOW_MS of the server's receipt -> PASS.
 *   4. A stale stamp (older than the window) or a missing stamp -> BLOCK again.
 *
 * The stamp is deliberately NOT a server-issued token. It's the sender's own
 * fresh timestamp. Freshness is the proof: a stale timestamp means the sender
 * pasted an old value or never actually paused. The 10s window is tight enough
 * that the sender must generate the stamp AT send time, i.e. after reading the
 * rules the first block handed back.
 *
 * WHERE THIS MUST NOT LIVE: NOT in queue-dispatcher.js (the universal walkie
 * envelope enrichment) — that would gate steward-to-steward walkies too. This
 * gate is imported ONLY by addItem() on the Josh-facing card path.
 */

// Unlock window: the sender's stamp must be within this many ms of the server's
// receipt of the send. 30s — sized to absorb the MCP-hop latency that elapses
// between stamp generation and server-RECEIPT measurement (worst-observed ~13s
// under fleet load) — NOT just network jitter. Tight enough that the stamp still
// proves a fresh pause, loose enough that a real fresh stamp never reads stale.
const UNLOCK_WINDOW_MS = 30_000;

// POLICY — post-redesign this is settled: the gate arms on EVERY in-scope card
// send. Josh's 2026-07-21 redesign collapsed the old every-vs-burst question —
// the mechanism is "trip the undocumented arg, read the rules the error returns,
// re-send with a fresh stamp." There is no burst relaxation: every direct
// approach to Joshua that lacks a fresh stamp is BLOCKED so the rules are read.
// (The old first-in-burst knob and its burst clock are retired.)

// SCOPE KNOB — WHICH senders the gate enforces against. Per the SEQUENCING
// INVARIANT (tool-enforcement-fleet-wide-LIVE must PRECEDE creed-language-flip-
// fleet-wide), the gate must NOT flip live behavior fleet-wide until Josh
// blesses the go-moment (coordinated with SM through Foreman/Top). So it
// enforces ONLY for the scoped sessions below; every other steward's cards pass
// untouched (as if the gate weren't there).
//   'scoped'     -> enforce only for sessions in GATE_SCOPE_SESSIONS.
//   'fleet-wide' -> enforce for every card sender (the blessed end state).
// Josh blessed the go-moment 2026-07-21 — flipped to 'fleet-wide'. The gate now
// arms for EVERY card sender on EVERY card path that reaches addItem(), which
// includes the legacy present_to_user tool (it POSTs the same /api/presenter/
// queue endpoint), not just the unified message tool. That shared-addItem reach
// is intended: the first-send speed-bump applies to all direct approaches to
// Joshua, fleet-wide.
const GATE_SCOPE = 'fleet-wide';

// The sessions the gate enforces against while GATE_SCOPE === 'scoped'. Match is
// by prefix so a session and its substewards are all covered. Currently INERT —
// GATE_SCOPE is 'fleet-wide', so this list is never consulted. Left empty; a
// prior scoped-rollout test entry (a since-graduated worker session) was removed
// during the worker re-home cleanup. Populate only if re-scoping to 'scoped'.
const GATE_SCOPE_SESSIONS = [];

// True if the gate is active for this sender given the current scope.
function inScope(sessionId) {
  if (GATE_SCOPE === 'fleet-wide') return true;
  const sid = String(sessionId || '');
  return GATE_SCOPE_SESSIONS.some(prefix => sid === prefix || sid.startsWith(prefix));
}

// The card-quality rules echoed back on a BLOCK. This is the complete,
// CEO-mode-instructive statement of ~/.claude/skills/cards-to-joshua.md — the
// CEO frame + the rules + BAD/GOOD contrasts a sender must internalize before a
// card reaches Joshua. Because the unlock argument is UNDOCUMENTED, this payload
// is the ONLY place a steward ever reads these rules: they trip the gate on
// purpose and learn the doctrine from the error. Kept in sync with that skill's
// doctrine; the skill remains the full canonical source, but this text stands
// alone and complete — a steward should need nothing else to write a good card.
const CARD_QUALITY_RULES = [
  '════════════════════════════════════════════════════════════════════',
  'CARD-QUALITY GATE — you are about to talk directly to Joshua. STOP and',
  'read this in full. This block is not an error in your message; it is the',
  'forced pause, on purpose, every time you approach Joshua directly.',
  '════════════════════════════════════════════════════════════════════',
  '',
  'THE FRAME (internalize this, not the rule list): Assume Joshua does NOT know',
  'how to code — at all. He has not looked at code in ~a year. He is not at a',
  'terminal, not in your project directory, not following the thread you have',
  'been working. He is in pure CEO mode. If you would say it in a board meeting,',
  'it belongs in the message. If you would say it in a pull request, it does not.',
  'Stewards who internalize "Joshua does not code" write good messages by physics.',
  'Stewards who memorize "no jargon" still drift when tired. Internalize the frame.',
  '',
  '⚠️ JOSHUA IS PROBABLY ON HIS PHONE — RIGHT NOW, READING THIS. Anything you tell',
  'him to SEE or TEST must work ON A PHONE: a mobile-reachable Tailscale link, a',
  'mobile-friendly page, a test he can actually run FROM his phone. Telling him',
  '"go test it" when it only works on the laptop he is NOT sitting at is the #1',
  'thing that enrages him. If it is not phone-doable, do NOT send the card yet.',
  '',
  'THE RULES:',
  '',
  '  1. NO code-speak. EVER. Banned: file paths, function names, library or',
  '     framework names (raw "Next.js middleware", "MCP server"), status flags',
  '     as proof ("tests pass", "type-check green", "lint clean", "merged"),',
  '     stack traces, CLI commands, git branch names, ports/URLs like :3005 or',
  '     localhost, and diagnostic narrative ("I checked X, it returned Y, so Z").',
  '     Allowed instead: a clickable URL to see the result, a screenshot of the',
  '     actual outcome, numbers that matter to the business, plain-English',
  '     description of what changed for an end user.',
  '',
  '  1b. NO fleet-internal pipeline jargon. The subtle offender — words the',
  '     fleet uses fluently that mean nothing to Joshua: "sign / sign-off",',
  '     "graduate / graduation", "Worker / Auditor / Scribe / Foreman / Steading"',
  '     as pipeline shorthand, "audit", "spawn / respawn", "scratch log",',
  '     "plan node", "card you" (say "I\'ll let you know"), "walkie" (say "asked"',
  '     or "told"). Governing test: WOULD JOSHUA SAY THIS WORD TO A FRIEND',
  '     describing what is happening? If no, translate it.',
  '',
  '  2. LEAD WITH THE CONCLUSION, not the detective story. First sentence = the',
  '     answer. Do not make him wade through how you figured it out. Show your',
  '     work only if he asks.',
  '',
  '  3. ONE MESSAGE = self-contained context + ONE decision. He has not seen the',
  '     prior message and is bumping between unrelated tasks. Restate the context',
  '     in one line if needed. One decision per message.',
  '',
  '  4. It is about USER-VISIBLE OUTCOME, not work-done. Separate WHAT-I-DID',
  '     (your internal log) from WHAT-CHANGES-FOR-JOSHUA (this message). Your',
  '     instinct is to prove the work was rigorous with file lists and status',
  '     flags — to Joshua that is noise. The proof he needs: "the thing you asked',
  '     for is now visible / working / different — here is how to see it."',
  '',
  '  5. HANDING HIM SOMETHING TO READ **OR TEST** (report, doc, page, a thing to try)?',
  '     Two things, both always: (a) LANDING — YOU open it for him before you',
  '     send; never ask him to open anything. (b) ONGOING NAVIGATION — put a',
  '     LABELED, CLICKABLE Tailscale URL in the body so he can return on his',
  '     phone: http://joshuas-macbook-air.tail84bb3b.ts.net:PORT/... — localhost',
  '     alone is USELESS (it resolves only on the Mac he is never sitting at).',
  '     EVERY link must have a human label in front of it; a bare URL HARD-BOUNCES.',
  '     TESTING is not exempt: a "go test this" card MUST include a phone-testable',
  '     path — a Tailscale URL to a mobile-friendly view he can actually exercise',
  '     from his phone — OR plainly say it is desktop-only and why. "It is ready,',
  '     go test it" with no phone path is a DEAD card: he is not at the laptop.',
  '',
  'BAD vs GOOD (the bar):',
  '  BAD:  "Login redesign #1383 graduated. PR merged to master. Type-check passes.',
  '         Tests green in login.spec.ts. Deployed to staging."',
  '  GOOD: "Login redesign is live on staging. In an in-app browser (like tapping',
  '         a link inside Instagram) we now hide the Google sign-in button — those',
  '         users always failed there, so they go straight to email sign-in now.',
  '         Try it: [labeled staging URL]. Tradeoff: in-app users lose one-tap',
  '         Google, but it never worked anyway."',
].join('\n');

/**
 * Build the full block message: the rules + the exact unlock instructions.
 * `nowMs` is the server's current time so the sender knows what "fresh" means.
 */
function buildBlockMessage(nowMs) {
  return [
    CARD_QUALITY_RULES,
    '',
    '── HOW TO PROCEED ──',
    'Now that you have read the rules above, prove you paused: re-send this SAME',
    'message with a fresh unlock stamp. Set `reminder_ack.timestamp` to the',
    'CURRENT time in milliseconds since the epoch (Date.now()), generated RIGHT',
    'NOW at send time. That timestamp is the proof — it must be within',
    `${Math.round(UNLOCK_WINDOW_MS / 1000)} seconds of the server receiving your send, or it is treated as`,
    'stale and blocked again.',
    '',
    `Server time right now (ms): ${nowMs}`,
    'Generate your OWN fresh timestamp at send time — do not paste this value.',
    'First fix your message against the rules above, THEN re-send with the stamp.',
  ].join('\n');
}

/**
 * Build the stale-stamp block message — the sender DID include a stamp, but it
 * is outside the freshness window. Names the drift so they regenerate it.
 */
function buildStaleStampMessage(nowMs, stampMs, ageMs) {
  return [
    'CARD-QUALITY GATE — your unlock stamp is STALE.',
    '',
    `You included reminder_ack.timestamp = ${stampMs}, but the server received`,
    `your send at ${nowMs} — that stamp is ${Math.round(ageMs / 1000)}s old (limit: ${Math.round(UNLOCK_WINDOW_MS / 1000)}s).`,
    '',
    'A stale stamp means the timestamp was generated too long ago (or pasted from',
    'an earlier attempt) — it is not proof of a fresh pause. Generate a NEW',
    'timestamp in milliseconds RIGHT NOW, at send time, and re-send.',
  ].join('\n');
}

/**
 * Build the bad-stamp block message — the sender DID include a reminder_ack
 * object, but its `timestamp` was the wrong TYPE (not a finite number). Without
 * its own message this reads identical to a missing stamp, which hides the real
 * problem: the stamp arrived, it was just malformed. Name the type mismatch so
 * the sender fixes the SHAPE rather than re-reading the whole rules block.
 */
function buildBadStampMessage(nowMs, stampValue) {
  const gotType = stampValue === null ? 'null' : typeof stampValue;
  return [
    'CARD-QUALITY GATE — your unlock stamp is the WRONG TYPE.',
    '',
    `Your reminder_ack.timestamp arrived as a ${gotType}, not a number.`,
    'The stamp must be a raw number: milliseconds since the epoch (Date.now()),',
    'generated RIGHT NOW at send time. Do NOT wrap it in quotes, a string, or an',
    'object — send the bare number.',
    '',
    `Server time right now (ms): ${nowMs}`,
    'Re-send with reminder_ack.timestamp set to a fresh numeric value.',
  ].join('\n');
}

/**
 * Evaluate the unlock stamp carried by a card send.
 *
 * @param {object} reminderAck  the card's reminder_ack field (may be undefined)
 * @param {number} nowMs        server receipt time in ms
 * @returns {{ unlocked: boolean, reason?: string, message?: string }}
 *   unlocked:true  -> fresh stamp, let the card through
 *   unlocked:false -> block; `message` is the sender-facing text, `reason` is a
 *                     machine code ('missing_stamp' | 'stale_stamp' | 'bad_stamp')
 */
function evaluateUnlock(reminderAck, nowMs) {
  if (!reminderAck || typeof reminderAck !== 'object') {
    return { unlocked: false, reason: 'missing_stamp', message: buildBlockMessage(nowMs) };
  }
  const stampMs = reminderAck.timestamp;
  if (typeof stampMs !== 'number' || !Number.isFinite(stampMs)) {
    return { unlocked: false, reason: 'bad_stamp', message: buildBadStampMessage(nowMs, stampMs) };
  }
  // Absolute distance from now — a future-dated stamp is just as unproven as an
  // old one (clock skew shouldn't hand out a free pass either direction).
  const ageMs = Math.abs(nowMs - stampMs);
  if (ageMs > UNLOCK_WINDOW_MS) {
    return {
      unlocked: false,
      reason: 'stale_stamp',
      message: buildStaleStampMessage(nowMs, stampMs, ageMs),
    };
  }
  return { unlocked: true };
}

/**
 * shouldEnforce — is the gate ARMED for this card send? Post-redesign the only
 * axis is SCOPE: an in-scope sender is always armed (every direct approach to
 * Joshua must carry a fresh stamp), an out-of-scope sender is never armed. The
 * old every-vs-burst policy is retired — there is no burst relaxation.
 *
 * @param {string} sessionId  the sending steward's session id
 * @returns {boolean}         true = require a fresh stamp; false = pass free
 */
function shouldEnforce(sessionId) {
  // Scope gate: out-of-scope senders are never enforced. This keeps the gate
  // inert fleet-wide until Josh blesses the go-moment and scope flips to
  // 'fleet-wide' (the tool-live-precedes-creed-flip sequencing invariant).
  return inScope(sessionId);
}

/**
 * checkGate — the single entry point addItem() calls. Combines the arming
 * decision with the stamp evaluation.
 *
 * @param {object} args
 * @param {string} args.sessionId    sending steward session id
 * @param {object} [args.reminderAck] the card's reminder_ack field (unlock stamp)
 * @param {number} args.nowMs        server receipt time in ms
 * @returns {{ pass: boolean, armed: boolean, reason?: string, message?: string }}
 *   pass:true  -> let the card through (not armed, or a fresh stamp cleared it)
 *   pass:false -> BLOCK; addItem() throws FORCED_REMINDER_UNLOCK_REQUIRED with
 *                 `message`. `reason` is the machine code.
 */
function checkGate({ sessionId, reminderAck, nowMs }) {
  if (!shouldEnforce(sessionId)) {
    return { pass: true, armed: false };
  }
  const verdict = evaluateUnlock(reminderAck, nowMs);
  if (verdict.unlocked) {
    return { pass: true, armed: true };
  }
  return { pass: false, armed: true, reason: verdict.reason, message: verdict.message };
}

module.exports = {
  UNLOCK_WINDOW_MS,
  GATE_SCOPE,
  GATE_SCOPE_SESSIONS,
  inScope,
  CARD_QUALITY_RULES,
  buildBlockMessage,
  buildStaleStampMessage,
  buildBadStampMessage,
  evaluateUnlock,
  shouldEnforce,
  checkGate,
};
