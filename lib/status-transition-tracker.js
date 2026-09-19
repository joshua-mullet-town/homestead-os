/**
 * Status-transition tracker.
 *
 * Persists, per tmux session, the wall-clock time the session's STATUS last
 * CHANGED (working ↔ waiting ↔ idle ↔ terminated) — not the last tool-use
 * event. The presenter's worker rows show "how long since this worker last
 * changed status", and the naive source (the activity file's `updated_at`,
 * stamped by the tool hooks on every tool event) drifts stale-but-working when
 * a tool-completion hook is dropped. Reading a real transition timestamp fixes
 * that: it only advances when the authoritative status actually flips.
 *
 * Authoritative status comes from /api/claude-sessions (its route comments
 * "Hooks are the source of truth for status"). We poll it, compare each
 * session's status to the last-seen value, and stamp `changedAt = now` on any
 * difference (or on first sight). The map is persisted to a JSON file that is
 * LOADED ON START so transitions survive a server restart — a restart must not
 * reset every worker's clock to "now".
 *
 * route.ts reads `changedAt` from this file for the `updatedAt` field it
 * surfaces to the presenter.
 */

const { readFileSync, writeFileSync, existsSync, renameSync } = require('fs');

const POLL_INTERVAL = 12_000; // 12s — between the fcm-watcher's 15s and the UI's 10s poll
const STATUS_URL = 'http://localhost:3005/api/claude-sessions?raw=true';
const STORE_FILE = '/tmp/claude-status-transitions.json';

// In-memory store: { [tmuxSession]: { status, changedAt } }.
// Seeded from disk on start() so transitions survive restart.
let store = {};
let intervalId = null;

function loadStore() {
  if (!existsSync(STORE_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Corrupt file — start clean rather than crash the poller.
  }
  return {};
}

function saveStore() {
  // Atomic write (temp + rename) so a mid-write read never sees a truncated
  // file — route.ts reads this on every /api/session-status request.
  try {
    const tmp = STORE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(store), 'utf-8');
    renameSync(tmp, STORE_FILE);
  } catch (e) {
    console.error('[StatusTracker] Failed to persist store:', e.message || e);
  }
}

async function fetchSessionStatuses() {
  try {
    const res = await fetch(STATUS_URL);
    if (!res.ok) return new Map();
    const data = await res.json();
    const sessions = data.sessions || [];
    // MANY RECORDS SHARE ONE TMUX NAME (2026-09-19). A long-lived session like
    // `holler-rooster` has ~27 records in ~/.claude/sessions — one per claude
    // process that ever ran in that pane. The old code did a bare `set()` per
    // record, so whichever record the directory read happened to yield LAST
    // won. That is file order, not recency: `holler-rooster` was live and
    // WORKING while a terminated record from May won the slot, and the tracker
    // recorded it as `terminated`. Four of 27 live sessions were misread this
    // way, and each wrong status also corrupts the transition time — a bogus
    // flip stamps `changedAt`, and a missed real flip fails to.
    //
    // Keep the record with the NEWEST `updatedAt` instead. Ties and missing
    // timestamps fall back to first-seen so the choice stays deterministic.
    const best = new Map(); // tmuxSession -> { status, updatedAt }
    for (const session of sessions) {
      const tmuxSession = session.tmuxSession || session.tmux_session || '';
      if (!tmuxSession) continue;
      const status = session.status || 'idle';
      const ts = Date.parse(session.updatedAt || '');
      const updatedAt = isNaN(ts) ? -Infinity : ts;
      const prev = best.get(tmuxSession);
      if (!prev || updatedAt > prev.updatedAt) {
        best.set(tmuxSession, { status, updatedAt });
      }
    }
    return best;
  } catch {
    return new Map();
  }
}

async function poll() {
  const statuses = await fetchSessionStatuses();
  if (statuses.size === 0) return;

  const now = new Date().toISOString();
  let changed = false;

  for (const [sessionName, rec] of statuses) {
    const newStatus = rec.status;
    const prev = store[sessionName];
    if (!prev) {
      // FIRST SIGHT IS NOT A TRANSITION (2026-09-19). The old code stamped
      // `changedAt = now` here, which meant one restart wrote the SAME instant
      // onto every session it had never seen. Measured on the live fleet: 424
      // of 426 entries carried one identical `changedAt`, and 25 of the 27
      // sessions actually running all displayed that one moment as if it were
      // their own. The badge was showing the age of a restart, fleet-wide.
      //
      // We do not know when an unseen session last flipped, so we do not
      // invent it. We seed from the newest REAL timestamp that session's own
      // records carry (`updatedAt` — when it last did something), and mark the
      // entry `seeded` so nothing downstream mistakes it for an observed flip.
      // A seeded time is a genuine upper bound: the session cannot have
      // changed status later than the last moment it was seen doing anything.
      // The first real flip we observe replaces it with an exact time.
      const seededAt =
        rec.updatedAt > 0 && isFinite(rec.updatedAt)
          ? new Date(rec.updatedAt).toISOString()
          : now;
      store[sessionName] = { status: newStatus, changedAt: seededAt, seeded: true };
      changed = true;
    } else if (prev.status !== newStatus) {
      // Real status transition — this is the timestamp Josh wants. Observed
      // first-hand, so it is exact and no longer `seeded`.
      store[sessionName] = { status: newStatus, changedAt: now };
      changed = true;
    }
    // else: status unchanged — keep the existing changedAt (do NOT bump it;
    // that would recreate the last-activity-time bug).
  }

  if (changed) saveStore();
}

function start() {
  // Load persisted transitions FIRST so a restart doesn't reset every clock.
  store = loadStore();
  console.log(
    `[StatusTracker] Starting (poll ${POLL_INTERVAL / 1000}s) — loaded ` +
    `${Object.keys(store).length} prior transitions from ${STORE_FILE}`
  );
  // Small delay so the server's own API is up before the first poll.
  setTimeout(() => poll().catch(() => {}), 4000);
  intervalId = setInterval(() => poll().catch(() => {}), POLL_INTERVAL);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[StatusTracker] Stopped');
  }
}

module.exports = { start, stop, STORE_FILE };
