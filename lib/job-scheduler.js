/**
 * Recurring Job Scheduler
 *
 * Supports cron-like recurring jobs that persist across server restarts.
 * Uses node-schedule for execution timing.
 */

const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const { execSync, exec, spawn } = require('child_process');
const { promisify } = require('util');
const os = require('os');

// Promisified exec for non-blocking git ops in executeStewardCommit — see the
// re-entrancy-guard comment near memoryHarvesterRunning. Pre-fix these git
// add/status/commit calls ran as unbounded execSync and pinned the main event
// loop (2026-07-07 137s fleet-wide :3005 wedge). Now they exec-with-callback.
const execAsync = promisify(exec);
const { acquireStewardsGitLockSync, LockTimeoutError } = require('./stewards-git-lock');

const JOBS_FILE = path.join(process.cwd(), 'recurring-jobs.json');
const JOBS_STATE_FILE = path.join(process.cwd(), 'data', 'recurring-jobs-state.json');
// Per-job runtime fields that churn every tick — kept out of recurring-jobs.json
// so the source-of-truth config file stays clean in git. See migrateMixedSchema.
const STATE_FIELDS = [
  'last_run',
  'run_count',
  'consecutive_failures',
  'last_success_at',
  'last_error_text',
  'failing_since',
  'backstop_fired_at',
  'backstop_card_id',
];
const JOB_LOGS_DIR = path.join(process.cwd(), 'data', 'job-logs');
const LOG_FILE = '/tmp/homestead-jobs.log';
const GLOBAL_GATE_FILE = path.join(process.cwd(), 'data', 'jobs-global-gate.json');
const QUEUE_FILE = path.join(os.homedir(), '.homestead', 'queue.json');

// Failure alert thresholds (SPEC 1)
const ROOSTER_ALERT_THRESHOLD = 2;
const BACKSTOP_FAILURE_COUNT = 10;
const BACKSTOP_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
const JOB_LOG_RING_SIZE = 20;

// Check if the global gate is on (default: on if file missing)
function isGloballyEnabled() {
  try {
    if (fs.existsSync(GLOBAL_GATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(GLOBAL_GATE_FILE, 'utf-8'));
      return data.enabled !== false;
    }
  } catch {}
  return true;
}

function setGlobalGate(enabled) {
  fs.writeFileSync(GLOBAL_GATE_FILE, JSON.stringify({ enabled, updated_at: new Date().toISOString() }, null, 2));
}

// In-memory map of active job instances
const activeJobs = new Map();

// Track last execution time per job to prevent rapid-fire after sleep/resume
const lastExecutionTime = new Map();

// Grace-window absence ledger for steward-resurrect (anti-thrash guard).
// Keyed by session name -> epoch ms of first tick we saw it absent.
// PURELY anti-thrash: a persistent-crash session (bad state / OOM / quota loop)
// would otherwise re-spawn -> crash -> re-spawn forever on every tick, hammering
// the box. We only revive a session that has stayed absent longer than
// RESURRECT_GRACE_MS, i.e. across more than one observation. The entry is
// deleted the moment the session reappears so a flap doesn't carry a stale timer.
// This is NOT a teardown-race guard — Rooster's teardown reorder (rm -f
// steward.json BEFORE tmux kill-session) already closes that window upstream;
// a torn-down session never enters sessionsToCheck, so it never reaches the ledger.
// In-memory Map is safe: the scheduler process is long-lived (server.js requires
// this module once, initialize() runs once, node-schedule reuses the module across
// ticks — same mechanism lastExecutionTime relies on), so the Map persists tick to tick.
const RESURRECT_GRACE_MS = 90 * 1000;
const resurrectAbsenceLedger = new Map();

// Grace-window gate for an absent session: record first-seen-absent on the first
// tick we notice it gone, and return true (safe to revive) only once it has stayed
// absent longer than RESURRECT_GRACE_MS. Returns false (hold off) while still inside
// the window. Callers must delete the ledger entry when the session reappears or is
// successfully revived. Used by the guest revival loops; the steward loop inlines the
// same logic so it can emit the grace-window-start log line.
function resurrectGraceElapsed(name, now) {
  const firstSeen = resurrectAbsenceLedger.get(name);
  if (firstSeen === undefined) {
    resurrectAbsenceLedger.set(name, now);
    log(`Steward resurrect: ${name} absent — starting grace window (${RESURRECT_GRACE_MS / 1000}s)`);
    return false;
  }
  return now - firstSeen >= RESURRECT_GRACE_MS;
}

