#!/usr/bin/env node
/**
 * timer-tick.js — Universal Timer System tick engine.
 *
 * Runs once per invocation (via launchd every 60s). Scans every
 *   ~/.homestead/stewards/**\/timers.json
 * and fires any timer whose most-recent scheduled fire time is after its
 * last recorded `last_run` in the sibling `timers.state.json`.
 *
 * Fire semantics:
 *   - spawn the timer's `script` detached + unref so we don't block.
 *   - on successful spawn, update state file with `last_run: now` and
 *     increment `run_count`.
 *   - we also attach `child.on('exit')` to record `last_exit_code`.
 *     Because we detach+unref, this handler may not fire before tick
 *     exits — so `last_exit_code` is best-effort only.
 *
 * Crash ordering: last_run is written AFTER successful spawn. If this
 * tick dies between spawn and state-write, the timer fires again next
 * minute (double-run). Chose this over silent skips.
 *
 * Concurrency: /tmp/timer-tick.pid guard. If another live tick holds it,
 * exit immediately.
 *
 * Design spec: ~/.homestead/stewards/rooster/TIMER_SYSTEM_DESIGN.md
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PIDFILE = '/tmp/timer-tick.pid';
const LOGFILE = '/tmp/timer-tick.log';
const STEWARDS_DIR = path.join(os.homedir(), '.homestead', 'stewards');

// ---------- logging ----------
function log(line) {
  const ts = new Date().toISOString();
  try {
    fs.appendFileSync(LOGFILE, `${ts} ${line}\n`);
  } catch (_) {
    // best-effort logging
  }
}

// ---------- pidfile ----------
function acquirePidfile() {
  if (fs.existsSync(PIDFILE)) {
    try {
      const existing = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
      if (existing && !Number.isNaN(existing)) {
        try {
          // signal 0 = liveness probe
          process.kill(existing, 0);
          // still alive → bail
          log(`tick skipped: pidfile held by live pid ${existing}`);
          process.exit(0);
        } catch (_) {
          // stale pidfile, take it
        }
      }
    } catch (_) {
      // unreadable → overwrite
    }
  }
  fs.writeFileSync(PIDFILE, String(process.pid));
}

function releasePidfile() {
  try {
    if (fs.existsSync(PIDFILE)) {
      const held = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
      if (held === process.pid) fs.unlinkSync(PIDFILE);
    }
  } catch (_) {
    // ignore
  }
}

process.on('exit', releasePidfile);
process.on('SIGINT', () => { releasePidfile(); process.exit(130); });
process.on('SIGTERM', () => { releasePidfile(); process.exit(143); });
process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err && err.stack || err}`);
  releasePidfile();
  process.exit(1);
});

// ---------- file glob ----------
/**
 * Recursively walk STEWARDS_DIR and return every `timers.json` file.
 * Avoids depending on a glob library.
 */
function findTimerFiles(root) {
  const results = [];
  if (!fs.existsSync(root)) return results;
  // Seed with immediate subdirs only — a timers.json at the root of
  // `stewards/` is not a steward timer config (e.g. the legacy
  // walkie-talkie timer queue that lives there).
  const stack = [];
  let rootEntries;
  try {
    rootEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return results;
  }
  for (const ent of rootEntries) {
    if (ent.isDirectory() && ent.name !== 'node_modules' && ent.name !== '.git') {
      stack.push(path.join(root, ent.name));
    }
  }
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name === 'timers.json') {
        results.push(full);
      }
    }
  }
  return results;
}

// ---------- state helpers ----------
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return {};
  try {
    return readJson(stateFile);
  } catch (e) {
    log(`state-parse-fail ${stateFile}: ${e.message} — treating as empty`);
    return {};
  }
}

function writeState(stateFile, state) {
  const tmp = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

// ---------- cron ----------
let cronParser;
try {
  cronParser = require('cron-parser');
} catch (e) {
  log(`FATAL: cron-parser not installed: ${e.message}`);
  process.exit(1);
}

/**
 * Returns the most recent scheduled fire time (a Date) at or before `now`.
 * cron-parser's .prev() from a CronExpression initialized at `now` returns
 * the fire time strictly before `now`, which is what we want.
 */
function previousFireTime(cronString, now) {
  const iter = cronParser.parseExpression(cronString, { currentDate: now });
  return iter.prev().toDate();
}

// ---------- main ----------
function main() {
  acquirePidfile();

  const now = new Date();
  const fired = [];
  const errors = [];

  const timerFiles = findTimerFiles(STEWARDS_DIR);

  for (const file of timerFiles) {
    let cfg;
    try {
      cfg = readJson(file);
    } catch (e) {
      errors.push(`parse-fail ${file}: ${e.message}`);
      continue;
    }
    if (!cfg || !Array.isArray(cfg.timers)) {
      errors.push(`bad-schema ${file}: missing timers array`);
      continue;
    }
    const owner = cfg.owner || path.basename(path.dirname(file));
    const stateFile = path.join(path.dirname(file), 'timers.state.json');
    const state = readState(stateFile);
    let stateDirty = false;

    for (const t of cfg.timers) {
      if (!t || !t.enabled) continue;
      if (!t.id || !t.cron || !t.script) {
        errors.push(`bad-timer ${file}: missing id/cron/script`);
        continue;
      }
      if (!path.isAbsolute(t.script)) {
        errors.push(`non-absolute script ${file}:${t.id}`);
        continue;
      }

      let prevFire;
      try {
        prevFire = previousFireTime(t.cron, now);
      } catch (e) {
        errors.push(`bad-cron ${file}:${t.id} "${t.cron}": ${e.message}`);
        continue;
      }

      const st = state[t.id] || {};
      const lastRunMs = st.last_run ? Date.parse(st.last_run) : 0;
      const due = !lastRunMs || lastRunMs < prevFire.getTime();

      if (!due) continue;

      // Spawn detached and unref. We don't block on the child.
      let child;
      try {
        child = spawn(t.script, [], {
          detached: true,
          stdio: 'ignore'
        });
      } catch (e) {
        errors.push(`spawn-fail ${owner}/${t.id}: ${e.message}`);
        continue;
      }

      // Best-effort exit-code capture. Most detached long-runners won't
      // exit before our tick dies, and with unref() the event loop won't
      // wait for them. For fast scripts (~no-op), this often fires.
      child.on('exit', (code) => {
        try {
          const cur = readState(stateFile);
          const entry = cur[t.id] || {};
          entry.last_exit_code = code;
          cur[t.id] = entry;
          writeState(stateFile, cur);
        } catch (_) { /* best effort */ }
      });
      child.unref();

      const entry = state[t.id] || { run_count: 0 };
      entry.last_run = now.toISOString();
      entry.run_count = (entry.run_count || 0) + 1;
      // last_exit_code left alone here; exit handler may update later.
      state[t.id] = entry;
      stateDirty = true;
      fired.push(`${owner}/${t.id}`);
    }

    if (stateDirty) {
      try {
        writeState(stateFile, state);
      } catch (e) {
        errors.push(`state-write-fail ${stateFile}: ${e.message}`);
      }
    }
  }

  const summary = `tick scanned=${timerFiles.length} fired=${fired.length}${fired.length ? ' [' + fired.join(',') + ']' : ''}${errors.length ? ' errors=' + errors.length + ' [' + errors.join(' | ') + ']' : ''}`;
  log(summary);
}

main();
