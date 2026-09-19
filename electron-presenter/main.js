const { app, BrowserWindow, ipcMain, globalShortcut, shell } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');

const PORT = 3847;
const SERVER_URL = 'http://localhost:3005';
const PID_DIR = path.join(require('os').homedir(), '.presenter');
const PID_FILE = path.join(PID_DIR, 'presenter.pid');
const SETTINGS_FILE = path.join(PID_DIR, 'settings.json');

// --- Window geometry defaults ---
const COLLAPSED_WIDTH = 80;
const COLLAPSED_HEIGHT = 30;
const DEFAULT_WIDTH = 380;
const DEFAULT_OPACITY = 0.92;
const DEFAULT_FONT_SIZE = 14;

// --- UI zoom ---
// The per-element font-size setting only reaches ~7 selectors (message body,
// buttons, textarea); titles, timestamps, avatar bars and the bottom toolbar
// are all hardcoded px and never move. That's why turning the font up still
// read as "too small" to Josh. Zoom scales the ENTIRE renderer uniformly, the
// way browser zoom does, so everything grows together.
const DEFAULT_ZOOM = 1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

function clampZoom(z) {
  const n = typeof z === 'number' && isFinite(z) ? z : DEFAULT_ZOOM;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100));
}

// Apply zoom to the expanded window and persist it. Kept in one place so the
// hotkeys, the restore-on-load path and any IPC caller can't drift apart.
function applyZoom(nextZoom, { persist = true } = {}) {
  const zoom = clampZoom(nextZoom);
  if (win && !win.isDestroyed()) {
    win.webContents.setZoomFactor(zoom);
  }
  if (persist) saveSettings({ zoom });
  return zoom;
}

// --- Persistent settings ---
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveSettings(updates) {
  try {
    fs.mkdirSync(PID_DIR, { recursive: true });
    const current = loadSettings();
    const merged = { ...current, ...updates };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.error('[Presenter] Failed to save settings:', e.message);
  }
}

let saveTimeout = null;
function debouncedSaveSettings(updates) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveSettings(updates), 500);
}

// --- Robust window-bounds persistence across display-resolution changes ---
//
// When the display resolution changes (e.g. the phone-driven "Grandpa Mode"
// flips the Mac to a scaled resolution and back), macOS repositions/resizes
// our window and fires transient 'moved'/'resized' events with coordinates
// valid only for the scaled resolution. Naively persisting those pollutes
// settings.json, so after flipping back to native the saved x/y mis-place the
// window (Josh's upper-right pin ended up dead-center).
//
// We can't just suppress-on-metrics-change: empirically the polluting 'moved'
// fires ~16ms BEFORE its 'display-metrics-changed' event, so arming after the
// event is too late. Instead we SETTLE-AND-RECONCILE: on any 'moved'/'resized'
// we wait BOUNDS_SETTLE_MS, then only persist if (a) the bounds are still the
// same as when the event fired (a res-flip transient snaps back within that
// window, so it won't be stable) AND (b) no display-metrics change happened
// recently. A genuine user drag is stable and has no recent metrics change, so
// it still saves. Verified: res-flip round-trip persists nothing; real drags
// persist correctly.
const BOUNDS_SETTLE_MS = 700;
const METRICS_GRACE_MS = 1500;
let lastMetricsChangeAt = 0;
let boundsSettleTimer = null;

// Persist window bounds only once they've settled and aren't the byproduct of
// a resolution change. `readBounds()` returns the CURRENT {x,y,width,height}
// subset to save; we snapshot it now and re-read after the settle delay.
function saveBoundsWhenSettled(readBounds) {
  const before = readBounds();
  if (boundsSettleTimer) clearTimeout(boundsSettleTimer);
  boundsSettleTimer = setTimeout(() => {
    const after = readBounds();
    const stable = JSON.stringify(before) === JSON.stringify(after);
    const recentMetrics = (Date.now() - lastMetricsChangeAt) < METRICS_GRACE_MS;
    if (stable && !recentMetrics) {
      saveSettings(after);
    }
  }, BOUNDS_SETTLE_MS);
}

// --- Singleton check via PID file ---

