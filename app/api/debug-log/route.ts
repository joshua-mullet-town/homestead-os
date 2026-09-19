import { NextRequest, NextResponse } from 'next/server';
import { appendFileSync } from 'fs';

const DEBUG_LOG = '/tmp/homestead-frontend-debug.log';

export async function POST(request: NextRequest) {
  try {
    const data = await request.json();
    const timestamp = new Date().toISOString();
    const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

    const logLine = '[' + timestamp + '] [' + clientIp + '] ' + JSON.stringify(data) + '\n';

    appendFileSync(DEBUG_LOG, logLine);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to log' }, { status: 500 });
  }
}
