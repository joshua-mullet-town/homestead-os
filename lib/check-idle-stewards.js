#!/usr/bin/env node
/**
 * check-idle-stewards.js — fleet-wide idle detector for sleep-and-wake.
 *
 * Runs every minute via recurring-jobs.json. For each active tmux session
 * matching `holler-*`, reads its activity file at
 * `/tmp/claude-session-<name>-activity.json`, and if `is_working === false`
 * AND `now - updated_at > IDLE_THRESHOLD_SEC`, fires a sleep walkie via
 * POST http://localhost:3005/api/queue. The walkie tells the steward to run
 * its handoff skill (write HANDOFF.md, then `tmux kill-session`).
 *
 * Design choices:
 *
 *   - Pure read of activity files; no tmux send-keys, no in-band side effects.
 *     The dispatch happens via the queue API, which is the canonical way to
 *     reach a steward.
 *
 *   - Skip stewards who already have a pending sleep-related walkie in the
 *     queue. Otherwise we'd re-fire the sleep walkie every minute while the
 *     target finishes writing its HANDOFF, flooding the inbox.
 *
 *   - Skip stewards with an active wake-in-flight (would be racing). This
 *     is a coarse check — the dispatcher's inFlightWakes set is in-memory,
 *     not on disk. Cheap proxy: if there's a `wake_failure_hard` walkie
 *     pending for the target in the recent past, skip; otherwise the
 *     dispatcher itself will short-circuit duplicate wakes.
 *
 *   - updated_at format is ISO8601 with fractional seconds and no timezone
 *     (`2026-05-04T14:10:14.241827`). Node's `Date.parse()` handles this if we
 *     append a Z (treat as UTC) — the activity-writer also assumes UTC.
 *
 *   - Critical exclusions: skip any session whose tmux name starts with
 *     `wake-cycle-` (test scaffolding from wake-protocol-test). Watchdog also
 *     opts out — see SKIP_SESSIONS below.
 *
 * Env overrides (mostly for testing):
 *   IDLE_THRESHOLD_SEC  — default 14400 (4 hours, Joshua-set 2026-06-26; was 1800 = 30 min)
 *   QUEUE_API           — default http://localhost:3005/api/queue
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const IDLE_THRESHOLD_SEC = parseInt(process.env.IDLE_THRESHOLD_SEC || '14400', 10);
const QUEUE_API = process.env.QUEUE_API || 'http://localhost:3005/api/queue';
const QUEUE_FILE = path.join(os.homedir(), '.homestead', 'queue.json');
const STEWARDS_DIR = path.join(os.homedir(), '.homestead', 'stewards');

const SKIP_SESSIONS = new Set([
  // Rooster is the ALWAYS-ON orchestrator — the heartbeat of Homestead. It must
  // NEVER be a sleep target (creed-level invariant: "the one steward that must
  // ALWAYS be running"). It was MISSING from this set (2026-07-03): this script
  // fired a sleep walkie AT holler-rooster while it was actively working. The
  // sibling sleep-idle-stewards.sh already excludes it (NEVER_SLEEP); this .js
  // did not — the two were inconsistent. Non-negotiable exclusion.
  'holler-rooster',
  // Watchdog is the explicit fleet exception (per Scribe's lesson 2026-05-04).
  // It runs a 60s cron cycle and never idles in the conventional sense — its
  // own action-driven kill triggers (real-repair + staleness cap) handle its
  // lifecycle. The standard idle-detect model does not apply.
  //
  // PARAMETERIZED (GOTCHA 2 — worker re-home): the watchdog's COORDINATED
  // value-flip landed 2026-08-01 — re-homed sub-substeward → worker, live session
  // is now `holler-rooster--watchdog`. Default updated to the confirmed live name;
  // still overridable via WATCHDOG_SESSION env. Kept in sync with the cousin scripts.
  process.env.WATCHDOG_SESSION || 'holler-rooster--watchdog',
].filter(Boolean));

// Skip session-name patterns (test scaffolding, wake-protocol harnesses, etc.)
const SKIP_PATTERNS = [
  /^wake-cycle-/,
  /^wake-/, // wake-protocol-test scratch sessions
];

function log(...args) {
  console.log('[check-idle-stewards]', ...args);
}

function listHollerSessions() {
  try {
    const out = execSync('tmux ls -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('holler-'));
  } catch {
    return [];
  }
}

function readActivityFile(sessionName) {
  const f = `/tmp/claude-session-${sessionName}-activity.json`;
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Resolve a session's steward dir the SAME WAY queue-dispatcher.js does
 * (its resolveSessionDir, ~L445-449). Nested-substeward aware: strip the
 * `holler-` prefix, split on `--`, and join the parts with `/substewards/`
 * under STEWARDS_DIR.
 *   holler-venture--marketing--seo
 *     -> stewards/venture/substewards/marketing/substewards/seo
 *
 * This is a self-contained PORT (not a cross-import) so idle-detect stays a
 * standalone script. It exists so we never post a sleep walkie the dispatcher's
 * wakeFreshSpawn (its own existsSync(sessionDir) bail at ~L139) will later
 * refuse — e.g. guest sessions (holler-guest-*) that have a live tmux session
 * + activity file but NO steward dir, which are not sleep-and-wake eligible.
 */
