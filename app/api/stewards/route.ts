import { NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { readdirSync, readFileSync, statSync } from 'fs';

const STEWARDS_DIR = join(homedir(), '.homestead', 'stewards');

/**
 * The newest mtime across a worker's OWN top-level files, as an ISO string
 * (null if unreadable). Used as the last-resort "when did this one go quiet"
 * for a worker whose tmux session no longer exists, so its status badge shows
 * a real per-worker number instead of a dash.
 *
 * Deliberately NOT a recursive walk: a worker dir can contain a whole checkout
 * (one here holds a Python venv), and this runs for every worker on a cached
 * 1s endpoint. Top-level files are enough — steward.json, CLAUDE.md and
 * HANDOFF.md are what actually get touched as a worker works.
 */
function newestOwnFileMtime(dir: string): string | null {
  try {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const m = statSync(join(dir, entry.name)).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        // skip unreadable entry
      }
    }
    return newest > 0 ? new Date(newest).toISOString() : null;
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = 1000;
let cache: { data: { stewards: any[] }; expiresAt: number } | null = null;

interface SessionInfo {
  name: string;
  status: 'working' | 'waiting' | 'active'; // working/waiting from activity file, active = tmux exists but no activity file
  currentTool?: string;
  lastActivity?: string;
}

/**
 * Get all active tmux sessions as a Map of name -> createdAt ISO string.
 * Creation time comes from tmux's session_created (unix seconds).
 */
async function getActiveTmuxSessions(): Promise<Map<string, string>> {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name} #{session_created}" 2>/dev/null');
    const map = new Map<string, string>();
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, createdSec] = line.split(' ');
      const createdAt = createdSec ? new Date(parseInt(createdSec, 10) * 1000).toISOString() : new Date().toISOString();
      map.set(name, createdAt);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Read activity files from /tmp to get session working/waiting status
 */
function getSessionStatuses(): Map<string, { status: 'working' | 'waiting'; currentTool?: string; lastActivity?: string }> {
  const statuses = new Map();
  try {
    const files = readdirSync('/tmp').filter(f => f.startsWith('claude-session-') && f.endsWith('-activity.json'));
    for (const file of files) {
      try {
        const content = readFileSync(join('/tmp', file), 'utf-8');
        const data = JSON.parse(content);
        const sessionName = data.tmux_session;
        if (!sessionName) continue;

        const activities = data.activities || [];
        const lastAct = activities.length > 0 ? activities[activities.length - 1] : null;

        statuses.set(sessionName, {
          status: data.is_working ? 'working' : 'waiting',
          currentTool: data.current_tool || undefined,
          lastActivity: lastAct?.message || undefined,
        });
      } catch { /* skip bad files */ }
    }
  } catch { /* /tmp read failed */ }
  return statuses;
}

/**
 * Build session info for a steward given its tmux session name
 */
function buildSessionInfo(
  sessionName: string,
  tmuxSessions: Map<string, string>,
  activityStatuses: Map<string, { status: 'working' | 'waiting'; currentTool?: string; lastActivity?: string }>
): SessionInfo | null {
  if (!tmuxSessions.has(sessionName)) return null;

  const activity = activityStatuses.get(sessionName);
  return {
    name: sessionName,
    status: activity?.status || 'active',
    currentTool: activity?.currentTool,
    lastActivity: activity?.lastActivity,
  };
}

/**
 * Scan a parent's child-worker directories.
 *
 * DUAL-READ (worker-rehome transition — BUILD-CHARTER-worker-tree-presenter):
 * the canonical spawn tool is moving worker dirs from `<parent>/substewards/`
 * to `<parent>/workers/`, and the intermediate `foreman` layer is being
 * dropped. During the fleet-wide cutover BOTH layouts coexist — a Steading
 * whose live crew still sits in `substewards/` must NOT vanish the moment the
 * spawn tool starts writing to `workers/`. So we recurse BOTH subdir names and
 * merge their children. Retire the `substewards/` scan only once every Steading
 * is on `workers/`.
 *
 * `sessionPrefix` is the parent's session name. A child files its session as
 * `${sessionPrefix}--${id}`; because the new spawn tool drops the `foreman`
 * layer, a top-level worker under a Steading resolves to
 * `holler-<steading>--<name>` and a nested sub-worker to
 * `holler-<steading>--<parent>--<child>` — the same recursive shape either way.
 */
