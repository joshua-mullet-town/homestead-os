/**
 * steward-level.js — DUAL-READ session classifier for the worker re-home + rename.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM this solves: post-rename a Worker's session is
 * `holler-{steading}--{worker}` — the `--foreman--` structural tell is GONE, so
 * the same `holler-{steading}--{name}` shape now covers BOTH a Worker and crew
 * (the Auditor / Librarian). We can no longer key worker-detection off the
 * session name. The distinguisher is `level` in the steward's steward.json,
 * which is already the mandated source of truth for revivability.
 *
 * DUAL-READ CONTRACT (SM-finalized, canonical 2026-07-28):
 *   - WORKER  iff steward.json level ∈ {"worker", "sub-substeward"}
 *       (new re-homed workers write "worker"; legacy on-disk workers still read
 *        "sub-substeward" until each is re-homed — accept BOTH this pass).
 *   - CREW    iff level === "substeward"  (Auditor; Venture Librarian). Crew are
 *       skipped by the stall→Foreman escalation path.
 *   - Anything else (a top-level Steading, an unknown/deeper node) → "other".
 *
 * ⚠️ GOTCHA 1 — DEFENSIVE MISSING-FILE DEFAULT (baked-in, smoke-tested):
 *   A dir sitting DIRECTLY under a Steading's substewards/ (session shape
 *   `holler-{steading}--{name}`, exactly one `--` segment after the steading)
 *   whose steward.json is MISSING or UNREADABLE defaults to WORKER — NOT skipped,
 *   NOT crashed. This is the new-file-in-absent-dir / set-u bug class: a freshly
 *   re-homed worker whose steward.json hasn't landed yet must still be watched,
 *   never silently dropped from the scanners. (Ref: rooster watchdog, which
 *   lived with no steward.json for a period.) A missing file DEEPER than one
 *   level (legacy `holler-{steading}--foreman--{name}`) also defaults to worker,
 *   since that is the legacy worker shape.
 *
 * This module is the SINGLE place session→level classification lives, so the
 * DUAL-READ rules — and the eventual cleanup that drops "sub-substeward"
 * acceptance — change in exactly one file. Reuses lib/steward-path.js as the
 * shared session-id → on-disk-dir resolver.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { stewardIdToPath } = require('./steward-path');

// Levels that identify a WORKER under the dual-read contract. Legacy on-disk
// workers read "sub-substeward"; new re-homed workers read "worker". Accept BOTH
// until the fleet is fully re-homed — dropping "sub-substeward" is a LATER
// cleanup, not this pass.
const WORKER_LEVELS = new Set(['worker', 'sub-substeward']);
// The single level that identifies CREW (Auditor / Librarian) — skipped by
// worker-only escalation paths.
const CREW_LEVEL = 'substeward';

/**
 * Session name (`holler-...`) → steward id (drop the `holler-` prefix). The id is
 * the `--`-joined chain steward-path.js already understands.
 */
function sessionToStewardId(sessionName) {
  if (typeof sessionName !== 'string') return null;
  return sessionName.replace(/^holler-/, '');
}

/**
 * Read a steward dir's steward.json → { level, type }, each a string or null.
 * `exists` is false only when the file is missing/unreadable/corrupt (the
 * defensive-default path). NEVER throws.
 *
 * WHY we also read `type`: real fleet data (venture's auditor/foreman/librarian,
 * 2026-07-28) has crew with `type:"substeward"` but NO `level` field. `level` is
 * the canonical dual-read distinguisher, but it is NOT universally populated on
 * crew yet — so a missing `level` must fall back to `type` before it falls
 * through to the GOTCHA-1 worker default, or those 3 crew get misclassified as
 * workers and falsely stall-escalated.
 */
