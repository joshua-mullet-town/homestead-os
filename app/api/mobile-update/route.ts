import { NextRequest, NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import path from 'path';

// Where the APK gets built
const APK_PATH = '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/mobile/app/build/outputs/apk/debug/app-debug.apk';
const MOBILE_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/mobile';

/**
 * GET /api/mobile-update
 * Returns APK info (version, size, last modified)
 */
export async function GET() {
  if (!existsSync(APK_PATH)) {
    return NextResponse.json({ available: false, error: 'No APK found. Build first.' });
  }

  try {
    const stats = await stat(APK_PATH);
    return NextResponse.json({
      available: true,
      size: stats.size,
      sizeHuman: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
      lastModified: stats.mtime.toISOString(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ available: false, error: msg });
  }
}

/**
 * POST /api/mobile-update
 * Builds a fresh APK and returns info about it
 */
export async function POST() {
  try {
    await execAsync('./gradlew assembleDebug', {
      cwd: MOBILE_DIR,
      timeout: 120000,
    });

    const stats = await stat(APK_PATH);
    return NextResponse.json({
      success: true,
      size: stats.size,
      sizeHuman: `${(stats.size / (1024 * 1024)).toFixed(1)} MB`,
      lastModified: stats.mtime.toISOString(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Build failed';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
