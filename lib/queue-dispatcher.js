/**
 * Steward Queue Dispatcher
 *
 * Centralized queue that dispatches messages to steward sessions.
 * - Reads ~/.homestead/queue.json every 10s
 * - For each pending item, checks if the target session is ALIVE
 * - If session doesn't exist (or claude is dead), fresh-spawn-wakes it — but ONLY
 *   for a steward whose session dir still exists. A TORN-DOWN worker is NOT
 *   resurrected: wakeFreshSpawn hard-returns false at the `!existsSync(sessionDir)`
 *   guard (~:887), so a late reply to a dead worker fails cleanly instead of
 *   respawning it into a deleted cwd. Stated explicitly because this line described
 *   the INTENT and omitted the CONSTRAINT, and read on its own it looks exactly like
 *   the resurrect-into-deleted-directory bug — Steward Manager 2026-09-12 nearly
 *   reported it as one before testing and finding three guards already in the way.
 * - If session is alive, MID-STREAM INJECTS the message immediately via tmux
 *   load-buffer + paste-buffer + Enter — no idle wait (modern Claude Code queues
 *   mid-turn input). "Alive" is the only gate (2026-08-01, Josh directive).
 * - Marks items as dispatched, then waits for confirmation
 *
 * Lifecycle: pending → dispatched → confirmed (or failed after max retries)
 *
 * The receiving agent must confirm receipt by calling POST /api/queue/confirm
 * with the queue item id. The confirm command is included in the message itself.
 * If unconfirmed after 30s, the dispatcher retries — but only counts attempts
 * when the session was confirmed ready at dispatch time. If the session was busy,
 * re-queues without penalty (up to MAX_RETRIES ready-state attempts).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } = fs;
const { writeJsonAtomicSync } = require('./atomic-write');
const { join } = require('path');
const os = require('os');
const { resolveClaudePath } = require('./claude-resolver');

// Defaults to the real ~/.homestead. Env-overridable so an isolated proof
// instance gets its OWN queue.json/stewards/timers and never touches the live
// fleet's shared queue. Production leaves HOMESTEAD_DIR unset → real path.
const HOMESTEAD_DIR = process.env.HOMESTEAD_DIR || join(os.homedir(), '.homestead');
const STEWARDS_DIR = join(HOMESTEAD_DIR, 'stewards');
const QUEUE_FILE = join(HOMESTEAD_DIR, 'queue.json');
const TIMERS_FILE = join(STEWARDS_DIR, 'timers.json'); // stewards/timers.json — the file set-timer.js + checkin-timer.sh write (was join(HOMESTEAD_DIR,'timers.json'), a non-existent path → event timers silently never fired; fixed 2026-08-21)

// Potato tracker — Josh-message drop-detection accountability ledger. Loaded
// defensively so a tracker fault can NEVER break message dispatch: the tracker
// only OBSERVES enqueues (births Josh-originated potatoes, moves the holder
// pointer on steward→steward passes). It does not gate, slow, or alter any
// message. All calls into it are wrapped in try/catch at the call site.
let potatoTracker = null;
try {
  potatoTracker = require('./potato-tracker.js');
} catch (e) {
  console.error('[QueueDispatcher] potato-tracker unavailable (non-fatal):', e.message);
  potatoTracker = null;
}

const MAX_RETRIES = 3;
const CONFIRM_TIMEOUT_MS = 30000; // 30 seconds to confirm before retry

// How long an item stays CONFIRMABLE after its redelivery attempts are spent.
//
// WHY (2026-09-02). MAX_RETRIES(3) x CONFIRM_TIMEOUT_MS(30s) is about a
// 90-SECOND window, and the old code terminalized the item to 'failed' the
// instant it closed. But a busy steward routinely rogers MINUTES later — the
// notification-triage pattern is exactly a steward that is IDLE when work
// arrives (so the item dispatches dispatched_ready=true and its attempts DO
// count toward the cap — see L2229) and then goes BUSY working the very thing
// it was handed. Observed: a roger 191s after creation on routine CI triage,
// 2x+ over the old window. Terminalizing at 90s made a perfectly good late
// roger land on a 'failed' record.
//
// The fix DECOUPLES the two things that were conflated:
//   "stop pasting it again"  — still bounded by MAX_RETRIES (unchanged)
//   "declare it failed"      — now waits out CONFIRM_WINDOW_MS
// Retries are deliberately NOT increased: more retries means more pastes, and
// a redelivery loop is what previously wedged :3005 (see the CONFIRM-WINS
// guard notes below). This adds ZERO extra deliveries — the item simply sits
// quietly in 'dispatched' with redeliver_exhausted set, still confirmable,
// until the window expires.
const CONFIRM_WINDOW_MS = 10 * 60 * 1000; // 10 minutes from dispatch
// Delivery stagger (2026-08-21, Josh directive). When several walkies queue at
// once, delivering them all in ONE tight tick fires every target's Claude turn
// simultaneously — a concurrent burst that trips the shared-account API rate
// limit ("Server is temporarily limiting requests") and cascades into
// stuck_frozen alerts. So we space CONSECUTIVE deliveries ~1s apart via a
// non-blocking `await sleep()` between them (see tick() Phase 2). The FIRST
// delivery in a burst fires immediately — a lone walkie is never penalized; the
// gap is only BETWEEN back-to-back deliveries. Tunable without a code change via
// env WALKIE_DELIVERY_STAGGER_MS (default 1000). Set to 0 to disable.
const WALKIE_DELIVERY_STAGGER_MS = parseInt(process.env.WALKIE_DELIVERY_STAGGER_MS, 10) >= 0
  ? parseInt(process.env.WALKIE_DELIVERY_STAGGER_MS, 10)
  : 1000;
// Max age of a session-stuck-state.json "idle" reading before it's rejected as
// proof-of-idle (paste-race hole #2 fix). The stuck checker refreshes ~60s, so a
// session working <60s reads stale-idle; anything older than this must be
// re-confirmed by a LIVE capture-pane probe. See isSessionReady().
const STUCK_STATE_MAX_AGE_MS = 15000; // 15s

// --- Dark-circle UI status (Josh additive req 2026-07-18) ---
// The compute-suspend detector sets a session's UI status to the dark/asleep
// value when it kill-9's the process. resumeComputeSuspend() must CLEAR it back
// to an active/lit value once the session is live again. Single constant so the
// value is one string. Setter shares the same module the detector uses
// (lib/update-session-status.js).
//
// Suspend sets status='idle' (#666666 dark gray = asleep dot). Resume must move
// it OFF idle so the dot goes LIT — 'waiting' (#00FF66 green) is the honest
// value: the resumed session is alive and waiting for its (still-pending) walkie.
// Confirmed color map (app/components/right-gutter/utils.ts getStatusColor):
// working #FFCC00, waiting #00FF66, idle #666666 (dark), terminated #FF3333
// (red alarm), interrupted #FF6633.
const COMPUTE_RESUME_STATUS = process.env.COMPUTE_RESUME_STATUS || 'waiting'; // lit green; alive + waiting for the pending walkie
let computeStatusSetter = null;
try {
  ({ setStatus: computeStatusSetter } = require('./update-session-status.js'));
} catch (e) {
  computeStatusSetter = null; // non-fatal — resume still works, dot just may not clear
}

// Terminal (non-active) statuses. Items in these states have finished their
// lifecycle and are eligible to drain out of the live queue into dated archive
// files. Everything NOT in this set (pending, dispatched) stays in queue.json.
const TERMINAL_STATUSES = new Set(['confirmed', 'failed', 'skipped-unknown-target']);

// How long a terminal item lingers in the live queue before cleanQueue() drains
// it to the dated archive. A short grace window (not 24h) is what keeps the
// queue small: today's confirmed items used to sit here until they aged out at
// 24h, piling up into hundreds of never-purged entries and inflating every
// per-tick JSON.parse. The grace still avoids racing a just-confirmed item's
// own follow-up reads (the confirming client may re-read within a second or two).
const ARCHIVE_GRACE_MS = 60 * 1000; // 60s

// Hard ceiling on live-queue size (Step 2 — burst safety). The grace-window
// drain above handles steady state, but a burst can enqueue faster than the
// grace lets items leave. If the queue exceeds this cap, cleanQueue() force-
// archives the OLDEST terminal items (ignoring the grace window) until the
// queue is back under the cap — bounding the worst-case queue.json size, and
// therefore the per-tick JSON.parse cost, no matter how hard the fleet bursts.
// Active items (pending/dispatched) are never force-archived; only terminal
// ones are eligible, so no in-flight walkie is ever lost to the cap.
const MAX_LIVE_QUEUE = 250;

// Socket.IO — set by server.js on startup so we can broadcast lifecycle events
// (walkie:enqueued, walkie:confirmed) to the presenter UI. Silent no-op if unset.
let ioInstance = null;
function setIo(io) { ioInstance = io; }
function emitSocket(event, payload) {
  if (ioInstance) {
    try { ioInstance.emit(event, payload); } catch (e) { console.error('[QueueDispatcher] emit failed:', e.message); }
  }
}

/**
 * Read the queue
 */