async function scanSubstewards(
  parentDir: string,
  parentId: string,
  sessionPrefix: string,
  tmuxSessions: Map<string, string>,
  activityStatuses: Map<string, { status: 'working' | 'waiting'; currentTool?: string; lastActivity?: string }>,
  registeredSessions: Set<string>
): Promise<any[]> {
  const workers: any[] = [];
  const seen = new Set<string>(); // dedupe by id if a name somehow exists in both dirs

  // DUAL-READ: legacy `substewards/` first, then new `workers/`. workers/ wins
  // on collision (it's the canonical post-cutover location).
  for (const subdirName of ['substewards', 'workers']) {
    const childrenDir = join(parentDir, subdirName);
    if (!existsSync(childrenDir)) continue;

    let entries;
    try {
      entries = await readdir(childrenDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = join(childrenDir, entry.name);
      const jsonPath = join(subDir, 'steward.json');
      if (!existsSync(jsonPath)) continue;
      try {
        const data = JSON.parse(await readFile(jsonPath, 'utf-8'));
        // Retired workers are dead crew — never render them as a live line.
        if (data.role === 'retired') continue;
        const subSessionName = `${sessionPrefix}--${entry.name}`;
        registeredSessions.add(subSessionName);

        // If workers/ redefines an id already read from substewards/, replace it.
        if (seen.has(entry.name)) {
          const idx = workers.findIndex((w) => w.id === entry.name);
          if (idx !== -1) workers.splice(idx, 1);
        }
        seen.add(entry.name);

        const sub: any = {
          id: entry.name,
          parentId,
          sessionName: subSessionName,
          name: data.name,
          // Post-cutover default is 'worker'; legacy dirs may still say
          // 'substeward'. Echo whatever's on disk, defaulting to 'worker'.
          type: data.type || 'worker',
          shorthand: data.shorthand,
          // Worker-self-assigned emoji is the new canonical glyph; icon is the
          // legacy fallback. Renderer resolves emoji || icon || '🔹'.
          emoji: data.emoji || null,
          icon: data.icon || null,
          color: data.color,
          domain: data.domain || null,
          stewInt: data.stewInt || null,
          // LAST-SEEN FLOOR (Josh 2026-09-19: "even if the steward is asleep,
          // it should just tell us like when it was put to sleep").
          // /api/session-status only knows about LIVE tmux sessions, so a
          // worker whose session is gone has no status time at all and its
          // badge rendered a dash. Its own directory still carries a real,
          // per-worker instant — the newest mtime across its own files. That
          // is a measured fact, not a fabricated stamp, and it is the closest
          // honest answer to "when did this one go quiet".
          lastSeenAt: newestOwnFileMtime(subDir),
        };

        // Session status
        const session = buildSessionInfo(subSessionName, tmuxSessions, activityStatuses);
        if (session) sub.session = session;

        // Recurse — a worker's own children may nest under EITHER subdir too.
        const children = await scanSubstewards(subDir, entry.name, subSessionName, tmuxSessions, activityStatuses, registeredSessions);
        if (children.length > 0) {
          // Emit under both keys: `workers` is canonical, `substewards` is the
          // back-compat alias the existing renderer still reads. Same array ref.
          sub.workers = children;
          sub.substewards = children;
        }
        workers.push(sub);
      } catch {
        // Skip invalid worker
      }
    }
  }

  return workers;
}

/**
 * Synthesize a substeward node for a tmux session that has no steward.json
 * on disk. Tmux sessions named `{parent}--{id}` are treated as sub-stewards
 * of that parent regardless of whether they're persisted — the session IS
 * the sub-steward.
 *
 * Returned shape matches the registered-substeward shape exactly so the UI
 * renders them identically (no special classes, no separate code path).
 */
function synthesizeSubsteward(
  id: string,
  parentId: string,
  sessionName: string,
  tmuxSessions: Map<string, string>,
  activityStatuses: Map<string, { status: 'working' | 'waiting'; currentTool?: string; lastActivity?: string }>
): any {
  const sub: any = {
    id,
    parentId,
    sessionName,
    name: id,
    type: 'worker',
    shorthand: null,
    emoji: null,
    icon: null,
    color: null,
    domain: null,
    stewInt: null,
  };
  const session = buildSessionInfo(sessionName, tmuxSessions, activityStatuses);
  if (session) sub.session = session;
  return sub;
}

/**
 * Walk the tree and append any unregistered tmux sessions whose name starts
 * with `{node.sessionName}--` as synthesized sub-stewards. Runs recursively
 * so newly-synthesized nodes can themselves have children attached.
 *
 * Must run AFTER the full on-disk scan so registeredSessions is complete.
 */
function attachSyntheticSubstewards(
  node: { sessionName: string; substewards?: any[]; workers?: any[] },
  tmuxSessions: Map<string, string>,
  activityStatuses: Map<string, { status: 'working' | 'waiting'; currentTool?: string; lastActivity?: string }>,
  registeredSessions: Set<string>
): void {
  const prefix = `${node.sessionName}--`;
  for (const sessionName of tmuxSessions.keys()) {
    if (!sessionName.startsWith(prefix)) continue;
    if (registeredSessions.has(sessionName)) continue;
    const suffix = sessionName.slice(prefix.length);
    // Direct children only — grandchildren get picked up via recursion through
    // their own parent node.
    if (suffix.includes('--')) continue;

    const synth = synthesizeSubsteward(suffix, node.sessionName.replace(/^holler-/, ''), sessionName, tmuxSessions, activityStatuses);
    if (!node.workers) node.workers = [];
    node.workers.push(synth);
    // Keep the back-compat alias pointing at the same array so the existing
    // renderer (reads `substewards`) sees synthesized workers too.
    node.substewards = node.workers;
    registeredSessions.add(sessionName);
  }

  const children = node.workers || node.substewards;
  if (children) {
    for (const child of children) {
      attachSyntheticSubstewards(child, tmuxSessions, activityStatuses, registeredSessions);
    }
  }
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.data);
  }

  if (!existsSync(STEWARDS_DIR)) {
    const empty = { stewards: [] };
    cache = { data: empty, expiresAt: now + CACHE_TTL_MS };
    return NextResponse.json(empty);
  }

  // Gather session data upfront (once, not per-steward)
  const tmuxSessions = await getActiveTmuxSessions();
  const activityStatuses = getSessionStatuses();
  // Sessions that correspond to real on-disk stewards. Anything in tmux
  // matching a parent prefix but NOT in this set is an ephemeral worker.
  const registeredSessions = new Set<string>();

  try {
    const entries = await readdir(STEWARDS_DIR, { withFileTypes: true });
    const stewards: any[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dir = join(STEWARDS_DIR, entry.name);
      const stewardJsonPath = join(dir, 'steward.json');

      if (!existsSync(stewardJsonPath)) continue;

      try {
        const stewardData = JSON.parse(await readFile(stewardJsonPath, 'utf-8'));
        // Retired stewards are dead crew — never render them as a live line.
        if (stewardData.role === 'retired') continue;
        const sessionName = `holler-${entry.name}`;
        registeredSessions.add(sessionName);

        const steward: any = {
          id: entry.name,
          sessionName,
          name: stewardData.name,
          type: stewardData.type,
          shorthand: stewardData.shorthand,
          emoji: stewardData.emoji || null,
          icon: stewardData.icon || null,
          color: stewardData.color,
          stewInt: stewardData.stewInt || null,
          defaultTab: stewardData.defaultTab || null,
        };

        // Session status
        const session = buildSessionInfo(sessionName, tmuxSessions, activityStatuses);
        if (session) steward.session = session;

        // Check builder.json first (canonical), then build-data.json (legacy)
        const builderPath = join(dir, 'builder.json');
        const buildDataPath = join(dir, 'build-data.json');
        const buildFile = existsSync(builderPath) ? builderPath : existsSync(buildDataPath) ? buildDataPath : null;
        if (buildFile) {
          try {
            steward.buildData = JSON.parse(await readFile(buildFile, 'utf-8'));
          } catch {
            // Skip invalid build data
          }
        }

        // Discover workers (recursive, dual-read substewards/ + workers/) —
        // pass session prefix for name building. Emit under both keys: `workers`
        // is canonical, `substewards` is the back-compat alias (same array ref).
        const workers = await scanSubstewards(dir, entry.name, sessionName, tmuxSessions, activityStatuses, registeredSessions);
        if (workers.length > 0) {
          steward.workers = workers;
          steward.substewards = workers;
        }

        stewards.push(steward);
      } catch {
        // Skip stewards with invalid steward.json
      }
    }

    // Second pass: synthesize unregistered tmux sessions (e.g. Foreman-spawned
    // sub-sub-stewards that don't have steward.json yet) into the substewards
    // tree. They render identically to on-disk sub-stewards.
    for (const steward of stewards) {
      attachSyntheticSubstewards(steward, tmuxSessions, activityStatuses, registeredSessions);
    }

    const payload = { stewards };
    cache = { data: payload, expiresAt: Date.now() + CACHE_TTL_MS };
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ stewards: [] });
  }
}
