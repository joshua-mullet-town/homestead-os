/**
 * Steward File Watcher
 *
 * Watches ~/.homestead/stewards/ for changes and auto-commits.
 *
 * Immediate commits (debounced 5s): STRATEGY.md, CLAUDE.md changes
 * Nightly commits: Handled by the steward-commit recurring job in job-scheduler.js
 *
 * Uses a debounce so rapid edits don't create 50 commits.
 */

const { watch, existsSync } = require('fs');
const { execSync } = require('child_process');
const { join, basename, relative } = require('path');
const os = require('os');
const { acquireStewardsGitLockSync, LockTimeoutError } = require('./stewards-git-lock');

const SISWAPTS_DIR = join(os.homedir(), '.homestead', 'stewards');
const IMMEDIATE_FILES = ['STRATEGY.md', 'CLAUDE.md'];

// Debounce: wait 5s after last change before committing
let commitTimer = null;
const DEBOUNCE_MS = 5000;

// Track what changed for the commit message
let changedFiles = new Set();

/**
 * Check if a file should trigger an immediate commit
 */
function isImmediateFile(filename) {
  return IMMEDIATE_FILES.includes(basename(filename));
}

/**
 * Commit changes in the stewards repo
 */
function commitChanges(message) {
  let release;
  try {
    release = acquireStewardsGitLockSync(SISWAPTS_DIR);
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      console.warn(
        `[StewardWatcher] Lock timeout (held ${e.heldForMs}ms, lock_age=${Math.round(e.lockAgeMs)}ms) — dropping this commit cycle; next file change will retry`
      );
    } else {
      console.error('[StewardWatcher] Could not acquire stewards-git lock:', e.message);
    }
    return;
  }

  try {
    // Stage everything that changed
    execSync('git add -A', { cwd: SISWAPTS_DIR, stdio: 'pipe' });

    // Check if there's actually anything to commit
    const status = execSync('git status --porcelain', { cwd: SISWAPTS_DIR, encoding: 'utf-8' }).trim();
    if (!status) {
      return; // Nothing to commit
    }

    execSync(`git commit -m "${message}"`, { cwd: SISWAPTS_DIR, stdio: 'pipe', env: { ...process.env, HOMESTEAD_AUTOSAVE: '1' } });
    console.log(`[StewardWatcher] Committed: ${message}`);
  } catch (e) {
    // Ignore commit errors (nothing to commit, etc.)
    if (!e.message.includes('nothing to commit')) {
      console.error('[StewardWatcher] Commit error:', e.message);
    }
  } finally {
    try { release(); } catch (_) {}
  }
}

/**
 * Schedule an immediate commit (debounced)
 */
function scheduleCommit() {
  if (commitTimer) clearTimeout(commitTimer);

  commitTimer = setTimeout(() => {
    const files = Array.from(changedFiles);
    changedFiles.clear();

    if (files.length === 0) return;

    // Build a meaningful commit message
    const stewardNames = new Set();
    const fileNames = new Set();
    for (const f of files) {
      const rel = relative(SISWAPTS_DIR, f);
      const parts = rel.split('/');
      if (parts.length >= 2) {
        stewardNames.add(parts[0]);
        fileNames.add(parts[parts.length - 1]);
      } else {
        fileNames.add(parts[0]);
      }
    }

    const who = Array.from(stewardNames).join(', ') || 'root';
    const what = Array.from(fileNames).join(', ');
    commitChanges(`[auto] ${who}: ${what}`);
  }, DEBOUNCE_MS);
}

/**
 * Nightly commit — everything in the repo
 */
function nightlyCommit() {
  commitChanges('[nightly] Full stewards snapshot');
}

/**
 * Start watching
 */
function start() {
  if (!existsSync(SISWAPTS_DIR)) {
    console.log('[StewardWatcher] Stewards directory not found, skipping');
    return;
  }

  // Check it's a git repo
  if (!existsSync(join(SISWAPTS_DIR, '.git'))) {
    console.log('[StewardWatcher] Stewards directory is not a git repo, skipping');
    return;
  }

  // Single recursive watcher. macOS FSEvents handles the whole tree with one
  // handle. The prior approach called fs.watch per directory (~5k watchers
  // for the stewards tree) and exhausted FDs — EMFILE storm starved Next dev's
  // route-compile watchers, causing silent 404s on session-status, mcp-status,
  // host-stats, stewards.
  console.log('[StewardWatcher] Watching (recursive)', SISWAPTS_DIR);
  try {
    watch(SISWAPTS_DIR, { persistent: false, recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Skip excluded paths anywhere in the relative path
      if (filename.startsWith('.git/') || filename === '.git') return;
      if (filename.includes('/.git/') || filename.includes('/.claude/') || filename.includes('/node_modules/')) return;

      const fullPath = join(SISWAPTS_DIR, filename);
      changedFiles.add(fullPath);

      if (isImmediateFile(filename)) {
        console.log(`[StewardWatcher] Immediate file changed: ${filename}`);
        scheduleCommit();
      }
    });
  } catch (e) {
    console.error(`[StewardWatcher] Error starting recursive watcher:`, e.message);
  }
}

/**
 * Manually trigger a commit of all changes (for testing)
 */
function commitAll() {
  commitChanges('[manual] Full stewards snapshot');
}

module.exports = {
  start,
  nightlyCommit,
  commitAll
};