// ─── CLAUDE-PROCESS LIVENESS (dropped-to-shell detection) ────────────────────
// Node /1/143: the resurrect scanner's old liveness check was `tmux has-session`
// alone — which PASSES for a session whose tmux is alive but whose claude
// process has EXITED (dropped to a bare `; zsh` shell). A fleet auth expiry on
// 2026-07-22 produced exactly this in ~11 sessions: claude crashed on the
// invalidated token, fell through to the trailing `zsh`, the tmux session
// survived, and the scanner logged "All sessions running" while 11 were dead.
// The fix below adds a real process-liveness discriminator so the "needs
// revival" decision fires on dead-to-shell, not just fully-gone.
//
// findClaudePid — is there a live claude process in this session's pane?
// PORTED (self-contained, not cross-imported) from
// lib/check-compute-suspend-stewards.js:245 so the scheduler stays a standalone
// module (same porting discipline check-idle-stewards.js:109 follows). Two-stage
// ps-walk mirroring the dispatcher's needsClaudeRestart:
//   (a) is pane_pid ITSELF claude? (post-respawn shape: exec'd claude is the pane proc)
//   (b) is a direct child of pane_pid claude? (fleet `zsh -c '...claude...'` wrapper shape)
// Returns the claude PID string, or null if no claude found.
//
// ROOSTER HARDENING (live-verified 2026-07-22, walkie 1784759866669-cmwags):
//   • Do NOT use `pgrep -P panepid` for the child-walk — it RACES on macOS
//     zsh-under-tmux trees and intermittently returns empty even for a real PPID
//     match. The `ps -eo ... | awk '$2==ppid'` ATOMIC snapshot below is
//     authoritative. (Same macOS quirk documented in kill-and-respawn.sh.)
//   • Stage (b) is load-bearing: rooster's own pane_pid is a `zsh -c` wrapper
//     whose comm= is "zsh" — stage (a) misses it, stage (b) child-walk finds the
//     real claude child. Process-walk alone is authoritative; NO pane-content
//     (bare-% grep) check is needed.
function findClaudePid(sessionName) {
  let panePid;
  try {
    panePid = execSync(
      `tmux list-panes -t "=${sessionName}" -F '#{pane_pid}' 2>/dev/null | head -1`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
  } catch {
    return null;
  }
  if (!panePid) return null;

  // Stage (a): pane_pid itself claude? Use comm= (executable basename), NOT
  // command= (full argv) — a `zsh -c '...claude...'` wrapper's argv contains the
  // literal "claude" and would false-match; comm= is the precise binary name.
  try {
    const paneComm = execSync(`ps -p ${panePid} -o comm= 2>/dev/null | head -1`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    if (paneComm.split('/').pop() === 'claude') return panePid;
  } catch {
    // fall through
  }

  // Stage (b): direct child of pane_pid whose command is the claude binary.
  // ATOMIC single-snapshot ps walk (Rooster hardening — no pgrep -P race).
  try {
    const childrenLines = execSync(
      `ps -eo pid=,ppid=,command= | awk -v ppid=${panePid} '$2 == ppid'`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    if (childrenLines) {
      for (const line of childrenLines.split('\n')) {
        // Anchor on the claude binary (`/claude ` or line starting `claude `) so
        // an --add-dir arg like `.../claude-summary-hooks` doesn't false-match.
        const m = line.match(/^\s*(\d+)\s+\d+\s+(.*)$/);
        if (!m) continue;
        const pid = m[1];
        const cmd = m[2];
        if (/\/claude(\s|$)/.test(cmd) || /^claude(\s|$)/.test(cmd)) return pid;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

// classifyLiveness — the triage discriminator. Given a session name (tmux
// already known to EXIST — the `gone` case is handled by has-session throwing
// upstream), returns one of:
//   'alive'     — a live claude process is in the pane. Do NOT revive.
//   'suspended' — no claude proc BUT a compute-suspend marker is present. The
//                 session was intentionally kill-9'd by
//                 check-compute-suspend-stewards.js (memory intact, resumable
//                 via `claude --resume`). Recovery is the DISPATCHER's job on
//                 real walkie traffic (resumeComputeSuspend) — the cron LEAVES
//                 IT ALONE (Rooster Q3: waking it here would double-drive the
//                 picker and risk the resume-prompt trap). A kill+respawn would
//                 DESTROY its resumable state — never do that to a suspended one.
//   'dead'      — no claude proc AND no marker: dropped-to-shell (the auth-expiry
//                 class). claude hard-exited to the trailing `; zsh`; there is no
//                 resumable state. Needs KILL→HERMETIC-RESPAWN.
//
// The compute-suspend marker is the authoritative suspended-vs-dead
// discriminator: check-compute-suspend-stewards.js writes the marker BEFORE it
// kill-9's claude (that file, :428-431), so a cleanly-suspended session ALWAYS
// has a marker — there is no dead-but-unmarked window on the clean path. An
// auth-expiry crash writes NO marker, so no-proc + no-marker is unambiguously
// the dropped-to-shell class. (Rooster Q1, live-verified.)
function classifyLiveness(sessionName) {
  if (findClaudePid(sessionName)) return 'alive';
  const markerPath = `/tmp/claude-session-${sessionName}-compute-suspend.json`;
  if (fs.existsSync(markerPath)) return 'suspended';
  return 'dead';
}

// hermeticRespawn — kill the stale tmux session then fresh-spawn claude with the
// EXACT hermetic env spawn-substeward.sh:342-346 uses. Used for both the
// dropped-to-shell (dead) and fully-gone cases: a clean `tmux new-session` into
// a brand-new pane, never a send-keys into the dirty (escape-residue) pane.
//
// ROOSTER Q2 (live-verified): ALL THREE `-e` vars are load-bearing —
//   • STEWARD_ROLE=worker      — role identity the CLAUDE.md/creed keys on
//   • STEWARD_SESSION=<name>    — self-identity for walkie/library writes
//   • PATH=<substewardDir>/bin:$PATH — scopes the Worker's own bin/ (the `lib`
//        CLI) onto PATH. NOT secondary: drop it and the Worker cannot write to
//        its Library. substewardDir is re-derived per session from the scan.
// ROOSTER Q4 (escape-residue gotcha): an auth-expired pane can hold terminal
// cursor-position-report escape residue (`1;2c`, `0;276...`). Typing a relaunch
// INTO that dirty pane via send-keys would let the fragments mangle the command.
// kill-session + fresh new-session sidesteps it entirely (clean pane) — this is
// the correct path; do NOT fall back to send-keys-into-existing-pane.
//
// The trailing `; zsh` in claudeCmd is DELIBERATE and preserved (Rooster Q2): it
// is WHY a future auth-expiry drops-to-shell (claude exits → falls to zsh → pane
// survives) instead of killing the pane — which is what makes THIS scanner able
// to see and respawn the dead session on the next tick.
//
// Returns true on successful spawn, false on failure (caller logs + leaves the
// absence ledger intact so the grace window restarts and we can't tight-loop).
function hermeticRespawn(sessionName, cwd, substewardDir, claudeCmd) {
  // Kill any stale tmux session first so new-session gets a clean, fresh pane
  // (avoids the escape-residue gotcha). Harmless if the session is already gone.
  try { execSync(`tmux kill-session -t "=${sessionName}" 2>/dev/null`); } catch {}
  const pathEnv = `${substewardDir}/bin:${process.env.PATH || ''}`;
  execSync(
    `tmux new-session -d -s "${sessionName}" -c "${cwd}" ` +
    `-e "STEWARD_ROLE=worker" ` +
    `-e "STEWARD_SESSION=${sessionName}" ` +
    `-e "PATH=${pathEnv}" ` +
    `"${claudeCmd}"`,
    { stdio: 'pipe' }
  );
  return true;
}

// Ensure job logs directory exists
try {
  if (!fs.existsSync(JOB_LOGS_DIR)) {
    fs.mkdirSync(JOB_LOGS_DIR, { recursive: true });
  }
} catch (err) {
  console.error('Failed to create job logs directory:', err);
}

/**
 * Save the output of a job run.
 *
 * Writes a "latest run" summary (backward-compatible shape: {job_id, ran_at,
 * output, error}) PLUS a rolling ring buffer of the last N runs. Pre-SPEC-1
 * this function overwrote — erasing the breadcrumb trail that would have
 * exposed the 12-day steward-commit silent failure. Now it appends.
 *
 * Also drives the failure-tracking state machine: a non-null `error` is
 * treated as a failure, otherwise success. recordJobSuccess/recordJobFailure
 * handle the consecutive_failures + alerting logic.
 */
function saveJobLog(jobId, output, error = null) {
  const entry = {
    job_id: jobId,
    ran_at: new Date().toISOString(),
    output: output || null,
    error: error || null,
  };

  try {
    const logFile = path.join(JOB_LOGS_DIR, `${jobId}.json`);
    let existing = null;
    try {
      if (fs.existsSync(logFile)) {
        existing = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
      }
    } catch {}

    // Ring-buffer shape: { job_id, ran_at, output, error, runs: [...] }
    // Older runs first in the array, newest last.
    const prevRuns = Array.isArray(existing?.runs) ? existing.runs : [];
    // Back-fill a single entry from pre-ring-buffer files on first write.
    if (prevRuns.length === 0 && existing && existing.ran_at && existing.ran_at !== entry.ran_at) {
      prevRuns.push({
        ran_at: existing.ran_at,
        output: existing.output || null,
        error: existing.error || null,
      });
    }
    prevRuns.push({ ran_at: entry.ran_at, output: entry.output, error: entry.error });
    while (prevRuns.length > JOB_LOG_RING_SIZE) prevRuns.shift();

    const next = { ...entry, runs: prevRuns };
    fs.writeFileSync(logFile, JSON.stringify(next, null, 2));
  } catch (err) {
    log(`Failed to save job log for ${jobId}: ${err.message}`, 'ERROR');
  }

  if (error) recordJobFailure(jobId, String(error));
  else recordJobSuccess(jobId);
}

/**
 * Mark a job's latest run as successful. Resets consecutive_failures,
 * clears failing_since and last_error_text, stamps last_success_at.
 */
function recordJobSuccess(jobId) {
  try {
    const data = loadJobs();
    const job = data.jobs.find(j => j.id === jobId);
    if (!job) return;
    const wasFailing = (job.consecutive_failures || 0) > 0;
    job.consecutive_failures = 0;
    job.last_success_at = new Date().toISOString();
    job.last_error_text = null;
    job.failing_since = null;
    job.backstop_fired_at = null;
    // Recovery dismisses the "🚨 Job failing" backstop card dispatched on the
    // way down (close the asymmetry — failure fires it, success must clear it).
    // dismissItem is a no-op returning null if the card is already gone.
    const cardId = job.backstop_card_id;
    job.backstop_card_id = null;
    saveJobs(data);
    if (cardId) {
      try {
        require('./presenter-queue').dismissItem(cardId);
        log(`Dismissed backstop card ${cardId} for recovered job ${jobId}`);
      } catch (e) {
        log(`Failed to dismiss backstop card ${cardId} for ${jobId}: ${e.message}`, 'ERROR');
      }
    }
    if (wasFailing) log(`Job ${jobId} recovered after failure streak`);
  } catch (err) {
    log(`recordJobSuccess error for ${jobId}: ${err.message}`, 'ERROR');
  }
}

/**
 * Mark a job's latest run as failed. Increments consecutive_failures,
 * records error text, stamps failing_since on first failure. Dispatches
 * alerts per SPEC 1: Rooster walkie at 2 consecutive, presenter backstop
 * at 10 consecutive OR 6h+ failing (fires once per streak).
 */
function recordJobFailure(jobId, errorText) {
  try {
    const data = loadJobs();
    const job = data.jobs.find(j => j.id === jobId);
    if (!job) return;

    job.consecutive_failures = (job.consecutive_failures || 0) + 1;
    job.last_error_text = errorText || 'unknown error';
    if (!job.failing_since) job.failing_since = new Date().toISOString();
    saveJobs(data);

    const failingForMs = Date.now() - new Date(job.failing_since).getTime();
    const failingForMinutes = Math.round(failingForMs / 60000);

    log(`Job ${jobId} failed (consecutive=${job.consecutive_failures}, failing_for=${failingForMinutes}m)`, 'WARN');

    // Rooster alert at exactly the threshold, then every 5 failures after
    // (so Rooster can re-rollup if a streak keeps growing without backstop).
    const cf = job.consecutive_failures;
    if (cf === ROOSTER_ALERT_THRESHOLD || (cf > ROOSTER_ALERT_THRESHOLD && cf % 5 === 0)) {
      dispatchRoosterFailureAlert(job, failingForMinutes);
    }

    // Backstop: fire presenter card ONCE per streak when we cross either
    // the count threshold OR the duration threshold. backstop_fired_at
    // prevents duplicate cards; a success resets it via recordJobSuccess.
    const backstopDue =
      (cf >= BACKSTOP_FAILURE_COUNT || failingForMs >= BACKSTOP_DURATION_MS) &&
      !job.backstop_fired_at;
    if (backstopDue) {
      const cardId = dispatchBackstopPresenterCard(job, failingForMinutes);
      // Reload + stamp to prevent re-fire. Persist the card id so a later
      // recovery (recordJobSuccess) can dismiss the exact card it fired.
      const data2 = loadJobs();
      const job2 = data2.jobs.find(j => j.id === jobId);
      if (job2) {
        job2.backstop_fired_at = new Date().toISOString();
        job2.backstop_card_id = cardId || null;
        saveJobs(data2);
      }
    }
  } catch (err) {
    log(`recordJobFailure error for ${jobId}: ${err.message}`, 'ERROR');
  }
}

/**
 * Queue a walkie-talkie to holler-rooster describing a failing job.
 * Rooster is responsible for grouping/digesting if multiple jobs alert
 * in a short window — we just give it the metadata.
 */
// MUTEX-SAFE (confirmed-item redelivery-loop fix 2026-08-03): job-scheduler runs
// IN the server event loop alongside the dispatcher, so it shares the SAME
// mutateQueue single-flight lock instance. The old raw
// readFileSync→push→writeFileSync here BYPASSED that lock: it could read the queue
// before cleanQueue's atomic write, then write its stale snapshot back —
// RE-INTRODUCING an already-archived confirmed item into the live queue (which
// then re-delivers + gets re-archived). Routing the append through mutateQueue()
// serializes it with tick/confirm/cleanQueue so no write clobbers another.
// Fire-and-forget (caller doesn't await); errors are swallowed+logged so a queue
// hiccup can't break the scheduler's failure path.
function dispatchRoosterFailureAlert(job, failingForMinutes) {
  // b (safety-net): re-read the RECONCILED persisted record right before
  // emitting and SUPPRESS only when it is HEALTHY — consecutive_failures===0
  // AND failing_since==null. This guards against a stale-count-vs-healthy-disk
  // divergence firing a spurious alert for a job that disk says is fine.
  //
  // 🔴 This MUST NOT mask a real failure: if the reconciled record still shows
  // a streak (cf>0 OR failing_since set), we fall through and emit as normal.
  // Only the genuinely-healthy record is suppressed. If the re-read itself
  // fails we do NOT suppress (fail open — never swallow a possible real alert).
  try {
    const fresh = loadJobs().jobs.find(j => j.id === job.id);
    if (fresh && (fresh.consecutive_failures || 0) === 0 && fresh.failing_since == null) {
      log(`Suppressing Rooster failure alert for ${job.id}: reconciled record is healthy (cf=0, failing_since=null)`, 'WARN');
      return;
    }
  } catch (err) {
    log(`b emitter-guard re-read failed for ${job.id}, emitting anyway (fail-open): ${err.message}`, 'WARN');
  }

  const queueDispatcher = require('./queue-dispatcher');
  const item = {
    id: `${Date.now()}-job-failure-${job.id}`,
    target_session: 'holler-rooster',
    type: 'action',
    message: JSON.stringify({
      type: 'action',
      trigger: 'job_failure_alert',
      from: 'job-scheduler',
      job_id: job.id,
      job_type: job.type,
      consecutive_failures: job.consecutive_failures,
      last_success_at: job.last_success_at || null,
      last_error_text: job.last_error_text,
      failing_since: job.failing_since,
      failing_for_minutes: failingForMinutes,
    }),
    status: 'pending',
    created_at: new Date().toISOString(),
    attempts: 0,
  };
  Promise.resolve()
    .then(() => queueDispatcher.mutateQueue(queue => { queue.push(item); return queue; }))
    .then(() => log(`Dispatched job_failure_alert to holler-rooster for ${job.id}`))
    .catch((err) => log(`Failed to dispatch Rooster failure alert for ${job.id}: ${err.message}`, 'ERROR'));
}

/**
 * Fire a presenter card directly to Joshua — the nothing-can-rot-12-days-again
 * backstop. Bypasses Rooster so even if Rooster is broken, Joshua sees it.
 */
function dispatchBackstopPresenterCard(job, failingForMinutes) {
  try {
    const presenterQueue = require('./presenter-queue');
    const durationText = failingForMinutes >= 60
      ? `${Math.floor(failingForMinutes / 60)}h ${failingForMinutes % 60}m`
      : `${failingForMinutes}m`;
    const item = presenterQueue.addItem({
      title: `🚨 Job failing: ${job.id}`,
      message:
        `Recurring job \`${job.id}\` has failed ${job.consecutive_failures} times in a row ` +
        `(failing for ${durationText}). Last error: ${job.last_error_text || 'unknown'}. ` +
        `Last success: ${job.last_success_at || 'never recorded'}.`,
      priority: 'urgent',
      category: 'job_failure_alarm_backstop',
      source: 'job-scheduler',
      session_id: 'job-scheduler',
      // 3-lane docket (2026-08-21): a repeatedly-failing job needs Josh — file it
      // under "blocked" so it pops in the docket, with a one-line recap the docket
      // renders off (not the title).
      status: 'blocked',
      recap: `Recurring job "${job.id}" has failed ${job.consecutive_failures}x (${durationText}). Needs a look.`,
    });
    log(`Dispatched backstop presenter card for ${job.id} (consecutive=${job.consecutive_failures}, for=${durationText})`, 'WARN');
    return item && item.id;
  } catch (err) {
    log(`Failed to dispatch backstop presenter card for ${job.id}: ${err.message}`, 'ERROR');
    return null;
  }
}

// Persistent append-stream: writes queue into libuv, never block the event loop.
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
logStream.on('error', () => { /* fallback to console below; no extra noise */ });

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] [JobScheduler] ${message}`;
  console.log(logMessage);
  logStream.write(logMessage + '\n');
}

/**
 * Read state file (id-keyed runtime state). Missing file = empty map, never throws.
 */
function loadState() {
  try {
    if (fs.existsSync(JOBS_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(JOBS_STATE_FILE, 'utf-8')) || {};
    }
  } catch (err) {
    log(`Error loading job state: ${err.message}`, 'ERROR');
  }
  return {};
}

/**
 * One-shot migration: pre-split, recurring-jobs.json held both config and per-tick
 * runtime fields, so the daemon dirtied a tracked file every ~5 minutes. We now
 * keep config in recurring-jobs.json and state in data/recurring-jobs-state.json
 * (auto-gitignored via the data/*-state.json rule). Triggered when the state
 * file is absent — the only signal that needed. Idempotent: re-running with the
 * state file present is a no-op.
 */
function migrateMixedSchema() {
  if (fs.existsSync(JOBS_STATE_FILE)) return;
  let raw;
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    raw = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
  } catch (err) {
    log(`Migration: failed to read ${JOBS_FILE}: ${err.message}`, 'ERROR');
    return;
  }
  const state = {};
  const cleanedJobs = (raw.jobs || []).map(job => {
    const stateForJob = {};
    const configOnly = {};
    for (const [k, v] of Object.entries(job)) {
      if (STATE_FIELDS.includes(k)) stateForJob[k] = v;
      else configOnly[k] = v;
    }
    if (Object.keys(stateForJob).length > 0) state[job.id] = stateForJob;
    return configOnly;
  });
  try {
    const stateDir = path.dirname(JOBS_STATE_FILE);
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(JOBS_STATE_FILE, JSON.stringify(state, null, 2));
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ ...raw, jobs: cleanedJobs }, null, 2));
    log(`Migration: split ${cleanedJobs.length} jobs into config (${JOBS_FILE}) + state (${JOBS_STATE_FILE})`);
  } catch (err) {
    log(`Migration: failed to write split files: ${err.message}`, 'ERROR');
  }
}

/**
 * Load recurring jobs. Merges per-job state from data/recurring-jobs-state.json
 * onto config from recurring-jobs.json, producing the same shape callers expect
 * pre-split (single flat object per job).
 */
function loadJobs() {
  migrateMixedSchema();
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
      const state = loadState();
      const merged = (data.jobs || []).map(job => ({ ...job, ...(state[job.id] || {}) }));
      return { ...data, jobs: merged };
    }
  } catch (err) {
    log(`Error loading jobs: ${err.message}`, 'ERROR');
  }
  return { jobs: [] };
}

/**
 * Save jobs, splitting config and runtime state into separate files. State is
 * rewritten every call (cheap, gitignored). Config (recurring-jobs.json) is
 * rewritten ONLY when its content actually changes — without this guard, every
 * tick would touch the tracked file and reintroduce the churn this split exists
 * to eliminate.
 */
function saveJobs(data) {
  const jobs = data.jobs || [];
  const state = {};
  const configJobs = jobs.map(job => {
    const stateForJob = {};
    const configOnly = {};
    for (const [k, v] of Object.entries(job)) {
      if (STATE_FIELDS.includes(k)) stateForJob[k] = v;
      else configOnly[k] = v;
    }
    if (Object.keys(stateForJob).length > 0) state[job.id] = stateForJob;
    return configOnly;
  });

  try {
    const stateDir = path.dirname(JOBS_STATE_FILE);
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(JOBS_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`Error saving job state: ${err.message}`, 'ERROR');
  }

  try {
    const nextConfig = JSON.stringify({ ...data, jobs: configJobs }, null, 2);
    let prevConfig = null;
    try { if (fs.existsSync(JOBS_FILE)) prevConfig = fs.readFileSync(JOBS_FILE, 'utf-8'); } catch {}
    if (prevConfig !== nextConfig) {
      fs.writeFileSync(JOBS_FILE, nextConfig);
    }
  } catch (err) {
    log(`Error saving jobs: ${err.message}`, 'ERROR');
  }
}

/**
 * Parse a cron expression and return the minimum interval in milliseconds.
 * Used to prevent rapid-fire execution after system sleep/resume.
 * Only handles simple cases (star-slash-N patterns). Returns 0 if unparseable.
 */
function getMinIntervalMs(cron) {
  if (!cron) return 0;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return 0;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // "* * * * *" = every minute
  if (minute === '*') return 60 * 1000;

  // "*/N * * * *" = every N minutes
  const everyNMin = minute.match(/^\*\/(\d+)$/);
  if (everyNMin) return parseInt(everyNMin[1]) * 60 * 1000;

  // "N * * * *" or "0 */N * * *" = every N hours
  if (hour.match(/^\*\/(\d+)$/)) {
    return parseInt(hour.match(/^\*\/(\d+)$/)[1]) * 60 * 60 * 1000;
  }

  // Fixed hour schedule (e.g. "0 6 * * *") = daily
  if (/^\d+$/.test(hour) && /^\d+$/.test(minute)) {
    return 24 * 60 * 60 * 1000;
  }

  // Fallback: 1 minute minimum
  return 60 * 1000;
}

/**
 * Execute a job based on its type
 */
function executeJob(job) {
  // Global gate: if off, no jobs run regardless of individual enabled state
  if (!isGloballyEnabled()) {
    return;
  }

  // Rate-limit: skip if this job ran too recently (prevents flood after sleep/resume)
  const minInterval = getMinIntervalMs(job.cron);
  if (minInterval > 0) {
    const lastRun = lastExecutionTime.get(job.id);
    if (lastRun) {
      const elapsed = Date.now() - lastRun;
      // Allow execution if at least 50% of the interval has passed
      const threshold = Math.max(minInterval * 0.5, 30000); // at least 30s
      if (elapsed < threshold) {
        log(`Skipping job ${job.id}: last ran ${Math.round(elapsed / 1000)}s ago (min interval: ${Math.round(minInterval / 1000)}s)`);
        return;
      }
    }
  }

  lastExecutionTime.set(job.id, Date.now());
  log(`Executing job: ${job.id} (${job.type})`);
  job.last_run = new Date().toISOString();
  job.run_count = (job.run_count || 0) + 1;

  try {
    switch (job.type) {
      case 'memory-harvester':
        executeMemoryHarvester(job);
        break;

      case 'memory-consolidator':
        executeMemoryConsolidator(job);
        break;

      case 'ephemeral-cleanup':
        executeEphemeralCleanup(job);
        break;

      case 'card-links-cleanup':
        executeCardLinksCleanup(job);
        break;

      case 'command':
        executeCommand(job);
        break;

      case 'script':
        executeScript(job);
        break;

      case 'memory-commit':
        executeMemoryCommit(job);
        break;

      case 'steward-commit':
        executeStewardCommit(job);
        break;

      case 'session-health-check':
        executeSessionHealthCheck(job);
        break;

      case 'steward-resurrect':
        executeStewardResurrect(job);
        break;

      case 'location-reminder':
        executeLocationReminderCheck(job);
        break;

      case 'notification-check':
        executeNotificationCheck(job);
        break;

      default:
        log(`Unknown job type: ${job.type}`, 'ERROR');
    }

    // Update job state
    const jobsData = loadJobs();
    const idx = jobsData.jobs.findIndex(j => j.id === job.id);
    if (idx >= 0) {
      jobsData.jobs[idx].last_run = job.last_run;
      jobsData.jobs[idx].run_count = job.run_count;
      saveJobs(jobsData);
    }

  } catch (err) {
    log(`Error executing job ${job.id}: ${err.message}`, 'ERROR');
    // Outer-level catch — any executor that threw without calling saveJobLog
    // still gets counted as a failure for alerting purposes.
    saveJobLog(job.id, null, err.message);
  }
}

// Per-executor re-entrancy guards. Pre-fix execSync would pin the main loop
// up to its timeout (30s harvester/consolidator, 60s commit) every tick.
// Now we exec-with-callback; if a tick fires while the prior child is still
// running, we skip + log instead of stacking.
let memoryHarvesterRunning = false;
let memoryConsolidatorRunning = false;
let memoryCommitRunning = false;
let stewardCommitRunning = false;

/**
 * Execute memory harvester job
 */
function executeMemoryHarvester(job) {
  if (memoryHarvesterRunning) {
    log('Memory harvester skipped — previous run still in flight', 'WARN');
    saveJobLog(job.id, null, 'skipped: previous run in flight');
    return;
  }
  const minutes = job.config?.minutes || 15;
  const script = path.join(process.cwd(), 'lib/trigger-memory-harvester.js');

  log(`Running memory harvester (${minutes} minute window)`);
  memoryHarvesterRunning = true;
  exec(
    `node "${script}" ${minutes}`,
    { encoding: 'utf-8', cwd: process.cwd(), timeout: 30000 },
    (err, stdout) => {
      memoryHarvesterRunning = false;
      if (err) {
        log(`Memory harvester error: ${err.message}`, 'ERROR');
        saveJobLog(job.id, null, err.message);
        return;
      }
      log(`Memory harvester output: ${stdout.trim()}`);
      saveJobLog(job.id, stdout.trim());
    }
  );
}

/**
 * Execute memory consolidator job
 * Reviews yesterday's daily log and updates MEMORY.md with durable facts
 */
function executeMemoryConsolidator(job) {
  if (memoryConsolidatorRunning) {
    log('Memory consolidator skipped — previous run still in flight', 'WARN');
    saveJobLog(job.id, null, 'skipped: previous run in flight');
    return;
  }
  const script = path.join(process.cwd(), 'lib/trigger-memory-consolidator.js');
  const dateArg = job.config?.date || '';

  log(`Running memory consolidator${dateArg ? ` for ${dateArg}` : ' (yesterday)'}`);
  memoryConsolidatorRunning = true;
  exec(
    `node "${script}" ${dateArg}`,
    { encoding: 'utf-8', cwd: process.cwd(), timeout: 30000 },
    (err, stdout) => {
      memoryConsolidatorRunning = false;
      if (err) {
        log(`Memory consolidator error: ${err.message}`, 'ERROR');
        saveJobLog(job.id, null, err.message);
        return;
      }
      log(`Memory consolidator output: ${stdout.trim()}`);
      saveJobLog(job.id, stdout.trim());
    }
  );
}

/**
 * Execute memory commit job
 * Commits uncommitted memory files to git and pushes to origin
 */
function executeMemoryCommit(job) {
  if (memoryCommitRunning) {
    log('Memory commit skipped — previous run still in flight', 'WARN');
    saveJobLog(job.id, null, 'skipped: previous run in flight');
    return;
  }
  const script = path.join(process.cwd(), 'lib/commit-memories.js');

  log('Running memory commit');
  memoryCommitRunning = true;
  exec(
    `node "${script}"`,
    { encoding: 'utf-8', cwd: process.cwd(), timeout: 60000 },
    (err, stdout) => {
      memoryCommitRunning = false;
      if (err) {
        log(`Memory commit error: ${err.message}`, 'ERROR');
        saveJobLog(job.id, null, err.message);
        return;
      }
      log(`Memory commit output: ${stdout.trim()}`);
      saveJobLog(job.id, stdout.trim());
    }
  );
}

/**
 * Execute steward nightly commit
 * Commits all changes in ~/.homestead/stewards/ (responses.json, sub-docs, queue, etc.)
 */
function executeStewardCommit(job) {
  // Re-entrancy guard — same posture as the memory executors above. Because
  // the git ops are now async, a fresh hourly tick could fire while the prior
  // cycle's git add/status/commit/push is still in flight. Skip + log instead
  // of stacking a second lock-holder on top of the first.
  if (stewardCommitRunning) {
    log('Steward commit skipped — previous run still in flight', 'WARN');
    saveJobLog(job.id, null, 'skipped: previous run in flight');
    return;
  }

  const stewardsDir = path.join(os.homedir(), '.homestead', 'stewards');
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16);
  const results = [];

  log('Running hourly steward commit');

  let release;
  try {
    release = acquireStewardsGitLockSync(stewardsDir);
  } catch (lockErr) {
    if (lockErr instanceof LockTimeoutError) {
      const msg = `stewards: lock timeout after ${lockErr.heldForMs}ms (lock_age=${Math.round(lockErr.lockAgeMs)}ms) — dropping this hourly cycle; next tick will retry`;
      log(msg, 'WARN');
      saveJobLog(job.id, msg, msg);
    } else {
      const msg = `stewards: lock-acquire-failed ${lockErr.message}`;
      log(msg, 'ERROR');
      saveJobLog(job.id, msg, msg);
    }
    return;
  }

  // One async commit-and-push pass over stewardsDir. Every git call goes
  // through execAsync (exec-with-callback) so it NEVER pins the main event
  // loop — the fix for the 2026-07-07 137s fleet-wide :3005 wedge. Only the
  // push carries a timeout (matching pre-fix behavior); add/status/commit are
  // fast local ops that no longer block the loop regardless.
  const commitPass = async (label) => {
    try {
      await execAsync('git add -A', { cwd: stewardsDir });
      const { stdout } = await execAsync('git status --porcelain', { cwd: stewardsDir, encoding: 'utf-8' });
      const status = stdout.trim();
      if (status) {
        await execAsync(`git commit -m "[hourly] ${label} ${timestamp}"`, { cwd: stewardsDir, env: { ...process.env, HOMESTEAD_AUTOSAVE: '1' } });
        // The push is the actual backup. A swallowed failure here let a frozen
        // remote masquerade as green for days (2026-07-21). Report the failure
        // as a "stewards: error" so it trips the hasError alerting gate below,
        // and only claim "pushed" when the push actually resolves. 5min timeout
        // so a large legit push (6k+ commits) has time to complete.
        try {
          await execAsync('git push origin main', { cwd: stewardsDir, timeout: 300000 });
          results.push('stewards: committed + pushed');
        } catch (pushErr) {
          results.push(`stewards: error push FAILED ${pushErr.message}`);
        }
      } else {
        results.push('stewards: clean');
      }
    } catch (err) {
      if (!err.message?.includes('nothing to commit')) results.push(`stewards: error ${err.message}`);
      else results.push('stewards: clean');
    }
  };

  stewardCommitRunning = true;
  (async () => {
    try {
      // Queue snapshot (queue, archives, guest sessions)
      await commitPass('Queue snapshot');
      // Steward configs (CLAUDE.md, skills, knowledge, etc.)
      await commitPass('Steward configs');
    } finally {
      try { release(); } catch (_) {}
      stewardCommitRunning = false;
    }

    const summary = results.join(' | ');
    log(`Steward commit: ${summary}`);
    // Any segment that wrote "error" into results is a real failure. Pre-SPEC-1
    // those got buried in the summary string and never tripped alerting — that's
    // the exact path that let steward-commit fail silently for 12 days.
    const hasError = results.some(r => r.startsWith('stewards: error'));
    if (hasError) {
      saveJobLog(job.id, summary, summary);
    } else {
      saveJobLog(job.id, summary);
    }
  })().catch((err) => {
    // Belt-and-suspenders: the inner finally already releases the lock and
    // clears the guard, but if anything after it throws, make sure the failure
    // is still recorded rather than swallowed by an unhandled rejection.
    log(`Steward commit unexpected error: ${err.message}`, 'ERROR');
    saveJobLog(job.id, `stewards: error ${err.message}`, err.message);
  });
}

/**
 * Resurrect steward and guest tmux sessions if they're missing.
 * Runs every minute so they come back quickly after a reboot.
 */
function executeStewardResurrect(job) {
  const homesteadDir = path.join(os.homedir(), '.homestead');
  const stewardsDir = path.join(homesteadDir, 'stewards');
  const codeDir = path.join(os.homedir(), 'code');

  // Build --add-dir flags (same as holler command)
  let addDirFlags = '';
  try {
    const dirs = fs.readdirSync(codeDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'node_modules')
      .map(d => `--add-dir "${path.join(codeDir, d.name)}"`);
    addDirFlags = dirs.join(' ');
  } catch (err) {
    log(`Steward resurrect: failed to read code dir: ${err.message}`, 'ERROR');
  }

  // Get claude path — newest-version, not PATH-order (see lib/claude-resolver.js).
  const claudePath = require('./claude-resolver').resolveClaudePath();

  const baseFlags = `--dangerously-skip-permissions ${addDirFlags}`;
  const started = [];

  // Sessions to ensure exist: all stewards
  const sessionsToCheck = [];

  // Honor the watchdog's disallow list — sessions in disallowed_sessions are
  // intentionally down. Schema locked 2026-05-18 (plan-node /36) — replaces
  // the old `{sessions:[{name,enabled}]}` shape.
  const pausedSessions = new Set();
  try {
    // MULTI-READ (worker re-home, 2026-08-01): the watchdog re-homed
    // sub-substeward → worker, so its LIVE watchlist is now at
    // rooster/workers/watchdog/watchlist.json. The two older paths
    // (rooster/substewards/watchdog and rooster/substewards/foreman/substewards/watchdog)
    // are BOTH absent on disk post-re-home — reading them threw and the catch{}
    // below silently yielded an EMPTY pausedSessions, so the entire disallow list
    // was NOT honored (paused sessions could get resurrected). Try the live
    // workers/ path FIRST, keep the two legacy paths as additive fallbacks so this
    // keeps working before AND after any future re-home (shape-agnostic, no regression).
    const wlCandidates = [
      path.join(homesteadDir, 'stewards', 'rooster', 'workers', 'watchdog', 'watchlist.json'),
      path.join(homesteadDir, 'stewards', 'rooster', 'substewards', 'watchdog', 'watchlist.json'),
      path.join(homesteadDir, 'stewards', 'rooster', 'substewards', 'foreman', 'substewards', 'watchdog', 'watchlist.json'),
    ];
    const wlPath = wlCandidates.find(p => fs.existsSync(p));
    if (!wlPath) {
      log(`Steward resurrect: watchlist not found at any known path (${wlCandidates.join(', ')}) — pausedSessions EMPTY, disallow list NOT honored`, 'ERROR');
    }
    const wl = JSON.parse(fs.readFileSync(wlPath, 'utf-8'));
    for (const name of (wl.disallowed_sessions || [])) {
      pausedSessions.add(name);
    }
  } catch {}

  // All stewards — skip deprecated ones
  // Stewards to never resurrect (deprecated)
  const skipStewards = new Set(['build-manager', 'alert-triage', 'session-scribe', 'repairman']);
  try {
    const entries = fs.readdirSync(stewardsDir, { withFileTypes: true });
    // NOTE (2026-09-05): a first scan loop used to live here and was DEAD CODE —
    // its guard was `if (fs.existsSync(path.join(stewardsDir, entry.name))) continue;`,
    // which tested the existence of the very directory it was iterating, so it
    // was always true and the loop continued on every entry without ever
    // pushing a session. Removed rather than "fixed": the loop below already
    // enumerates top-level stewards correctly, and dead code that reads like
    // live code is a trap for the next editor.
    //
    // That dead loop was `skipStewards`' ONLY consumer, so the retired-crew
    // list was being enforced nowhere. None of those four dirs exist today
    // (WALL v4 retired them), so nothing regressed — but an unenforced list is
    // the same latent trap as the denylist above, so it is now applied in the
    // real loop below instead of sitting here decorative.
  } catch (err) {
    // No stewards dir yet
  }

  // All stewards + substewards
  const { resolveStewardCwd } = require('./resolve-session-dir');
  try {
    if (fs.existsSync(stewardsDir)) {
      const entries = fs.readdirSync(stewardsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip non-steward dirs. This was a DENYLIST of literal names ('.git',
        // 'all') and it kept leaking: `.git` spawned a bogus holler-.git every
        // tick until patched by name (2026-07-11), then `_archived` did exactly
        // the same thing — an empty archive folder spawning a full session with
        // a 6-server MCP stack every tick (found 2026-09-05).
        //
        // Now a POSITIVE test instead: a top-level dir must prove it is a real
        // steward by having a steward.json, which is what the substeward loop
        // below has always required. Same rule at both levels, no name list to
        // keep patching. `_`-prefixed dirs are also skipped as a cheap guard
        // for future archive/scratch folders.
        //
        // ⚠️ This check requires every REAL steward to actually HAVE a
        // steward.json — crowne-vault-qb-extension was missing one and would
        // have silently stopped being revived. Steward Manager wrote it before
        // this shipped; re-verify that invariant before tightening further.
        if (entry.name === '.git' || entry.name === 'all') continue;
        if (entry.name.startsWith('_')) continue;
        if (skipStewards.has(entry.name)) continue;
        if (!fs.existsSync(path.join(stewardsDir, entry.name, 'steward.json'))) continue;
        const stewardDir = path.join(stewardsDir, entry.name);
        const cwd = resolveStewardCwd(stewardDir);
        // substewardDir = own bin/ dir for the hermetic-respawn PATH (Rooster Q2).
        sessionsToCheck.push({ name: `holler-${entry.name}`, cwd, substewardDir: stewardDir });

        // Scan substewards recursively (supports sub-substewards)
        function scanSubstewards(parentDir, sessionPrefix) {
          const subsDir = path.join(parentDir, 'substewards');
          if (!fs.existsSync(subsDir)) return;
          try {
            const subEntries = fs.readdirSync(subsDir, { withFileTypes: true });
            for (const subEntry of subEntries) {
              if (!subEntry.isDirectory()) continue;
              const subDir = path.join(subsDir, subEntry.name);
              if (!fs.existsSync(path.join(subDir, 'steward.json'))) continue;
              const sessionName = `${sessionPrefix}--${subEntry.name}`;
              const subCwd = resolveStewardCwd(subDir);
              // substewardDir = subDir (holds this substeward's own bin/lib) —
              // load-bearing for the hermetic-respawn PATH scoping (Rooster Q2).
              sessionsToCheck.push({ name: sessionName, cwd: subCwd, substewardDir: subDir });
              // Recurse into sub-substewards
              scanSubstewards(subDir, sessionName);
            }
          } catch (subErr) {
            log(`Steward resurrect: failed to scan substewards of ${sessionPrefix}: ${subErr.message}`, 'ERROR');
          }
        }
        scanSubstewards(stewardDir, `holler-${entry.name}`);

        // Scan workers/ (worker re-home, 2026-08-01). Workers moved out of
        // substewards/foreman/substewards/ into a top-level workers/ dir, so the
        // substewards/ walk above never sees them. MOST workers are ephemeral
        // build-and-graduate sessions that must NOT auto-resurrect on reboot — so
        // unlike substewards, revive a worker ONLY when its steward.json carries an
        // explicit `resurrect: true` opt-in. That flag lives on exactly the PERMANENT
        // workers (rooster watchdog, cv gh-strategy-volume). Torn-down workers are
        // already handled by Rooster's teardown rm-ing the dir (no steward.json → not
        // scanned); the flag additionally keeps ephemeral-but-present workers dead.
        // Session shape `holler-{steading}--{worker}` matches the live re-homed names.
        function scanWorkers(parentDir, sessionPrefix) {
          const workersDir = path.join(parentDir, 'workers');
          if (!fs.existsSync(workersDir)) return;
          try {
            const workerEntries = fs.readdirSync(workersDir, { withFileTypes: true });
            for (const workerEntry of workerEntries) {
              if (!workerEntry.isDirectory()) continue;
              const workerDir = path.join(workersDir, workerEntry.name);
              const wSjPath = path.join(workerDir, 'steward.json');
              if (!fs.existsSync(wSjPath)) continue;
              // Opt-in gate: only permanent workers (resurrect:true) auto-revive.
              let wMeta;
              try {
                wMeta = JSON.parse(fs.readFileSync(wSjPath, 'utf-8'));
              } catch (parseErr) {
                log(`Steward resurrect: skipping worker ${workerEntry.name} — unreadable steward.json: ${parseErr.message}`, 'ERROR');
                continue;
              }
              if (wMeta.resurrect !== true) continue; // ephemeral worker — do not resurrect
              const sessionName = `${sessionPrefix}--${workerEntry.name}`;
              const workerCwd = resolveStewardCwd(workerDir);
              // substewardDir = workerDir (holds this worker's own bin/lib) —
              // load-bearing for the hermetic-respawn PATH scoping (Rooster Q2).
              sessionsToCheck.push({ name: sessionName, cwd: workerCwd, substewardDir: workerDir });
            }
          } catch (workerErr) {
            log(`Steward resurrect: failed to scan workers of ${sessionPrefix}: ${workerErr.message}`, 'ERROR');
          }
        }
        scanWorkers(stewardDir, `holler-${entry.name}`);
      }
    }
  } catch (err) {
    log(`Steward resurrect: failed to scan stewards: ${err.message}`, 'ERROR');
  }

  // Diagnostic summary (worker re-home sweep 2026-08-03): make the two things
  // that silently broke — an EMPTY pausedSessions from an unread watchlist, and
  // workers/ never being scanned — observable on every tick. A pausedSessions of 0
  // here is the fingerprint of the watchlist-read regression this fix closed.
  const workerResurrectTargets = sessionsToCheck
    .filter(s => s.substewardDir && s.substewardDir.includes(`${path.sep}workers${path.sep}`))
    .map(s => s.name);
  log(`Steward resurrect: pausedSessions=${pausedSessions.size}; permanent workers/ resurrect-eligible=[${workerResurrectTargets.join(', ')}]`);

  const now = Date.now();
  for (const { name, cwd, substewardDir } of sessionsToCheck) {
    // Skip paused sessions — watchdog has intentionally disabled them. Drop any
    // stale absence timer too, so if the watchdog un-pauses the session later it
    // gets a fresh grace window rather than an instant revive off an old timestamp.
    if (pausedSessions.has(name)) {
      resurrectAbsenceLedger.delete(name);
      continue;
    }

    // TRIAGE (node /1/143): "needs revival" is no longer just tmux-session-gone.
    // A session whose tmux is ALIVE but whose claude has EXITED (dropped to a
    // bare `; zsh` shell — the auth-expiry class) also needs revival, and the old
    // `has-session`-only check short-circuited PAST it. Classify:
    //   • has-session throws            → GONE  → needs revival (hermetic respawn)
    //   • has-session ok + 'alive'      → skip (live claude)
    //   • has-session ok + 'suspended'  → skip (compute-suspend; dispatcher's job
    //                                     via real walkie traffic — NOT the cron's,
    //                                     Rooster Q3; a respawn would DESTROY its
    //                                     resumable memory)
    //   • has-session ok + 'dead'       → needs revival (dropped-to-shell)
    // The absence ledger now keys on needs-revival = GONE-OR-DEAD (not just gone),
    // so a dead-to-shell session still waits out the anti-thrash grace window
    // before respawn — composing cleanly with the shipped grace guard.
    let needsRevival = false;
    let downReason = 'gone';
    try {
      execSync(`tmux has-session -t "${name}" 2>/dev/null`, { stdio: 'pipe' });
      // tmux session exists — now check CLAUDE-process liveness, not just presence.
      const liveness = classifyLiveness(name);
      if (liveness === 'dead') {
        needsRevival = true;
        downReason = 'dropped-to-shell';
      } else {
        // alive OR suspended — leave alone, and clear any absence timer so a flap
        // (or a suspended session that later resumes) doesn't carry a stale window.
        resurrectAbsenceLedger.delete(name);
      }
    } catch {
      // tmux session fully gone.
      needsRevival = true;
      downReason = 'gone';
    }

    // Grace-window anti-thrash guard: only revive once the session has stayed in
    // a needs-revival state longer than RESURRECT_GRACE_MS. Breaks the
    // re-spawn/crash tight loop for persistent-crash sessions. Applies uniformly
    // to gone AND dropped-to-shell.
    if (needsRevival && resurrectGraceElapsed(name, now)) {
      // Revive via KILL→HERMETIC-RESPAWN. Fleet-wide rip-and-replace (2026-05-04):
      // every revival is fresh-spawn; HANDOFF.md is the bridge to prior state.
      // The dropped-to-shell case has a stale tmux session sitting at a bare
      // shell (possibly with escape-residue, Rooster Q4) — hermeticRespawn
      // kill-sessions it first, then new-sessions a clean pane with the full
      // hermetic env (STEWARD_ROLE / STEWARD_SESSION / scoped PATH, Rooster Q2).
      // The gone case has nothing to kill (harmless no-op) and gets the same
      // hermetic env. Trailing `; zsh` preserved so a future crash re-drops to
      // shell rather than killing the pane (keeps the session self-observable).
      const claudeCmd = `${claudePath} ${baseFlags}; zsh`;

      try {
        hermeticRespawn(name, cwd, substewardDir, claudeCmd);
        started.push(name);
        // Revived — clear the absence timer so the next tick starts fresh. If the
        // spawn fails to stick (persistent crash), the session goes absent/dead
        // again and the grace window restarts, so we still can't tight-loop.
        resurrectAbsenceLedger.delete(name);
        log(`Steward resurrect: started ${name} (${downReason}; kill→hermetic-respawn, rip-and-replace doctrine)`);
      } catch (err) {
        log(`Steward resurrect: failed to start ${name}: ${err.message}`, 'ERROR');
      }
    }
  }

  // Guest sessions — read guests.json and resurrect enabled guests
  const guestsFile = path.join(homesteadDir, 'guests.json');
  try {
    if (fs.existsSync(guestsFile)) {
      const guestsConfig = JSON.parse(fs.readFileSync(guestsFile, 'utf-8'));
      const guests = guestsConfig.guests || [];

      for (const guest of guests) {
        if (!guest.enabled) continue;

        // Build guest-specific --add-dir flags from their projects
        let guestAddDirs = '';
        if (guest.projects && guest.projects.length > 0) {
          guestAddDirs = guest.projects
            .map(p => `--add-dir "${p.path}"`)
            .join(' ');
        }
        const guestFlags = `--dangerously-skip-permissions ${guestAddDirs}`;

        // Shared session
        const shared = guest.sharedSession;
        if (shared && shared.sessionName && shared.sessionDir) {
          // Same liveness triage as the steward loop (node /1/143): revive on
          // GONE or dropped-to-shell (claude dead but tmux alive), skip alive OR
          // suspended. Guests aren't stewards — no STEWARD_ROLE hermetic env — but
          // the dead-to-shell DETECTION and the kill→clean-respawn are identical.
          let sharedNeedsRevival = false;
          let sharedReason = 'gone';
          try {
            execSync(`tmux has-session -t "${shared.sessionName}" 2>/dev/null`, { stdio: 'pipe' });
            const liveness = classifyLiveness(shared.sessionName);
            if (liveness === 'dead') {
              sharedNeedsRevival = true;
              sharedReason = 'dropped-to-shell';
            } else {
              resurrectAbsenceLedger.delete(shared.sessionName);
            }
          } catch {
            sharedNeedsRevival = true;
            sharedReason = 'gone';
          }
          // Same grace window as steward sessions — guests can persistent-crash too.
          if (sharedNeedsRevival && resurrectGraceElapsed(shared.sessionName, now)) {
            try {
              if (!fs.existsSync(shared.sessionDir)) {
                fs.mkdirSync(shared.sessionDir, { recursive: true });
              }
              // Kill any stale (dropped-to-shell) tmux session first so the
              // respawn lands in a clean pane (escape-residue avoidance, Rooster
              // Q4); harmless no-op when the session is fully gone.
              try { execSync(`tmux kill-session -t "=${shared.sessionName}" 2>/dev/null`); } catch {}
              const claudeCmd = `${claudePath} ${guestFlags}; zsh`;
              execSync(`tmux new-session -d -s "${shared.sessionName}" -c "${shared.sessionDir}" "${claudeCmd}"`, { stdio: 'pipe' });
              started.push(shared.sessionName);
              resurrectAbsenceLedger.delete(shared.sessionName);
              log(`Steward resurrect: started guest session ${shared.sessionName} (${sharedReason})`);
            } catch (err) {
              log(`Steward resurrect: failed to start guest ${shared.sessionName}: ${err.message}`, 'ERROR');
            }
          }
        }

        // Personal sessions
        if (guest.personalSessions) {
          for (const ps of guest.personalSessions) {
            if (!ps.sessionName || !ps.sessionDir) continue;
            // Same liveness triage (node /1/143): revive on GONE or
            // dropped-to-shell, skip alive OR suspended.
            let psNeedsRevival = false;
            let psReason = 'gone';
            try {
              execSync(`tmux has-session -t "${ps.sessionName}" 2>/dev/null`, { stdio: 'pipe' });
              const liveness = classifyLiveness(ps.sessionName);
              if (liveness === 'dead') {
                psNeedsRevival = true;
                psReason = 'dropped-to-shell';
              } else {
                resurrectAbsenceLedger.delete(ps.sessionName);
              }
            } catch {
              psNeedsRevival = true;
              psReason = 'gone';
            }
            if (psNeedsRevival && resurrectGraceElapsed(ps.sessionName, now)) {
              try {
                if (!fs.existsSync(ps.sessionDir)) {
                  fs.mkdirSync(ps.sessionDir, { recursive: true });
                }
                // Clean-pane respawn (escape-residue avoidance, Rooster Q4);
                // harmless no-op when the session is fully gone.
                try { execSync(`tmux kill-session -t "=${ps.sessionName}" 2>/dev/null`); } catch {}
                const claudeCmd = `${claudePath} ${guestFlags}; zsh`;
                execSync(`tmux new-session -d -s "${ps.sessionName}" -c "${ps.sessionDir}" "${claudeCmd}"`, { stdio: 'pipe' });
                started.push(ps.sessionName);
                resurrectAbsenceLedger.delete(ps.sessionName);
                log(`Steward resurrect: started guest personal session ${ps.sessionName} (${psReason})`);
              } catch (err) {
                log(`Steward resurrect: failed to start guest personal ${ps.sessionName}: ${err.message}`, 'ERROR');
              }
            }
          }
        }
      }
    }
  } catch (err) {
    log(`Steward resurrect: failed to process guests: ${err.message}`, 'ERROR');
  }

  if (started.length > 0) {
    saveJobLog(job.id, `Started: ${started.join(', ')}`);
  } else {
    saveJobLog(job.id, 'All sessions running');
  }
}

/**
 * Execute session health check
 * Detects stale "working" sessions and spawns a worker to read screens and correct statuses
 */
function executeSessionHealthCheck(job) {
  const script = path.join(process.cwd(), 'lib/check-stale-sessions.js');

  log('Running session health check');

  runNodeScriptAsync(script, 30000, (err, stdout) => {
    if (!err) {
      log(`Session health check output: ${stdout.trim()}`);
      saveJobLog(job.id, stdout.trim());
      return;
    }
    // exit code 0 with "No stale sessions" is normal
    if (err.stdout && err.stdout.includes('No stale sessions')) {
      log('Session health check: no stale sessions');
      saveJobLog(job.id, 'No stale sessions');
    } else {
      log(`Session health check error: ${err.message}`, 'ERROR');
      saveJobLog(job.id, null, err.message);
    }
  });
}

/**
 * Execute ephemeral cleanup job
 * Kills stale ephemeral tmux sessions older than 30 minutes
 */
function executeEphemeralCleanup(job) {
  const script = path.join(process.cwd(), 'lib/cleanup-ephemeral.js');

  log('Running ephemeral session cleanup');

  runNodeScriptAsync(script, 30000, (err, stdout) => {
    if (err) {
      log(`Ephemeral cleanup error: ${err.message}`, 'ERROR');
      saveJobLog(job.id, null, err.message);
      return;
    }
    log(`Ephemeral cleanup output: ${stdout.trim()}`);
    saveJobLog(job.id, stdout.trim());
  });
}

/**
 * Prune stale card links (Josh 2026-09-09, verbatim: "if a link isn't clicked
 * on in a week, it's just cleared from the list... anything that has ever been
 * clicked on, that stays. Anything that's pinned, that stays... I don't
 * necessarily just want it to be a visual clearing where I just don't see it —
 * it would be great if it was like actually removed").
 *
 * Runs in-process rather than as a spawned script: the verdict is pure
 * arithmetic over one small JSON file this process already owns, so a
 * subprocess would cost more than the work. Emits a socket event so any open
 * presenter panel re-hydrates instead of showing links that no longer exist.
 */
function executeCardLinksCleanup(job) {
  try {
    const linksStore = require('./card-links-store');
    const result = linksStore.pruneStaleLinks();
    const summary = result.removed > 0
      ? `Pruned ${result.removed} stale card link${result.removed === 1 ? '' : 's'} ` +
        `(${result.before} → ${result.kept}) across ${Object.keys(result.perSteward).length} steward(s)`
      : `No stale card links to prune (${result.before} kept)`;
    log(summary);

    if (result.removed > 0) {
      // Repaint any open links panel — otherwise it keeps rendering deleted rows
      // until the next reload.
      try {
        const io = globalThis.io;
        if (io) {
          for (const stewardId of Object.keys(result.perSteward)) {
            io.emit('presenter:card-links-updated', { session_name: stewardId });
          }
        }
      } catch (e) {
        log(`Card-links cleanup emit failed: ${e.message}`, 'ERROR');
      }
    }
    saveJobLog(job.id, summary);
  } catch (err) {
    log(`Card-links cleanup error: ${err.message}`, 'ERROR');
    saveJobLog(job.id, null, err.message);
  }
}

/**
 * Execute a shell command job
 */
function executeCommand(job) {
  const { command, cwd } = job.config || {};
  if (!command) {
    log(`No command specified for job ${job.id}`, 'ERROR');
    saveJobLog(job.id, null, 'No command specified');
    return;
  }

  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      cwd: cwd || process.cwd(),
      timeout: 60000 // 1 minute timeout
    });
    log(`Command output: ${output.trim()}`);
    saveJobLog(job.id, output.trim());
  } catch (err) {
    log(`Command error: ${err.message}`, 'ERROR');
    saveJobLog(job.id, null, err.message);
  }
}

/**
 * Execute a Node.js script job
 */
function executeScript(job) {
  const { script, args } = job.config || {};
  if (!script) {
    log(`No script specified for job ${job.id}`, 'ERROR');
    saveJobLog(job.id, null, 'No script specified');
    return;
  }

  const runnerArgs = args ? [...args] : [];

  // Async spawn — fire and forget. Pre-async this used execSync, which is
  // blocking, so a hung child froze the entire scheduler event loop for
  // every other job. Converting to spawn means: one bad script can still
  // hang itself forever (caught by timeout), but nothing else stalls.
  // stdio: ['ignore', 'pipe', 'pipe'] + TMUX-strip env fixes the inherited
  // FD pipe / tmux var deadlock that hung system-health-check indefinitely.
  const runner = script.endsWith('.sh') ? 'bash' : script.endsWith('.py') ? 'python3' : 'node';
  const { TMUX, TMUX_PANE, ...cleanEnv } = process.env;
  const TIMEOUT_MS = 120000;

  let child;
  try {
    child = spawn(runner, [script, ...runnerArgs], {
      cwd: process.cwd(),
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    log(`Script spawn error: ${err.message}`, 'ERROR');
    saveJobLog(job.id, null, err.message);
    return;
  }

  let stdout = '';
  let stderr = '';
  let killed = false;
  let finished = false;

  const timeoutHandle = setTimeout(() => {
    if (finished) return;
    killed = true;
    log(`Script ${job.id} exceeded ${TIMEOUT_MS}ms — killing`, 'WARN');
    try { child.kill('SIGKILL'); } catch {}
  }, TIMEOUT_MS);

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutHandle);
    log(`Script ${job.id} runtime error: ${err.message}`, 'ERROR');
    saveJobLog(job.id, null, err.message);
  });

  child.on('close', (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutHandle);
    if (killed) {
      const msg = `timeout after ${TIMEOUT_MS}ms (killed via ${signal || 'SIGKILL'})`;
      log(`Script ${job.id} ${msg}`, 'ERROR');
      saveJobLog(job.id, stdout.trim() || null, msg);
      return;
    }
    if (code === 0) {
      const out = stdout.trim();
      log(`Script ${job.id} output: ${out}`);
      saveJobLog(job.id, out);
    } else {
      const errText = stderr.trim() || `exited with code ${code}${signal ? ` (signal ${signal})` : ''}`;
      log(`Script ${job.id} error: ${errText}`, 'ERROR');
      saveJobLog(job.id, stdout.trim() || null, errText);
    }
  });
}

/**
 * Run a node/bash/python script as an ASYNC child — the same non-blocking
 * spawn pattern executeScript uses, extracted so the typed executors
 * (session-health, ephemeral-cleanup, location-reminder, notification-check)
 * stop pinning the server event loop. Pre-fix these called execSync(`node ...`)
 * which BLOCKS the main loop for the full child duration (up to their 15-30s
 * timeout) — under box CPU saturation that stretched to the 29-52s EL-LAG
 * stalls + selfping timeouts that wedged :3005 fleet-wide (2026-07-09).
 *
 * stdio ['ignore','pipe','pipe'] + TMUX-strip cleanEnv is load-bearing: it
 * fixes the inherited-FD-pipe / tmux-var deadlock that hung system-health-check
 * indefinitely (same rationale as executeScript's comment).
 *
 * `done(err, stdout, stderr, { code, signal, timedOut })` fires exactly once
 * on completion/timeout/spawn-error so callers keep their own output parsing
 * (e.g. "No stale sessions" is a normal exit-0 case, not an error).
 */
function runNodeScriptAsync(script, timeoutMs, done) {
  const { TMUX, TMUX_PANE, ...cleanEnv } = process.env;

  let child;
  try {
    child = spawn('node', [script], {
      cwd: process.cwd(),
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    done(err, '', '', { code: null, signal: null, timedOut: false });
    return;
  }

  let stdout = '';
  let stderr = '';
  let killed = false;
  let finished = false;

  const timeoutHandle = setTimeout(() => {
    if (finished) return;
    killed = true;
    try { child.kill('SIGKILL'); } catch {}
  }, timeoutMs);

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutHandle);
    done(err, stdout, stderr, { code: null, signal: null, timedOut: false });
  });

  child.on('close', (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutHandle);
    if (killed) {
      const err = new Error(`timeout after ${timeoutMs}ms (killed via ${signal || 'SIGKILL'})`);
      done(err, stdout, stderr, { code, signal, timedOut: true });
      return;
    }
    if (code === 0) {
      done(null, stdout, stderr, { code, signal, timedOut: false });
    } else {
      const err = new Error(stderr.trim() || `exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
      err.stdout = stdout;
      done(err, stdout, stderr, { code, signal, timedOut: false });
    }
  });
}

/**
 * Every-minute scheduler housekeeping that used to piggyback on the
 * session-stuck check (retired 2026-07-03 — the watchdog frozen-detection is
 * now the sole stuck-watcher). Two SEPARATE concerns that must keep firing
 * every tick regardless of the stuck-check retirement:
 *   1. Rooster heartbeat — proves the scheduler is alive and running.
 *   2. active-sessions snapshot — for fast restore on reboot (read by server.js).
 * Re-homed onto the location-reminder tick because it's also cron "* * * * *".
 */
function emitSchedulerHeartbeatAndSnapshot() {
  // Write Rooster heartbeat (proves the scheduler is alive and running)
  try {
    execSync('bash <<REPLACE: your home dir, e.g. /Users/you>>/.homestead/stewards/rooster/heartbeat.sh', { stdio: 'pipe', timeout: 5000 });
  } catch {}

  // Snapshot active sessions (for fast restore on reboot)
  try {
    const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8', timeout: 3000 })
      .trim().split('\n').filter(s => s.startsWith('holler-'));
    if (sessions.length > 0) {
      const snapshotFile = path.join(os.homedir(), '.homestead', 'data', 'active-sessions.json');
      fs.writeFileSync(snapshotFile, JSON.stringify({ sessions, updated: new Date().toISOString() }, null, 2));
    }
  } catch {}
}

/**
 * Execute location reminder check
 * Only actually checks the phone if there are active reminders
 */
function executeLocationReminderCheck(job) {
  // Every-minute housekeeping (heartbeat + session snapshot). Runs BEFORE the
  // no-active-reminders early-return below so it fires every tick.
  emitSchedulerHeartbeatAndSnapshot();

  const script = path.join(process.cwd(), 'lib/check-location-reminders.js');

  // Quick check: skip if no active reminders
  const dataFile = path.join(process.cwd(), 'data', 'location-reminders.json');
  try {
    if (fs.existsSync(dataFile)) {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
      const activeCount = (data.reminders || []).filter(r => r.enabled).length;
      if (activeCount === 0) {
        saveJobLog(job.id, 'No active reminders, skipped');
        return;
      }
    } else {
      saveJobLog(job.id, 'No reminders file, skipped');
      return;
    }
  } catch (err) {
    // If we can't read the file, run the script anyway
  }

  log('Running location reminder check');

  runNodeScriptAsync(script, 15000, (err, stdout) => {
    if (err) {
      log(`Location reminder check error: ${err.message}`, 'ERROR');
      saveJobLog(job.id, null, err.message);
      return;
    }
    log(`Location reminder check: ${stdout.trim()}`);
    saveJobLog(job.id, stdout.trim());
  });
}

/**
 * Execute notification check
 * Lightweight check of Gmail/Slack/phone for new notifications.
 * If anything new, sends to the Rooster via walkie-talkie for triage.
 */
function executeNotificationCheck(job) {
  const script = path.join(process.cwd(), 'lib/check-notifications.js');

  log('Running notification check');

  runNodeScriptAsync(script, 30000, (err, stdout) => {
    if (err) {
      log(`Notification check error: ${err.message}`, 'ERROR');
      saveJobLog(job.id, null, err.message);
      return;
    }
    log(`Notification check: ${stdout.trim()}`);
    saveJobLog(job.id, stdout.trim());
  });
}

/**
 * Schedule a recurring job
 */
function scheduleRecurringJob(job) {
  if (!job.cron) {
    log(`Job ${job.id} has no cron expression`, 'ERROR');
    return null;
  }

  log(`Scheduling job: ${job.id} with cron: ${job.cron}`);

  // c2: capture the job ID (a string), NOT the job object. On every tick we
  // re-load the CURRENT job from disk by id so the run uses live config —
  // config.script/config.command, enabled state, etc. as they exist NOW. This
  // closes the stale-config-closure bug: a raw recurring-jobs.json edit that
  // repoints a job (no restart, no API reschedule) has no path to cancel+
  // reschedule this closure, so pre-c2 it kept running the schedule-time config
  // snapshot forever. Re-loading per tick makes a repoint take effect on the
  // next tick without a restart.
  //
  // .cron stays owned by the node-schedule timer (this closure). A cron CHANGE
  // legitimately needs a reschedule (cancel + re-add) — that's a separate
  // concern from config, which is what a repoint edits. c2 fixes config drift.
  const jobId = job.id;
  const scheduledJob = schedule.scheduleJob(job.cron, () => {
    const current = loadJobs().jobs.find(j => j.id === jobId);
    if (!current) {
      // Job was deleted from disk since it was scheduled. Don't crash the tick;
      // cancel this now-orphaned closure so it stops firing against nothing.
      log(`Job ${jobId} no longer on disk at tick — skipping and cancelling orphaned schedule`, 'WARN');
      cancelScheduledJob(jobId);
      return;
    }
    executeJob(current);
  });

  return scheduledJob;
}

/**
 * Cancel and remove any existing scheduled instance for a job id.
 * Prevents orphaned node-schedule timers from leaking.
 */
function cancelScheduledJob(id) {
  const existing = activeJobs.get(id);
  if (existing) {
    try { existing.cancel(); } catch (err) { log(`Error cancelling ${id}: ${err.message}`, 'WARN'); }
    activeJobs.delete(id);
  }
}

/**
 * Add a new recurring job
 */
function addRecurringJob({ id, type, cron, config, enabled = true }) {
  const job = {
    id,
    type,
    cron,
    config: config || {},
    enabled,
    created_at: new Date().toISOString(),
    last_run: null,
    run_count: 0
  };

  // Save to persistent storage
  const jobsData = loadJobs();
  // Remove existing job with same id
  jobsData.jobs = jobsData.jobs.filter(j => j.id !== id);
  jobsData.jobs.push(job);
  saveJobs(jobsData);

  // Cancel any existing scheduled instance before creating a new one (prevents leak)
  cancelScheduledJob(id);

  // Schedule if enabled
  if (enabled) {
    const scheduledJob = scheduleRecurringJob(job);
    if (scheduledJob) {
      activeJobs.set(id, scheduledJob);
    }
  }

  log(`Added recurring job: ${id}`);
  return job;
}

/**
 * Remove a recurring job
 */
function removeRecurringJob(id) {
  // Cancel and clear from activeJobs map
  cancelScheduledJob(id);

  const jobsData = loadJobs();
  jobsData.jobs = jobsData.jobs.filter(j => j.id !== id);
  saveJobs(jobsData);

  log(`Removed recurring job: ${id}`);
  return true;
}

/**
 * List all recurring jobs
 */
function listRecurringJobs() {
  return loadJobs().jobs;
}

/**
 * Enable/disable a job
 */
function setJobEnabled(id, enabled) {
  const jobsData = loadJobs();
  const job = jobsData.jobs.find(j => j.id === id);

  if (!job) {
    return false;
  }

  job.enabled = enabled;
  saveJobs(jobsData);

  // Always cancel existing scheduled instance first (prevents orphan leak on re-enable)
  cancelScheduledJob(id);

  if (enabled) {
    // Start the job fresh
    const scheduledJob = scheduleRecurringJob(job);
    if (scheduledJob) {
      activeJobs.set(id, scheduledJob);
    }
  }

  log(`Job ${id} ${enabled ? 'enabled' : 'disabled'}`);
  return true;
}

/**
 * Initialize - rehydrate all enabled jobs
 */
function initialize() {
  log('Initializing recurring job scheduler...');

  const jobsData = loadJobs();
  let scheduled = 0;
  let skipped = 0;

  for (const job of jobsData.jobs) {
    if (job.enabled) {
      const scheduledJob = scheduleRecurringJob(job);
      if (scheduledJob) {
        activeJobs.set(job.id, scheduledJob);
        scheduled++;
      }
    } else {
      skipped++;
    }
  }

  log(`Initialized: ${scheduled} jobs scheduled, ${skipped} disabled`);
}

/**
 * Shutdown - cancel all jobs
 */
function shutdown() {
  log('Shutting down recurring job scheduler...');
  for (const [id, job] of activeJobs) {
    job.cancel();
  }
  activeJobs.clear();
}

module.exports = {
  initialize,
  shutdown,
  addRecurringJob,
  removeRecurringJob,
  listRecurringJobs,
  setJobEnabled,
  executeJob, // For manual triggering
  isGloballyEnabled,
  setGlobalGate,
  // Test seams for the c2 stale-config-closure repro: grab the live
  // node-schedule Job so a harness can drive its exact captured closure via
  // .invoke() (proves whether the tick re-loads config or runs a stale
  // snapshot); and reset the per-job rate-limit clock so two ticks can fire
  // back-to-back in a test the way real elapsed wall-clock would allow.
  __getActiveJob: (id) => activeJobs.get(id),
  __resetRateLimit: (id) => lastExecutionTime.delete(id),
  // Test seams for the b emitter-guard proof: drive the real emit-decision
  // path (recordJobFailure) and the emit site (dispatchRoosterFailureAlert)
  // directly so a harness can prove the guard suppresses ONLY a healthy
  // reconciled record and still emits on a genuine streak.
  __failureAlertTestHooks: {
    recordJobFailure,
    dispatchRoosterFailureAlert,
  },
  // Test seam for the steward-resurrect grace-window guard.
  __resurrectGraceTestHooks: {
    resurrectGraceElapsed,
    resurrectAbsenceLedger,
    RESURRECT_GRACE_MS,
    // Liveness discriminator seams (node /1/143) — let a test drive the
    // classifier + respawn against a real throwaway session.
    findClaudePid,
    classifyLiveness,
    hermeticRespawn,
  },
};
