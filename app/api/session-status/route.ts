import { NextResponse } from 'next/server';
import { exec, execFileSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Session status via hook-maintained activity files.
 *
 * Each session has an activity file at /tmp/claude-session-{name}-activity.json
 * with an `is_working` boolean:
 * - Set to true by user_prompt_submit.py (when user sends a message)
 * - Set to false by stop.py (when assistant finishes responding)
 *
 * On working→waiting transitions (per-session opt-in):
 * - Session scribe is alerted if enabled for that session
 * - Build manager is alerted if enabled for that session
 */

const QUEUE_FILE = join(homedir(), '.homestead', 'queue.json');
const WATCHER_FILE = join(process.cwd(), 'data', 'watcher-enabled-sessions.json');
const SCRIBE_FILE = join(process.cwd(), 'data', 'scribe-enabled-sessions.json');

// Track previous status to detect transitions
const previousStatuses = new Map<string, 'working' | 'waiting' | 'idle'>();

const CACHE_TTL_MS = 1000;
let cache: { data: { statuses: Record<string, { status: 'working' | 'waiting' | 'idle'; updatedAt: string | null; activityAt: string | null }> }; expiresAt: number } | null = null;

async function getActiveHollerSessions(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      timeout: 3000,
    });
    return stdout.trim().split('\n').filter((s: string) => s.startsWith('holler-'));
  } catch {
    return [];
  }
}

// The status-transition tracker (lib/status-transition-tracker.js, started from
// server.js) persists { [tmuxSession]: { status, changedAt } } here — the time
// each session's STATUS last CHANGED (working↔waiting↔idle), NOT its last
// tool-use event. We read `changedAt` for the `updatedAt` we surface, so the
// presenter's worker rows show real status-change age. This deliberately
// REPLACES the old activity-file `updated_at`/mtime read, which tracked
// tool-lifecycle events and went stale-but-working when a completion hook was
// dropped.
const TRANSITIONS_FILE = '/tmp/claude-status-transitions.json';

