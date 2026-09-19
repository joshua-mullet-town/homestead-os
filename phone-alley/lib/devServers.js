const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execP = promisify(exec);

const CODE_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code';

const REGISTRY = [
  { project: 'covered-bridge', name: 'Covered Bridge', port: 3002 },
  { project: 'homestead', name: 'Homestead', port: 3005 },
];

const PROJECT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_NAME_LEN = 64;

function getEntry(project) {
  if (typeof project !== 'string' || project.length === 0 || project.length > MAX_NAME_LEN || !PROJECT_NAME_RE.test(project)) {
    const err = new Error(`Invalid project name: ${JSON.stringify(typeof project === 'string' ? project.slice(0, 64) : project)}`);
    err.code = 'INVALID_PROJECT_NAME';
    throw err;
  }
  const entry = REGISTRY.find((e) => e.project === project);
  if (!entry) {
    const err = new Error(`Unknown dev-server project: ${project}`);
    err.code = 'UNKNOWN_PROJECT';
    throw err;
  }
  return entry;
}

async function portInUse(port) {
  try {
    const { stdout } = await execP(`lsof -ti :${port} -sTCP:LISTEN`);
    const pids = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return { listening: pids.length > 0, pids };
  } catch (err) {
    if (err.code === 1) {
      return { listening: false, pids: [] };
    }
    throw err;
  }
}

async function list() {
  return Promise.all(
    REGISTRY.map(async (entry) => {
      const { listening, pids } = await portInUse(entry.port);
      return { ...entry, running: listening, pids };
    })
  );
}

async function start(project) {
  const entry = getEntry(project);
  const projectDir = path.join(CODE_DIR, entry.project);
  if (!fs.existsSync(projectDir)) {
    const err = new Error(`Project directory not found: ${projectDir}`);
    err.code = 'PROJECT_DIR_MISSING';
    throw err;
  }
  const before = await portInUse(entry.port);
  if (before.listening) {
    return { entry, already_running: true, pid: before.pids[0] };
  }
  const child = spawn('npm', ['run', 'dev'], {
    cwd: projectDir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  return { entry, already_running: false, spawned_pid: child.pid };
}

async function stop(project) {
  const entry = getEntry(project);
  const before = await portInUse(entry.port);
  if (!before.listening) {
    return { entry, was_running: false, killed_pids: [] };
  }
  const killed = [];
  for (const pid of before.pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
      killed.push(pid);
    } catch (err) {
      // Process may have died between lsof and now.
    }
  }
  return { entry, was_running: true, killed_pids: killed };
}

async function waitForPort(port, expected, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { listening } = await portInUse(port);
    if (listening === expected) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

module.exports = { list, start, stop, portInUse, waitForPort, getEntry, REGISTRY };
