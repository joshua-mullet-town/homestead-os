import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/navigate
 *
 * Broadcasts a navigation event to all connected Socket.IO clients.
 * Used by the mobile app to switch the Mac's browser to a specific session.
 *
 * Body: { path: "/session/holler-homestead/terminal" }
 */
export async function POST(request: NextRequest) {
  try {
    const { path } = await request.json();

    if (!path) {
      return NextResponse.json({ error: 'path required' }, { status: 400 });
    }

    const io = (global as any).io;
    if (!io) {
      return NextResponse.json({ error: 'Socket.IO not available' }, { status: 503 });
    }

    // Broadcast to all connected clients
    io.emit('navigate', { path });

    return NextResponse.json({ success: true, path });
  } catch (error) {
    console.error('Navigate error:', error);
    return NextResponse.json({ error: 'Failed to broadcast navigation' }, { status: 500 });
  }
}
