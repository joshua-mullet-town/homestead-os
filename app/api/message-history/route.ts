import { NextRequest, NextResponse } from 'next/server';
// Transport-agnostic message-history store (plain-JS CommonJS module).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const messageHistory = require('@/lib/message-history-store');

/**
 * Message History read endpoint (closes the RCS on-demand thread-read gap).
 *
 *   GET /api/message-history?contact=<number-or-name>&limit=<N>
 *
 * Returns a contact's thread history transport-agnostically — SMS AND RCS bodies
 * alike, because the store is populated from the notification tray (via the
 * real-time ingest push + the 5-min backstop cron), NOT the SMS content provider.
 *
 * `contact` matches by phone number (any format — "(616) 406-8841", "+16164068841",
 * "6164068841" all match) OR by display-name substring. Ambiguous name matches
 * return `candidates` instead of a thread.
 *
 * History is forward-from-ship: messages that arrived AFTER this store went live.
 * It does not retroactively recover already-cleared past messages.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const contact = searchParams.get('contact') || searchParams.get('q') || '';
  const limitRaw = searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 50)) : 50;

  if (!contact.trim()) {
    return NextResponse.json(
      { ok: false, error: 'missing required query param: contact (phone number or name)' },
      { status: 400 }
    );
  }

  try {
    const result = messageHistory.readThread(contact, limit);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[MsgHistory] read failed:', err);
    return NextResponse.json({ ok: false, error: 'read failed' }, { status: 500 });
  }
}
