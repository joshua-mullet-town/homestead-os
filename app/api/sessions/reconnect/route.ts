import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { appendFileSync } from 'fs';

const execAsync = promisify(exec);
const TMUX_DEBUG_LOG = '/tmp/homestead-tmux-debug.log';

function debugLog(message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [API/reconnect] ${message}\n`;
  try {
    appendFileSync(TMUX_DEBUG_LOG, logLine);
  } catch { /* ignore */ }
  console.log(`[API/reconnect] ${message}`);
}

/**
 * POST /api/sessions/reconnect?session=xxx
 *
 * Attempts to force-reconnect to a tmux session by:
 * 1. Checking if tmux session exists
 * 2. Signaling that a fresh PTY attachment is needed
 * 3. Returning instructions for the frontend to dispose and recreate the terminal
 */
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionName = searchParams.get('session');

    debugLog(`Reconnect requested for: ${sessionName}`);

    if (!sessionName) {
      return NextResponse.json({ error: 'Session name required' }, { status: 400 });
    }

    // Check if the tmux session exists
    try {
      await execAsync(`tmux has-session -t "${sessionName}"`);
      debugLog(`Tmux session exists: ${sessionName}`);
    } catch {
      debugLog(`Tmux session does NOT exist: ${sessionName}`);
      return NextResponse.json({ error: 'Session does not exist in tmux' }, { status: 404 });
    }

    // Get tmux session info for debugging
    try {
      const { stdout } = await execAsync(`tmux list-clients -t "${sessionName}" 2>/dev/null || echo "no clients"`);
      debugLog(`Tmux clients for ${sessionName}: ${stdout.trim()}`);
    } catch { /* ignore */ }

    // NOTE: We intentionally do NOT send Ctrl+L here. This route tells the
    // frontend to dispose + recreate its terminal (below), which triggers a
    // fresh tmux:attach on the server — and THAT path already issues a single,
    // debounced screen-refresh (TmuxManager.writeCtrlL). Sending a raw C-l here
    // bypasses that debounce and would pair with the attach refresh, tripping
    // Claude Code's double-Ctrl+L -> /clear shortcut (context wipe).

    // The key insight: tell the frontend to completely dispose its terminal
    // and create a fresh one. This will cause a new socket connection and
    // fresh PTY attachment in the TmuxManager.
    return NextResponse.json({
      success: true,
      session: sessionName,
      action: 'force_recreate', // Signal to frontend to dispose and recreate
      message: 'Session exists. Frontend should dispose terminal and reconnect fresh.'
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    debugLog(`Reconnect failed: ${errorMessage}`);
    console.error('Failed to reconnect session:', error);
    return NextResponse.json({ error: 'Failed to reconnect session' }, { status: 500 });
  }
}
