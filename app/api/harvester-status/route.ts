import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATUS_FILE = join(process.cwd(), 'data/harvester-status.json');

export async function GET() {
  try {
    if (!existsSync(STATUS_FILE)) {
      return NextResponse.json({
        lastSuccessfulRun: null,
        sessionsProcessed: 0,
        status: 'never_run'
      });
    }

    const data = JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));

    // Calculate time since last run
    let timeSince = null;
    let status = 'unknown';

    if (data.lastSuccessfulRun) {
      const lastRun = new Date(data.lastSuccessfulRun);
      const now = new Date();
      const diffMs = now.getTime() - lastRun.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      if (diffMins < 10) {
        status = 'healthy';
        timeSince = `${diffMins}m ago`;
      } else if (diffMins < 30) {
        status = 'warning';
        timeSince = `${diffMins}m ago`;
      } else if (diffMins < 60) {
        status = 'stale';
        timeSince = `${diffMins}m ago`;
      } else if (diffMins < 1440) {
        status = 'stale';
        timeSince = `${Math.floor(diffMins / 60)}h ago`;
      } else {
        status = 'stale';
        timeSince = `${Math.floor(diffMins / 1440)}d ago`;
      }
    } else {
      status = 'never_run';
    }

    return NextResponse.json({
      ...data,
      timeSince,
      status
    });
  } catch (err) {
    return NextResponse.json({
      error: 'Failed to read status',
      status: 'error'
    }, { status: 500 });
  }
}
