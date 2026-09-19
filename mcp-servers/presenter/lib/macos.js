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
