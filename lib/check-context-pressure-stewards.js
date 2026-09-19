#!/usr/bin/env node
/**
 * check-context-pressure-stewards.js — fleet-wide context-pressure handoff trigger.
 *
 * SIBLING of check-idle-stewards.js. This AUGMENTS the 4-hour idle clock, it
 * does NOT replace it. Both cron jobs run. Where check-idle-stewards fires a
 * sleep walkie on idle alone, this one fires a HANDOFF walkie only when a
 * session is BOTH near its context ceiling AND has been idle 4+ hours.
 *
 * AND-GATE (Josh's intended rule, restored 2026-08-04): fire the handoff ONLY IF
 *   (a) live context >= 85% of the CORRECT ceiling (e.g. 850K of a 1M window), AND
 *   (b) the session has had NO activity for >= 4 hours (idleSec >= 14400).
 * The point: get a steward to write a clean HANDOFF.md and cycle BEFORE a hard
 * context wall — but NEVER interrupt a session that is actively working. A
 * previous version fired on the 85% condition ALONE, "regardless of whether it's
 * idle" — that hit Crowne Vault MID-STREAM (mid-thought) and killed it. The idle
 * gate is what keeps this from severing an active session's train of thought;
 * near-full-but-working sessions are left alone until they naturally go quiet.
 *
 * Runs every ~5 minutes via recurring-jobs.json (id: check-context-pressure-stewards).
 *
 * MECHANISM (empirically prototyped by Scribe on the live fleet, then re-verified
 * live during this build — see the Worker's scratch log):
 *
 *   1. For each active `holler-*` tmux session, read its activity file at
 *      `/tmp/claude-session-<name>-activity.json` to get session_id + cwd.
 *
 *   2. Map to the transcript .jsonl. The cwd->project-dir encoding is NOT a
 *      naive s#/#-#g (a leading dot in a path segment collapses into the dash
 *      run: `/.homestead` -> `--homestead`). Rather than reproduce that rule,
 *      we GLOB every project dir under `~/.claude/projects/` for a file named
 *      `<session_id>.jsonl` — session_ids are unique across project dirs
 *      (verified live: 0 collisions), so the first match is authoritative.
 *      Robust to any future encoding change.
 *
 *   3. Compute PEAK context tokens EVER held across the transcript. Per-turn
 *      live context = input_tokens + cache_read_input_tokens +
 *      cache_creation_input_tokens (cache_read alone undercounts). We gate on
 *      the RUNNING PEAK, not the last block — the last block dips after internal
 *      compacts, which would make the gate flap.
 *
 *   4. CEILING DETECTION (FIXED 2026-08-04). The transcript per-message `model`
 *      field is identically "claude-opus-4-8" for BOTH 200K and 1M windows — it
 *      does NOT carry the "[1m]" marker, so it can't tell us the window on its
 *      own. The AUTHORITATIVE signal is the fleet's `~/.claude/settings.json`
 *      `model` key: on this machine it reads "opus[1m]", and the "[1m]" suffix
 *      means every session on the fleet runs on the 1,000,000-token window.
 *      (Empirically confirmed: sessions routinely peak ~999K tokens — impossible
 *      under a 200K window.) We map any "[1m]" variant -> 1,000,000 and the base
 *      model -> 200,000, and use THAT as the denominator DIRECTLY.
 *
 *      THE BUG THIS REPLACES: the old code guessed 200K until a session had
 *      *actually crossed* 200K tokens, only then flipping the denominator to 1M.
 *      That meant a genuine 1M session sitting at 183K read as 91% of 200K and
 *      fired a FALSE handoff — which killed Crowne Vault mid-work on 2026-08-04.
 *      A session must never be judged "nearly full" just because it hasn't yet
 *      grown past an arbitrary threshold.
 *
 *      SAFETY FLOOR: we also keep the old peak>200K signal, but ONLY as a
 *      one-directional floor — if a session has EVER held >200K it is
 *      definitively 1M regardless of what settings.json says (protects the
 *      crowne-vault peak=998539 case even if settings.json is ever missing or
 *      reverts to the base model). We take max(settingsCeiling, peakFloor); we
 *      NEVER let the peak DEMOTE a session below the settings-derived window.
 *
 *   5. IDLE GATE (condition (a) of the AND-gate). Compute idleSec exactly as the
 *      sibling check-idle-stewards.js does: idleSec = now - parse(activity.updated_at).
 *      Require idleSec >= CONTEXT_PRESSURE_IDLE_SEC (default 14400 = 4h). We also
 *      skip when activity.is_working === true (a session mid-turn RIGHT NOW is by
 *      definition not idle, regardless of updated_at). This is the gate that was
 *      MISSING and let the checker sever an actively-working session mid-stream.
 *
 *   6. CONTEXT GATE (condition (b)). At >= 85% of the detected ceiling AND past
 *      the idle gate, fire a HANDOFF walkie via the queue API
 *      (POST http://localhost:3005/api/queue), TAGGED source:context-pressure so
 *      the receiver knows it's context-driven, not idle-driven.
 *
 *   8. IDEMPOTENT: skip if a pending context-pressure walkie for the target is
 *      already in the queue (mirrors check-idle-stewards' pending-guard). Without
 *      this we'd re-fire every 5 min while the target writes its HANDOFF.
 *
 *   9. EXCLUSIONS: reuse check-idle-stewards' SKIP_SESSIONS (Rooster, Watchdog)
 *      and SKIP_PATTERNS (wake-*, wake-cycle-*). Rooster is the always-on
 *      orchestrator and must NEVER be handed off; guest/wake scaffolding sessions
 *      have no steward dir to cycle into.
 *
 * Expected live fire shape (do NOT trust a build that deviates without a reason):
 * Because of the AND-gate, a normal working fleet fires on essentially NOBODY —
 * a session only qualifies if it's simultaneously >=85% full AND has gone quiet
 * for 4+ hours. If the gate fires on an ACTIVELY-working session, the idle gate
 * is broken; if it fires on the whole fleet, the ceiling detection is wrong —
 * debug against that shape.
 *
 * Env overrides (mostly for testing):
 *   CONTEXT_PRESSURE_PCT       — default 0.85 (fraction of ceiling that triggers)
 *   CONTEXT_PRESSURE_IDLE_SEC  — default 14400 (4h idle required before firing;
 *                                mirrors check-idle-stewards' IDLE_THRESHOLD_SEC)
 *   QUEUE_API                  — default http://localhost:3005/api/queue
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CONTEXT_PRESSURE_PCT = parseFloat(process.env.CONTEXT_PRESSURE_PCT || '0.85');
// Idle gate (condition (a) of the AND-gate): a session must have been quiet at
// least this long before a context-pressure handoff can fire. Mirrors the
// sibling check-idle-stewards.js IDLE_THRESHOLD_SEC (4h, Joshua-set). This is
// what prevents severing an actively-working session mid-stream.
const CONTEXT_PRESSURE_IDLE_SEC = parseInt(process.env.CONTEXT_PRESSURE_IDLE_SEC || '14400', 10);
const QUEUE_API = process.env.QUEUE_API || 'http://localhost:3005/api/queue';
const QUEUE_FILE = path.join(os.homedir(), '.homestead', 'queue.json');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Window ceilings. WINDOW_1M is the "[1m]" long-context variant; WINDOW_200K is
// the base model. See detectCeiling() for how we pick between them.
const WINDOW_200K = 200000;
const WINDOW_1M = 1000000;
// One-directional safety floor: any session that has EVER held more than this
// many tokens is definitively on the 1M window, no matter what settings.json
// says. Used only to PROMOTE a session to 1M, never to demote it.
const CEILING_DISCRIMINATOR = WINDOW_200K;
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

// Same exclusions as check-idle-stewards.js — kept in sync deliberately.
const SKIP_SESSIONS = new Set([
  // Rooster is the ALWAYS-ON orchestrator — the heartbeat of Homestead. It must
  // NEVER be a handoff/sleep target. Non-negotiable exclusion.
  'holler-rooster',
  // Watchdog runs a 60s cron cycle and manages its own lifecycle; the standard
  // idle/context model does not apply.
  //
  // PARAMETERIZED (GOTCHA 2 — worker re-home): watchdog COORDINATED value-flip
  // landed 2026-08-01 — re-homed sub-substeward → worker, live session is now
  // `holler-rooster--watchdog`. Default updated to confirmed live name; still
  // overridable via WATCHDOG_SESSION env. Kept in sync with the cousin scripts.
  process.env.WATCHDOG_SESSION || 'holler-rooster--watchdog',
].filter(Boolean));

// Skip session-name patterns (test scaffolding, wake-protocol harnesses, guest
// wake sessions that have no steward dir to cycle into).
const SKIP_PATTERNS = [
  /^wake-cycle-/,
  /^wake-/,
];

function log(...args) {
  console.log('[check-context-pressure-stewards]', ...args);
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
 * Parse the activity file's `updated_at` to epoch ms. Kept byte-identical to
 * check-idle-stewards.js: the timestamp is ISO8601 with fractional seconds and
 * (usually) NO timezone offset, so we append 'Z' when no offset is present.
 * Returns null if unparsable.
 */
