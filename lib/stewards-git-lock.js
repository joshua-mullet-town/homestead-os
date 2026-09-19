/**
 * Shared stewards-git lock helper.
 *
 * Three writers race on `git add/commit/push` against ~/.homestead/stewards/:
 *   - lib/steward-watcher.js (debounced file-change commits)
 *   - lib/job-scheduler.js executeStewardCommit (hourly snapshot)
 *   - dotfiles auto_save.py auto_commit (5-min cycle)
 *
 * proper-lockfile's primitive is an atomic mkdir of the lockfile path; the
 * Python side reproduces the same mkdir/rmdir protocol so the three writers
 * serialize across process and language boundaries.
 *
 * lockSync does not support the retries option ("Cannot use retries with the
 * sync api"); we hand-roll a busy-wait retry with Atomics.wait so we yield
 * the CPU instead of spinning on Date.now. 100ms polling with a 30s ceiling
 * matches the Python side.
 *
 * On timeout, callers get a LockTimeoutError carrying contextual fields
 * (held_for_ms, lock_age_ms) so log triage doesn't need to grep for "Lock
 * file is already being held" specifically. Both callers (steward-watcher,
 * job-scheduler) already catch + soft-fail, dropping the write cycle and
 * retrying on the next tick; that posture is preserved.
 */

const fs = require('fs');
const lockfile = require('proper-lockfile');

const STEWARDS_GIT_LOCK_PATH = '/tmp/homestead-stewards-git.lock';
const STEWARDS_GIT_LOCK_OPTS = {
  lockfilePath: STEWARDS_GIT_LOCK_PATH,
  realpath: false,
  stale: 60000,
};
const STEWARDS_GIT_LOCK_RETRY_MS = 100;
const STEWARDS_GIT_LOCK_TIMEOUT_MS = 30000;

const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function syncSleepMs(ms) { Atomics.wait(_sleepBuf, 0, 0, ms); }

class LockTimeoutError extends Error {
  constructor(message, { startedAt, lockAgeMs, lastErr } = {}) {
    super(message);
    this.name = 'LockTimeoutError';
    this.code = 'STEWARDS_GIT_LOCK_TIMEOUT';
    this.startedAt = startedAt;
    this.heldForMs = Date.now() - startedAt;
    this.lockAgeMs = lockAgeMs;
    this.cause = lastErr;
  }
}

function readLockAgeMs() {
  try {
    return Date.now() - fs.statSync(STEWARDS_GIT_LOCK_PATH).mtimeMs;
  } catch {
    return null;
  }
}

function acquireStewardsGitLockSync(targetPath) {
  const startedAt = Date.now();
  const deadline = startedAt + STEWARDS_GIT_LOCK_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return lockfile.lockSync(targetPath, STEWARDS_GIT_LOCK_OPTS);
    } catch (e) {
      lastErr = e;
      syncSleepMs(STEWARDS_GIT_LOCK_RETRY_MS);
    }
  }
  const lockAgeMs = readLockAgeMs();
  throw new LockTimeoutError(
    `stewards-git lock timeout after ${STEWARDS_GIT_LOCK_TIMEOUT_MS}ms (lock_age=${lockAgeMs}ms; last_err=${lastErr?.message || 'none'})`,
    { startedAt, lockAgeMs, lastErr }
  );
}

module.exports = {
  acquireStewardsGitLockSync,
  LockTimeoutError,
  STEWARDS_GIT_LOCK_PATH,
  STEWARDS_GIT_LOCK_TIMEOUT_MS,
};
