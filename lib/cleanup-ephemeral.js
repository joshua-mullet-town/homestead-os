/**
 * Cleanup Stale Ephemeral and Alert Sessions
 *
 * Kills any ephemeral tmux sessions older than 30 minutes.
 * Kills any alert tmux sessions older than 15 minutes.
 * This is a fallback in case the stop hook fails to clean up.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const { emitSessionDeleted } = require('./emit-session-event');
const { cleanupSessionFiles } = require('./cleanup-session-files');

const REGISTRY_FILE = '/tmp/ephemeral-workers.json';
const EPHEMERAL_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes - without Slack timeouts, workers finish in ~1m
const ALERT_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes for alert-*

function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] [EphemeralCleanup] ${message}`);
}

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    }
  } catch (err) {
    log('ERROR', `Failed to load registry: ${err.message}`);
  }
  return { sessions: [] };
}

function saveRegistry(registry) {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (err) {
    log('ERROR', `Failed to save registry: ${err.message}`);
  }
}

function getActiveTmuxSessions() {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name} #{session_created}"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [name, created] = line.split(' ');
      return { name, created: parseInt(created) * 1000 }; // Convert to ms
    });
  } catch (err) {
    // No tmux sessions or tmux not running
    return [];
  }
}

function cleanup() {
  log('INFO', 'Starting ephemeral and alert session cleanup');

  const now = Date.now();
  const activeSessions = getActiveTmuxSessions();
  const registry = loadRegistry();

  log('INFO', `Found ${activeSessions.length} active tmux sessions`);
  log('INFO', `Registry has ${registry.sessions.length} ephemeral sessions`);

  let killedCount = 0;
  let cleanedFromRegistry = 0;

  // Find and clean ephemeral sessions (30 min TTL)
  const ephemeralSessions = activeSessions.filter(s => s.name.startsWith('ephemeral-'));
  for (const session of ephemeralSessions) {
    const age = now - session.created;
    const ageMinutes = Math.round(age / 60000);

    if (age > EPHEMERAL_MAX_AGE_MS) {
      log('INFO', `Killing stale ephemeral session: ${session.name} (age: ${ageMinutes} minutes)`);
      try {
        execSync(`tmux kill-session -t "${session.name}"`, { stdio: 'pipe' });
        emitSessionDeleted(session.name);
        cleanupSessionFiles(session.name);
        killedCount++;
      } catch (err) {
        log('ERROR', `Failed to kill session ${session.name}: ${err.message}`);
      }
    } else {
      log('INFO', `Ephemeral session ${session.name} is ${ageMinutes} minutes old (keeping)`);
    }
  }

  // Find and clean alert sessions (15 min TTL)
  const alertSessions = activeSessions.filter(s => s.name.startsWith('alert-'));
  let alertKilledCount = 0;
  for (const session of alertSessions) {
    const age = now - session.created;
    const ageMinutes = Math.round(age / 60000);

    if (age > ALERT_MAX_AGE_MS) {
      log('INFO', `Killing stale alert session: ${session.name} (age: ${ageMinutes} minutes)`);
      try {
        execSync(`tmux kill-session -t "${session.name}"`, { stdio: 'pipe' });
        emitSessionDeleted(session.name);
        cleanupSessionFiles(session.name);
        killedCount++;
        alertKilledCount++;
      } catch (err) {
        log('ERROR', `Failed to kill session ${session.name}: ${err.message}`);
      }
    } else {
      log('INFO', `Alert session ${session.name} is ${ageMinutes} minutes old (keeping)`);
    }
  }

  // Clean up registry entries for sessions that no longer exist
  const activeNames = activeSessions.map(s => s.name);
  const before = registry.sessions.length;
  registry.sessions = registry.sessions.filter(name => activeNames.includes(name));
  cleanedFromRegistry = before - registry.sessions.length;

  if (cleanedFromRegistry > 0) {
    saveRegistry(registry);
    log('INFO', `Removed ${cleanedFromRegistry} stale entries from registry`);
  }

  log('INFO', `Cleanup complete: killed ${killedCount} sessions (${alertKilledCount} alerts), cleaned ${cleanedFromRegistry} registry entries`);

  return {
    killedSessions: killedCount,
    killedAlertSessions: alertKilledCount,
    cleanedFromRegistry,
    activeEphemeral: ephemeralSessions.length - (killedCount - alertKilledCount),
    activeAlerts: alertSessions.length - alertKilledCount
  };
}

// If run directly
if (require.main === module) {
  const result = cleanup();
  console.log('\nResult:', JSON.stringify(result, null, 2));
}

module.exports = { cleanup };
