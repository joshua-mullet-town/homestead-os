import { NextRequest, NextResponse } from 'next/server';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { readdir, stat, readFile, writeFile, mkdir, rm, copyFile, rename } from 'fs/promises';
import path from 'path';
import { getCodeDir, getWorktreesDir } from '@/lib/get-code-dir';

const execAsync = promisify(exec);

// Get CODE_DIR and WORKTREES_DIR from config
function getDirs() {
  return {
    CODE_DIR: getCodeDir(),
    WORKTREES_DIR: getWorktreesDir()
  };
}

interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
  project: string;
  lastModified?: string;  // ISO timestamp of last activity (from .git/index)
}

interface WorktreeCreateRequest {
  sourceProject: string;  // The main project to branch from
  branchName: string;     // New branch name
}

/**
 * GET /api/worktrees
 *
 * Lists all worktrees, organized by project.
 * Only returns worktrees for "main" projects (those with .git as a directory),
 * avoiding duplicates from worktrees which have .git as a file.
 */
export async function GET() {
  try {
    const { CODE_DIR } = getDirs();
    const worktrees: Record<string, WorktreeInfo[]> = {};

    // Get all projects in code directory
    const codeDirEntries = await readdir(CODE_DIR, { withFileTypes: true });
    const projectDirs = codeDirEntries
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name);

    // For each project, get worktree info
    for (const project of projectDirs) {
      const projectPath = path.join(CODE_DIR, project);
      const gitPath = path.join(projectPath, '.git');

      // Check if it's a git repo
      if (!existsSync(gitPath)) {
        continue;
      }

      // Check if this is a worktree (not the main repo)
      // Main repos have .git as a directory
      // Worktrees have .git as a file pointing to the main repo
      const gitStat = await stat(gitPath);
      if (!gitStat.isDirectory()) {
        // This is a worktree, skip it - we'll get it from the main repo
        continue;
      }

      try {
        // Get worktree list for this repo
        const { stdout } = await execAsync(`git worktree list --porcelain`, { cwd: projectPath });

        const trees: WorktreeInfo[] = [];
        let currentTree: Partial<WorktreeInfo> = {};

        for (const line of stdout.split('\n')) {
          if (line.startsWith('worktree ')) {
            if (currentTree.path) {
              trees.push(currentTree as WorktreeInfo);
            }
            currentTree = { path: line.slice(9), project };
          } else if (line.startsWith('HEAD ')) {
            currentTree.commit = line.slice(5, 12); // Short hash
          } else if (line.startsWith('branch ')) {
            currentTree.branch = line.slice(7).replace('refs/heads/', '');
            currentTree.isMain = currentTree.path === projectPath;
          }
        }

        if (currentTree.path) {
          trees.push(currentTree as WorktreeInfo);
        }

        // Add lastModified for each worktree by checking .git/index or .git file
        for (const tree of trees) {
          try {
            // For main repo, check .git/index
            // For worktrees, check the .git file's parent's index
            const gitPath = path.join(tree.path, '.git');
            if (existsSync(gitPath)) {
              const gitStat = await stat(gitPath);
              if (gitStat.isDirectory()) {
                // Main repo - check .git/index
                const indexPath = path.join(gitPath, 'index');
                if (existsSync(indexPath)) {
                  const indexStat = await stat(indexPath);
                  tree.lastModified = indexStat.mtime.toISOString();
                }
              } else {
                // Worktree - .git is a file, check the worktree's own index
                const gitContent = await readFile(gitPath, 'utf-8');
                const match = gitContent.match(/gitdir:\s*(.+)/);
                if (match) {
                  const worktreeGitDir = match[1].trim();
                  const indexPath = path.join(worktreeGitDir, 'index');
                  if (existsSync(indexPath)) {
                    const indexStat = await stat(indexPath);
                    tree.lastModified = indexStat.mtime.toISOString();
                  }
                }
              }
            }
          } catch (e) {
            // Skip if we can't get mtime
          }
        }

        if (trees.length > 0) {
          worktrees[project] = trees;
        }
      } catch (err) {
        // Not a git repo or other error, skip
        console.log(`[Worktrees] Skipping ${project}:`, err);
      }
    }

    return NextResponse.json({ worktrees });
  } catch (error) {
    console.error('[Worktrees] Failed to list:', error);
    return NextResponse.json({ error: 'Failed to list worktrees' }, { status: 500 });
  }
}