function parseActivityTimestamp(s) {
  if (!s || typeof s !== 'string') return null;
  // Append Z if no offset present.
  const withZ = /[Z+-]/.test(s.slice(10)) ? s : `${s}Z`;
  const ms = Date.parse(withZ);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve a session's transcript .jsonl by GLOBBING every project dir for
 * <session_id>.jsonl. session_ids are unique across project dirs (verified
 * live: 0 collisions), so the first match is authoritative. This deliberately
 * avoids reproducing the cwd->project-dir encoding rule (which has non-obvious
 * dot-collapse behavior). Returns the absolute path or null.
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

/**
 * Compute the PEAK live-context token count ever held in a transcript.
 * Per-turn live context = input + cache_read + cache_creation. We parse the
 * JSONL line-by-line (it's one JSON object per line) and track the max. Any
 * unparsable line or usage-less line is skipped. Returns the peak, or 0 if the
 * transcript has no usage blocks.
 */
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

/**
 * Read the fleet's configured model window from ~/.claude/settings.json.
 * Returns WINDOW_1M if the `model` value carries a "[1m]" long-context marker
 * (e.g. "opus[1m]", "sonnet[1m]", "claude-opus-4-8[1m]"), else WINDOW_200K.
 * If settings.json is missing/unreadable/has no model field, defaults to
 * WINDOW_200K — the conservative base window (a smaller denominator can only
 * make the gate MORE eager, which the peak-floor in detectCeiling() corrects
 * upward for any session actually large enough to be on 1M).
 */
function readSettingsWindow() {
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
  } catch {
    return WINDOW_200K;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return WINDOW_200K;
  }
  const model = parsed && typeof parsed.model === 'string' ? parsed.model : '';
  // "[1m]" anywhere in the model slug = long-context 1M variant.
  return /\[1m\]/i.test(model) ? WINDOW_1M : WINDOW_200K;
}