function readQueue() {
  try {
    if (!existsSync(QUEUE_FILE)) return [];
    const content = readFileSync(QUEUE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    console.error('[QueueDispatcher] Failed to read queue:', e.message);
    return [];
  }
}

/**
 * Write the queue back.
 *
 * ATOMIC (torn-read fix, 2026-08-25): routed through the shared temp-file +
 * rename helper (lib/atomic-write.js) so a concurrent reader never observes a
 * half-written queue.json. The old plain writeFileSync was non-atomic and raced
 * readers under load → torn reads ("Unexpected non-whitespace after JSON" /
 * "Unexpected end of JSON input") → dispatcher retry-storm → :3005 event-loop
 * starvation (2026-08-25 incident). Rooster shipped the acute equivalent inline
 * to prod; this canonicalizes it through the ONE shared helper every writer now
 * uses. Matches the async writeQueueAsync() atomic pattern below.
 */
function writeQueue(queue) {
  try {
    writeJsonAtomicSync(QUEUE_FILE, queue);
  } catch (e) {
    console.error('[QueueDispatcher] Failed to write queue:', e.message);
  }
}

// ---------------------------------------------------------------------------
// ASYNC + SERIALIZED read-modify-write core (event-loop wedge fix, 2026-07-23).
//
// WHY: confirm()/enqueue() ran a fully SYNCHRONOUS read-modify-write of the
// whole queue.json on EVERY roger-that. A fleet-wide roger BURST fired N of
// these back-to-back; each readFileSync+JSON.parse+JSON.stringify+writeFileSync
// blocks the event loop, so N of them serialize into one long block. Reproduced
// (isolated harness): N=150 confirms => ~106ms loop-block, N=300 => ~542ms —
// past the 200ms [EL-LAG WARN] line at server.js. During that block :3005
// accepts nothing => fleet-wide HTTP 000 hang. That is the wedge.
//
// FIX (two properties, both required):
//   1. ASYNC fs (fs.promises) — the read and write no longer block the loop;
//      other requests interleave between the awaits.
//   2. SINGLE-FLIGHT MUTEX — mutations run strictly one-at-a-time through a
//      promise chain, so a burst can't race (two confirms reading the same old
//      state, second write clobbering the first) AND can't pile N synchronous
//      syscalls onto one tick. Each op yields the loop before the next runs.
//
// mutateQueue(fn) is the ONLY correct way to change the queue on a request path.
// fn receives the current array, mutates/returns the new array; the write is
// awaited under the lock. Read-only paths can still use the cheap sync
// readQueue() — a single sync read of a size-capped file (MAX_LIVE_QUEUE) is
// ~1-2ms, not a wedge; the wedge was N sync ops back-to-back, never one.
// ---------------------------------------------------------------------------
const fsp = fs.promises;

async function readQueueAsync() {
  try {
    const content = await fsp.readFile(QUEUE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.error('[QueueDispatcher] Failed to read queue (async):', e.message);
    return [];
  }
}

async function writeQueueAsync(queue) {
  // Atomic write: serialize to a temp file then rename, so a concurrent reader
  // never observes a half-written file (rename is atomic on the same fs).
  const tmp = `${QUEUE_FILE}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(queue, null, 2));
  await fsp.rename(tmp, QUEUE_FILE);
}

// The single-flight lock: a chained promise. Each mutateQueue() call appends its
// critical section to the chain, so they run strictly in order, one at a time.
let _queueLock = Promise.resolve();

// Sentinel a mutateQueue() fn returns to signal "nothing changed, skip the write".
const NO_CHANGE = Symbol('queue-no-change');

/**
 * Serialized async read-modify-write. `fn(queue)` may mutate the array in place
 * and/or return a replacement array; whatever it returns (or the mutated input)
 * is written back atomically under the lock. Returns fn's own return value's
 * companion `result` when provided as { queue, result }, else the queue.
 *
 * Usage:
 *   await mutateQueue(queue => { queue.push(item); return { queue, result: item }; })
 */
function mutateQueue(fn) {
  const run = _queueLock.then(async () => {
    const queue = await readQueueAsync();
    const out = await fn(queue);
    // fn may return:
    //   - mutateQueue.NO_CHANGE  -> read-only, skip the write entirely
    //   - {queue, result}        -> write `queue`, hand `result` back to caller
    //   - a plain array          -> write it
    //   - nothing (undefined)    -> mutated `queue` in place, write it back
    if (out === NO_CHANGE) return undefined;
    let nextQueue = queue;
    let result;
    if (out && typeof out === 'object' && Array.isArray(out.queue)) {
      nextQueue = out.queue;
      result = out.result;
    } else if (Array.isArray(out)) {
      nextQueue = out;
    }
    await writeQueueAsync(nextQueue);
    return result;
  });
  // Keep the chain alive even if this op throws, so one failure doesn't wedge
  // every future mutation. Swallow here; callers get the rejection via `run`.
  _queueLock = run.catch(() => {});
  return run;
}
mutateQueue.NO_CHANGE = NO_CHANGE;

/**
 * COMPUTE-SUSPEND RESUME (added 2026-07-18).
 *
 * The compute-only suspend mode (check-compute-suspend-stewards.js) kills an
 * idle session's claude PROCESS but LEAVES THE TMUX SESSION ALIVE — no archive,
 * no HANDOFF.md, memory intact. It records the session_id in a marker at
 * /tmp/claude-session-<name>-compute-suspend.json. When a walkie later arrives
 * for such a session, we must resume it WHOLE via `claude --resume <session_id>`
 * (restores full context/scrollback from the transcript) — NOT wakeFreshSpawn,
 * which kills the tmux and fresh-spawns NO --continue (memory-destructive).
 *
 * This is the RESUME half of that contract. Empirically proven (2026-07-18):
 *   - kill -9 frees the claude RSS; the pane's parent zsh survives at a prompt.
 *   - `claude --resume <session_id>` in that shell restores the full prior
 *     conversation and answers recall questions coherently — zero memory loss.
 *   - --resume by explicit session_id is UNAMBIGUOUS even when the cwd/global
 *     has multiple transcripts (unlike --continue = most-recent-in-cwd).
 *
 * Steps:
 *   1. Read + validate the marker. If session_id missing/marker gone, return
 *      false (caller falls through to wakeFreshSpawn — safe degrade).
 *   2. Rebuild the --add-dir flag list (same as wakeFreshSpawn) so the resumed
 *      session keeps the same directory access.
 *   3. send-keys `claude --resume <id> --dangerously-skip-permissions ...` into
 *      the EXISTING pane's shell. Do NOT kill the tmux.
 *   4. Poll up to 45s for the ready footer (widened from 20s + hardened detection
 *      2026-07-30 — see Step 4 for the memory-wipe root cause this fixes).
 *   5. On success: delete the marker (session is live again) and return 'ready'.
 *      The original walkie stays pending; the next dispatcher tick delivers it
 *      once the resumed session is idle — same two-tick contract as wake.
 *
 * Returns a QUAD-STATE string (widened from boolean 2026-07-30 for a
 * NON-destructive timeout path; widened again 2026-08-09 to BOUND the 'alive'
 * loop):
 *   'ready' — resume reached ready-state; session live, memory intact, marker
 *             deleted. Caller does nothing; next tick delivers the walkie.
 *   'alive' — not detected-ready within the timeout BUT claude is still running
 *             (slow load / undetected footer / transient send-keys error).
 *             Memory is INTACT. Caller must LEAVE the session and let the next
 *             tick retry — NEVER fresh-spawn. Marker is kept for the retry.
 *   'dead'  — resume genuinely impossible (no marker/session_id, tmux gone).
 *             Nothing live to preserve; caller degrades to memory-destructive
 *             fresh-spawn. This is the ONLY outcome that may wipe.
 *   'wake_failure' — the 'alive' branch retried ALIVE_MAX_RETRIES times
 *             (~7.5 min at 45s/tick) and claude is STILL alive-but-never-ready.
 *             This is a PERMANENT post-resume hang: the process launched but the
 *             footer never renders and it never crashes, so the 'alive' branch
 *             would otherwise loop FOREVER and never reach the 3-strike alarm.
 *             Caller routes this to handleWakeFailure (increments wake_attempts
 *             toward the wake_failure_hard escalation) — human-in-the-loop alarm,
 *             NOT a silent fresh-spawn (memory is potentially intact). The marker
 *             is KEPT (nothing wiped); Rooster/Josh decide the fate.
 */
async function resumeComputeSuspend(sessionName, markerPath) {
  const failureLog = '/tmp/sleep-wake-failures.log';
  const logFail = (msg) => {
    const line = `[${new Date().toISOString()}] [resumeComputeSuspend] ${sessionName}: ${msg}\n`;
    try { fs.appendFileSync(failureLog, line); } catch {}
    console.error(`[QueueDispatcher] [resumeComputeSuspend] ${sessionName}: ${msg}`);
  };

  // Step 1: read + validate marker.
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
  } catch (e) {
    logFail(`marker unreadable (${e.message}) — degrading to fresh-spawn`);
    return 'dead';
  }
  const sessionId = marker && marker.session_id;
  if (!sessionId) {
    logFail('marker has no session_id — degrading to fresh-spawn');
    return 'dead';
  }

  // DELETED-CWD GUARD (2026-09-07). `claude` REFUSES to start in a deleted
  // directory ("The current working directory was deleted, so that command
  // didn't work"), and a resume spawns a FRESH process in this pane's existing
  // cwd. So if the session dir was removed while the session was suspended, the
  // resume shell-drops — and the shell-drop path below UNLINKS THE MARKER,
  // destroying the only record of session_id and making the transcript
  // unrecoverable rather than merely unreachable. That is a one-way door.
  //
  // wakeFreshSpawn already guards this (`if (!existsSync(sessionDir))`); this
  // path never did, because it types into an EXISTING pane and so never had to
  // resolve the directory itself. Check it explicitly and BAIL WITH THE MARKER
  // INTACT: restoring the directory then makes the session resumable again,
  // which is impossible once the marker is gone.
  //
  // Reproduced 2026-09-07 (holler-isa-hi-9514): fixture dir deleted mid-suspend
  // -> resume exited to a bare shell -> marker unlinked -> context unrecoverable.
  const markerSessionDir = marker && marker.session_dir;
  if (markerSessionDir && !existsSync(markerSessionDir)) {
    logFail(`session_dir no longer exists (${markerSessionDir}) — claude cannot start in a deleted cwd, so a resume WOULD shell-drop and the shell-drop path would unlink this marker. Refusing to attempt: leaving the marker INTACT so the session stays resumable if the directory is restored.`);
    return 'blocked-deleted-cwd';
  }

  // The pane must still exist (tmux alive). If not, there's nothing to resume
  // into — caller's cold-path (wakeFreshSpawn) handles a missing session.
  if (!sessionExists(sessionName)) {
    logFail('tmux session gone — cannot resume-in-place, degrading to fresh-spawn');
    return 'dead';
  }

  console.log(`[QueueDispatcher] [resumeComputeSuspend] ${sessionName}: resuming session_id=${sessionId} in-place`);

  // Step 2: rebuild --add-dir flags (same as wakeFreshSpawn).
  const homeDir = os.homedir();
  // Resolve the NEWEST-version claude (not PATH-order) — under launchd env,
  // `which claude` grabs a stale /opt/homebrew build. See lib/claude-resolver.js.
  const claudePath = resolveClaudePath();
  const codeDir = join(homeDir, 'code');
  let addDirFlags = '';
  try {
    const dirList = execSync(`ls -d "${codeDir}"/*/`, { encoding: 'utf-8' });
    addDirFlags = dirList.trim().split('\n')
      .filter(d => d && !d.includes('node_modules'))
      .map(d => `--add-dir '${d.replace(/\/$/, '')}'`)
      .join(' ');
  } catch {}

  // Stamp the resume BEFORE typing the command — this is the load-bearing
  // ordering. The vulnerable window is the resume ITSELF: from the moment the
  // command is typed into the shell until Claude's TUI draws. Inside it,
  // needsClaudeRestart can already report ALIVE (measured ~0.25s after submit)
  // while there is still no input box, so a delivery pastes onto the SHELL
  // command line and the message is silently lost.
  //
  // A first version of this fix stamped on SUCCESS (Step 5) and therefore left
  // exactly that window uncovered — the race harness caught it: one corrupted
  // shell-line paste in 6000 lines of scrollback, landing between "resuming"
  // and "RESUMED". Stamping here covers the whole window; the stamp's existing
  // expiry (FRESH_SPAWN_WINDOW_MS) still bounds it, and a resume that fails
  // simply leaves a stamp that ages out on its own.
  try {
    fs.writeFileSync(`/tmp/claude-session-${sessionName}-resumed-at`, String(Date.now()));
  } catch {}

  // Step 3: send the resume command into the existing pane's shell. The pane
  // is a live zsh (claude died as its child); send-keys types the command and
  // Enter runs it. NO tmux kill — that's the whole point.
  try {
    // --model 'opus' is MANDATORY here, not cosmetic. `claude --resume` REPLAYS the
    // model id stored in the dead session's jsonl history. When that history carries
    // the RETIRED claude-opus-4-20250514, the resumed session 404s on EVERY inference
    // even with a correct binary — and each --resume wake re-poisons. Forcing --model
    // OVERRIDES the replayed id. We pass the ALIAS 'opus' (not a dated id) so it tracks
    // the binary's current-latest Opus and can NOT re-retire the way a dated id rots.
    // On a session whose saved model is already valid this is a no-op override.
    const resumeCmd = `${claudePath} --resume ${sessionId} --model opus --dangerously-skip-permissions ${addDirFlags}`;
    // Clear any stray input first (defensive — a partial paste could be in the
    // buffer), then type the command + Enter.
    execSync(`tmux send-keys -t "=${sessionName}:" C-u 2>/dev/null`);
    const tempFile = join(os.tmpdir(), `compute-resume-${Date.now()}-${process.pid}.txt`);
    const bufName = `compute-resume-${Date.now()}-${process.pid}`;
    fs.writeFileSync(tempFile, resumeCmd);
    execSync(`tmux load-buffer -b "${bufName}" "${tempFile}"`);
    execSync(`tmux paste-buffer -b "${bufName}" -t "=${sessionName}:" -d`);
    await sleep(300); // non-blocking render delay — yields the loop (see sleep() note)
    submitPane(sessionName); // Enter + KPEnter (see submitPane note)
    try { fs.unlinkSync(tempFile); } catch {}
  } catch (e) {
    // A send-keys hiccup means `claude --resume` never started — but the
    // transcript on disk is INTACT and the marker still records its session_id.
    // Fresh-spawning here would wipe a conversation we never even tried to load.
    // Return 'alive' (retry): keep the marker so the NEXT tick re-attempts the
    // resume cleanly. NON-destructive — a transient tmux error must never cost
    // the user their memory.
    logFail(`resume send-keys failed: ${e.message} — will retry resume next tick (NOT wiping)`);
    return 'alive';
  }

  // Ceiling for the 'alive' branch (claude launched, process alive, footer never
  // renders). At READY_TIMEOUT_SEC=45s per tick, 10 retries ≈ 7.5 min of grace —
  // GENEROUS enough for even a huge slow transcript load to finish, while still
  // BOUNDING a permanent post-resume hang so it eventually reaches the 3-strike
  // wake_failure_hard alarm instead of looping 'alive' forever (2026-08-09).
  const ALIVE_MAX_RETRIES = 10;

  // Step 4: poll for ready-state. Resume loads the transcript, which can take a
  // few seconds longer than a fresh spawn — and MUCH longer under fleet load when
  // several sessions resume at once (concurrent transcript reads contend on CPU/IO).
  //
  // Widened 20s -> 45s (2026-07-30): observed real successes clustered at T+2..7s
  // but the tail reached T+14s even in light conditions; 20s left only ~6s of
  // headroom, so a loaded-tail resume crossed it and got its memory wiped. 45s is
  // strictly safe here — this is the memory-PRESERVING path, so waiting longer only
  // costs a few seconds of latency, never data. The detection is also hardened
  // below: a real footer can render as a line-wrapped / NBSP-laced variant that the
  // exact `bypass permissions on` substring misses (false-negative), so we accept
  // several ready signatures.
  const READY_TIMEOUT_SEC = 45;
  const isReadyPane = (cap) =>
    cap.includes('bypass permissions on') ||
    // NBSP-normalized variant (footer sometimes renders U+00A0 between words).
    cap.replace(/\u00A0/g, ' ').includes('bypass permissions on') ||
    // Line-wrap-tolerant: footer split across lines still contains both tokens.
    (/bypass\s+permissions/i.test(cap) && /\bon\b/i.test(cap)) ||
    // The interactive prompt box is present (claude is at the input prompt).
    (cap.includes('╭') && cap.includes('╰') && /shortcuts/i.test(cap));
  // STALE-MARKER AUTO-HEAL (2026-08-04). A compute-suspend marker whose session_id
  // points at a conversation that has since AGED OUT makes `claude --resume <id>`
  // fail hard with "No conversation found with session ID" and drop the pane back
  // to a bare shell. That failure is PERMANENT for this session_id — no amount of
  // retrying will ever make the aged-out transcript reappear — so the claimed
  // degrade-to-fresh-spawn never fired (resume exits to shell, and the old timeout
  // path burned 3 retries first, or waited the full 45s). Detect this specific
  // error in the poll: as soon as we see it, the marker is provably useless. Delete
  // it and return 'dead' so the caller falls straight through to wakeFreshSpawn —
  // self-healing, no manual marker-rm needed. Line-wrap/NBSP tolerant like the
  // ready-footer matcher above.
  // RESUME-SUMMARY PICKER (2026-09-06). `claude --resume` can interrupt with an
  // interactive prompt BEFORE loading the conversation:
  //
  //   This session is 4h 20m old and 103.1k tokens.
  //   Resuming the full session will consume a substantial portion of your usage
  //   limits. We recommend resuming from a summary.
  //   > 1. Resume from summary (recommended)
  //     2. Resume full session as-is
  //     3. Don't ask me again
  //
  // Nothing answered it, so the pane parked there indefinitely: claude alive, the
  // ready footer never rendering, the session unusable. Observed in production on
  // the first real cold-resume of the staged rollout.
  //
  // ⚠️ THE SUMMARY OPTION IS THE PRE-SELECTED DEFAULT, so a blind Enter — or any
  // answer-by-POSITION — is a coin flip against the "wakes up whole" promise.
  // Confirmed real but unrealised in production 2026-09-06: a session that hit
  // this picker was answered full-session, and a memory probe for INCIDENTAL
  // specifics (a port, a line number, a duration, a verbatim quote), each
  // cross-checked against an independent record, confirmed its context survived.
  // A summary keeps the SHAPE of the work and flattens exactly that detail — so
  // "does it know its task?" cannot tell the two apart, and only incidental
  // specifics can.
  //
  // ⚠️ WHY WE MUST PICK "Resume full session as-is" AND NEVER THE DEFAULT:
  // option 1 ("Resume from summary") is PRE-SELECTED, and taking it would SILENTLY
  // DEFEAT THE ENTIRE FEATURE. The whole premise — the thing that was signed off —
  // is that a suspended session wakes up WHOLE. A summary resume is by definition a
  // session that comes back NOT whole. That failure would be INVISIBLE: the session
  // looks healthy, answers normally, and has quietly lost the context the
  // secret-word test was written to prove. A visible wedge is strictly better than
  // a silent amnesia, so blind-Enter here is the one thing we must never do.
  //
  // NO SIZE OR AGE GATE, deliberately. Measured 2026-09-06: the picker keys on
  // last-turn context + age, NOT file size and NOT peak context — a 16.4MB / 464k
  // session got it while a 3.4MB / 526k session did NOT (five times the peak
  // context, exempt). With n=2 the exact threshold is unknown, so any predictive
  // gate would fire sometimes and be trusted always. A text matcher does not need
  // to PREDICT the picker; it REACTS to the prompt being on screen.
  const isResumeSummaryPicker = (cap) => {
    // FLATTEN WHITESPACE BEFORE MATCHING (fix 2026-09-07). The explanatory
    // sentence WRAPS in a real pane:
    //     "...your usage limits. We recommend resuming from a"
    //     "summary."
    // so a single-line regex can NEVER match it. Because both phrases are
    // required (correctly — that is what stops false positives), the wrapped
    // phrase failing meant this predicate returned false on EVERY REAL PICKER.
    // It was structurally incapable of firing, and it did not fire on two
    // production pickers (mcgucket 02:37, steward-manager 02:41) before the
    // cause was found from a live pane capture.
    //
    // WHY THE ORIGINAL LOOKED CORRECT: it was written and tested against a
    // HAND-TYPED fixture, where the sentence sits on one line. The fixture and
    // the real pane differed in the one dimension that mattered, and the fixture
    // agreed with the code. isNoConversationPane, eight lines below, was already
    // line-wrap-tolerant for exactly this reason — the precedent was in-file.
    const flat = cap.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
    // Require BOTH the explanatory sentence and the full-session option, so an
    // unrelated pane that merely says "resume" can never match.
    return /We recommend resuming from a summary/i.test(flat) &&
      /Resume full session as-is/i.test(flat);
  };

  const isNoConversationPane = (cap) => {
    const norm = cap.replace(/\u00A0/g, ' ');
    return /No conversation found with session ID/i.test(norm) ||
      // Line-wrap-tolerant: the phrase can split across a wrapped line.
      (/No conversation found/i.test(norm) && /session ID/i.test(norm));
  };
  // SHELL-DROP DISCRIMINATOR (2026-08-08). When `claude --resume` actually RAN and
  // then EXITED (resume definitively failed \u2014 bad/aged session_id that slipped past
  // the "No conversation found" matcher, an internal crash, a 404-on-inference bail,
  // etc.), the pane falls back to the bare interactive shell it was launched into
  // and NO amount of retrying revives it. That state is INDISTINGUISHABLE from
  // "resume not started yet" by process liveness alone (claude is GONE in both), so
  // before conceding to the conservative 3-retry (correct only for not-started-yet)
  // we discriminate here.
  //
  // Rooster reproduced a real shell-drop 2026-08-08 and captured it literally:
  //   joshuamullet@Joshuas-MacBook-Air ~ % ~/.local/bin/claude --resume 0000...
  //   No conversation found with session ID: 00000000-...
  //   joshuamullet@Joshuas-MacBook-Air ~ %
  // Findings: (a) prompt is the DEFAULT zsh `%n@%m %1~ %# ` (from /etc/zshrc) \u2014 no
  // theme, no git branch; (b) a dropped shell has NO residual claude chrome (no box,
  // no "bypass permissions" footer). A still-LOADING transcript, by contrast, keeps
  // that chrome on screen WITH claude ALIVE \u2014 so it's caught by the claudeStillAlive
  // branch above and never reaches this code.
  //
  // Per Rooster's robustness guidance, the PRIMARY signal is the PROCESS TREE, not
  // the prompt string (a host rename / cwd change / added theme would break a
  // text-only matcher and silently resurrect this bug):
  //   PRIMARY   = pane's foreground process is a shell (pane_current_command is
  //               zsh/bash/etc) AND claude is gone from the tree (== the already-
  //               computed !claudeStillAlive that gates this branch).
  //   SECONDARY = (tightener) pane text is a clean shell prompt (trailing %/# with a
  //               user@host/path segment) AND shows NO claude chrome. This separates
  //               "exited to shell" from "shell briefly foreground while claude is
  //               still launching" (not-started-yet), preserving the retry.
  const paneForegroundIsShell = () => {
    try {
      const fg = execSync(
        `tmux list-panes -t "=${sessionName}" -F '#{pane_current_command}' 2>/dev/null | head -1`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim();
      const base = fg.replace(/^-/, ''); // login shells report as '-zsh'
      return base === 'zsh' || base === 'bash' || base === 'sh' || base === 'fish';
    } catch {
      return false;
    }
  };
  const isCleanShellPromptPane = (cap) => {
    const norm = cap.replace(/\u00A0/g, ' ');
    // Any claude chrome on screen \u21D2 NOT a clean dropped shell \u2014 bail.
    if (norm.includes('\u276F') || norm.includes('\u256D') || norm.includes('\u2570') ||
        /bypass\s+permissions/i.test(norm) || /shortcuts/i.test(norm)) {
      return false;
    }
    const lines = norm.split('\n');
    let last = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().length > 0) { last = lines[i]; break; }
    }
    if (last === null) return false; // wholly blank pane \u2192 still loading, not a drop
    const trimmed = last.replace(/\s+$/, '');
    // zsh default prompt ends in `%` (user) or `#` (root); anchor on the glyph and
    // require a user@host / path segment so it can't match arbitrary command output.
    return /[%#]$/.test(trimmed) && /\S+@\S+|[~/]/.test(trimmed);
  };
  let readySec = 0;
  // Answer the picker at most ONCE per resume attempt. Re-sending on every poll
  // tick would type stray digits into the freshly-loaded session.
  let pickerAnswered = false;
  for (let s = 1; s <= READY_TIMEOUT_SEC; s++) {
    try {
      const cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, { encoding: 'utf-8' });
      if (isReadyPane(cap)) { readySec = s; break; }

      // Answer the resume-summary picker if it is blocking us. Selection is by
      // OPTION TEXT, never by position: the numbers could be reordered by a future
      // build, and picking "1" positionally would silently choose the SUMMARY
      // resume — the one outcome that destroys the feature invisibly.
      //
      // We locate the line whose text contains "Resume full session as-is", read
      // ITS OWN leading number, and send that. If the line is missing, or carries
      // no number we can read, we send NOTHING and let the session stay wedged.
      // A visible wedge is recoverable; a wrong pick is silent memory loss.
      if (!pickerAnswered && isResumeSummaryPicker(cap)) {
        const norm = cap.replace(/\u00A0/g, ' ');
        const line = norm.split('\n').find((l) => /Resume full session as-is/i.test(l));
        const m = line && line.match(/(\d+)\s*[.)]/);
        if (m) {
          const choice = m[1];
          logFail(`resume-summary picker detected — selecting option ${choice} ("Resume full session as-is") by TEXT match. Never the default: option 1 is a SUMMARY resume, which would silently defeat the wake-up-whole guarantee.`);
          try {
            execSync(`tmux send-keys -t "=${sessionName}:" ${choice} 2>/dev/null`);
            await sleep(200);
            submitPane(sessionName);
            pickerAnswered = true;
          } catch (e) {
            logFail(`resume-summary picker: send-keys failed (${e.message}) — leaving the session on the picker rather than guessing.`);
          }
        } else {
          logFail('resume-summary picker detected BUT the "Resume full session as-is" line carries no readable option number — doing NOTHING deliberately. A visible wedge beats a wrong pick (option 1 would summarize and silently lose context).');
        }
      }

      if (isNoConversationPane(cap)) {
        // Aged-out session_id — resume is permanently impossible. Remove the stale
        // marker so it can't re-poison future ticks, and degrade to fresh-spawn.
        // (The caller ALSO rm's the marker on 'dead'; the unlink is idempotent.)
        logFail(`claude --resume reported "No conversation found with session ID ${sessionId}" — aged-out transcript. Removing stale marker + degrading to fresh-spawn (self-heal).`);
        try { fs.unlinkSync(markerPath); } catch {}
        return 'dead';
      }
    } catch {}
    await sleep(1000); // non-blocking poll interval — yields the loop
  }
  if (!readySec) {
    // Timeout reached WITHOUT a detected ready footer. This does NOT mean the
    // session is dead — the resume may still be loading a huge transcript, or the
    // footer may be rendering in a form our detection still misses. The old code
    // returned false here and the caller unconditionally KILLED this pane and
    // fresh-spawned (memory-destructive) — the exact bug that wiped Josh's
    // sessions. Instead, probe the pane's process tree: if `claude` is still
    // ALIVE, we must NOT touch it — leave it running (memory intact) and let the
    // next dispatcher tick deliver the pending walkie once it finishes. Only if
    // claude is genuinely GONE is a fresh-spawn safe (nothing to preserve).
    const claudeStillAlive = !needsClaudeRestart(sessionName);
    if (claudeStillAlive) {
      // BOUND the 'alive' loop (2026-08-09). A claude that LAUNCHES but PERMANENTLY
      // HANGS post-resume (process alive, footer never renders, never crashes) would
      // otherwise return 'alive' every tick FOREVER and never reach the 3-strike
      // wake_failure_hard alarm — the last uncovered edge in that chain. Track a
      // SEPARATE counter ('alive_retries') in the marker so it can't be conflated
      // with 'resume_retries' (the not-started-yet counter): a session can bounce
      // between not-started and alive across ticks, and sharing one field would
      // either over-count (false-concede on a healthy slow load) or reset the other.
      let aliveRetries = 0;
      let aliveMarkerValid = false;
      try {
        const m = JSON.parse(readFileSync(markerPath, 'utf-8'));
        aliveRetries = (m.alive_retries || 0) + 1;
        aliveMarkerValid = !!(m && m.session_id);
        if (aliveMarkerValid) {
          m.alive_retries = aliveRetries;
          fs.writeFileSync(markerPath, JSON.stringify(m, null, 2));
        }
      } catch {}
      if (!aliveMarkerValid || aliveRetries <= ALIVE_MAX_RETRIES) {
        logFail(`claude --resume not detected-ready within ${READY_TIMEOUT_SEC}s BUT claude process is ALIVE — leaving it (memory intact), next tick will deliver. alive-retry ${aliveRetries}/${ALIVE_MAX_RETRIES}. NOT wiping.`);
        // A DOT THAT LIES (fixed 2026-09-06). The suspend sets the UI status to
        // the dark/asleep value, and ONLY the 'ready' path at the end of this
        // function clears it back to 'waiting'. This branch returns while claude
        // is CONFIRMED ALIVE (it is gated on claudeStillAlive above) and merely
        // slow to render its footer — so the dashboard kept showing "asleep/off"
        // for a session that was genuinely up and loading. Invariant: the status
        // dot must match reality on every session touch.
        //
        // Deliberately NOT applied to the other two `return 'alive'` sites: the
        // send-keys-failed case (the resume command never ran) and the
        // not-started-yet case (reached only when claudeStillAlive is FALSE) both
        // have claude genuinely DEAD, where the asleep dot is CORRECT. Clearing
        // it there would just invert the lie.
        if (computeStatusSetter) {
          try {
            computeStatusSetter(sessionName, COMPUTE_RESUME_STATUS);
          } catch (e) {
            // Cosmetic only — never let a dot update break the resume path.
          }
        }
        // Keep the marker so the next tick re-enters this path if claude is still
        // mid-load; if by then it's ready, isReadyPane will catch it and Step 5
        // cleans up. Return 'alive' so the caller does a NON-destructive re-queue.
        return 'alive';
      }
      // Alive-retries EXHAUSTED: claude has been alive-but-never-ready for
      // ~ALIVE_MAX_RETRIES × READY_TIMEOUT_SEC — a permanent post-resume hang.
      // Do NOT fresh-spawn (memory is potentially intact — a silent wipe is the
      // wrong call here). Escalate to the human-in-the-loop wake_failure_hard
      // alarm instead: return 'wake_failure' and let the caller route it to
      // handleWakeFailure (which increments wake_attempts toward the 3-strike
      // Rooster escalation). Marker is KEPT — nothing is wiped.
      logFail(`claude --resume alive-but-never-ready for ${aliveRetries} ticks (>${ALIVE_MAX_RETRIES}) — permanent post-resume hang. Escalating to wake_failure_hard (NO wipe; memory potentially intact).`);
      return 'wake_failure';
    }
    // Claude is GONE. SHELL-DROP CHECK (2026-08-08) — run BEFORE the bounded retry.
    // If `claude --resume` ran-and-exited to a bare shell, retrying is futile and
    // the old 3x45s wait is exactly the 3+ min Josh sat through. Discriminate a
    // definitive shell-drop from a not-started-yet resume:
    //   PRIMARY   = pane foreground process is a shell (claude already exited to it).
    //   SECONDARY = pane text is a clean shell prompt with NO claude chrome.
    // Both must hold: the primary alone can be true in the transient "shell
    // foreground while claude is about to exec" window, so the clean-prompt confirm
    // gates out that not-started-yet case (its pane won't show a settled %/# prompt).
    let shellDropCap = '';
    try {
      shellDropCap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, { encoding: 'utf-8' });
    } catch {}
    if (paneForegroundIsShell() && isCleanShellPromptPane(shellDropCap)) {
      // PRESERVE THE MARKER WHEN THE CAUSE MIGHT BE RECOVERABLE (2026-09-07).
      // Unlinking here destroys the only record of session_id, so a shell-drop
      // whose cause is later fixed can never be resumed — the transcript exists
      // but nothing knows which one it is. A deleted cwd is exactly that case:
      // restore the directory and the session is resumable again, but ONLY if
      // the marker survived. Re-check it here as well as up front, because the
      // directory can be removed DURING the resume attempt.
      const dirGoneNow = markerSessionDir && !existsSync(markerSessionDir);
      if (dirGoneNow) {
        logFail(`claude --resume EXITED to a bare shell (session_id=${sessionId}) AND session_dir is gone (${markerSessionDir}) — that is the cause, and it is RECOVERABLE. KEEPING the marker so restoring the directory makes this session resumable. Not degrading to fresh-spawn.`);
        return 'blocked-deleted-cwd';
      }
      logFail(`claude --resume ran and EXITED to a bare shell (session_id=${sessionId}) — resume DEFINITIVELY failed (shell-drop). Skipping the bounded retry wait and degrading to fresh-spawn IMMEDIATELY (self-heal).`);
      try { fs.unlinkSync(markerPath); } catch {}
      return 'dead';
    }
    // Not a shell-drop. Claude is NOT alive at timeout, but this does NOT
    // automatically mean memory is gone: the `claude --resume` may simply not have
    // STARTED yet (a busy/blocked
    // shell delayed it), while the transcript the marker points to is STILL on
    // disk and fully resumable. The marker is our proof-of-resumability — the
    // compute-suspend writer only creates it after validating the session_id. So
    // as long as the marker survives, prefer a NON-destructive retry over a wipe.
    // A bounded retry counter (stored in the marker) prevents an infinite loop:
    // only after RESUME_MAX_RETRIES exhausted do we concede to a fresh-spawn.
    const RESUME_MAX_RETRIES = 3;
    let retries = 0;
    let markerStillValid = false;
    try {
      const m = JSON.parse(readFileSync(markerPath, 'utf-8'));
      retries = (m.resume_retries || 0) + 1;
      markerStillValid = !!(m && m.session_id);
      if (markerStillValid && retries <= RESUME_MAX_RETRIES) {
        m.resume_retries = retries;
        fs.writeFileSync(markerPath, JSON.stringify(m, null, 2));
      }
    } catch {}
    if (markerStillValid && retries <= RESUME_MAX_RETRIES) {
      logFail(`claude --resume not ready within ${READY_TIMEOUT_SEC}s and process not yet started, but transcript is INTACT (marker session_id present) — retry ${retries}/${RESUME_MAX_RETRIES} next tick. NOT wiping.`);
      return 'alive';
    }
    logFail(`claude --resume did not reach ready-state within ${READY_TIMEOUT_SEC}s, process dead, retries exhausted (${retries}) — degrading to fresh-spawn`);
    return 'dead';
  }

  // Step 5: success. Remove the marker (session is live again) and clear the
  // last-was-clear flag so message-delivery semantics stay normal.
  try { fs.unlinkSync(markerPath); } catch {}
  try {
    const flagPath = `/tmp/claude-session-${sessionName}-last-was-clear.flag`;
    if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath);
  } catch {}

  // dark-circle: clear the asleep/dark UI dot — session is live again. Non-fatal:
  // if the setter is unavailable or errors, log and continue (dot mismatch is
  // cosmetic; the resume itself already succeeded).
  if (computeStatusSetter) {
    try {
      computeStatusSetter(sessionName, COMPUTE_RESUME_STATUS);
      console.log(`[QueueDispatcher] [resumeComputeSuspend] ${sessionName}: dark-circle cleared -> ${COMPUTE_RESUME_STATUS}`);
    } catch (e) {
      console.error(`[QueueDispatcher] [resumeComputeSuspend] ${sessionName}: dark-circle clear failed: ${e.message}`);
    }
  }

  // REFRESH the stamp at ready-state. It was already written before the resume
  // command was typed (see the note there — that is what covers the resume
  // window itself); re-stamping here restarts the freshness window from the
  // moment the TUI is actually up, so a slow resume still gets the full guard
  // afterwards rather than a window that half-expired while it loaded.
  try {
    fs.writeFileSync(`/tmp/claude-session-${sessionName}-resumed-at`, String(Date.now()));
  } catch {}

  console.log(`[QueueDispatcher] [resumeComputeSuspend] ${sessionName}: RESUMED (ready at T+${readySec}s); original walkie stays pending for next tick`);
  return 'ready';
}

/**
 * Wake a steward via fresh-spawn (NO --continue). Fleet-wide unconditional
 * since 2026-05-04 — every steward is woken fresh; --continue paths are gone.
 *
 * ASYNC body (2026-07-29): takes up to ~45s (15s ready-poll + 30s marker-deadman)
 * of WALL time, but its internal poll/render delays are non-blocking `await
 * sleep()`s (not `execSync('sleep N')`), so the event loop stays responsive the
 * whole time. Invoked via `setImmediate(() => Promise.resolve().then(() =>
 * wakeFreshSpawn(...)))` from the dispatch tick so the tick itself never blocks
 * — see scheduleAsyncWake() below. Returns a Promise<boolean>.
 *
 * Steps:
 *   1. If a tmux session exists for the target, kill it (we want a true fresh
 *      shell — not a respawn into stale pane state).
 *   2. tmux new-session in sessionDir with the claude command as the
 *      shell-command arg. NO --continue. tmux execs the shell directly so we
 *      sidestep the send-keys length/quoting issues that broke the first
 *      attempt (~2.5KB --add-dir flag list got truncated mid-arg).
 *   3. Poll up to 15s for "bypass permissions on" footer in pane (the canonical
 *      ready-state signature; `❯ Try ` regex breaks on U+00A0 NBSP).
 *   4. Build a wake-message instructing Claude to (a) touch a marker, (b) read
 *      HANDOFF.md, (c) skim CLAUDE.md. Inject via canonical load-buffer +
 *      paste-buffer + sleep 0.5 + Enter (mirrors sendMessage()).
 *   5. Watch for the marker file for up to 30s.
 *
 * CRITICAL CONTRACT: this function does NOT consume the queued walkie. It
 * only handles spawn + bootstrap. The original walkie stays `pending` so the
 * NEXT dispatcher tick (5-10s later) sees session=awake and delivers normally.
 * Two-tick wake by design — self-correcting, idempotent, easy to reason about.
 *
 * Returns true on success (marker observed), false on any failure. Failures
 * write to /tmp/sleep-wake-failures.log. Hard-failure escalation (max-retry +
 * walkie holler-rooster) is handled by the caller via wake_attempts on the
 * queue item; see the dispatch-loop branches.
 */
async function wakeFreshSpawn(sessionName, sessionDir) {
  const wakeId = `${Date.now()}-${process.pid}`;
  const marker = `/tmp/wake-rogered-${wakeId}`;
  const failureLog = '/tmp/sleep-wake-failures.log';
  const captureDir = `/tmp/sleep-wake-pane-captures/${wakeId}`;
  try { execSync(`mkdir -p "${captureDir}"`); } catch {}

  const logFail = (msg) => {
    const line = `[${new Date().toISOString()}] [wakeFreshSpawn] ${sessionName}: ${msg}\n`;
    try { fs.appendFileSync(failureLog, line); } catch {}
    console.error(`[QueueDispatcher] [wakeFreshSpawn] ${sessionName}: ${msg}`);
  };

  console.log(`[QueueDispatcher] [wakeFreshSpawn] ${sessionName}: starting (wake_id=${wakeId} cwd=${sessionDir})`);

  // Step 1: kill any stale tmux session — we want a TRUE fresh shell.
  try { execSync(`tmux kill-session -t "=${sessionName}" 2>/dev/null`); } catch {}

  // Step 2: spawn fresh tmux + start claude. NO --continue.
  const homeDir = os.homedir();
  // Resolve the NEWEST-version claude (not PATH-order) — see lib/claude-resolver.js.
  const claudePath = resolveClaudePath();

  const codeDir = join(homeDir, 'code');
  let addDirFlags = '';
  try {
    const dirList = execSync(`ls -d "${codeDir}"/*/`, { encoding: 'utf-8' });
    addDirFlags = dirList.trim().split('\n')
      .filter(d => d && !d.includes('node_modules'))
      .map(d => `--add-dir '${d.replace(/\/$/, '')}'`)
      .join(' ');
  } catch {}

  if (!existsSync(sessionDir)) {
    logFail(`session dir does not exist: ${sessionDir}`);
    return false;
  }

  // Spawn tmux WITH the claude command as the shell-command arg — same pattern as
  // startSession() (line 226). NO --continue. tmux execs the shell directly, so
  // we sidestep the send-keys quoting/length issues that break a 2.5KB
  // --add-dir flag string when typed via send-keys (observed in rehearsal #3
  // first attempt: send-keys truncated the command mid-arg, claude never started,
  // ready-poll deadman fired). The trailing `; zsh` keeps the pane alive after
  // claude exits so the next dispatcher tick can detect dead-claude and re-wake.
  try {
    const claudeCommand = `${claudePath} --dangerously-skip-permissions ${addDirFlags}; zsh`;
    execSync(`tmux new-session -d -s "${sessionName}" -c "${sessionDir}" -x 200 -y 50 "${claudeCommand}"`);
  } catch (e) {
    logFail(`tmux spawn failed: ${e.message}`);
    return false;
  }

  // Step 3: poll for ready-state. 15s timeout, 1s polling.
  const READY_TIMEOUT_SEC = 15;
  let readySec = 0;
  for (let s = 1; s <= READY_TIMEOUT_SEC; s++) {
    try {
      const cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, { encoding: 'utf-8' });
      try { fs.writeFileSync(`${captureDir}/ready-${s}.txt`, cap); } catch {}
      if (cap.includes('bypass permissions on')) {
        readySec = s;
        break;
      }
    } catch {}
    // Non-blocking poll interval — yields the loop instead of the old
    // execSync('sleep 1'). (2026-06-07 note kept for history: the old shell-out
    // could propagate as "wakeFreshSpawn threw: Command failed: sleep 1" — /2/80.)
    await sleep(1000);
  }
  if (!readySec) {
    logFail(`claude did not reach ready-state within ${READY_TIMEOUT_SEC}s`);
    try {
      const cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, { encoding: 'utf-8' });
      fs.writeFileSync(`${captureDir}/ready-timeout.txt`, cap);
    } catch {}
    return false;
  }
  console.log(`[QueueDispatcher] [wakeFreshSpawn] ${sessionName}: ready at T+${readySec}s`);

  // Step 4: inject bootstrap wake-message via canonical load-buffer pattern.
  const handoffPath = join(sessionDir, 'HANDOFF.md');
  const claudeMdPath = join(sessionDir, 'CLAUDE.md');
  const wakeMsg = [
    'WAKE-UP. You were asleep; you have just been spawned fresh (NO --continue, no scrollback). Three steps in order, do them now BEFORE anything else:',
    `1. FIRST: touch ${marker} (use the Bash tool). Sub-second op — proves the wake worked.`,
    `2. THEN: read ${handoffPath} — that file is the bridge to your previous self.`,
    `3. THEN: skim ${claudeMdPath} for doctrine you need.`,
    'After bootstrap completes, the queued walkie that woke you will arrive on the next dispatcher tick (5-10s). Process it as your first real work.',
    'Do NOT consume the queued walkie yourself; the dispatcher delivers it naturally once you are idle.',
  ].join('\n');

  const tempFile = join(os.tmpdir(), `wake-fresh-spawn-${Date.now()}-${process.pid}.txt`);
  const bufName = `walkie-wake-${Date.now()}-${process.pid}`;
  try {
    fs.writeFileSync(tempFile, wakeMsg);
    execSync(`tmux load-buffer -b "${bufName}" "${tempFile}"`);
    // Bracketed paste — see pasteBufferToPane (head-truncation fix 2026-08-29).
    pasteBufferToPane(bufName, sessionName);
    await sleep(500); // non-blocking render delay — yields the loop (see sleep() note)
    submitPane(sessionName); // Enter + KPEnter (see submitPane note)

    // LOST-KICKOFF-ZOMBIE FIX (2026-08-08). A fresh-spawn had been STRANDING here:
    // the bootstrap text pasted into the just-ready prompt but the single submit
    // silently no-op'd (Enter/KPEnter can race the TUI while the input box is still
    // settling right after "bypass permissions on" first renders), leaving the
    // kickoff parked UNSUBMITTED (ps flat ~0%) until a human nudged Enter. This is
    // the SAME failure class the delivery path (injectNow) already guards against —
    // so apply the SAME tracked-box recheck-and-refire loop here: confirm the input
    // box actually emptied (kickoff committed); if not, re-fire submit up to
    // SUBMIT_RETRY_MAX times. Idempotent — re-submitting an already-empty box is a
    // no-op, so this can only help, never double-submit.
    //
    // Shared with the delivery path since 2026-08-31 (verifySubmitted) so both use
    // identical semantics — this pane is by definition freshly spawned and still
    // settling, so it gets the same longer FRESH_SUBMIT_RETRY_MAX window the
    // kickoff delivery path now uses.
    const submitted = await verifySubmitted(sessionName, {
      maxAttempts: FRESH_SUBMIT_RETRY_MAX,
      label: '[wakeFreshSpawn] bootstrap kickoff:',
    });
    if (submitted) {
      console.log(`[QueueDispatcher] [wakeFreshSpawn] ${sessionName}: bootstrap kickoff SUBMITTED (input box cleared)`);
    } else {
      // Not fatal on its own: the Step-5 marker deadman below is the real success
      // gate. Log loudly so a genuinely-stuck kickoff is visible in the failure log.
      logFail(`bootstrap kickoff did NOT clear the input box after ${SUBMIT_RETRY_MAX} submit re-fires — marker deadman will confirm/deny; possible lost-kickoff-zombie`);
    }
  } catch (e) {
    logFail(`bootstrap injection failed: ${e.message}`);
    try { fs.unlinkSync(tempFile); } catch {}
    return false;
  }
  try { fs.unlinkSync(tempFile); } catch {}

  // Step 5: poll for marker file. 30s deadman.
  const MARKER_TIMEOUT_SEC = 30;
  const injectEpoch = Math.floor(Date.now() / 1000);
  while (true) {
    const elapsed = Math.floor(Date.now() / 1000) - injectEpoch;
    if (existsSync(marker)) {
      console.log(`[QueueDispatcher] [wakeFreshSpawn] ${sessionName}: PASS — marker observed at T+${elapsed}s`);
      try {
        const cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, { encoding: 'utf-8' });
        fs.writeFileSync(`${captureDir}/final.txt`, cap);
      } catch {}
      // Mark the resurrect-flag so the post-handoff-clear semantics
      // remain consistent with kill+respawn flows elsewhere.
      try { fs.writeFileSync(`/tmp/claude-session-${sessionName}-last-was-clear.flag`, ''); } catch {}
      return true;
    }
    if (elapsed >= MARKER_TIMEOUT_SEC) {
      // False-alarm discrimination: if the tmux session exists and isSessionReady
      // returns true at deadman time, the wake actually succeeded — Claude woke
      // up and is at the prompt, but hasn't gotten to the marker Bash call yet
      // (busy reading HANDOFF.md, processing prior thoughts, or compaction). The
      // next dispatcher tick will deliver the original walkie just fine. Mark as
      // success so handleWakeFailure doesn't increment wake_attempts on healthy
      // sessions. Pre-2026-06-04 this fired ~7x/week as a false alarm; the
      // queue.json record showed status='confirmed' on the next tick anyway.
      try {
        const cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, { encoding: 'utf-8' });
        fs.writeFileSync(`${captureDir}/deadman.txt`, cap);
        if (cap.includes('bypass permissions on')) {
          console.log(`[QueueDispatcher] [wakeFreshSpawn] ${sessionName}: marker-deadman at ${MARKER_TIMEOUT_SEC}s BUT pane is ready (bypass-permissions visible) — treating as success; next tick will deliver`);
          try { fs.writeFileSync(`/tmp/claude-session-${sessionName}-last-was-clear.flag`, ''); } catch {}
          return true;
        }
      } catch {}
      logFail(`marker deadman fired at ${MARKER_TIMEOUT_SEC}s; no ${marker} AND pane not at ready-prompt — genuine spawn failure`);
      return false;
    }
    if (elapsed > 0 && elapsed % 3 === 0) {
      try {
        const cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, { encoding: 'utf-8' });
        fs.writeFileSync(`${captureDir}/poll-${elapsed}s.txt`, cap);
      } catch {}
    }
    // Non-blocking poll interval — yields the loop. (2026-06-07 ready-poll note
    // above applies here too — /2/80.)
    await sleep(1000);
  }
}

