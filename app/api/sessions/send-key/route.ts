import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const runtime = 'nodejs';

/**
 * Send raw key sequences to a tmux session.
 * Used for special keys like Enter, Escape, Ctrl+C, arrow keys, etc.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId, key } = body;

    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Missing sessionId' }, { status: 400 });
    }

    if (!key) {
      return NextResponse.json({ success: false, error: 'Missing key' }, { status: 400 });
    }

    // Check if session exists
    try {
      await execAsync(`tmux has-session -t "${sessionId}"`);
    } catch {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    // Send the raw key sequence using tmux send-keys with -l for literal
    // For escape sequences, we need to send them properly
    try {
      // Use printf to handle escape sequences, then pipe to tmux
      // The key is already an escape sequence string from the client
      const escapedKey = key
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "'\\''");

      await execAsync(`printf '%s' '${escapedKey}' | tmux load-buffer - && tmux paste-buffer -t "${sessionId}"`);

      return NextResponse.json({ success: true });
    } catch (err) {
      console.error('Failed to send key:', err);
      return NextResponse.json({
        success: false,
        error: err instanceof Error ? err.message : 'Failed to send key'
      }, { status: 500 });
    }
  } catch (err) {
    console.error('send-key error:', err);
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal error'
    }, { status: 500 });
  }
}
