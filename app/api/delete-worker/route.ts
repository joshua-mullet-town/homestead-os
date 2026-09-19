import { NextRequest, NextResponse } from 'next/server';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

const execAsync = promisify(exec);

// Canonical fleet teardown + orphan-card-gate tools. These are the SAME tools a
// Foreman runs by hand; this endpoint just wires Josh's "Delete worker"
// presenter button to them so a phone tap does what a Foreman would type.
const TEARDOWN = join(homedir(), '.homestead', 'lib', 'foreman-tools', 'teardown-substeward.sh');
const ORPHAN_GATE = join(homedir(), '.homestead', 'lib', 'foreman-tools', 'check-orphan-cards.sh');
const STEWARDS_DIR = join(homedir(), '.homestead', 'stewards');

// Sessions that are NOT workers and must never be deletable through this button:
// the top-level stewards themselves (no `--` in the name), josh-presenter, and
// any guest. Only ephemeral workers (holler-<steading>--<name> and deeper) tear
// down here.
const NON_WORKER_EXACT = new Set(['josh-presenter', 'josh-mobile']);

interface Resolved {
  session: string;
  steading: string;
  name: string;          // short worker slug (the LAST segment)
  parentWorker?: string; // present only for nested sub-workers
  workerDir: string;     // stewards/<steading>/workers/<...>/<name>
  repo?: string;
  branch?: string;
  worktreePath?: string; // absolute worktree dir (from cwd), when known
}

/**
 * Resolve a presenter session id to the teardown tool's arguments.
 *
 * Session shapes (mirrors spawn/teardown-substeward.sh exactly):
 *   holler-<steading>--<name>                  flat top-level worker (common)
 *   holler-<steading>--<parent>--<name>        nested sub-worker
 *
 * Returns null + a reason when the session is NOT a deletable worker (a top
 * steward, josh-presenter, a guest, or a shape we don't recognize). Reading
 * repo/branch from the worker's own steward.json means the server never has to
 * be handed those by the untrusted client — it derives everything from the id.
 */
function resolveWorker(sessionId: string): { ok: true; w: Resolved } | { ok: false; reason: string } {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'No session provided.' };
  }
  if (NON_WORKER_EXACT.has(sessionId)) {
    return { ok: false, reason: 'That is not a worker — it cannot be deleted here.' };
  }
  if (!sessionId.startsWith('holler-')) {
    return { ok: false, reason: 'That is not a worker — it cannot be deleted here.' };
  }
  const body = sessionId.slice('holler-'.length); // <steading>[--<parent>]--<name>
  const parts = body.split('--');
  // parts[0] == steading. A bare top-level steward is `holler-<steading>` (one
  // part, no `--`) — refuse it: those are the permanent stewards, never workers.
  if (parts.length < 2) {
    return { ok: false, reason: 'That is a top-level steward, not a worker — it cannot be deleted here.' };
  }
  const steading = parts[0];
  const name = parts[parts.length - 1];
  const parentWorker = parts.length >= 3 ? parts[parts.length - 2] : undefined;

  // Locate the worker dir. Mirror teardown-substeward.sh's dual-read:
  // workers/<name> (canonical), workers/<parent>/workers/<name> (nested),
  // substewards/<name> (legacy flat crew). Session-name is identical across the
  // flat variants so we probe on disk to pick the real one.
  const steadingDir = join(STEWARDS_DIR, steading);
  let workerDir: string;
  if (parentWorker) {
    workerDir = join(steadingDir, 'workers', parentWorker, 'workers', name);
  } else {
    const canonical = join(steadingDir, 'workers', name);
    const legacyFlat = join(steadingDir, 'substewards', name);
    workerDir = existsSync(canonical) ? canonical
      : existsSync(legacyFlat) ? legacyFlat
      : canonical; // default to canonical for the error message below
  }

  // Read repo/branch from the worker's own steward.json. Two ways they land:
  //   (a) EXPLICIT fields: spawn-substeward.sh --steward-json-extra
  //       '{"repo":...,"branch":...}'. GiveGrove workers carry these.
  //   (b) DERIVED from `cwd`: most workers (homestead, crowne-vault, etc.) do
  //       NOT persist repo/branch, but they DO carry `cwd` pointing at their
  //       worktree: ~/.worktrees/<repo>/<name>. When the explicit fields are
  //       missing, we derive repo = the dir under ~/.worktrees, branch = the
  //       worktree's actual checked-out branch, and use `cwd` as the worktree
  //       path directly. Without this, the line-diff + worktree-destroy path
  //       was dead for every non-GiveGrove worker (steward-caught 2026-08-06).
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
      // Derive from cwd when it's a worktree path and the explicit fields are gaps.
      const WT_ROOT = join(homedir(), '.worktrees') + '/';
      if (cwd.startsWith(WT_ROOT) && existsSync(cwd)) {
        worktreePath = cwd;
        const rel = cwd.slice(WT_ROOT.length);      // <repo>/<name>[/...]
        const derivedRepo = rel.split('/')[0];
        if (!repo && derivedRepo) repo = derivedRepo;
        if (!branch) {
          try {
            const out = execSync(`git -C ${shq(cwd)} rev-parse --abbrev-ref HEAD`, { timeout: 8000 })
              .toString().trim();
            if (out && out !== 'HEAD') branch = out;
          } catch { /* detached / not a git dir — leave branch undefined */ }
        }
      }
    } catch { /* malformed json — proceed without worktree destroy */ }
  }

  return { ok: true, w: { session: sessionId, steading, name, parentWorker, workerDir, repo, branch, worktreePath } };
}

