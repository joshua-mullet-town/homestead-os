import { NextRequest, NextResponse } from 'next/server';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const CODE_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code';
const WORKTREE_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/.worktrees';
const STEWARDS_DIR = join(homedir(), '.homestead', 'stewards');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const { searchParams } = new URL(request.url);
  const worktree = searchParams.get('worktree');
  const steward = searchParams.get('steward');

  // Steward mode: read CLAUDE.md (and any other .md files) from steward dir
  if (steward) {
    // Resolve steward directory — supports nested substewards via parent--child--grandchild format
    let stewardDir = join(STEWARDS_DIR, steward);

    if (!existsSync(stewardDir) && steward.includes('--')) {
      // Try resolving as nested substeward path: "rooster--watchdog" → "rooster/substewards/watchdog"
      const parts = steward.split('--');
      let resolvedPath = STEWARDS_DIR;
      for (let i = 0; i < parts.length; i++) {
        if (i === 0) {
          resolvedPath = join(resolvedPath, parts[i]);
        } else {
          resolvedPath = join(resolvedPath, 'substewards', parts[i]);
        }
      }
      if (existsSync(resolvedPath)) {
        stewardDir = resolvedPath;
      }
    }

    console.log('[API docs] Steward request:', { steward, stewardDir });

    if (!existsSync(stewardDir)) {
      return NextResponse.json({ error: 'Steward not found' }, { status: 404 });
    }

    try {
      // Read all .md files in the steward directory
      const entries = await readdir(stewardDir);
      const mdFiles = entries.filter(f => f.endsWith('.md'));

      const files: Record<string, string> = {};
      for (const file of mdFiles) {
        files[file] = await readFile(join(stewardDir, file), 'utf-8').catch(() => '');
      }

      // Also include plan/state as legacy fields for compatibility
      return NextResponse.json({
        plan: files['CLAUDE.md'] || '',
        state: '',
        stewardFiles: files,
      });
    } catch (error) {
      return NextResponse.json({ error: 'Failed to read steward docs' }, { status: 500 });
    }
  }

  // Standard mode: read PLAN.md and STATE.md from project/worktree dir
  const projectDir = worktree
    ? join(WORKTREE_DIR, project, worktree)
    : join(CODE_DIR, project);

  console.log('[API docs] Request:', { project, worktree, projectDir });

  try {
    const [plan, state] = await Promise.all([
      readFile(join(projectDir, 'PLAN.md'), 'utf-8').catch(() => ''),
      readFile(join(projectDir, 'STATE.md'), 'utf-8').catch(() => ''),
    ]);

    return NextResponse.json({ plan, state });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to read docs' },
      { status: 500 }
    );
  }
}