function resolveSessionDir(sessionName) {
  // Use the SAME resolver the dispatcher tries FIRST (queue-dispatcher.js
  // resolveSessionDir). The structural `--` -> /substewards/ rule below is only
  // the dispatcher's FALLBACK, and porting just the fallback was a silent bug:
  // workers live under `<steward>/workers/<name>`, NOT `/substewards/`, so every
  // worker resolved to a nonexistent path, failed the eligibility check, and was
  // silently EXCLUDED from sleep — the longest-lived sessions exempted by an
  // implementation detail. (Found 2026-09-06 while re-enabling idle-sleep.)
  try {
    const resolver = require('./steward-resolver');
    const result = resolver.resolveTarget(sessionName);
    if (result && result.valid && result.directory) {
      return result.directory;
    }
  } catch {
    // resolver unavailable or threw — fall through to the structural rule
  }
  const name = sessionName.replace(/^holler-/, '');
  const parts = name.split('--');
  const relPath = parts.join('/substewards/');
  return path.join(STEWARDS_DIR, relPath);
}

/**
 * Parse `2026-05-04T14:10:14.241827` (ISO-ish, no TZ). Treat as UTC because
 * the activity-writer (homestead's session-status pipeline) writes UTC.
 */
function parseActivityTimestamp(s) {
  if (!s || typeof s !== 'string') return null;
  // Append Z if no offset present.
  const withZ = /[Z+-]/.test(s.slice(10)) ? s : `${s}Z`;
  const ms = Date.parse(withZ);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Returns true if the queue already has a pending walkie for the target whose
 * source is `idle-detect` (i.e. a sleep walkie we sent recently). Prevents
 * re-firing while the target is still processing an earlier sleep walkie.
 *
 * Also returns true if there's a pending `wake_failure_hard` escalation —
 * those are about to be processed by Rooster; sending another sleep walkie
 * to the original target would just compete.
 */
function hasPendingSleepRelatedWalkie(sessionName) {
  if (!fs.existsSync(QUEUE_FILE)) return false;
  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  } catch {
    return false; // queue file unreadable; don't block on it
  }
  if (!Array.isArray(queue)) return false;
  return queue.some((item) => {
    if (item.status !== 'pending') return false;
    if (item.target_session === sessionName && item.source === 'idle-detect') return true;
    return false;
  });
}

