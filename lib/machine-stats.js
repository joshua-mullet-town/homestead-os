/**
 * machine-stats.js — accurate machine diagnostics for the Presenter stat sheet.
 *
 * READING LOAD CORRECTLY (noted 2026-08-30 after getting this wrong in prose):
 * load averages are only meaningful as a RATIO against core count. This machine
 * has 8 cores, so a load of 4.7 is ~0.6x — comfortable, not overloaded. Compare
 * `load.pctOfCores` / (load.one / cores), never the raw load number against an
 * intuition of "big". Also: a 1-minute average spikes hard during a build and
 * settles within minutes, so never generalize one instantaneous reading into a
 * standing claim about the machine — check the history window first.
 *
 * ACCURACY IS THE POINT (Josh, 2026-08-29: "It just needs to be accurate more
 * than anything"). Two traps this module exists to avoid, both learned the
 * hard way in this codebase:
 *
 *  1. NEVER classify a process by searching its full argument string. A live
 *     Claude session's argv contains dozens of `--add-dir .../code/mcp/` paths,
 *     so substring tests misfire wildly. Classify on the EXECUTABLE basename
 *     (first argv token) only. This is the bug that made the readout claim
 *     0 sessions and 106 orphans.
 *
 *  2. NEVER use `ps -o %cpu` for "current" CPU. On macOS that column is a
 *     LIFETIME AVERAGE since process start, so a session that was busy an hour
 *     ago still reports high while idle. For instantaneous usage we sample
 *     `top -l 2` and read the SECOND block (the first is a since-boot average).
 *
 * Also note: Claude's process `comm` in `top` output is its version string
 * (e.g. "2.1.251"), NOT "claude" — so CPU must be attributed BY PID against a
 * pid set built from `ps`, never by matching names in top's output.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execAsync = promisify(exec);

const CACHE_TTL_MS = 4000;
let cache = null;

/** Basename of the executable — first argv token, directory stripped. */
function execBasename(cmd) {
  const first = String(cmd || '').trim().split(/\s+/)[0] || '';
  return first.split('/').pop();
}

/**
 * Instantaneous per-PID CPU percentages, from the SECOND `top` sample.
 *
 * Values are percent-of-ONE-core (so 8 cores => 800 possible in total).
 * Returns an empty map if top is unavailable rather than throwing, so the
 * stat sheet degrades to "unknown" instead of breaking.
 */
