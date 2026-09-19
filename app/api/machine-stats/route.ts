import { NextResponse } from 'next/server';

// Plain JS libs (shared with server.js), required rather than imported so the
// same modules serve both the Next route and the node server.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getMachineStats } = require('@/lib/machine-stats');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  recordSample,
  readHistory,
} = require('@/lib/machine-stats-history');

/**
 * GET /api/machine-stats
 *
 * Everything the Presenter's diagnostics screen needs, in one call:
 * accurate instantaneous CPU split by who is using it, process counts,
 * honest memory figures, and a rolling history for the charts.
 *
 * `?history=0` skips the history payload for the lightweight topbar poll.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const wantHistory = url.searchParams.get('history') !== '0';

    const stats = await getMachineStats();
    recordSample(stats);

    return NextResponse.json({
      ...stats,
      history: wantHistory ? readHistory() : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read machine stats', detail: String(err) },
      { status: 500 }
    );
  }
}