function buildSleepMessage(sessionName) {
  return [
    `You've been idle past the threshold; the dispatcher is putting you to sleep.`,
    ``,
    `Run your handoff skill (~/.claude/skills/handoff.md):`,
    `  1. Roger this walkie immediately (you can't roger after you kill yourself).`,
    `  2. Update HANDOFF.md in your steward dir thoroughly — be the bridge to your next self. A stranger reading ONLY that file should be able to pick up your story.`,
    `  3. Run \`tmux kill-session -t ${sessionName}\` to put yourself fully to sleep.`,
    ``,
    `When the next walkie targeting you arrives, the dispatcher will fresh-spawn a new Claude in your dir (NO --continue). The bootstrap will tell it to read your HANDOFF.md as its first action — that's where it picks up where you left off. So the quality of your HANDOFF.md is the quality of your continuity.`,
    ``,
    `No need to walkie back to confirm. The kill is your signal.`,
  ].join('\n');
}

function postSleepWalkie(sessionName, idleSec) {
  const body = JSON.stringify({
    target_session: sessionName,
    message: buildSleepMessage(sessionName),
    type: 'action',
    source: 'idle-detect',
  });

  return new Promise((resolve) => {
    const url = new URL(QUEUE_API);
    const req = http.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const id = parsed?.item?.id || parsed?.id || 'unknown';
              log(`OK: enqueued sleep walkie id=${id} for ${sessionName} (idle=${idleSec}s)`);
            } catch {
              log(`OK: enqueued sleep walkie for ${sessionName} (idle=${idleSec}s) (response unparsable: ${data})`);
            }
            resolve(true);
          } else {
            log(`ERROR: ${QUEUE_API} returned ${res.statusCode} for ${sessionName}: ${data}`);
            resolve(false);
          }
        });
      }
    );
    req.on('error', (err) => {
      log(`ERROR: POST to ${QUEUE_API} for ${sessionName}: ${err.message}`);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  const sessions = listHollerSessions();
  if (sessions.length === 0) {
    log('no holler-* tmux sessions found');
    return;
  }
  log(`scanning ${sessions.length} holler-* sessions; threshold=${IDLE_THRESHOLD_SEC}s`);

  const now = Date.now();
  let fired = 0;
  let skipped = 0;

  for (const sessionName of sessions) {
    if (SKIP_SESSIONS.has(sessionName)) {
      skipped++;
      continue;
    }
    if (SKIP_PATTERNS.some((rx) => rx.test(sessionName))) {
      skipped++;
      continue;
    }

    const activity = readActivityFile(sessionName);
    if (!activity) {
      // No activity file yet — session may have just started or be a guest
      // session not wired into the activity pipeline. Don't sleep without
      // evidence; skip.
      skipped++;
      continue;
    }

    if (activity.is_working === true) {
      // Busy. Leave it alone.
      continue;
    }

    const updatedMs = parseActivityTimestamp(activity.updated_at);
    if (updatedMs == null) {
      log(`skip ${sessionName}: could not parse updated_at (${activity.updated_at})`);
      skipped++;
      continue;
    }

    const idleSec = Math.floor((now - updatedMs) / 1000);
    if (idleSec < IDLE_THRESHOLD_SEC) {
      // Idle but not past threshold yet.
      continue;
    }

    if (hasPendingSleepRelatedWalkie(sessionName)) {
      log(`skip ${sessionName}: already has a pending idle-detect walkie`);
      skipped++;
      continue;
    }

    // Sleep-and-wake requires a steward dir to fresh-spawn from. If the session
    // has no steward dir (guest/unprovisioned — e.g. holler-guest-*), the
    // dispatcher's wakeFreshSpawn will refuse the wake (its own existsSync
    // bail), so the sleep walkie can NEVER be honored: it just retries 3x and
    // escalates wake_failure_hard to Rooster. Skip these here, mirroring the
    // dispatcher's resolver, so we never post a walkie it will later refuse.
    const sessionDir = resolveSessionDir(sessionName);
    if (!fs.existsSync(sessionDir)) {
      log(`skip ${sessionName}: no steward dir (guest/unprovisioned -- not sleep-and-wake eligible)`);
      skipped++;
      continue;
    }

    log(`FIRING: ${sessionName} idle=${idleSec}s (threshold=${IDLE_THRESHOLD_SEC}s)`);
    await postSleepWalkie(sessionName, idleSec);
    fired++;
  }

  log(`done: fired=${fired} skipped=${skipped} total=${sessions.length}`);
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
