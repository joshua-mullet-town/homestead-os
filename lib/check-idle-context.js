#!/usr/bin/env node
/**
 * Idle Context Checker
 *
 * Identifies holler-* sessions ripe for /compact.
 * Fast — uses stat() for file sizes, reads only small JSON files.
 *
 * Usage:
 *   node check-idle-context.js          # table output
 *   node check-idle-context.js --json   # JSON output
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STUCK_STATE_FILE = path.join(__dirname, '..', 'data', 'session-stuck-state.json');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const IDLE_THRESHOLD_MIN = 10;
const SIZE_THRESHOLD_MB = 1;

function getHollerSessions() {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.trim().split('\n').filter(n => n.startsWith('holler-'));
  } catch {
    return [];
  }
}

function isClaudeRunning(sessionName) {
  try {
    // Check if there's a Claude process in this tmux session
    const screen = execSync(
      `tmux capture-pane -t "${sessionName}" -p 2>/dev/null | tail -5`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    // If we see a shell prompt, Claude is NOT running
    const isShell = /(\$\s*$|%\s*$|joshuamullet@|❯\s*$)/.test(screen);
    return !isShell;
  } catch {
    return false;
  }
}

function getActivityInfo(sessionName) {
  const actFile = `/tmp/claude-session-${sessionName}-activity.json`;
  try {
    if (fs.existsSync(actFile)) {
      const data = JSON.parse(fs.readFileSync(actFile, 'utf-8'));
      return {
        isWorking: !!data.is_working,
        sessionId: data.session_id || null,
        updatedAt: data.updated_at || null,
      };
    }
  } catch {}
  return { isWorking: false, sessionId: null, updatedAt: null };
}

function getIdleMinutes(sessionName, stuckState) {
  if (!stuckState.sessions || !stuckState.sessions[sessionName]) return 0;
  // matches = consecutive unchanged hash checks; checker runs every ~1 minute
  return stuckState.sessions[sessionName].matches || 0;
}

/**
 * Find the most recent JSONL file for a session.
 * Strategy:
 *   1. If we have the session_id from the activity file, look for that exact file
 *   2. Otherwise scan all project dirs for the newest .jsonl by mtime
 */
function findJsonlFile(sessionId) {
  if (!sessionId) return null;

  // Search all project directories for a file matching this session ID
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(CLAUDE_PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function getFileSizeMB(filePath) {
  if (!filePath) return 0;
  try {
    const stat = fs.statSync(filePath);
    return stat.size / (1024 * 1024);
  } catch {
    return 0;
  }
}

function main() {
  const jsonMode = process.argv.includes('--json');

  // Load stuck state for idle tracking
  let stuckState = { sessions: {} };
  try {
    if (fs.existsSync(STUCK_STATE_FILE)) {
      stuckState = JSON.parse(fs.readFileSync(STUCK_STATE_FILE, 'utf-8'));
    }
  } catch {}

  const sessions = getHollerSessions();
  if (sessions.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ sessions: [], flagged: [] }));
    } else {
      console.log('No holler-* tmux sessions found.');
    }
    return;
  }

  const results = [];

  for (const name of sessions) {
    const claudeRunning = isClaudeRunning(name);
    const activity = getActivityInfo(name);
    const idleMinutes = getIdleMinutes(name, stuckState);
    const jsonlPath = findJsonlFile(activity.sessionId);
    const sizeMB = getFileSizeMB(jsonlPath);

    let recommendation;
    if (!claudeRunning) {
      recommendation = 'spun-down';
    } else if (idleMinutes >= IDLE_THRESHOLD_MIN && sizeMB >= SIZE_THRESHOLD_MB) {
      recommendation = 'compact';
    } else {
      recommendation = 'skip';
    }

    results.push({
      session: name,
      claudeRunning,
      isWorking: activity.isWorking,
      idleMinutes,
      sizeMB: Math.round(sizeMB * 100) / 100,
      jsonlPath: jsonlPath || null,
      recommendation,
    });
  }

  // Sort: compact first, then by size descending
  results.sort((a, b) => {
    const order = { compact: 0, skip: 1, 'spun-down': 2 };
    if (order[a.recommendation] !== order[b.recommendation]) {
      return order[a.recommendation] - order[b.recommendation];
    }
    return b.sizeMB - a.sizeMB;
  });

  const flagged = results.filter(r => r.recommendation === 'compact');

  if (jsonMode) {
    console.log(JSON.stringify({ sessions: results, flagged: flagged.map(f => f.session) }, null, 2));
    return;
  }

  // Table output
  const header = ['Session', 'Idle (min)', 'Size (MB)', 'Status', 'Recommendation'];
  const rows = results.map(r => [
    r.session,
    String(r.idleMinutes),
    r.sizeMB.toFixed(2),
    r.claudeRunning ? (r.isWorking ? 'working' : 'idle') : 'dead',
    r.recommendation,
  ]);

  // Calculate column widths
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  const sep = widths.map(w => '-'.repeat(w)).join('--+-');
  const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  | ');

  console.log();
  console.log(fmt(header));
  console.log(sep);
  rows.forEach(r => console.log(fmt(r)));
  console.log();
  console.log(`Total: ${results.length} sessions | Flagged for compact: ${flagged.length}`);
  if (flagged.length > 0) {
    console.log(`Compact candidates: ${flagged.map(f => f.session).join(', ')}`);
  }
  console.log();
}

main();
