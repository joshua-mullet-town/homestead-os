/**
 * Steward Resolver
 *
 * Scans the steward filesystem, tmux sessions, stewards, and guests
 * to build a map of all valid walkie-talkie targets.
 *
 * Caches the scan for 30 seconds to avoid hammering the filesystem.
 *
 * Usage:
 *   const { resolveTarget, listValidTargets } = require('./steward-resolver');
 *   const result = resolveTarget('holler-rooster');
 *   // { valid: true, sessionName: 'holler-rooster', directory: '...', type: 'steward' }
 *   // EXACT MATCH ONLY — no fuzzy, no partial, no prefix guessing
 */

const { execSync } = require('child_process');
const { existsSync, readFileSync, readdirSync, statSync } = require('fs');
const { join } = require('path');
const os = require('os');

const STEWARDS_DIR = join(os.homedir(), '.homestead', 'stewards');
const SISWAPTS_DIR = join(os.homedir(), '.homestead', 'stewards');
const GUESTS_FILE = join(os.homedir(), '.homestead', 'guests.json');

// Cache
let cachedTargets = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30000;

/**
 * Recursively scan a steward directory for steward.json files.
 * Returns an array of { sessionName, directory, type, description }.
 *
 * Naming convention:
 *   Top-level:      holler-{dirName}
 *   Substeward:     holler-{parent}--{sub}
 *   Sub-sub:        holler-{parent}--{sub}--{subsub}
 */
function scanStewards(dir, prefix, depth) {
  const results = [];

  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const stewardJson = join(entryPath, 'steward.json');
    if (!existsSync(stewardJson)) continue;

    const sessionName = prefix ? `holler-${prefix}--${entry}` : `holler-${entry}`;

    let description = entry;
    try {
      const data = JSON.parse(readFileSync(stewardJson, 'utf-8'));
      description = data.name || entry;
    } catch {}

    results.push({
      sessionName,
      directory: entryPath,
      type: depth === 0 ? 'steward' : 'substeward',
      description,
    });

    // Recurse into substewards/
    const subDir = join(entryPath, 'substewards');
    if (existsSync(subDir)) {
      const subPrefix = prefix ? `${prefix}--${entry}` : entry;
      results.push(...scanStewards(subDir, subPrefix, depth + 1));
    }
  }

  return results;
}

/**
 * Get active tmux sessions that might be worktree/build sessions.
 */
function scanTmuxSessions() {
  const results = [];
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const sessions = output.trim().split('\n').filter(s => s.startsWith('holler-'));

    for (const sessionName of sessions) {
      // Only add if not already in steward results (those are added by scanStewards)
      results.push({
        sessionName,
        directory: null, // tmux session — directory resolved at dispatch time
        type: 'tmux-session',
        description: `Active tmux session: ${sessionName}`,
      });
    }
  } catch {
    // tmux not running or no sessions
  }
  return results;
}

/**
 * Scan steward directories, recursing into substewards.
 */
