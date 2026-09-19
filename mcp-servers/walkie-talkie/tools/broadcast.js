/**
 * broadcast tool — Send a walkie-talkie message to ALL steward sessions.
 *
 * Enumerates ~/.homestead/stewards/ directories and enqueues one message
 * per steward. Each receiver must roger-that (confirm) individually.
 *
 * Use case: push policy updates, CLAUDE.md changes, or instructions
 * to every agent at once.
 */

import { getTmuxSessionId } from '../lib/macos.js';
import { readdirSync, statSync, readlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOMESTEAD_URL = 'http://localhost:3005';
const SISWAPTS_DIR = join(homedir(), '.homestead', 'stewards');

// Not real stewards — skip these
const SKIP = new Set(['.git', 'all', 'queue.json']);

export const broadcastTool = {
  name: 'broadcast',
  description: 'Send a walkie-talkie message to ALL steward sessions at once. Each steward receives the message individually and must roger-that (confirm) receipt. Use for policy updates, CLAUDE.md changes, or any instruction that applies to every agent. Returns the list of targets queued.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to broadcast to all stewards.',
      },
      type: {
        type: 'string',
        enum: ['action', 'feedback'],
        description: 'Message type. Defaults to "action".',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of steward names to exclude (e.g., ["alert-triage"]). Useful to skip yourself.',
      },
    },
    required: ['message'],
  },

  async execute(args) {
    const { message, type, exclude } = args;

    if (!message || typeof message !== 'string') {
      return { success: false, error: 'message is required' };
    }

    const sender = getTmuxSessionId() || 'unknown';
    const msgType = type || 'action';
    const excludeSet = new Set(exclude || []);

    // Also exclude self (by steward name derived from tmux session)
    if (sender.startsWith('holler-')) {
      excludeSet.add(sender.replace('holler-', ''));
    }

    // Enumerate steward directories
    let stewardNames;
    try {
      const entries = readdirSync(SISWAPTS_DIR);
      stewardNames = entries.filter(entry => {
        if (SKIP.has(entry)) return false;
        if (excludeSet.has(entry)) return false;
        const fullPath = join(SISWAPTS_DIR, entry);
        try {
          // Follow symlinks
          const stat = statSync(fullPath);
          return stat.isDirectory();
        } catch {
          return false;
        }
      });
    } catch (error) {
      return { success: false, error: `Failed to read stewards dir: ${error.message}` };
    }

    if (!stewardNames.length) {
      return { success: false, error: 'No stewards found to broadcast to', sender };
    }

    // Enqueue one message per steward
    const results = [];
    const errors = [];

    for (const name of stewardNames) {
      const targetSession = `holler-${name}`;
      const envelope = JSON.stringify({
        type: msgType,
        from: sender,
        broadcast: true,
        instruction: message,
      });

      try {
        const response = await fetch(`${HOMESTEAD_URL}/api/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target_session: targetSession,
            type: msgType,
            message_override: envelope,
          }),
          signal: AbortSignal.timeout(10000),
        });

        const result = await response.json();

        if (response.ok) {
          results.push({ target: targetSession, steward: name, queue_id: result.item?.id });
        } else {
          errors.push({ target: targetSession, error: result.error || `HTTP ${response.status}` });
        }
      } catch (error) {
        errors.push({ target: targetSession, error: error.message });
      }
    }

    return {
      success: results.length > 0,
      sender,
      broadcast_count: results.length,
      queued: results,
      errors: errors.length > 0 ? errors : undefined,
    };
  },
};
