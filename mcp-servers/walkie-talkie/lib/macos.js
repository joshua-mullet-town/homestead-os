/**
 * macOS-specific helpers
 */

import { execSync } from 'child_process';

/**
 * Get the current tmux session name (if running in tmux)
 */
export function getTmuxSessionId() {
  try {
    return execSync('tmux display-message -p "#S"', { encoding: 'utf-8' }).trim();
  } catch (e) {
    return null;
  }
}

/**
 * List all active holler sessions
 */
export function listSessions() {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(s => s.startsWith('holler-'));
  } catch {
    return [];
  }
}
