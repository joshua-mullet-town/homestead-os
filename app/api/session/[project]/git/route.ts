import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execAsync = promisify(exec);
const CODE_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code';
const WORKTREE_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/.worktrees';

interface FileChange {
  file: string;
  status: string; // M, A, D, ?, etc.
  additions: number;
  deletions: number;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const { searchParams } = new URL(request.url);
  const worktree = searchParams.get('worktree');

  // Determine project directory based on whether it's a worktree
  const projectDir = worktree
    ? join(WORKTREE_DIR, project, worktree)
    : join(CODE_DIR, project);

  try {
    const [statusResult, diffStatResult, branchResult, diffNumstatResult] = await Promise.all([
      execAsync('git status --short', { cwd: projectDir }).catch(() => ({ stdout: '' })),
      execAsync('git diff --stat', { cwd: projectDir }).catch(() => ({ stdout: '' })),
      execAsync('git branch --show-current', { cwd: projectDir }).catch(() => ({ stdout: 'unknown' })),
      execAsync('git diff --numstat', { cwd: projectDir }).catch(() => ({ stdout: '' })),
    ]);

    // Parse status to get file list with status codes
    const statusLines = statusResult.stdout.trim().split('\n').filter(Boolean);
    const files: FileChange[] = [];

    // Parse numstat for additions/deletions
    const numstatMap = new Map<string, { add: number; del: number }>();
    diffNumstatResult.stdout.trim().split('\n').filter(Boolean).forEach(line => {
      const [add, del, file] = line.split('\t');
      if (file) {
        numstatMap.set(file, {
          add: add === '-' ? 0 : parseInt(add) || 0,
          del: del === '-' ? 0 : parseInt(del) || 0,
        });
      }
    });

    // Combine status with numstat
    statusLines.forEach(line => {
      const status = line.substring(0, 2).trim();
      const file = line.substring(3).trim();
      // Skip .next directory files
      if (file.startsWith('.next/')) return;

      const stats = numstatMap.get(file) || { add: 0, del: 0 };
      files.push({
        file,
        status,
        additions: stats.add,
        deletions: stats.del,
      });
    });

    // Calculate totals
    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
    const totalFiles = files.length;

    return NextResponse.json({
      branch: branchResult.stdout.trim(),
      files,
      summary: {
        totalFiles,
        totalAdditions,
        totalDeletions,
      },
      // Keep raw diff for detailed view
      rawDiff: diffStatResult.stdout.trim(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to get git info' },
      { status: 500 }
    );
  }
}

// Endpoint to get diff for a specific file
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const { searchParams } = new URL(request.url);
  const worktree = searchParams.get('worktree');

  // Determine project directory based on whether it's a worktree
  const projectDir = worktree
    ? join(WORKTREE_DIR, project, worktree)
    : join(CODE_DIR, project);

  const { file } = await request.json();

  try {
    const { stdout } = await execAsync(`git diff -- "${file}"`, {
      cwd: projectDir,
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer for large diffs
    });

    return NextResponse.json({ diff: stdout });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to get file diff' },
      { status: 500 }
    );
  }
}
