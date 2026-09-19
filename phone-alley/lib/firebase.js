const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execP = promisify(exec);

const SESSION_NAME = 'firebase-login';
const LOG_PATH = path.join(os.tmpdir(), 'firebase-login.log');

async function whichFirebase() {
  try {
    const { stdout } = await execP('command -v firebase');
    const found = stdout.trim();
    return found || null;
  } catch {
    return null;
  }
}

async function sessionExists(name) {
  try {
    await execP(`tmux has-session -t "${name}"`);
    return true;
  } catch {
    return false;
  }
}

async function killSession(name) {
  try {
    await execP(`tmux kill-session -t "${name}"`);
    return true;
  } catch {
    return false;
  }
}

async function launchLogin() {
  const firebasePath = await whichFirebase();
  if (!firebasePath) {
    const err = new Error('firebase CLI not found on PATH');
    err.code = 'FIREBASE_CLI_MISSING';
    throw err;
  }
  if (await sessionExists(SESSION_NAME)) {
    await killSession(SESSION_NAME);
  }
  try {
    fs.unlinkSync(LOG_PATH);
  } catch {
    // best-effort
  }
  const inner =
    `firebase login --interactive 2>&1 | tee ${LOG_PATH}; ` +
    `echo "[phone-alley] firebase exited at $(date)" >> ${LOG_PATH}; ` +
    `sleep 5; ` +
    `tmux kill-session -t ${SESSION_NAME} 2>/dev/null`;
  await execP(`tmux new-session -d -s "${SESSION_NAME}" "${inner.replace(/"/g, '\\"')}"`);
  return { session: SESSION_NAME, log_path: LOG_PATH, firebase_cli: firebasePath };
}

module.exports = { launchLogin, sessionExists, killSession, whichFirebase, SESSION_NAME, LOG_PATH };
