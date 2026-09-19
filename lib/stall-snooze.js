#!/usr/bin/env node
/**
 * stall-snooze.js — the Foreman's release valve for check-stalled-workers.js.
 *
 * When the stall checker pings a Foreman about a card-less, silent Worker, the
 * ping hands the Foreman a self-contained snooze command. That command is
 * literally an invocation of THIS helper. It writes a per-worker snooze-until
 * epoch-ms into SNOOZE_FILE; the checker reads that file and skips re-pinging
 * until the snooze expires.
 *
 * Semantics are load-bearing and must match check-stalled-workers.js exactly:
 *   - Snooze DELAYS, never DISABLES. Hours are capped at SNOOZE_MAX_HOURS (24).
 *     A Foreman can defer the re-ping but can NEVER fully silence stall
 *     detection for a worker. At expiry the checker re-pings.
 *   - Read-modify-write so concurrent snoozes for different workers don't clobber
 *     each other. A missing or unparsable file starts from an empty object
 *     (fail-open toward detection: a broken snooze file must never permanently
 *     silence a real stall).
 *
 * Usage:
 *   node lib/stall-snooze.js <worker-session-name> [hours]
 * hours defaults to 1, is coerced to a positive number, and is capped at 24.
 *
 * Env overrides (mirror check-stalled-workers.js so tests share one knob):
 *   SNOOZE_FILE — default /tmp/stall-check-snooze.json
 */

'use strict';

const fs = require('fs');

const SNOOZE_FILE = process.env.SNOOZE_FILE || '/tmp/stall-check-snooze.json';
const SNOOZE_MAX_HOURS = 24; // hard cap — snooze DELAYS, never DISABLES

/**
 * Coerce an hours argument to a positive number capped at SNOOZE_MAX_HOURS.
 * Anything non-positive or non-numeric falls back to 1h.
 */
function normalizeHours(raw) {
  let h = Number(raw);
  if (!(h > 0)) h = 1;
  if (h > SNOOZE_MAX_HOURS) h = SNOOZE_MAX_HOURS;
  return h;
}

/**
 * Read SNOOZE_FILE into an object. Missing or unparsable => empty object.
 */
function readSnoozes() {
  try {
    const obj = JSON.parse(fs.readFileSync(SNOOZE_FILE, 'utf-8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/**
 * Snooze <worker> for <hours> (capped). Returns the snooze-until epoch-ms it
 * wrote. Read-modify-write so other workers' entries are preserved.
 */
function snooze(worker, hours, nowMs) {
  const h = normalizeHours(hours);
  const until = nowMs + h * 3600 * 1000;
  const snoozes = readSnoozes();
  snoozes[worker] = until;
  fs.writeFileSync(SNOOZE_FILE, JSON.stringify(snoozes, null, 2));
  return { hours: h, until };
}

function main() {
  const worker = process.argv[2];
  if (!worker) {
    console.error('usage: node lib/stall-snooze.js <worker-session-name> [hours]');
    process.exit(2);
  }
  const { hours, until } = snooze(worker, process.argv[3], Date.now());
  console.log(`snoozed ${worker} for ${hours}h (until ${new Date(until).toISOString()})`);
}

module.exports = { normalizeHours, readSnoozes, snooze, SNOOZE_FILE, SNOOZE_MAX_HOURS };

if (require.main === module) {
  main();
}
