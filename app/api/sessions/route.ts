import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { getCodeDir, getWorktreesDir } from '@/lib/get-code-dir';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveStewardCwd } = require('@/lib/resolve-session-dir');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emitSessionCreated, emitSessionDeleted } = require('@/lib/emit-session-event');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cleanupSessionFiles } = require('@/lib/cleanup-session-files');

const execAsync = promisify(exec);

// Debug logging - set to true to see detailed session resolution logs.
// Kept OFF: the /api/sessions GET runs logSession() dozens of times per session
// across all sessions, and the front-end polls this endpoint every 3s — with this
// on it produced ~99.5% of all server log volume (~118 MB/day of spam). Flip to
// true only for a short local debugging session, never leave it on.
const DEBUG_SESSIONS = false;
function logSession(...args: unknown[]) {
  if (DEBUG_SESSIONS) {
    console.log('[Sessions]', ...args);
  }
}

interface SessionInfo {
  name: string;
  project: string;      // Base project name (e.g., "homestead")
  branch: string;       // Current git branch
  path: string;         // Full path to project/worktree
  isWorktree: boolean;  // Is this a worktree or the main repo?
  created: string;
  windows: number;
}

// Helper to get git branch for a directory
async function getGitBranch(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  try {
    const { stdout } = await execAsync('git branch --show-current', { cwd: dir });
    return stdout.trim() || 'detached';
  } catch {
    return null;
  }
}

// Helper to find the base project name from a worktree
// Worktrees have .git as a file containing "gitdir: /path/to/main/.git/worktrees/name"
function getBaseProject(dir: string): string | null {
  const gitPath = path.join(dir, '.git');
  if (!existsSync(gitPath)) return null;

  try {
    const stat = statSync(gitPath);
    if (stat.isDirectory()) {
      // This is a main repo, not a worktree
      return null;
    }

    // It's a file - read it to find the main repo
    const content = readFileSync(gitPath, 'utf-8').trim();
    // Format: "gitdir: /path/to/main/.git/worktrees/branch-name"
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return null;

    const gitDir = match[1];
    // Extract the main repo path: /path/to/main/.git/worktrees/x -> /path/to/main
    const mainGitMatch = gitDir.match(/^(.+)\/\.git\/worktrees\/.+$/);
    if (!mainGitMatch) return null;

    const mainRepoPath = mainGitMatch[1];
    // Extract project name from path
    return path.basename(mainRepoPath);
  } catch {
    return null;
  }
}

