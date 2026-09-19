import { NextRequest, NextResponse } from 'next/server';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emitSessionDeleted } = require('@/lib/emit-session-event');

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { sessionId } = body as { sessionId?: unknown; parent?: unknown };

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return NextResponse.json(
        { error: 'sessionId is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    // `parent` in the body is accepted for forward-compat but ignored — the
    // emit helper recomputes parent from the sessionId canonically so senders
    // and listeners always agree.
    emitSessionDeleted(sessionId);
    return NextResponse.json({ emitted: true, sessionId });
  } catch (err) {
    console.error('[api/emit/session-deleted] failed:', err);
    return NextResponse.json({ error: 'Failed to emit event' }, { status: 500 });
  }
}