/**
 * Maximum wake attempts per queued walkie before escalating to Rooster.
 * When wake_attempts on a queue item reaches MAX_WAKE_ATTEMPTS, we walkie
 * holler-rooster (type=action) with trigger=wake_failure_hard and mark the
 * original item status=failed.
 */
const MAX_WAKE_ATTEMPTS = 3;

/**
 * Set of in-flight wake operations keyed by sessionName. Prevents two
 * concurrent wake attempts for the same target — if a tick fires async wake
 * for X and the next tick (5-10s later) sees X still cold, we must NOT fire
 * a second wakeFreshSpawn for X while the first is still running. The
 * Set is cleared in the .finally() of the async wake.
 */
const inFlightWakes = new Set();

/**
 * Async wrapper around wakeFreshSpawn. Schedules the synchronous body on the
 * next event-loop turn via setImmediate so the dispatch tick returns
 * immediately. On success: nothing more to do — original walkie stays pending,
 * next tick delivers normally. On failure: increments item.wake_attempts; on
 * the 3rd failure, walkies holler-rooster with wake_failure_hard and marks the
 * item status=failed.
 *
 * The item argument is a reference into the in-memory queue snapshot; mutating
 * its fields here is safe because the dispatcher tick re-reads + re-writes the
 * queue every cycle and our writes survive via writeQueue() at the next tick.
 * (We also call writeQueue() ourselves after a failure to persist the
 * wake_attempts increment + status change immediately — otherwise a
 * server-restart between wake-failure and the next tick would lose the
 * counter.)
 */
function scheduleAsyncWake(sessionName, sessionDir, item) {
  if (inFlightWakes.has(sessionName)) {
    console.log(`[QueueDispatcher] [scheduleAsyncWake] ${sessionName}: already in-flight, skipping`);
    return;
  }
  inFlightWakes.add(sessionName);

  setImmediate(() => {
    Promise.resolve()
      .then(() => wakeFreshSpawn(sessionName, sessionDir))
      .then((woken) => {
        if (woken) {
          console.log(`[QueueDispatcher] [scheduleAsyncWake] ${sessionName}: woken; original walkie stays pending for next tick`);
          return;
        }
        // Wake failed (returned false). Bump the queue item's wake_attempts
        // and decide whether to escalate.
        return handleWakeFailure(sessionName, item, 'wakeFreshSpawn returned false');
      })
      .catch((err) => {
        console.error(`[QueueDispatcher] [scheduleAsyncWake] ${sessionName} (item ${item.id}): wakeFreshSpawn threw:`, err.message);
        return handleWakeFailure(sessionName, item, `threw: ${err.message}`);
      })
      .finally(() => {
        inFlightWakes.delete(sessionName);
      });
  });
}

/**
 * Async wrapper around resumeComputeSuspend (compute-suspend resume path).
 * Reuses the same inFlightWakes lock as scheduleAsyncWake so a compute-resume
 * and a fresh-wake can't race the same target.
 *
 * Handles resumeComputeSuspend's TRI-STATE outcome (2026-07-30):
 *   'ready' — nothing to do; marker deleted, session live, walkie pending.
 *   'alive' — NON-DESTRUCTIVE: claude is up but not detected-ready yet. Leave
 *             the session alone, keep the marker, let the next tick retry. The
 *             pending walkie is untouched. Memory is NEVER wiped on a timeout.
 *   'dead'  — resume is genuinely impossible (no live conversation to lose):
 *             DEGRADE to wakeFreshSpawn (memory-destructive, but nothing to
 *             preserve). We DELETE the marker before degrading so the next tick
 *             doesn't loop back into a failing resume. Logged loudly.
 *   'wake_failure' — the 'alive' branch exhausted its bound (permanent post-resume
 *             hang). Route to handleWakeFailure (wake_attempts++ → 3-strike
 *             wake_failure_hard alarm). NON-destructive: marker kept, no wipe.
 */
function scheduleAsyncComputeResume(sessionName, sessionDir, markerPath, item) {
  if (inFlightWakes.has(sessionName)) {
    console.log(`[QueueDispatcher] [scheduleAsyncComputeResume] ${sessionName}: already in-flight, skipping`);
    return;
  }
  inFlightWakes.add(sessionName);

  setImmediate(() => {
    Promise.resolve()
      .then(() => resumeComputeSuspend(sessionName, markerPath))
      .then((outcome) => {
        // resumeComputeSuspend now returns a TRI-STATE string (2026-07-30):
        //   'ready' — resume reached the ready footer; session is live, memory
        //             intact. Marker already deleted. Original walkie stays
        //             pending; next tick delivers.
        //   'alive' — timed out detecting the footer BUT claude is still running
        //             in the pane (slow transcript load / footer we didn't match)
        //             OR a transient send-keys error. Memory is INTACT. We must
        //             NOT wipe. Leave the session alone, keep the marker, and let
        //             the next dispatcher tick re-enter this path — by then it's
        //             usually ready, and if it is, 'ready' cleans up the marker.
        //   'dead'  — resume is genuinely impossible (no marker/session_id, tmux
        //             gone). There is no live conversation to preserve, so a
        //             memory-destructive fresh-spawn is the correct degrade.
        if (outcome === 'ready') {
          console.log(`[QueueDispatcher] [scheduleAsyncComputeResume] ${sessionName}: resumed; original walkie stays pending for next tick`);
          return;
        }
        if (outcome === 'alive') {
          // NON-DESTRUCTIVE: claude is up, just not detected-ready yet. Do NOT
          // fresh-spawn. Keep the marker so the next tick retries the resume.
          // The pending walkie is untouched and will deliver once ready.
          console.log(`[QueueDispatcher] [scheduleAsyncComputeResume] ${sessionName}: resume not-yet-ready but claude ALIVE — leaving session (memory intact), next tick retries. NO wipe.`);
          return;
        }
        if (outcome === 'wake_failure') {
          // 'alive' branch exhausted its bound (2026-08-09): claude launched but
          // has permanently hung post-resume (alive, never-ready). Memory is
          // POTENTIALLY intact, so we must NOT silently fresh-spawn (wipe). Route
          // to handleWakeFailure — it increments wake_attempts and, on the 3rd
          // strike, fires the wake_failure_hard alarm to holler-rooster (human in
          // the loop). Marker is intentionally KEPT (resumeComputeSuspend did not
          // unlink it) so nothing is destroyed while Rooster/Josh decide.
          console.error(`[QueueDispatcher] [scheduleAsyncComputeResume] ${sessionName}: resume alive-but-never-ready bound EXHAUSTED — escalating via handleWakeFailure (NO wipe)`);
          return handleWakeFailure(sessionName, item, 'compute-resume alive-but-never-ready: permanent post-resume hang (bound exhausted)');
        }
        if (outcome === 'blocked-deleted-cwd') {
          // The session's directory was removed while it was suspended. claude
          // cannot start in a deleted cwd, so BOTH resume and fresh-spawn would
          // fail — and fresh-spawn is memory-destructive besides. The marker was
          // deliberately KEPT so restoring the directory makes this session
          // resumable again; unlinking it here would destroy the only record of
          // its session_id and make the transcript unrecoverable. Escalate to a
          // human instead of degrading. The pending walkie stays queued.
          console.error(`[QueueDispatcher] [scheduleAsyncComputeResume] ${sessionName}: resume BLOCKED — session_dir deleted while suspended. Marker KEPT (transcript still recoverable if the directory is restored). NO wipe, NO fresh-spawn.`);
          return handleWakeFailure(sessionName, item, 'compute-resume blocked: session_dir deleted while suspended — restore the directory to make this session resumable, do NOT fresh-spawn');
        }
        // outcome === 'dead' (or any unexpected value) — genuinely can't resume.
        // Degrade to fresh-spawn (memory-destructive, but nothing live to lose).
        console.error(`[QueueDispatcher] [scheduleAsyncComputeResume] ${sessionName}: resume DEAD (unrecoverable) — degrading to fresh-spawn wake`);
        try { fs.unlinkSync(markerPath); } catch {}
        // wakeFreshSpawn is ASYNC (returns Promise<boolean>) since 2026-07-29 —
        // its internal delays are non-blocking. Await it (returning the promise
        // from this .then() callback chains it correctly), then act on the boolean.
        return wakeFreshSpawn(sessionName, sessionDir).then((woken) => {
          if (!woken) return handleWakeFailure(sessionName, item, 'compute-resume dead AND fresh-spawn fallback failed');
        });
      })
      .catch((err) => {
        console.error(`[QueueDispatcher] [scheduleAsyncComputeResume] ${sessionName} (item ${item.id}): resume threw:`, err.message);
        try { fs.unlinkSync(markerPath); } catch {}
        return handleWakeFailure(sessionName, item, `compute-resume threw: ${err.message}`);
      })
      .finally(() => {
        inFlightWakes.delete(sessionName);
      });
  });
}

