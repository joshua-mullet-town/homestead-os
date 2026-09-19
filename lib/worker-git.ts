/**
 * Shared worker → git helpers.
 *
 * Lifted verbatim (behavior-identical) from app/api/delete-worker/route.ts so a
 * second consumer — the per-worker ahead-only diff endpoint that feeds the
 * presenter worker row's "N files +X −Y" chip (Josh 2026-08-07 redesign) — can
 * reuse the SAME battle-tested computation without duplicating it. The delete
 * route still carries its own private copies for now; converging it onto this
 * lib is a safe no-behavior-change follow-up.
 *
 * The core value is `branchAheadBehind`: it computes how much work a worker's
 * branch has that ISN'T in main yet (AHEAD-only), taking the MIN ahead against
 * both local <base> and origin/<base> so an already-merged branch correctly
 * reads 0 (the Homestead /worktree merge flow lands in LOCAL main without
 * pushing, so origin/main is stale — comparing only to it false-alarms).
 */
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

const execAsync = promisify(exec);

const STEWARDS_DIR = join(homedir(), '.homestead', 'stewards');
const NON_WORKER_EXACT = new Set(['josh-presenter', 'josh-mobile']);

export interface ResolvedWorker {
  session: string;
  steading: string;
  name: string;
  parentWorker?: string;
  workerDir: string;
  repo?: string;
  branch?: string;
  worktreePath?: string;
}

/** Single-quote for /bin/sh. Args are resolved slugs/paths, never raw client text. */
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve a presenter session id → its steading/worker dir and (repo, branch).
 * Returns { ok:false } for non-workers (top stewards, josh-presenter, guests).
 * repo/branch come from the worker's own steward.json, either explicit fields or
 * derived from a `cwd` under ~/.worktrees/<repo>/<name>.
 */
export function resolveWorker(sessionId: string): { ok: true; w: ResolvedWorker } | { ok: false; reason: string } {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'No session provided.' };
  }
  if (NON_WORKER_EXACT.has(sessionId)) {
    return { ok: false, reason: 'Not a worker.' };
  }
  if (!sessionId.startsWith('holler-')) {
    return { ok: false, reason: 'Not a worker.' };
  }
  const body = sessionId.slice('holler-'.length); // <steading>[--<parent>]--<name>
  const parts = body.split('--');
  if (parts.length < 2) {
    return { ok: false, reason: 'Top-level steward, not a worker.' };
  }
  const steading = parts[0];
  const name = parts[parts.length - 1];
  const parentWorker = parts.length >= 3 ? parts[parts.length - 2] : undefined;

  const steadingDir = join(STEWARDS_DIR, steading);
  let workerDir: string;
  if (parentWorker) {
    workerDir = join(steadingDir, 'workers', parentWorker, 'workers', name);
  } else {
    const canonical = join(steadingDir, 'workers', name);
    const legacyFlat = join(steadingDir, 'substewards', name);
    workerDir = existsSync(canonical) ? canonical
      : existsSync(legacyFlat) ? legacyFlat
      : canonical;
  }

  let repo: string | undefined;
  let branch: string | undefined;
  let worktreePath: string | undefined;
  const jsonPath = join(workerDir, 'steward.json');
  if (existsSync(jsonPath)) {
    try {
      const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      repo = typeof data.repo === 'string' && data.repo ? data.repo : undefined;
      branch = typeof data.branch === 'string' && data.branch ? data.branch : undefined;
      const cwd = typeof data.cwd === 'string' ? data.cwd : '';
      const WT_ROOT = join(homedir(), '.worktrees') + '/';
      if (cwd.startsWith(WT_ROOT) && existsSync(cwd)) {
        worktreePath = cwd;
        const rel = cwd.slice(WT_ROOT.length);
        const derivedRepo = rel.split('/')[0];
        if (!repo && derivedRepo) repo = derivedRepo;
        if (!branch) {
          try {
            const out = execSync(`git -C ${shq(cwd)} rev-parse --abbrev-ref HEAD`, { timeout: 8000 })
              .toString().trim();
            if (out && out !== 'HEAD') branch = out;
          } catch { /* detached / not a git dir */ }
        }
      }
    } catch { /* malformed json */ }
  }

  return { ok: true, w: { session: sessionId, steading, name, parentWorker, workerDir, repo, branch, worktreePath } };
}