function checkSingleton() {
  try {
    fs.mkdirSync(PID_DIR, { recursive: true });
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      try {
        process.kill(oldPid, 0); // Check if process exists
        // Verify it's actually an Electron/presenter process, not a recycled PID
        const cmdline = execSync(`ps -p ${oldPid} -o comm=`, { encoding: 'utf-8' }).trim();
        if (cmdline.includes('Electron') || cmdline.includes('electron')) {
          console.error(`Presenter already running (PID ${oldPid}). Exiting.`);
          process.exit(0);
        }
        // PID exists but isn't Electron — stale PID file
      } catch {
        // Old process is dead, clean up stale PID file
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (err) {
    console.error('PID file error:', err.message);
  }
}

function cleanupPid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

checkSingleton();
process.on('exit', cleanupPid);
process.on('SIGINT', () => { cleanupPid(); process.exit(); });
process.on('SIGTERM', () => { cleanupPid(); process.exit(); });

// --- Local queue state (mirror of server queue) ---

let queue = [];
let win = null;        // expanded window
let barWin = null;     // collapsed bar window
let socket = null;
// --- Whisper Village peek duck ---
//
// We float at level 'screen-saver' (CG layer 1000) so we cover full-screen
// Chrome — that is deliberate and Josh relies on it. But WV's peek toast is an
// NSPanel at level .mainMenu (CG layer 24) positioned centre-bottom, which on
// his layout lands 100% INSIDE our window rect. 24 < 1000, so we hide it
// completely. While a peek is up we drop to 'floating' so it shows through.
//
// This used to be a naive toggle (`presenterDucked = !presenterDucked`) and it
// drifted permanently out of sync, because the peek is WV's window, not ours:
// PeekToastView auto-dismisses on a countdown (and has a close X, and
// hover-pause). So the peek closes ON ITS OWN, with no second Alt+P — after
// the very first peek the boolean was inverted forever, and every later press
// did the opposite of what Josh wanted. Hence the bug he reported.
//
// The fix: never toggle, and never guess. `duckDepth` counts REASONS to be
// ducked and the level is recomputed from it, so it is idempotent — duplicate
// or out-of-order signals cannot wedge it. Sources of truth, in order:
//   1. WV pushes POST /wv-peek {visible} the moment its peek panel opens or
//      closes. That is driven by the panel's OWN close notification, so it
//      covers every close path including ones that never call dismiss.
//   2. Alt+P optimistically ducks (never restores — Alt+P always means
//      "show me the peek"), so we're right even before WV reports in.
//   3. A reconciler that ASKS WV what its peek is really doing and makes our
//      level match — in BOTH directions, so a stray or lost message from (1)
//      self-heals within one interval instead of persisting.
//
// ⚠️ Why (3) asks instead of just expiring a timer: hovering the toast pauses
// its auto-dismiss with NO upper bound (PeekToastView.onHover invalidates the
// timer and nothing caps it). So there is no duration we could wait that is
// guaranteed to be "longer than the max" — a peek Josh is reading can outlive
// any constant. A blind timer would yank the presenter back on top of a peek
// he is actively reading, which is exactly the complaint we are fixing.
// Where WV genuinely cannot answer, prefer the harmless failure: being ducked
// with nothing on screen is invisible to Josh, whereas covering a live peek is
// the bug itself.
let duckDepth = 0;          // >0 = ducked. Counts reasons, never flips.
let duckReconciler = null;  // interval that re-checks WV's real peek state
let peekWatch = null;       // slower interval that catches a MISSED duck
let peekVisibleFromWV = false; // last state WV actually reported

// How often to re-ask WV whether the peek is still up, while we are ducked.
// Cheap (loopback GET) and only runs while ducked.
const DUCK_RECONCILE_MS = 2000;

// How often to check whether we MISSED a peek opening, while not ducked.
// Deliberately slower: this is the always-on half, and a dropped duck signal is
// far rarer than the ordinary close it already handles via the 2s loop.
const PEEK_WATCH_MS = 5000;

// Bump on every behavioural change here, so verification can never pass
// against a presenter process that predates the fix (CLAUDE.md build-marker
// rule — a running process silently serving old code is the classic trap).
const PEEK_DUCK_BUILD = 5;
let isExpanded = true; // start expanded
// Active reading-mode theme preset ('off' | 'iowa' | 'gruvbox' |
// 'gruvbox-hard'). The main renderer owns this in localStorage; it's pushed
// to us via the 'set-theme' IPC so the collapsed bar can theme its pill to
// match. Seeded from persisted settings so the bar renders correctly at
// startup before the renderer reports in.
let currentThemePreset = loadSettings().readingPreset || 'off';

// Mini-bar badge counts ONLY steward-attributable cards (session_id prefixed
// `holler-`). Job-scheduler backstop cards (`session_id: "job-scheduler"`,
// `category: "job_failure_alarm_backstop"`) are intentional historical
// alarms — the main UI hides them via the steward-session-id filter in
// renderer/app.js (getItemsForSteward). Pre-2026-06-27 the badge counted
// the raw queue.length so Joshua saw mini-badge=33 while the main UI
// showed ~13. Fixed at source per Joshua's verbatim "the only cards we
// count are ones that are under the stewards."
function getStewardQueueCount() {
  return queue.filter(item =>
    typeof item.session_id === 'string' && item.session_id.startsWith('holler-')
  ).length;
}

function pushQueueToRenderer() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('queue-update', queue);
  }
  if (barWin && !barWin.isDestroyed()) {
    barWin.webContents.send('queue-count', getStewardQueueCount());
  }
}

// Push the active reading-mode theme to the collapsed bar so its pill matches
// the rest of the presenter UI (mirrors pushQueueToRenderer's queue-count).
function pushThemeToBar() {
  if (barWin && !barWin.isDestroyed()) {
    barWin.webContents.send('theme', currentThemePreset);
  }
}

function playSound() {
  // Quiet hours: no sound between midnight and 6 AM
  const hour = new Date().getHours();
  if (hour < 6) return;
  try {
    execSync('afplay /System/Library/Sounds/Glass.aiff &', { stdio: 'ignore' });
  } catch {}
}

function showWindow() {
  if (isExpanded) {
    if (win && win.isMinimized()) win.restore();
    if (win) win.show();
  } else {
    // Auto-expand when new items arrive
    expandPresenter();
  }
}