/**
 * POST /api/worktrees
 *
 * Creates a new worktree with a new branch
 */
export async function POST(request: NextRequest) {
  try {
    const { CODE_DIR, WORKTREES_DIR } = getDirs();
    const { sourceProject, branchName }: WorktreeCreateRequest = await request.json();

    if (!sourceProject || !branchName) {
      return NextResponse.json({ error: 'sourceProject and branchName required' }, { status: 400 });
    }

    // Sanitize branch name
    const safeBranch = branchName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();

    const sourceDir = path.join(CODE_DIR, sourceProject);
    const worktreeDir = path.join(WORKTREES_DIR, sourceProject, safeBranch);

    // Check source exists and is a git repo
    if (!existsSync(path.join(sourceDir, '.git'))) {
      return NextResponse.json({ error: 'Source project is not a git repo' }, { status: 400 });
    }

    // Check if worktree already exists
    if (existsSync(worktreeDir)) {
      return NextResponse.json({ error: 'Worktree already exists' }, { status: 409 });
    }

    // Create worktrees parent directory
    await mkdir(path.join(WORKTREES_DIR, sourceProject), { recursive: true });

    // Fetch latest from origin to ensure we branch from up-to-date code
    try {
      await execAsync('git fetch origin 2>&1', { cwd: sourceDir, timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
      console.log('[Worktrees] Fetched origin');
    } catch (fetchErr) {
      console.log('[Worktrees] Could not fetch origin:', fetchErr);
      // Continue anyway - might be offline or no remote
    }

    // Determine base branch (origin/main or origin/master)
    let baseBranchRef = 'HEAD';
    try {
      const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null', { cwd: sourceDir });
      baseBranchRef = stdout.trim().replace('refs/remotes/', '');
      console.log('[Worktrees] Using base branch:', baseBranchRef);
    } catch {
      // Try common defaults
      try {
        await execAsync('git rev-parse origin/main', { cwd: sourceDir });
        baseBranchRef = 'origin/main';
      } catch {
        try {
          await execAsync('git rev-parse origin/master', { cwd: sourceDir });
          baseBranchRef = 'origin/master';
        } catch {
          console.log('[Worktrees] No origin/main or origin/master, using HEAD');
        }
      }
    }

    // Create new branch from origin's default branch and worktree
    // Redirect BOTH stdout AND stderr to /dev/null — git sends verbose per-file checkout
    // progress to stderr, which can exceed the OS pipe buffer (64KB on macOS) and cause
    // the process to block on write, hanging the API response indefinitely.
    await execAsync(`git worktree add -b "${branchName}" "${worktreeDir}" "${baseBranchRef}" > /dev/null 2>&1`, { cwd: sourceDir, maxBuffer: 10 * 1024 * 1024 });

    // Copy ALL .env* files AND secrets.local.yaml files (gitignored config secrets)
    // Use -prune to skip node_modules/.next entirely — -not -path still traverses them,
    // which takes minutes for repos with 50k+ files in node_modules.
    try {
      const { stdout: envOutput } = await execAsync(
        'find . -maxdepth 3 \\( -path "*/node_modules" -o -path "*/.next" \\) -prune -o \\( -name ".env*" -o -name "secrets.local.yaml" \\) -type f -print',
        { cwd: sourceDir, timeout: 10000 }
      );
      const secretFiles = envOutput.trim().split('\n').filter(Boolean);
      for (const relPath of secretFiles) {
        const srcPath = path.join(sourceDir, relPath);
        const dstPath = path.join(worktreeDir, relPath);
        if (existsSync(srcPath)) {
          await mkdir(path.dirname(dstPath), { recursive: true });
          await copyFile(srcPath, dstPath);
          console.log(`[Worktrees] Copied ${relPath}`);
        }
      }
    } catch (envErr) {
      console.log('[Worktrees] secret/env copy failed:', envErr);
    }

    // Create metadata file BEFORE slow operations so the worktree is immediately usable
    // Get base branch
    let baseBranch = 'main';
    try {
      const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "refs/heads/main"', { cwd: sourceDir });
      baseBranch = stdout.trim().replace('refs/remotes/origin/', '').replace('refs/heads/', '');
    } catch {
      // Default to main
    }

    const metadata = {
      project: sourceProject,
      branch: branchName,
      baseBranch,
      mainRepoPath: sourceDir,
      created: new Date().toISOString(),
    };
    // Use same filename as /worktree skill for compatibility
    await writeFile(
      path.join(worktreeDir, '.worktree-meta.json'),
      JSON.stringify(metadata, null, 2)
    );

    // Copy node_modules in the BACKGROUND — don't block the API response.
    // Even with APFS CoW (cp -c), copying 50k+ small files takes minutes
    // due to per-file metadata operations. The worktree is functional without
    // node_modules; the session can start while the copy completes.
    const srcModules = path.join(sourceDir, 'node_modules');
    const dstModules = path.join(worktreeDir, 'node_modules');
    if (existsSync(srcModules)) {
      console.log('[Worktrees] Starting background node_modules copy with CoW...');
      execAsync(`cp -cR "${srcModules}" "${dstModules}"`)
        .then(() => console.log(`[Worktrees] node_modules copied for ${safeBranch}`))
        .catch(() => {
          console.log('[Worktrees] CoW copy failed, trying regular copy...');
          return execAsync(`cp -R "${srcModules}" "${dstModules}"`);
        })
        .then(() => {
          // Run project-specific setup after node_modules is ready
          const setupScript = path.join(sourceDir, '.claude', 'worktree-setup.sh');
          if (existsSync(setupScript)) {
            console.log('[Worktrees] Running worktree-setup.sh');
            return execAsync(`bash "${setupScript}"`, { cwd: worktreeDir });
          }
        })
        .catch((err) => console.log('[Worktrees] Background setup failed:', err));
    } else {
      // No node_modules to copy, but still run setup script if it exists
      const setupScript = path.join(sourceDir, '.claude', 'worktree-setup.sh');
      if (existsSync(setupScript)) {
        console.log('[Worktrees] Running worktree-setup.sh');
        execAsync(`bash "${setupScript}"`, { cwd: worktreeDir })
          .catch((err) => console.log('[Worktrees] Setup script failed:', err));
      }
    }

    return NextResponse.json({
      success: true,
      worktree: {
        path: worktreeDir,
        branch: branchName,
        project: sourceProject,
      }
    });
  } catch (error) {
    console.error('[Worktrees] Failed to create:', error);
    return NextResponse.json({
      error: 'Failed to create worktree',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}

/**
 * DELETE /api/worktrees?path=/path/to/worktree&deleteBranch=true
 *
 * Removes a worktree and optionally its branch
 */
export async function DELETE(request: NextRequest) {
  try {
    const { CODE_DIR, WORKTREES_DIR } = getDirs();
    const { searchParams } = new URL(request.url);
    const worktreePath = searchParams.get('path');
    const deleteBranch = searchParams.get('deleteBranch') === 'true';

    if (!worktreePath) {
      return NextResponse.json({ error: 'Worktree path required' }, { status: 400 });
    }

    // Security: Only allow deleting from worktrees dir OR code dir
    // But never allow deleting the main repo (where .git is a directory)
    const isInWorktreesDir = worktreePath.startsWith(WORKTREES_DIR);
    const isInCodeDir = worktreePath.startsWith(CODE_DIR);

    if (!isInWorktreesDir && !isInCodeDir) {
      return NextResponse.json({ error: 'Can only delete worktrees from ~/.worktrees or ~/code' }, { status: 403 });
    }

    // Check if this is actually a worktree (not a main repo)
    // Worktrees have .git as a FILE, main repos have .git as a DIRECTORY
    const gitPath = path.join(worktreePath, '.git');
    if (existsSync(gitPath)) {
      const gitStat = await stat(gitPath);
      if (gitStat.isDirectory()) {
        return NextResponse.json({ error: 'Cannot delete main repository, only worktrees' }, { status: 403 });
      }
    }

    // Read metadata to get branch name and source project
    // Check both filenames for compatibility with /worktree skill
    const metadataPathNew = path.join(worktreePath, '.worktree-meta.json');
    const metadataPathOld = path.join(worktreePath, '.worktree-metadata.json');
    const metadataPath = existsSync(metadataPathNew) ? metadataPathNew : metadataPathOld;
    let branchName: string | null = null;
    let sourceProject: string | null = null;

    if (existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(await readFile(metadataPath, 'utf-8'));
        branchName = metadata.branch;
        sourceProject = metadata.project || metadata.sourceProject; // Handle both formats
      } catch (err) {
        console.log('[Worktrees] Could not read metadata:', err);
      }
    }

    // Try to get branch name from git if metadata is missing
    if (!branchName && existsSync(worktreePath)) {
      try {
        const { stdout } = await execAsync('git branch --show-current', { cwd: worktreePath });
        branchName = stdout.trim();
      } catch (err) {
        console.log('[Worktrees] Could not get branch from git:', err);
      }
    }

    // Find the main repo to run worktree remove command
    let mainRepoPath: string | null = null;
    if (sourceProject) {
      mainRepoPath = path.join(CODE_DIR, sourceProject);
    } else if (isInWorktreesDir) {
      // Path format: ~/.worktrees/{project}/{branch}
      const pathParts = worktreePath.replace(WORKTREES_DIR + '/', '').split('/');
      if (pathParts.length >= 1) {
        mainRepoPath = path.join(CODE_DIR, pathParts[0]);
      }
    } else if (isInCodeDir) {
      // For worktrees in code dir, read the .git file to find main repo
      try {
        const gitContent = await readFile(gitPath, 'utf-8');
        // Format: "gitdir: /path/to/main/.git/worktrees/branch-name"
        const match = gitContent.match(/gitdir:\s*(.+)/);
        if (match) {
          const gitDir = match[1].trim();
          // Extract main repo path from worktree gitdir
          const mainGitDir = gitDir.replace(/\/\.git\/worktrees\/.*$/, '');
          if (existsSync(mainGitDir)) {
            mainRepoPath = mainGitDir;
          }
        }
      } catch (err) {
        console.log('[Worktrees] Could not read .git file:', err);
      }
    }

    if (mainRepoPath && existsSync(mainRepoPath)) {
      // Unlock worktree first (in case it's locked)
      try {
        await execAsync(`git worktree unlock "${worktreePath}"`, { cwd: mainRepoPath });
        console.log('[Worktrees] Unlocked worktree');
      } catch (err) {
        // Not locked, that's fine
        console.log('[Worktrees] Worktree was not locked (or unlock failed):', err);
      }

      // Remove worktree using git command
      let gitRemoved = false;
      try {
        await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: mainRepoPath });
        console.log('[Worktrees] Removed worktree via git');
        gitRemoved = true;
      } catch (err) {
        console.log('[Worktrees] git worktree remove failed (orphaned or locked)');
      }

      // If git didn't remove the directory, rename it out of the way instantly
      // then background-delete the renamed dir (huge node_modules = slow rm)
      if (!gitRemoved && existsSync(worktreePath)) {
        const trashPath = `${worktreePath}__deleting_${Date.now()}`;
        try {
          await rename(worktreePath, trashPath);
          console.log('[Worktrees] Renamed to trash path for background deletion');
          spawn('rm', ['-rf', trashPath], { detached: true, stdio: 'ignore' }).unref();
        } catch (renameErr) {
          // Rename failed — try direct rm as last resort (still backgrounded)
          console.log('[Worktrees] Rename failed, backgrounding direct rm');
          spawn('rm', ['-rf', worktreePath], { detached: true, stdio: 'ignore' }).unref();
        }
      }

      // Optionally delete the branch
      if (deleteBranch && branchName) {
        try {
          await execAsync(`git branch -D "${branchName}"`, { cwd: mainRepoPath });
          console.log(`[Worktrees] Deleted branch: ${branchName}`);
        } catch (err) {
          console.log('[Worktrees] Could not delete branch:', err);
        }
      }

      // Prune worktree references
      try {
        await execAsync('git worktree prune', { cwd: mainRepoPath });
      } catch (err) {
        console.log('[Worktrees] Prune failed:', err);
      }
    } else {
      // Just delete the directory if we can't find the main repo
      // Use instant rename + background delete pattern
      const trashPath = `${worktreePath}__deleting_${Date.now()}`;
      try {
        await rename(worktreePath, trashPath);
        spawn('rm', ['-rf', trashPath], { detached: true, stdio: 'ignore' }).unref();
      } catch (renameErr) {
        spawn('rm', ['-rf', worktreePath], { detached: true, stdio: 'ignore' }).unref();
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Worktrees] Failed to delete:', error);
    return NextResponse.json({ error: 'Failed to delete worktree' }, { status: 500 });
  }
}