// Helper to determine project path from session name
async function getProjectPath(sessionName: string): Promise<{ path: string; project: string; isWorktree: boolean }> {
  const CODE_DIR = getCodeDir();
  const WORKTREES_DIR = getWorktreesDir();
  const HOMESTEAD_DIR = path.join(process.env.HOME || '<<REPLACE: your home dir, e.g. /Users/you>>', '.homestead');

  // Session name format: holler-{project} or holler-{project}--{branch}
  const nameWithoutPrefix = sessionName.replace('holler-', '');

  // Check if this is a steward or substeward session
  // Top-level: holler-{stewardId} -> ~/.homestead/stewards/{stewardId}
  // Substeward: holler-{parent}--{child} -> ~/.homestead/stewards/{parent}/substewards/{child}
  // Sub-sub: holler-{parent}--{child}--{grandchild} -> ~/.homestead/stewards/{parent}/substewards/{child}/substewards/{grandchild}
  const stewardPath = path.join(HOMESTEAD_DIR, 'stewards', nameWithoutPrefix);
  if (existsSync(stewardPath)) {
    logSession(`  Special case: steward -> ${stewardPath}`);
    return { path: stewardPath, project: nameWithoutPrefix, isWorktree: false };
  }

  // Check for substeward: convert -- separators to /substewards/ path segments
  if (nameWithoutPrefix.includes('--')) {
    const parts = nameWithoutPrefix.split('--');
    // Build path: stewards/{parts[0]}/substewards/{parts[1]}/substewards/{parts[2]}/...
    let substewardPath = path.join(HOMESTEAD_DIR, 'stewards', parts[0]);
    for (let i = 1; i < parts.length; i++) {
      substewardPath = path.join(substewardPath, 'substewards', parts[i]);
    }
    if (existsSync(substewardPath) && existsSync(path.join(substewardPath, 'steward.json'))) {
      logSession(`  Special case: substeward -> ${substewardPath}`);
      return { path: substewardPath, project: nameWithoutPrefix, isWorktree: false };
    }
  }

  // Check if this is a guest session (holler-guest-{shortName} -> ~/.homestead/guest-sessions/{shortName})
  if (nameWithoutPrefix.startsWith('guest-')) {
    const guestName = nameWithoutPrefix.replace('guest-', '');
    const guestPath = path.join(HOMESTEAD_DIR, 'guest-sessions', guestName);
    if (existsSync(guestPath)) {
      logSession(`  Special case: guest session -> ${guestPath}`);
      return { path: guestPath, project: nameWithoutPrefix, isWorktree: false };
    }
  }

  logSession(`getProjectPath("${sessionName}")`);
  logSession(`  nameWithoutPrefix: "${nameWithoutPrefix}"`);
  logSession(`  CODE_DIR: "${CODE_DIR}"`);
  logSession(`  WORKTREES_DIR: "${WORKTREES_DIR}"`);

  // Check if it's a worktree session (contains a branch separator)
  // Worktree sessions: holler-{project}--{branch} (double dash to separate)
  if (nameWithoutPrefix.includes('--')) {
    const [project, branch] = nameWithoutPrefix.split('--');
    const worktreePath = path.join(WORKTREES_DIR, project, branch);
    logSession(`  Double-dash format: project="${project}", branch="${branch}"`);
    logSession(`  Checking worktree: ${worktreePath} -> ${existsSync(worktreePath)}`);
    if (existsSync(worktreePath)) {
      logSession(`  ✓ FOUND as double-dash worktree`);
      return { path: worktreePath, project, isWorktree: true };
    }

    // Worktree folder name may differ from session branch name (e.g. sanitized short names).
    // Scan the project's worktree directory for a folder that could match.
    const projectWorktreeDir = path.join(WORKTREES_DIR, project);
    if (existsSync(projectWorktreeDir)) {
      try {
        const folders = readdirSync(projectWorktreeDir);
        for (const folder of folders) {
          // Check if the branch name ends with the same issue/feature identifier
          // e.g. branch="joshua-mullet-town-feature-gh-1427" matches folder="jmullet-feature-gh-1427"
          // Strategy: extract trailing identifier (gh-XXXX or last meaningful segment) and match
          const branchParts = branch.split('-');
          const folderParts = folder.split('-');
          // Match on the last 2+ segments (e.g. "gh-1427")
          const branchTail = branchParts.slice(-2).join('-');
          const folderTail = folderParts.slice(-2).join('-');
          if (branchTail === folderTail && branchTail.length >= 3) {
            const matchPath = path.join(projectWorktreeDir, folder);
            if (existsSync(matchPath)) {
              logSession(`  ✓ FOUND via tail match: branch tail="${branchTail}" -> ${matchPath}`);
              return { path: matchPath, project, isWorktree: true };
            }
          }
        }
      } catch {
        logSession(`  Could not scan worktree dir for ${project}`);
      }
    }

    // Last resort: ask tmux where the session is actually running
    try {
      const { stdout: panePathRaw } = await execAsync(
        `tmux display-message -t "${sessionName}" -p '#{pane_current_path}'`,
        { timeout: 3000 }
      );
      const panePath = panePathRaw.trim();
      if (panePath && existsSync(panePath) && panePath.includes(WORKTREES_DIR)) {
        logSession(`  ✓ FOUND via tmux pane path: ${panePath}`);
        return { path: panePath, project, isWorktree: true };
      }
    } catch {
      logSession(`  Could not get pane path for ${sessionName}`);
    }
  }

  // NEW: Check if this might be a worktree branch name directly
  // e.g., holler-alert-triage could be ~/.worktrees/*/alert-triage
  // Scan all project folders in WORKTREES_DIR to find a matching branch
  if (existsSync(WORKTREES_DIR)) {
    try {
      const projectDirs = readdirSync(WORKTREES_DIR);
      logSession(`  Scanning WORKTREES_DIR for branch "${nameWithoutPrefix}"`);
      logSession(`  Projects in worktrees: ${projectDirs.join(', ')}`);

      for (const projectDir of projectDirs) {
        const worktreePath = path.join(WORKTREES_DIR, projectDir, nameWithoutPrefix);
        const exists = existsSync(worktreePath);
        logSession(`    ${projectDir}/${nameWithoutPrefix}: ${worktreePath} -> ${exists}`);
        if (exists) {
          logSession(`  ✓ FOUND worktree: project="${projectDir}", branch="${nameWithoutPrefix}"`);
          return { path: worktreePath, project: projectDir, isWorktree: true };
        }
      }
    } catch (err) {
      logSession(`  ERROR scanning worktrees:`, err);
    }
  }

  // Default: check the project in code directory
  const projectPath = path.join(CODE_DIR, nameWithoutPrefix);
  logSession(`  Checking CODE_DIR: ${projectPath} -> ${existsSync(projectPath)}`);

  // Check if this directory is actually a worktree of another project
  const baseProject = getBaseProject(projectPath);
  if (baseProject && baseProject !== nameWithoutPrefix) {
    // This is a worktree living in CODE_DIR (like homestead-voice)
    logSession(`  Detected as worktree of: ${baseProject}`);
    return { path: projectPath, project: baseProject, isWorktree: true };
  }

  logSession(`  Final: path="${projectPath}", project="${nameWithoutPrefix}", isWorktree=false`);
  return { path: projectPath, project: nameWithoutPrefix, isWorktree: false };
}