// Shared shell-exec helper for both the IPC `run-command` (from local renderer)
// and the socket-bridged `presenter:exec-shell` (from server, originating APK).
function runShellCommand(command, origin) {
  if (!command || typeof command !== 'string') return;
  exec(command, { shell: '/bin/zsh', timeout: 30000 }, (err, stdout, stderr) => {
    if (err) console.error(`[run-command:${origin}] error: ${err.message}`);
    if (stdout) console.error(`[run-command:${origin}] stdout: ${stdout.trim()}`);
    if (stderr) console.error(`[run-command:${origin}] stderr: ${stderr.trim()}`);
  });
}

// --- Connect to Homestead server via Socket.IO ---

function connectToServer() {
  // Dynamic import since socket.io-client is ESM-friendly but we're in CJS
  const { io } = require('socket.io-client');

  socket = io(SERVER_URL, {
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    console.error('[Presenter] Connected to Homestead server');
    // Register as electron presenter client for delivery tracking
    socket.emit('presenter:register', 'electron');
    // Fetch current queue on connect
    fetchQueue();
  });

  socket.on('disconnect', () => {
    console.error('[Presenter] Disconnected from Homestead server');
  });

  socket.on('presenter:new-item', (item) => {
    console.error(`[Presenter] New item: ${item.id} - ${item.title}`);
    // Acknowledge delivery back to server
    socket.emit('presenter:ack', item.id);
    if (!queue.find(i => i.id === item.id)) {
      if (item.priority === 'urgent') {
        queue.splice(1, 0, item);
      } else {
        queue.push(item);
      }
      pushQueueToRenderer();
      playSound();
    }
  });

  socket.on('presenter:item-resolved', ({ id }) => {
    console.error(`[Presenter] Item resolved: ${id}`);
    queue = queue.filter(i => i.id !== id);
    pushQueueToRenderer();
  });

  // Item updated in place (e.g. pin toggle). Patch the in-memory queue item
  // with the new fields so the renderer sees the change without a full refetch.
  socket.on('presenter:item-updated', ({ id, fields }) => {
    if (!id || !fields) return;
    const item = queue.find(i => i.id === id);
    if (!item) return;
    Object.assign(item, fields);
    pushQueueToRenderer();
  });

  // Server-bridged shell exec. Triggered when a non-Electron client (APK,
  // browser) clicks a scripted bookmark and POSTs to /api/presenter/run-command.
  // Server validates the command against the saved bookmark store BEFORE
  // emitting this — main.js trusts that the bridge has already enforced the
  // allowlist.
  socket.on('presenter:exec-shell', ({ command }) => {
    runShellCommand(command, 'socket');
  });

  // Consolidated bulk-dismiss event — payload: { ids: [...] }
  socket.on('presenter:bulk-resolved', ({ ids }) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    console.error(`[Presenter] Bulk resolved: ${ids.length} cards`);
    const toRemove = new Set(ids);
    queue = queue.filter(i => !toRemove.has(i.id));
    pushQueueToRenderer();
  });

  // Session lifecycle — forward to renderer so it can re-fetch /api/stewards.
  // Expected payloads: { sessionId, parent? } (Web owns the shape).
  socket.on('session:created', (payload) => {
    console.error(`[Presenter] session:created: ${payload && payload.sessionId}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('session-event', { type: 'created', payload });
    }
  });
  socket.on('session:deleted', (payload) => {
    console.error(`[Presenter] session:deleted: ${payload && payload.sessionId}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('session-event', { type: 'deleted', payload });
    }
  });
}

async function fetchQueue() {
  try {
    const res = await fetch(`${SERVER_URL}/api/presenter/queue`);
    const data = await res.json();
    queue = data.queue || [];
    pushQueueToRenderer();
  } catch (err) {
    console.error('[Presenter] Failed to fetch queue:', err.message);
  }
}

async function respondToServer(id, response) {
  const endpoint = response.dismissed
    ? `${SERVER_URL}/api/presenter/dismiss`
    : `${SERVER_URL}/api/presenter/respond`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...response }),
  });
  // 404 = card already resolved/dismissed elsewhere — treat as success
  // (matches the cardComponentRespond convention in renderer/app.js).
  if (!res.ok && res.status !== 404) {
    throw new Error(`respond HTTP ${res.status}`);
  }
}

