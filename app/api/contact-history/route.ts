import { NextRequest, NextResponse } from 'next/server';
// TRUE on-demand per-contact history reader (reads the phone's REAL Messages store).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const contactHistory = require('@/lib/contact-history-reader');

/**
 * Contact History read endpoint — TRUE on-demand per-contact text HISTORY from the
 * phone's REAL Messages store, regardless of when the messages arrived.
 *
 *   GET /api/contact-history?contact=<number-or-name>&limit=<N>&rcs=<0|1>
 *
 * This is DISTINCT from /api/message-history:
 *   - /api/message-history reads the forward-buffer (notification-tray bodies
 *     persisted since capture went live). It returns nothing for a contact who
 *     hasn't texted since go-live (e.g. Mom/<<REPLACE: a family contact>> <<REPLACE: a phone number>>).
 *   - THIS endpoint reads the phone's REAL store on demand:
 *       * SMS — the Android Telephony SMS content provider (always, lock-independent).
 *       * RCS — an accessibility UI-scrape of the rendered Messages thread, which
 *         requires the phone to be awake/unlocked. When locked, returns an HONEST
 *         degraded status, never a false empty.
 *
 * Honesty rails (returned in the payload):
 *   1. SMS history is always readable (even locked).
 *   2. RCS history is readable only when the phone is awake/unlocked.
 *   3. Already-deleted messages cannot be recovered.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const contact = searchParams.get('contact') || searchParams.get('q') || '';
  const limitRaw = searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 50)) : 50;
  // rcs defaults ON; pass rcs=0 to skip the accessibility scrape entirely (SMS-only).
  const rcsParam = searchParams.get('rcs');
  const rcs = rcsParam === null ? true : !(rcsParam === '0' || rcsParam === 'false');

  if (!contact.trim()) {
    return NextResponse.json(
      { ok: false, error: 'missing required query param: contact (phone number or name)' },
      { status: 400 }
    );
  }

  try {
    const result = await contactHistory.readContactHistory(contact, { limit, rcs });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ContactHistory] read failed:', err);
    return NextResponse.json({ ok: false, error: 'read failed' }, { status: 500 });
  }
}