/**
 * Persist a wake-failure on the original queue item and, on the 3rd failure,
 * walkie holler-rooster + mark the item failed. Reads + rewrites the queue
 * file directly so the counter survives even if the dispatcher restarts
 * between failures.
 */
// ASYNC (event-loop wedge fix): routed through the serialized mutateQueue() lock
// like every other queue mutation, so the wake-attempt bookkeeping can't race an
// in-flight confirm/enqueue. Called from async wake .catch() chains; returns a
// Promise. The re-read inside the lock is authoritative (`live` is looked up on
// the fresh queue), so the counter is correct even under concurrency.
async function handleWakeFailure(sessionName, item, reason) {
  try {
    await mutateQueue(queue => {
      const live = queue.find((q) => q.id === item.id);
      if (!live) return NO_CHANGE; // Item already removed/archived; nothing to do.

      live.wake_attempts = (live.wake_attempts || 0) + 1;
      live.last_wake_error = reason;
      live.last_wake_failed_at = new Date().toISOString();

      if (live.wake_attempts >= MAX_WAKE_ATTEMPTS) {
        console.error(`[QueueDispatcher] [handleWakeFailure] ${sessionName} (item ${item.id}): hard-failure after ${live.wake_attempts} attempts (${reason}) — escalating to holler-rooster`);

        // Walkie holler-rooster with the hard-failure trigger. Append directly
        // to the queue (same file we're already writing). resolveTarget is not
        // strictly needed since "holler-rooster" is the canonical session name.
        const escalation = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          target_session: 'holler-rooster',
          type: 'action',
          message: JSON.stringify({
            trigger: 'wake_failure_hard',
            target: sessionName,
            attempts: live.wake_attempts,
            last_error: reason,
            original_item_id: item.id,
            original_target_session: item.target_session,
            escalated_at: new Date().toISOString(),
          }),
          status: 'pending',
          created_at: new Date().toISOString(),
          source: 'wake_failure_escalation',
        };
        queue.push(escalation);

        live.status = 'failed';
        live.failed_at = new Date().toISOString();
        live.error = `Wake failed after ${live.wake_attempts} attempts: ${reason}`;
      } else {
        console.log(`[QueueDispatcher] [handleWakeFailure] ${sessionName} (item ${item.id}): attempt ${live.wake_attempts}/${MAX_WAKE_ATTEMPTS} failed (${reason}); will retry on next tick (item stays pending)`);
      }
      return queue;
    });
  } catch (e) {
    console.error(`[QueueDispatcher] [handleWakeFailure] ${sessionName}: bookkeeping failed:`, e.message);
  }
}

/**
 * Check if a tmux session exists
 */
function sessionExists(sessionName) {
  try {
    // '=' prefix forces tmux exact-name match. Without it, tmux prefix-matches
    // and a cold target like "holler-givegrove--foreman" silently resolves to
    // a live descendant like "holler-givegrove--foreman--voting-1444" — the
    // dispatcher then skips startSession() and pastes into the wrong inbox.
    execSync(`tmux has-session -t "=${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a working directory for a steward session.
 *
 * Session names like holler-{steward}--{worktree} map to a worktree path
 * found in ~/.homestead/stewards/{steward}/builder.json.
 *
 * Returns the worktree directory path, or null if not found.
 */
function resolveStewartWorktreeDir(stewardName, worktreeName) {
  const buildDataPath = join(STEWARDS_DIR, stewardName, 'builder.json');
  if (!existsSync(buildDataPath)) return null;

  try {
    const data = JSON.parse(readFileSync(buildDataPath, 'utf-8'));
    // Match by basename (worktree may be a full path or just a name)
    const build = (data.builds || []).find(b => {
      const bName = b.worktree ? b.worktree.toString().split('/').filter(Boolean).pop() : '';
      return bName === worktreeName || b.worktree === worktreeName;
    });
    if (!build) return null;

    // If worktree is already an absolute path, use it directly
    if (build.worktree && build.worktree.startsWith('/') && existsSync(build.worktree)) {
      return build.worktree;
    }

    // Worktree dir: ~/.worktrees/{project}/{worktreeName}
    const worktreeDir = join(os.homedir(), '.worktrees', data.project || stewardName, worktreeName);
    if (existsSync(worktreeDir)) return worktreeDir;

    // Fallback: check the codeDir from builder.json
    if (data.worktreeDir) {
      const resolved = data.worktreeDir.replace(/^~/, os.homedir());
      const withName = join(resolved, worktreeName);
      if (existsSync(withName)) return withName;
    }

    return null;
  } catch (e) {
    console.log(`[QueueDispatcher] Could not resolve steward worktree for ${stewardName}/${worktreeName}: ${e.message}`);
    return null;
  }
}

/**
 * Resolve a steward session name to its on-disk directory (the wake/spawn cwd).
 *
 * PREFERRED: ask the steward-resolver, which already scans BOTH substewards/
 * AND workers/ and returns the real directory. The fleet is re-homing
 * conversational workers to <parent>/workers/, so a workers/-homed session's
 * true dir is stewards/<parent>/workers/<name> — NOT the '/substewards/'
 * reconstruction below. Without this, a resolved reply to a workers/-homed
 * session spawns in the wrong (non-existent) dir and delivery fails.
 *
 * FALLBACK: the legacy structural rule — replace '--' with '/substewards/' and
 * prepend the stewards dir. Used only when the resolver has no directory for
 * this name (e.g. a bare tmux-session with directory:null, or a name the
 * resolver doesn't know). Additive: existing substewards/-homed sessions that
 * the resolver already returns resolve identically to before.
 *   Example fallback: holler-venture--marketing--seo → stewards/venture/substewards/marketing/substewards/seo
 */
function resolveSessionDir(sessionName) {
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
  return join(STEWARDS_DIR, relPath);
}

/**
 * Check if a session is ready to receive a message.
 *
 * Simple: if session status is "waiting", it's ready. Period.
 * The session-status API is the single source of truth — it already polls
 * all sessions and tracks working/waiting state reliably.
 *
 * If the status API is unavailable, falls back to checking the activity file.
 */
function isSessionReady(sessionName) {
  if (!sessionExists(sessionName)) {
    console.log(`[QueueDispatcher] ${sessionName}: not ready (session does not exist)`);
    return false;
  }

  try {
    // Read the activity file directly — same source of truth as /api/session-status.
    // If is_working is false (or file doesn't exist), session is waiting = ready.
    const activityFile = join(os.tmpdir(), `claude-session-${sessionName}-activity.json`);
    if (existsSync(activityFile)) {
      const activity = JSON.parse(readFileSync(activityFile, 'utf-8'));
      if (activity.is_working) {
        // Activity file says working — the stuck-state file MAY override with an
        // "idle" reading (the stuck checker runs ~every minute and captures the
        // actual screen). But that file refreshes only ~60s, so a session that
        // started working <60s ago can still read "idle" there → paste lands
        // mid-tool-call → scramble (paste-race hole #2). TIGHTENED (2026-07-29):
        // the stuck-state "idle" override is no longer trusted on its own — it is
        // only honored when (a) the reading is FRESH (<= STUCK_STATE_MAX_AGE_MS,
        // when the file carries a timestamp) AND (b) a LIVE capture-pane probe
        // right now ALSO shows idle. This makes the override require live proof,
        // so a 60s-stale "idle" can never by itself green-light a paste.
        try {
          const stuckStateFile = join(process.cwd(), 'data', 'session-stuck-state.json');
          if (existsSync(stuckStateFile)) {
            const stuckState = JSON.parse(readFileSync(stuckStateFile, 'utf-8'));
            const sessionState = stuckState.sessions?.[sessionName];
            if (sessionState?.state === 'idle') {
              // Reject a stale reading if the file/entry exposes a timestamp.
              const tsRaw = sessionState.updatedAt || sessionState.updated_at ||
                            sessionState.checkedAt || sessionState.timestamp ||
                            stuckState.updatedAt || stuckState.updated_at || null;
              const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
              const fresh = Number.isNaN(ts) ? true : (Date.now() - ts) <= STUCK_STATE_MAX_AGE_MS;
              if (fresh && capturePaneIdle(sessionName)) {
                console.log(`[QueueDispatcher] ${sessionName}: READY (live capture-pane confirms idle at prompt, overriding stale activity file)`);
                return true;
              }
              console.log(`[QueueDispatcher] ${sessionName}: stuck-state says idle but ${!fresh ? 'reading is stale' : 'live capture shows busy'} — NOT overriding`);
            }
          }
        } catch {}

        console.log(`[QueueDispatcher] ${sessionName}: not ready (working, tool=${activity.current_tool || 'unknown'})`);
        return false;
      }
      console.log(`[QueueDispatcher] ${sessionName}: READY (waiting)`);
      return true;
    }

    // No activity file = session hasn't reported status yet.
    // Default to waiting (same as the session-status API does).
    console.log(`[QueueDispatcher] ${sessionName}: READY (no activity file, assuming waiting)`);
    return true;
  } catch (e) {
    console.log(`[QueueDispatcher] ${sessionName}: not ready (error: ${e.message})`);
    return false;
  }
}

/**
 * Check if claude process exists in session but isn't running
 * (session alive, but claude exited — needs restart)
 *
 * Two correctness wrinkles this fn must handle (both surfaced 2026-04-29 by
 * the Patch Kill-Respawn v3 Worker after Watchdog observed input-poisoning):
 *
 *   1. RESPAWN-IN-PROGRESS LOCK. When `kill-and-respawn.sh` is in flight on
 *      a pane, it writes /tmp/kill-and-respawn-active-${SESSION}.flag before
 *      `tmux respawn-pane -k` fires. The wrapper script deletes the flag
 *      once fresh Claude has shown the bypass-permissions-on signal. While
 *      the flag is fresh (<60s), this fn MUST return false — otherwise the
 *      dispatcher fires restartClaude() during the boot window and pollutes
 *      the new pane's input buffer with literal `claude --foo` cmdline text
 *      (tmux send-keys treats them as keystrokes). See
 *      lessons.v2_paste_mechanism_bug_5_2026_04_29.
 *
 *   2. DUAL PANE SHAPE. The historic detection used
 *      `pgrep -P PANE_PID -f claude` which has TWO bugs on macOS:
 *        (a) `pgrep -P -f` quirk — empty result on real PPID match. See
 *            lessons.macos_pgrep_dash_p_dash_f_quirk_2026_04_28.
 *        (b) Misses the post-v2-respawn shape entirely: when the wrapper
 *            execs into claude, PANE_PID == claude itself (no shell
 *            intermediate, no children-walk hits). See
 *            lessons.post_respawn_claude_direct_pane_shape_2026_04_29.
 *      The replacement uses ps-walk in two stages: (1) is PANE_PID itself
 *      claude? (post-v2 shape) (2) is any direct child of PANE_PID claude?
 *      (legacy shell+claude shape). Mirrors kill-and-respawn.sh's CLAUDE_PID
 *      lookup so the two stay in sync.
 */
/**
 * isSessionWorking — true iff the session exists AND its activity file says
 * is_working. Used by the idle check-in timer's seen_working latch. This is a
 * deliberately SIMPLE read of the same activity file isSessionReady() consults;
 * it does NOT do the capture-pane override dance (the latch only needs to know
 * "have we ever seen this worker actively working", so a plain is_working read is
 * the right, cheap signal). Missing activity file / not-yet-reported → false.
 */
function isSessionWorking(sessionName) {
  try {
    if (!sessionExists(sessionName)) return false;
    const activityFile = join(os.tmpdir(), `claude-session-${sessionName}-activity.json`);
    if (!existsSync(activityFile)) return false;
    const activity = JSON.parse(readFileSync(activityFile, 'utf-8'));
    return !!activity.is_working;
  } catch {
    return false;
  }
}

const KILL_AND_RESPAWN_LOCK_TTL_MS = 60_000;

function isRespawnInProgress(sessionName) {
  const lockPath = `/tmp/kill-and-respawn-active-${sessionName}.flag`;
  try {
    const stat = require('fs').statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < KILL_AND_RESPAWN_LOCK_TTL_MS) return true;
    // Stale lock (>60s) — orphaned by a wrapper that never cleared it
    // (e.g. respawn_failed). Reap it so we don't block restart forever.
    try { require('fs').unlinkSync(lockPath); } catch {}
    return false;
  } catch {
    return false; // No lock file
  }
}

function needsClaudeRestart(sessionName) {
  if (!sessionExists(sessionName)) return false;

  // Wrinkle #1: kill-and-respawn.sh is in flight on this pane. Skip restart
  // attempts until the wrapper clears the lock (or 60s passes — stale-lock
  // safety reap inside isRespawnInProgress).
  if (isRespawnInProgress(sessionName)) {
    console.log(`[QueueDispatcher] ${sessionName}: respawn-in-progress lock held, skipping restart check`);
    return false;
  }

  try {
    const panePid = execSync(
      `tmux list-panes -t "=${sessionName}" -F '#{pane_pid}' 2>/dev/null | head -1`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    if (!panePid) return false;

    // Wrinkle #2 stage (a): is PANE_PID itself the claude binary?
    // Post-v2 respawn shape — wrapper execs into claude; pane process IS claude.
    // `comm=` returns basename only — `command=` would false-match `zsh -c '...claude...'`.
    try {
      const paneComm = execSync(
        `ps -p ${panePid} -o comm= 2>/dev/null | head -1`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim();
      const paneBasename = paneComm.split('/').pop();
      if (paneBasename === 'claude') return false; // Claude is alive (post-v2 shape)
    } catch {
      // Fall through to the children-walk
    }

    // Wrinkle #2 stage (b): direct PPID-child whose command contains 'claude'.
    // Legacy shell+claude shape. Walk via `ps -ef | awk` not `pgrep -P -f`
    // to dodge the macOS quirk.
    try {
      const childrenLines = execSync(
        `ps -eo pid=,ppid=,command= | awk -v ppid=${panePid} '$2 == ppid'`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim();
      if (childrenLines) {
        for (const line of childrenLines.split('\n')) {
          // Crude grep for 'claude' in the command column — ps -eo command
          // returns the full argv. Matches both the binary path and any
          // `--add-dir` / `-c` arg containing 'claude'. False positives are
          // benign here: if a child has 'claude' in its argv, treating the
          // pane as alive is the safe direction (won't incorrectly fire restart).
          if (/claude/i.test(line)) return false;
        }
      }
    } catch {
      // Fall through to "needs restart"
    }

    return true; // No claude process found in either shape — needs restart
  } catch {
    return false;
  }
}

// Non-blocking sleep helper (event-loop starvation fix, 2026-07-29). Replaces
// `execSync('sleep N')`, which shells out and BLOCKS the Node thread for the full
// duration. A wide broadcast fan-out serialized N of these blocking sleeps inside
// one dispatch tick → the event loop was starved → Express couldn't service the
// inbound /api/queue/confirm POSTs → roger-thats timed out (http 000) → items
// never confirmed → the retry loop redelivered forever → :3005 wedge. setTimeout
// makes the render delay ELAPSE (tmux paste still needs to finish rendering before
// Enter) WITHOUT pinning the thread, so HTTP stays responsive throughout the fan-out.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Submit the pane's current input box (belt-and-suspenders, 2026-07-30).
 *
 * ROOT CAUSE (verified live by Rooster + holler-code, reproduced on a real pane):
 * the current Claude Code TUI does NOT reliably honor `tmux send-keys Enter` /
 * C-m as submit — the keystroke lands but the turn never commits, so pasted text
 * parks in the input box unsent. The pane's numeric-keypad Enter (`KPEnter`) DOES
 * submit. It's intermittent (plain Enter works sometimes), so we fire BOTH: plain
 * Enter first (keeps working where it works, and is the correct newline-run for a
 * raw zsh pane in the compute-resume path), then KPEnter to cover the TUI cases
 * where plain Enter silently no-ops. Submitting an already-empty box a second time
 * is harmless (no-op), so the superset never double-submits real content.
 *
 * Single choke point every dispatcher submit routes through — the fix lands once
 * and covers all paths (compute-resume, wake-bootstrap, sendMessage, mid-stream
 * injectNow).
 */
function submitPane(sessionName) {
  execSync(`tmux send-keys -t "=${sessionName}:" Enter`);
  execSync(`tmux send-keys -t "=${sessionName}:" KPEnter`);
}

/**
 * Paste a loaded tmux buffer into a Claude pane using BRACKETED PASTE (-p).
 *
 * WALKIE HEAD-TRUNCATION FIX (2026-08-29). Large walkie payloads (~900B+) were
 * arriving at the target with their LEADING bytes GONE — only the tail survived.
 * Alfred flagged 3 samples with the identical signature "tail survives, head cut";
 * the full payload was always INTACT in ~/.homestead/queue.json and the dispatcher
 * logged "Message sent" + "Confirmed", so the loss was strictly in the PASTE layer.
 *
 * ROOT CAUSE (reproduced live, not inferred): plain `paste-buffer` (no -p) streams
 * the buffer to the pane as RAW KEYSTROKES. Claude Code's TUI applies a
 * paste-detection heuristic to raw input bursts, and on a large burst it collapses
 * the burst and keeps only the trailing fragment. A 2050-byte payload landed in the
 * box as literally 6 characters (`LOAD"}` — the tail of `..._PAYLOAD"}`), and the
 * receiving Claude confirmed it saw only that fragment.
 *
 * IT IS NOT AN IDLE/BUSY PROBLEM. The same payload truncated IDENTICALLY when
 * pasted into a fully IDLE pane, so gating delivery on pane-idle does NOT fix it
 * (and would re-introduce the ghost-placeholder drop bug: an idle pane displaying
 * the `❯ Try "…"` placeholder reads as a non-empty input box, which is still live
 * on the fleet today — verified on holler-mcgucket).
 *
 * THE FIX: `-p` wraps the payload in the bracketed-paste escapes
 * (ESC[200~ … ESC[201~), so the TUI treats it as ONE atomic paste block instead of
 * a keystroke burst. Verified: the same 2KB payload lands complete head-to-tail,
 * both MID-RENDER and idle, with the receiving Claude echoing both markers.
 *
 * Small payloads still render as literal text in the box, so the tracked-box
 * safety net (paneInputBoxEmpty) keeps working unchanged.
 */
function pasteBufferToPane(bufferName, sessionName) {
  execSync(`tmux paste-buffer -p -b "${bufferName}" -t "=${sessionName}:" -d`);
}

// Tracked-box safety-net tunables (2026-07-30). After a serialized delivery's
// submit, re-check the input box and re-fire up to SUBMIT_RETRY_MAX times, waiting
// SUBMIT_RECHECK_MS between tries for the TUI to render the empty box, before
// escalating.
const SUBMIT_RETRY_MAX = 3;
const SUBMIT_RECHECK_MS = 700;

// ---------------------------------------------------------------------------
// LOST-KICKOFF-ON-SPAWN FIX (2026-08-31).
//
// SYMPTOM: a freshly-spawned worker ends up alive-but-idle at a bare prompt with
// NO task — the Claude banner rendered, the worktree path is right, the footer
// reads "bypass permissions on", and the box is empty. It looks perfectly
// healthy and it never got its objective. Surfaced as walkie_submit_stuck;
// recovered by hand TWICE on 2026-08-31.
//
// THE RACE (reproduced live, not inferred). spawn-substeward.sh creates the tmux
// session and returns immediately; the spawning steward then walkies the
// objective, which the dispatcher delivers on its next tick. But the dispatcher's
// only gate is ALIVE (sessionExists + claude-process-present). A brand-new pane
// satisfies both WELL BEFORE the Claude TUI is accepting pasted input — measured
// boot-to-ready on this machine is ~5s, and the tick can fire at T+1s. Pasting
// into that window puts the payload in the box but the Enter+KPEnter never
// registers; the payload sits there UNSUBMITTED forever. Verified end-to-end:
// paste at T+2s left a 2-line JSON kickoff parked in the box, still unsubmitted
// at T+25s, marker never touched — and a single late Enter re-fire (once the pane
// had settled) submitted it cleanly and the worker started its task.
//
// WHY THE EXISTING SAFETY NET MISSES IT. injectNow's tracked-box retry loop is
// tuned for a transient render race on an ALREADY-RUNNING pane: 3 re-fires at
// 700ms = a ~2.1s window. A pane that needs ~5s to finish booting outlives that
// window entirely, so the loop exhausts, the item is marked 'failed', and the
// kickoff is DROPPED — the worker is stranded with no task. wakeFreshSpawn()
// already solves this for the WAKE path (ready-poll + verify loop + deadman);
// the spawn-tool kickoff path had no equivalent.
//
// THE FIX, in three parts:
//   1. FRESH-PANE DETECTION — tmux's own `session_created` timestamp. Ambient, so
//      it needs no cooperation from the spawn script and covers every spawner.
//   2. PASTE-READY GATE (fresh panes only) — before pasting, poll until the pane
//      is genuinely ready: footer present AND box placeholder-empty AND stable
//      across two consecutive samples. This is NOT the old idle-gate: it applies
//      ONLY inside the fresh-spawn window and is about the TUI existing at all,
//      not about the target being un-busy. See the constraint note below.
//   3. NO-DROP SEMANTICS — if a fresh pane never becomes ready, or the submit
//      never verifies, leave the item PENDING so a later tick redelivers, rather
//      than burning it to 'failed'. Mirrors wakeFreshSpawn's "two-tick, self-
//      correcting" contract.
//
// ⚠️ CONSTRAINT — DO NOT GENERALISE THIS INTO THE OLD IDLE GATE. The idle gate
// removed on 2026-07-29 blocked delivery to any BUSY pane, fleet-wide and
// forever. This gate fires ONLY within FRESH_SPAWN_WINDOW_MS of session creation,
// waits at most FRESH_PASTE_READY_TIMEOUT_MS, and is about "has the TUI finished
// booting", never "is the target idle". Mid-stream inject into a busy pane is
// unchanged and still immediate. Bracketed paste (pasteBufferToPane) is likewise
// untouched — this gate changes WHEN we paste on a virgin pane, never HOW.
// ---------------------------------------------------------------------------

// How long after tmux session creation a pane still counts as "fresh". Must
// comfortably EXCEED FRESH_PASTE_READY_TIMEOUT_MS so that an item deferred by a
// gate timeout is still recognised as fresh on the next tick (and so keeps the
// no-drop semantics) instead of aging out into the established-pane path mid-boot.
// Generous vs. the measured boot: a false positive costs only the cheap,
// fast-exiting paste-ready probe on an already-ready pane.
const FRESH_SPAWN_WINDOW_MS = 5 * 60_000;
// Max wall time the fresh-pane paste-ready gate will wait before giving up and
// leaving the item pending for a later tick. Sized against measured boot-to-ready
// (~4s idle, ~10.5s with several panes coming up at once, plus the project-store
// `connecting…` phase on top) with generous headroom for a loaded machine.
// Overshooting is cheap: the gate exits the instant the pane is ready, and a
// timeout merely DEFERS to the next tick rather than dropping anything.
const FRESH_PASTE_READY_TIMEOUT_MS = 60_000;
const FRESH_PASTE_READY_POLL_MS = 750;
// On a fresh pane, give the submit far longer to verify than the 3x700ms tuned
// for an already-running pane — the TUI can still be settling as we submit.
const FRESH_SUBMIT_RETRY_MAX = 8;

/**
 * Age in ms of the tmux session (time since `session_created`), or null if it
 * can't be determined. Used to decide whether a target is a FRESH spawn.
 */
function sessionAgeMs(sessionName) {
  try {
    // NB the ':' suffix on the target — `-t "=name"` (no colon) returns EMPTY from
    // display-message, while `-t "=name:"` resolves correctly. Same convention as
    // every other tmux target in this file; dropping the colon silently disabled
    // the whole fresh-spawn gate (caught in live testing 2026-08-31).
    const out = execSync(
      `tmux display-message -p -t "=${sessionName}:" '#{session_created}' 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    if (!out) return null;
    const created = parseInt(out, 10);
    if (!Number.isFinite(created) || created <= 0) return null;
    return Date.now() - created * 1000;
  } catch {
    return null;
  }
}

