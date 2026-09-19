import { NextRequest, NextResponse } from 'next/server';
import { readdir, writeFile, unlink } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { existsSync } from 'fs';
import { getCodeDir } from '@/lib/get-code-dir';
import { tmpdir } from 'os';
import { join } from 'path';
import { homedir } from 'os';

async function getActiveSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null');
    return stdout.trim().split('\n').filter(name => name.startsWith('holler-'));
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send text to a tmux session using load-buffer + paste-buffer + Enter.
 * This avoids the issue where `tmux send-keys 'text' Enter` triggers
 * Claude Code's autocomplete instead of submitting the input.
 */
async function sendToSession(session: string, text: string): Promise<void> {
  const tempFile = join(tmpdir(), `restart-${session}-${Date.now()}.txt`);
  try {
    await writeFile(tempFile, text);
    await execAsync(`tmux load-buffer "${tempFile}" 2>/dev/null`);
    await execAsync(`tmux paste-buffer -t "${session}" 2>/dev/null`);
    await sleep(500);
    await execAsync(`tmux send-keys -t "${session}" Enter 2>/dev/null`);
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}

/**
 * Derive the project directory from a session name.
 * Mirrors the logic in server.js ensureSession() + special sessions:
 *   holler-{project}--{branch}       → ~/.worktrees/{project}/{branch}
 *   holler-{steward}                  → ~/.homestead/stewards/{steward}
 *   holler-guest-{shortName}          → ~/.homestead/guest-sessions/{shortName}
 *   holler-gp-{shortName}-{session}   → ~/.homestead/guest-sessions/{shortName}/{session}
 *   holler-{project}                  → ~/code/{project}
 */
function getProjectDir(sessionName: string, codeDir: string): string | null {
  const home = homedir();
  const worktreesDir = join(home, '.worktrees');
  const homesteadDir = join(home, '.homestead');
  const nameWithoutPrefix = sessionName.replace(/^holler-/, '');

  // Worktree sessions: holler-{project}--{branch}
  if (nameWithoutPrefix.includes('--')) {
    const [project, branch] = nameWithoutPrefix.split('--');
    const worktreePath = join(worktreesDir, project, branch);
    if (existsSync(worktreePath)) return worktreePath;
    const fallback = join(codeDir, nameWithoutPrefix);
    if (existsSync(fallback)) return fallback;
    return null;
  }

  // Guest shared sessions: holler-guest-{shortName}
  if (nameWithoutPrefix.startsWith('guest-')) {
    const shortName = nameWithoutPrefix.replace('guest-', '');
    const dir = join(homesteadDir, 'guest-sessions', shortName);
    return existsSync(dir) ? dir : null;
  }

  // Guest personal sessions: holler-gp-{shortName}-{session}
  if (nameWithoutPrefix.startsWith('gp-')) {
    const rest = nameWithoutPrefix.replace('gp-', '');
    // shortName is first segment, session name is the rest
    const parts = rest.split('-');
    // Try progressively longer shortName prefixes
    for (let i = 1; i < parts.length; i++) {
      const shortName = parts.slice(0, i).join('-');
      const sessionName = parts.slice(i).join('-');
      const dir = join(homesteadDir, 'guest-sessions', shortName, sessionName);
      if (existsSync(dir)) return dir;
    }
    return null;
  }

  // Steward sessions: check ~/.homestead/stewards/{name}
  const stewardDir = join(homesteadDir, 'stewards', nameWithoutPrefix);
  if (existsSync(stewardDir)) return stewardDir;

  // Standard dev sessions: ~/code/{project}
  const projectDir = join(codeDir, nameWithoutPrefix);
  if (existsSync(projectDir)) return projectDir;
  return null;
}

/**
 * POST /api/claude-sessions/restart-all
 *
 * Gracefully restarts all active Claude Code sessions.
 * Each session is restarted in its original project directory with
 * the same flags it was created with (matching server.js ensureSession).
 *
 * Flow per session:
 * 1. Send Ctrl+C to interrupt any running operation
 * 2. Send /exit to gracefully exit Claude
 * 3. Wait for Claude to exit (zsh keeps tmux alive)
 * 4. cd to the correct project directory
 * 5. Inject the restart command with all flags
 *
 * Query params:
 *   ?exclude=session1,session2 — skip specific sessions
 *   ?only=session1,session2 — only restart these sessions
 *   ?dry=true — just list what would be restarted
 */
export async function POST(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const excludeParam = searchParams.get('exclude') || '';
  const onlyParam = searchParams.get('only') || '';
  const dryRun = searchParams.get('dry') === 'true';

  const exclude = excludeParam ? excludeParam.split(',').map(s => s.trim()) : [];
  const only = onlyParam ? onlyParam.split(',').map(s => s.trim()) : [];

  // Get all active holler sessions
  let sessions = await getActiveSessions();

  // Filter out ephemeral workers — those restart on their own
  sessions = sessions.filter(s => !s.startsWith('ephemeral-'));

  // Apply exclude/only filters
  if (only.length > 0) {
    sessions = sessions.filter(s => only.includes(s));
  }
  if (exclude.length > 0) {
    sessions = sessions.filter(s => !exclude.includes(s));
  }

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      sessions,
      count: sessions.length,
    });
  }

  if (sessions.length === 0) {
    return NextResponse.json({ restarted: [], count: 0, message: 'No sessions to restart' });
  }

  // Build the --add-dir flags (shared across all sessions, same as server.js)
  const codeDir = getCodeDir();
  let addDirFlags = '';
  try {
    const entries = await readdir(codeDir, { withFileTypes: true });
    addDirFlags = entries
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => `--add-dir '${codeDir}/${d.name}'`)
      .join(' ');
  } catch { /* no add-dir flags if we can't list */ }

  const results: { session: string; status: string; projectDir?: string }[] = [];

  for (const session of sessions) {
    try {
      // Resolve the original project directory for this session
      const projectDir = getProjectDir(session, codeDir);
      if (!projectDir) {
        results.push({ session, status: `error: could not resolve project dir` });
        continue;
      }

      // Step 1: Send Ctrl+C to interrupt anything running
      await execAsync(`tmux send-keys -t "${session}" C-c 2>/dev/null`);
      await sleep(500);

      // Step 2: Send /exit using load-buffer + paste-buffer + Enter
      // (tmux send-keys with Enter triggers Claude's autocomplete instead of submitting)
      await sendToSession(session, '/exit');

      // Step 3: Wait for Claude to exit (check for zsh prompt)
      let exited = false;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        try {
          const { stdout: pane } = await execAsync(`tmux capture-pane -t "${session}" -p -S -5 2>/dev/null`);
          // Look for zsh prompt indicators that Claude has fully exited
          // Claude Code also shows ❯ so we need the full prompt pattern (╰─ or %)
          if (pane.includes('╰─') || pane.match(/\n%\s/) || pane.match(/\$\s*$/m)) {
            exited = true;
            break;
          }
        } catch {
          // Session might have died
          break;
        }
      }

      if (!exited) {
        // Force kill Claude process inside tmux and wait
        await execAsync(`tmux send-keys -t "${session}" C-c C-c 2>/dev/null`);
        await sleep(1000);
        await sendToSession(session, 'exit');
        await sleep(500);
      }

      // Step 4: cd to the correct project directory first
      await sleep(300);
      await sendToSession(session, `cd '${projectDir}'`);
      await sleep(300);

      // Step 5: Start Claude with the same flags as ensureSession()
      // The command runs inside zsh which has the user's full PATH (nvm etc)
      const baseFlags = `--dangerously-skip-permissions ${addDirFlags}`;
      const restartCommand = `claude ${baseFlags} --continue || claude ${baseFlags}`;
      await sendToSession(session, restartCommand);

      results.push({ session, status: 'restarted', projectDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ session, status: `error: ${msg}` });
    }
  }

  return NextResponse.json({
    restarted: results.filter(r => r.status === 'restarted').map(r => r.session),
    errors: results.filter(r => r.status !== 'restarted'),
    count: results.filter(r => r.status === 'restarted').length,
    totalAttempted: sessions.length,
  });
}
