#!/usr/bin/env node
/**
 * check-stalled-workers.js — anti-stall detector for silently-stalled Workers.
 *
 * SIBLING of check-idle-stewards.js and check-context-pressure-stewards.js —
 * same activity-file reads, same SKIP conventions, same queue-API dispatch,
 * same idempotency guard. Runs every 5 minutes via recurring-jobs.json
 * (id: check-stalled-workers).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM: quiet Workers stall SILENTLY — they stop working but present NO
 * card to Josh AND aren't making progress (dead walkie link, waiting on a
 * steward reply that never comes, process died mid-wait). Those go unnoticed.
 * This detector catches them and pings the Worker's Foreman to go look.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ NOTIFY-ONLY. NEVER auto-kill, auto-restart, or auto-respond to the Worker.
 * This script DETECTS; the Foreman (human-judged) DECIDES. This honors the
 * standing fleet invariant "never automate stuck-session response." The ONLY
 * side effect this script emits is a single walkie to the Worker's Foreman
 * saying "go check on it."
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * DETECTION (per live WORKER — identified by steward.json `level` via
 * lib/steward-level.js, NOT by session name. Both legacy Foreman-child
 * `holler-{steading}--foreman--{task}` and re-homed `holler-{steading}--{task}`
 * shapes count as workers during the dual-read transition):
 *
 *   1. LAST-ACTIVE: read /tmp/claude-session-<name>-activity.json → updated_at.
 *      Compute seconds since (silentSec).
 *
 *   2. CARD-CHECK: GET http://localhost:3005/api/presenter/queue. Is there a
 *      card attributable to <name> (session_id OR callback_session === name)
 *      that is NOT dismissed? Presenter cards have no `dismissed` field — they
 *      are REMOVED from the queue on dismiss/respond, so "has an undismissed
 *      card" == "a card for <name> is still present in the live queue." We also
 *      honor an explicit `dismissed === true` if that field ever appears, so the
 *      check is robust to a future schema that soft-deletes instead of removing.
 *
 * FLAG (true positive) IFF: card-less (no undismissed card from <name>) AND
 * silent > STALL_THRESHOLD_SEC (default 300s = 5 min) AND not currently snoozed.
 *
 * ACTION when flagged: notify the Foreman ONLY. Send a walkie to the Worker's
 * Foreman (holler-<steward>--foreman) via POST /api/queue. The two downstream
 * outcomes (Foreman cards Josh why / Foreman shakes the Worker) are the
 * FOREMAN's job, human-judged — NOT this script's. This script's job ends at
 * the correct ping.
 *
 * SNOOZE — the Foreman's release valve (delays, NEVER disables). When a Foreman
 * gets a ping and KNOWS the Worker is legitimately quiet with no card coming
 * soon, it can SNOOZE the re-ping so it isn't re-alarmed every 5 min. Rules:
 *   - Snooze DELAYS, never DISABLES. Max = 24h. At expiry it RE-PINGS. A Foreman
 *     can defer but can NEVER fully turn stall-detection off for a Worker.
 *   - The snooze command is baked into EVERY ping (see buildForemanMessage) —
 *     never something the Foreman has to remember.
 *   - IMPLEMENTATION: a per-worker snooze-until epoch-ms in a small JSON state
 *     file (SNOOZE_FILE). Before firing, the check reads it; if now < snooze-
 *     until for that Worker, it skips the re-ping. The Foreman snoozes by running
 *     the helper `lib/stall-snooze.js <worker> <hours>` (STALL_SNOOZE_HELPER),
 *     which writes SNOOZE_FILE directly, capped at 24h.
 *
 * FALSE-POSITIVE DISCIPLINE (a noisy version trains the Foreman to ignore it).
 * Do NOT flag:
 *   (a) A Worker that HAS an undismissed card from itself (legit waiting on
 *       Josh) — covered by CARD-CHECK above.
 *   (b) A Worker parked on a waiting-on-user picker (surfaced a question, is
 *       correctly waiting) — detected via pane capture showing a picker prompt.
 *   (c) A Worker that is ASLEEP (tmux session exists but no live claude
 *       process) — asleep ≠ stalled; it's a deliberate state.
 *   (d) A Worker that is currently WORKING (is_working === true) — trivially
 *       not stalled.
 *
 * Env overrides (mostly for testing):
 *   STALL_THRESHOLD_SEC — default 300 (5 min)
 *   QUEUE_API           — default http://localhost:3005/api/queue
 *   PRESENTER_API       — default http://localhost:3005/api/presenter/queue
 *   SNOOZE_FILE         — default /tmp/stall-check-snooze.json
 *   STALL_SNOOZE_HELPER — default <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/lib/stall-snooze.js
 *   DRY_RUN             — "1" to detect + log but NOT send the Foreman walkie
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const { classifySession } = require('./steward-level');

const STALL_THRESHOLD_SEC = parseInt(process.env.STALL_THRESHOLD_SEC || '300', 10);
const QUEUE_API = process.env.QUEUE_API || 'http://localhost:3005/api/queue';
const PRESENTER_API = process.env.PRESENTER_API || 'http://localhost:3005/api/presenter/queue';
const SNOOZE_FILE = process.env.SNOOZE_FILE || '/tmp/stall-check-snooze.json';
const STALL_SNOOZE_HELPER =
  process.env.STALL_SNOOZE_HELPER || '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/lib/stall-snooze.js';
const SNOOZE_MAX_HOURS = 24; // hard cap — snooze DELAYS, never DISABLES
const DRY_RUN = process.env.DRY_RUN === '1';

// DUAL-READ (worker re-home + rename): a WORKER is no longer identified by the
// `--foreman--` session infix — post-rename a worker is `holler-{steading}--{w}`,
// indistinguishable by name from crew. The distinguisher is steward.json `level`
// (see lib/steward-level.js). classifySession() returns 'worker' | 'crew' |
// 'other' against the on-disk steward.json, accepting BOTH legacy
// ("sub-substeward", parent foreman) and new ("worker", parent steading) shapes,
// and defaulting a missing/corrupt steward.json under a Steading to worker.

// The WATCHDOG session — parameterized (GOTCHA 2). The watchdog is script-only
// (launchd cron, no Claude instance) and manages its own lifecycle, so the stall
// model does not apply. The COORDINATED value-flip landed 2026-08-01 (worker
// re-home): the watchdog re-homed sub-substeward → worker and its live session
// is now `holler-rooster--watchdog`. Default updated to the confirmed live name;
// still overridable via env. Set to empty to disable the exclusion.
const WATCHDOG_SESSION =
  process.env.WATCHDOG_SESSION || 'holler-rooster--watchdog';

// Rooster is the always-on orchestrator and never a target; the Watchdog is
// excluded via the parameterized WATCHDOG_SESSION above.
const SKIP_SESSIONS = new Set(
  ['holler-rooster', WATCHDOG_SESSION].filter(Boolean)
);

// Skip session-name patterns (test scaffolding, wake-protocol harnesses).
const SKIP_PATTERNS = [/^wake-cycle-/, /^wake-/];

function log(...args) {
  console.log('[check-stalled-workers]', ...args);
}

// ── tmux session enumeration ────────────────────────────────────────────────

function listWorkerSessions() {
  try {
    const out = execSync('tmux ls -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      // DUAL-READ: worker-detection keys off steward.json `level`, NOT the
      // `--foreman--` infix. classifySession() reads the on-disk level (legacy
      // sub-substeward + new worker both count) and defensively defaults a
      // missing/corrupt steward.json under a Steading to worker.
      .filter((s) => classifySession(s) === 'worker')
      .filter((s) => !SKIP_SESSIONS.has(s))
      .filter((s) => !SKIP_PATTERNS.some((rx) => rx.test(s)));
  } catch {
    return [];
  }
}

// ── worker → escalation target ──────────────────────────────────────────────

/**
 * DUAL-READ escalation target for a stalled worker. Post re-home, a worker
 * belongs to the whole STEADING, not a Foreman — so its stall-escalation target
 * is the Steading itself.
 *
 *   legacy:   holler-<steading>--foreman--<task>  ->  holler-<steading>--foreman
 *   re-homed: holler-<steading>--<task>           ->  holler-<steading>
 *
 * Legacy shape (contains `--foreman--`): strip from the FIRST `--foreman--`
 * onward, anchoring on the literal delimiter (not positional dash-splitting) so
 * steading names with dashes survive — target the (still-live) Foreman.
 *
 * Re-homed shape (`holler-{steading}--{worker}`, no `--foreman--`): the target
 * is the STEADING top steward — everything before the first `--` after the
 * `holler-` prefix. Steading names never contain `--` (that IS the substeward
 * delimiter), so splitting on the first `--` is exact.
 */
