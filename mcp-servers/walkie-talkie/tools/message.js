/**
 * message tool — "The One Tool" unified messaging entry point.
 *
 * ONE act, ONE tool. The steward names a recipient and composes a message; the
 * tool figures out the surface:
 *
 *   recipient = "josh" / "joshua"  -> a CARD to Joshua (the human). Carries the
 *                                     forced-reminder card-quality gate.
 *   recipient = any steward name   -> a fast plain walkie to that session,
 *                                     behavior identical to send_message.
 *
 * This is a THIN entry-tool over the shared dispatch core (lib/message-dispatch).
 * It is now the ONLY messaging path: the legacy send_message and present_to_user
 * tools were removed once this unified migration was proven non-regressed. Josh's
 * "same act, tool figures out the rest" is realized here; the steward-walkie
 * invariant holds by construction because the core mirrors the original
 * send_message envelope exactly, and the card path is the same server endpoint
 * the old present_to_user tool used (POST /api/presenter/queue).
 */

import { createRequire } from 'module';
import {
  classifyRecipient,
  dispatchToSteward,
  dispatchToJosh,
} from '../lib/message-dispatch.js';

const require = createRequire(import.meta.url);
const HOMESTEAD_URL = 'http://localhost:3005';

export const messageTool = {
  name: 'message',
  description:
    'THE unified messaging tool — one act, the tool picks the surface by recipient. ' +
    'Set recipient to "josh" (or "joshua") to reach Joshua directly (a persistent floating ' +
    'window on his devices; his reply arrives later as feedback) — this needs title + ' +
    'message + buttons + status + recap. Set recipient to any other session ("holler-homestead", "homestead", ' +
    '"homestead/branch") to reach a steward with a fast plain walkie — just recipient + ' +
    'message; your identity is auto-attached and the receiver must roger-that.',
  inputSchema: {
    type: 'object',
    properties: {
      recipient: {
        type: 'string',
        description:
          'Who receives this. "josh" or "joshua" -> a card to Joshua the human. Any session ' +
          'target ("holler-homestead", "homestead", "homestead/branch") -> a walkie to that steward.',
      },
      message: {
        type: 'string',
        description:
          'The message body. For a walkie: the full content. For a card to Joshua: the card body ' +
          '(plain English, CEO mode).',
      },
      // --- steward-walkie-only ---
      type: {
        type: 'string',
        enum: ['action', 'feedback'],
        description: 'Walkie only. "action" for instructions/requests, "feedback" for responses. Default "action". Ignored for cards to Joshua.',
      },
      // --- card-to-josh-only ---
      title: {
        type: 'string',
        description: 'Card to Joshua only. Short title (e.g. "Build Complete"). Required when recipient is josh.',
      },
      buttons: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                label: { type: 'string' },
                run: { type: 'string' },
              },
              required: ['label'],
            },
          ],
        },
        description: 'Card to Joshua only. Buttons — plain string labels or { label, run }. Required (non-empty) when recipient is josh.',
      },
      // --- 3-lane docket (card to Joshua only) ---
      // These two drive Josh's scanning view. They are REQUIRED on the card path
      // (enforced in lib/message-dispatch.dispatchToJosh) — deliberately, not by
      // oversight. Before this, the tool exposed neither field, so every card
      // from every steward fell through the server's `undefined -> 'fyi'`
      // fallback and landed in the swipe-past lane, including cards where a
      // Worker was blocked on Josh's answer. A default (any default) just moves
      // that silent mis-file somewhere else, so there is none: the sender picks.
      status: {
        type: 'string',
        enum: ['blocked', 'weigh_in', 'fyi'],
        description:
          'Card to Joshua only. REQUIRED. Which lane this card lands in, on the axis of ' +
          '"does this invite Josh?" — "blocked": you CANNOT proceed without his answer; you are ' +
          'stopped and waiting on him. "weigh_in": you are moving fine, but he would want to ' +
          'steer, react, or veto — he can ignore it and you keep going. "fyi": nothing for him ' +
          'to do; you are reporting. Pick honestly by whether YOUR work is stopped, not by how ' +
          'much you want a reply — marking a non-blocking card "blocked" is how the loud lane ' +
          'stops meaning anything.',
      },
      recap: {
        type: 'string',
        description:
          'Card to Joshua only. REQUIRED. ONE plain-English line — this is the text Josh actually ' +
          'SEES while scanning his deck, before he opens anything. It is not a summary of the ' +
          'card; it is the single thing he needs off it at a glance. Write it to match the lane: ' +
          'blocked -> the question or choice you need from him ("Ship the status fix now or wait ' +
          'for the APK build?"); weigh_in -> what he would want to steer ("Defaulting new cards ' +
          'to the middle lane"); fyi -> what happened ("Card status field shipped, needs a ' +
          'restart"). No file paths, no function names, no steward jargon. If it reads like a ' +
          'title, rewrite it as the sentence you would say out loud.',
      },
      priority: {
        type: 'string',
        enum: ['normal', 'urgent'],
        description: 'Card to Joshua only. Urgent cards jump the queue.',
      },
      category: {
        type: 'string',
        enum: ['situation', 'build'],
        description: 'Card to Joshua only. Visual badge.',
      },
      source: {
        type: 'string',
        description: 'Card to Joshua only. Human-readable source label shown on the card.',
      },
      component: {
        type: 'string',
        description: 'Card to Joshua only. Optional registered custom component to render below the message.',
      },
      componentProps: {
        type: 'object',
        description: 'Card to Joshua only. Optional JSON props for the named component.',
        additionalProperties: true,
      },
      // Card-quality unlock stamp for the fleet-wide forced-reminder gate (card
      // to Joshua only). A steward who reaches Joshua directly WITHOUT a stamp is
      // MEANT to trip the gate the first time, read the card-quality rules the
      // error returns, then re-send with a fresh `reminder_ack.timestamp`
      // (current ms, within 10s) as proof they paused. The RULES are taught only
      // in the error payload — nothing here or in any creed spells them out. But
      // the arg itself MUST be DECLARED: the Claude Code MCP client validates
      // tool-call args against inputSchema and STRIPS undeclared properties before
      // they go over the wire, so an undeclared reminder_ack never reaches the
      // server and the unlock is undeliverable. Declaring it (optional, not in
      // `required`) is what makes the unlock actually work.
      reminder_ack: {
        type: 'object',
        properties: {
          timestamp: { type: 'number' },
        },
      },
      // Potato loop-close (card to Joshua only). When a steward cards Joshua to
      // answer/close a message JOSH originated (a tracked "potato"), pass the
      // potato_id here so the drop-detection tracker marks that potato's loop
      // closed. Like reminder_ack, this MUST be DECLARED here: the Claude Code MCP
      // client validates args against inputSchema and STRIPS undeclared properties
      // before they go over the wire — an undeclared potato_id would never reach
      // the server and the loop would never close. Optional: omit for ordinary
      // cards that aren't answering a tracked Josh message.
      potato_id: {
        type: 'string',
        description:
          'Card to Joshua only. The potato_id of the Josh-originated message this card is answering/closing. ' +
          'Omit for ordinary cards. Closes that potato\'s drop-detection loop.',
      },
    },
    required: ['recipient', 'message'],
  },

  async execute(args) {
    const { recipient, message } = args;

    if (!recipient || typeof recipient !== 'string') {
      return { success: false, error: 'recipient is required' };
    }
    if (!message || typeof message !== 'string') {
      return { success: false, error: 'message is required' };
    }

    const surface = classifyRecipient(recipient);

    if (surface === 'josh') {
      // Route to the Josh-facing card path (forced-reminder gate lives server-side).
      return dispatchToJosh({
        title: args.title,
        message,
        status: args.status,
        recap: args.recap,
        buttons: args.buttons,
        priority: args.priority,
        category: args.category,
        source: args.source,
        component: args.component,
        componentProps: args.componentProps,
        reminder_ack: args.reminder_ack,
        potato_id: args.potato_id,
      });
    }

    // Steward walkie — validate the target, then dispatch. Uses the same
    // steward-resolver + fuzzy resolution send_message uses, so targeting
    // behavior is identical.
    try {
      const resolver = require('../../../lib/steward-resolver');
      const validation = resolver.resolveTarget(recipient);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
          validTargets: validation.validTargets,
        };
      }
    } catch (e) {
      // Resolver unavailable — fall through to fuzzy resolution below.
      console.error('[message] steward-resolver unavailable, falling back:', e.message);
    }

    return dispatchToSteward({
      recipient,
      message,
      type: args.type,
      resolveSession,
    });
  },
};

