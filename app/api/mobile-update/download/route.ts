import { NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';

const APK_PATH = '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/mobile/app/build/outputs/apk/debug/app-debug.apk';

/**
 * GET /api/mobile-update/download
 * Serves the APK file for download
 */
export async function GET() {
  if (!existsSync(APK_PATH)) {
    return NextResponse.json({ error: 'No APK found' }, { status: 404 });
  }

  try {
    const fileBuffer = await readFile(APK_PATH);
    const stats = await stat(APK_PATH);

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="homestead.apk"',
        'Content-Length': stats.size.toString(),
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to read APK';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