async function sampleCpuByPid() {
  const { stdout } = await execAsync(
    'top -l 2 -s 1 -stats pid,cpu 2>/dev/null',
    { maxBuffer: 8 * 1024 * 1024 }
  ).catch(() => ({ stdout: '' }));

  const lines = stdout.split('\n');
  // Each sample block is preceded by a "PID  %CPU" header. The last header
  // begins the second (real, interval-measured) sample.
  const headers = [];
  lines.forEach((l, i) => {
    if (l.trim().startsWith('PID')) headers.push(i);
  });
  if (!headers.length) return new Map();

  const byPid = new Map();
  for (const line of lines.slice(headers[headers.length - 1] + 1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parseInt(parts[0], 10);
    const pct = parseFloat(parts[1]);
    if (!isNaN(pid) && !isNaN(pct)) byPid.set(pid, pct);
  }
  return byPid;
}

/** Swap usage — the signal that actually correlates with the machine feeling slow. */
async function getSwap() {
  const { stdout } = await execAsync('sysctl -n vm.swapusage 2>/dev/null').catch(
    () => ({ stdout: '' })
  );
  // "total = 9216.00M  used = 8389.88M  free = 826.12M  (encrypted)"
  const m = stdout.match(/total\s*=\s*([\d.]+)M.*used\s*=\s*([\d.]+)M/);
  if (!m) return { totalMb: null, usedMb: null };
  return { totalMb: Math.round(+m[1]), usedMb: Math.round(+m[2]) };
}

/**
 * macOS "free percentage" from memory_pressure — the kernel's own view of how
 * much memory is genuinely available. Far more honest than free/total, because
 * most "used" RAM is reclaimable cache.
 */
async function getMemoryFreePct() {
  const { stdout } = await execAsync(
    'memory_pressure 2>/dev/null | tail -3'
  ).catch(() => ({ stdout: '' }));
  const m = stdout.match(/free percentage:\s*(\d+)%/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Full snapshot: process counts by category, CPU split by category, memory.
 *
 * Category definitions (all by executable basename, never by argv text):
 *   claude  — the Claude CLI binary itself, one per session
 *   mcp     — helper programs the sessions drive
 *   other   — everything else on the machine
 */
async function getMachineStats() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.data;

  const [psOut, cpuByPid, swap, memFreePct] = await Promise.all([
    execAsync('ps -eo pid=,ppid=,rss=,comm= 2>/dev/null', {
      maxBuffer: 8 * 1024 * 1024,
    })
      .then((r) => r.stdout)
      .catch(() => ''),
    sampleCpuByPid(),
    getSwap(),
    getMemoryFreePct(),
  ]);

  // Full command lines, used ONLY for MCP detection (which legitimately needs
  // to see the script path being run, e.g. "node .../foo-mcp-server.js").
  const argsOut = await execAsync('ps -eo pid=,args= 2>/dev/null', {
    maxBuffer: 8 * 1024 * 1024,
  })
    .then((r) => r.stdout)
    .catch(() => '');
  const argsByPid = new Map();
  for (const line of argsOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) argsByPid.set(parseInt(m[1], 10), m[2]);
  }

  const claudePids = new Set();
  const mcpPids = new Set();
  let claudeRssKb = 0;
  let mcpRssKb = 0;

  for (const line of psOut.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0], 10);
    const rss = parseInt(parts[2], 10);
    const comm = parts.slice(3).join(' ');
    if (isNaN(pid)) continue;

    if (execBasename(comm) === 'claude') {
      claudePids.add(pid);
      claudeRssKb += rss || 0;
      continue;
    }
    const full = argsByPid.get(pid) || comm;
    if (
      /node.*mcp|mcp-server\.js|chrome-devtools-mcp/.test(full) ||
      /uv.*tool|uv.*uvx|uv.*mcp/.test(full) ||
      /python.*mcp|mcp_stdio/.test(full)
    ) {
      mcpPids.add(pid);
      mcpRssKb += rss || 0;
    }
  }

  const cores = os.cpus().length;

  // Sum instantaneous CPU per category. Values are percent-of-one-core; divide
  // by core count to express as a share of the WHOLE machine.
  let claudeCpu = 0;
  let mcpCpu = 0;
  let totalCpu = 0;
  for (const [pid, pct] of cpuByPid) {
    totalCpu += pct;
    if (claudePids.has(pid)) claudeCpu += pct;
    else if (mcpPids.has(pid)) mcpCpu += pct;
  }
  const otherCpu = Math.max(0, totalCpu - claudeCpu - mcpCpu);

  const haveCpu = cpuByPid.size > 0;
  const pctOfMachine = (v) =>
    haveCpu ? Math.round((v / cores) * 10) / 10 : null;

  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const [load1, load5, load15] = os.loadavg();

  const data = {
    at: now,
    cores,

    // CPU as a share of the WHOLE machine (0-100), split by who is using it.
    cpu: {
      total: pctOfMachine(totalCpu),
      claude: pctOfMachine(claudeCpu),
      mcp: pctOfMachine(mcpCpu),
      other: pctOfMachine(otherCpu),
      // Share of the busy work attributable to Claude (0-100), null when idle.
      claudeShareOfBusy:
        haveCpu && totalCpu > 0
          ? Math.round((claudeCpu / totalCpu) * 1000) / 10
          : null,
    },

    counts: {
      claude: claudePids.size,
      mcp: mcpPids.size,
    },

    memory: {
      claudeMb: Math.round(claudeRssKb / 1024),
      mcpMb: Math.round(mcpRssKb / 1024),
      totalMb: totalMemMb,
      // Kernel's own availability figure — the honest one.
      freePct: memFreePct,
      swapUsedMb: swap.usedMb,
      swapTotalMb: swap.totalMb,
    },

    load: {
      one: Math.round(load1 * 100) / 100,
      five: Math.round(load5 * 100) / 100,
      fifteen: Math.round(load15 * 100) / 100,
      // Load expressed against cores — "6.9 of 8 engines".
      pctOfCores: Math.round((load1 / cores) * 1000) / 10,
    },
  };

  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

module.exports = { getMachineStats, execBasename };