function scanStewards(dir, prefix, depth) {
  if (!dir) dir = STEWARDS_DIR;
  if (!prefix) prefix = '';
  if (!depth) depth = 0;

  const results = [];
  if (!existsSync(dir)) return results;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      try {
        if (!statSync(entryPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Skip known non-session dirs
      if (entry === 'all' || entry.startsWith('.')) continue;

      // Must have steward.json to be a valid steward
      if (!existsSync(join(entryPath, 'steward.json'))) continue;

      const sessionName = prefix ? `holler-${prefix}--${entry}` : `holler-${entry}`;

      let description = entry;
      try {
        const data = JSON.parse(readFileSync(join(entryPath, 'steward.json'), 'utf-8'));
        description = data.name || entry;
      } catch {}

      results.push({
        sessionName,
        directory: entryPath,
        type: depth === 0 ? 'steward' : 'substeward',
        description,
      });

      // Recurse into substewards/ AND workers/ — the fleet is re-homing
      // conversational workers from substewards/foreman/substewards/ to
      // <parent>/workers/, so a renamed/nested worker won't resolve at all
      // unless we scan workers/ too. Both produce the collapsed shape
      // holler-<parent>--<name> (no --foreman-- segment).
      const childPrefix = prefix ? `${prefix}--${entry}` : entry;
      for (const childDirName of ['substewards', 'workers']) {
        const childDir = join(entryPath, childDirName);
        if (existsSync(childDir)) {
          results.push(...scanStewards(childDir, childPrefix, depth + 1));
        }
      }
    }
  } catch {}

  return results;
}

/**
 * Scan guests.json for guest sessions.
 */
function scanGuests() {
  const results = [];
  if (!existsSync(GUESTS_FILE)) return results;

  try {
    const data = JSON.parse(readFileSync(GUESTS_FILE, 'utf-8'));
    const guests = data.guests || [];

    for (const guest of guests) {
      if (!guest.enabled) continue;

      // Shared session
      if (guest.sharedSession?.sessionName) {
        results.push({
          sessionName: guest.sharedSession.sessionName,
          directory: guest.sharedSession.sessionDir || null,
          type: 'guest',
          description: `Guest: ${guest.name || guest.shortName}`,
        });
      }

      // Personal sessions
      for (const ps of (guest.personalSessions || [])) {
        if (ps.sessionName) {
          results.push({
            sessionName: ps.sessionName,
            directory: ps.sessionDir || null,
            type: 'guest-personal',
            description: `Guest personal: ${guest.name || guest.shortName} / ${ps.name}`,
          });
        }
      }
    }
  } catch {}

  return results;
}

/**
 * Build the full list of valid targets, using cache if fresh.
 */
function buildTargetList() {
  const now = Date.now();
  if (cachedTargets && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedTargets;
  }

  // Collect from all sources
  const stewards = scanStewards(STEWARDS_DIR, '', 0);
  const tmuxSessions = scanTmuxSessions();
  const guests = scanGuests();

  // Deduplicate by sessionName, preferring steward > tmux > guest
  const byName = new Map();
  const priority = { steward: 0, substeward: 1, guest: 2, 'guest-personal': 3, 'tmux-session': 4 };

  for (const list of [stewards, guests, tmuxSessions]) {
    for (const item of list) {
      const existing = byName.get(item.sessionName);
      if (!existing || (priority[item.type] || 99) < (priority[existing.type] || 99)) {
        byName.set(item.sessionName, item);
      }
    }
  }

  cachedTargets = Array.from(byName.values());
  cacheTimestamp = now;
  return cachedTargets;
}

/**
 * Resolve a target string to a valid session.
 *
 * Accepts:
 *   "holler-rooster"            → exact match
 *   "rooster"                   → holler-rooster
 *   "venture--marketing"        → holler-venture--marketing
 *   "holler-venture--marketing" → exact match
 *
 * Returns:
 *   { valid: true, sessionName, directory, type } or
 *   { valid: false, error, validTargets: [...] }
 */
function resolveTarget(targetString) {
  const targets = buildTargetList();
  const targetMap = new Map(targets.map(t => [t.sessionName, t]));

  // Exact match ONLY — no fuzzy, no partial, no prefix guessing
  if (targetMap.has(targetString)) {
    const t = targetMap.get(targetString);
    return { valid: true, sessionName: t.sessionName, directory: t.directory, type: t.type };
  }

  // Dual-read the --foreman-- shape. Conversational-worker cutover renames a
  // session from holler-X--foreman--Y to holler-X--Y. A Josh card stored the
  // OLD name as its callback_session literal; after rename that literal no
  // longer matches. Collapse any --foreman-- segment(s) and re-try so BOTH the
  // pre-rename (--foreman--) and post-rename (collapsed) names resolve to
  // whichever session actually exists. Shape-agnostic, additive: only fires
  // when the literal exact match already failed, so non-renamed targets are
  // untouched.
  if (targetString.includes('--foreman--')) {
    const collapsed = targetString.split('--foreman--').join('--');
    if (collapsed !== targetString && targetMap.has(collapsed)) {
      const t = targetMap.get(collapsed);
      return { valid: true, sessionName: t.sessionName, directory: t.directory, type: t.type };
    }
  }

  // No match — fail with the full list of valid targets
  const suggestions = targets
    .map(t => ({ name: t.sessionName, description: t.description }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    valid: false,
    error: `Unknown target "${targetString}". No matching steward, steward, guest, or active tmux session found.`,
    validTargets: suggestions,
  };
}

/**
 * List all valid targets.
 */
function listValidTargets() {
  return buildTargetList().map(t => ({
    sessionName: t.sessionName,
    directory: t.directory,
    type: t.type,
    description: t.description,
  }));
}

/**
 * Clear the cache (useful for testing or after structural changes).
 */
function clearCache() {
  cachedTargets = null;
  cacheTimestamp = 0;
}

module.exports = { resolveTarget, listValidTargets, clearCache };
