/**
 * Ephemeral Claude Worker Spawner
 *
 * Spawns a Claude Code instance in a tmux session, sends it a prompt,
 * and registers it for automatic cleanup when done.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveClaudePath } = require('./claude-resolver');
const { emitSessionCreated, emitSessionDeleted } = require('./emit-session-event');
const { cleanupSessionFiles } = require('./cleanup-session-files');
const { pretrustWorkspace } = require('./pretrust-workspace');

const REGISTRY_FILE = '/tmp/ephemeral-workers.json';
const LOG_DIR = '/tmp/ephemeral-worker-logs';
// Derive HOMESTEAD_DIR from this file's location (lib/ is one level down)
const HOMESTEAD_DIR = path.resolve(__dirname, '..');
// Ephemeral workers run here to avoid polluting code project session history
const EPHEMERAL_CWD = path.join(require('os').homedir(), '.homestead', 'ephemeral-workers');

/**
 * Load the ephemeral workers registry
 */
function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[SpawnWorker] Error loading registry:', err.message);
  }
  return { sessions: [] };
}

/**
 * Save the ephemeral workers registry
 */
function saveRegistry(registry) {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (err) {
    console.error('[SpawnWorker] Error saving registry:', err.message);
  }
}

/**
 * Log a message to both console and log file
 */
function log(sessionName, message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(`[${sessionName}] ${message}`);

  // Ensure log directory exists
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const logFile = path.join(LOG_DIR, `${sessionName}.log`);
  fs.appendFileSync(logFile, logMessage + '\n');
}

/**
 * Spawn an ephemeral Claude worker
 *
 * @param {string} prompt - The task to give Claude
 * @param {object} options - Optional configuration
 * @param {string} options.cwd - Working directory (defaults to homestead)
 * @returns {object} - { sessionName, success, error? }
 */
function spawnWorker(prompt, options = {}) {
  const cwd = options.cwd || EPHEMERAL_CWD;
  const sessionName = `ephemeral-${Date.now()}`;

  log(sessionName, `Starting ephemeral worker`);
  log(sessionName, `Working directory: ${cwd}`);
  log(sessionName, `Prompt: ${prompt}`);

  try {
    // 0. Pre-trust the cwd. Claude Code gates any never-before-seen directory
    // behind "Is this a project you trust?", which --dangerously-skip-permissions
    // does NOT suppress; the default is "No, exit", so the spawn dies on launch
    // and the prompt below pastes into a dead pane. `cwd` is caller-supplied
    // (spawn-turn-watcher passes a per-session project dir), so it is routinely
    // a path Claude has never seen. Non-fatal: on failure we still launch.
    log(sessionName, `Pre-trusting workspace: ${cwd}`);
    pretrustWorkspace(cwd);

    // 1. Create tmux session
    log(sessionName, 'Creating tmux session...');
    execSync(`tmux new-session -d -s ${sessionName} -c "${cwd}"`, { stdio: 'pipe' });
    emitSessionCreated(sessionName);

    // 2. Register in ephemeral workers list
    log(sessionName, 'Registering in ephemeral workers registry...');
    const registry = loadRegistry();
    registry.sessions.push(sessionName);
    saveRegistry(registry);

    // 3. Write prompt to file for Claude to read
    log(sessionName, 'Writing prompt file...');
    const promptFile = `/tmp/${sessionName}-prompt.txt`;
    fs.writeFileSync(promptFile, prompt);

    // 4. Start Claude Code with initial prompt to read the file
    // This bootstraps the session by telling Claude to read its full instructions
    // Must unset CLAUDECODE env var to avoid nested session detection
    // Must set EPHEMERAL_WORKER=1 so hooks know not to write to conversation files
    log(sessionName, 'Starting Claude Code...');
    const bootstrapPrompt = `Read ${promptFile} and follow those instructions exactly.`;
    // Escape for shell
    const escapedBootstrap = bootstrapPrompt.replace(/'/g, "'\\''");
    // Interpolate the ABSOLUTE resolved claude path — a bare `claude` token here
    // is re-resolved by the spawned shell via PATH, which grabs the stale
    // /opt/homebrew build under the launchd env → 404. See lib/claude-resolver.js.
    const claudeBin = resolveClaudePath();
    execSync(`tmux send-keys -t ${sessionName} 'CLAUDECODE= EPHEMERAL_WORKER=1 ${claudeBin} --dangerously-skip-permissions --add-dir "${HOMESTEAD_DIR}" "${escapedBootstrap}"' Enter`, { stdio: 'pipe' });

    log(sessionName, 'Worker spawned successfully, Claude is working...');

    return {
      sessionName,
      success: true,
      logFile: path.join(LOG_DIR, `${sessionName}.log`)
    };

  } catch (err) {
    log(sessionName, `ERROR: ${err.message}`);

    // Try to clean up if we failed partway through
    try {
      execSync(`tmux kill-session -t ${sessionName} 2>/dev/null || true`, { stdio: 'pipe' });
      emitSessionDeleted(sessionName);
      cleanupSessionFiles(sessionName);
      const registry = loadRegistry();
      registry.sessions = registry.sessions.filter(s => s !== sessionName);
      saveRegistry(registry);
    } catch (cleanupErr) {
      log(sessionName, `Cleanup error: ${cleanupErr.message}`);
    }

    return {
      sessionName,
      success: false,
      error: err.message,
      logFile: path.join(LOG_DIR, `${sessionName}.log`)
    };
  }
}

/**
 * Check if a session is in the ephemeral registry
 */
function isEphemeralSession(sessionName) {
  const registry = loadRegistry();
  return registry.sessions.includes(sessionName);
}

/**
 * Remove a session from the registry (called by stop hook)
 */
function removeFromRegistry(sessionName) {
  const registry = loadRegistry();
  const before = registry.sessions.length;
  registry.sessions = registry.sessions.filter(s => s !== sessionName);
  saveRegistry(registry);
  return registry.sessions.length < before;
}

/**
 * List all registered ephemeral sessions
 */
function listEphemeralSessions() {
  return loadRegistry().sessions;
}

// If run directly from command line
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node spawn-worker.js "<prompt>"');
    console.log('');
    console.log('Example:');
    console.log('  node spawn-worker.js "Read /tmp/test-input.txt and write a summary to /tmp/test-output.txt"');
    process.exit(1);
  }

  const prompt = args.join(' ');
  const result = spawnWorker(prompt);

  console.log('');
  console.log('Result:', JSON.stringify(result, null, 2));
}

module.exports = {
  spawnWorker,
  isEphemeralSession,
  removeFromRegistry,
  listEphemeralSessions,
  loadRegistry,
  REGISTRY_FILE
};
