/**
 * claude-resolver.js — robust claude-binary resolution for spawn/wake tooling.
 *
 * THE BUG THIS FIXES: two claude binaries exist on this machine —
 *   /opt/homebrew/bin/claude = 1.0.65 (STALE — its "opus" alias hardcodes the
 *     retired model claude-opus-4-20250514 → every inference 404s → session wedges)
 *   ~/.local/bin/claude = 2.1.195 (CURRENT)
 * Spawn/wake tooling used `which claude` (PATH-order). Under the launchd/dispatcher
 * env, /opt/homebrew/bin PRECEDES ~/.local/bin → grabs the STALE binary. Interactive
 * shells have ~/.local/bin first, so it looks fine interactively (that's the trap).
 *
 * THE FIX: don't trust PATH-order. Enumerate candidate paths, run `--version` on
 * each, and pick the highest semver. Survives future path shuffles and a future
 * where ~/.local/bin goes stale instead. Cost is a few `--version` calls (~ms) at
 * spawn time — negligible relative to launching a whole claude session.
 */
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');
const os = require('os');

// Candidate binaries in preference order (order only matters as a tiebreak;
// version wins). ~/.local/bin/claude first because it's the known-current path.
function candidatePaths() {
  const home = os.homedir();
  const paths = [
    join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  // Whatever the current PATH resolves to (interactive spawns, novel installs).
  try {
    const w = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (w) paths.push(w);
  } catch {}
  // De-dupe, keep only existing files, preserve order.
  const seen = new Set();
  return paths.filter(p => {
    if (!p || seen.has(p) || !existsSync(p)) return false;
    seen.add(p);
    return true;
  });
}

// Parse "2.1.195 (Claude Code)" → [2, 1, 195]. Returns null if unparseable.
function parseVersion(bin) {
  try {
    const out = execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 10000 }).trim();
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  } catch {
    return null;
  }
}

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Resolve the newest-version claude binary path. Falls back to ~/.local/bin/claude
 * (the known-current install) if version probing turns up nothing usable.
 */
function resolveClaudePath() {
  const home = os.homedir();
  const localBin = join(home, '.local', 'bin', 'claude');
  const candidates = candidatePaths();

  let best = null;
  let bestVer = null;
  for (const bin of candidates) {
    const ver = parseVersion(bin);
    if (!ver) continue;
    if (!bestVer || cmpSemver(ver, bestVer) > 0) {
      best = bin;
      bestVer = ver;
    }
  }

  if (best) return best;

  // No candidate reported a version. Prefer the known-current install if present,
  // else whatever `which` finds, else the local path as a last resort.
  if (existsSync(localBin)) return localBin;
  try {
    const w = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (w) return w;
  } catch {}
  return localBin;
}

module.exports = { resolveClaudePath };
