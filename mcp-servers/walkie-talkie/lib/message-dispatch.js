/**
 * Shared message-dispatch core — "The One Tool" unification.
 *
 * Josh's approved mental model: "same act, the tool figures out the rest."
 * A steward composes ONE message and names a recipient; this core decides the
 * surface by RECIPIENT:
 *
 *   recipient is a STEWARD  -> fast plain walkie (POST /api/queue). Behavior is
 *                              UNCHANGED from send_message: same envelope, same
 *                              queue, same roger-that flow, zero new friction,
 *                              no gate. Proven-by-construction: this path posts
 *                              the EXACT same envelope send_message builds.
 *   recipient is JOSH       -> the Josh-facing CARD path (POST /api/presenter/
 *                              queue), which carries the forced-reminder
 *                              card-quality gate. The gate lives server-side in
 *                              addItem(); this core only routes to it.
 *
 * ARCHITECTURE (Foreman-signed-off): shared core + thin entry-tool. This core
 * re-implements the two send paths from their own first principles (it does NOT
 * import the old tools), so the steward-to-steward invariant is provable by
 * construction. The unified `message` entry-tool delegates to this core, which
 * is now the only messaging path — the legacy send_message and present_to_user
 * tools were removed once this migration was proven non-regressed.
 *
 * WHERE THE GATE IS NOT: this core does NOT enrich or gate the walkie envelope.
 * The forced-reminder gate is exclusively on the card path (server addItem()).
 * Steward-to-steward walkies pass through the universal dispatcher untouched.
 */

import { getTmuxSessionId } from './macos.js';

// Defaults to production (:3005). Env-overridable so an isolated proof instance
// can point the real tool path at a worktree server on a test port without
// touching production behavior.
const HOMESTEAD_URL = process.env.HOMESTEAD_URL || 'http://localhost:3005';

// Recipients that mean "Joshua" — the human, not a steward. Matched
// case-insensitively against the trimmed recipient string. Anything else is
// treated as a steward target and resolved through the walkie resolver.
const JOSH_ALIASES = new Set(['josh', 'joshua', 'user', '<<REPLACE: your email>>']);

/**
 * Decide the surface for a recipient. Returns 'josh' or 'steward'.
 * A JOSH recipient routes to the card path; everything else is a steward walkie.
 */
export function classifyRecipient(recipient) {
  const key = String(recipient || '').trim().toLowerCase();
  return JOSH_ALIASES.has(key) ? 'josh' : 'steward';
}

/**
 * STEWARD path — send a walkie. This is a from-first-principles re-implementation
 * of the send_message envelope+POST, kept byte-compatible with that tool so the
 * steward-to-steward invariant cannot drift. It intentionally does NOT import
 * send_message (which must stay literally untouched); it mirrors it.
 *
 * @param {object} p
 * @param {string} p.recipient  target session (fuzzy or exact)
 * @param {string} p.message    message body
 * @param {string} [p.type]     'action' | 'feedback' (default 'action')
 * @param {function} p.resolveSession  the walkie session resolver (injected so
 *                   this core stays dependency-light and testable)
 */
