import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stewardIdToPath } = require('@/lib/steward-path');

/**
 * GET /api/steward-timers/:stewardId
 *
 * Returns the merged view of a single steward's timers.json + timers.state.json.
 * Steward id uses the "--" convention for nested substewards
 * (e.g. "venture--foreman").
 *
 * Response:
 *   { stewardId, owner, dir, timers: [{id, description, cron, script, enabled, state: {last_run, last_exit_code, run_count}}], exists: boolean }
 *
 * If the steward's dir has no timers.json, returns { exists: false, timers: [] }.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ stewardId: string }> }
) {
  const { stewardId } = await context.params;
  return NextResponse.json(loadStewardTimers(stewardId));
}

interface StateEntry {
  last_run?: string;
  last_exit_code?: number;
  run_count?: number;
}

interface MergedTimer {
  id: string;
  description?: string;
  cron?: string;
  script?: string;
  enabled?: boolean;
  state: StateEntry;
}

interface LoadResult {
  stewardId: string;
  owner: string | null;
  dir: string | null;
  exists: boolean;
  timers: MergedTimer[];
  error?: string;
}

export function loadStewardTimers(stewardId: string): LoadResult {
  const dir = stewardIdToPath(stewardId);
  if (!dir) {
    return { stewardId, owner: null, dir: null, exists: false, timers: [], error: 'Invalid stewardId' };
  }

  const timersFile = join(dir, 'timers.json');
  const stateFile = join(dir, 'timers.state.json');

  if (!existsSync(timersFile)) {
    return { stewardId, owner: null, dir, exists: false, timers: [] };
  }

  let config: { owner?: string; timers?: Array<{ id: string; description?: string; cron?: string; script?: string; enabled?: boolean }> } = {};
  try {
    config = JSON.parse(readFileSync(timersFile, 'utf-8'));
  } catch (err) {
    return { stewardId, owner: null, dir, exists: true, timers: [], error: `Failed to parse timers.json: ${(err as Error).message}` };
  }

  let state: Record<string, StateEntry> = {};
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    } catch {
      // Bad state file — treat as empty; engine will recreate.
      state = {};
    }
  }

  const timers: MergedTimer[] = (config.timers || []).map(t => ({
    id: t.id,
    description: t.description,
    cron: t.cron,
    script: t.script,
    enabled: t.enabled !== false,
    state: state[t.id] || {},
  }));

  return {
    stewardId,
    owner: config.owner || null,
    dir,
    exists: true,
    timers,
  };
}
