import { NextRequest, NextResponse } from 'next/server';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emitSessionCreated } = require('@/lib/emit-session-event');

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { sessionId, createdAt } = body as { sessionId?: unknown; createdAt?: unknown };

    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return NextResponse.json(
        { error: 'sessionId is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    const extra: { createdAt?: number } = {};
    if (typeof createdAt === 'number' && Number.isFinite(createdAt)) {
      extra.createdAt = createdAt;
    }

    emitSessionCreated(sessionId, extra);
    return NextResponse.json({ emitted: true, sessionId });
  } catch (err) {
    console.error('[api/emit/session-created] failed:', err);
    return NextResponse.json({ error: 'Failed to emit event' }, { status: 500 });
  }
}
