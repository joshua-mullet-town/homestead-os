/**
 * start_thread / reply_to_thread tools — Round-robin group conversations.
 *
 * A thread is a structured group discussion between multiple stewards.
 * Messages travel in order: A → B → C → A → B → C, each participant
 * seeing the full accumulated context before adding their piece.
 *
 * Rules:
 * - Each participant responds in turn, then the message goes to the next
 * - Thread ends when all participants say "agreed" or "done"
 * - If no agreement after 5 rounds, thread escalates to Joshua
 * - Disagreements must have logical reasons, not arbitrary objections
 * - The thread message is self-documenting — it includes all instructions
 *   so even a brand-new steward knows exactly what to do
 *
 * Threads are persisted in the walkie-talkie queue (each hop is a queue item).
 * Thread state is stored in a threads file for tracking active conversations.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getTmuxSessionId } from '../lib/macos.js';

const THREADS_FILE = join(homedir(), '.homestead', 'stewards', 'threads.json');
// Route thread queue writes through the Homestead API (the SAME path send_message
// uses) instead of writing queue.json directly. This makes every thread send flow
// through queueDispatcher.enqueue() — the single potato-tracker observation
// chokepoint — so a thread reply/forward ALSO closes the sender's owed-response
// loop (Josh's "to ANYONE whatsoever"). A direct queue.json write bypasses that
// chokepoint entirely, so the tracker would never see the send.
const HOMESTEAD_URL = 'http://localhost:3005';

function readThreads() {
  try {
    if (!existsSync(THREADS_FILE)) return [];
    return JSON.parse(readFileSync(THREADS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeThreads(threads) {
  writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
}

/**
 * Enqueue a thread hop through the Homestead API → queueDispatcher.enqueue().
 * The envelope (message_override) carries the thread's `_thread_id` inside it, so
 * threaded delivery is unaffected — the dispatcher delivers on target_session +
 * message alone, and reply_to_thread parses `_thread_id` from the envelope, NOT
 * from any top-level queue-item field. (The old direct write stamped a cosmetic
 * `source`/`thread_id` on the item that nothing in the delivery path ever read.)
 *
 * Returns { success, queue_id? , error? }. Never throws — a transport failure is
 * surfaced to the caller so the tool can report it rather than crash the thread.
 */