function loadTransitions(): Record<string, { status?: string; changedAt?: string }> {
  try {
    if (!existsSync(TRANSITIONS_FILE)) return {};
    const parsed = JSON.parse(readFileSync(TRANSITIONS_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parse an activity-file timestamp to epoch ms, or null.
 *
 * THE ACTIVITY WRITERS DISAGREE ABOUT TIMEZONES, AND A BARE DATETIME IS THE
 * DANGEROUS CASE (found 2026-09-19 by Josh, on the worker time badge). Most
 * writers emit `updated_at` with an explicit offset
 * (`2026-09-19T11:55:46.042821+00:00`), but at least one emits it BARE
 * (`2026-09-19T12:04:00.201`) while still meaning UTC. `new Date(bare)` parses
 * it as LOCAL time, so on this machine (UTC-4/-5) a UTC instant becomes one
 * FOUR HOURS IN THE FUTURE.
 *
 * That is worse than it sounds: a future timestamp makes "time since" NEGATIVE,
 * which the badge clamps to "0s" — so a worker that last ran hours ago reported
 * itself as active this second. Exactly what Josh saw on the Rooster's story
 * interviewer. The bug predates the badge work; surfacing the time in both
 * states is simply what made it visible.
 *
 * Appending `Z` when no offset is present matches what the writers assume and
 * what five other callers in lib/ already do (check-idle-stewards.js,
 * check-stalled-workers.js, potato-tracker.js, and two more) — this route was
 * the one reader that skipped the step.
 */
function parseActivityTimestamp(s: string): number | null {
  if (!s || typeof s !== 'string') return null;
  // Look for a zone marker AFTER the date part, so the `-` in `2026-09-19`
  // is never mistaken for a negative UTC offset.
  const withZ = /[Z+-]/.test(s.slice(10)) ? s : `${s}Z`;
  const ms = Date.parse(withZ);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When tmux created this session, as an ISO string — or null if tmux cannot
 * tell us. Used as the LAST fallback for a session that has no transition
 * record and no activity file, so the presenter's badge always has a real,
 * per-session number instead of a dash.
 *
 * `#{session_created}` is epoch SECONDS.
 *
 * Built on `list-sessions`, NOT `display-message -t =<name>`: the latter
 * returns an EMPTY string with EXIT CODE 0 here, which is indistinguishable
 * from "this session has no creation time" — a silent false negative that
 * would have quietly reinstated the dash. Verified 2026-09-19: list-sessions
 * yields a real epoch for every live session, display-message yields nothing.
 */
function tmuxSessionCreatedAt(sessionName: string): string | null {
  try {
    const out = execFileSync(
      'tmux',
      ['list-sessions', '-F', '#{session_name} #{session_created}'],
      { encoding: 'utf-8', timeout: 3000 }
    );
    for (const line of out.split('\n')) {
      const idx = line.lastIndexOf(' ');
      if (idx <= 0) continue;
      if (line.slice(0, idx) !== sessionName) continue;
      const secs = Number(line.slice(idx + 1).trim());
      if (!Number.isFinite(secs) || secs <= 0) return null;
      return new Date(secs * 1000).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

function getSessionStatus(
  sessionName: string,
  transitions: Record<string, { status?: string; changedAt?: string }>
): {
  status: 'working' | 'waiting' | 'idle';
  updatedAt: string | null;
  activityAt: string | null;
} {
  // The status-change time PREFERS the transition tracker's `changedAt` (the
  // real working↔waiting↔idle flip time — see status-transition-tracker.js).
  // But the tracker only stamps a session AFTER it first observes it (12s poll,
  // 4s startup delay) and skips a whole cycle on any transient fetch blip. That
  // left `updatedAt` intermittently null for a live worker → the presenter's
  // time badge blanked to "—" mid-session (Josh: "the value totally disappears
  // when it should obviously be on"). Fix: FALL BACK to the worker's own
  // activity file so a session that clearly has activity ALWAYS has an honest
  // "time since". Order: tracker changedAt → activity `updated_at` → activity
  // file mtime. Never surface null for a session whose activity file exists.
  const trackerChangedAt: string | null =
    transitions[sessionName] && typeof transitions[sessionName].changedAt === 'string'
      ? transitions[sessionName].changedAt
      : null;

  const filePath = `/tmp/claude-session-${sessionName}-activity.json`;

  function activityFallbackTime(): string | null {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      // The activity file's own timestamp is a real event time (not fabricated).
      // MUST go through parseActivityTimestamp: some writers emit `updated_at`
      // WITHOUT a timezone suffix, and a bare datetime is parsed as LOCAL —
      // which turns a UTC instant into one 4-5h in the FUTURE here. See that
      // helper for the full account.
      if (data && typeof data.updated_at === 'string' && data.updated_at) {
        const ms = parseActivityTimestamp(data.updated_at);
        if (ms !== null) return new Date(ms).toISOString();
      }
    } catch {
      // fall through to mtime
    }
    try {
      // Last resort: the file's own modification time — still a real, monotone
      // signal of when this session last did anything.
      return statSync(filePath).mtime.toISOString();
    } catch {
      return null;
    }
  }

  // FINAL REAL FALLBACK (Josh 2026-09-19: "it should just tell us like when it
  // was put to sleep... whenever the status changed last is what I'm looking
  // for"). A session with no tracker entry AND no activity file previously
  // surfaced null, which the badge rendered as a dash. tmux itself knows when
  // the session was created — a real, per-session, monotone instant, and a
  // sound floor for "nothing has happened since at least then". This is a
  // measured fact from tmux, not a fabricated stamp, and it differs per row.
  const updatedAt: string | null =
    trackerChangedAt ?? activityFallbackTime() ?? tmuxSessionCreatedAt(sessionName);

  // ADDITIVE (Josh 2026-08-07 badge redesign): `activityAt` = the worker's FRESH
  // last-activity time (activity-file updated_at / mtime), independent of the
  // status-transition `changedAt`. The presenter's combined status+time badge
  // shows this when a worker is NOT working, so a long-'working' worker no longer
  // reads a stale "2d" — it reads real last-activity age. `updatedAt` is kept
  // untouched for back-compat (any other consumer of status-change age).
  const activityAt: string | null = activityFallbackTime();

  // Compute-suspend: if the session was kill-9'd but its tmux is kept alive,
  // the detector writes this marker (and the dispatcher clears it on resume).
  // While present, the session is asleep/resumable — report 'idle' so the UI
  // dot renders dark-gray (#666666) instead of a lit working/waiting color.
  const suspendMarker = `/tmp/claude-session-${sessionName}-compute-suspend.json`;
  if (existsSync(suspendMarker)) {
    // STALE-MARKER SELF-HEAL (2026-09-07). A marker is only the truth while the
    // session is ACTUALLY suspended. The dispatcher clears it on its own resume
    // path — but a HAND recovery (tmux send-keys into a wedged picker, which is
    // how two sessions were rescued on 09-06) bypasses that code entirely, so a
    // live session keeps wearing the asleep tag. This check runs BEFORE
    // is_working is ever read, so a stale marker short-circuits the truth and the
    // UI dot contradicts the pane. Josh saw exactly that and was right.
    //
    // REPORTING AND DELETING ARE DELIBERATELY SEPARATE, because the two errors
    // are not symmetric:
    //   reporting wrongly  -> a wrong dot for one poll cycle. Cheap, self-correcting.
    //   deleting wrongly   -> a genuinely-suspended session loses the record of
    //                         its own session_id, cannot --resume, and degrades to
    //                         fresh-spawn. That is CONTEXT LOSS, and irreversible.
    // So: report the truth on liveness alone; delete only on the STRONGER signal
    // of a session_id mismatch, which is positive evidence the marker belongs to a
    // session that is gone rather than merely evidence something is running now.
    if (claudeIsLiveInPane(sessionName)) {
      // Positive proof of a running claude => NOT suspended, whatever the marker says.
      if (markerNamesADifferentSession(suspendMarker, sessionName)) {
        // The marker names a session that is not the one running. Stale by
        // definition — safe to remove, and removing it stops the lie recurring.
        try { unlinkSync(suspendMarker); } catch { /* non-fatal: reporting is what matters */ }
      }
      // Fall through and report the REAL status from the activity file.
    } else {
      // No positive liveness proof. The session may genuinely be suspended, so
      // change NOTHING and keep the existing behaviour.
      return { status: 'idle', updatedAt, activityAt };
    }
  }
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    return { status: data.is_working ? 'working' : 'waiting', updatedAt, activityAt };
  } catch {
    return { status: 'waiting', updatedAt, activityAt };
  }
}

/**
 * POSITIVE PROOF that a claude process is running in this session's pane.
 *
 * Mirrors needsClaudeRestart()'s two-stage walk in queue-dispatcher.js, which is
 * the shape proven against the real fleet:
 *   (a) the pane_pid IS claude (post-v2 shape) — `comm=` (basename only), never
 *       `command=`, which would false-match `zsh -c '...claude...'`
 *   (b) a DIRECT CHILD of pane_pid is claude (legacy shell+claude shape)
 *
 * NOT pgrep by session name: a tmux session name is not in the process argv, so
 * such a query is structurally incapable of returning a positive and its negative
 * carries no information. (That mistake is in the Library.)
 *
 * Returns TRUE only on positive evidence. Any error, any ambiguity, any missing
 * pane => FALSE, because the caller treats false as "change nothing".
 */
function claudeIsLiveInPane(sessionName: string): boolean {
  try {
    const panePid = execFileSync('tmux',
      ['list-panes', '-t', `=${sessionName}`, '-F', '#{pane_pid}'],
      { encoding: 'utf-8', timeout: 3000 }).split('\n')[0]?.trim();
    if (!panePid) return false;

    // (a) pane_pid itself
    try {
      const comm = execFileSync('ps', ['-p', panePid, '-o', 'comm='],
        { encoding: 'utf-8', timeout: 3000 }).trim();
      if (comm.split('/').pop() === 'claude') return true;
    } catch { /* fall through to (b) */ }

    // (b) direct child of pane_pid
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,command='],
      { encoding: 'utf-8', timeout: 3000 }).split('\n');
    for (const row of rows) {
      const m = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m || m[2] !== panePid) continue;
      // Anchor on the binary, not a substring: `--add-dir .../claude-x` must not match.
      if (/\/claude(\s|$)/.test(m[3]) || /^claude(\s|$)/.test(m[3])) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * TRUE only when the marker names a DIFFERENT session than the one currently
 * running — positive evidence the marker is stale, not merely evidence that
 * something is alive. This is the ONLY signal we allow to trigger a delete,
 * because a wrongly-deleted marker costs a session its context on next wake.
 *
 * Unreadable marker, missing session_id, or an unknown running id => FALSE
 * (do not delete). Absence of proof is never treated as proof.
 */
function markerNamesADifferentSession(markerPath: string, sessionName: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    const markerSid = marker?.session_id;
    if (!markerSid) return false;
    const activityFile = `/tmp/claude-session-${sessionName}-activity.json`;
    if (!existsSync(activityFile)) return false;
    const runningSid = JSON.parse(readFileSync(activityFile, 'utf-8'))?.session_id;
    if (!runningSid) return false;
    return markerSid !== runningSid;
  } catch {
    return false;
  }
}

function isBuildManagerEnabled(sessionName: string): boolean {
  try {
    if (!existsSync(WATCHER_FILE)) return false;
    const enabled: string[] = JSON.parse(readFileSync(WATCHER_FILE, 'utf-8'));
    return enabled.includes(sessionName);
  } catch {
    return false;
  }
}

function isScribeEnabled(sessionName: string): boolean {
  try {
    if (!existsSync(SCRIBE_FILE)) return false;
    const enabled: string[] = JSON.parse(readFileSync(SCRIBE_FILE, 'utf-8'));
    return enabled.includes(sessionName);
  } catch {
    return false;
  }
}

function enqueueAlert(targetSession: string, sessionName: string) {
  try {
    const queue = existsSync(QUEUE_FILE)
      ? JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'))
      : [];

    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      target_session: targetSession,
      type: 'action',
      message: JSON.stringify({
        type: 'action',
        session: sessionName,
        trigger: 'turn_complete',
      }),
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    queue.push(item);
    // ATOMIC (torn-read fix 2026-08-25): temp+rename so a concurrent dispatcher
    // read never sees a half-written queue.json.
    const tmp = `${QUEUE_FILE}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(queue, null, 2));
    renameSync(tmp, QUEUE_FILE);
    console.log(`[SessionStatus] Queued ${targetSession} alert for ${sessionName}`);
  } catch (e) {
    console.error(`[SessionStatus] Failed to enqueue alert:`, e);
  }
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.data);
  }

  const sessions = await getActiveHollerSessions();
  const statuses: Record<string, { status: 'working' | 'waiting' | 'idle'; updatedAt: string | null; activityAt: string | null }> = {};

  // Load the transition store once for the whole batch (not per-session).
  const transitions = loadTransitions();

  for (const name of sessions) {
    const { status, updatedAt, activityAt } = getSessionStatus(name, transitions);
    const prev = previousStatuses.get(name);

    // Detect working → waiting transition
    // Skip steward sessions — they're infrastructure, not user work
    const isSteward = name === 'holler-build-manager' || name === 'holler-session-scribe' || name === 'holler-alert-triage' || name === 'holler-repairman' || name.startsWith('holler-guest-');
    if (prev === 'working' && status === 'waiting' && !isSteward) {
      // Session scribe fires if enabled for this session
      if (isScribeEnabled(name)) {
        enqueueAlert('holler-session-scribe', name);
      }

      // Build manager fires if enabled for this session
      if (isBuildManagerEnabled(name)) {
        enqueueAlert('holler-build-manager', name);
      }
    }

    previousStatuses.set(name, status);
    statuses[name] = { status, updatedAt, activityAt };
  }

  // Clean up sessions that no longer exist
  for (const name of previousStatuses.keys()) {
    if (!sessions.includes(name)) {
      previousStatuses.delete(name);
    }
  }

  const payload = { statuses };
  cache = { data: payload, expiresAt: Date.now() + CACHE_TTL_MS };
  return NextResponse.json(payload);
}