// Per-repo default-branch overrides (most repos are `main`; GiveGrove is `master`).
const DEFAULT_BRANCH_OVERRIDE: Record<string, string> = {
  GiveGrove: 'master',
};

/** Resolve a repo's default (base) branch: override → origin/HEAD → `main`. */
export async function resolveDefaultBranch(repo: string, repoDir: string): Promise<string> {
  if (DEFAULT_BRANCH_OVERRIDE[repo]) return DEFAULT_BRANCH_OVERRIDE[repo];
  try {
    const { stdout } = await execAsync(
      `git -C ${shq(repoDir)} symbolic-ref --quiet refs/remotes/origin/HEAD`,
      { timeout: 8000 }
    );
    const ref = stdout.trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return m[1];
  } catch { /* origin/HEAD not set */ }
  return 'main';
}

export type AheadBehind =
  | { ok: true; base: string; ahead: number; behind: number; filesChanged: number; insertions: number; deletions: number }
  | { ok: false; reason: string };

/**
 * How much UNMERGED (ahead-only) work the worker's branch has vs its default
 * branch. Takes the MIN ahead against local <base> and origin/<base> so an
 * already-merged branch reads 0. Uses that same base for the line-diff.
 */
export async function branchAheadBehind(repo: string, branch: string): Promise<AheadBehind> {
  const repoDir = join(homedir(), 'code', repo);
  if (!existsSync(join(repoDir, '.git'))) {
    return { ok: false, reason: 'repo not found' };
  }
  const base = await resolveDefaultBranch(repo, repoDir);

  const candidates: string[] = [];
  for (const ref of [base, `origin/${base}`]) {
    try {
      await execAsync(`git -C ${shq(repoDir)} rev-parse --verify --quiet ${shq(ref)}`, { timeout: 8000 });
      candidates.push(ref);
    } catch { /* ref absent */ }
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'no base branch found' };
  }

  try {
    await execAsync(`git -C ${shq(repoDir)} rev-parse --verify --quiet ${shq(branch)}`, { timeout: 8000 });

    let best: { baseRef: string; ahead: number; behind: number } | null = null;
    for (const baseRef of candidates) {
      const { stdout } = await execAsync(
        `git -C ${shq(repoDir)} rev-list --left-right --count ${shq(baseRef)}...${shq(branch)}`,
        { timeout: 12000 }
      );
      const parts = stdout.trim().split(/\s+/);
      const behind = parseInt(parts[0], 10) || 0;
      const ahead = parseInt(parts[1], 10) || 0;
      if (best === null || ahead < best.ahead) best = { baseRef, ahead, behind };
    }
    const chosenRef = best!.baseRef;
    const ahead = best!.ahead;
    const behind = best!.behind;

    let filesChanged = 0, insertions = 0, deletions = 0;
    try {
      const { stdout: stat } = await execAsync(
        `git -C ${shq(repoDir)} diff --shortstat ${shq(chosenRef)}...${shq(branch)}`,
        { timeout: 12000 }
      );
      const fm = stat.match(/(\d+)\s+files?\s+changed/);
      const im = stat.match(/(\d+)\s+insertions?\(\+\)/);
      const dm = stat.match(/(\d+)\s+deletions?\(-\)/);
      if (fm) filesChanged = parseInt(fm[1], 10) || 0;
      if (im) insertions = parseInt(im[1], 10) || 0;
      if (dm) deletions = parseInt(dm[1], 10) || 0;
    } catch { /* shortstat failed — leave zeros */ }

    return { ok: true, base, ahead, behind, filesChanged, insertions, deletions };
  } catch {
    return { ok: false, reason: 'could not compare branch' };
  }
}
