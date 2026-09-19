import { NextRequest, NextResponse } from 'next/server';
import { resolveWorker, branchAheadBehind } from '@/lib/worker-git';

/**
 * Per-worker AHEAD-ONLY git diff, batched.
 *
 * Feeds the presenter worker row's tiny GitHub-style "N files +X −Y" chip
 * (Josh 2026-08-07 redesign): how much work is in each worker's branch that
 * ISN'T in main yet. Ahead-only — Josh explicitly does NOT want "behind".
 *
 * BATCH by design: the row has many visible workers; it POSTs ALL of their
 * session ids in ONE call so we don't fan out N HTTP requests per render. We
 * compute each worker's ahead-diff in parallel (reusing the battle-tested
 * branchAheadBehind from delete-worker via lib/worker-git).
 *
 * COST GUARD: a git rev-list + shortstat per worker is real work, so we cache
 * each session's result for CACHE_TTL_MS. Rapid re-polls within the window
 * return cached numbers; the row can poll on a relaxed cadence without thrashing
 * git. The diff only changes when the worker commits, so short staleness is fine.
 *
 * Request:  POST { sessions: string[] }
 * Response: { diffs: { [session]: { files, add, del, ahead } | null } }
 *           null = not a worker / no repo+branch / git error (row shows no chip).
 */

const CACHE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; value: DiffEntry | null }>();

interface DiffEntry {
  files: number;
  add: number;
  del: number;
  ahead: number;
}

async function computeOne(session: string): Promise<DiffEntry | null> {
  const cached = cache.get(session);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  let value: DiffEntry | null = null;
  const resolved = resolveWorker(session);
  if (resolved.ok && resolved.w.repo && resolved.w.branch) {
    const ab = await branchAheadBehind(resolved.w.repo, resolved.w.branch);
    if (ab.ok) {
      value = { files: ab.filesChanged, add: ab.insertions, del: ab.deletions, ahead: ab.ahead };
    }
  }
  cache.set(session, { at: now, value });
  return value;
}

export async function POST(request: NextRequest) {
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const sessions: unknown = payload?.sessions;
  if (!Array.isArray(sessions)) {
    return NextResponse.json({ error: 'sessions must be an array.' }, { status: 400 });
  }
  // Cap defensively — the row never has hundreds of workers, but don't let a
  // bad client spawn unbounded git subprocesses.
  const ids = sessions
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .slice(0, 64);

  const results = await Promise.all(
    ids.map(async (id) => [id, await computeOne(id)] as const)
  );

  const diffs: Record<string, DiffEntry | null> = {};
  for (const [id, value] of results) diffs[id] = value;

  return NextResponse.json({ diffs });
}