/**
 * Detect the real context-window ceiling for a session.
 *
 * Primary signal: the fleet's settings.json model window (readSettingsWindow) —
 * used DIRECTLY as the denominator, so a 1M session at 183K reads ~18%, not 91%.
 *
 * Safety floor: if the session has EVER held more than CEILING_DISCRIMINATOR
 * (200K) tokens it is definitively a 1M window regardless of settings — this can
 * only PROMOTE to 1M, never demote below the settings-derived window.
 *
 * We return max(settingsCeiling, peakFloor). This never lets the peak drag a
 * genuine 1M session down to 200K (the old bug), and never lets a stale/missing
 * settings.json drag a demonstrably-huge session down either.
 */
function detectCeiling(peak, settingsWindow) {
  const peakFloor = peak > CEILING_DISCRIMINATOR ? WINDOW_1M : WINDOW_200K;
  return Math.max(settingsWindow, peakFloor);
}

/**
 * Returns true if the queue already has a pending context-pressure walkie for
 * the target — so we don't re-fire every cycle while the target writes HANDOFF.
 */
function hasPendingContextPressureWalkie(sessionName) {
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
    if (item.target_session === sessionName && item.source === 'context-pressure') return true;
    return false;
  });
}

function buildContextPressureMessage(sessionName, peak, ceiling, pct) {
  const pctStr = (pct * 100).toFixed(1);
  const ceilStr = ceiling === WINDOW_1M ? '1M' : '200K';
  return [
    `Your live context has reached ${pctStr}% of your ${ceilStr} window (peak ~${peak.toLocaleString()} tokens). You're approaching the context wall — time to hand off and cycle BEFORE you run out of room mid-thought.`,
    ``,
    `Run your handoff skill (~/.claude/skills/handoff.md):`,
    `  1. Roger this walkie immediately (you can't roger after you kill yourself).`,
    `  2. Update HANDOFF.md in your steward dir thoroughly — be the bridge to your next self. A stranger reading ONLY that file should be able to pick up your story: what you're mid-way through, what's decided, what's still open, exact next action.`,
    `  3. Run \`tmux kill-session -t ${sessionName}\` to cycle yourself.`,
    ``,
    `This is a CONTEXT-PRESSURE handoff, not an idle-sleep — you're being cycled because you're nearly full, not because you've been quiet. When the next walkie targeting you arrives, the dispatcher fresh-spawns a new Claude in your dir (NO --continue) and its first action is reading your HANDOFF.md. The quality of that file IS the quality of your continuity.`,
    ``,
    `No need to walkie back to confirm. The kill is your signal.`,
  ].join('\n');
}