/**
 * Is this target a freshly-created pane (within FRESH_SPAWN_WINDOW_MS)?
 * Unknown age → false (treat as an established pane; preserves existing
 * behaviour rather than gating deliveries we previously sent straight through).
 */
function isFreshSpawn(sessionName) {
  // A just-RESUMED pane is every bit as "fresh" as a just-spawned one: its TUI
  // is still drawing and a paste can land in the shell instead of the input box.
  // tmux session age cannot see this (a resume reuses the session), so consult
  // the resume stamp written by resumeComputeSuspend as well. Same window.
  //
  // ⚠️ A SECOND CALLER DEPENDS ON THIS AND ITS COMMENT DOES NOT SAY SO — writing
  // it down here because the dependency was found by audit, not by design
  // (2026-09-06). injectNow's stuck-submit escalation is gated
  // `if (!submitted && fresh) -> defer`, and escalateStuckSubmit itself has NO
  // liveness check: its guards are loop-edge, still-pending and throttle, none of
  // which asks whether the target is alive, suspended or mid-resume. A merely
  // RESUMING session therefore looks identical to one that will not accept a
  // submit, and would raise a false walkie_submit_stuck — an alert type Rooster
  // acts on. It does not today ONLY because this function reports a resumed pane
  // as fresh, so that path defers instead of escalating.
  // CONSEQUENCE: if FRESH_SPAWN_WINDOW_MS shrinks, if a resume ever exceeds it,
  // or if freshness stops consulting the resume stamp, the escalation path
  // silently re-opens and presents as a burst of false stuck alerts. Nothing in
  // injectNow or escalateStuckSubmit would flag it. Change this function with
  // that caller in mind, not just the paste-targeting one it was written for.
  try {
    const stampPath = `/tmp/claude-session-${sessionName}-resumed-at`;
    if (existsSync(stampPath)) {
      const t = parseInt(readFileSync(stampPath, 'utf-8').trim(), 10);
      if (Number.isFinite(t)) {
        const since = Date.now() - t;
        if (since >= 0 && since < FRESH_SPAWN_WINDOW_MS) return true;
      }
    }
  } catch {}

  const age = sessionAgeMs(sessionName);
  if (age === null) return false;
  return age >= 0 && age < FRESH_SPAWN_WINDOW_MS;
}

/**
 * THE SILENT-DROP PHASE — why the footer alone is NOT enough (measured 2026-08-31).
 *
 * The obvious readiness signal is the 'bypass permissions on' footer, and that IS
 * what wakeFreshSpawn polls for. But a delay sweep showed a payload submitted at
 * footer+0s, +1s, +2s and +3s is ACCEPTED AND SILENTLY DISCARDED: the input box
 * clears (so every box-based check reports a clean submit) and yet no turn ever
 * starts — no transcript entry, no tool call, nothing. That is EXACTLY the
 * lost-kickoff zombie: a pane that looks perfectly healthy and never got its task.
 * It is strictly worse than the parked-box failure, because the box-empty check
 * actively reports SUCCESS.
 *
 * The discriminator is the footer's own status indicator: while Claude is still
 * bringing up its project/memory store the footer carries `connecting…`. The
 * bundle spells the consequence out in as many words — "The project memory store
 * is still connecting; try again in a moment." Input submitted in that phase is
 * refused. Once `connecting…` clears, the same payload lands and the worker runs
 * its task.
 *
 * So the gate waits for the footer AND for `connecting…` to be GONE. We match the
 * bare word 'connecting' (not the ellipsis glyph) so a plain-ASCII rendering of
 * the same indicator can't slip past.
 *
 * NOT a timing constant, deliberately: observed boot-to-footer ranged from ~4s on
 * an idle machine to ~10.5s with several panes coming up at once, so any fixed
 * sleep would be both too slow normally and too fast under load. This waits on the
 * actual state.
 */
const PANE_CONNECTING_RE = /connecting/i;

/**
 * Wait until a freshly-spawned pane is genuinely PASTE-READY.
 *
 * Ready means, on two CONSECUTIVE samples (so we never act on a half-drawn frame
 * mid-render):
 *   - the Claude footer is present ('bypass permissions on') — the TUI exists and
 *     has finished its initial draw, AND
 *   - the footer is NOT showing `connecting…` — the project/memory store is up, so
 *     a submit will be accepted rather than silently discarded (see the note
 *     above; this is the condition that actually fixes the zombie), AND
 *   - the input box is empty-or-placeholder (see boxContentIsEmpty) — nothing is
 *     already parked in it that our paste would concatenate onto.
 *
 * Deliberately does NOT require the pane to be un-busy: a fresh worker can start
 * doing something on its own, and mid-stream inject into a busy-but-booted pane is
 * the intended, supported behaviour. We are only waiting for the TUI to be up.
 *
 * Returns true once ready; false on timeout (caller must NOT drop the item).
 */
async function waitForFreshPanePasteReady(sessionName) {
  const deadline = Date.now() + FRESH_PASTE_READY_TIMEOUT_MS;
  let consecutive = 0;
  let logged = false;
  while (Date.now() < deadline) {
    let cap = '';
    try {
      cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, {
        encoding: 'utf-8',
        timeout: 3000,
      });
    } catch {
      cap = '';
    }
    const footer = !!cap && cap.includes('bypass permissions on');
    // Only the footer line carries the connecting indicator — scope the check to
    // it so the word appearing in scrollback (e.g. a transcript mentioning it)
    // can't hold the gate shut forever.
    const footerLine = footer
      ? (cap.split('\n').find(l => l.includes('bypass permissions on')) || '')
      : '';
    const connecting = PANE_CONNECTING_RE.test(footerLine);
    const boxOk = footer && boxContentIsEmpty(readPaneInputBox(cap));
    if (footer && !connecting && boxOk) {
      consecutive++;
      // Two consecutive good samples ⇒ the frame is stable, not mid-render.
      if (consecutive >= 2) return true;
    } else {
      if (!logged) {
        console.log(`[QueueDispatcher] ${sessionName}: fresh pane not paste-ready yet (footer=${footer} connecting=${connecting}) — waiting before kickoff paste`);
        logged = true;
      }
      consecutive = 0;
    }
    await sleep(FRESH_PASTE_READY_POLL_MS);
  }
  return false;
}

/**
 * SHARED submit-verification. Confirm a just-pasted payload actually left the
 * input box; re-fire Enter+KPEnter up to `maxAttempts` times if it is still
 * parked. Factored out (2026-08-31) so the delivery path (injectNow) and the wake
 * bootstrap (wakeFreshSpawn) use IDENTICAL semantics — previously each carried its
 * own copy and only the wake path had a long-enough window for a settling pane.
 *
 * Idempotent: re-submitting an already-empty box is a no-op, so an extra re-fire
 * can never double-submit real content.
 *
 * Returns true iff the box was observed empty (payload committed).
 */
async function verifySubmitted(sessionName, { maxAttempts = SUBMIT_RETRY_MAX, label = '' } = {}) {
  const tag = label ? `${label} ` : '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(SUBMIT_RECHECK_MS);
    if (paneInputBoxEmpty(sessionName)) return true;
    console.log(`[QueueDispatcher] ${sessionName}: ${tag}input box still holds unsent text after submit (attempt ${attempt}/${maxAttempts}) — re-firing submit`);
    submitPane(sessionName);
  }
  // Final recheck after the last re-fire's own settle window.
  await sleep(SUBMIT_RECHECK_MS);
  return paneInputBoxEmpty(sessionName);
}

// Stuck-submit ESCALATION guards (2026-08-03 — hotfix for the walkie_submit_stuck
// self-escalation storm). The old path escalated the instant the box didn't read
// empty after 3 re-fires, walkie-ing holler-rooster every time — which storms a
// peer when its pane is legitimately busy with its own work, and (worse) loops:
// the escalation is ITSELF a paste-to-pane walkie, so when rooster is busy the
// escalation's own paste won't clear the box → it re-escalates about the failed
// escalation, self-feeding. Three guards break this:
//   1. NEVER escalate about an escalation (isEscalationWalkie skip) — the loop edge.
//   2. Only escalate if the item is STILL genuinely pending in the queue after the
//      retry window (a busy pane holding the target's own in-progress work is not a
//      stuck submit; if the target rogered-that mid-flight the item is 'confirmed').
//   3. Throttle: at most one walkie_submit_stuck per target per window.
const ESCALATE_THROTTLE_MS = 5 * 60 * 1000; // ≤1 stuck-escalation per target / 5 min
const lastEscalationAt = new Map(); // targetSessionName -> epoch ms of last escalation

/**
 * Is this queue item an escalation walkie (trigger === 'walkie_submit_stuck')?
 * Escalation walkies are the ones escalateStuckSubmit enqueues; if one of THEM
 * won't submit we must NOT escalate again about it — that's the self-feeding loop
 * edge. Parses item.message defensively; a non-JSON / missing-trigger message is
 * treated as a normal (non-escalation) walkie.
 */
function isEscalationWalkie(item) {
  try {
    const parsed = JSON.parse(item.message);
    return parsed && parsed.trigger === 'walkie_submit_stuck';
  } catch {
    return false;
  }
}

/**
 * GHOST-PLACEHOLDER DISCRIMINATOR (2026-08-31 — lost-kickoff-on-spawn fix).
 *
 * Claude Code renders a DIMMED HINT inside an otherwise-EMPTY input box:
 *   ❯ Try "how does <filepath> work?"
 * It is not user text — the box is empty; the TUI is just showing a suggestion.
 * But the naive "anything after ❯ means non-empty" reading counts it as an
 * orphaned unsent paste. That misreading is the long-standing ghost-placeholder
 * bug (flagged in the HEAD-TRUNCATION POSTSCRIPT below, and live-reproduced on a
 * virgin pane on 2026-08-31: capturePaneIdle → false and paneInputBoxEmpty →
 * false on a pane that was perfectly idle and ready).
 *
 * It bites HARDEST on a fresh spawn, because a just-booted pane shows EXACTLY
 * this placeholder and nothing else — so any fresh-pane readiness gate built on
 * the naive reading can never open.
 *
 * The hint is emitted by a single template in the Claude bundle:
 *   `Try "${W[(P>>>8)%W.length]}"`
 * over a fixed 8-entry suggestion list ("fix lint errors", "how does X work?",
 * "refactor X", "edit X to...", "write a test for X", …). So the shape is always
 * exactly `Try "<suggestion>"` — a whole-string match, anchored at both ends.
 *
 * Matching it is SAFE against false-positives: every dispatcher payload is
 * JSON-enriched by injectNow (starts with `{`), and the wake bootstrap starts
 * with 'WAKE-UP.' — neither can ever match `^Try "…"$`. We deliberately anchor
 * the whole string rather than substring-matching 'Try "', so a real message that
 * merely CONTAINS that text is still correctly read as non-empty.
 */
const PANE_PLACEHOLDER_RE = /^Try\s+"[^"]*"$/;

/**
 * Extract the live input-box contents from a pane capture.
 * Returns the text after the '❯' glyph on the LAST prompt line, or null if no
 * prompt box is present at all (pane is booting / raw shell / not a Claude TUI).
 */
function readPaneInputBox(cap) {
  if (!cap) return null;
  const lines = cap.split('\n');
  let inputLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const stripped = lines[i].replace(/^[\s│]*/, '');
    if (stripped.startsWith('❯')) { inputLine = stripped; break; }
  }
  if (inputLine === null) return null;
  return inputLine.replace(/^❯\s?/, '').replace(/[\s│]*$/, '').trim();
}

/**
 * Is this box-content string EMPTY for our purposes — i.e. holds no unsent user
 * text? True for a literally-blank box AND for a box showing only the dimmed
 * `Try "…"` suggestion placeholder (see PANE_PLACEHOLDER_RE).
 */
function boxContentIsEmpty(content) {
  if (content === null) return false;   // no prompt box → not confirmed empty
  if (content.length === 0) return true;
  return PANE_PLACEHOLDER_RE.test(content);
}

/**
 * LIVE check: is the target pane's input box EMPTY right now? Finds the last
 * '❯ …' prompt line; empty iff nothing follows the glyph OR only the dimmed
 * `Try "…"` placeholder does (see PANE_PLACEHOLDER_RE). Does NOT require at-rest
 * idle — used purely to confirm our just-submitted paste actually left the box.
 * Returns false on any capture error or if no prompt box is found (fail-safe:
 * "not confirmed empty" → the caller re-fires / escalates rather than assuming
 * success).
 */
function paneInputBoxEmpty(sessionName) {
  let cap;
  try {
    cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
  } catch {
    return false;
  }
  if (!cap) return false;
  return boxContentIsEmpty(readPaneInputBox(cap));
}

/**
 * Escalate a stuck submit: the input box still held our un-submitted paste after
 * SUBMIT_RETRY_MAX re-fires. Log loudly and walkie holler-rooster (via the same
 * enqueue path everything else uses) so a human-in-the-loop steward can look —
 * instead of silently leaving a jammed box that clogs this target's chain. The
 * queue item itself is left pending (caller returns 'failed'), so a later tick can
 * still redeliver if the pane recovers. Awaited by the caller (injectNow is
 * async) so any enqueue rejection surfaces there rather than as an unhandled reject.
 */
async function escalateStuckSubmit(sessionName, item) {
  // Throttle guard (#3): at most one walkie_submit_stuck per target per window, so
  // even a genuinely-jammed target can't storm holler-rooster tick after tick.
  const now = Date.now();
  const last = lastEscalationAt.get(sessionName) || 0;
  if (now - last < ESCALATE_THROTTLE_MS) {
    console.error(`[QueueDispatcher] ${sessionName}: submit stuck (item ${item.id}) but a stuck-escalation already fired ${Math.round((now - last) / 1000)}s ago (< ${Math.round(ESCALATE_THROTTLE_MS / 1000)}s throttle) — suppressing duplicate escalation.`);
    return;
  }
  lastEscalationAt.set(sessionName, now);
  console.error(`[QueueDispatcher] ${sessionName}: submit STUCK — input box still holds unsent text after ${SUBMIT_RETRY_MAX} re-fires (item ${item.id}). Escalating to holler-rooster.`);
  try {
    await enqueue('holler-rooster', JSON.stringify({
      trigger: 'walkie_submit_stuck',
      target: sessionName,
      refires: SUBMIT_RETRY_MAX,
      original_item_id: item.id,
      original_target_session: item.target_session,
      note: 'Pasted walkie would not submit (Enter+KPEnter both failed to clear the input box). Target chain may be jammed — investigate the pane.',
      escalated_at: new Date().toISOString(),
    }));
  } catch (e) {
    console.error(`[QueueDispatcher] escalateStuckSubmit: failed to enqueue holler-rooster walkie: ${e.message}`);
  }
}

/**
 * Send a message to a tmux session via load-buffer + paste-buffer + Enter.
 * Injects the queue item ID and an explicit confirm command into the message
 * so the receiver knows exactly how to acknowledge receipt.
 *
 * ASYNC (event-loop starvation fix, 2026-07-29): the paste→Enter render delay is
 * now a non-blocking `await sleep(500)` instead of `execSync('sleep 0.5')`. The
 * tick loop awaits this, so during a wide broadcast the per-delivery delays yield
 * the loop (letting inbound confirms land) instead of blocking it back-to-back.
 * Returns a Promise<boolean>.
 */
