/**
 * Shared session directory resolver.
 *
 * Given a tmux session name (e.g. "holler-alfred"), resolves the correct
 * working directory. Used by:
 *   - POST /api/sessions (route.ts)
 *   - job-scheduler.js (steward/steward resurrect)
 *   - server.js TmuxManager.ensureSession()
 *
 * Resolution order:
 *   1. Steward:   ~/.homestead/stewards/{name}
 *   2. Steward:   ~/.homestead/stewards/{name}  (build stewards → codeDir from builder.json)
 *   3. Guest:     ~/.homestead/guest-sessions/{shortName}
 *   4. Worktree:  ~/.worktrees/{project}/{branch}
 *   5. Code dir:  ~/code/{name}
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const HOMESTEAD_DIR = path.join(HOME, '.homestead');

/**
 * Resolve the working directory for a steward.
 * Build stewards have a builder.json with codeDir; utility stewards use their own dir.
 */
function resolveStewardCwd(stewardDir) {
  // 1. Build stewards: builder.json with codeDir
  const builderPath = path.join(stewardDir, 'builder.json');
  if (fs.existsSync(builderPath)) {
    try {
      const builder = JSON.parse(fs.readFileSync(builderPath, 'utf-8'));
      if (builder.codeDir) {
        const resolved = builder.codeDir.replace(/^~/, HOME);
        if (fs.existsSync(resolved)) {
          return resolved;
        }
      }
    } catch {
      // Fall through
    }
  }
  // 2. Any steward (including substewards): cwd field in steward.json
  const stewardJsonPath = path.join(stewardDir, 'steward.json');
  if (fs.existsSync(stewardJsonPath)) {
    try {
      const steward = JSON.parse(fs.readFileSync(stewardJsonPath, 'utf-8'));
      if (steward.cwd) {
        const resolved = steward.cwd.replace(/^~/, HOME);
        if (fs.existsSync(resolved)) {
          return resolved;
        }
      }
    } catch {
      // Fall through
    }
  }
  // 3. Fallback: use the steward directory itself
  return stewardDir;
}

/**
 * Resolve the correct cwd for a session name.
 *
 * @param {string} sessionName - Full tmux session name (e.g. "holler-alfred")
 * @param {object} opts
 * @param {string} opts.codeDir   - Path to ~/code (or configured equivalent)
 * @param {string} opts.worktreesDir - Path to ~/.worktrees
 * @returns {{ path: string, project: string, isWorktree: boolean, isSteward: boolean }}
 */
function resolveSessionDir(sessionName, { codeDir, worktreesDir } = {}) {
  const resolvedCodeDir = codeDir || path.join(HOME, 'code');
  const resolvedWorktreesDir = worktreesDir || path.join(HOME, '.worktrees');

  const nameWithoutPrefix = sessionName.replace('holler-', '');

  // 1. Top-level steward — honor builder.json codeDir + steward.json cwd
  const stewardPath = path.join(HOMESTEAD_DIR, 'stewards', nameWithoutPrefix);
  if (fs.existsSync(stewardPath)) {
    const cwd = resolveStewardCwd(stewardPath);
    return { path: cwd, project: nameWithoutPrefix, isWorktree: false, isSteward: true };
  }

  // 2. Substeward / sub-substeward (holler-{parent}--{sub}--{subsub}--...)
  if (nameWithoutPrefix.includes('--')) {
    const parts = nameWithoutPrefix.split('--');
    // Walk the steward tree: stewards/{parts[0]}/substewards/{parts[1]}/substewards/{parts[2]}/...
    let subPath = path.join(HOMESTEAD_DIR, 'stewards', parts[0]);
    for (let i = 1; i < parts.length; i++) {
      subPath = path.join(subPath, 'substewards', parts[i]);
    }
    if (fs.existsSync(subPath) && fs.existsSync(path.join(subPath, 'steward.json'))) {
      const subCwd = resolveStewardCwd(subPath);
      return { path: subCwd, project: parts.join('/'), isWorktree: false, isSteward: true };
    }
  }

  // 3. Guest session
  if (nameWithoutPrefix.startsWith('guest-')) {
    const guestName = nameWithoutPrefix.replace('guest-', '');
    const guestPath = path.join(HOMESTEAD_DIR, 'guest-sessions', guestName);
    if (fs.existsSync(guestPath)) {
      return { path: guestPath, project: nameWithoutPrefix, isWorktree: false, isSteward: false };
    }
  }

  // 4. Worktree (double-dash format: holler-{project}--{branch})
  if (nameWithoutPrefix.includes('--')) {
    const [project, branch] = nameWithoutPrefix.split('--');
    const worktreePath = path.join(resolvedWorktreesDir, project, branch);
    if (fs.existsSync(worktreePath)) {
      return { path: worktreePath, project, isWorktree: true, isSteward: false };
    }
  }

  // 5. Worktree scan (branch name without project prefix)
  if (fs.existsSync(resolvedWorktreesDir)) {
    try {
      const projectDirs = fs.readdirSync(resolvedWorktreesDir);
      for (const projectDir of projectDirs) {
        const worktreePath = path.join(resolvedWorktreesDir, projectDir, nameWithoutPrefix);
        if (fs.existsSync(worktreePath)) {
          return { path: worktreePath, project: projectDir, isWorktree: true, isSteward: false };
        }
      }
    } catch {
      // ignore
    }
  }

  // 6. Code dir fallback
  const projectPath = path.join(resolvedCodeDir, nameWithoutPrefix);
  return { path: projectPath, project: nameWithoutPrefix, isWorktree: false, isSteward: false };
}

module.exports = { resolveSessionDir, resolveStewardCwd };
