#!/usr/bin/env node
/**
 * check-compute-suspend-stewards.js — fleet-wide COMPUTE-ONLY suspend.
 *
 * The SECOND, gentler sleep mode. SIBLING of check-idle-stewards.js and
 * check-context-pressure-stewards.js. Both of those cousins are MEMORY-
 * DESTRUCTIVE: they fire a handoff walkie, the steward writes HANDOFF.md,
 * kills its tmux, and the dispatcher later fresh-spawns a NEW Claude (NO
 * --continue) that rebuilds from the HANDOFF archive.
 *
 * This one is NOT memory-destructive. It exists purely to reclaim CPU/RAM
 * from idle sessions (Joshua's machine runs ~69 live claude instances; an
 * idle one still holds ~70-210MB RSS). It:
 *
 *   - Detects a session idle >= IDLE_THRESHOLD_SEC (default 14400s / 4h,
 *     the SAME threshold the old idle-sleep used) via the activity file,
 *     EXACTLY like check-idle-stewards.js.
 *
 *   - YIELDS to the memory-handoff path: it only suspends sessions UNDER
 *     the context-pressure gate (peak context < CONTEXT_PRESSURE_PCT of the
 *     detected ceiling). A session AT-OR-OVER 85% must go the memory-handoff
 *     route (check-context-pressure-stewards.js), never this one. This is the
 *     de-confliction: over-85 -> memory path; under-85 + idle-4h -> here.
 *     Peak-context computation + ceiling detection are PORTED verbatim from
 *     check-context-pressure-stewards.js so the two gates agree exactly.
 *
 *   - ACTION (the opposite of the idle-detect action): kill -9 the claude
 *     PROCESS in the pane (frees CPU/RAM), LEAVE THE TMUX SESSION ALIVE.
 *     NO archive, NO handoff, NO HANDOFF.md write, NO walkie round-trip.
 *     Writes a compute-suspend marker file recording the session_id so the
 *     dispatcher knows to resume-in-place via `claude --resume <session_id>`
 *     (NOT fresh-spawn) on the next walkie. See RESUME CONTRACT below.
 *
 * RESUME CONTRACT (implemented in queue-dispatcher.js):
 *   When a walkie arrives for a session whose tmux is alive but claude is
 *   dead, the dispatcher checks for the marker at
 *   /tmp/claude-session-<name>-compute-suspend.json. If present, it resumes
 *   IN-PLACE via `claude --resume <session_id>` in the existing pane's shell
 *   (zero memory loss) instead of wakeFreshSpawn (which kills the tmux and
 *   fresh-spawns NO --continue — memory-destructive). Empirically proven:
 *   --resume <session_id> restores full context AND is unambiguous even when
 *   the cwd/global has multiple transcripts (explicit id, not most-recent).
 *
 * WHY kill -9 (not SIGTERM): Claude Code traps SIGTERM (graceful-shutdown
 * handler) and does NOT exit — empirically verified: SIGTERM left the proc
 * in S+ state, only kill -9 freed the RSS. So this script uses SIGKILL.
 *
 * WHY the pane survives: fleet panes are shaped `zsh` (pane_pid) with claude
 * as a CHILD. kill -9 on the claude child leaves the parent zsh alive at a
 * shell prompt — exactly the surface the dispatcher sends `claude --resume`
 * into. remain-on-exit is off, but we never kill the pane's own zsh.
 *
 * EXCLUSIONS: same as check-idle-stewards / check-context-pressure —
 * SKIP_SESSIONS (Rooster, Watchdog) + SKIP_PATTERNS (wake-*, wake-cycle-*).
 * Rooster is the always-on orchestrator and must NEVER be suspended.
 *
 * Env overrides (mostly for testing):
 *   IDLE_THRESHOLD_SEC    — default 14400 (4h). Same as check-idle-stewards.
 *   CONTEXT_PRESSURE_PCT  — default 0.85. The yield gate; must match
 *                           check-context-pressure-stewards.js.
 *   COMPUTE_SUSPEND_DRY_RUN — if '1', detect + log but do NOT kill (test aid).
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ALWAYS-OFF (Josh directive 2026-09-06): "everyone is off all the time unless
// they are absolutely working." The new trigger drops the 4h dwell entirely — a
// session that goes idle with an EMPTY QUEUE is suspended on the next cycle. The
// 4h idle-sleep job this replaces (check-idle-stewards) is disabled and stays
// that way, per Josh: "get rid of it entirely."
//
// SAFETY: the always-off trigger is OPT-IN and DISABLED BY DEFAULT until Josh
// approves it. The default stays the historical 4h so the live every-minute cron
// keeps its old, known-safe behavior while this is under audit.
//
// WHY THIS IS EXPLICIT (incident 2026-09-06): defaulting this to 0 shipped the
// new trigger to PRODUCTION the instant the file was saved — the cron job runs
// this script every minute and picked it up with no restart and no deploy step.
// Real fleet sessions (alfred among them) were suspended within minutes. A file
// on disk IS the deployment here; there is no staging copy. Set
// ALWAYS_OFF_SHUTDOWN=1 to enable the new behavior.
const ALWAYS_OFF = process.env.ALWAYS_OFF_SHUTDOWN === '1';
// The historical dwell (4h). Sessions NOT in the staged-rollout wave keep using
// this, so a partial rollout can never silently become a fleet-wide one.
const LEGACY_IDLE_THRESHOLD_SEC = 14400;
const IDLE_THRESHOLD_SEC = parseInt(
  process.env.IDLE_THRESHOLD_SEC || (ALWAYS_OFF ? '0' : '14400'),
  10
);
const CONTEXT_PRESSURE_PCT = parseFloat(process.env.CONTEXT_PRESSURE_PCT || '0.85');
const DRY_RUN = process.env.COMPUTE_SUSPEND_DRY_RUN === '1';

// --- Dark-circle UI status (Josh additive req 2026-07-18) ---
// On suspend we set the session's UI status field (drives the dashboard's
// asleep/dark dot); resumeComputeSuspend in queue-dispatcher.js clears it back.
// CONFIRMED by Homestead (2026-07-18, via Rooster): the dark/asleep dot is
// status='idle' → #666666 dark gray, no glow/pulse (present + resumable). NOT
// 'terminated' (#FF3333 bright red = dead/error alarm). Driver = `status` in
// ~/.claude/sessions/<name>.json (via /api/claude-sessions → getStatusColor at
// app/components/right-gutter/utils.ts). Setter lives in
// lib/update-session-status.js. Valid: working|waiting|idle|terminated|interrupted.
const SUSPEND_STATUS = process.env.COMPUTE_SUSPEND_STATUS || 'idle'; // dark-gray dot: present-but-suspended, resumable, un-alarming
let setStatusFn = null;
try {
  ({ setStatus: setStatusFn } = require('./update-session-status.js'));
} catch (e) {
  setStatusFn = null; // non-fatal — dark-circle wiring degrades to no-op, suspend still works
}

const QUEUE_FILE = path.join(os.homedir(), '.homestead', 'queue.json');
const STEWARDS_DIR = path.join(os.homedir(), '.homestead', 'stewards');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Ceiling detection — ported verbatim from check-context-pressure-stewards.js.
const WINDOW_200K = 200000;
const WINDOW_1M = 1000000;
const CEILING_DISCRIMINATOR = WINDOW_200K;

// Same exclusions as the two cousin scripts — kept in sync deliberately.
const SKIP_SESSIONS = new Set([
  // Rooster is the ALWAYS-ON orchestrator — the heartbeat of Homestead. It must
  // NEVER be suspended. Non-negotiable creed-level exclusion.
  'holler-rooster',
  // Watchdog runs a 60s cron cycle and manages its own lifecycle; the standard
  // idle model does not apply.
  //
  // PARAMETERIZED (GOTCHA 2 — worker re-home): watchdog COORDINATED value-flip
  // landed 2026-08-01 — re-homed sub-substeward → worker, live session is now
  // `holler-rooster--watchdog`. Default updated to confirmed live name; still
  // overridable via WATCHDOG_SESSION env. Kept in sync with the cousin scripts.
  process.env.WATCHDOG_SESSION || 'holler-rooster--watchdog',
  // --- Added 2026-09-06 for the always-off rollout (Rooster's call) ---
  // These matter FAR more under the immediate-idle trigger than they did at a 4h
  // dwell: a session now suspends on its FIRST idle tick, so a Top that is woken
  // constantly would cycle continuously, and any cost lands on Josh's own paths.
  // Alfred owns notification triage — he is Josh's INBOUND path, and a lost or
  // merely delayed notification is a real cost to Josh, not an internal one.
  'holler-alfred',
  // Steward Manager owns fleet doctrine; peers walkie it and block on an answer.
  'holler-steward-manager',
  // Homestead owns :3005 (this very dispatcher) and the APK, and is woken
  // constantly. Suspending the owner of the delivery path during a rollout of a
  // delivery-path change is a needless coupling.
  'holler-homestead',
].filter(Boolean));

const SKIP_PATTERNS = [
  /^wake-cycle-/,
  /^wake-/,
];

/**
 * STAGED-ROLLOUT INCLUDE-LIST (ALWAYS_OFF_SESSIONS) — added 2026-09-06.
 *
 * WHY THIS EXISTS: the always-off trigger is all-or-nothing without it. The two
 * available switches (server env, or hard-coding) both apply to the WHOLE fleet
 * at once, and this feature runs on every session many times a day with a SILENT
 * failure mode — a message simply doesn't arrive, with no error. Enabling that
 * across ~30 sessions in one step, on the same day two message-loss defects were
 * found in this exact path, is not a rollout; it's a bet.
 *
 * SEMANTICS — deliberately inert by default:
 *   unset / empty  -> no effect whatsoever. Every session keeps the historical
 *                     4h dwell. This is the state the code LANDS in.
 *   non-empty      -> ONLY the named sessions get the immediate-idle trigger.
 *                     Everyone else still uses IDLE_THRESHOLD_SEC (4h default).
 *
 * It is an ALLOW-list layered UNDER the existing exclusions, never over them: a
 * session in SKIP_SESSIONS stays protected even if someone also names it here.
 * Protection always wins over eligibility.
 *
 * ROLLBACK: shrink or unset the variable. No deploy, no revert, no restart of
 * anything — the next cron tick reads the new value. That property is the main
 * reason this is worth six lines.
 *
 * Format: comma-separated tmux session names, whitespace tolerated.
 *   ALWAYS_OFF_SESSIONS='holler-a,holler-b'
 *
 * THE `ALL` SENTINEL (2026-09-11, Josh's explicit call to widen fleet-wide).
 * A literal `ALL` means every session the trigger reaches — i.e. everything not
 * in SKIP_SESSIONS/SKIP_PATTERNS. It exists because an ENUMERATED list cannot
 * express "and everything spawned from now on": a name list is a snapshot, and
 * every worker created after it was written would silently keep the 4h dwell.
 * That is a rollout that quietly stops rolling.
 *
 * This does NOT reopen the 2026-09-06 footgun. That bug was an EMPTY list
 * meaning "no restriction", so an operator CLEARING the list to halt instead
 * widened it to the whole fleet. Empty still means EMPTY WAVE. Widening now
 * requires typing a deliberate, unmistakable token — you cannot arrive at `ALL`
 * by deleting something.
 */
