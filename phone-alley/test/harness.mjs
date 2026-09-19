// Isolated PM2 namespace harness.
//
// Spins up:
//   - An isolated PM2 daemon under PM2_HOME=/tmp/pm2-alley-audit
//   - 3 dummy long-lived processes inside that daemon ("alley-dummy-1/2/3")
//   - A throwaway phone-alley HTTP server child on TEST_PORT (default 3099)
//     whose env carries the isolated PM2_HOME — so all of its pm2 helper
//     calls hit the isolated daemon, NEVER the real fleet.
//
// Exposes a single async setup(): -> { baseUrl, alleyChild, isolatedHome, dummies, teardown }
//
// Teardown:
//   - kills the alley child
//   - pm2 kill (against isolated daemon)
//   - rm -rf the isolated home dir
//   - leaves real PM2 (~/.pm2) untouched

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileP = promisify(execFile);

export const ISOLATED_HOME = process.env.ALLEY_AUDIT_PM2_HOME || '/tmp/pm2-alley-audit';
export const TEST_PORT = Number(process.env.ALLEY_AUDIT_PORT || 3099);
export const DUMMY_NAMES = ['alley-dummy-1', 'alley-dummy-2', 'alley-dummy-3'];

function isolatedEnv() {
  return { ...process.env, PM2_HOME: ISOLATED_HOME };
}

async function isoExec(cmd, args, opts = {}) {
  return execFileP(cmd, args, { env: isolatedEnv(), maxBuffer: 4 * 1024 * 1024, ...opts });
}

export async function pm2List() {
  try {
    const { stdout } = await isoExec('pm2', ['jlist']);
    return JSON.parse(stdout);
  } catch (err) {
    if (err.code === 4 || /no process/i.test(err.stderr || '')) return [];
    throw err;
  }
}

async function killIsolatedDaemon() {
  try {
    await isoExec('pm2', ['kill']);
  } catch {
    // best-effort
  }
}

async function startDummies() {
  // Each dummy is `node -e "setInterval(()=>{}, 60000)"` — a process that
  // does nothing forever. PM2 will give us a real PID we can watch flip.
  for (const name of DUMMY_NAMES) {
    await isoExec('pm2', [
      'start',
      'node',
      '--name',
      name,
      '--',
      '-e',
      'setInterval(() => {}, 60000)',
    ]);
  }
  // Wait for all three to report online with PIDs.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const list = await pm2List();
    const ok = DUMMY_NAMES.every((n) => {
      const p = list.find((x) => x.name === n);
      return p && p.pid && p.pm2_env.status === 'online';
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error('Isolated dummies did not all come online within 8s');
}

async function waitForHttp(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return res;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(`waitForHttp gave up on ${url}: ${lastErr?.message}`);
}

export async function setup() {
  // Fresh isolated home.
  try {
    fs.rmSync(ISOLATED_HOME, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(ISOLATED_HOME, { recursive: true });

  // Make sure no isolated daemon survives from a prior run.
  await killIsolatedDaemon();
  // Restart it so future commands hit the fresh home.
  await isoExec('pm2', ['ping']).catch(() => {});

  // Spawn alley child with isolated PM2_HOME so its pm2 calls hit our daemon.
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const logPath = path.join(os.tmpdir(), `phone-alley-audit-${TEST_PORT}.log`);
  const logFd = fs.openSync(logPath, 'a');
  const alleyChild = spawn(process.execPath, [path.join(repoRoot, 'server.js')], {
    env: { ...isolatedEnv(), PORT: String(TEST_PORT) },
    cwd: repoRoot,
    detached: false,
    stdio: ['ignore', logFd, logFd],
  });

  await waitForHttp(`http://127.0.0.1:${TEST_PORT}/health`);
  await startDummies();
  const dummies = await pm2List();

  return {
    baseUrl: `http://127.0.0.1:${TEST_PORT}`,
    alleyChild,
    isolatedHome: ISOLATED_HOME,
    dummies,
    logPath,
    pm2List,
    isoExec,
    isolatedEnv,
    async teardown() {
      try {
        alleyChild.kill('SIGTERM');
      } catch {}
      await sleep(200);
      try {
        alleyChild.kill('SIGKILL');
      } catch {}
      await killIsolatedDaemon();
      try {
        fs.rmSync(ISOLATED_HOME, { recursive: true, force: true });
      } catch {}
      try {
        fs.closeSync(logFd);
      } catch {}
    },
  };
}
