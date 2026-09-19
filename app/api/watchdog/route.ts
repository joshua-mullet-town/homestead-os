import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// DUAL-READ (worker re-home): the watchdog re-homes from
// rooster/substewards/foreman/substewards/watchdog → rooster/substewards/watchdog.
// Resolve the NEW re-homed dir if it exists, else fall back to the LEGACY
// foreman-nested dir — so watchlist read/write stays on the live location before
// AND after the watchdog is re-homed. Reads and writes both target the same
// resolved dir (no split-brain between reading one and writing the other).
const NEW_WATCHDOG_DIR = join(homedir(), '.homestead', 'stewards', 'rooster', 'substewards', 'watchdog');
const LEGACY_WATCHDOG_DIR = join(homedir(), '.homestead', 'stewards', 'rooster', 'substewards', 'foreman', 'substewards', 'watchdog');
const WATCHDOG_DIR = existsSync(NEW_WATCHDOG_DIR) ? NEW_WATCHDOG_DIR : LEGACY_WATCHDOG_DIR;
const WATCHLIST_FILE = join(WATCHDOG_DIR, 'watchlist.json');
const LAST_CHECK_FILE = join(WATCHDOG_DIR, 'last-check.json');

// Schema locked 2026-05-18 (plan-node /36). Replaces the old
// `{ sessions: [{ name, enabled, cadence }] }` shape. Fleet discovery is now
// a live `tmux list-sessions` scan; this file is the explicit opt-out list.
interface Watchlist {
  disallowed_sessions: string[];
}

function loadWatchlist(): Watchlist {
  try {
    if (existsSync(WATCHLIST_FILE)) {
      const raw = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf-8'));
      return { disallowed_sessions: Array.isArray(raw.disallowed_sessions) ? raw.disallowed_sessions : [] };
    }
  } catch {}
  return { disallowed_sessions: [] };
}

function saveWatchlist(data: Watchlist) {
  writeFileSync(WATCHLIST_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function listHollerSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`tmux list-sessions -F '#{session_name}' 2>/dev/null`);
    return stdout.split('\n')
      .map(s => s.trim())
      .filter(s => s.startsWith('holler-') && !s.startsWith('ephemeral-'));
  } catch {
    return [];
  }
}

async function getSessionStatus(name: string): Promise<'running' | 'stopped'> {
  try {
    await execAsync(`tmux has-session -t "${name}" 2>/dev/null`);
    return 'running';
  } catch {
    return 'stopped';
  }
}

/**
 * GET /api/watchdog
 * Returns: live holler-* sessions (the fleet) + each session's status +
 * whether it's currently disallowed. Replaces the old enabled-flag shape.
 */
export async function GET() {
  const watchlist = loadWatchlist();
  const disallowed = new Set(watchlist.disallowed_sessions);
  const live = await listHollerSessions();

  // Combine live + disallowed (a disallowed session may also be killed).
  const names = new Set<string>([...live, ...disallowed]);

  let lastChecks: Record<string, number> = {};
  try {
    if (existsSync(LAST_CHECK_FILE)) {
      lastChecks = JSON.parse(readFileSync(LAST_CHECK_FILE, 'utf-8'));
    }
  } catch {}

  const sessions = await Promise.all(Array.from(names).sort().map(async name => ({
    name,
    disallowed: disallowed.has(name),
    status: await getSessionStatus(name),
    lastChecked: lastChecks[name] || null,
  })));

  return NextResponse.json({ sessions, disallowed_sessions: watchlist.disallowed_sessions });
}

/**
 * PATCH /api/watchdog?name=holler-alfred
 * Body shapes:
 *   { disallowed: true }   → add to disallowed_sessions
 *   { disallowed: false }  → remove from disallowed_sessions
 *   { action: "stop" }     → kill the tmux session
 *   { action: "start" }    → create and start the session
 */
export async function PATCH(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');

  if (!name) {
    return NextResponse.json({ error: 'name parameter required' }, { status: 400 });
  }

  const body = await request.json();

  // Handle stop/start actions
  if (body.action === 'stop') {
    try {
      await execAsync(`tmux kill-session -t "${name}" 2>/dev/null || true`);
      // Reset activity file
      const activityFile = `/tmp/claude-session-${name}-activity.json`;
      try { writeFileSync(activityFile, '{"is_working":false}'); } catch {}
      return NextResponse.json({ success: true, action: 'stopped', name });
    } catch (err: any) {
      return NextResponse.json({ error: `Failed to stop: ${err.message}` }, { status: 500 });
    }
  }

  if (body.action === 'start') {
    try {
      // Check if already running
      try {
        await execAsync(`tmux has-session -t "${name}" 2>/dev/null`);
        return NextResponse.json({ success: true, action: 'already_running', name });
      } catch {}

      // Determine working directory from session name
      const parts = name.replace('holler-', '').split('--');
      let cwd = join(homedir(), '.homestead', 'stewards');
      if (parts.length === 1) {
        cwd = join(cwd, parts[0]);
      } else {
        cwd = join(cwd, parts[0]);
        for (let i = 1; i < parts.length; i++) {
          cwd = join(cwd, 'substewards', parts[i]);
        }
      }

      if (!existsSync(cwd)) {
        // Fallback to code directory
        cwd = join('<<REPLACE: your home dir, e.g. /Users/you>>/code', parts[0]);
      }

      const { stdout: claudePathRaw } = await execAsync('which claude');
      const claudePath = claudePathRaw.trim();
      const cmd = `${claudePath} --dangerously-skip-permissions --continue || ${claudePath} --dangerously-skip-permissions; zsh`;
      await execAsync(`tmux new-session -d -s "${name}" -c "${cwd}" "${cmd}"`);

      return NextResponse.json({ success: true, action: 'started', name, cwd });
    } catch (err: any) {
      return NextResponse.json({ error: `Failed to start: ${err.message}` }, { status: 500 });
    }
  }

  // Update disallow state
  if (body.disallowed !== undefined) {
    const watchlist = loadWatchlist();
    const set = new Set(watchlist.disallowed_sessions);
    if (body.disallowed) {
      set.add(name);
    } else {
      set.delete(name);
    }
    watchlist.disallowed_sessions = Array.from(set).sort();
    saveWatchlist(watchlist);

    return NextResponse.json({
      success: true,
      session: {
        name,
        disallowed: set.has(name),
        status: await getSessionStatus(name),
      },
    });
  }

  return NextResponse.json({ error: 'no recognized field in body' }, { status: 400 });
}
