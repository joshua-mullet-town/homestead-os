import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const MONITORS_FILE = join(process.cwd(), 'data', 'monitors.json');

interface MonitorConfig {
  id: string;
  heartbeat_file: string;
  stale_threshold_seconds: number;
  owner: string;
}

interface MonitorStatus {
  id: string;
  display_name: string;
  icon: string;
  status: 'up' | 'down' | 'unknown';
  uptime_seconds: number | null;
  last_heartbeat: string | null;
  stale: boolean;
  stats: Record<string, unknown>;
  owner: string;
}

export async function GET() {
  try {
    if (!existsSync(MONITORS_FILE)) {
      return NextResponse.json({ monitors: [] });
    }

    const config = JSON.parse(readFileSync(MONITORS_FILE, 'utf-8'));
    const monitors: MonitorStatus[] = [];

    for (const mon of config.monitors || []) {
      const m = mon as MonitorConfig;
      let status: MonitorStatus = {
        id: m.id,
        display_name: m.id,
        icon: '⚙️',
        status: 'unknown',
        uptime_seconds: null,
        last_heartbeat: null,
        stale: true,
        stats: {},
        owner: m.owner,
      };

      if (existsSync(m.heartbeat_file)) {
        try {
          const heartbeat = JSON.parse(readFileSync(m.heartbeat_file, 'utf-8'));
          const now = Date.now();
          const hbTime = new Date(heartbeat.timestamp).getTime();
          const ageSeconds = Math.floor((now - hbTime) / 1000);
          const isStale = ageSeconds > m.stale_threshold_seconds;

          status.display_name = heartbeat.display_name || m.id;
          status.icon = heartbeat.icon || '⚙️';
          status.status = isStale ? 'down' : (heartbeat.status || 'up');
          status.last_heartbeat = heartbeat.timestamp;
          status.stale = isStale;
          status.stats = heartbeat.stats || {};

          if (heartbeat.started_at) {
            status.uptime_seconds = Math.floor((now - new Date(heartbeat.started_at).getTime()) / 1000);
          }
        } catch {}
      }

      monitors.push(status);
    }

    return NextResponse.json({ monitors });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read monitors' }, { status: 500 });
  }
}
