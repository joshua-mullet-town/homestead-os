/**
 * Pre-trust a workspace directory for Claude Code.
 *
 * Claude Code shows a first-run "Is this a project you trust?" gate for any
 * never-before-seen directory. `--dangerously-skip-permissions` does NOT
 * suppress it (verified 2026-08-31), and the highlighted default is "No, exit"
 * — so a spawn into a novel cwd launches, immediately exits, and the pane falls
 * back to raw zsh. The prompt then pastes into a dead pane and never submits.
 *
 * Trust is stored per absolute path at ~/.claude.json .projects[path]
 * .hasTrustDialogAccepted. We seed it before launching.
 *
 * Concurrency: ~/.claude.json is written by EVERY live claude session. macOS
 * ships no flock(1), so we serialize with a portable mkdir(2) mutex, re-read
 * under the lock, and rename(2) a temp file on the same filesystem — the update
 * is atomic and cannot half-write the fleet's config. A stale lock (>60s, from
 * a killed spawn) is reclaimed rather than blocking spawns forever.
 *
 * NON-FATAL BY DESIGN: if anything here fails we warn and return false so the
 * caller still launches. The operator sees the trust prompt rather than losing
 * the spawn outright.
 *
 * Mirrors ~/.homestead/lib/foreman-tools/spawn-substeward.sh pretrust_workspace().
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = path.join(os.homedir(), '.claude.json');
const LOCK = path.join(os.homedir(), '.claude.json.pretrust.lock');
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;

function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      // Reclaim a lock orphaned by a killed spawn.
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(LOCK);
          continue;
        }
      } catch { /* vanished under us; retry */ }
      // Busy-wait: this runs in a spawn path, and Atomics.wait needs a
      // SharedArrayBuffer view; a short spin is simpler and bounded.
      const until = Date.now() + LOCK_POLL_MS;
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false;
}

/**
 * @param {string} target - directory to trust
 * @returns {boolean} true if the path is trusted (already or newly)
 */
function pretrustWorkspace(target) {
  if (!target) return false;
  if (!fs.existsSync(CONFIG)) {
    console.error(`[pretrust] ${CONFIG} absent; skipping pre-trust for ${target}`);
    return false;
  }

  if (!acquireLock()) {
    console.error(`[pretrust] could not lock ${CONFIG} within 10s; skipping for ${target}`);
    return false;
  }

  try {
    const resolved = fs.realpathSync(target);

    let data;
    try {
      data = JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
    } catch (err) {
      console.error(`[pretrust] could not parse ${CONFIG} (${err.message}); skipping`);
      return false;
    }

    if (!data.projects || typeof data.projects !== 'object') {
      console.error(`[pretrust] ${CONFIG} has no projects map; skipping`);
      return false;
    }

    const proj = data.projects[resolved] || (data.projects[resolved] = {});
    if (proj.hasTrustDialogAccepted === true) return true;
    proj.hasTrustDialogAccepted = true;

    // Atomic same-fs rename so a crash can never leave a half-written config.
    const tmp = path.join(path.dirname(CONFIG), `.claude.json.pretrust.${process.pid}.${Date.now()}`);
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(data, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, CONFIG);
      console.log(`[pretrust] trusted ${resolved}`);
      return true;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      console.error(`[pretrust] write failed (${err.message}); launching anyway`);
      return false;
    }
  } catch (err) {
    console.error(`[pretrust] unexpected failure (${err.message}); launching anyway`);
    return false;
  } finally {
    try { fs.rmdirSync(LOCK); } catch { /* already released */ }
  }
}

module.exports = { pretrustWorkspace };
