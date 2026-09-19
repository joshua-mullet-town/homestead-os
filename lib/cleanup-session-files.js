/**
 * Nuke all per-session stale files when a tmux session dies.
 *
 * Called from every session-destroy path (API DELETE, cleanup-ephemeral,
 * spawn-worker error paths, etc.) so dead workers cannot
 * "speak" via stale activity/conversation files and presenter history
 * doesn't grow unbounded as Venture churns workers.
 *
 * Safe on missing files — silent no-op per path.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function safeUnlink(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      return true;
    }
  } catch (err) {
    // Log but don't throw — the session is dead, cleanup is best-effort.
    console.error(`[cleanupSessionFiles] Failed to unlink ${filepath}: ${err.message}`);
  }
  return false;
}

function cleanupSessionFiles(sessionName) {
  if (!sessionName) return;

  const home = os.homedir();
  const homesteadDir = path.join(home, '.homestead');

  // Homestead repo — presenter history lives alongside the server, not in homedir.
  // Default: <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/data/presenter-history
  // Allow override via env for flexibility.
  const presenterHistoryDir = process.env.HOMESTEAD_PRESENTER_HISTORY
    || path.join(home, 'code', 'homestead', 'data', 'presenter-history');

  const targets = [
    `/tmp/claude-session-${sessionName}-activity.json`,
    `/tmp/claude-session-${sessionName}-conversation.json`,
    path.join(homesteadDir, 'conversations', `${sessionName}.json`),
    path.join(presenterHistoryDir, `${sessionName}.json`),
  ];

  let removed = 0;
  for (const target of targets) {
    if (safeUnlink(target)) removed++;
  }
  return removed;
}

module.exports = { cleanupSessionFiles };
