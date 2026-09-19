import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const runtime = 'nodejs';

/**
 * Send Escape key to a tmux session to interrupt/pause the running agent.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Missing sessionId' }, { status: 400 });
    }

    // Check if session exists
    try {
      await execAsync(`tmux has-session -t "${sessionId}"`);
    } catch {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    // Send Escape key via tmux send-keys (not paste-buffer)
    await execAsync(`tmux send-keys -t "${sessionId}" Escape`);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('send-escape error:', err);
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal error'
    }, { status: 500 });
  }
}
