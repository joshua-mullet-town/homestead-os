import { NextRequest, NextResponse } from 'next/server';
// Live routing-suggester preview. Runs the SAME matcher the notification pipeline uses
// (reads Alfred's routing-table.json FRESH each call) against a supplied notification and
// returns the routing hint — so a test page can show Josh the exact tag the pipeline would
// stamp. READ-ONLY: never forwards, never enqueues, never mutates anything.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { suggestSteward } = require('@/lib/routing-suggester');

function run(n: unknown) {
  const hint = suggestSteward(n);
  if (hint && hint.suggested_steward) {
    return {
      found: true,
      suggested_steward: hint.suggested_steward,
      suggested_topic: hint.topic || null,
      suggested_note: hint.note || null,
      suggested_rule_id: hint.matched_rule_id || null,
    };
  }
  return { found: false };
}

// POST a notification-shaped body → returns its routing hint (or {found:false}).
export async function POST(request: NextRequest) {
  let n: unknown;
  try {
    n = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, ...run(n) });
}

// GET convenience: ?title=Big+Jim&text=...&from=...&subject=...&snippet=...
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const n: Record<string, unknown> = {};
  for (const f of ['title', 'text', 'bigText', 'subText', 'from', 'subject', 'snippet', 'appName', 'packageName']) {
    const v = p.get(f);
    if (v != null) n[f] = v;
  }
  return NextResponse.json({ ok: true, ...run(n) });
}
