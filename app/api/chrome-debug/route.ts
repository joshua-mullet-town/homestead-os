import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * GET /api/chrome-debug
 * Check if Chrome debug is running
 */
export async function GET() {
  try {
    const { stdout } = await execAsync('lsof -i :9222 2>/dev/null || true');
    const isRunning = stdout.includes('Google Chrome') || stdout.includes('LISTEN');

    let version = null;
    if (isRunning) {
      try {
        const response = await fetch('http://127.0.0.1:9222/json/version', {
          signal: AbortSignal.timeout(2000)
        });
        if (response.ok) {
          const data = await response.json();
          version = data.Browser || data['User-Agent'];
        }
      } catch {
        // Ignore fetch errors
      }
    }

    return NextResponse.json({
      running: isRunning,
      port: 9222,
      version,
    });
  } catch (error) {
    return NextResponse.json({
      running: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

/**
 * POST /api/chrome-debug
 * Launch Chrome debug instance
 */
export async function POST() {
  try {
    // Check if already running
    const { stdout: checkOutput } = await execAsync('lsof -i :9222 2>/dev/null || true');
    if (checkOutput.includes('LISTEN')) {
      return NextResponse.json({
        success: true,
        message: 'Chrome debug already running',
        alreadyRunning: true,
      });
    }

    // Launch Chrome debug
    const chromeCmd = `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      --remote-debugging-port=9222 \
      --user-data-dir="$HOME/chrome-debug-profile" \
      --no-first-run \
      --no-default-browser-check &`;

    await execAsync(chromeCmd);

    // Wait a bit and verify
    await new Promise(resolve => setTimeout(resolve, 2000));

    const { stdout: verifyOutput } = await execAsync('lsof -i :9222 2>/dev/null || true');
    const isRunning = verifyOutput.includes('LISTEN');

    return NextResponse.json({
      success: isRunning,
      message: isRunning ? 'Chrome debug launched' : 'Failed to launch Chrome debug',
      alreadyRunning: false,
    });
  } catch (error) {
    console.error('[chrome-debug] Launch failed:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

/**
 * DELETE /api/chrome-debug
 * Kill Chrome debug instance
 */
export async function DELETE() {
  try {
    // Find and kill Chrome processes using port 9222
    await execAsync('lsof -ti :9222 | xargs kill -9 2>/dev/null || true');

    return NextResponse.json({
      success: true,
      message: 'Chrome debug stopped'
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