function foremanTarget(workerName) {
  const legacyIdx = workerName.indexOf('--foreman--');
  if (legacyIdx !== -1) {
    return workerName.slice(0, legacyIdx) + '--foreman';
  }
  // Re-homed: target the Steading (the segment before the first `--`).
  const sepIdx = workerName.indexOf('--');
  if (sepIdx === -1) return null; // no substeward segment — not a re-homed worker
  return workerName.slice(0, sepIdx);
}

// ── activity file ───────────────────────────────────────────────────────────

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
 * Parse `2026-07-18T14:13:52.863122+00:00` or `2026-05-04T14:10:14.241827`
 * (ISO-ish, offset optional). Treat as UTC when no offset present — the
 * activity-writer writes UTC. Returns ms or null.
 */
function parseActivityTimestamp(s) {
  if (!s || typeof s !== 'string') return null;
  const withZ = /[Z+-]/.test(s.slice(10)) ? s : `${s}Z`;
  const ms = Date.parse(withZ);
  return Number.isFinite(ms) ? ms : null;
}

// ── asleep detection (ported from queue-dispatcher.js needsClaudeRestart) ────

/**
 * True if the tmux session exists but has NO live claude process — i.e. the
 * Worker is ASLEEP (deliberate state), not stalled. Ported from
 * queue-dispatcher.js:needsClaudeRestart to stay in sync with the two shapes:
 *   (a) post-v2 respawn: PANE_PID itself is the claude binary.
 *   (b) legacy shell+claude: a direct child of PANE_PID has 'claude' in argv.
 * Uses ps-walk (NOT `pgrep -P -f`) to dodge the macOS pgrep quirk.
 * On any uncertainty we return FALSE (assume alive) — the safe direction is to
 * let the stall check proceed rather than silently excusing a real stall.
 */