/**
 * Resolve a fuzzy session target to an exact session name. Byte-identical logic
 * to send_message's private resolveSession (mirrored, not imported, so
 * send_message stays literally untouched). Accepts exact names ("holler-x"),
 * project names ("homestead"), and project/branch ("homestead/branch").
 */
async function resolveSession(target) {
  if (target.startsWith('holler-')) {
    return { success: true, name: target, project: target.replace(/^holler-/, '').replace(/--.*$/, '') };
  }

  let sessions;
  try {
    const response = await fetch(`${HOMESTEAD_URL}/api/sessions`, { signal: AbortSignal.timeout(5000) });
    sessions = await response.json();
    sessions = Array.isArray(sessions) ? sessions : sessions.sessions || [];
  } catch {
    return { success: false, error: `Can't resolve "${target}" — Homestead API unavailable. Use exact session name (e.g., "holler-homestead").` };
  }

  if (target.includes('/')) {
    const [project, branch] = target.split('/', 2);
    const matches = sessions.filter(s => s.project === project && s.branch === branch);
    if (matches.length === 1) return { success: true, name: matches[0].name, project: matches[0].project };
    if (matches.length === 0) return { success: false, error: `No session found for project "${project}" on branch "${branch}".`, available: sessions.map(s => ({ name: s.name, project: s.project, branch: s.branch })) };
    return { success: false, error: `Multiple sessions match "${target}".`, matches: matches.map(s => s.name) };
  }

  const matches = sessions.filter(s => s.project === target);
  if (matches.length === 1) return { success: true, name: matches[0].name, project: matches[0].project };
  if (matches.length === 0) {
    const fuzzy = sessions.filter(s => s.name.includes(target) || s.project.includes(target));
    if (fuzzy.length === 1) return { success: true, name: fuzzy[0].name, project: fuzzy[0].project };
    return { success: false, error: `No session found matching "${target}".`, available: sessions.map(s => ({ name: s.name, project: s.project, branch: s.branch })) };
  }
  return {
    success: false,
    error: `"${target}" matches ${matches.length} sessions. Be more specific — use project/branch format.`,
    matches: matches.map(s => ({ name: s.name, project: s.project, branch: s.branch })),
  };
}
