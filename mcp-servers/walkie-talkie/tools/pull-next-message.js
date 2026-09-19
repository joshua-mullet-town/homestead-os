/**
 * pull_next_message tool — Proactively pull the next queued message for this session.
 *
 * Lets busy sessions grab their next message without waiting for the dispatcher.
 * Useful when a session spawns subagents and wants to process the next item in parallel.
 *
 * Marks pulled items as "confirmed" so the dispatcher won't re-deliver them.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getTmuxSessionId } from '../lib/macos.js';

const QUEUE_FILE = join(homedir(), '.homestead', 'queue.json');

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

export const pullNextMessageTool = {
  name: 'pull_next_message',
  description: 'Pull the next pending walkie-talkie message for this session. Use this to proactively grab queued messages while busy (e.g., after spawning a subagent). Returns the oldest pending message and marks it as confirmed so the dispatcher won\'t re-deliver it.',
  inputSchema: {
    type: 'object',
    properties: {
      max_count: {
        type: 'number',
        description: 'Number of messages to pull (default: 1). Set higher to batch-process.',
      },
    },
  },

  async execute(args) {
    const maxCount = args.max_count || 1;
    const sessionId = getTmuxSessionId();

    if (!sessionId) {
      return { error: 'Cannot determine session identity (not in tmux)' };
    }

    const queue = readQueue();
    const pulled = [];

    for (const item of queue) {
      if (pulled.length >= maxCount) break;

      // Match pending items for this session
      if (item.target_session !== sessionId) continue;
      if (item.status !== 'pending') continue;

      // Mark as confirmed (skip "dispatched" — caller is explicitly pulling)
      item.status = 'confirmed';
      item.confirmed_at = new Date().toISOString();
      item.pulled_by = sessionId;

      pulled.push({
        id: item.id,
        type: item.type,
        message: item.message,
        created_at: item.created_at,
        _queue_id: item.id,
        _confirm: `curl -s -X POST http://localhost:3005/api/queue/confirm -H "Content-Type: application/json" -d '{"id":"${item.id}","confirmed_by":"${sessionId}"}'`,
      });
    }

    if (pulled.length > 0) {
      // Confirm through the SERVER, not just this file write.
      //
      // WHY (Alfred-flagged 2026-09-06): the dispatcher cancels an in-flight
      // paste via an IN-MEMORY set (cancelledDeliveries) that only the :3005
      // confirm endpoint populates. This tool runs in a separate MCP process, so
      // a direct queue.json write marked items 'confirmed' but could NOT cancel a
      // delivery already scheduled on the target's chain — the item got pasted
      // anyway and the drain cost a turn per item instead of saving one.
      //
      // Route each pulled id through the endpoint so the cancel path runs. The
      // file write below stays as a fallback for when :3005 is unreachable.
      await Promise.all(
        pulled.map(async (m) => {
          try {
            await fetch('http://localhost:3005/api/queue/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: m.id, confirmed_by: sessionId }),
              signal: AbortSignal.timeout(5000),
            });
          } catch {
            // Server unreachable — the direct write below still marks it confirmed.
          }
        })
      );
      writeQueue(queue);
    }

    if (maxCount === 1) {
      return {
        found: pulled.length > 0,
        message: pulled[0] || null,
      };
    }

    return {
      found: pulled.length > 0,
      count: pulled.length,
      messages: pulled,
    };
  },
};