function isAsleep(sessionName) {
  let panePid;
  try {
    panePid = execSync(
      `tmux list-panes -t "=${sessionName}" -F '#{pane_pid}' 2>/dev/null | head -1`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
  } catch {
    return false;
  }
  if (!panePid) return false;

  // Shape (a): is PANE_PID itself the claude binary?
  try {
    const paneComm = execSync(`ps -p ${panePid} -o comm= 2>/dev/null | head -1`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    if (paneComm.split('/').pop() === 'claude') return false; // alive
  } catch {
    // fall through
  }

  // Shape (b): a direct child of PANE_PID whose argv contains 'claude'.
  try {
    const childrenLines = execSync(
      `ps -eo pid=,ppid=,command= | awk -v ppid=${panePid} '$2 == ppid'`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    if (childrenLines) {
      for (const line of childrenLines.split('\n')) {
        if (/claude/i.test(line)) return false; // alive
      }
    }
  } catch {
    return false; // uncertain — assume alive
  }

  return true; // no claude process in either shape — asleep
}

// ── picker detection (waiting-on-user) ──────────────────────────────────────

/**
 * True if the Worker's pane shows a live waiting-on-user picker — it surfaced a
 * question and is correctly waiting. That's legit, NOT a stall. Match the
 * Claude Code picker footer markers: an "❯ 1." option list plus a "to navigate"
 * / "Enter to select" / "Enter to confirm" instruction line. We require BOTH a
 * numbered-option marker AND a navigation-instruction line so the plain idle
 * "❯ " prompt (which is NOT a picker) does not false-match.
 */
function isOnPicker(sessionName) {
  // NB: capture-pane does NOT accept the `=` exact-match anchor the way
  // list-panes does — with `=` it resolves to no pane and returns empty. Use the
  // bare session name. Session names here are fully-qualified worker names, so a
  // bare -t is already an exact target in practice.
  let cap;
  try {
    cap = execSync(`tmux capture-pane -t "${sessionName}" -p 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
  } catch {
    return false;
  }
  if (!cap) return false;
  const tail = cap.split('\n').slice(-25).join('\n');

  const hasNavInstruction = /to navigate|Enter to select|Enter to confirm|↑\/↓/.test(tail);
  // Numbered picker option like "❯ 1." or "> 1." — the selection cursor in front
  // of a numbered choice. The bare idle prompt is just "❯ " with no digit.
  const hasNumberedOption = /(❯|>)\s*\d+[.\s]/.test(tail);

  return hasNavInstruction && hasNumberedOption;
}

// ── presenter card check ────────────────────────────────────────────────────

function httpGetJson(apiUrl) {
  return new Promise((resolve) => {
    const url = new URL(apiUrl);
    const req = http.request(
      { method: 'GET', hostname: url.hostname, port: url.port, path: url.pathname + url.search },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          } else {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * PURE — given a presenter-queue array, return the SET of session names with at
 * least one undismissed card attributable to them (session_id OR
 * callback_session). Presence in the queue == undismissed. Split out from the
 * HTTP fetch so tests can pass a MOCK queue array and NEVER touch the live :3005
 * endpoint.
 */
function cardSetFromQueue(queue) {
  const set = new Set();
  if (!Array.isArray(queue)) return set;
  for (const item of queue) {
    if (item && item.dismissed === true) continue; // future soft-delete schema
    if (item && typeof item.session_id === 'string') set.add(item.session_id);
    if (item && typeof item.callback_session === 'string') set.add(item.callback_session);
  }
  return set;
}

/**
 * Fetch the LIVE presenter queue and reduce to the card-set. Used by main() in
 * real deployment. Tests should NOT call this — they build a mock queue and
 * call cardSetFromQueue() directly.
 */
async function fetchSessionsWithCards() {
  const body = await httpGetJson(PRESENTER_API);
  // FAIL-CLOSED on an unreachable presenter (2026-09-06). httpGetJson resolves
  // null for ANY failure (socket error, non-2xx, unparsable body). Treating that
  // as "[] = nobody has a card" silently DISABLES exclusion (a) and flags every
  // silent worker at once — which is exactly what happened during the load spike
  // that morning (:3005 saturated, this job SIGKILLed at 120s), producing a false
  // STALLED ping for holler-mcgucket--hey-alfred while it held 3 undismissed
  // cards. Unlike the snooze file (fail-open toward detection is safe there),
  // failing open HERE manufactures false positives against healthy workers.
  // null => "unknown", and the caller skips this cycle rather than guessing.
  if (body === null) return null;
  const queue = Array.isArray(body.queue) ? body.queue : [];
  return cardSetFromQueue(queue);
}

// ── snooze state (Foreman's delay-not-disable release valve) ─────────────────

/**
 * Read SNOOZE_FILE -> { "<worker>": <snooze-until-epoch-ms>, ... }. Missing or
 * unparsable file is treated as "no snoozes" (fail-open toward detection: a
 * broken snooze file must never silence a real stall — it just means everyone
 * gets checked, which is the safe direction).
 */
function readSnoozes() {
  if (!fs.existsSync(SNOOZE_FILE)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(SNOOZE_FILE, 'utf-8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/**
 * True if <worker> is currently snoozed (now < its snooze-until). Expired
 * snooze entries return false -> the Worker re-pings, exactly as charter
 * requires ("at snooze expiry it RE-PINGS").
 */
function isSnoozed(snoozes, workerName, nowMs) {
  const until = snoozes[workerName];
  return typeof until === 'number' && nowMs < until;
}

/**
 * The self-contained snooze command handed to the Foreman inside every ping.
 * Invokes the real helper (lib/stall-snooze.js), which writes
 * SNOOZE_FILE[worker] = now + Nh, capping N at SNOOZE_MAX_HOURS so a Foreman can
 * defer but NEVER disable. Returns the command with a trailing space so the ping
 * can append the hours argument.
 */
function buildSnoozeCmd(workerName) {
  return `node ${STALL_SNOOZE_HELPER} ${workerName} `;
}

// ── Foreman notify (NOTIFY-ONLY — the sole permitted side effect) ────────────

function buildForemanMessage(workerName, silentSec) {
  const min = Math.round(silentSec / 60);
  const snoozeCmd = buildSnoozeCmd(workerName);
  return [
    // (a) which worker + why flagged
    `Worker ${workerName} appears STALLED — card-less and silent ${min} min ` +
      `(no undismissed presenter card from it, no activity since its last tool).`,
    ``,
    `This is a DETECTION-ONLY ping from the stall checker. It does NOT ` +
      `kill/restart/respond to the worker — that judgment is yours. Two outcomes ` +
      `Josh wants from you here:`,
    // (b) the two required outcomes
    `  1. CARD JOSH WHY — if it's genuinely wedged, tell Josh what stalled it.`,
    `  2. SHAKE THE WORKER — nudge it, re-send the walkie it's blocked on, or ` +
      `restart it.`,
    ``,
    // (c) how to snooze + for how long (baked in, not remembered)
    `OR, if you KNOW it's legitimately quiet with no card coming soon, SNOOZE the ` +
      `re-ping so you're not re-alarmed every 5 min. Snooze DELAYS, never ` +
      `disables — max 24h, then it re-pings. To snooze for N hours (default 1, ` +
      `capped at 24), run:`,
    ``,
    `    ${snoozeCmd}<N>`,
    ``,
    `e.g. \`${snoozeCmd}6\` snoozes ${workerName} for 6h. Omit N for 1h.`,
  ].join('\n');
}

function postForemanWalkie(foreman, workerName, silentSec) {
  const body = JSON.stringify({
    target_session: foreman,
    message: buildForemanMessage(workerName, silentSec),
    type: 'action',
    source: 'stall-check',
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
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            let id = 'unknown';
            try { const p = JSON.parse(data); id = p?.item?.id || p?.id || 'unknown'; } catch {}
            log(`NOTIFY OK: pinged ${foreman} re ${workerName} (id=${id})`);
            resolve(true);
          } else {
            log(`NOTIFY ERROR: ${QUEUE_API} -> ${res.statusCode} for ${foreman}: ${data}`);
            resolve(false);
          }
        });
      }
    );
    req.on('error', (err) => {
      log(`NOTIFY ERROR: POST ${QUEUE_API} for ${foreman}: ${err.message}`);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Idempotency guard: skip if we already pinged this Foreman about this specific
 * worker RECENTLY. "Recently" = a stall-check walkie about the worker whose
 * created_at is within STALL_THRESHOLD_SEC of now, in ANY non-terminal-yet state
 * (pending / dispatched / confirmed).
 *
 * WHY a time window and not just status==='pending' (the sibling checkers' rule):
 * the idle/context-pressure siblings fire a walkie that makes the TARGET kill
 * itself, so the target is gone on the next cycle and can't re-fire — their
 * pending-only guard is sufficient. A stalled worker here does NOT die; it stays
 * alive and silent, so it re-qualifies every cycle. Meanwhile the dispatcher
 * flips a walkie pending->dispatched in ~1-2s, so by the next 5-min cron the
 * prior ping is 'dispatched'/'confirmed', never 'pending' — a pending-only guard
 * would miss it and re-ping the Foreman every 5 min about the same worker. A
 * created_at cooldown of one cron interval yields "one ping per worker per
 * cycle"; the Foreman's SNOOZE is the mechanism for longer deferral.
 *
 * Reads ~/.homestead/queue.json directly.
 */
function recentlyPingedForeman(foreman, workerName, nowMs) {
  const os = require('os');
  const path = require('path');
  const qf = path.join(os.homedir(), '.homestead', 'queue.json');
  if (!fs.existsSync(qf)) return false;
  let queue;
  try { queue = JSON.parse(fs.readFileSync(qf, 'utf-8')); } catch { return false; }
  if (!Array.isArray(queue)) return false;
  const cooldownMs = STALL_THRESHOLD_SEC * 1000;
  return queue.some((item) => {
    if (!item || item.target_session !== foreman) return false;
    // Ignore items the dispatcher has permanently given up on (failed) — a
    // failed delivery should NOT suppress a fresh attempt.
    if (item.status === 'failed') return false;
    // Only stall-check walkies mention a worker STALLED in the body; match the
    // worker name so one Foreman's other stalled workers are tracked separately.
    const msg = typeof item.message === 'string' ? item.message : JSON.stringify(item.message || '');
    if (!msg.includes(workerName)) return false;
    // Within the cooldown window? created_at is ISO8601 (dispatcher-written).
    const createdMs = Date.parse(item.created_at || '');
    if (!Number.isFinite(createdMs)) return true; // undateable but matches worker+foreman -> be conservative, suppress
    return nowMs - createdMs < cooldownMs;
  });
}

// ── main (ONE pass) ─────────────────────────────────────────────────────────

async function main() {
  const workers = listWorkerSessions();
  if (workers.length === 0) {
    log('no worker sessions found (level-based scan)');
    return;
  }
  log(`scanning ${workers.length} worker sessions; threshold=${STALL_THRESHOLD_SEC}s dry_run=${DRY_RUN}`);

  const cardSessions = await fetchSessionsWithCards();
  // Presenter unreachable => we cannot tell who is legitimately waiting on Josh.
  // Skip the whole cycle rather than flag healthy workers as stalled. The next
  // run (this job is on a short cron) re-checks; a genuine stall is silent for
  // hours, so deferring one cycle cannot hide it.
  if (cardSessions === null) {
    log('ABORT cycle: presenter queue unreachable — cannot evaluate exclusion (a); ' +
        'skipping rather than risk false STALLED pings. Will retry next run.');
    return;
  }
  const snoozes = readSnoozes();
  const now = Date.now();
  let flagged = 0;
  let skipped = 0;

  for (const worker of workers) {
    const activity = readActivityFile(worker);
    if (!activity) {
      log(`skip ${worker}: no activity file (unwired / just-spawned)`);
      skipped++;
      continue;
    }

    // Exclusion (d): currently working — trivially not stalled.
    if (activity.is_working === true) {
      skipped++;
      continue;
    }

    const updatedMs = parseActivityTimestamp(activity.updated_at);
    if (updatedMs == null) {
      log(`skip ${worker}: unparsable updated_at (${activity.updated_at})`);
      skipped++;
      continue;
    }
    const silentSec = Math.floor((now - updatedMs) / 1000);

    // Under threshold — not silent long enough.
    if (silentSec < STALL_THRESHOLD_SEC) {
      skipped++;
      continue;
    }

    // Exclusion (a): has an undismissed card → legitimately waiting on Josh.
    if (cardSessions.has(worker)) {
      log(`skip ${worker}: has undismissed presenter card (waiting on Josh)`);
      skipped++;
      continue;
    }

    // Exclusion (c): asleep (deliberate state, not a stall).
    if (isAsleep(worker)) {
      log(`skip ${worker}: asleep (no live claude process)`);
      skipped++;
      continue;
    }

    // Exclusion (b): parked on a waiting-on-user picker (legit waiting).
    if (isOnPicker(worker)) {
      log(`skip ${worker}: parked on waiting-on-user picker`);
      skipped++;
      continue;
    }

    // SNOOZE gate: Foreman deferred the re-ping. Delays, never disables — an
    // expired snooze (now >= snooze-until) falls through and re-pings. Checked
    // AFTER the exclusions so a snoozed-but-now-legitimately-quiet worker (e.g.
    // it later surfaced a card) is skipped by the cheaper card check anyway.
    if (isSnoozed(snoozes, worker, now)) {
      const mins = Math.round((snoozes[worker] - now) / 60000);
      log(`skip ${worker}: snoozed by Foreman (${mins} min remaining)`);
      skipped++;
      continue;
    }

    // ── TRUE POSITIVE: card-less AND silent past threshold. NOTIFY FOREMAN. ──
    const foreman = foremanTarget(worker);
    if (!foreman) {
      log(`skip ${worker}: could not derive Foreman target`);
      skipped++;
      continue;
    }

    if (recentlyPingedForeman(foreman, worker, now)) {
      log(`skip ${worker}: Foreman ${foreman} pinged about it within the last ${STALL_THRESHOLD_SEC}s (cooldown)`);
      skipped++;
      continue;
    }

    log(`FLAG: ${worker} silent=${silentSec}s card-less alive not-picker -> notify ${foreman}`);
    if (DRY_RUN) {
      log(`DRY_RUN: would notify ${foreman} re ${worker} (silent=${silentSec}s)`);
    } else {
      await postForemanWalkie(foreman, worker, silentSec);
    }
    flagged++;
  }

  log(`done: flagged=${flagged} skipped=${skipped} total=${workers.length}`);
}

// Export pure/testable pieces so an isolated test harness can require() this
// file WITHOUT running main() (which would hit the live fleet). Auto-run only
// when invoked directly as a script.
module.exports = {
  foremanTarget,
  parseActivityTimestamp,
  cardSetFromQueue,
  readSnoozes,
  isSnoozed,
  buildSnoozeCmd,
  buildForemanMessage,
  SNOOZE_MAX_HOURS,
  STALL_THRESHOLD_SEC,
};

if (require.main === module) {
  main().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
