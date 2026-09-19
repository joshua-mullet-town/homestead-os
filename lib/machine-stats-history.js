/**
 * machine-stats-history.js — a small rolling history so the stat sheet can draw
 * real charts instead of a single instant.
 *
 * Deliberately tiny and bounded: one sample per write, capped at MAX_POINTS,
 * stored as a flat array of compact records. This is a diagnostics nicety, not
 * a metrics system — it must never grow without bound or block a request.
 *
 * Writes go through the shared atomic writer: every writer of a JSON file under
 * ~/.homestead must be atomic (temp + rename), or concurrent readers get torn
 * reads. That failure mode has previously saturated the server.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORY_DIR = path.join(os.homedir(), '.homestead');
const HISTORY_FILE = path.join(HISTORY_DIR, 'machine-stats-history.json');

// ~2 hours at one sample per 10s, which is the Presenter's poll cadence.
const MAX_POINTS = 720;
// Don't record more often than this even if polled harder.
const MIN_INTERVAL_MS = 8000;

let lastWriteAt = 0;

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Append one sample. Silently no-ops on any failure — a diagnostics readout
 * must never take the server down.
 */
function recordSample(stats) {
  try {
    const now = Date.now();
    if (now - lastWriteAt < MIN_INTERVAL_MS) return;
    lastWriteAt = now;

    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

    const history = readHistory();
    history.push({
      t: now,
      c: stats.cpu.claude,
      m: stats.cpu.mcp,
      o: stats.cpu.other,
      tot: stats.cpu.total,
      sessions: stats.counts.claude,
      helpers: stats.counts.mcp,
      memFree: stats.memory.freePct,
      swap: stats.memory.swapUsedMb,
      load: stats.load.one,
    });

    while (history.length > MAX_POINTS) history.shift();
    atomicWrite(HISTORY_FILE, JSON.stringify(history));
  } catch {
    /* diagnostics only — never throw */
  }
}

module.exports = { recordSample, readHistory };