const ALWAYS_OFF_ALL = (process.env.ALWAYS_OFF_SESSIONS || '').trim() === 'ALL';
const ALWAYS_OFF_SESSIONS = new Set(
  ALWAYS_OFF_ALL
    ? []
    : (process.env.ALWAYS_OFF_SESSIONS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
);

/**
 * ⚠️ THE LIST CAN ONLY EVER NARROW SCOPE — IT CAN NEVER WIDEN IT.
 *
 * The first version of this made an EMPTY list mean "no restriction", i.e.
 * STAGED_ROLLOUT = size > 0 and inWave = !STAGED_ROLLOUT || has(name). That is a
 * footgun aimed squarely at the moment of highest intent-to-halt: an operator
 * emptying a scope list is almost always trying to STOP something. It went
 * exactly that way in production on 2026-09-06 — clearing the list to roll back
 * flipped the job to ALWAYS-OFF FLEET-WIDE and suspended four sessions,
 * including ones outside the intended wave.
 *
 * Now: whenever the trigger is armed, the list is ALWAYS consulted. An empty
 * list under an armed trigger means an EMPTY WAVE — nothing is eligible — rather
 * than everything. Emptying the list is therefore a safe way to halt, matching
 * what an operator reaching for it actually intends.
 *
 * THE TRIGGER FLAG (ALWAYS_OFF_SHUTDOWN) IS THE ONLY KILL SWITCH that turns the
 * feature off, and unsetting it restores the historical 4h dwell for everyone.
 * Either action is now safe; neither can widen anything.
 */
const STAGED_ROLLOUT = ALWAYS_OFF;

function log(...args) {
  console.log('[check-compute-suspend-stewards]', ...args);
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
 * Resolve steward dir the SAME WAY the dispatcher does. Nested-substeward
 * aware. Used to confirm the session is provisioned (not a guest) — matches
 * check-idle-stewards' guard so we never suspend an unwakeable session.
 */
function resolveSessionDir(sessionName) {
  // Use the SAME resolver the dispatcher tries FIRST. The structural
  // `--` -> /substewards/ rule below is only its FALLBACK, and porting just the
  // fallback silently excluded EVERY worker: workers live under
  // `<steward>/workers/<name>`, so they resolved to a nonexistent path, failed
  // the provisioned-session guard, and were never suspended. Same defect fixed
  // in check-idle-stewards.js the same day (d9a59a36ea) — 17 of 29 live
  // sessions were workers, i.e. the majority of the fleet was exempt.
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

/** Parse `2026-05-04T14:10:14.241827` (ISO-ish, no TZ). Treat as UTC. */
function parseActivityTimestamp(s) {
  if (!s || typeof s !== 'string') return null;
  const withZ = /[Z+-]/.test(s.slice(10)) ? s : `${s}Z`;
  const ms = Date.parse(withZ);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Locate the transcript .jsonl by globbing every project dir for
 * <session_id>.jsonl. session_ids are unique across project dirs (verified
 * live: 0 collisions). Ported from check-context-pressure-stewards.js.
 */
function findTranscript(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  const fname = `${sessionId}.jsonl`;
  for (const d of dirs) {
    const candidate = path.join(PROJECTS_DIR, d, fname);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Peak live-context ever held. Ported from check-context-pressure-stewards.js. */
function computePeakContext(transcriptPath) {
  let peak = 0;
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return 0;
  }
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = obj && obj.message && obj.message.usage;
    if (!usage) continue;
    const total =
      (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0);
    if (total > peak) peak = total;
  }
  return peak;
}

function detectCeiling(peak) {
  return peak > CEILING_DISCRIMINATOR ? WINDOW_1M : WINDOW_200K;
}

/**
 * Resolve a queue item's target_session to a canonical tmux session name the
 * SAME way the dispatcher does. REQUIRED for the in-flight guard below to be
 * correct: senders address sessions loosely ("homestead", "GiveGrove/branch",
 * a bare worker name), and the dispatcher resolves those through
 * steward-resolver before delivering. A raw string compare against the
 * canonical `holler-*` name therefore MISSES most real walkies — and a guard
 * that silently misses is worse than no guard, because it reads as protection.
 * Falls back to the raw value when the resolver can't place it (an unresolvable
 * target is one the dispatcher will not deliver either).
 */
function canonicalTarget(targetSession) {
  if (!targetSession || typeof targetSession !== 'string') return null;
  try {
    const resolver = require('./steward-resolver');
    const r = resolver.resolveTarget(targetSession);
    if (r && r.valid && r.sessionName) return r.sessionName;
  } catch {}
  return targetSession;
}

/**
 * True if the queue holds ANY undelivered/unconfirmed work for this session.
 *
 * THE RACE THIS CLOSES (Josh named it directly; hole found 2026-09-06):
 * the previous version of this guard only matched `source` of 'idle-detect' or
 * 'context-pressure' — the two MEMORY-HANDOFF paths. Ordinary walkies (every
 * message a steward or Josh actually sends) have other sources entirely, so
 * they did NOT block a suspend. With the OLD 4h idle threshold that was nearly
 * harmless: a session silent for four hours rarely has mail in flight. Moving
 * the trigger to fire-immediately-on-idle makes it load-bearing — the moment a
 * session finishes a turn is EXACTLY the moment a reply to it is most likely to
 * be in the queue. Suspending then kills the pane out from under an in-flight
 * paste and the message is lost off-screen.
 *
 * So this now blocks on the FULL set of non-terminal states:
 *   - 'pending'    — not yet delivered; delivering into a dying pane loses it.
 *   - 'dispatched' — pasted but NOT yet rogered-that. This is the dangerous one:
 *                    the text is on screen and the session is about to be killed
 *                    before it can act on it or confirm it.
 * Terminal states ('confirmed', 'failed', 'skipped-unknown-target', archived)
 * never block — that work is done and holding a session up for it would mean a
 * session with any history never sleeps.
 *
 * Deliberately source-AGNOSTIC: enumerating "safe" sources is precisely the
 * mistake that created this hole. Any live item defers the suspend by one cycle
 * (60s), which costs at most a minute of held memory and can never lose mail.
 */
const LIVE_QUEUE_STATUSES = new Set(['pending', 'dispatched']);

function hasLiveQueueWork(sessionName) {
  if (!fs.existsSync(QUEUE_FILE)) return false;
  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  } catch {
    // A queue we cannot read is a queue we cannot clear. FAIL CLOSED: report
    // "work in flight" so we skip the suspend this cycle rather than killing a
    // session whose mail we simply failed to look at. Costs 60s of memory;
    // the alternative costs a message.
    return true;
  }
  if (!Array.isArray(queue)) return false;
  return queue.some((item) => {
    if (!LIVE_QUEUE_STATUSES.has(item.status)) return false;
    return canonicalTarget(item.target_session) === sessionName;
  });
}

/**
 * Find the live claude PID in a session's pane. Mirrors the dispatcher's
 * needsClaudeRestart two-stage ps-walk:
 *   (a) is the pane_pid itself claude? (post-respawn shape)
 *   (b) is a direct child of pane_pid claude? (zsh+claude fleet shape)
 * Returns the claude PID string, or null if no claude found.
 */
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

  // Stage (a): pane_pid itself claude?
  try {
    const paneComm = execSync(`ps -p ${panePid} -o comm= 2>/dev/null | head -1`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    if (paneComm.split('/').pop() === 'claude') return panePid;
  } catch {
    // fall through
  }

  // Stage (b): direct child of pane_pid whose command contains 'claude'.
  try {
    const childrenLines = execSync(
      `ps -eo pid=,ppid=,command= | awk -v ppid=${panePid} '$2 == ppid'`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    if (childrenLines) {
      for (const line of childrenLines.split('\n')) {
        // Match the claude binary specifically (avoid false-matching an arg
        // like `--add-dir .../claude-summary-hooks`). The binary is invoked as
        // `.../bin/claude ` or `.../local/bin/claude ` — anchor on `/claude `
        // or a line that starts the command with claude.
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

/** Write the compute-suspend marker the dispatcher reads to resume-in-place. */
function writeSuspendMarker(sessionName, sessionId, sessionDir) {
  const markerPath = `/tmp/claude-session-${sessionName}-compute-suspend.json`;
  const marker = {
    session_name: sessionName,
    session_id: sessionId,
    session_dir: sessionDir,
    suspended_at: new Date().toISOString(),
    reason: 'compute-only-suspend (idle >= threshold, under context-pressure gate)',
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
  return markerPath;
}

/** Reset the activity file to a clean idle state so the UI dots match reality. */
function resetActivityIdle(sessionName) {
  const f = `/tmp/claude-session-${sessionName}-activity.json`;
  try {
    let obj = {};
    if (fs.existsSync(f)) {
      try { obj = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { obj = {}; }
    }
    obj.is_working = false;
    obj.current_tool = null;
    obj.updated_at = new Date().toISOString().replace('Z', '000000').replace(/\.(\d{3})\d*/, '.$1');
    fs.writeFileSync(f, JSON.stringify(obj));
  } catch {
    // non-fatal
  }
}

/**
 * Set the UI dark-circle status on suspend. Single field-write via the shared
 * setter. Non-fatal: if the setter is unavailable or errors, we log and move on
 * — the suspend itself already succeeded and the dot mismatch is cosmetic.
 */
function setSuspendUIStatus(sessionName) {
  if (!setStatusFn) {
    log(`dark-circle: setStatus unavailable, skipping UI status for ${sessionName}`);
    return;
  }
  try {
    const ok = setStatusFn(sessionName, SUSPEND_STATUS);
    log(`dark-circle: set ${sessionName} status -> ${SUSPEND_STATUS} (${ok ? 'ok' : 'no-session-file'})`);
  } catch (e) {
    log(`dark-circle: failed to set status for ${sessionName}: ${e.message}`);
  }
}

function main() {
  const sessions = listHollerSessions();
  if (sessions.length === 0) {
    log('no holler-* tmux sessions found');
    return;
  }
  // State the rollout stage up front — the job's own output should say which
  // mode it is in, so nobody has to infer it from behaviour or read the code.
  // Three honest states. "ALWAYS-OFF FLEET-WIDE" is deliberately GONE: the list
  // can no longer widen scope, so an armed trigger is ALWAYS a wave — possibly an
  // empty one. Saying "wave of 0 (nothing eligible)" out loud is what makes the
  // halt legible; the old label implied a state that can no longer be reached.
  const stage = !ALWAYS_OFF
    ? 'legacy dwell (always-off inactive)'
    : (ALWAYS_OFF_ALL
        ? 'FLEET-WIDE (ALL — every session except the protected list)'
        : ALWAYS_OFF_SESSIONS.size === 0
          ? 'STAGED (wave of 0 — NOTHING eligible; list empty under an armed trigger)'
          : `STAGED (wave of ${ALWAYS_OFF_SESSIONS.size}: ${[...ALWAYS_OFF_SESSIONS].join(', ')})`);
  log(`scanning ${sessions.length} holler-* sessions; mode=${stage} idle_threshold=${IDLE_THRESHOLD_SEC}s legacy=${LEGACY_IDLE_THRESHOLD_SEC}s pressure_gate=${CONTEXT_PRESSURE_PCT}${DRY_RUN ? ' [DRY-RUN]' : ''}`);

  const now = Date.now();
  let suspended = 0;
  let skipped = 0;

  for (const sessionName of sessions) {
    // PROTECTED — permanent, never suspends regardless of rollout stage. Logged
    // distinctly from "not eligible yet" (Rooster's ask) so the job output alone
    // tells you which of the two is holding a session back, without reading code.
    if (SKIP_SESSIONS.has(sessionName)) {
      log(`skip ${sessionName}: PROTECTED (permanent exclusion — never suspends)`);
      skipped++;
      continue;
    }
    if (SKIP_PATTERNS.some((rx) => rx.test(sessionName))) {
      log(`skip ${sessionName}: PROTECTED (matches an excluded name pattern)`);
      skipped++;
      continue;
    }

    // STAGED ROLLOUT. Under a non-empty include-list, a session NOT named in it
    // is not "protected" — it is simply not in this wave yet, and it still uses
    // the historical 4h dwell below via its own threshold. Distinct wording is
    // deliberate: PROTECTED vs NOT-IN-WAVE are different states with different
    // futures, and conflating them in the log is how a wave gets misread.
    const inWave = !STAGED_ROLLOUT || ALWAYS_OFF_ALL || ALWAYS_OFF_SESSIONS.has(sessionName);
    // The trigger this session actually gets. Under a staged rollout only the
    // named sessions get the immediate-idle threshold; everyone else keeps the
    // historical dwell, so a partial rollout can never accidentally go fleet-wide.
    const effectiveThresholdSec = inWave ? IDLE_THRESHOLD_SEC : LEGACY_IDLE_THRESHOLD_SEC;

    const activity = readActivityFile(sessionName);
    if (!activity) { skipped++; continue; }

    // --- Idle gate (identical to check-idle-stewards.js) ---
    if (activity.is_working === true) { continue; }

    const updatedMs = parseActivityTimestamp(activity.updated_at);
    if (updatedMs == null) {
      log(`skip ${sessionName}: could not parse updated_at (${activity.updated_at})`);
      skipped++;
      continue;
    }
    const idleSec = Math.floor((now - updatedMs) / 1000);
    if (idleSec < effectiveThresholdSec) {
      // Only NOISE about a not-in-wave session when it WOULD have qualified under
      // the new trigger — that is the informative case ("this one would have slept
      // if it were in the wave"). Sessions that are simply still busy log nothing,
      // exactly as before.
      if (STAGED_ROLLOUT && !inWave && idleSec >= IDLE_THRESHOLD_SEC) {
        log(`skip ${sessionName}: NOT-IN-WAVE (idle ${idleSec}s; would suspend under always-off, but this wave does not include it — using ${LEGACY_IDLE_THRESHOLD_SEC}s dwell)`);
      }
      continue;
    }

    // --- Provisioned-dir guard (so we never suspend an unwakeable guest) ---
    const sessionDir = resolveSessionDir(sessionName);
    if (!fs.existsSync(sessionDir)) {
      log(`skip ${sessionName}: no steward dir (guest/unprovisioned)`);
      skipped++;
      continue;
    }

    // --- IN-FLIGHT MAIL GUARD (the anti-message-loss gate) ---
    // Blocks the suspend whenever ANY undelivered or unconfirmed item targets
    // this session — ordinary walkies included, not just the two handoff
    // sources. Under the always-off trigger this is the single most important
    // check in the script: "just went idle" is exactly when a reply is most
    // likely to be mid-flight. Deferring costs one cycle; not deferring costs
    // Josh a message. See hasLiveQueueWork().
    if (hasLiveQueueWork(sessionName)) {
      log(`skip ${sessionName}: live queue work in flight (pending/dispatched) — deferring suspend one cycle`);
      skipped++;
      continue;
    }

    // --- YIELD gate: only suspend UNDER the context-pressure threshold ---
    // A session at/over 85% must go the memory-handoff route, never here.
    if (!activity.session_id) {
      log(`skip ${sessionName}: no session_id in activity file — cannot verify context gate OR resume; refusing to suspend`);
      skipped++;
      continue;
    }
    const transcript = findTranscript(activity.session_id);
    if (!transcript) {
      log(`skip ${sessionName}: no transcript for session_id=${activity.session_id} — cannot verify context gate; refusing to suspend`);
      skipped++;
      continue;
    }
    const peak = computePeakContext(transcript);
    const ceiling = detectCeiling(peak);
    const pct = ceiling > 0 ? peak / ceiling : 0;
    if (pct >= CONTEXT_PRESSURE_PCT) {
      log(`skip ${sessionName}: at ${(pct * 100).toFixed(1)}% context (>= ${(CONTEXT_PRESSURE_PCT * 100).toFixed(0)}% gate) — YIELDING to memory-handoff path`);
      skipped++;
      continue;
    }

    // --- Already compute-suspended? (claude already dead + marker present) ---
    const markerPath = `/tmp/claude-session-${sessionName}-compute-suspend.json`;
    const claudePid = findClaudePid(sessionName);
    if (!claudePid) {
      if (fs.existsSync(markerPath)) {
        log(`skip ${sessionName}: already compute-suspended (no claude proc + marker present)`);
      } else {
        log(`skip ${sessionName}: no claude proc found and no marker — not our state, leaving alone`);
      }
      skipped++;
      continue;
    }

    // --- SUSPEND: kill -9 the claude proc, keep tmux, write marker ---
    log(`SUSPENDING: ${sessionName} idle=${idleSec}s ctx=${(pct * 100).toFixed(1)}% claude_pid=${claudePid}${DRY_RUN ? ' [DRY-RUN, not killing]' : ''}`);
    if (DRY_RUN) { skipped++; continue; }

    try {
      // Write the marker FIRST so a walkie that races in during the kill still
      // finds the resume path (the dispatcher tolerates a marker + live claude:
      // it only acts on the marker when claude is actually dead).
      writeSuspendMarker(sessionName, activity.session_id, sessionDir);
      // Drop any previous resume stamp so the fresh-pane paste gate keys off the
      // NEXT resume, not a stale one from an earlier cycle.
      try { fs.unlinkSync(`/tmp/claude-session-${sessionName}-resumed-at`); } catch {}
      execSync(`kill -9 ${claudePid} 2>/dev/null`);
      resetActivityIdle(sessionName);
      setSuspendUIStatus(sessionName); // dark-circle: set UI dot to asleep/dark
      log(`OK: suspended ${sessionName} (killed claude ${claudePid}, tmux kept alive, marker written)`);
      suspended++;
    } catch (e) {
      log(`ERROR: suspend of ${sessionName} failed: ${e.message}`);
      // Best-effort: remove the marker we wrote so the dispatcher doesn't try to
      // resume a session whose claude is still alive.
      try { fs.unlinkSync(markerPath); } catch {}
      skipped++;
    }
  }

  log(`done: suspended=${suspended} skipped=${skipped} total=${sessions.length}`);
}

try {
  main();
} catch (err) {
  log(`FATAL: ${err.message}`);
  process.exit(1);
}
