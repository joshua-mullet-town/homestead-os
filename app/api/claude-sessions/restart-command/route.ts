import { NextResponse } from 'next/server';
import { readdir } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getCodeDir } from '@/lib/get-code-dir';

const execAsync = promisify(exec);

async function resolveClaudePath(): Promise<string> {
  try {
    const { stdout } = await execAsync('which claude');
    return stdout.trim();
  } catch {
    return '<<REPLACE: your home dir, e.g. /Users/you>>/.local/bin/claude';
  }
}

/**
 * GET /api/claude-sessions/restart-command
 *
 * Returns the command to restart Claude Code with all the --add-dir flags.
 * This is called from inside tmux to restart claude.
 */
export async function GET() {
  try {
    const codeDir = getCodeDir();
    const claudePath = await resolveClaudePath();

    const entries = await readdir(codeDir, { withFileTypes: true });
    const dirs = entries
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => `${codeDir}/${d.name}`);

    const addDirFlags = dirs.map(d => `--add-dir '${d}'`).join(' ');
    const command = `${claudePath} --dangerously-skip-permissions ${addDirFlags} --continue`;

    return NextResponse.json({ command });
  } catch (error) {
    console.error('[restart-command] Failed to build command:', error);
    const claudePath = await resolveClaudePath();
    return NextResponse.json({
      command: `${claudePath} --continue`,
      error: 'Failed to build full command, using fallback'
    });
  }
}
