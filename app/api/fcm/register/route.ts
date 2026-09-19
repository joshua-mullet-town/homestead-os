import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const TOKEN_FILE = '/tmp/homestead-fcm-tokens.json';

function getTokens(): string[] {
  if (!existsSync(TOKEN_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveTokens(tokens: string[]) {
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * POST /api/fcm/register
 * Registers a device FCM token for push notifications.
 * Body: { token: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'token is required' }, { status: 400 });
    }

    // ⚠️ A TOKEN IS `<instance-id>:<payload>`. The instance-id is STABLE for
    // an app install and the payload CHANGES when Firebase reissues. So a
    // reissued token for THE SAME DEVICE arrives here looking almost identical
    // to the one already on file — same prefix, different tail.
    //
    // The old code did `tokens.push()` on any string it had not seen exactly.
    // That meant a reissue ADDED a second entry and kept the DEAD one forever,
    // and every push went to both: one silently discarded by Google, one real.
    // Worse, when the dead token was the only one, everything looked healthy
    // from the server while the phone got nothing — that is the five-day
    // outage of 2026-09-13..18.
    //
    // ✅ Treat the instance-id as the DEVICE IDENTITY and REPLACE, never append.
    // One device -> at most one token, always the newest it told us about.
    const instanceId = token.split(':')[0];
    const tokens = getTokens();
    const existingForDevice = tokens.filter((t) => t.split(':')[0] === instanceId);
    const alreadyCurrent = existingForDevice.includes(token) && existingForDevice.length === 1;

    if (!alreadyCurrent) {
      // Drop every token for THIS device, then add the one it just gave us.
      const others = tokens.filter((t) => t.split(':')[0] !== instanceId);
      const next = [...others, token];
      saveTokens(next);
      // ⚠️ Log the TAIL, never the prefix — the prefix is identical across a
      // reissue, so a prefix log makes a replacement look like a no-op. The
      // original `substring(0, 20)` logging is precisely what made this
      // invisible for five days.
      const retired = existingForDevice.filter((t) => t !== token);
      if (retired.length) {
        console.log(
          `[FCM] Device ${instanceId.slice(0, 8)}… rotated its token: `
          + `retired ${retired.map((t) => '…' + t.slice(-12)).join(', ')} `
          + `-> now …${token.slice(-12)}`
        );
      } else {
        console.log(`[FCM] Registered device ${instanceId.slice(0, 8)}… token …${token.slice(-12)}`);
      }
    } else {
      console.log(`[FCM] Device ${instanceId.slice(0, 8)}… already current (…${token.slice(-12)})`);
    }

    return NextResponse.json({ success: true, totalTokens: tokens.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[FCM] Register error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  const tokens = getTokens();
  return NextResponse.json({ tokens: tokens.length });
}