function shq(s: string): string {
  // Single-quote for /bin/sh. Every arg we pass is a resolved slug/path, never
  // raw client text, but quote defensively anyway.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * PREVIEW mode — run the orphan-card gate in check-only mode so the confirmation
 * modal can tell Josh whether this worker has un-dismissed cards (and how many).
 * Distinguishes the gate's exit codes:
 *   rc 0 → no cards           → { cards: [] }
 *   rc 2 → real cards present  → { cards: [{id,title}, ...] }
 *   rc 1 → presenter unreachable / tooling error → { gateError: true }
 */
async function previewCards(session: string) {
  const cmd = `bash ${shq(ORPHAN_GATE)} --session ${shq(session)}`;
  try {
    const { stdout } = await execAsync(cmd, { timeout: 15000 });
    // rc 0 with no orphan cards → empty stdout
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    const cards = lines
      .filter(l => l.includes('|'))
      .map(l => {
        const idx = l.indexOf('|');
        return { id: l.slice(0, idx), title: l.slice(idx + 1) };
      });
    return { gateError: false, cards };
  } catch (err: any) {
    const code = typeof err?.code === 'number' ? err.code : null;
    if (code === 2) {
      // Real orphan cards. The gate printed `id|title` lines to stdout.
      const stdout: string = err?.stdout || '';
      const cards = stdout.split('\n').map((l: string) => l.trim()).filter(Boolean)
        .filter((l: string) => l.includes('|'))
        .map((l: string) => {
          const idx = l.indexOf('|');
          return { id: l.slice(0, idx), title: l.slice(idx + 1) };
        });
      return { gateError: false, cards };
    }
    // rc 1 (presenter unreachable) or any other failure → surface as a gate error
    // so the modal refuses rather than guessing "no cards".
    return { gateError: true, cards: [] };
  }
}

// Per-repo default-branch OVERRIDES. Most repos default to `main`; GiveGrove
// works on `master`. Josh asked for this to be per-project configurable and to
// default to `main`. Rather than hardcode every repo, we (1) check this override
// map, (2) else ask git for the repo's real default via origin/HEAD, (3) else
// fall back to `main`. New exceptions only need a line here.
const DEFAULT_BRANCH_OVERRIDE: Record<string, string> = {
  GiveGrove: 'master',
};

/**
 * Resolve a repo's default (base) branch name — the branch a worker's work
 * should be measured against. Override map wins; then the repo's own
 * origin/HEAD; then `main`.
 */
async function resolveDefaultBranch(repo: string, repoDir: string): Promise<string> {
  if (DEFAULT_BRANCH_OVERRIDE[repo]) return DEFAULT_BRANCH_OVERRIDE[repo];
  try {
    // origin/HEAD points at e.g. refs/remotes/origin/main → basename is the branch.
    const { stdout } = await execAsync(
      `git -C ${shq(repoDir)} symbolic-ref --quiet refs/remotes/origin/HEAD`,
      { timeout: 8000 }
    );
    const ref = stdout.trim(); // refs/remotes/origin/<branch>
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return m[1];
  } catch { /* origin/HEAD not set — fall through */ }
  return 'main';
}

/**
 * Compute how much UNMERGED work the worker's branch has vs its default branch,
 * so Josh can judge whether deleting throws away real work.
 *
 * BASE SELECTION (the subtle bit — Josh caught this): a branch's work is "saved"
 * if it's merged into EITHER local <base> OR origin/<base>. In the Homestead
 * flow, /worktree merge lands work in LOCAL main and does NOT push, so
 * origin/main is stale (behind local main). Comparing only against origin/main
 * made an already-merged worker look "2 ahead, +14/−11" — false alarm. So we
 * compute ahead against BOTH bases that exist and report the MINIMUM ahead (if
 * the work made it into either trunk, nothing is at risk), using that same base
 * for the line-diff. For GiveGrove-style push flows origin/<base> is the live
 * one; for Homestead local <base> is — the min handles both without special-casing.
 *
 * Returns:
 *   { ok: true, base, ahead, behind, filesChanged, insertions, deletions }
 *        ahead = the branch's own commits not in the closest base (work AT RISK);
 *        behind = commits in that base not on the branch (staleness — not shown).
 *   { ok: false, reason }               — branch/repo gone or git error; the modal
 *                                          still lets Josh delete, just without the read.
 */
async function branchAheadBehind(repo: string, branch: string):
  Promise<{ ok: true; base: string; ahead: number; behind: number; filesChanged: number; insertions: number; deletions: number } | { ok: false; reason: string }> {
  const repoDir = join(homedir(), 'code', repo);
  if (!existsSync(join(repoDir, '.git'))) {
    return { ok: false, reason: 'repo not found' };
  }
  const base = await resolveDefaultBranch(repo, repoDir);

  // Candidate bases: local <base> AND origin/<base>, whichever exist. The branch
  // is safe to delete if merged into ANY of them, so we take the min-ahead.
  const candidates: string[] = [];
  for (const ref of [base, `origin/${base}`]) {
    try {
      await execAsync(`git -C ${shq(repoDir)} rev-parse --verify --quiet ${shq(ref)}`, { timeout: 8000 });
      candidates.push(ref);
    } catch { /* ref absent — skip */ }
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'no base branch found' };
  }

  try {
    // Verify the worker branch exists before comparing.
    await execAsync(`git -C ${shq(repoDir)} rev-parse --verify --quiet ${shq(branch)}`, { timeout: 8000 });

    // Compute ahead/behind against each candidate base; keep the one with the
    // SMALLEST ahead (the base the branch is most-merged into = least at risk).
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

    // LINE DIFF (Josh's 2026-08-06 ask): show how BIG the unmerged work is, not
    // just the commit count. `diff --shortstat <base>...<branch>` (three dots)
    // diffs from the merge-base to the branch tip = the branch's OWN work vs base.
    // Uses the SAME base we chose for ahead, so a fully-merged branch reports 0.
    // Output: " N files changed, X insertions(+), Y deletions(-)" (any clause may
    // be absent when zero). Parse each independently; default 0.
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
    } catch { /* shortstat failed — leave zeros, ahead/behind still returned */ }

    return { ok: true, base, ahead, behind, filesChanged, insertions, deletions };
  } catch (err: any) {
    return { ok: false, reason: 'could not compare branch' };
  }
}