async function enqueueViaApi({ targetSession, envelope, type }) {
  try {
    const response = await fetch(`${HOMESTEAD_URL}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_session: targetSession,
        type: type || 'action',
        message_override: envelope,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { success: false, error: result.error || `HTTP ${response.status}` };
    }
    return { success: true, queue_id: result.item?.id };
  } catch (error) {
    const msg = error.name === 'TimeoutError' ? 'Request timed out' : error.message;
    return { success: false, error: msg };
  }
}

/**
 * Build the thread message that gets delivered to each participant.
 * This is self-documenting — it contains all instructions so any steward knows what to do.
 */
function buildThreadMessage(thread, newEntry) {
  const currentIdx = thread.current_index;
  const currentParticipant = thread.participants[currentIdx];
  const nextIdx = (currentIdx + 1) % thread.participants.length;
  const nextParticipant = thread.participants[nextIdx];
  const round = Math.floor(thread.entries.length / thread.participants.length) + 1;

  let msg = `--- THREAD: ${thread.topic} ---\n`;
  msg += `Thread ID: ${thread.id}\n`;
  msg += `Round: ${round} of 5 max\n`;
  msg += `Participants: ${thread.participants.join(' → ')}\n`;
  msg += `You are: ${currentParticipant}\n`;
  msg += `Next up: ${nextParticipant}\n\n`;

  msg += `--- INSTRUCTIONS ---\n`;
  msg += `You are part of a round-robin group discussion. Read the full context below, then add your response.\n\n`;
  msg += `When you're done, use reply_to_thread with:\n`;
  msg += `  thread_id: "${thread.id}"\n`;
  msg += `  response: your response text\n`;
  msg += `  status: "continue" (to keep discussing) or "agree" (if you're satisfied)\n\n`;
  msg += `RULES:\n`;
  msg += `- Read all previous responses before adding yours\n`;
  msg += `- If you disagree, provide a logical reason — no arbitrary objections\n`;
  msg += `- You may ask clarifying questions\n`;
  msg += `- If this goes past 5 rounds without agreement, it escalates to Joshua\n`;
  msg += `- Thread ends when ALL participants say "agree"\n\n`;

  msg += `--- CONTEXT ---\n`;
  msg += `Topic: ${thread.topic}\n`;
  msg += `Started by: ${thread.started_by}\n\n`;

  if (thread.entries.length === 0) {
    msg += `Opening message:\n${thread.opening_message}\n`;
  } else {
    msg += `Opening message (from ${thread.started_by}):\n${thread.opening_message}\n\n`;
    msg += `--- DISCUSSION ---\n`;
    for (const entry of thread.entries) {
      msg += `\n[${entry.from}] (${entry.status}):\n${entry.response}\n`;
    }
  }

  if (newEntry) {
    msg += `\n[${newEntry.from}] (${newEntry.status}):\n${newEntry.response}\n`;
  }

  msg += `\n--- YOUR TURN ---\n`;
  msg += `Add your response using reply_to_thread.\n`;

  return msg;
}

export const startThreadTool = {
  name: 'start_thread',
  description: 'Start a round-robin group conversation between multiple stewards. Messages travel in order through all participants, each seeing the full context. Thread ends when all say "agree" or after 5 rounds (escalates to Joshua). Use this for multi-steward discussions, planning, and consultation.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Short topic/title for the thread (e.g., "Timer implementation approach")',
      },
      participants: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered list of session names. Messages travel in this order. The first participant receives the opening message. Example: ["holler-rooster", "holler-homestead", "holler-steward-manager"]',
      },
      message: {
        type: 'string',
        description: 'Opening message / topic to discuss. Sets the context for the entire thread.',
      },
    },
    required: ['topic', 'participants', 'message'],
  },

  async execute(args) {
    const { topic, participants, message } = args;
    const sender = getTmuxSessionId() || 'unknown';

    if (!topic) return { success: false, error: 'topic is required' };
    if (!participants || participants.length < 2) {
      return { success: false, error: 'Need at least 2 participants' };
    }
    if (!message) return { success: false, error: 'message is required' };

    // Normalize participant names
    const normalized = participants.map(p =>
      p.startsWith('holler-') ? p : `holler-${p}`
    );

    const thread = {
      id: `thread-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      topic,
      started_by: sender,
      participants: normalized,
      opening_message: message,
      entries: [],
      current_index: 0,
      status: 'active',
      round: 1,
      created_at: new Date().toISOString(),
    };

    // Save the thread
    const threads = readThreads();
    threads.push(thread);
    writeThreads(threads);

    // Queue the first message to participant[0] via the enqueue chokepoint.
    const threadMsg = buildThreadMessage(thread);
    const envelope = JSON.stringify({
      type: 'action',
      from: sender,
      instruction: threadMsg,
      _thread_id: thread.id,
    });

    const enq = await enqueueViaApi({ targetSession: normalized[0], envelope, type: 'action' });
    if (!enq.success) {
      return { success: false, error: `Failed to enqueue thread opener: ${enq.error}`, thread_id: thread.id };
    }

    return {
      success: true,
      thread_id: thread.id,
      topic,
      participants: normalized,
      first_recipient: normalized[0],
      queue_id: enq.queue_id,
      message_preview: message.slice(0, 100) + (message.length > 100 ? '...' : ''),
    };
  },
};

export const replyToThreadTool = {
  name: 'reply_to_thread',
  description: 'Reply to a round-robin thread. Your response gets added to the thread context and forwarded to the next participant. Set status to "agree" when satisfied, or "continue" to keep discussing.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: {
        type: 'string',
        description: 'The thread ID (from the thread message you received)',
      },
      response: {
        type: 'string',
        description: 'Your response / contribution to the discussion',
      },
      status: {
        type: 'string',
        enum: ['continue', 'agree'],
        description: '"continue" to keep discussing, "agree" if you are satisfied with the current state',
      },
    },
    required: ['thread_id', 'response', 'status'],
  },

  async execute(args) {
    const { thread_id, response, status } = args;
    const sender = getTmuxSessionId() || 'unknown';

    if (!thread_id) return { success: false, error: 'thread_id is required' };
    if (!response) return { success: false, error: 'response is required' };
    if (!status) return { success: false, error: 'status is required ("continue" or "agree")' };

    const threads = readThreads();
    const thread = threads.find(t => t.id === thread_id);

    if (!thread) {
      return { success: false, error: `Thread not found: ${thread_id}` };
    }

    if (thread.status !== 'active') {
      return { success: false, error: `Thread is ${thread.status}, not active` };
    }

    // Add this entry
    const entry = {
      from: sender,
      response,
      status,
      timestamp: new Date().toISOString(),
    };
    thread.entries.push(entry);

    // Check if all participants have agreed
    const recentStatuses = {};
    for (const e of thread.entries) {
      recentStatuses[e.from] = e.status;
    }
    const allAgreed = thread.participants.every(p => recentStatuses[p] === 'agree');

    // Check round count
    const round = Math.floor(thread.entries.length / thread.participants.length) + 1;
    thread.round = round;

    if (allAgreed) {
      thread.status = 'resolved';
      thread.resolved_at = new Date().toISOString();
      writeThreads(threads);

      return {
        success: true,
        thread_id: thread.id,
        status: 'resolved',
        message: 'All participants agreed. Thread closed.',
        round,
      };
    }

    if (round > 5) {
      thread.status = 'escalated';
      thread.escalated_at = new Date().toISOString();
      writeThreads(threads);

      // Queue escalation message to Joshua via presenter steward-manager, through
      // the enqueue chokepoint. NOTE: from='thread-system' (not a real session), so
      // this escalation does NOT close any potato — only a real steward's own send
      // matching envelope.from===holder closes. That's correct: the escalation is a
      // system notification, not the holder answering.
      const escalationMsg = JSON.stringify({
        type: 'action',
        from: 'thread-system',
        instruction: `THREAD ESCALATION: "${thread.topic}" has gone 5+ rounds without agreement. Thread ID: ${thread.id}. Participants: ${thread.participants.join(', ')}. Please present to Joshua for resolution.\n\n--- FULL THREAD ---\nOpening: ${thread.opening_message}\n\n${thread.entries.map(e => `[${e.from}] (${e.status}): ${e.response}`).join('\n\n')}`,
        _thread_id: thread.id,
      });
      const escEnq = await enqueueViaApi({ targetSession: 'holler-steward-manager', envelope: escalationMsg, type: 'action' });
      if (!escEnq.success) {
        return { success: false, error: `Failed to enqueue thread escalation: ${escEnq.error}`, thread_id: thread.id };
      }

      return {
        success: true,
        thread_id: thread.id,
        status: 'escalated',
        message: 'Thread exceeded 5 rounds without agreement. Escalated to Steward Manager for Joshua.',
        round,
      };
    }

    // Advance to next participant
    const nextIdx = (thread.current_index + 1) % thread.participants.length;
    thread.current_index = nextIdx;
    writeThreads(threads);

    // Queue message to next participant THROUGH the enqueue chokepoint. Because the
    // envelope's from===sender (this replying steward's real session name), the
    // potato-tracker observation at enqueue closes any owed-response THIS steward
    // held — a thread reply is the sender's "next outbound to anyone" and Josh wants
    // it to close the loop. (A direct queue.json write would bypass that entirely.)
    const threadMsg = buildThreadMessage(thread);
    const envelope = JSON.stringify({
      type: 'action',
      from: sender,
      instruction: threadMsg,
      _thread_id: thread.id,
    });

    const fwdEnq = await enqueueViaApi({ targetSession: thread.participants[nextIdx], envelope, type: 'action' });
    if (!fwdEnq.success) {
      return { success: false, error: `Failed to forward thread reply: ${fwdEnq.error}`, thread_id: thread.id };
    }

    return {
      success: true,
      thread_id: thread.id,
      next_participant: thread.participants[nextIdx],
      queue_id: fwdEnq.queue_id,
      round,
      entries_count: thread.entries.length,
      your_status: status,
    };
  },
};
