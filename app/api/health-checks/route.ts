import { NextResponse } from 'next/server';

// Plain JS lib (shared with server.js), required rather than imported so the
// same module can serve both the Next route and the node server.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getHealthChecks } = require('@/lib/health-checks');

/**
 * GET /api/health-checks
 *
 * "Is something DOWN or MISSING?" — the actionable half of the Presenter's
 * health dot. Deliberately separate from /api/machine-stats, which answers the
 * unrelated question of how BUSY the machine is. Keeping them apart is what
 * lets the dot show two distinct meanings in two distinct colours.
 *
 * The detectors shell out to mDNS and are cached ~20s, so polling this
 * alongside the stats poll is cheap.
 */
export async function GET() {
  try {
    const health = await getHealthChecks();
    return NextResponse.json(health);
  } catch (err) {
    // Never 500 the dot into a false alarm — degrade to "nothing known down".
    return NextResponse.json({
      at: new Date().toISOString(),
      checks: [],
      downCount: 0,
      anyDown: false,
      error: String(err),
    });
  }
}

/**
 * POST /api/health-checks
 *
 * Perform a check's "fix" action — the button in the Presenter's modal.
 * Body: { id: <check id> }
 *
 * Today the only action kind is `phone-app`: ask the Homestead app on the
 * phone to bring an app to the front. That is as far as we can get Joshua
 * toward the wireless-debugging toggle, and it is exactly as far as he asked
 * to get ("gets me at least close").
 */
export async function POST(request: Request) {
  try {
    const { id } = await request.json();
    const health = await getHealthChecks();
    const check = (health.checks || []).find((c: any) => c.id === id);

    if (!check || !check.fix) {
      return NextResponse.json(
        { success: false, error: 'No fix action for that check.' },
        { status: 404 }
      );
    }

    if (check.fix.kind === 'phone-app') {
      // The phone tells us its own address via mDNS — never hardcoded here.
      const ip = health.phoneIp;
      if (!ip) {
        return NextResponse.json({
          success: false,
          error: "Your phone isn't reachable on the home network right now.",
        });
      }
      const res = await fetch(`http://${ip}:8888/app/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageName: check.fix.target }),
        signal: AbortSignal.timeout(6000),
      });
      const out = await res.json().catch(() => ({}));
      return NextResponse.json({
        success: !!out.success,
        error: out.success ? undefined : (out.error || 'The phone did not answer.'),
        hint: check.fix.hint,
      });
    }

    return NextResponse.json(
      { success: false, error: `Unsupported fix action: ${check.fix.kind}` },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
