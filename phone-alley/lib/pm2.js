const { exec } = require('child_process');
const { promisify } = require('util');

const execP = promisify(exec);

const SERVICE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_NAME_LEN = 64;

function validateServiceName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LEN || !SERVICE_NAME_RE.test(name)) {
    const err = new Error(`Invalid PM2 service name: ${JSON.stringify(typeof name === 'string' ? name.slice(0, 64) : name)}`);
    err.code = 'INVALID_SERVICE_NAME';
    throw err;
  }
  return name;
}

async function jlist() {
  const { stdout } = await execP('pm2 jlist', { maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function describe(name) {
  validateServiceName(name);
  const procs = await jlist();
  return procs.find((p) => p.name === name) || null;
}

async function restart(name) {
  validateServiceName(name);
  const before = await describe(name);
  if (!before) {
    const err = new Error(`PM2 service not found: ${name}`);
    err.code = 'SERVICE_NOT_FOUND';
    throw err;
  }
  await execP(`pm2 restart ${name}`);
  return { previous_pid: before.pid, previous_restart_count: before.pm2_env?.restart_time ?? null };
}

async function restartAll() {
  const before = await jlist();
  await execP('pm2 restart all');
  return before.map((p) => ({
    name: p.name,
    previous_pid: p.pid,
    previous_restart_count: p.pm2_env?.restart_time ?? null,
  }));
}

async function waitForOnline(name, { timeoutMs = 10000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const proc = await describe(name);
    last = proc;
    if (proc && proc.pm2_env?.status === 'online' && proc.pid) {
      return proc;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error(`PM2 service did not return to online within ${timeoutMs}ms: ${name}`);
  err.code = 'SERVICE_RESTART_TIMEOUT';
  err.last = last;
  throw err;
}

module.exports = { jlist, describe, restart, restartAll, waitForOnline, validateServiceName };
