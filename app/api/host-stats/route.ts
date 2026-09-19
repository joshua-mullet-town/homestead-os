import { NextResponse } from 'next/server';
import { cpus, loadavg, freemem, totalmem } from 'os';

/**
 * GET /api/host-stats
 *
 * Real host-level resource snapshot. Polled by the Presenter (and anything
 * else) at the same 10s cadence as /api/mcp-status.
 *
 * Response shape:
 *   {
 *     cpuPct: number | null,        // 0-100, percent busy across all cores since previous call. null on cold start.
 *     loadAvg1: number,              // 1-min load avg
 *     loadAvg5: number,              // 5-min load avg
 *     loadAvg15: number,             // 15-min load avg
 *     freeMemMb: number,             // free physical memory, MB
 *     totalMemMb: number,            // total physical memory, MB
 *     cpuCores: number,              // logical core count (for sanity / max load)
 *     sampleAgeMs: number | null,    // ms between this sample and the previous (for client to know window)
 *     at: number                     // unix ms timestamp of this sample
 *   }
 *
 * CPU% computation: os.cpus() returns per-core cumulative tick counters
 * (user/nice/sys/idle/irq). We snapshot once per call; the next call computes
 * the delta. On the very first call we have no baseline → cpuPct = null.
 * Subsequent calls return the busy percentage averaged across all cores in
 * the interval between calls.
 */

interface CoreSnapshot {
  total: number;
  idle: number;
}

interface Snapshot {
  at: number;
  cores: CoreSnapshot[];
}

let lastSnapshot: Snapshot | null = null;

const CACHE_TTL_MS = 2000;
let cache: { data: any; expiresAt: number } | null = null;

function takeSnapshot(): Snapshot {
  const list = cpus();
  return {
    at: Date.now(),
    cores: list.map(c => {
      const t = c.times;
      const total = t.user + t.nice + t.sys + t.idle + t.irq;
      return { total, idle: t.idle };
    }),
  };
}

function computeCpuPct(prev: Snapshot, curr: Snapshot): number | null {
  if (prev.cores.length !== curr.cores.length) return null;
  let totalDelta = 0;
  let idleDelta = 0;
  for (let i = 0; i < curr.cores.length; i++) {
    totalDelta += curr.cores[i].total - prev.cores[i].total;
    idleDelta += curr.cores[i].idle - prev.cores[i].idle;
  }
  if (totalDelta <= 0) return null;
  const busyPct = ((totalDelta - idleDelta) / totalDelta) * 100;
  // Clamp to [0, 100] in case of clock weirdness across the sample window.
  return Math.max(0, Math.min(100, Math.round(busyPct * 10) / 10));
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.data);
  }

  const snap = takeSnapshot();
  let cpuPct: number | null = null;
  let sampleAgeMs: number | null = null;
  if (lastSnapshot) {
    cpuPct = computeCpuPct(lastSnapshot, snap);
    sampleAgeMs = snap.at - lastSnapshot.at;
  }
  lastSnapshot = snap;

  const [load1, load5, load15] = loadavg();
  const free = freemem();
  const total = totalmem();

  const payload = {
    cpuPct,
    loadAvg1: Math.round(load1 * 100) / 100,
    loadAvg5: Math.round(load5 * 100) / 100,
    loadAvg15: Math.round(load15 * 100) / 100,
    freeMemMb: Math.round(free / 1024 / 1024),
    totalMemMb: Math.round(total / 1024 / 1024),
    cpuCores: snap.cores.length,
    sampleAgeMs,
    at: snap.at,
  };
  cache = { data: payload, expiresAt: Date.now() + CACHE_TTL_MS };
  return NextResponse.json(payload);
}