// --- HTTP server (health check + legacy fallback) ---

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      queue: queue.length,
      pid: process.pid,
      server_connected: socket?.connected || false,
      mode: isExpanded ? 'expanded' : 'collapsed',
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/queue') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queue }));
    return;
  }

  // Whisper Village tells us when its peek toast opens/closes, so our window
  // level follows the peek's REAL state instead of a local guess that drifts.
  // Body: {"visible": true|false}. Fire-and-forget on WV's side; we answer
  // immediately and never make it wait on us.
  if (req.method === 'POST' && req.url === '/wv-peek') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let visible = false;
      try { visible = !!JSON.parse(body || '{}').visible; } catch { /* treat garbage as closed */ }
      peekVisibleFromWV = visible;
      if (visible) duckForPeek('wv-peek:visible');
      else restoreFromPeek('wv-peek:hidden');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ducked: duckDepth > 0 }));
    });
    return;
  }

  // Read-only view of the duck state — lets us verify the fix without
  // guessing at window levels from outside.
  if (req.method === 'GET' && req.url === '/wv-peek') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ducked: duckDepth > 0,
      duckDepth,
      peekVisibleFromWV,
      reconciling: !!duckReconciler,
      level: duckDepth > 0 ? 'floating' : 'screen-saver',
      duckBuild: PEEK_DUCK_BUILD,
    }));
    return;
  }

  // Legacy /present-async — proxy to server
  if (req.method === 'POST' && req.url === '/present-async') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const serverRes = await fetch(`${SERVER_URL}/api/presenter/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const result = await serverRes.json();
        res.writeHead(serverRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server unreachable: ' + err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// --- Whisper Village peek duck ---

// Apply the window level implied by duckDepth. Idempotent: safe to call as
// often as we like, and the ONLY place the level is set for ducking. Level is
// per-window, so the expanded window and the collapsed bar must move together
// — otherwise the bar alone would still cover the peek.
function applyDuckLevel(reason) {
  const ducked = duckDepth > 0;
  const level = ducked ? 'floating' : 'screen-saver';
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, level);
  if (barWin && !barWin.isDestroyed()) barWin.setAlwaysOnTop(true, level);
  console.error(`[Presenter] peek-duck: ${ducked ? 'DUCKED' : 'RESTORED'} level=${level} depth=${duckDepth} reason=${reason}`);
}

// While ducked, periodically ASK Whisper Village what its peek is actually
// doing, and make our window level match.
//
// This replaces a plain expiry timer on purpose. Hover-pause on the toast has
// no upper bound (PeekToastView.onHover invalidates the countdown and nothing
// caps it), so no fixed duration can be safely "longer than the longest peek" —
// a blind timer would pop the presenter back over a peek Josh is still reading,
// which is the complaint we are fixing. Asking is the only thing that stays
// correct for a peek of unbounded length.
//
// When WV cannot tell us, prefer the harmless failure:
//   - unparseable / older WV with no peekVisible -> change nothing.
//   - WV not reachable at all                    -> restore (no peek can
//     exist without it, and staying ducked forever would leave us under
//     full-screen Chrome).
// Staying ducked is invisible to Josh — the presenter is still on screen, just
// not above full-screen apps — whereas covering a live peek IS the bug.
async function reconcileOnce() {
  let st;
  try {
    const r = await fetch('http://localhost:8179/status', { signal: AbortSignal.timeout(1500) });
    st = await r.json();
  } catch {
    // WV unreachable. If it is not running at all no peek can exist, so it is
    // both safe and necessary to come back up rather than stay ducked.
    restoreFromPeek('reconciler:wv-unreachable');
    return;
  }
  if (typeof st.peekVisible !== 'boolean') {
    // Older WV that cannot tell us. Stay as we are and rely on its POST (or
    // Alt+P) — guessing here is what the whole fix exists to avoid.
    return;
  }
  peekVisibleFromWV = st.peekVisible;
  // Enforce WV's state in BOTH directions. Re-ducking matters as much as
  // restoring: during a peek-replaces-peek the superseded window's close can
  // briefly say "gone" while a new peek is going up, and without this we would
  // sit on top of a live peek until the next keypress — Josh's original
  // complaint, recurring on consecutive dictations. This makes any stray or
  // lost message self-heal within one interval instead of persisting.
  if (st.peekVisible && duckDepth === 0) duckForPeek('reconciler:wv-says-open');
  else if (!st.peekVisible && duckDepth > 0) restoreFromPeek('reconciler:wv-says-closed');
}

function startDuckReconciler() {
  if (duckReconciler) return;
  duckReconciler = setInterval(() => {
    if (duckDepth === 0) { stopDuckReconciler(); return; }
    reconcileOnce();
  }, DUCK_RECONCILE_MS);
}

// The reconciler above only runs WHILE ducked, so on its own it can restore but
// can never re-duck: restoreFromPeek() stops it, and the loop also self-stops
// at duckDepth === 0, which makes the `peekVisible && duckDepth === 0` branch
// in reconcileOnce() unreachable from polling. Measured on Josh's machine: with
// a genuinely live peek (WV reporting peekVisible:true) and a stray `false`
// delivered to /wv-peek, the presenter sat at layer 1000 covering that peek for
// the peek's whole remaining life — the original complaint, which the restore-
// only reconciler cannot heal.
//
// So this slower watch runs while NOT ducked and closes the loop. It is the
// cheaper half of the pair by design: a missed re-duck means Josh is briefly
// covered (the bug), while a missed restore only leaves us harmlessly ducked,
// so the fast 2s loop stays on the side that must react immediately.
function startPeekWatch() {
  if (peekWatch) return;
  peekWatch = setInterval(() => {
    if (duckDepth > 0) return;   // the 2s reconciler owns the ducked case
    reconcileOnce();
  }, PEEK_WATCH_MS);
}

function stopDuckReconciler() {
  if (duckReconciler) { clearInterval(duckReconciler); duckReconciler = null; }
}

// Duck because a peek is (or is very likely) on screen. Idempotent — calling
// it twice does not require two restores, which is precisely the drift the old
// toggle suffered from.
function duckForPeek(reason) {
  const was = duckDepth > 0;
  duckDepth = 1;
  startDuckReconciler();
  if (!was) applyDuckLevel(reason);
}

// Restore because the peek is definitively gone. Also idempotent.
function restoreFromPeek(reason) {
  stopDuckReconciler();
  if (duckDepth === 0) return;
  duckDepth = 0;
  peekVisibleFromWV = false;
  applyDuckLevel(reason);
}

// --- Collapse / Expand ---

function collapsePresenter() {
  if (!isExpanded) return;
  isExpanded = false;

  // Hide expanded window
  if (win && !win.isDestroyed()) {
    win.hide();
  }

  // Show or create collapsed bar
  if (barWin && !barWin.isDestroyed()) {
    barWin.show();
    barWin.webContents.send('queue-count', getStewardQueueCount());
  } else {
    createCollapsedBar();
  }
}

function expandPresenter() {
  if (isExpanded) return;
  isExpanded = true;

  // Hide collapsed bar
  if (barWin && !barWin.isDestroyed()) {
    barWin.hide();
  }

  // Show expanded window
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    pushQueueToRenderer();
  } else {
    createExpandedWindow();
  }
}

function togglePresenter() {
  if (isExpanded) {
    collapsePresenter();
  } else {
    expandPresenter();
  }
}

function createCollapsedBar() {
  // Upper-right pin, computed by the same helper the post-res-flip restore
  // uses so both agree on where the bar belongs.
  const cb = computeCollapsedBounds();

  barWin = new BrowserWindow({
    width: cb.width,
    height: cb.height,
    x: cb.x,
    y: cb.y,
    frame: false,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    transparent: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-collapsed.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Ensure visible on all macOS Spaces/desktops, including full-screen apps.
  // Level 'screen-saver' (not 'floating') is required to cover full-screen
  // apps like full-screen Chrome. 'floating' sits below full-screen windows.
  barWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Respect an in-flight peek duck: if a peek is up right now, a window
  // created/recreated mid-peek must NOT pop back to the covering level and
  // re-hide it. duckDepth is the single source of truth for our level.
  barWin.setAlwaysOnTop(true, duckDepth > 0 ? 'floating' : 'screen-saver');

  barWin.loadFile(path.join(__dirname, 'renderer', 'collapsed.html'));

  barWin.webContents.on('did-finish-load', () => {
    barWin.webContents.send('queue-count', getStewardQueueCount());
    barWin.webContents.send('theme', currentThemePreset);
  });

  barWin.on('closed', () => { barWin = null; });
}

// Compute where the expanded presenter window should sit for the CURRENT
// display, honoring the user's saved bounds and falling back to the flush-
// right pin. Shared by window creation and by the post-resolution-change
// restore so both agree on the canonical position.
function computeExpandedBounds() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const bounds = display.bounds;
  const settings = loadSettings();

  // Size is stored as a FRACTION of the work area, not as fixed pixels.
  //
  // Why: the pixel clamps below are lossy. At a scaled (Grandpa Mode)
  // resolution the work area shrinks, so a saved pixel height got clamped
  // DOWN to fit — and that clamped value was then persisted. Flipping back to
  // native never restored it, so every resolution round-trip ratcheted the
  // window smaller and it never grew back (Josh: "I changed the size of the
  // screen a few times and I think it fucked it up"). A fraction survives the
  // round-trip because it's re-multiplied against whatever work area is
  // current, so the window keeps the same PROPORTION of the screen at every
  // resolution.
  //
  // Legacy pixel width/height are still read as a one-time fallback so an
  // existing settings.json keeps working; the fraction is written from then on.
  const fracW = settings.widthFrac;
  const fracH = settings.heightFrac;
  const rawW = (typeof fracW === 'number' && fracW > 0)
    ? Math.round(workArea.width * fracW)
    : (settings.width || DEFAULT_WIDTH);
  const rawH = (typeof fracH === 'number' && fracH > 0)
    ? Math.round(workArea.height * fracH)
    : (settings.height || workArea.height);

  // Still clamp to the work area so the window can never run off-screen (that
  // overflow is what clipped card scrolling), but the clamp is now applied to
  // a freshly-derived value rather than to a value we then persist.
  const width = Math.min(rawW, workArea.width);
  const height = Math.min(rawH, workArea.height);
  const rawX = settings.x ?? (bounds.x + bounds.width - width);
  const rawY = settings.y ?? workArea.y;
  // Keep the window fully on-screen at whatever the current resolution is. At
  // a scaled resolution a saved x/y valid for the native res could place the
  // window off the (now smaller) screen; clamp so the corner pin is preserved
  // where it fits and the window stays visible where it doesn't.
  const x = Math.max(bounds.x, Math.min(rawX, bounds.x + bounds.width - width));
  const y = Math.max(workArea.y, Math.min(rawY, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

// After a display-resolution change (Grandpa Mode flips the Mac to a scaled
// resolution and back), macOS physically drags our window off its corner and
// does NOT reliably restore it — it can end up shoved toward center/bottom,
// even partly off-screen (which clips card scrolling). We can't rely on
// macOS auto-restoring, so we actively put the window back to its canonical
// bounds. Runs on every display-metrics change; a no-op if bounds already
// match. Guarded so we don't re-trigger our own 'moved' save (the settle
// logic + METRICS_GRACE_MS already reject it, but this keeps it clean).
function restoreExpandedWindowBounds() {
  if (!win || win.isDestroyed()) return;
  const target = computeExpandedBounds();
  const [cx, cy] = win.getPosition();
  const [cw, ch] = win.getSize();
  if (cx === target.x && cy === target.y && cw === target.width && ch === target.height) return;
  win.setBounds(target);
}

// The collapsed bar (the little ticket-count + down-arrow button) is pinned
// upper-right ONCE at creation. A grandpa-mode res-flip strands it exactly
// like the expanded window, and it's movable:false/focusable:false so it can't
// be nudged externally — it must be re-pinned here. Same upper-right math as
// createCollapsedBar(), recomputed against the CURRENT display and clamped
// on-screen.
function computeCollapsedBounds() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const rawX = workArea.x + workArea.width - COLLAPSED_WIDTH - 10;
  const rawY = workArea.y;
  const x = Math.max(workArea.x, Math.min(rawX, workArea.x + workArea.width - COLLAPSED_WIDTH));
  const y = Math.max(workArea.y, Math.min(rawY, workArea.y + workArea.height - COLLAPSED_HEIGHT));
  return { x, y, width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT };
}

function restoreCollapsedBarBounds() {
  if (!barWin || barWin.isDestroyed()) return;
  const target = computeCollapsedBounds();
  const [cx, cy] = barWin.getPosition();
  if (cx === target.x && cy === target.y) return;
  // barWin is movable:false, so setPosition is ignored while that's set;
  // setBounds still repositions it. Use setBounds to be safe.
  barWin.setBounds(target);
}

// Restore BOTH presenter windows (expanded + collapsed bar) to their pins
// after a resolution change. Called on the settle ticks.
function restorePresenterWindowsBounds() {
  restoreExpandedWindowBounds();
  restoreCollapsedBarBounds();
}

function createExpandedWindow() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.size;
  const workArea = display.workArea;
  const { x, y, width, height } = computeExpandedBounds();
  const settings = loadSettings();
  const opacity = settings.opacity ?? DEFAULT_OPACITY;

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    skipTaskbar: false,
    resizable: true,
    backgroundColor: '#111',
    opacity,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Ensure visible on all macOS Spaces/desktops, including full-screen apps.
  // Level 'screen-saver' (not 'floating') is required to cover full-screen
  // apps like full-screen Chrome. 'floating' sits below full-screen windows.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Respect an in-flight peek duck (see the note in createCollapsedBar).
  win.setAlwaysOnTop(true, duckDepth > 0 ? 'floating' : 'screen-saver');

  // Restore fullscreen state from prior session. setSimpleFullScreen stays
  // on the current macOS Space (native fullscreen shoves the window into
  // its own Space, which is annoying here).
  if (settings.simpleFullscreen) {
    win.setSimpleFullScreen(true);
  }

  // Load from Homestead server so Electron and web share the same presenter code.
  // ?embedded=true switches to the unified mobile-deck UI — desktop-native view
  // is dead (Josh 2026-04-21). Same URL as APK WebView.
  win.loadURL('http://localhost:3005/presenter/index.html?embedded=true');

  // Intercept navigation — keep presenter in the Electron window, open everything else externally
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.includes('/presenter/')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Auto-recover from renderer crashes / process-gone (OOM kill, GPU crash, etc.).
  // Why: 2026-04-25 freeze — system RAM thrashed, renderer became unresponsive,
  // window stayed visible but inert. Without this handler the window would just
  // sit blank forever; with it, we reload and Joshua's surface comes back.
  // Cmd +/-/0 zoom, scoped to THIS window only. Deliberately not a
  // globalShortcut: those are system-wide and would steal Cmd+/- from every
  // other app on the Mac. before-input-event only fires while the presenter
  // has focus, so zoom behaves like it does in any normal app window.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta) return;
    // '=' is the unshifted key for '+', so accept both spellings.
    const key = input.key;
    if (key === '=' || key === '+') {
      applyZoom(win.webContents.getZoomFactor() + ZOOM_STEP);
      event.preventDefault();
    } else if (key === '-' || key === '_') {
      applyZoom(win.webContents.getZoomFactor() - ZOOM_STEP);
      event.preventDefault();
    } else if (key === '0') {
      applyZoom(DEFAULT_ZOOM);
      event.preventDefault();
    }
  });

  win.webContents.on('render-process-gone', (event, details) => {
    console.error(`[Presenter] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    if (win && !win.isDestroyed()) {
      win.webContents.reload();
    }
  });

  // Renderer hang detection — if the renderer stops responding for >20s,
  // force-reload. macOS RAM pressure can swap the renderer out long enough
  // to break the IPC loop without an actual crash.
  let unresponsiveTimer = null;
  win.webContents.on('unresponsive', () => {
    console.error('[Presenter] renderer unresponsive — will reload in 20s if not recovered');
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        console.error('[Presenter] forcing reload after sustained unresponsiveness');
        win.webContents.reload();
      }
    }, 20000);
  });
  win.webContents.on('responsive', () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
      console.error('[Presenter] renderer recovered');
    }
  });

  win.webContents.on('did-finish-load', () => {
    pushQueueToRenderer();
    // Apply font size immediately via CSS injection (before React/JS renders cards)
    const s = loadSettings();
    const fontSize = s.fontSize ?? DEFAULT_FONT_SIZE;
    win.webContents.insertCSS(`body { font-size: ${fontSize}px !important; } .card-message, .card-input textarea, .card-btn { font-size: ${fontSize}px !important; }`);
    // Re-apply saved zoom: Electron resets the zoom factor on every navigation
    // (including the reload paths above), so this has to run per load, not
    // once at window creation.
    applyZoom(s.zoom ?? DEFAULT_ZOOM, { persist: false });
    win.webContents.send('settings-update', {
      opacity: s.opacity ?? DEFAULT_OPACITY,
      fontSize,
    });
  });

  // Save position/size on move/resize — but only once bounds have SETTLED and
  // aren't the transient byproduct of a display-resolution change (Grandpa
  // Mode). See saveBoundsWhenSettled. A real user drag still persists.
  win.on('moved', () => {
    if (!win) return;
    saveBoundsWhenSettled(() => {
      if (!win) return {};
      const [wx, wy] = win.getPosition();
      return { x: wx, y: wy };
    });
  });
  win.on('resized', () => {
    if (!win) return;
    saveBoundsWhenSettled(() => {
      if (!win) return {};
      const [w, h] = win.getSize();
      // Persist as a fraction of the CURRENT work area so the size survives
      // resolution flips (see computeExpandedBounds). Pixels are written too,
      // purely so an older build reading this file still gets sane values.
      const { screen } = require('electron');
      const wa = screen.getPrimaryDisplay().workArea;
      return {
        width: w,
        height: h,
        widthFrac: +(w / wa.width).toFixed(4),
        heightFrac: +(h / wa.height).toFixed(4),
      };
    });
  });

  win.on('closed', () => { win = null; });
}

