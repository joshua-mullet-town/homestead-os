import { NextRequest, NextResponse } from 'next/server';
// Reads Josh's recent outbound walkie sends from the walkie-talkie's own
// existing queue log (live queue + rolling archives). No new tracker.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const joshSends = require('@/lib/josh-walkie-sends');

/**
 * Recency/frequency ring data.
 *
 *   GET /api/recency-ring?limit=<N>   (default 30, clamped 1..100)
 *
 * Returns the ring's fuel: Josh's last N outbound walkie sends attributed to
 * the top-level steward each went to.
 *
 *   {
 *     ok: true,
 *     limit: 30,
 *     total: 30,                       // how many sends we actually found
 *     ordered: ["rooster","homestead", ...],  // newest-first steward ids
 *     counts: { rooster: 7, homestead: 8, ... }
 *   }
 *
 * The presenter recomputes this on each Josh-send (walkie:enqueued) and repaints
 * the faint ring around each steward icon. `ordered` drives recency-clockwise
 * fill; `counts` drives count-based fill.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limitRaw = searchParams.get('limit');
  const limit = limitRaw
    ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 30))
    : 30;

  try {
    const ring = joshSends.getRecencyRing(limit);
    return NextResponse.json({ ok: true, ...ring });
  } catch (err) {
    console.error('[recency-ring] read failed:', err);
    return NextResponse.json({ ok: false, error: 'read failed' }, { status: 500 });
  }
}