export async function GET() {
  try {
    // Get tmux sessions
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}|#{session_created}|#{session_windows}"').catch(() => ({ stdout: '' }));

    if (!stdout.trim()) {
      return NextResponse.json({ sessions: [] });
    }

    const sessionsPromises = stdout.trim().split('\n').map(async (line): Promise<SessionInfo | null> => {
      const [name, created, windows] = line.split('|');

      // Only process holler sessions
      if (!name.startsWith('holler-')) return null;

      const { path: projectPath, project, isWorktree } = await getProjectPath(name);

      // Filter out orphan sessions (directory doesn't exist)
      if (!existsSync(projectPath)) {
        logSession(`⚠ Orphan session: ${name} -> ${projectPath} (doesn't exist)`);
        return null;
      }

      logSession(`✓ Valid session: ${name} -> ${projectPath}`);
      logSession(`  project="${project}", isWorktree=${isWorktree}`);

      const branch = await getGitBranch(projectPath) || 'unknown';

      return {
        name,
        project,
        branch,
        path: projectPath,
        isWorktree,
        created: new Date(parseInt(created) * 1000).toISOString(),
        windows: parseInt(windows) || 1,
      };
    });

    const sessions = (await Promise.all(sessionsPromises)).filter((s): s is SessionInfo => s !== null);

    return NextResponse.json({ sessions });
  } catch (error) {
    console.error('Failed to list tmux sessions:', error);
    return NextResponse.json({ sessions: [], error: 'Failed to list sessions' });
  }
}

