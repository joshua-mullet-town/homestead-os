import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * POST /api/tmux-mouse
 * Toggle tmux mouse mode for a session.
 * Body: { session: "holler-homestead", enabled: boolean }
 */
export async function POST(request: NextRequest) {
  try {
    const { session, enabled } = await request.json();

    if (!session) {
      return NextResponse.json({ error: 'Missing session' }, { status: 400 });
    }

    const mode = enabled ? 'on' : 'off';
    await execAsync(`tmux set -t "${session}" mouse ${mode}`, { timeout: 5000 });

    return NextResponse.json({ success: true, mouse: mode });
  } catch (err) {
    console.error('[tmux-mouse] Error:', err);
    return NextResponse.json({ error: 'Failed to toggle mouse mode' }, { status: 500 });
  }
}