export async function POST(request: NextRequest) {
  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body.' }, { status: 400 });
  }

  const sessionId: string = payload?.sessionId;
  const action: string = payload?.action || 'preview';
  // Flags Josh's card answers toggle. Defaults match the recommended behavior:
  // destroy the worktree/branch, and bypass the Layer-2 scratch gate for a
  // manual delete. Both can be flipped by the client if Josh chose otherwise.
  const destroyWorktree: boolean = payload?.destroyWorktree !== false;
  const bypassScratchGate: boolean = payload?.bypassScratchGate !== false;

  const resolved = resolveWorker(sessionId);
  if (!resolved.ok) {
    return NextResponse.json({ success: false, error: resolved.reason }, { status: 400 });
  }
  const w = resolved.w;

  if (!existsSync(TEARDOWN)) {
    return NextResponse.json(
      { success: false, error: 'Teardown tool not found on this machine.' },
      { status: 500 }
    );
  }

  // ── PREVIEW ────────────────────────────────────────────────────────────────
  if (action === 'preview') {
    const { gateError, cards } = await previewCards(w.session);
    // Branch ahead/behind its default branch (Josh: helps him judge whether the
    // worker has real unmerged work at risk before deleting). Only meaningful
    // when the worker actually has a repo/branch.
    let work: any = null;
    if (w.repo && w.branch) {
      const ab = await branchAheadBehind(w.repo, w.branch);
      if (ab.ok) {
        work = {
          base: ab.base,
          ahead: ab.ahead,
          behind: ab.behind,
          filesChanged: ab.filesChanged,
          insertions: ab.insertions,
          deletions: ab.deletions,
        };
      } else {
        work = { error: ab.reason };
      }
    }
    return NextResponse.json({
      success: true,
      session: w.session,
      name: w.name,
      hasWorktree: !!(w.repo && w.branch),
      repo: w.repo || null,
      branch: w.branch || null,
      gateError,
      cardCount: cards.length,
      cards,
      work,
    });
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const args: string[] = [
      '--steading', w.steading,
      '--name', w.name,
    ];
    if (w.parentWorker) {
      args.push('--parent-worker', w.parentWorker);
    }
    // Bulk-dismiss any outstanding cards as part of teardown (Josh confirmed).
    args.push('--acknowledge-orphan-cards');
    if (bypassScratchGate) {
      // Manual "Josh hit delete" — skip the graduation discipline gate.
      args.push('--acknowledge-empty-scratch');
    }
    // Destroy the worktree + branch when requested AND we have repo/branch. If
    // the worker had no worktree (research-only), these are simply omitted.
    // Pass --worktree-path explicitly when we derived it from cwd, so teardown
    // removes the EXACT worktree dir rather than recomputing the
    // ~/.worktrees/<repo>/<name> convention (which can diverge — e.g. GiveGrove's
    // slug-mangled branch names). teardown-substeward.sh honors the override.
    if (destroyWorktree && w.repo && w.branch) {
      args.push('--destroy-worktree', '--repo', w.repo, '--branch', w.branch);
      if (w.worktreePath) {
        args.push('--worktree-path', w.worktreePath);
      }
    }

    const cmd = `bash ${shq(TEARDOWN)} ${args.map(shq).join(' ')}`;
    // NOTE: TEARDOWN is an absolute path with no shell-meta chars; single-quote
    // it defensively anyway. Real teardown can take a few seconds
    // (tmux kill + worktree remove + verify triple) — allow generous timeout.
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 });
      return NextResponse.json({
        success: true,
        session: w.session,
        name: w.name,
        message: `Deleted ${w.name}.`,
        detail: stdout,
        stderr,
      });
    } catch (err: any) {
      // teardown exit codes: 1 gate/verify failure, 2 orphan/permanent refusal,
      // 3 scratch gate. Surface the tool's stderr so the modal can show why.
      const code = typeof err?.code === 'number' ? err.code : null;
      const stderr: string = err?.stderr || err?.message || '';
      let reason = 'Delete failed.';
      if (code === 2 && /permanent Worker/i.test(stderr)) {
        reason = 'This is a permanent helper and is protected from deletion.';
      } else if (code === 1) {
        reason = 'Delete did not fully complete — something survived. Left it alone; investigate.';
      }
      return NextResponse.json(
        { success: false, error: reason, code, stderr },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ success: false, error: 'Unknown action.' }, { status: 400 });
}