function postContextPressureWalkie(sessionName, peak, ceiling, pct) {
  const body = JSON.stringify({
    target_session: sessionName,
    message: buildContextPressureMessage(sessionName, peak, ceiling, pct),
    type: 'action',
    source: 'context-pressure',
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
              log(`OK: enqueued context-pressure walkie id=${id} for ${sessionName} (peak=${peak} ceil=${ceiling} pct=${(pct * 100).toFixed(1)}%)`);
            } catch {
              log(`OK: enqueued context-pressure walkie for ${sessionName} (peak=${peak} pct=${(pct * 100).toFixed(1)}%) (response unparsable: ${data})`);
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
  const settingsWindow = readSettingsWindow();
  const now = Date.now();
  log(`scanning ${sessions.length} holler-* sessions; pressure_pct=${CONTEXT_PRESSURE_PCT}; idle_gate_sec=${CONTEXT_PRESSURE_IDLE_SEC}; settings_window=${settingsWindow === WINDOW_1M ? '1M' : '200K'}`);

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
    if (!activity || !activity.session_id) {
      // No activity file / no session_id — can't locate the transcript. Skip.
      skipped++;
      continue;
    }

    const transcript = findTranscript(activity.session_id);
    if (!transcript) {
      log(`skip ${sessionName}: no transcript found for session_id=${activity.session_id}`);
      skipped++;
      continue;
    }

    const peak = computePeakContext(transcript);
    if (peak <= 0) {
      // No usage data yet (brand-new session). Nothing to gate on.
      skipped++;
      continue;
    }

    const ceiling = detectCeiling(peak, settingsWindow);
    const pct = peak / ceiling;

    if (pct < CONTEXT_PRESSURE_PCT) {
      // Under the context gate — plenty of room. (Condition (b) fails.)
      continue;
    }

    // AND-GATE condition (a): the session must ALSO be idle 4+ hours. A session
    // that's near-full but actively working must NOT be handed off mid-stream —
    // that's the bug that killed Crowne Vault. Two idle signals, both required:
    //   1. activity.is_working === true means it's mid-turn RIGHT NOW → never fire.
    //   2. idleSec (now - updated_at) must be >= CONTEXT_PRESSURE_IDLE_SEC.
    if (activity.is_working === true) {
      log(`skip ${sessionName}: at ${(pct * 100).toFixed(1)}% but is_working=true (actively working — no mid-stream handoff)`);
      skipped++;
      continue;
    }
    const updatedMs = parseActivityTimestamp(activity.updated_at);
    if (updatedMs == null) {
      // Can't prove it's idle — do NOT fire without evidence (fail safe: a
      // handoff kills the session; better to miss than to sever an active one).
      log(`skip ${sessionName}: at ${(pct * 100).toFixed(1)}% but updated_at unparsable (${activity.updated_at}) — can't confirm 4h-idle`);
      skipped++;
      continue;
    }
    const idleSec = Math.floor((now - updatedMs) / 1000);
    if (idleSec < CONTEXT_PRESSURE_IDLE_SEC) {
      // Near-full but NOT idle long enough — leave it working. (Condition (a) fails.)
      log(`skip ${sessionName}: at ${(pct * 100).toFixed(1)}% but idle only ${idleSec}s (< ${CONTEXT_PRESSURE_IDLE_SEC}s gate) — still active, no handoff`);
      skipped++;
      continue;
    }

    if (hasPendingContextPressureWalkie(sessionName)) {
      log(`skip ${sessionName}: already has a pending context-pressure walkie`);
      skipped++;
      continue;
    }

    log(`FIRING: ${sessionName} peak=${peak} ceiling=${ceiling} pct=${(pct * 100).toFixed(1)}% (gate=${(CONTEXT_PRESSURE_PCT * 100).toFixed(0)}%) idle=${idleSec}s (>= ${CONTEXT_PRESSURE_IDLE_SEC}s) — BOTH gates passed`);
    await postContextPressureWalkie(sessionName, peak, ceiling, pct);
    fired++;
  }

  log(`done: fired=${fired} skipped=${skipped} total=${sessions.length}`);
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
