#!/usr/bin/env node
/**
 * Update Session Status
 *
 * Updates status fields in ~/.claude/sessions/*.json files.
 * Used by:
 * - spawn-turn-watcher.js to set watcherStatus: "working"
 * - Watcher to set watcherStatus: "done"
 * - Homestead UI to set read: true
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

/**
 * Generate hash from cwd (same as hooks use)
 */
function getCwdHash(cwd) {
  return crypto.createHash('md5').update(cwd).digest('hex').substring(0, 12);
}

/**
 * Find session file by tmux session name or cwd
 */
function findSessionFile(identifier) {
  // If it's a path (cwd), hash it
  if (identifier.startsWith('/')) {
    const hash = getCwdHash(identifier);
    const filePath = path.join(SESSIONS_DIR, `${hash}.json`);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
    return null;
  }

  // Otherwise search by tmuxSession field
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  const files = fs.readdirSync(SESSIONS_DIR);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const filePath = path.join(SESSIONS_DIR, file);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (content.tmuxSession === identifier) {
        return filePath;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

/**
 * Find ALL session files matching a tmux session name
 * @param {string} tmuxSessionName - tmux session name to match
 * @returns {string[]} - array of file paths
 */
function findAllSessionFiles(tmuxSessionName) {
  if (tmuxSessionName.startsWith('/') || !fs.existsSync(SESSIONS_DIR)) return [];

  const matches = [];
  const files = fs.readdirSync(SESSIONS_DIR);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const filePath = path.join(SESSIONS_DIR, file);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (content.tmuxSession === tmuxSessionName) {
        matches.push(filePath);
      }
    } catch (e) {
      continue;
    }
  }
  return matches;
}

/**
 * Update fields in a session file
 * @param {string} identifier - tmux session name or cwd path
 * @param {object} updates - fields to update (e.g., { watcherStatus: 'working', read: true })
 * @returns {boolean} - success
 */
function updateSessionStatus(identifier, updates) {
  const filePath = findSessionFile(identifier);
  if (!filePath) {
    console.error(`[updateSessionStatus] Session not found: ${identifier}`);
    return false;
  }

  try {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Apply updates
    Object.assign(content, updates);

    // Write back
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    console.log(`[updateSessionStatus] Updated ${filePath}:`, updates);
    return true;
  } catch (err) {
    console.error(`[updateSessionStatus] Error updating session:`, err.message);
    return false;
  }
}

/**
 * Set watcher status for a session
 */
function setWatcherStatus(identifier, status) {
  return updateSessionStatus(identifier, { watcherStatus: status });
}

/**
 * Mark session as read
 */
function markAsRead(identifier) {
  return updateSessionStatus(identifier, { read: true });
}

/**
 * Mark session as unread (called when agent responds)
 */
function markAsUnread(identifier) {
  return updateSessionStatus(identifier, { read: false });
}

/**
 * Set the primary session status (working, waiting, interrupted, idle, terminated)
 * Updates ALL session files matching the tmux session name
 */
function setStatus(identifier, newStatus) {
  const validStatuses = ['working', 'waiting', 'idle', 'terminated', 'interrupted'];
  if (!validStatuses.includes(newStatus)) {
    console.error(`[setStatus] Invalid status: ${newStatus}. Must be one of: ${validStatuses.join(', ')}`);
    return false;
  }

  const updates = { status: newStatus, updatedAt: new Date().toISOString() };

  // For tmux session names, update ALL matching files (not just the first)
  if (!identifier.startsWith('/')) {
    const files = findAllSessionFiles(identifier);
    if (files.length === 0) {
      console.error(`[setStatus] No session files found for: ${identifier}`);
      return false;
    }
    let updated = 0;
    for (const filePath of files) {
      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        Object.assign(content, updates);
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
        console.log(`[setStatus] Updated ${filePath}:`, updates);
        updated++;
      } catch (err) {
        console.error(`[setStatus] Error updating ${filePath}:`, err.message);
      }
    }
    return updated > 0;
  }

  return updateSessionStatus(identifier, updates);
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: node update-session-status.js <session> <action> [value]');
    console.log('');
    console.log('Actions:');
    console.log('  set-status <s>     Set session status (working|waiting|idle|terminated|interrupted)');
    console.log('  watcher-working    Set watcherStatus to "working"');
    console.log('  watcher-done       Set watcherStatus to "done"');
    console.log('  watcher-clear      Remove watcherStatus');
    console.log('  mark-read          Set read to true');
    console.log('  mark-unread        Set read to false');
    console.log('');
    console.log('Examples:');
    console.log('  node update-session-status.js holler-homestead set-status waiting');
    console.log('  node update-session-status.js holler-homestead watcher-working');
    console.log('  node update-session-status.js holler-homestead mark-read');
    process.exit(1);
  }

  const [session, action, ...rest] = args;

  switch (action) {
    case 'set-status': {
      const statusValue = rest[0];
      if (!statusValue) {
        console.error('set-status requires a status value');
        process.exit(1);
      }
      setStatus(session, statusValue);
      break;
    }
    case 'watcher-working':
      setWatcherStatus(session, 'working');
      break;
    case 'watcher-done':
      setWatcherStatus(session, 'done');
      break;
    case 'watcher-clear':
      updateSessionStatus(session, { watcherStatus: null });
      break;
    case 'mark-read':
      markAsRead(session);
      break;
    case 'mark-unread':
      markAsUnread(session);
      break;
    default:
      console.error(`Unknown action: ${action}`);
      process.exit(1);
  }
}

module.exports = {
  updateSessionStatus,
  setWatcherStatus,
  setStatus,
  markAsRead,
  markAsUnread,
  findSessionFile,
  findAllSessionFiles,
  getCwdHash,
};