// Create a new tmux session
export async function POST(request: NextRequest) {
  try {
    const CODE_DIR = getCodeDir();
    const { project, mode = 'continue', worktreePath, branch } = await request.json();

    if (!project) {
      return NextResponse.json({ error: 'Project name required' }, { status: 400 });
    }

    // Resolve session name and project directory
    let sessionName: string;
    let projectDir: string;
    const HOMESTEAD_DIR = path.join(process.env.HOME || '<<REPLACE: your home dir, e.g. /Users/you>>', '.homestead');

    if (worktreePath && branch) {
      // Worktree session: holler-{project}--{branch}
      sessionName = `holler-${project}--${branch}`;
      projectDir = worktreePath;
    } else if (existsSync(path.join(HOMESTEAD_DIR, 'stewards', project))) {
      // Top-level steward: ~/.homestead/stewards/{name}
      // Honors builder.json codeDir AND steward.json cwd via resolveStewardCwd
      sessionName = `holler-${project}`;
      const stewardDir = path.join(HOMESTEAD_DIR, 'stewards', project);
      projectDir = resolveStewardCwd(stewardDir);
    } else if (project.includes('--')) {
      // Substeward / sub-sub-steward: holler-{parent}--{child}[--{grandchild}...]
      // Walks stewards/{parts[0]}/substewards/{parts[1]}/substewards/{parts[2]}/...
      const parts = project.split('--');
      let substewardDir = path.join(HOMESTEAD_DIR, 'stewards', parts[0]);
      for (let i = 1; i < parts.length; i++) {
        substewardDir = path.join(substewardDir, 'substewards', parts[i]);
      }
      if (existsSync(substewardDir) && existsSync(path.join(substewardDir, 'steward.json'))) {
        sessionName = `holler-${project}`;
        projectDir = resolveStewardCwd(substewardDir);
      } else {
        // Not a real substeward — fall back to worktree/code-dir resolution
        sessionName = `holler-${project}`;
        projectDir = `${CODE_DIR}/${project}`;
      }
    } else if (project.startsWith('guest-') && existsSync(path.join(HOMESTEAD_DIR, 'guest-sessions', project.replace('guest-', '')))) {
      // Guest session: lives in ~/.homestead/guest-sessions/{shortName}
      sessionName = `holler-${project}`;
      projectDir = path.join(HOMESTEAD_DIR, 'guest-sessions', project.replace('guest-', ''));
    } else {
      // Main project session: lives in ~/code/{name}
      sessionName = `holler-${project}`;
      projectDir = `${CODE_DIR}/${project}`;
    }

    // Guard: refuse to create session in nonexistent dir.
    // tmux silently falls back to its own cwd when -c is invalid, which silently
    // contaminates CLAUDE.md auto-load. Fail loud instead.
    if (!existsSync(projectDir)) {
      console.error(`[Sessions] Refusing to create ${sessionName}: projectDir does not exist: ${projectDir}`);
      return NextResponse.json(
        { error: `Cannot create session: working directory does not exist: ${projectDir}` },
        { status: 500 }
      );
    }

    // Build the --add-dir flags for all code directories
    const { stdout: dirList } = await execAsync(`ls -d "${CODE_DIR}"/*/`).catch(() => ({ stdout: '' }));
    const addDirFlags = dirList
      .trim()
      .split('\n')
      .filter(d => d && !d.includes('node_modules'))
      .map(d => `--add-dir "${d.replace(/\/$/, '')}"`)
      .join(' ');

    let claudePath: string;
    try {
      const { stdout } = await execAsync('which claude');
      claudePath = stdout.trim();
    } catch {
      claudePath = '<<REPLACE: your home dir, e.g. /Users/you>>/.local/bin/claude';
    }
    const baseFlags = `--dangerously-skip-permissions ${addDirFlags}`;

    // mode: 'continue' tries to resume, falling back to fresh if no previous session
    // mode: 'fresh' always starts new
    let claudeCommand: string;
    if (mode === 'continue') {
      claudeCommand = `${claudePath} ${baseFlags} --continue || ${claudePath} ${baseFlags}; zsh`;
    } else {
      claudeCommand = `${claudePath} ${baseFlags}; zsh`;
    }

    // Atomic create: tmux new-session fails with "duplicate session" if the name
    // already exists. This closes the check-then-create race that parallel
    // spawners (e.g. Foreman spawning multiple Workers) would otherwise hit.
    try {
      await execAsync(`tmux new-session -d -s ${sessionName} -c "${projectDir}" "${claudeCommand}"`);
    } catch (err) {
      const msg = (err as { stderr?: string; message?: string })?.stderr
        || (err as { message?: string })?.message
        || '';
      if (msg.includes('duplicate session')) {
        return NextResponse.json({ error: 'Session already exists' }, { status: 409 });
      }
      throw err;
    }

    emitSessionCreated(sessionName);

    return NextResponse.json({
      success: true,
      session: { name: sessionName, project }
    });
  } catch (error) {
    console.error('Failed to create session:', error);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }
}

// Kill a tmux session (and optionally destroy worktree)
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionName = searchParams.get('session');
    const destroyWorktree = searchParams.get('destroyWorktree') === 'true';
    const deleteBranch = searchParams.get('deleteBranch') === 'true';

    if (!sessionName) {
      return NextResponse.json({ error: 'Session name required' }, { status: 400 });
    }

    // Kill the tmux session
    await execAsync(`tmux kill-session -t "${sessionName}"`);

    emitSessionDeleted(sessionName);

    // Dead workers must not "speak" for any window — nuke activity, conversation,
    // and presenter-history files immediately rather than waiting for the
    // periodic cleanup to catch them.
    cleanupSessionFiles(sessionName);

    // If requested, also destroy the worktree
    if (destroyWorktree) {
      const { path: projectPath, project, isWorktree } = await getProjectPath(sessionName);

      if (isWorktree && existsSync(projectPath)) {
        // Construct URL for worktrees API
        const worktreeApiUrl = `http://localhost:3005/api/worktrees?path=${encodeURIComponent(projectPath)}&deleteBranch=${deleteBranch}`;

        try {
          // Call the worktrees API to properly clean up
          const response = await fetch(worktreeApiUrl, { method: 'DELETE' });
          if (!response.ok) {
            console.error('[Sessions] Failed to destroy worktree via API');
          }
        } catch (err) {
          console.error('[Sessions] Error calling worktrees API:', err);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to kill session:', error);
    return NextResponse.json({ error: 'Failed to kill session' }, { status: 500 });
  }
}