function readStewardMeta(stewardDir) {
  if (!stewardDir) return { level: null, type: null, exists: false };
  const jsonPath = path.join(stewardDir, 'steward.json');
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf-8');
  } catch {
    return { level: null, type: null, exists: false }; // missing or unreadable
  }
  try {
    const data = JSON.parse(raw);
    return {
      level: typeof data.level === 'string' ? data.level : null,
      type: typeof data.type === 'string' ? data.type : null,
      exists: true,
    };
  } catch {
    return { level: null, type: null, exists: false }; // corrupt — defensive default applies
  }
}

/** Back-compat thin wrapper — returns just the level string or null. */
function readLevel(stewardDir) {
  return readStewardMeta(stewardDir).level;
}

/**
 * True if the session sits DIRECTLY under a Steading's substewards/ — i.e. the
 * re-homed-worker shape `holler-{steading}--{name}` with exactly ONE `--`
 * segment after the steading. This is the set that gets the defensive
 * default-WORKER when steward.json is missing.
 */
function isDirectSteadingChild(sessionName) {
  const id = sessionToStewardId(sessionName);
  if (!id) return false;
  const parts = id.split('--').filter(Boolean);
  return parts.length === 2; // {steading}--{name}
}

/**
 * True if the session is the LEGACY worker shape
 * `holler-{steading}--foreman--{name}` (three `--` segments, middle == foreman).
 */
function isLegacyForemanChild(sessionName) {
  const id = sessionToStewardId(sessionName);
  if (!id) return false;
  const parts = id.split('--').filter(Boolean);
  return parts.length >= 3 && parts[1] === 'foreman';
}

/**
 * Classify a session as 'worker' | 'crew' | 'other' under the DUAL-READ
 * contract. Pure-ish: reads the on-disk steward.json for the session's dir.
 *
 * Precedence:
 *   1. If steward.json has a `level`:
 *        level ∈ {worker, sub-substeward} → 'worker'
 *        level === substeward             → 'crew'
 *        (any other explicit level)       → 'other'
 *   2. If steward.json exists but has NO `level`, fall back to `type`:
 *        type === substeward              → 'crew'
 *        (real fleet data: venture crew have type but no level)
 *   3. If steward.json is missing/unreadable/corrupt (DEFENSIVE, GOTCHA 1):
 *        direct Steading child ({steading}--{name})     → 'worker'
 *        legacy foreman child ({steading}--foreman--..) → 'worker'
 *        otherwise                                      → 'other'
 *
 * Never throws.
 */
function classifySession(sessionName) {
  const id = sessionToStewardId(sessionName);
  if (!id) return 'other';
  const dir = stewardIdToPath(id);
  const { level, type, exists } = readStewardMeta(dir);

  // (1) Explicit level is canonical.
  if (level !== null) {
    if (WORKER_LEVELS.has(level)) return 'worker';
    if (level === CREW_LEVEL) return 'crew';
    return 'other';
  }

  // (2) steward.json exists but is level-less. Real crew (venture
  // auditor/foreman/librarian) sit here — key off `type` so they are NOT swept
  // into the GOTCHA-1 worker default below and falsely stall-escalated.
  if (exists) {
    if (type === CREW_LEVEL) return 'crew'; // type "substeward" == crew
    // A level-less, non-substeward-type file is ambiguous. Only default to
    // worker if it's positioned like a worker; otherwise 'other'.
  }

  // (3) Defensive missing/corrupt-file path (GOTCHA 1): a dir sitting under a
  // Steading's substewards/ (direct re-homed shape, or legacy foreman-nested)
  // with no readable level is a WORKER — watch it, don't drop it.
  if (isDirectSteadingChild(sessionName) || isLegacyForemanChild(sessionName)) {
    return 'worker';
  }
  return 'other';
}

/** Convenience predicate: is this session a WORKER under dual-read? */
function isWorkerSession(sessionName) {
  return classifySession(sessionName) === 'worker';
}

module.exports = {
  WORKER_LEVELS,
  CREW_LEVEL,
  sessionToStewardId,
  readLevel,
  readStewardMeta,
  isDirectSteadingChild,
  isLegacyForemanChild,
  classifySession,
  isWorkerSession,
};
