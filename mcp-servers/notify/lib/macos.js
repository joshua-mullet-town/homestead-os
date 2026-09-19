/**
 * macOS-specific helpers for browser control and notifications
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Open a URL in Chrome with the debug profile
 */
export async function openUrl(url) {
  await execAsync(`open -a "Google Chrome" "${url}" --args --user-data-dir=<<REPLACE: your home dir, e.g. /Users/you>>/chrome-debug-profile`);
}

/**
 * Bring Chrome to the front using AppleScript
 */
export async function bringChromeToFront() {
  await execAsync(`osascript -e 'tell application "Google Chrome" to activate'`);
}

/**
 * Play the system Glass sound
 */
export async function playSound() {
  await execAsync(`afplay /System/Library/Sounds/Glass.aiff &`);
}

/**
 * Check if a dev server is responding at the given URL
 */
export async function checkDevServer(serverUrl, maxRetries = 3) {
  const origin = new URL(serverUrl).origin;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(origin, { signal: AbortSignal.timeout(3000) });
      if (resp.ok || resp.status < 500) return true;
    } catch (e) {
      // Server not responding
    }
    if (i < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

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