async function sendMessage(sessionName, message, queueItemId) {
  const tempFile = join(os.tmpdir(), `tmux-queue-${Date.now()}.txt`);
  try {
    // Build the enriched message with _queue_id and _confirm command.
    // The confirm now captures the receiver's actual tmux session name so the
    // server can record `confirmed_by` — proves which session actually got the
    // message (catches misroutes where target=A but A's substeward A--B picks
    // it up via fuzzy match). `tmux display-message` inside Claude's Bash tool
    // returns whatever tmux session Claude is currently running in.
    let enrichedMessage = message;
    const confirmCmd = `SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo unknown) && curl -s -X POST http://localhost:3005/api/queue/confirm -H "Content-Type: application/json" -d "{\\"id\\":\\"${queueItemId}\\",\\"confirmed_by\\":\\"$SESSION\\"}"`;
    try {
      const parsed = JSON.parse(message);
      parsed._queue_id = queueItemId;
      parsed._confirm = confirmCmd;
      enrichedMessage = JSON.stringify(parsed);
    } catch {
      // Not JSON — wrap it with the ID and confirm command
      enrichedMessage = JSON.stringify({ _queue_id: queueItemId, _confirm: confirmCmd, _raw: message });
    }

    writeFileSync(tempFile, enrichedMessage);
    const bufferName = `walkie-${Date.now()}`;
    execSync(`tmux load-buffer -b "${bufferName}" "${tempFile}"`);
    // '=name:' forces exact session match for pane-target commands.
    // (bare '=name' fails — paste-buffer/send-keys need session:window.pane form;
    // the trailing ':' selects the current window/pane of the named session.)
    // Bracketed paste — see pasteBufferToPane (head-truncation fix 2026-08-29).
    pasteBufferToPane(bufferName, sessionName);
    // Delay to let paste fully render before sending Enter. NON-BLOCKING (see
    // sleep() note above) — yields the event loop so inbound confirms can land.
    await sleep(500);
    submitPane(sessionName); // Enter + KPEnter (see submitPane note)
    console.log(`[QueueDispatcher] Message sent to ${sessionName} (id: ${queueItemId})`);
    return true;
  } catch (e) {
    console.error(`[QueueDispatcher] Failed to send to ${sessionName}:`, e.message);
    return false;
  } finally {
    try { require('fs').unlinkSync(tempFile); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Walkie delivery: MID-STREAM INJECT, alive-only (2026-08-01, Josh directive).
//
// "No more blocking based on working or not. The only check is for 'alive' and
// then otherwise, we send it all the way every time. Midstream. No more waiting.
// Inject asap." — Josh.
//
// WHY THIS IS SAFE: modern Claude Code natively accepts mid-turn input and QUEUES
// it ("Send messages to Claude while it works to steer Claude in real-time").
// The old idle-gate (waitForLiveIdle / deliverWhenIdle / pre- & post-paste live
// idle re-checks) guarded a paste-into-busy SCRAMBLE bug that CC has since fixed,
// so mid-stream inject is now clean. Removing the idle box-check also moots the
// ghost-placeholder drop bug (capturePaneIdle misreading `❯ Try "…"` placeholder
// text as an orphaned unsent paste, then refusing delivery forever) — nothing on
// the delivery path checks the box for idle anymore.
//
// WHAT REMAINS:
//   - ALIVE gate only (Steps 1-2 of tick's per-item loop): a dead/cold target
//     fresh-spawn-wakes; an alive target gets an immediate inject.
//   - Per-target SERIALIZED chain (deliverySerials, see deliverNow) — kept ONLY
//     so two pastes can't race into ONE pane and concatenate/scramble. It waits
//     purely on the prior paste's submit, NEVER on idle. Different targets inject
//     concurrently (each has its own chain).
//   - Tracked-box submit safety net (re-fire Enter+KPEnter if the paste is still
//     parked; escalate if it never clears) — unrelated to idle, kept.
//
// capturePaneIdle() itself is retained: isSessionReady()'s stale-idle
// discrimination still uses it. It is no longer part of the delivery path.
//
// HEAD-TRUNCATION POSTSCRIPT (2026-08-29). Large walkies were arriving with their
// leading bytes missing (tail-only). It is tempting to blame mid-stream inject and
// "restore the idle gate" — DON'T. Reproduced live: the same 2KB payload truncates
// IDENTICALLY into a fully IDLE pane, so busy-ness is not the variable. The loss is
// in the paste layer: a plain `paste-buffer` streams raw keystrokes that the TUI
// collapses to their tail. The real fix is BRACKETED paste (`paste-buffer -p`) —
// see pasteBufferToPane(). Re-adding an idle gate would not fix truncation and WOULD
// resurrect the ghost-placeholder drop bug (a pane idling on `❯ Try "…"` placeholder
// text reads as a non-empty box — still reproducible on the fleet today).
// ---------------------------------------------------------------------------

/**
 * LIVE idle probe: capture the target pane RIGHT NOW and decide if it is sitting
 * idle at an empty prompt. Unlike isSessionReady()'s file-based check this reads
 * ground truth with zero staleness.
 *
 * A pane is idle iff:
 *   - the Claude footer is present ('bypass permissions on'), AND
 *   - the footer does NOT show 'esc to interrupt' (that only appears while a turn
 *     is actively rendering), AND
 *   - the input box prompt line ('❯ …') is EMPTY (no orphaned/half-typed paste
 *     waiting to be submitted — pasting on top would concatenate + scramble).
 *
 * Returns false on any capture error or ambiguous state (fail-safe: when in
 * doubt, treat as NOT idle so we don't paste into a possibly-busy pane).
 */
function capturePaneIdle(sessionName) {
  let cap;
  try {
    cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
  } catch {
    return false;
  }
  if (!cap) return false;

  // Must show the Claude prompt footer at all — otherwise it's not a live
  // ready-to-receive Claude pane (booting, /clear mid-flight, raw shell, etc.).
  if (!cap.includes('bypass permissions on')) return false;

  // Actively rendering a turn — the single most reliable "busy" signal.
  if (cap.includes('esc to interrupt')) return false;

  // Input box must be empty. Find the LAST '❯ ' prompt line (the live input box
  // sits just above the footer) and ensure nothing follows the prompt glyph.
  // A non-empty box means an orphaned paste is sitting there un-submitted;
  // pasting again would concatenate and scramble.
  //
  // GHOST-PLACEHOLDER FIX (2026-08-31): the dimmed `Try "…"` suggestion hint is
  // NOT orphaned text — the box is empty and the pane IS idle. Reading it as
  // occupied is the long-flagged ghost-placeholder drop bug (see
  // PANE_PLACEHOLDER_RE); it made this function return false on every freshly
  // booted pane, which is exactly the state a fresh-spawn gate must recognise.
  return boxContentIsEmpty(readPaneInputBox(cap));
}

// Per-target serialized delivery chains. Each target session gets its own promise
// chain so deliveries into the SAME pane run strictly one-at-a-time (paste →
// Enter) while DIFFERENT targets deliver concurrently. This is the ONLY thing the
// chain waits on — the prior paste's submit — NOT idle. It exists purely so two
// pastes can't race into one pane and concatenate/scramble. Cleared lazily when a
// chain drains (see deliverNow).
const deliverySerials = new Map(); // sessionName -> Promise (tail of the chain)
// Items whose delivery is currently scheduled/in-flight on a chain — prevents the
// next tick from re-scheduling the same pending item while its chain runs.
const inFlightDeliveries = new Set(); // queue item ids

// REDELIVERY CANCEL (2026-09-01 — drop-detector false-positive fix). When an
// item is confirmed, any delivery already sitting on a per-target chain (waiting
// behind an earlier paste) must NOT still fire: a confirmed item redelivered is
// exactly the duplicate the roger-that protocol exists to prevent, and it also
// re-arms the Phase-1 retry ladder. confirm() adds the id here; injectNow's
// wrapper checks it right before the paste and skips, and the post-write drops
// it. Bounded: entries only live as long as the chain hop they guard.
const cancelledDeliveries = new Set(); // queue item ids confirmed mid-flight

/**
 * MID-STREAM INJECT — deliver ONE item to ONE alive target IMMEDIATELY, without
 * waiting for the pane to be idle (2026-08-01, Josh directive). This is the unit
 * that runs on the per-target chain. It:
 *   1. loads the enriched message into a tmux buffer and pastes it into the pane
 *      RIGHT NOW (mid-turn is fine — modern Claude Code queues mid-stream input),
 *   2. sleeps briefly for the paste to render, then submits (Enter + KPEnter),
 *   3. re-checks the input box and re-fires the submit up to SUBMIT_RETRY_MAX
 *      times if the paste is still parked (render race), escalating if it never
 *      clears.
 * There is NO idle wait, NO pre-paste idle gate, NO pre-Enter idle re-check, and
 * NO return-to-idle wait. The only thing the caller's chain serializes on is this
 * function resolving (i.e. our submit landed) so the next paste to the same pane
 * doesn't overlap ours.
 *
 * ONE narrow exception (2026-08-31): a pane created within FRESH_SPAWN_WINDOW_MS
 * first waits for its TUI to finish booting (waitForFreshPanePasteReady). That is
 * a boot gate on virgin panes only — NOT a return of the fleet-wide idle gate; an
 * established busy pane is still injected into immediately. See the
 * LOST-KICKOFF-ON-SPAWN block for why, and for the constraint that keeps the two
 * apart.
 *
 * Returns 'delivered' | 'failed' | 'deferred'.
 *   - 'deferred' means the target was a still-booting fresh pane: nothing was
 *     committed, the item MUST stay pending, and a later tick retries. Callers
 *     must not treat it as a failure (that drop is the bug being fixed).
 */
async function injectNow(sessionName, item) {
  const tempFile = join(os.tmpdir(), `tmux-queue-${Date.now()}-${item.id}.txt`);
  const bufferName = `walkie-${Date.now()}-${item.id}`;
  try {
    const confirmCmd = `SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo unknown) && curl -s -X POST http://localhost:3005/api/queue/confirm -H "Content-Type: application/json" -d "{\\"id\\":\\"${item.id}\\",\\"confirmed_by\\":\\"$SESSION\\"}"`;
    let enrichedMessage = item.message;
    try {
      const parsed = JSON.parse(item.message);
      parsed._queue_id = item.id;
      parsed._confirm = confirmCmd;
      enrichedMessage = JSON.stringify(parsed);
    } catch {
      enrichedMessage = JSON.stringify({ _queue_id: item.id, _confirm: confirmCmd, _raw: item.message });
    }
    // FRESH-SPAWN PASTE-READY GATE (2026-08-31 — lost-kickoff fix). If this pane
    // was created moments ago, the TUI may still be booting: "alive" is true but
    // it is not yet accepting pasted input, and a paste+submit here silently
    // no-ops (payload parks in the box forever). Wait for the TUI to finish its
    // first draw before pasting. Established panes skip this entirely, so
    // mid-stream inject is unchanged. See the LOST-KICKOFF-ON-SPAWN block above,
    // especially the constraint note: this is NOT the old fleet-wide idle gate.
    const fresh = isFreshSpawn(sessionName);
    if (fresh) {
      const ready = await waitForFreshPanePasteReady(sessionName);
      if (!ready) {
        // NO-DROP: a still-booting pane is not a failed delivery. Leave the item
        // PENDING so the next tick redelivers once the TUI is up, rather than
        // burning the kickoff and stranding the worker with no task.
        console.log(`[QueueDispatcher] ${sessionName}: fresh pane still not paste-ready after ${Math.round(FRESH_PASTE_READY_TIMEOUT_MS / 1000)}s — deferring item ${item.id} (left PENDING for a later tick, NOT dropped)`);
        return 'deferred';
      }
      console.log(`[QueueDispatcher] ${sessionName}: fresh pane confirmed paste-ready — delivering kickoff item ${item.id}`);
    }

    writeFileSync(tempFile, enrichedMessage);
    execSync(`tmux load-buffer -b "${bufferName}" "${tempFile}"`);
    // Bracketed paste (-p) — see pasteBufferToPane. This is THE fix for the
    // large-walkie head-truncation Alfred flagged: a plain paste-buffer streams
    // raw keystrokes that the TUI collapses to their tail on big payloads.
    pasteBufferToPane(bufferName, sessionName);

    // Let the paste render, then commit (Enter + KPEnter — see submitPane note).
    // No pre-Enter idle/rendering re-check: mid-stream submit is intended.
    await sleep(500);
    submitPane(sessionName);

    // Tracked-box safety net (2026-07-30). Even with the KPEnter superset, a
    // submit can intermittently fail to register (render race, transient TUI
    // state). If our pasted text is STILL parked in the input box, re-fire the
    // submit. If it never clears, ESCALATE (log + walkie holler-rooster) rather
    // than silently leaving the box jammed.
    //
    // A FRESH pane gets a much longer verification window (2026-08-31): the 3x700ms
    // budget is tuned for a transient render race on a running pane, but a pane
    // that is still settling can outlive it entirely — which is precisely how the
    // kickoff got marked 'failed' and dropped.
    const submitted = await verifySubmitted(sessionName, {
      maxAttempts: fresh ? FRESH_SUBMIT_RETRY_MAX : SUBMIT_RETRY_MAX,
      label: `item ${item.id}:`,
    });
    if (!submitted && fresh) {
      // NO-DROP on a fresh pane, same reasoning as the readiness gate above: a
      // kickoff that would not commit into a settling TUI must stay deliverable.
      //
      // ⚠️ THIS BRANCH IS ALSO WHAT KEEPS A RESUMING SESSION OUT OF THE STUCK-
      // SUBMIT ESCALATION BELOW (found by audit 2026-09-06, not by design).
      // escalateStuckSubmit has no liveness check, so a session that is merely
      // mid-resume is indistinguishable from one that will not accept a submit.
      // It stays out only because isFreshSpawn() reports a RESUMED pane as fresh
      // (see the note at its definition). If that ever stops being true, this
      // `continue`-equivalent disappears and the escalation fires on healthy
      // resuming sessions. Do not narrow `fresh` here without reading that note.
      console.log(`[QueueDispatcher] ${sessionName}: kickoff did not commit on fresh pane after ${FRESH_SUBMIT_RETRY_MAX} re-fires — deferring item ${item.id} (left PENDING for a later tick, NOT dropped)`);
      return 'deferred';
    }
    if (!submitted) {
      // The box never read empty across the retry window. Before escalating, apply
      // the loop-break + durable-pending guards (2026-08-03 hotfix):
      //
      //   #1 LOOP-BREAK: if THIS item is itself an escalation walkie, NEVER escalate
      //      again about it. The escalation is delivered by the same paste-to-pane
      //      path; when its target is busy the paste won't clear the box either, and
      //      re-escalating spawns another escalation → the self-feeding storm. An
      //      escalation that won't submit just fails quietly (still pending on the
      //      queue, so a later tick can redeliver when the pane frees up).
      if (isEscalationWalkie(item)) {
        console.error(`[QueueDispatcher] ${sessionName}: escalation walkie (item ${item.id}) would not submit — NOT re-escalating (loop-break). Leaving it pending for a later tick.`);
        return 'failed';
      }
      //   #2 DURABLE-PENDING GATE: a non-empty box THIS instant is not proof of a
      //      stuck submit — the box legitimately holds the target's OWN in-progress
      //      work during a burst, and the target may have rogered-that mid-flight
      //      (status→'confirmed'). Only escalate if the item is STILL genuinely
      //      pending in the queue after the retry window. If it already advanced
      //      (confirmed/dispatched by a concurrent path), the submit wasn't stuck.
      let stillPending = true;
      try {
        // NB: `freshQueue`, not `fresh` — `fresh` is the fresh-SPAWN flag in this
        // function's outer scope (2026-08-31). Different concept entirely.
        const freshQueue = readQueue();
        const it = freshQueue.find(q => q.id === item.id);
        // Missing item (cleaned) or any non-pending status ⇒ not a stuck submit.
        stillPending = !!it && it.status === 'pending';
      } catch (e) {
        console.error(`[QueueDispatcher] ${sessionName}: could not re-read queue for durable-pending check (item ${item.id}): ${e.message} — proceeding to escalate.`);
      }
      if (!stillPending) {
        console.log(`[QueueDispatcher] ${sessionName}: box non-empty after re-fires but item ${item.id} is no longer pending (target likely accepted/rogered mid-stream) — NOT escalating.`);
        return 'failed';
      }
      await escalateStuckSubmit(sessionName, item);
      return 'failed';
    }
    console.log(`[QueueDispatcher] Message sent to ${sessionName} (id: ${item.id}) [mid-stream inject]`);
    return 'delivered';
  } catch (e) {
    console.error(`[QueueDispatcher] Mid-stream inject to ${sessionName} failed:`, e.message);
    return 'failed';
  } finally {
    try { require('fs').unlinkSync(tempFile); } catch {}
    try { execSync(`tmux delete-buffer -b "${bufferName}" 2>/dev/null`); } catch {}
  }
}

/**
 * Append an item's mid-stream inject onto its target's serialized chain and
 * return the chain-tail promise. Deliveries to the same target run strictly in
 * order (each waits only for the prior paste's submit, NEVER for idle); to
 * different targets, concurrently. The item's final queue status is written from
 * inside the chain via mutateQueue, so tick() must NOT also mutate it.
 */
function deliverNow(sessionName, item) {
  inFlightDeliveries.add(item.id);
  const prev = deliverySerials.get(sessionName) || Promise.resolve();
  const next = prev.then(() => {
    // CANCEL-ON-CONFIRM (2026-09-01): the target may have rogered-that while
    // this delivery sat behind an earlier paste on the chain. Re-check right
    // before the paste — a confirmed item must never be pasted again.
    if (cancelledDeliveries.has(item.id)) {
      console.log(`[QueueDispatcher] Delivery of ${item.id} to ${sessionName} CANCELLED — confirmed while queued on the chain`);
      return 'cancelled';
    }
    return injectNow(sessionName, item);
  })
    .catch(e => {
      console.error(`[QueueDispatcher] Delivery chain error for ${sessionName} item ${item.id}:`, e && e.message);
      return 'failed';
    })
    .then(async (outcome) => {
      await mutateQueue(queue => {
        const it = queue.find(q => q.id === item.id);
        if (!it) return mutateQueue.NO_CHANGE;
        // CONFIRM-WINS GUARD (race fix 2026-07-30): the target can roger-that
        // BEFORE this async delivery-chain post-write runs. If confirm already
        // landed (status='confirmed'), do NOT downgrade back to 'dispatched' —
        // that re-armed Phase-1 retries, which redelivered the same item 3x and
        // then marked it 'failed' despite a valid confirmed_by. 'confirmed' is
        // terminal; leave it. (Alfred-flagged notif-push redelivery loop.)
        if (it.status === 'confirmed') return mutateQueue.NO_CHANGE;
        // Cancelled (confirmed mid-chain): leave the item exactly as-is. The
        // confirm() that cancelled it already wrote the terminal status.
        if (outcome === 'cancelled') return mutateQueue.NO_CHANGE;
        if (outcome === 'delivered') {
          it.status = 'dispatched';
          it.dispatched_at = new Date().toISOString();
          it.dispatched_ready = true;
          if (!it.attempts) it.attempts = 1;
          // Clear the "last-was-clear" flag unless the message opts out.
          try {
            let parsed = {};
            try { parsed = JSON.parse(it.message); } catch {}
            if (!parsed._skip_flag_clear) {
              const flagPath = `/tmp/claude-session-${sessionName}-last-was-clear.flag`;
              if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath);
            }
          } catch {}
        } else if (outcome === 'failed') {
          it.status = 'failed';
          it.error = 'Mid-stream inject failed';
          it.failed_at = new Date().toISOString();
        } else if (outcome === 'deferred') {
          // FRESH-PANE DEFERRAL (2026-08-31 — lost-kickoff fix). The target was a
          // just-spawned pane whose TUI had not finished booting, so we never got
          // a committed submit. This is NOT a failure: leave the item exactly as
          // it is (status stays 'pending', attempts NOT incremented) so the next
          // tick redelivers once the pane is up. Burning it to 'failed' here is
          // precisely what stranded workers with no task.
          return mutateQueue.NO_CHANGE;
        }
        return queue;
      });
      inFlightDeliveries.delete(item.id);
      cancelledDeliveries.delete(item.id);
    });
  // Store a chain tail that never rejects (so one failure can't wedge the chain).
  const tail = next.catch(() => {});
  deliverySerials.set(sessionName, tail);
  // Lazy cleanup: when this tail drains and it's still the current tail, drop the
  // map entry so the Map doesn't grow unbounded across many one-off targets.
  tail.then(() => {
    if (deliverySerials.get(sessionName) === tail) deliverySerials.delete(sessionName);
  });
  return next;
}

/**
 * Map a target_session value to a steward name and tmux session name
 * target_session can be "one-interface", etc.
 */
function resolveTarget(targetSession) {
  const resolver = require('./steward-resolver');
  let result = resolver.resolveTarget(targetSession);
  if (!result.valid) {
    // FRESH-WORKER CACHE-RACE HEAL (2026-08-04). The resolver caches its target
    // list for 30s (steward-resolver CACHE_TTL_MS). A worker that spawned in the
    // last 30s has its steward.json ON DISK but is NOT in the stale cached list,
    // so its just-enqueued auto-kickoff walkie resolves to Unknown-target and gets
    // marked skipped-unknown-target — a TERMINAL status (no retry): the kickoff is
    // lost forever. So on the FIRST failure, bust the resolver cache and re-resolve
    // ONCE: a real on-disk fresh worker now resolves and the kickoff delivers on
    // attempt 1. A genuinely decommissioned target still fails the re-resolve and
    // is correctly skipped. clearCache() is exported by steward-resolver.
    try { resolver.clearCache(); } catch {}
    result = resolver.resolveTarget(targetSession);
  }
  if (!result.valid) {
    throw new Error(`Unknown target "${targetSession}": ${result.error}`);
  }
  const stewardName = result.sessionName.replace('holler-', '');
  return { sessionName: result.sessionName, stewardName, directory: result.directory };
}

/**
 * True when a walkie's target is provably NOT able to receive right now —
 * either its claude process is dead, or a compute-suspend marker says it is
 * suspended/mid-resume. Used by Phase 1 to grant retry AMNESTY so the
 * always-off shutdown can never burn an item's delivery attempts at a closed
 * door. See the SUSPEND-COLLISION AMNESTY block in tick().
 *
 * Cheap by construction (a marker stat, and needsClaudeRestart's ps-walk only
 * when the session exists) and TOTALLY non-throwing: this runs per-unconfirmed-
 * item per tick and must never be able to break the dispatch loop. On ANY error
 * it returns false — i.e. it declines to grant amnesty — so a bug here degrades
 * to exactly the pre-existing retry behavior rather than to an item that never
 * fails.
 */
function isTargetDownOrResuming(targetSession) {
  try {
    if (!targetSession || typeof targetSession !== 'string') return false;
    let sessionName;
    try {
      ({ sessionName } = resolveTarget(targetSession));
    } catch {
      return false; // unresolvable target — not our case; let normal handling run
    }
    if (!sessionName) return false;

    // A suspend marker means the session is suspended or actively resuming.
    // Checked FIRST and independently of process state: during a resume the
    // claude process may already be up while the transcript is still loading,
    // and that window is precisely when we must not spend a strike.
    if (existsSync(`/tmp/claude-session-${sessionName}-compute-suspend.json`)) return true;

    // A session whose tmux is gone is cold — Phase 2 will fresh-spawn it. No
    // strike should be spent for that either.
    if (!sessionExists(sessionName)) return true;

    // tmux alive but claude dead = suspended-without-marker or crashed. Either
    // way the paste had nowhere to land.
    if (needsClaudeRestart(sessionName)) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Epoch (ms) of the target's CURRENT resume window, from the stamp
 * resumeComputeSuspend writes before typing the resume command. Null when the
 * target is not mid-resume, unresolvable, or the stamp is unreadable.
 *
 * Used to stop the suspend-collision amnesty from re-queueing an item that has
 * ALREADY been pasted during this same resume. Non-throwing by construction: it
 * runs per unconfirmed item per tick, and on any error returns null, which makes
 * the caller fall back to the previous (over-eager) behaviour rather than break.
 */
function resumeEpochMs(targetSession) {
  try {
    if (!targetSession || typeof targetSession !== 'string') return null;
    let sessionName;
    try {
      ({ sessionName } = resolveTarget(targetSession));
    } catch {
      return null;
    }
    if (!sessionName) return null;
    const stampPath = `/tmp/claude-session-${sessionName}-resumed-at`;
    if (!existsSync(stampPath)) return null;
    const t = parseInt(readFileSync(stampPath, 'utf-8').trim(), 10);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Process the queue — called every 10s
 *
 * Handles two cases:
 * 1. Dispatched-but-unconfirmed items — retry only if the session was ready when dispatched
 * 2. Pending items — deliver to target session when ready
 *
 * Retry logic: attempts only count when the session was confirmed ready at
 * dispatch time (dispatched_ready = true). If the session was busy, we just
 * re-queue without incrementing attempts.
 */
// ASYNC (event-loop wedge fix): tick runs on the 10s dispatch interval (never a
// request burst), so its own body stays synchronous. But its final write-back is
// routed through mutateQueue() and applied as a PATCH-BY-ID over a fresh re-read,
// so a status transition it computed can't clobber an async confirm/enqueue that
// landed while tick was working. `changedIds` records every item tick mutated;
// under the lock we re-read fresh and overlay tick's version for those ids only —
// items a concurrent enqueue added survive (they're in the fresh read, untouched).
async function tick() {
  const queue = readQueue();
  if (!queue.length) return;
  const changedIds = new Set(); // ids tick mutated this cycle — see write-back below

  const pendingCount = queue.filter(i => i.status === 'pending').length;
  const dispatchedCount = queue.filter(i => i.status === 'dispatched').length;
  if (pendingCount > 0 || dispatchedCount > 0) {
    console.log(`[QueueDispatcher] tick: ${pendingCount} pending, ${dispatchedCount} dispatched`);
  }

  let changed = false;

  // --- Phase 1: Retry unconfirmed dispatched items ---
  const unconfirmed = queue.filter(item =>
    item.status === 'dispatched' &&
    item.dispatched_at &&
    (Date.now() - new Date(item.dispatched_at).getTime()) > CONFIRM_TIMEOUT_MS
  );

  for (const item of unconfirmed) {
    const attempts = item.attempts || 1;

    // SUSPEND-COLLISION AMNESTY (2026-09-06 — always-off shutdown hardening).
    //
    // THE RACE: an item is pasted into a live pane (so it dispatches with
    // dispatched_ready=true and its attempts DO count), and the always-off
    // shutdown kills that pane moments later — before the target could act on
    // the text or roger-that. The message is now gone off-screen, and the item
    // is on a 30s retry clock with only MAX_RETRIES(3) strikes.
    //
    // WHY THAT LOSES MAIL: a compute-suspend RESUME can legitimately take up to
    // 45s to reach ready-state (READY_TIMEOUT_SEC in resumeComputeSuspend), and
    // slow/large-transcript resumes retry across several ticks beyond that. That
    // is LONGER than the 30s retry interval, so all three strikes can burn while
    // the session is still legitimately coming back up. The item then stops
    // redelivering — and the walkie Josh sent is never seen by anyone.
    //
    // THE FIX: while the target is provably NOT in a position to receive (its
    // claude is dead, or it is mid-resume with a suspend marker present), a
    // strike is NOT a real delivery failure — it is us retrying at a closed
    // door. Re-queue WITHOUT incrementing attempts, exactly as the dispatcher
    // already does for the "session wasn't ready at dispatch" case. This spends
    // no extra pastes (the item just returns to pending and Step 1/2 of Phase 2
    // routes it into the resume path), and it CANNOT loop forever — see the
    // AMNESTY_MAX_REQUEUES bound below, which is what actually guarantees
    // termination here (this branch's `continue` skips the CONFIRM_WINDOW_MS
    // terminalizer, so the bound, not that window, is the backstop).
    //
    // Ordering note: this is checked BEFORE the attempts>=MAX_RETRIES branch so
    // an item that already spent its strikes during a suspend is REVIVED rather
    // than sitting redeliver_exhausted while the session comes back healthy.
    //
    // BOUNDED (must be): amnesty skips the CONFIRM_WINDOW_MS terminalizer via the
    // `continue` below, so an UNBOUNDED version would revive an item forever
    // whenever its target stays down — a session that can never wake (torn-down
    // dir, permanently failed resume) would accumulate immortal pending items.
    // Under the in-flight guard those items also mean that session can NEVER be
    // suspended again: a live-forever queue entry is a permanent sleep blocker.
    // So amnesty is generous but FINITE. Past the cap we stop granting it and
    // fall through to the normal retry/terminalize logic, which ends the item.
    // 60 requeues at a 10s tick is ~10 minutes of grace — far longer than any
    // legitimate resume (observed 1-3s; the resume path's own ceiling is ~7.5min)
    // while still guaranteeing termination.
    const AMNESTY_MAX_REQUEUES = 60;
    const amnestySpent = (item.suspend_collision_requeues || 0) >= AMNESTY_MAX_REQUEUES;
    if (amnestySpent && isTargetDownOrResuming(item.target_session)) {
      console.warn(`[QueueDispatcher] Item ${item.id}: suspend-collision amnesty EXHAUSTED after ${item.suspend_collision_requeues} requeues (target still down) — falling through to normal retry/terminalize so it cannot block forever`);
    }
    // ALREADY-PASTED-THIS-RESUME GUARD (2026-09-06 — production defect).
    //
    // THE BUG: the amnesty re-queues while the target reads DOWN-OR-RESUMING. A
    // session that has just been resumed but is still LOADING still reads as
    // resuming. So: deliver -> unconfirmed (target still coming up) -> amnesty
    // re-queues -> deliver AGAIN -> ... Observed in production on a single item
    // (1788735152653-dglvca): FOUR "Message sent [mid-stream inject]" lines, each
    // preceded by a "suspend collision — re-queuing WITHOUT penalty". The target
    // received the same instruction four times and answered it twice.
    //
    // WHY IT MATTERS AT FLEET SCALE: cheap for one session, expensive when every
    // session suspends on every idle. Beyond doubled turns and tokens, a steward
    // ACTING TWICE on one instruction is a real cost — "tear down", "push the
    // branch", "dismiss the card" are not idempotent.
    //
    // THE FIX: amnesty exists for an item that was pasted into a pane that then
    // DIED. It must not re-send an item already pasted DURING the current resume
    // window. resumeComputeSuspend stamps that window's start before typing the
    // resume command, so an item whose last paste is NEWER than the stamp has
    // already landed in this attempt — decline amnesty and let the normal
    // confirm/retry path own it. A genuine mid-shutdown collision (paste OLDER
    // than the stamp, or no stamp at all) still gets its no-penalty retry.
    const resumeEpoch = resumeEpochMs(item.target_session);
    const dispatchedMsForGuard = item.dispatched_at ? new Date(item.dispatched_at).getTime() : NaN;
    const pastedThisResume =
      resumeEpoch !== null &&
      Number.isFinite(dispatchedMsForGuard) &&
      dispatchedMsForGuard >= resumeEpoch;
    if (pastedThisResume && isTargetDownOrResuming(item.target_session)) {
      // Leave the item exactly as it is: still 'dispatched', still confirmable,
      // attempts untouched. It was delivered; we are simply waiting for the
      // target to finish loading and roger it. No re-paste.
      if (!item.awaiting_post_resume_confirm) {
        item.awaiting_post_resume_confirm = true;
        console.log(`[QueueDispatcher] Item ${item.id} already pasted during this resume window (dispatched ${item.dispatched_at} >= resume ${new Date(resumeEpoch).toISOString()}) — NOT re-sending; waiting for the target to finish loading and confirm`);
        changed = true;
        changedIds.add(item.id);
      }
      continue;
    }

    if (!amnestySpent && isTargetDownOrResuming(item.target_session)) {
      if (item.status !== 'pending' || item.attempts !== attempts) {
        console.log(`[QueueDispatcher] Item ${item.id} unconfirmed but target is down/resuming (suspend collision) — re-queuing WITHOUT penalty (attempts stay ${attempts})`);
      }
      item.status = 'pending';
      delete item.dispatched_ready;
      // Clear the exhausted latch: the strikes it spent were spent at a closed
      // door, so redelivery must be re-armed once the session is back.
      if (item.redeliver_exhausted) {
        delete item.redeliver_exhausted;
        delete item.redeliver_exhausted_at;
      }
      item.suspend_collision_requeues = (item.suspend_collision_requeues || 0) + 1;
      changed = true;
      changedIds.add(item.id);
      continue;
    }

    // Only count toward max retries if the session was actually ready when we sent
    if (item.dispatched_ready && attempts >= MAX_RETRIES) {
      // RETRIES SPENT — but NOT necessarily failed yet (2026-09-02).
      //
      // Previously this terminalized to 'failed' immediately, roughly 90s after
      // dispatch, which is far shorter than a normal busy-steward turnaround.
      // Now: stop REDELIVERING (no more pastes — the retry budget is genuinely
      // spent), but leave the item non-terminal and CONFIRMABLE until
      // CONFIRM_WINDOW_MS elapses. `redeliver_exhausted` is what keeps it out of
      // Phase 2 while it waits; the status stays 'dispatched' deliberately, so
      // every existing consumer of item.status (QueueViewer, presenter-queue,
      // server stats, check-stalled-workers) keeps reading a state it already
      // understands. No new status string was introduced.
      const dispatchedMs = new Date(item.dispatched_at).getTime();
      const windowExpired =
        !Number.isFinite(dispatchedMs) ||
        (Date.now() - dispatchedMs) > CONFIRM_WINDOW_MS;

      if (!windowExpired) {
        if (!item.redeliver_exhausted) {
          item.redeliver_exhausted = true;
          item.redeliver_exhausted_at = new Date().toISOString();
          console.log(`[QueueDispatcher] Item ${item.id} spent its ${attempts} ready-state attempts — no further redelivery, but staying CONFIRMABLE for up to ${Math.round(CONFIRM_WINDOW_MS / 1000)}s from dispatch`);
          changed = true;
          changedIds.add(item.id);
        }
        continue;
      }

      console.log(`[QueueDispatcher] Item ${item.id} failed after ${attempts} ready-state attempts and an unconfirmed ${Math.round(CONFIRM_WINDOW_MS / 1000)}s confirm window — giving up`);
      item.status = 'failed';
      item.error = `Unconfirmed after ${attempts} ready-state delivery attempts`;
      item.failed_at = new Date().toISOString();
      changed = true;
      changedIds.add(item.id);
      continue;
    }

    // Reset to pending for re-delivery
    if (item.dispatched_ready) {
      console.log(`[QueueDispatcher] Item ${item.id} unconfirmed after 30s (ready-attempt ${attempts}/${MAX_RETRIES}), retrying...`);
      item.attempts = attempts + 1;
    } else {
      console.log(`[QueueDispatcher] Item ${item.id} unconfirmed (session wasn't ready at dispatch), re-queuing without penalty...`);
    }
    item.status = 'pending';
    delete item.dispatched_ready;
    changed = true;
    changedIds.add(item.id);
  }

  // --- Phase 2: Deliver pending items ---
  const pending = queue.filter(item => item.status === 'pending');
  if (!pending.length && !changed) return;

  // Delivery stagger (2026-08-21): count how many items in THIS pass actually
  // triggered a session to fire (a mid-stream inject or a wake/resume). Before
  // each such action AFTER the first, sleep WALKIE_DELIVERY_STAGGER_MS so the
  // targets don't all fire their Claude turn in the same instant and trip the
  // shared-account rate limit. sleep() is non-blocking (setTimeout) so it yields
  // the :3005 event loop — it never wedges the server. No-op iterations
  // (malformed target, already-in-flight, unknown target) do NOT consume a
  // stagger gap: they never fire a session. A lone walkie hits `deliveries === 0`
  // and delivers immediately.
  let deliveries = 0;
  const staggerBeforeDelivery = async () => {
    if (deliveries > 0 && WALKIE_DELIVERY_STAGGER_MS > 0) {
      await sleep(WALKIE_DELIVERY_STAGGER_MS);
    }
    deliveries++;
  };

  for (const item of pending) {
    try {
      // Validate target_session before processing
      if (!item.target_session || typeof item.target_session !== 'string') {
        console.error(`[QueueDispatcher] Item ${item.id} has invalid target_session: ${JSON.stringify(item.target_session)}`);
        item.status = 'failed';
        item.error = `Malformed item: target_session is ${item.target_session === undefined ? 'missing' : 'invalid'} (got ${JSON.stringify(item.target_session)})`;
        item.failed_at = new Date().toISOString();
        changed = true;
        changedIds.add(item.id);
        notifyRepairman(item.id, item.error);
        continue;
      }

      const { sessionName, stewardName } = resolveTarget(item.target_session);

      // Step 1: Does the session exist?
      if (!sessionExists(sessionName)) {
        // Cold-target detection.
        //
        // NOTE: We deliberately do NOT short-circuit on `disallowed_sessions` in the
        // watchlist. The disallow list is meant to prevent SPURIOUS resurrection by
        // the Watchdog/stuck-checker (when nothing is happening). A walkie ARRIVING
        // for a target IS the reason to wake them. Treating membership in
        // `disallowed_sessions` as "refuse delivery" is a category error: that list
        // means "no autonomous wake without a reason," not "never deliver messages."
        // A real walkie is the reason. (Schema locked 2026-05-18, plan-node /36 —
        // replaces the old `enabled:false` flag.)
        //
        // Fleet-wide unconditional fresh-spawn since 2026-05-04: every steward
        // gets wakeFreshSpawn (NO --continue) and bootstrap. Original walkie
        // remains pending so the next tick delivers it normally — two-tick wake
        // by design.
        //
        // Async: scheduleAsyncWake schedules wakeFreshSpawn on the next event-loop
        // turn so the dispatch tick itself returns immediately. Concurrent-wake
        // protection lives in scheduleAsyncWake's inFlightWakes set.
        console.log(`[QueueDispatcher] Session ${sessionName} doesn't exist → async fresh-spawn wake (cold)`);
        const coldSessionDir = resolveSessionDir(sessionName);
        await staggerBeforeDelivery();
        scheduleAsyncWake(sessionName, coldSessionDir, item);
        // Original walkie stays pending — dispatcher re-evaluates next tick.
        // Self-healing. wake_attempts on the queue item gates retries.
        continue;
      }

      // Step 2: Does claude need a restart? (session exists but claude exited)
      if (needsClaudeRestart(sessionName)) {
        const deadSessionDir = resolveSessionDir(sessionName);

        // COMPUTE-SUSPEND RESUME (2026-07-18): if this session was compute-only
        // suspended (tmux kept alive, claude killed, marker written), resume it
        // WHOLE via `claude --resume <session_id>` — restoring full memory —
        // instead of the memory-destructive fresh-spawn. The marker records the
        // session_id. See resumeComputeSuspend(). If resume fails it degrades to
        // wakeFreshSpawn internally, so this is always at least as good as the
        // old dead-claude path.
        const suspendMarkerPath = `/tmp/claude-session-${sessionName}-compute-suspend.json`;
        if (existsSync(suspendMarkerPath)) {
          console.log(`[QueueDispatcher] Claude not running in ${sessionName} but compute-suspend marker present → async resume-in-place (--resume, memory-preserving)`);
          await staggerBeforeDelivery();
          scheduleAsyncComputeResume(sessionName, deadSessionDir, suspendMarkerPath, item);
          continue;
        }

        // Fleet-wide unconditional fresh-spawn since 2026-05-04: dead claude
        // gets wakeFreshSpawn, which kills the stale tmux first so pane state
        // doesn't leak. Async via scheduleAsyncWake.
        console.log(`[QueueDispatcher] Claude not running in ${sessionName} → async fresh-spawn wake (dead-claude)`);
        await staggerBeforeDelivery();
        scheduleAsyncWake(sessionName, deadSessionDir, item);
        continue;
      }

      // Step 3: already scheduled on a delivery chain? A prior tick may have
      // enqueued this item onto its target's serialized chain and be waiting for
      // the pane to go idle. Don't double-schedule it.
      if (inFlightDeliveries.has(item.id)) {
        continue;
      }

      // Step 4: MID-STREAM INJECT (2026-08-01 — Josh directive). The session is
      // ALIVE (Steps 1-2 above already fresh-spawn-wake dead/cold targets and
      // `continue`). "Alive" is now the ONLY gate. We no longer wait for the
      // pane to be idle — modern Claude Code natively accepts mid-turn input and
      // QUEUES it ("Send messages to Claude while it works to steer in real-
      // time"). So we inject ASAP, mid-stream, every time.
      //
      // deliverNow schedules onto the target's LIGHTWEIGHT per-target chain so
      // two pastes never race into ONE pane — but that chain waits only for the
      // prior paste's Enter, NEVER for idle. Different targets deliver
      // concurrently. deliverNow returns immediately (fire-and-forget); it owns
      // the item's final status write-back via mutateQueue, so tick() must NOT
      // also mark this item changed here.
      await staggerBeforeDelivery();
      deliverNow(sessionName, item);
    } catch (e) {
      // Never let one bad item crash the entire tick loop.
      //
      // Unknown-target errors (stale items pointing at decommissioned sessions)
      // are a different failure class from genuine processing bugs. They're
      // operational drift, not data corruption — repairman can't fix them.
      // Tag them with a distinct status, log as a structured warning (no stack),
      // and skip without spawning a repairman-notify.
      if (e.message && e.message.startsWith('Unknown target ')) {
        console.warn(`[QueueDispatcher] Skipping item ${item.id}: target "${item.target_session}" no longer resolves (decommissioned session). Item moved to skipped-unknown-target.`);
        item.status = 'skipped-unknown-target';
        item.error = e.message;
        item.failed_at = new Date().toISOString();
        changed = true;
        changedIds.add(item.id);
        continue;
      }
      console.error(`[QueueDispatcher] Item ${item.id} threw an error, marking as failed:`, e.message);
      item.status = 'failed';
      item.error = `Processing error: ${e.message}`;
      item.failed_at = new Date().toISOString();
      changed = true;
      changedIds.add(item.id);
      notifyRepairman(item.id, `Queue item threw error: ${e.message}`);
    }
  }

  if (changed) {
    // Write-back as a patch-by-id over a FRESH re-read, under the serialized
    // lock. This preserves any item a concurrent async confirm/enqueue added or
    // mutated while tick was working: we only overlay the ids tick itself
    // changed, and drop nothing that's still present in the fresh queue.
    const patched = new Map();
    for (const item of queue) {
      if (changedIds.has(item.id)) patched.set(item.id, item);
    }
    await mutateQueue(fresh => {
      for (let i = 0; i < fresh.length; i++) {
        const p = patched.get(fresh[i].id);
        if (!p) continue;
        // CONFIRM-WINS GUARD (re-delivery race fix 2026-08-03): tick computed
        // this item's transition off a STALE sync-read snapshot (readQueue at the
        // top of tick). Between that read and this write-back, an async confirm()
        // can land and move the item to a TERMINAL status ('confirmed', etc). The
        // classic trigger: Phase 1 resets a 30s-unconfirmed 'dispatched' item to
        // 'pending' while the target's roger-that is in flight — overlaying tick's
        // stale 'pending' over the fresh 'confirmed' clobbers the confirm, so the
        // next tick re-DELIVERS the same item (attempts:2/3). deliverNow already
        // has this guard (L1514); tick's write-back did not. Confirm is terminal —
        // if the fresh item advanced to terminal but tick's patch is non-terminal,
        // the confirm/fail wins: drop the overlay. (Same-or-terminal patches still
        // apply — e.g. tick itself marking an item 'failed' is honored.)
        if (TERMINAL_STATUSES.has(fresh[i].status) && !TERMINAL_STATUSES.has(p.status)) {
          continue;
        }
        fresh[i] = p;
      }
      return fresh;
    });
  }
}

/**
 * Look an id up in the dated archive files (queue-archive-YYYY-MM-DD.json).
 *
 * WHY (2026-09-01 — drop-detector false-positive fix): terminal items drain out
 * of the live queue after ARCHIVE_GRACE_MS. A roger-that that arrives (or is
 * re-issued) after that drain used to find nothing in queue.json and report
 * "not found", which is INDISTINGUISHABLE from "this id never existed" — and the
 * fleet drop-detector reads the latter as a dropped message, re-raising a
 * correction for a walkie that was in fact delivered and confirmed on time.
 * Consulting the archive is what makes "already confirmed" a distinct answer.
 *
 * Newest archive first (an id is far more likely recent), bounded to the most
 * recent ARCHIVE_LOOKBACK_FILES days so a long-lived install can't turn a roger
 * into a full-history scan.
 *
 * Returns the archived item, or null if the id is in no archive.
 */
const ARCHIVE_LOOKBACK_FILES = 7;

function listArchiveFiles() {
  try {
    return readdirSync(HOMESTEAD_DIR)
      .filter(f => /^queue-archive-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse()
      .slice(0, ARCHIVE_LOOKBACK_FILES);
  } catch (e) {
    console.error('[QueueDispatcher] listArchiveFiles: cannot list archives:', e.message);
    return [];
  }
}

function findInArchive(queueItemId) {
  for (const f of listArchiveFiles()) {
    try {
      const items = JSON.parse(readFileSync(join(HOMESTEAD_DIR, f), 'utf8'));
      if (!Array.isArray(items)) continue;
      const hit = items.find(i => i && i.id === queueItemId);
      if (hit) return hit;
    } catch (e) {
      console.error(`[QueueDispatcher] findInArchive: unreadable archive ${f}:`, e.message);
    }
  }
  return null;
}

/**
 * WRITE BACK a late roger-that onto an item that has ALREADY drained to the
 * archive.
 *
 * WHY (2026-09-02 — the write-side half of the tri-state fix). Consulting the
 * archive on the confirm miss-path (above) fixed how a late roger READS, but the
 * archived record itself was left untouched, so the WRITE was silently dropped.
 * A steward could roger a message correctly, get {confirmed:true} back, and the
 * persisted record would still say status:'failed' with no confirmed_by — for
 * good, since every re-roger hit the same read-only branch.
 *
 * The damage is to the FORENSIC RECORD, and that matters more than it sounds.
 * The archive is what every later reader reconstructs history from. A record
 * that lies "failed / never confirmed" about a message that WAS delivered and
 * WAS acknowledged doesn't merely lose data — it actively manufactures wrong
 * diagnoses downstream. (This fix's own investigation is the proof: two readers
 * independently built causal models on top of these false records — including a
 * confident but incorrect story about archived status driving notification
 * re-pushes — before the records were checked against the code. Nothing reads an
 * archived item's status to decide redelivery; the duplicate notifications had a
 * separate cause in the phone_seen_keys ledger.)
 *
 * How items reach this state: MAX_RETRIES(3) x CONFIRM_TIMEOUT_MS(30s) is about
 * a 90-second window, but a busy steward routinely rogers minutes later, so the
 * item terminalizes and drains before its roger lands. Observed on
 * 1788347913751-notif-push and 1788348001445-notif (both left status:'failed'
 * with no confirmed_by despite being rogered); 1788347913755-notif-push is the
 * control — same terminalization, but its roger arrived inside the 60s
 * ARCHIVE_GRACE_MS window, so the LIVE path flipped it correctly. The true
 * discriminator is rogered-before vs rogered-after the archive drain.
 * CONFIRM_WINDOW_MS (above) is the prevention half; this is the cure.
 *
 * So: flip the archived record to 'confirmed', stamp confirmed_at/confirmed_by,
 * and persist ATOMICALLY (temp+rename — the archive is read on the roger hot
 * path, and a torn read there degrades into the false "dropped message" the tri-
 * state fix exists to eliminate). Preserves the original terminal state in
 * `late_confirm_of` for forensics rather than erasing it.
 *
 * IDEMPOTENT: an already-confirmed archived record is a no-op — no rewrite of
 * the archive file, no clobbering of the original confirmed_at.
 *
 * Returns { found, changed, status, item } — `changed:false` with `found:true`
 * means it was already confirmed.
 */
function confirmInArchive(queueItemId, confirmedBy) {
  for (const f of listArchiveFiles()) {
    const archiveFile = join(HOMESTEAD_DIR, f);
    let items;
    try {
      items = JSON.parse(readFileSync(archiveFile, 'utf8'));
    } catch (e) {
      console.error(`[QueueDispatcher] confirmInArchive: unreadable archive ${f}:`, e.message);
      continue;
    }
    if (!Array.isArray(items)) continue;
    const idx = items.findIndex(i => i && i.id === queueItemId);
    if (idx === -1) continue;

    const item = items[idx];
    if (item.status === 'confirmed') {
      // Already terminal-confirmed. No write — idempotent.
      return { found: true, changed: false, status: item.status, item };
    }

    const prevStatus = item.status;
    item.status = 'confirmed';
    item.confirmed_at = new Date().toISOString();
    item.confirmed_late = true;
    item.late_confirm_of = prevStatus; // forensics: what it had terminalized as
    if (confirmedBy) {
      item.confirmed_by = confirmedBy;
      if (item.target_session && confirmedBy !== item.target_session) {
        console.warn(`[QueueDispatcher] MISROUTE detected (archived): ${queueItemId} target=${item.target_session} confirmed_by=${confirmedBy}`);
      }
    }

    try {
      writeJsonAtomicSync(archiveFile, items);
    } catch (e) {
      console.error(`[QueueDispatcher] confirmInArchive: FAILED to persist late confirm for ${queueItemId} in ${f}:`, e.message);
      return { found: true, changed: false, status: prevStatus, item, error: e.message };
    }
    console.log(`[QueueDispatcher] LATE CONFIRM written back to archive: ${queueItemId} (${prevStatus} -> confirmed)${confirmedBy ? ` by ${confirmedBy}` : ''}`);
    return { found: true, changed: true, status: 'confirmed', previous_status: prevStatus, item };
  }
  return { found: false, changed: false };
}

/**
 * Confirm receipt of a queue item.
 * Called by the receiving agent after it processes the message.
 *
 * TRI-STATE (2026-09-01). A bare boolean collapsed two very different answers
 * into `false`, and the fleet drop-detector read both as "dropped":
 *   { confirmed: true }                     — just confirmed now
 *   { confirmed: true, already: true }      — was already confirmed (live OR archived)
 *   { confirmed: false, reason:'not_found' }— genuinely unknown id (neither live nor archived)
 * Only the third is a real miss. Callers that just want a boolean can read
 * `.confirmed`.
 */
// ASYNC + serialized (event-loop wedge fix): the roger-that hot path. Each
// confirm now runs its read-modify-write under mutateQueue()'s single-flight
// lock via fs.promises, so a fleet-wide roger burst interleaves on the loop
// instead of blocking it. Returns a Promise<object>; callers await it.
async function confirm(queueItemId, confirmedBy) {
  const outcome = await mutateQueue(queue => {
    const item = queue.find(i => i.id === queueItemId);
    if (!item) {
      return { queue, result: { ok: false } };
    }
    if (item.status === 'confirmed') {
      return { queue, result: { ok: true, alreadyConfirmed: true, item } }; // idempotent
    }
    item.status = 'confirmed';
    item.confirmed_at = new Date().toISOString();
    if (confirmedBy) {
      item.confirmed_by = confirmedBy;
      if (item.target_session && confirmedBy !== item.target_session) {
        console.warn(`[QueueDispatcher] MISROUTE detected: ${queueItemId} target=${item.target_session} confirmed_by=${confirmedBy}`);
      }
    }
    return { queue, result: { ok: true, item } };
  });

  if (!outcome || !outcome.ok) {
    // Not in the LIVE queue — but it may simply have drained to the archive
    // after a perfectly good confirm. Check before calling it a miss.
    // WRITE BACK (2026-09-02): reading the archive is not enough. If the item
    // terminalized as 'failed' before this (perfectly valid) roger arrived, the
    // read-only branch that used to live here threw the confirm away — leaving a
    // permanent record that says "failed / never confirmed" about a message that
    // was in fact acknowledged, and no re-roger could ever correct it. Flip it,
    // stamp it, persist it atomically. Idempotent: an already-confirmed archived
    // record is a no-op. See confirmInArchive() above.
    const writeBack = confirmInArchive(queueItemId, confirmedBy);
    if (writeBack.found) {
      if (writeBack.changed) {
        emitSocket('walkie:confirmed', {
          id: queueItemId,
          target_session: writeBack.item && writeBack.item.target_session,
          confirmed_by: confirmedBy || null,
          late: true,
        });
        return {
          confirmed: true,
          already: true,
          archived: true,
          late: true,
          status: writeBack.status,
          previous_status: writeBack.previous_status,
        };
      }
      console.log(`[QueueDispatcher] Confirm: ${queueItemId} already terminal in archive (status=${writeBack.status}) — reporting already-confirmed`);
      return { confirmed: true, already: true, archived: true, status: writeBack.status };
    }
    console.log(`[QueueDispatcher] Confirm: item ${queueItemId} not found (neither live queue nor archive)`);
    return { confirmed: false, reason: 'not_found' };
  }

  if (outcome.alreadyConfirmed) {
    // CANCEL EVEN ON AN ALREADY-CONFIRMED ITEM (Alfred-flagged 2026-09-06).
    // This early-return used to sit BEFORE the cancel block below, so an item
    // confirmed by a path that doesn't reach this endpoint (pull_next_message
    // writes queue.json directly from the walkie-talkie MCP process) could not
    // have its in-flight paste cancelled: the drain marked it 'confirmed', the
    // later roger hit this branch and returned, and the delivery already
    // scheduled on the target's chain still pasted. Net effect: a pull-drained
    // item was re-delivered anyway, burning a turn per item.
    // Report whether a paste was actually suppressed. `already:true` alone is
    // ambiguous — it says the same thing whether or not an in-flight delivery
    // was cancelled, and a caller (Alfred, 2026-09-06) reasonably read it as
    // "so it won't come back" through four straight redeliveries. Make the
    // answer explicit rather than something the caller has to infer.
    let cancelledInFlight = false;
    if (inFlightDeliveries.has(queueItemId)) {
      cancelledDeliveries.add(queueItemId);
      cancelledInFlight = true;
      console.log(`[QueueDispatcher] Confirm: ${queueItemId} already confirmed but had a delivery in flight — marked CANCELLED so it will not be pasted again`);
    }
    return { confirmed: true, already: true, cancelled_in_flight: cancelledInFlight };
  }

  // CANCEL ANY IN-FLIGHT/QUEUED REDELIVERY (2026-09-01). Tri-state fixes how a
  // LATER roger READS; this stops a redelivery that is already scheduled on the
  // target's chain from firing at all. Without it the duplicate still lands and
  // the loop survives in weaker form.
  let cancelledInFlight = false;
  if (inFlightDeliveries.has(queueItemId)) {
    cancelledDeliveries.add(queueItemId);
    cancelledInFlight = true;
    console.log(`[QueueDispatcher] Confirm: ${queueItemId} had a delivery in flight — marked CANCELLED so it will not be pasted again`);
  }

  console.log(`[QueueDispatcher] Confirmed: ${queueItemId}${confirmedBy ? ` by ${confirmedBy}` : ''}`);
  emitSocket('walkie:confirmed', { id: queueItemId, target_session: outcome.item.target_session, confirmed_by: confirmedBy || null });
  return { confirmed: true, cancelled_in_flight: cancelledInFlight };
}

/**
 * Auto-notify the repairman when queue items fail due to malformed data or errors.
 * Enqueues a message to holler-repairman with the error details.
 * Avoids infinite loops by never notifying about its own notification failures.
 */
// ASYNC (event-loop wedge fix): appends the repairman notice through the
// serialized mutateQueue() lock. Called fire-and-forget from tick (not awaited),
// so its rejection is swallowed here rather than propagating into the tick loop.
async function notifyRepairman(failedItemId, errorDetails) {
  try {
    // Don't notify about failures in notifications to the repairman itself
    if (failedItemId && failedItemId.startsWith('repairman-notify-')) return;

    const notifyItem = {
      id: `repairman-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      target_session: 'holler-repairman',
      message: JSON.stringify({
        type: 'action',
        from: 'queue-dispatcher',
        instruction: `Queue dispatcher error: Item ${failedItemId} failed. Error: ${errorDetails}. Check queue.json for the malformed item.`
      }),
      status: 'pending',
      created_at: new Date().toISOString()
    };
    await mutateQueue(queue => { queue.push(notifyItem); return queue; });
    console.log(`[QueueDispatcher] Notified repairman about failed item ${failedItemId}`);
  } catch (e) {
    console.error(`[QueueDispatcher] Failed to notify repairman:`, e.message);
  }
}

/**
 * Add an item to the queue programmatically
 */
// ASYNC + serialized (event-loop wedge fix): remove a queue item by id under the
// lock. Returns a Promise<boolean> — true if an item was removed. Replaces the
// sync readFileSync+filter+writeFileSync that the DELETE /api/queue/:id handler
// did inline, which was a per-request whole-file RMW on the wedge-prone path.
async function removeItem(queueItemId) {
  return mutateQueue(queue => {
    const filtered = queue.filter(item => item.id !== queueItemId);
    if (filtered.length === queue.length) return { queue, result: false };
    return { queue: filtered, result: true };
  });
}

// ASYNC + serialized (event-loop wedge fix): enqueue's read-modify-write now
// runs under mutateQueue()'s lock via fs.promises. Returns a Promise<item>;
// callers await it. The item is built OUTSIDE the lock so its id/created_at are
// stable, then pushed inside the critical section.
async function enqueue(targetSession, message) {
  if (!targetSession || typeof targetSession !== 'string') {
    throw new Error(`enqueue: target_session must be a non-empty string, got ${JSON.stringify(targetSession)}`);
  }

  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    target_session: targetSession,
    message,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  await mutateQueue(queue => { queue.push(item); return queue; });
  console.log(`[QueueDispatcher] Enqueued message for ${targetSession}: ${message.slice(0, 80)}...`);

  // Potato tracker OBSERVATION (non-blocking, never alters the message).
  // This single enqueue choke point carries BOTH:
  //   • BIRTH — a Josh-originated send (envelope from='josh-presenter'): record a
  //     tracker-side owed-response held by targetSession.
  //   • CLOSE — any other outbound (envelope from='<sender-session>'): if that
  //     sender currently holds OPEN potatoes, its next-outbound-to-anyone CLOSES
  //     them (pure-code close — no potato_id echo, no card required). The static
  //     corrections-officer identity is excluded inside recordCloseFromQueueItem
  //     so a ring can never close its own potato.
  // A birth and a close are mutually exclusive per item (isJoshOriginated gates
  // each), so we call both — at most one fires. Wrapped so a tracker fault can
  // never break dispatch.
  if (potatoTracker) {
    try {
      const born = potatoTracker.recordBirthFromQueueItem({
        queueItemId: item.id,
        targetSession,
        message,
      });
      if (born) {
        emitSocket('potato:born', { potato_id: born.potato_id, holder: born.holder, surface: born.origin_surface });
      } else {
        // Not a birth — the sender's next outbound closes any potato it holds.
        const closed = potatoTracker.recordCloseFromQueueItem({
          queueItemId: item.id,
          message,
        });
        for (const rec of closed || []) {
          emitSocket('potato:closed', { potato_id: rec.potato_id, closed_by: rec.closed_by });
        }
      }
    } catch (e) {
      console.error('[QueueDispatcher] potato observe (enqueue) failed (non-fatal):', e.message);
    }
  }

  // Real-time signal: presenter UI subscribes to this so it can resolve the
  // bottom-bar send promise the instant the message lands on the laptop —
  // replacing the old 24-35s "watch /api/queue for new items" poll that
  // produced fake "voice send failed" toasts when the poll outran transcription.
  emitSocket('walkie:enqueued', { id: item.id, target_session: targetSession, created_at: item.created_at, message });
  return item;
}

/**
 * Drain terminal (confirmed/failed/skipped-unknown-target) items to dated
 * archive files once they've lingered past ARCHIVE_GRACE_MS. Active items
 * (pending/dispatched) always stay in queue.json.
 *
 * This runs on every dispatcher tick (cheap — early-returns when nothing is
 * eligible), so confirmed walkies drain within ~a minute of confirmation
 * instead of aging out at 24h. Keeping the live queue small is what bounds the
 * per-tick JSON.parse cost across the whole fleet.
 *
 * Archive is preferred over hard-delete: skipped-unknown-target (misroute) and
 * failed items are forensic gold, so they land in
 * ~/.homestead/queue-archive-YYYY-MM-DD.json rather than being dropped.
 */
// ASYNC + serialized (event-loop wedge fix): runs its read-modify-write of the
// live queue under mutateQueue()'s lock so a tick-driven drain can never race
// (and clobber) an in-flight async confirm/enqueue write. Called fire-and-forget
// from runDispatch on the interval — its Promise is not awaited, which is fine.
// The per-date archive-file writes stay sync: they touch SEPARATE files, not the
// hot queue.json, and are only reached when items actually drain (rare per tick).
async function cleanQueue() {
  return mutateQueue(queue => {
  const graceCutoff = Date.now() - ARCHIVE_GRACE_MS;
  const keep = [];
  const toArchive = [];

  for (const item of queue) {
    if (!TERMINAL_STATUSES.has(item.status)) {
      // pending, dispatched, or any unexpected non-terminal status — keep live
      keep.push(item);
      continue;
    }
    const timestamp = item.confirmed_at || item.failed_at || item.created_at;
    // Missing/unparseable timestamp -> treat as immediately archivable (an old
    // terminal item with no timestamp is exactly the cruft we want to drain).
    const ts = timestamp ? new Date(timestamp).getTime() : 0;
    if (!Number.isFinite(ts) || ts <= graceCutoff) {
      toArchive.push(item);
    } else {
      keep.push(item);
    }
  }

  // Step 2 — burst safety valve. If, after the grace-window drain, the live
  // queue is still over the cap, force-archive the oldest *terminal-but-still-
  // in-grace* items until we're back under. Never touches pending/dispatched.
  if (keep.length > MAX_LIVE_QUEUE) {
    // Candidates: terminal items we kept only because they're inside the grace
    // window. Oldest first, so we shed the least-recently-relevant.
    const capCandidates = keep
      .filter(i => TERMINAL_STATUSES.has(i.status))
      .sort((a, b) => {
        const ta = new Date(a.confirmed_at || a.failed_at || a.created_at || 0).getTime();
        const tb = new Date(b.confirmed_at || b.failed_at || b.created_at || 0).getTime();
        return ta - tb;
      });
    const overBy = keep.length - MAX_LIVE_QUEUE;
    const forced = new Set(capCandidates.slice(0, overBy).map(i => i.id));
    if (forced.size > 0) {
      console.warn(`[QueueDispatcher] Live queue ${keep.length} > cap ${MAX_LIVE_QUEUE}; force-archiving ${forced.size} in-grace terminal items (burst safety)`);
      const stillKeep = [];
      for (const item of keep) {
        if (forced.has(item.id)) toArchive.push(item);
        else stillKeep.push(item);
      }
      keep.length = 0;
      keep.push(...stillKeep);
    }
  }

  if (toArchive.length === 0) return NO_CHANGE;

  // Group archived items by date for dated archive files
  const byDate = {};
  for (const item of toArchive) {
    const ts = item.confirmed_at || item.failed_at || item.created_at;
    const date = ts ? ts.slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(item);
  }

  // Append to each dated archive file
  for (const [date, items] of Object.entries(byDate)) {
    const archiveFile = join(HOMESTEAD_DIR, `queue-archive-${date}.json`);
    let existing = [];
    try {
      if (existsSync(archiveFile)) {
        existing = JSON.parse(readFileSync(archiveFile, 'utf8'));
      }
    } catch (e) {
      console.error(`[QueueDispatcher] Error reading archive ${archiveFile}:`, e.message);
      existing = [];
    }
    existing.push(...items);
    // ATOMIC (2026-09-01): temp+rename. This became load-bearing when confirm()
    // started CONSULTING the archive on the roger-that miss path — a torn read
    // there throws, gets caught, and falls through to `not_found`, which is
    // precisely the false "dropped message" this change exists to eliminate.
    // (Same reason every queue.json writer is atomic; see lib/atomic-write.js.)
    writeJsonAtomicSync(archiveFile, existing);
  }

  console.log(`[QueueDispatcher] Archived ${toArchive.length} items to dated archive files`);
  return keep;
  });
}

/**
 * Process deferred timers — fires time-based and event-based timers.
 * Called on each dispatcher tick.
 */
// ASYNC (event-loop wedge fix): the timers file (a SEPARATE, tiny file) is still
// read/written sync — it never bursts. But items produced by fired timers are
// appended to the hot queue through mutateQueue()'s lock so the append can't race
// an in-flight async confirm/enqueue write. Fire-and-forget from runDispatch.
async function processTimers() {
  let timers;
  try {
    if (!existsSync(TIMERS_FILE)) return;
    timers = JSON.parse(readFileSync(TIMERS_FILE, 'utf-8'));
  } catch {
    return;
  }

  if (!timers || !timers.length) return;

  const now = new Date();
  let timersChanged = false;
  const toEnqueue = []; // queue items produced by fired timers, pushed under the lock below

  for (const timer of timers) {
    if (timer.status !== 'pending') continue;

    let shouldFire = false;

    // Time-based: check if fire time has passed
    if (timer.type === 'time' && timer.fires_at && new Date(timer.fires_at) <= now) {
      shouldFire = true;
    }

    // Event-based: two watch modes.
    //   watch_mode "idle" (idle check-in timer, 2026-08-21): fire when the watched
    //     session is ALIVE but IDLE (finished working, waiting at its prompt). Uses
    //     isSessionWorking() — the same is_working activity file source of truth. A
    //     fresh worker has no activity file yet, so a naive idle check would misfire
    //     the instant it spawns. GUARD: a seen_working LATCH — the timer only becomes
    //     fireable once we've observed the watched session WORKING at least once. So
    //     idle can only fire AFTER a real work->idle transition.
    //   watch_mode "gone" / unset (legacy default): fire when the watched session is
    //     no longer active (torn down). Unchanged — zero regression for existing timers.
    if (timer.type === 'event' && timer.watch_session) {
      const mode = timer.watch_mode || 'gone';
      if (mode === 'idle') {
        const alive = sessionExists(timer.watch_session);
        if (alive) {
          if (isSessionWorking(timer.watch_session)) {
            if (!timer.seen_working) { timer.seen_working = true; timersChanged = true; }
          } else if (timer.seen_working) {
            shouldFire = true;
          }
        }
        // If the session died before ever idling, it drops via the 24h cleanup below.
      } else {
        if (!sessionExists(timer.watch_session)) shouldFire = true;
      }
    }

    if (shouldFire) {
      // Idle check-in envelopes: the message IS already a JSON envelope (trigger/
      // worker/etc). Stamp idle_since at the actual fire moment and pass it through
      // verbatim so the Top receives the exact contract shape.
      let envelope;
      if (timer.checkin_envelope) {
        let parsed;
        try { parsed = JSON.parse(timer.message); } catch { parsed = null; }
        if (parsed && typeof parsed === 'object') {
          parsed.idle_since = new Date().toISOString();
          parsed._timer_id = timer.id;
          envelope = JSON.stringify(parsed);
        } else {
          envelope = JSON.stringify({
            type: 'action', from: timer.created_by, instruction: timer.message,
            _timer_id: timer.id, _timer_context: timer.context,
          });
        }
      } else {
        envelope = JSON.stringify({
        type: 'action',
        from: timer.created_by,
        instruction: timer.message,
        _timer_id: timer.id,
        _timer_context: timer.context,
      });
      }

      toEnqueue.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        target_session: timer.target_session,
        type: 'action',
        message: envelope,
        status: 'pending',
        created_at: new Date().toISOString(),
        source: 'timer',
        timer_id: timer.id,
      });

      timer.status = 'fired';
      timer.fired_at = new Date().toISOString();
      timersChanged = true;
      console.log(`[QueueDispatcher] Timer ${timer.id} fired → ${timer.target_session}`);
    }
  }

  // Clean up old fired timers (older than 24h)
  const cutoff = new Date(Date.now() - 86400000);
  const cleaned = timers.filter(t =>
    t.status === 'pending' || new Date(t.created_at) > cutoff
  );
  if (cleaned.length !== timers.length) timersChanged = true;

  if (timersChanged) {
    try { writeFileSync(TIMERS_FILE, JSON.stringify(cleaned, null, 2)); } catch {}
  }
  if (toEnqueue.length) {
    await mutateQueue(queue => { queue.push(...toEnqueue); return queue; });
  }
}

module.exports = {
  tick,
  enqueue,
  confirm,
  removeItem,
  cleanQueue,
  readQueue,
  // Async, serialized read-modify-write (event-loop wedge fix). mutateQueue is
  // the canonical way to change the queue off the hot path; readQueueAsync is a
  // non-blocking read for callers that can await.
  mutateQueue,
  readQueueAsync,
  isSessionReady,
  sessionExists,
  processTimers,
  setIo,
  // Exposed for v3 patch test harness:
  needsClaudeRestart,
  isTargetDownOrResuming,
  isRespawnInProgress,
  // Exposed for the paste-race fix test harness (2026-07-29). capturePaneIdle is
  // still used internally by isSessionReady's stale-idle discrimination.
  capturePaneIdle,
  // Mid-stream inject path (2026-08-01, Josh directive — alive-only, no idle gate):
  injectNow,
  deliverNow,
  sendMessage,
  // Exposed for the non-destructive-resume proof harness (2026-07-30):
  resumeComputeSuspend,
  // Exposed for the wake_failure_hard 3-strike proof harness (2026-08-09):
  handleWakeFailure,
  // Exposed for the lost-kickoff-on-spawn proof harness (2026-08-31):
  paneInputBoxEmpty,
  boxContentIsEmpty,
  readPaneInputBox,
  isFreshSpawn,
  sessionAgeMs,
  waitForFreshPanePasteReady,
  verifySubmitted
};
