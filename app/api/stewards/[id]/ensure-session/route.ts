import { NextResponse, type NextRequest } from 'next/server';

/**
 * POST /api/stewards/:id/ensure-session
 *
 * Ensures a steward's Claude Code session exists and is running.
 * Delegates to queue-dispatcher's ensureSession() — the single source of truth
 * for session creation, directory resolution, and claude restart logic.
 *
 * Returns { ok, sessionName, started, restarted }
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionName = `holler-${id}`;

  try {
    // Import the centralized session management from queue-dispatcher
    const dispatcher = require('../../../../../lib/queue-dispatcher');
    const result = dispatcher.ensureSession(sessionName);

    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
