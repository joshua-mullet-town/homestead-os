/**
 * set_timer tool — Schedule a deferred walkie-talkie message.
 *
 * Two modes:
 * 1. TIME-BASED: "In 5 minutes, send this message to target session"
 * 2. EVENT-BASED: "When session X stops/goes idle, send this message to target session"
 *
 * Time-based timers are stored in a timers file and checked by the queue dispatcher.
 * Event-based timers hook into session stop detection (checked by the dispatcher
 * when a session goes idle).
 *
 * Any steward can set a timer. The timer fires by queuing a walkie-talkie message.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getTmuxSessionId } from '../lib/macos.js';

const TIMERS_FILE = join(homedir(), '.homestead', 'stewards', 'timers.json');
const QUEUE_FILE = join(homedir(), '.homestead', 'queue.json');

function readTimers() {
  try {
    if (!existsSync(TIMERS_FILE)) return [];
    return JSON.parse(readFileSync(TIMERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeTimers(timers) {
  writeFileSync(TIMERS_FILE, JSON.stringify(timers, null, 2));
}

function readQueue() {
  try {
    if (!existsSync(QUEUE_FILE)) return [];
    return JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

/**
 * Parse a human-friendly delay into milliseconds.
 * Accepts: "5m", "30s", "2h", "1m30s", "90" (seconds)
 */
function parseDelay(delay) {
  if (typeof delay === 'number') return delay * 1000;
  const str = String(delay).toLowerCase().trim();

  // Try composite like "1m30s"
  let totalMs = 0;
  const hourMatch = str.match(/(\d+)\s*h/);
  const minMatch = str.match(/(\d+)\s*m(?!s)/);
  const secMatch = str.match(/(\d+)\s*s/);

  if (hourMatch) totalMs += parseInt(hourMatch[1]) * 3600000;
  if (minMatch) totalMs += parseInt(minMatch[1]) * 60000;
  if (secMatch) totalMs += parseInt(secMatch[1]) * 1000;

  if (totalMs > 0) return totalMs;

  // Plain number = seconds
  const num = parseFloat(str);
  if (!isNaN(num)) return num * 1000;

  return null;
}

export const setTimerTool = {
  name: 'set_timer',
  description: 'Schedule a deferred walkie-talkie message. Two modes: (1) TIME-BASED: set a delay like "5m" or "30s" and the message gets queued after that time. (2) EVENT-BASED: specify a session to watch — when that session stops/goes idle, the message fires. Use this for reminders, follow-ups, and "check on X after Y finishes" patterns.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Session to send the message TO when the timer fires. Defaults to self (the calling session). Use exact session name like "holler-venture".',
      },
      message: {
        type: 'string',
        description: 'The message to deliver when the timer fires.',
      },
      delay: {
        type: 'string',
        description: 'Time-based: delay before firing. Accepts "5m", "30s", "2h", "1m30s", or a number in seconds. Mutually exclusive with watch_session.',
      },
      watch_session: {
        type: 'string',
        description: 'Event-based: session to watch. When this session stops or goes idle, the timer fires. Mutually exclusive with delay.',
      },
      context: {
        type: 'string',
        description: 'Optional context/reason for the timer. Helps the receiver understand why they got this message.',
      },
    },
    required: ['message'],
  },

  async execute(args) {
    const { message, delay, watch_session, context } = args;
    const sender = getTmuxSessionId() || 'unknown';
    const target = args.target || sender;

    if (!message) {
      return { success: false, error: 'message is required' };
    }

    if (!delay && !watch_session) {
      return { success: false, error: 'Either delay or watch_session is required' };
    }

    if (delay && watch_session) {
      return { success: false, error: 'Use delay OR watch_session, not both' };
    }

    const timer = {
      id: `timer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      created_by: sender,
      target_session: target,
      message,
      context: context || null,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    if (delay) {
      const delayMs = parseDelay(delay);
      if (!delayMs || delayMs < 1000) {
        return { success: false, error: `Invalid delay: "${delay}". Use formats like "5m", "30s", "2h"` };
      }
      timer.type = 'time';
      timer.fires_at = new Date(Date.now() + delayMs).toISOString();
      timer.delay_ms = delayMs;
    } else {
      timer.type = 'event';
      timer.watch_session = watch_session.startsWith('holler-') ? watch_session : `holler-${watch_session}`;
    }

    // Save the timer
    const timers = readTimers();
    timers.push(timer);
    writeTimers(timers);

    return {
      success: true,
      timer_id: timer.id,
      type: timer.type,
      target: timer.target_session,
      fires_at: timer.fires_at || null,
      watch_session: timer.watch_session || null,
      message_preview: message.slice(0, 100) + (message.length > 100 ? '...' : ''),
    };
  },
};

/**
 * Process timers — called by the queue dispatcher on each tick.
 * Checks for fired time-based timers and event-based timers whose watched session stopped.
 *
 * This function is exported for the dispatcher to use, not as an MCP tool.
 */
export function processTimers(activeSessions = []) {
  const timers = readTimers();
  const queue = readQueue();
  const now = new Date();
  let changed = false;
  let queueChanged = false;

  for (const timer of timers) {
    if (timer.status !== 'pending') continue;

    let shouldFire = false;

    if (timer.type === 'time' && new Date(timer.fires_at) <= now) {
      shouldFire = true;
    }

    if (timer.type === 'event' && timer.watch_session) {
      // Fire if the watched session is NOT in the active sessions list
      const isActive = activeSessions.some(s =>
        s === timer.watch_session || s.name === timer.watch_session
      );
      if (!isActive) {
        shouldFire = true;
      }
    }

    if (shouldFire) {
      // Queue the message as a walkie-talkie delivery
      const envelope = JSON.stringify({
        type: 'action',
        from: timer.created_by,
        instruction: timer.message,
        _timer_id: timer.id,
        _timer_context: timer.context,
      });

      queue.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        target_session: timer.target_session,
        type: 'action',
        message: envelope,
        status: 'pending',
        created_at: new Date().toISOString(),
        source: 'timer',
        timer_id: timer.id,
      });

      timer.status = 'fired';
      timer.fired_at = new Date().toISOString();
      changed = true;
      queueChanged = true;
    }
  }

  // Clean up old fired timers (older than 24h)
  const cutoff = new Date(Date.now() - 86400000);
  const cleaned = timers.filter(t =>
    t.status === 'pending' || new Date(t.created_at) > cutoff
  );

  if (cleaned.length !== timers.length) changed = true;

  if (changed) writeTimers(cleaned);
  if (queueChanged) writeQueue(queue);

  return { fired: timers.filter(t => t.status === 'fired').length };
}