export async function dispatchToSteward({ recipient, message, type, resolveSession }) {
  const sender = getTmuxSessionId() || 'unknown';
  const msgType = type || 'action';

  const resolved = await resolveSession(recipient);
  if (!resolved.success) {
    return { ...resolved, sender };
  }
  const targetName = resolved.name;

  // EXACT same envelope shape send_message builds — do not change.
  const envelope = JSON.stringify({
    type: msgType,
    from: sender,
    instruction: message,
  });

  try {
    const response = await fetch(`${HOMESTEAD_URL}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_session: targetName,
        type: msgType,
        message_override: envelope,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) {
      return { success: false, error: result.error || `HTTP ${response.status}`, sender, target: targetName };
    }
    return {
      success: true,
      surface: 'walkie',
      queued: true,
      queue_id: result.item?.id,
      sender,
      target: targetName,
      project: resolved.project,
    };
  } catch (error) {
    if (error.name === 'TimeoutError') {
      return { success: false, error: 'Request timed out', sender, target: targetName };
    }
    return { success: false, error: error.message, sender, target: targetName };
  }
}

/**
 * JOSH path — post a card. Routes to /api/presenter/queue, where the server's
 * addItem() runs the full card-quality lineage: session_id validation, the
 * forced-reminder gate (BLOCK + 10s fresh-timestamp unlock),
 * naked/lazy/duplicate link gates. This core does NOT re-implement any gate —
 * it just posts the card and relays the server's structured 4xx rejections
 * (including FORCED_REMINDER_UNLOCK_REQUIRED with the echoed rules) verbatim.
 *
 * @param {object} p  card fields: title, message, buttons, status, recap,
 *                    priority, category, source, component, componentProps,
 *                    reminder_ack
 */
export async function dispatchToJosh(p) {
  const { title, message, buttons, status, recap, priority, category, source, component, componentProps, reminder_ack, potato_id } = p;

  if (!title || typeof title !== 'string') {
    return { success: false, error: 'title is required for a card to Joshua' };
  }
  if (!message || typeof message !== 'string') {
    return { success: false, error: 'message is required for a card to Joshua' };
  }
  if (!Array.isArray(buttons) || buttons.length === 0) {
    return { success: false, error: 'buttons must be a non-empty array for a card to Joshua' };
  }

  // 3-lane docket: status + recap are HARD-REQUIRED on the card path, and are
  // rejected HERE (client-side) rather than defaulted. The server's addItem()
  // keeps its `undefined -> 'fyi'` fallback for IN-PROCESS system callers
  // (job-scheduler alarms and the like), which is correct for them — but that
  // same fallback is what silently buried every steward card in the swipe-past
  // lane once the message tool stopped sending these fields. A default here of
  // ANY value would just relocate the silent mis-file: 'fyi' hides blocked
  // cards, 'weigh_in' falsely pokes Josh for every routine report. So the
  // sender chooses, or the send fails loudly with the choice spelled out.
  if (status !== 'blocked' && status !== 'weigh_in' && status !== 'fyi') {
    return {
      success: false,
      error:
        'status is required for a card to Joshua and must be exactly one of "blocked", ' +
        '"weigh_in", or "fyi"' + (status ? ` (got "${status}")` : '') + '. This is the lane ' +
        'the card lands in on Josh\'s deck — "blocked": you cannot proceed without his answer. ' +
        '"weigh_in": you are moving, but he would want to steer or veto. "fyi": nothing for him ' +
        'to do. There is no default on purpose: an unmarked card used to fall into "fyi" and ' +
        'get swiped past, even when a Worker was stopped waiting on it.',
    };
  }
  if (typeof recap !== 'string' || !recap.trim()) {
    return {
      success: false,
      error:
        'recap is required for a card to Joshua — one plain-English line. This is the text Josh ' +
        'SEES while scanning his deck, before he opens the card. Not a summary of the card: the ' +
        'single thing he needs off it at a glance. Match it to your status — blocked: the ' +
        'question you need answered; weigh_in: what he would want to steer; fyi: what happened. ' +
        'No file paths, no function names.',
    };
  }

  const session_id = getTmuxSessionId() || 'unknown';

  const payload = {
    title,
    message,
    buttons,
    input: true,               // every card must allow free-form response
    // Validated above — pass through verbatim so the STORED item carries the
    // sender's real lane, instead of the server-side fallback overwriting it.
    status,
    recap: recap.trim(),
    priority: priority || 'normal',
    category: category || null,
    session_id,
    callback_session: session_id,
    source: source || null,
    component: component || null,
    componentProps: componentProps || null,
    reminder_ack: reminder_ack || null,
    // Potato loop-close: a card to Josh carrying a potato_id closes that potato's
    // drop-detection loop server-side (presenter-queue.addItem). Optional — a card
    // with no potato_id is a normal card and closes nothing.
    potato_id: potato_id || null,
  };

  try {
    const response = await fetch(`${HOMESTEAD_URL}/api/presenter/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();

    // A 4xx is a REJECTED card — relay it as success:false so the steward sees
    // the rejection (incl. the forced-reminder rules) and can fix + re-send.
    if (!response.ok) {
      return {
        success: false,
        surface: 'card',
        rejected: true,
        status: response.status,
        code: result.code || null,
        error: result.error || `Presenter rejected the card (HTTP ${response.status})`,
      };
    }
    return { success: true, surface: 'card', queued: true, ...result };
  } catch (error) {
    return { success: false, surface: 'card', error: `Card path unavailable: ${error.message}` };
  }
}
