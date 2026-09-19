import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { join } from 'path';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const hours = searchParams.get('hours');
  const current = searchParams.get('current');

  const scriptPath = join(process.cwd(), 'lib', 'token-usage-report.js');
  const args = ['--json'];

  if (current === 'true') {
    args.push('--current');
  } else if (hours) {
    args.push('--hours', hours);
  } else {
    args.push('--hours', '24');
  }

  return new Promise<NextResponse>((resolve) => {
    execFile('node', [scriptPath, ...args], { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        resolve(NextResponse.json(
          { error: 'Failed to run token usage report', details: stderr || error.message },
          { status: 500 }
        ));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        resolve(NextResponse.json(data));
      } catch {
        resolve(NextResponse.json(
          { error: 'Failed to parse report output', raw: stdout.slice(0, 500) },
          { status: 500 }
        ));
      }
    });
  });
}