// --- Electron app ---

app.whenReady().then(() => {
  httpServer.listen(PORT, '127.0.0.1', () => {
    console.error(`Presenter HTTP server on http://127.0.0.1:${PORT}`);
  });

  // Connect to Homestead server
  connectToServer();

  // Watch for a peek we were never told about (see startPeekWatch). Runs for
  // the life of the process; it is a no-op while ducked and while WV is down.
  startPeekWatch();

  // Handle display resolution/layout changes (Grandpa Mode flips the Mac's
  // resolution and back). Two jobs:
  //  1. Record the time so window-bounds saving rejects the transient
  //     'moved'/'resized' events the flip produces (see saveBoundsWhenSettled).
  //  2. ACTIVELY restore the expanded window to its canonical bounds — macOS
  //     drags it off its corner during the flip and doesn't reliably put it
  //     back (leaving it shoved center/bottom, clipping scroll). We restore
  //     after a short delay so the new resolution's workArea has settled.
  {
    const { screen } = require('electron');
    screen.on('display-metrics-changed', (_event, _display, changedMetrics) => {
      if (changedMetrics.includes('bounds') || changedMetrics.includes('workArea') || changedMetrics.includes('scaleFactor')) {
        lastMetricsChangeAt = Date.now();
        // Restore once the layout settles. Do it a couple of times to catch
        // late relayouts macOS sometimes applies after the metrics event.
        // Covers BOTH the expanded window and the collapsed bar.
        setTimeout(restorePresenterWindowsBounds, 250);
        setTimeout(restorePresenterWindowsBounds, 800);
      }
    });
  }

  // Create both windows (expanded shown first, collapsed hidden)
  createExpandedWindow();
  createCollapsedBar();
  barWin.hide(); // start collapsed bar hidden

  // Global hotkey: backtick (`) to toggle presenter visibility
  globalShortcut.register('`', togglePresenter);

  // Global hotkey: Option+P to trigger Whisper Village peek.
  //
  // Alt+P ALWAYS means "show me the peek" — it is never a request to restore.
  // So we only ever duck here; coming back up is driven by the peek actually
  // ending (WV's POST /wv-peek {visible:false}, or the watchdog). That
  // asymmetry is the whole fix: the old code flipped a boolean on every press,
  // which inverted permanently the first time the peek self-dismissed on its
  // 8s timer without a second press.
  globalShortcut.register('Alt+P', () => {
    fetch('http://localhost:8179/peek', { method: 'POST' }).catch(() => {});
    duckForPeek('alt+p');
  });

  // Global hotkey: Option+C to cancel/stop Whisper Village recording
  globalShortcut.register('Alt+C', () => {
    fetch('http://localhost:8179/cancel', { method: 'POST' }).catch(() => {});
  });

  // IPC handlers
  ipcMain.handle('get-queue', () => queue);

  ipcMain.handle('get-history', async (event, sessionId) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/presenter/history/${encodeURIComponent(sessionId)}`);
      return await res.json();
    } catch { return []; }
  });

  ipcMain.handle('get-message-queue', async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/queue`);
      const data = await res.json();
      return data.queue || [];
    } catch { return []; }
  });

  ipcMain.handle('delete-queue-item', async (event, id) => {
    try {
      await fetch(`${SERVER_URL}/api/queue/${id}`, { method: 'DELETE' });
      return true;
    } catch { return false; }
  });

  ipcMain.handle('readd-queue-item', async (event, data) => {
    try {
      await fetch(`${SERVER_URL}/api/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      return true;
    } catch { return false; }
  });

  ipcMain.handle('respond', async (event, { id, button, text, keepCard }) => {
    const response = { button };
    if (text) response.text = text;
    // keepCard (Josh 2026-07-10): send the reply + card context to the steward
    // WITHOUT dismissing the card. Forward the flag to the server (respondToServer
    // spreads `response` into the POST body) AND keep the card in the local
    // Electron queue — otherwise the native shell would silently dismiss the card
    // even though the server keeps it, a split-behavior bug vs the web/APK path.
    if (keepCard) {
      response.keepCard = true;
      await respondToServer(id, response);
      return;
    }
    // Default path: remove from local queue immediately for responsiveness.
    queue = queue.filter(i => i.id !== id);
    pushQueueToRenderer();
    // Await so the renderer's .then()/.catch() reflects real send outcome.
    await respondToServer(id, response);
  });

  ipcMain.handle('dismiss', async (event, { id }) => {
    queue = queue.filter(i => i.id !== id);
    pushQueueToRenderer();
    await respondToServer(id, { dismissed: true });
  });

  ipcMain.on('open-url', (event, url) => {
    if (url) shell.openExternal(url);
  });

  ipcMain.on('run-command', (event, command) => {
    runShellCommand(command, 'ipc');
  });

  ipcMain.on('phone-open-uri', (event, uri) => {
    console.log('[Presenter] phone-open-uri:', uri);
    const http = require('http');
    const postData = JSON.stringify({ uri });
    const req = http.request({
      hostname: '<<REPLACE: your Tailscale IP>>',
      port: 8888,
      path: '/open-uri',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => console.log('[Presenter] phone-open-uri response:', res.statusCode, body));
    });
    req.on('error', (err) => console.error('[Presenter] phone-open-uri error:', err.message));
    req.write(postData);
    req.end();
  });

  ipcMain.on('minimize-window', () => {
    collapsePresenter();
  });

  ipcMain.on('set-opacity', (event, value) => {
    const opacity = Math.max(0.2, Math.min(1, parseFloat(value) || DEFAULT_OPACITY));
    if (win) win.setOpacity(opacity);
    saveSettings({ opacity });
  });

  ipcMain.on('set-font-size', (event, value) => {
    const fontSize = Math.max(10, Math.min(24, parseInt(value) || DEFAULT_FONT_SIZE));
    saveSettings({ fontSize });
    if (win) win.webContents.send('settings-update', { fontSize });
  });

  // Renderer reports its active reading-mode theme (on startup restore and on
  // every live theme change). We remember it, persist it so the collapsed bar
  // themes correctly on next launch, and push it straight to the bar so a live
  // theme switch reflects on the pill immediately.
  ipcMain.on('set-theme', (event, preset) => {
    const allowed = ['off', 'iowa', 'gruvbox', 'gruvbox-hard'];
    currentThemePreset = allowed.includes(preset) ? preset : 'off';
    saveSettings({ readingPreset: currentThemePreset });
    pushThemeToBar();
  });

  ipcMain.handle('get-settings', () => {
    const s = loadSettings();
    return {
      opacity: s.opacity ?? DEFAULT_OPACITY,
      fontSize: s.fontSize ?? DEFAULT_FONT_SIZE,
      zoom: clampZoom(s.zoom ?? DEFAULT_ZOOM),
    };
  });

  // Zoom from the renderer (settings panel buttons), mirroring the hotkeys.
  ipcMain.on('set-zoom', (event, value) => {
    applyZoom(parseFloat(value));
  });

  ipcMain.on('collapse-presenter', () => {
    collapsePresenter();
  });

  ipcMain.on('expand-presenter', () => {
    expandPresenter();
  });

  // Fullscreen toggle — setSimpleFullScreen stays on the current Space,
  // doesn't shove the window into its own macOS Space like the native
  // macOS fullscreen button would. Tick (`) hide/show + Alt+P duck still
  // work because they operate on window level, not fullscreen state.
  ipcMain.on('toggle-fullscreen', () => {
    if (!win || win.isDestroyed()) return;
    const next = !win.isSimpleFullScreen();
    win.setSimpleFullScreen(next);
    saveSettings({ simpleFullscreen: next });
    // Report current state back to renderer so button UI stays in sync
    win.webContents.send('fullscreen-update', { fullscreen: next });
  });

  ipcMain.handle('get-fullscreen-state', () => {
    if (!win || win.isDestroyed()) return false;
    return win.isSimpleFullScreen();
  });
});

// Track whether the system/user is requesting a real quit
let isQuitting = false;

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  httpServer.close();
  if (socket) socket.disconnect();
});

app.on('window-all-closed', () => {
  // Don't quit when windows are hidden (toggle between collapsed/expanded).
  // But DO quit if the system is shutting down or user explicitly quit.
  if (isQuitting) {
    app.quit();
  }
});
