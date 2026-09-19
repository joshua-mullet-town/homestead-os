#!/usr/bin/env node
/**
 * Check Stale Sessions
 *
 * Reads ~/.claude/sessions/*.json, finds any with status "working"
 * and updatedAt > 5 minutes ago. If found, spawns an ephemeral worker
 * to read the actual tmux screens and correct statuses.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function log(msg) {
  console.log(`[check-stale-sessions] ${msg}`);
}

function findStaleSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    log('Sessions directory does not exist');
    return [];
  }

  const now = Date.now();
  const stale = [];

  const files = fs.readdirSync(SESSIONS_DIR);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    try {
      const filePath = path.join(SESSIONS_DIR, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      if (data.status !== 'working') continue;
      if (!data.updatedAt) continue;
      if (!data.tmuxSession) continue;

      const age = now - new Date(data.updatedAt).getTime();
      if (age > STALE_THRESHOLD_MS) {
        stale.push({
          tmuxSession: data.tmuxSession,
          updatedAt: data.updatedAt,
          ageMinutes: Math.round(age / 60000),
        });
      }
    } catch {
      continue;
    }
  }

  return stale;
}

function buildWorkerPrompt(staleSessions) {
  // Deduplicate by tmux session name (multiple session files can share one tmux session)
  const uniqueSessions = new Map();
  for (const s of staleSessions) {
    if (!uniqueSessions.has(s.tmuxSession) || s.ageMinutes > uniqueSessions.get(s.tmuxSession).ageMinutes) {
      uniqueSessions.set(s.tmuxSession, s);
    }
  }

  const sessionList = Array.from(uniqueSessions.values())
    .map(s => `- ${s.tmuxSession} (stale for ${s.ageMinutes} minutes)`)
    .join('\n');

  const updateScript = path.join(__dirname, 'update-session-status.js');

  return `You are a session health checker. The following tmux sessions have been marked as "working" for over 5 minutes and may be stale:

${sessionList}

For each session:
1. Run: tmux capture-pane -t "{session}" -p | tail -10
2. Look at the LAST FEW LINES of the screen output to determine the actual state.

HOW TO DETERMINE STATUS — look at the bottom status bar:

WORKING (actively running, leave alone):
- The bottom bar contains "esc to interrupt"
- There is an active spinner line with a present-tense verb and "..." like: "Prestidigitating..." or "Thinking..."
- There may be a live timer with token count like "(42s · ↓ 669 tokens)"

WAITING (finished, idle at prompt):
- The bottom bar does NOT contain "esc to interrupt"
- There is a PAST-TENSE completion line like: "Worked for 30s" or "Cooked for 53s" or "Churned for 2m 37s"
- Or the prompt just shows the input line with no spinner above it

INTERRUPTED (error/crash):
- Screen shows an error message, stack trace, "interrupted", or "permission denied"
- Or the tmux session exists but Claude is not running (just a shell prompt like $ or %)

3. If the status needs correction, run: node ${updateScript} "{session}" set-status {status}

IMPORTANT: The prompt character (❯ or >) appears in ALL states, so do NOT use it to determine status. Focus on "esc to interrupt" (working) vs past-tense completion verb (waiting).

Only update sessions that need correction. If it's genuinely still working, leave it alone.
After checking all sessions, summarize what you found and what you changed.`;
}

// Main
const staleSessions = findStaleSessions();

if (staleSessions.length === 0) {
  log('No stale sessions found');
  process.exit(0);
}

log(`Found ${staleSessions.length} stale session(s):`);
for (const s of staleSessions) {
  log(`  ${s.tmuxSession} - stale for ${s.ageMinutes} min (last update: ${s.updatedAt})`);
}

// Spawn ephemeral worker
const { spawnWorker } = require('./spawn-worker');
const prompt = buildWorkerPrompt(staleSessions);
const result = spawnWorker(prompt);

if (result.success) {
  log(`Spawned worker: ${result.sessionName}`);
} else {
  log(`Failed to spawn worker: ${result.error}`);
  process.exit(1);
}
