import { NextRequest, NextResponse } from 'next/server';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const HOMESTEAD_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead';

// GET - Check server status
export async function GET() {
  try {
    const { stdout } = await execAsync('pm2 jlist');
    const processes = JSON.parse(stdout);
    const homestead = processes.find((p: { name: string }) => p.name === 'homestead');

    if (homestead) {
      return NextResponse.json({
        status: 'running',
        pid: homestead.pid,
        uptime: homestead.pm2_env.pm_uptime,
        restarts: homestead.pm2_env.restart_time,
        memory: homestead.monit?.memory,
        cpu: homestead.monit?.cpu,
      });
    }

    return NextResponse.json({ status: 'stopped' });
  } catch (error) {
    return NextResponse.json({ status: 'unknown', error: 'Failed to get PM2 status' });
  }
}

// POST - Rebuild and restart the server
// ?rebuild=true (default) - runs npm run build first
// ?rebuild=false - just restarts without rebuilding
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const shouldRebuild = searchParams.get('rebuild') !== 'false';

    // Spawn a detached process that will outlive this request
    // This process will: 1) optionally build, 2) restart PM2
    const script = shouldRebuild
      ? `cd ${HOMESTEAD_DIR} && npm run build && pm2 restart homestead`
      : `pm2 restart homestead`;

    // Use spawn with detached to run independently of this process
    const child = spawn('bash', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      cwd: HOMESTEAD_DIR,
    });
    child.unref();

    return NextResponse.json({
      success: true,
      message: shouldRebuild ? 'Build and restart scheduled' : 'Restart scheduled',
      rebuild: shouldRebuild,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to schedule restart' }, { status: 500 });
  }
}
