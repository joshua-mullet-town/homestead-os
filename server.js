const { createServer: createHttpServer } = require('http');
const { createServer: createHttpsServer } = require('https');
const { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, watch, unlinkSync, createWriteStream } = require('fs');
const { parse } = require('url');
const { join } = require('path');
const next = require('next');
const { Server } = require('socket.io');
const pty = require('node-pty');
const os = require('os');
const { execSync, spawn } = require('child_process');
const webpush = require('web-push');
const jobScheduler = require('./lib/job-scheduler');
const queueDispatcher = require('./lib/queue-dispatcher');
const { resolveClaudePath } = require('./lib/claude-resolver');
const stewardWatcher = require('./lib/steward-watcher');
const fcmSessionWatcher = require('./lib/fcm-session-watcher');
const statusTransitionTracker = require('./lib/status-transition-tracker');
const guestManager = require('./lib/guest-manager');
const presenterQueue = require('./lib/presenter-queue');
const triageResolve = require('./lib/triage-resolve');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const BOOT_ID = crypto.randomUUID();

// ── PROD-CHECKOUT DISCRIMINATOR ──────────────────────────────────────────────
// server.js is BOTH the canonical prod process (pm2 homestead @ ~/code/homestead)
// AND the same file a Worker runs from a worktree copy (~/.worktrees/homestead/<branch>)
// for local dev/render iteration. A worktree copy booting the FULL server means it
// boots the fleet's AUTONOMOUS machinery too — the job scheduler (emits real
// job_failure_alerts off the worktree's own possibly-stale recurring-jobs.json),
// the walkie dispatcher (delivers/cleans the SHARED ~/.homestead/queue.json),
// the steward auto-committer (commits to the SHARED stewards git repo), the potato
// heartbeat (rings/raises Rooster), and session-restore (spawns tmux). On 2026-08-04
// two leaked worktree servers did exactly this — flooded Rooster with phantom
// job_failure_alerts ~1/min for hours.
//
// __dirname (server.js's own on-disk location) is the ROBUST signal: a worktree
// copy's __dirname is under /.worktrees/, prod's is ~/code/homestead. Preferred over
// process.cwd() (cwd can be set arbitrarily; __dirname tracks the actual file).
// When NOT the prod checkout, server.js stays a pure local dev/render server:
// it serves the UI, hot-reloads, streams terminals — it just does NOT run any
// autonomous fleet-side-effecting subsystem.
const IS_PROD_CHECKOUT = !__dirname.includes('/.worktrees/');

// Uncaught-error dedup + throttle state (module-scoped, in-memory)
// Keys gated on body.source === 'uncaught-error' at /api/queue intake.
const UNCAUGHT_ERROR_WINDOW_MS = 60_000;
const uncaughtErrorState = {
  signatures: new Map(), // signature -> lastSeenTs (dedup within window)
  windowStartTs: 0,      // start of current throttle window (0 = no active window)
  windowAllowedSignature: null, // signature of the one walkie we let through this window
  suppressedCount: 0,    // distinct-error count suppressed by throttle in this window
  summaryTimer: null,    // setTimeout handle for end-of-window summary
};

function uncaughtErrorSignature(envelope) {
  try {
    const parsed = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
    const msg = String(parsed.error_message || '').slice(0, 200);
    const stack = String(parsed.error_stack || '');
    // First non-empty stack line, stripped of absolute paths and line:col numbers
    const firstFrame = (stack.split('\n').find(l => l.trim()) || '')
      .replace(/\(.*?\)/g, '')
      .replace(/:\d+:\d+/g, '')
      .replace(/https?:\/\/[^\s)]+/g, '')
      .trim()
      .slice(0, 200);
    return `${msg}||${firstFrame}`;
  } catch {
    return String(envelope).slice(0, 200);
  }
}

// Returns { action: 'allow' | 'dedup' | 'throttle', signature }
// Caller enqueues normally on 'allow', drops silently on 'dedup' or 'throttle'.
function classifyUncaughtError(envelope) {
  const now = Date.now();
  const signature = uncaughtErrorSignature(envelope);

  // Dedup: same signature seen within window → drop
  const lastSeen = uncaughtErrorState.signatures.get(signature);
  if (lastSeen && now - lastSeen < UNCAUGHT_ERROR_WINDOW_MS) {
    uncaughtErrorState.signatures.set(signature, now);
    return { action: 'dedup', signature };
  }
  uncaughtErrorState.signatures.set(signature, now);

  // Garbage-collect old signatures occasionally
  if (uncaughtErrorState.signatures.size > 200) {
    for (const [sig, ts] of uncaughtErrorState.signatures) {
      if (now - ts > UNCAUGHT_ERROR_WINDOW_MS) {
        uncaughtErrorState.signatures.delete(sig);
      }
    }
  }

  // Throttle window check
  const windowActive = uncaughtErrorState.windowStartTs > 0 &&
    now - uncaughtErrorState.windowStartTs < UNCAUGHT_ERROR_WINDOW_MS;

  if (!windowActive) {
    // Open a fresh window; this signature is the one we let through.
    uncaughtErrorState.windowStartTs = now;
    uncaughtErrorState.windowAllowedSignature = signature;
    uncaughtErrorState.suppressedCount = 0;
    if (uncaughtErrorState.summaryTimer) {
      clearTimeout(uncaughtErrorState.summaryTimer);
    }
    uncaughtErrorState.summaryTimer = setTimeout(() => {
      flushUncaughtErrorSummary();
    }, UNCAUGHT_ERROR_WINDOW_MS);
    return { action: 'allow', signature };
  }

  // Window active. The first error in the window already passed.
  // This is a DISTINCT new error (we passed dedup). Suppress + count.
  uncaughtErrorState.suppressedCount += 1;
  return { action: 'throttle', signature };
}

function flushUncaughtErrorSummary() {
  const count = uncaughtErrorState.suppressedCount;
  uncaughtErrorState.windowStartTs = 0;
  uncaughtErrorState.windowAllowedSignature = null;
  uncaughtErrorState.suppressedCount = 0;
  uncaughtErrorState.summaryTimer = null;
  if (count <= 0) return;
  const summaryEnvelope = JSON.stringify({
    type: 'action',
    source: 'uncaught-error-summary',
    from: 'web-client',
    instruction: `${count} more uncaught error${count === 1 ? '' : 's'} in the last minute, suppressed by throttle`,
    suppressed_count: count,
    timestamp: new Date().toISOString(),
  });
  // enqueue() is async now (event-loop wedge fix). Fire-and-forget with a .catch
  // so a rejection is logged, not left as an unhandled promise rejection.
  Promise.resolve(queueDispatcher.enqueue('holler-homestead', summaryEnvelope))
    .then(() => log(`[uncaught-error] flushed summary: ${count} suppressed`, 'INFO'))
    .catch((err) => log(`[uncaught-error] failed to enqueue summary: ${err.message}`, 'ERROR'));
}

// Logging utility
const LOG_DIR = '/tmp';
const LOG_FILE = join(LOG_DIR, 'homestead-server.log');

// Persistent append-stream: each log() call queues the write into libuv,
// never blocks the event loop the way appendFileSync did. Caller-side
// ordering is preserved by the stream's internal buffer.
const logStream = createWriteStream(LOG_FILE, { flags: 'a' });
logStream.on('error', (err) => {
  console.error('logStream error:', err);
});

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;
  logStream.write(logMessage);
  console.log(logMessage.trim());
}

// Best-effort flush on shutdown so SIGTERM/beforeExit don't drop trailing lines.
// PM2 sends SIGTERM on restart — this catches the normal restart path.
function flushLogsAndExit(signal) {
  try {
    logStream.end(() => {
      if (signal) process.exit(0);
    });
  } catch {
    if (signal) process.exit(0);
  }
}
process.on('beforeExit', () => { try { logStream.end(); } catch {} });
process.on('SIGTERM', () => flushLogsAndExit('SIGTERM'));
process.on('SIGINT',  () => flushLogsAndExit('SIGINT'));

log(`=== Homestead Server Starting === boot_id=${BOOT_ID}`, 'STARTUP');

// ===== PUSH NOTIFICATION SETUP =====
const VAPID_PUBLIC_KEY = 'BJER-IcMm5K2KH9Ia8Hq98uD-HLcyLEWVPNewW3V063jh0sfZG1BiGRqiWymi7p8ab4tdTNvtDJ_Ai9Vc67ypew';
const VAPID_PRIVATE_KEY = 'toj5aWzLQDVL40gq3pmlk0ZAguODquKu7NM7fZAMWyQ';
const SUBSCRIPTIONS_FILE = join(process.cwd(), 'push-subscriptions.json');

webpush.setVapidDetails(
  'mailto:josh@homestead.dev',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

function loadSubscriptions() {
  if (existsSync(SUBSCRIPTIONS_FILE)) {
    try {
      return JSON.parse(readFileSync(SUBSCRIPTIONS_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveSubscriptions(subscriptions) {
  writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
}

/**
 * Send push notification to all subscribers
 * This is exposed globally so the scheduler can use it
 */
async function sendPushNotification({ title, body, data }) {
  const subscriptions = loadSubscriptions();

  if (subscriptions.length === 0) {
    log('[Push] No subscriptions found', 'WARN');
    return { success: false, error: 'No subscriptions found', sent: 0, total: 0 };
  }

  const payload = JSON.stringify({
    title: title || 'Homestead',
    body: body || 'Notification from your Mac!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: data || {}
  });

  log(`[Push] Sending to ${subscriptions.length} subscriber(s)`);

  const results = await Promise.allSettled(
    subscriptions.map((subscription) =>
      webpush.sendNotification(subscription, payload)
    )
  );

  // Clean up failed subscriptions (expired/unsubscribed)
  const validSubscriptions = subscriptions.filter((_, i) => {
    const result = results[i];
    if (result.status === 'rejected') {
      log(`[Push] Removing invalid subscription: ${result.reason}`, 'WARN');
      return false;
    }
    return true;
  });

  if (validSubscriptions.length !== subscriptions.length) {
    saveSubscriptions(validSubscriptions);
  }

  const successCount = results.filter((r) => r.status === 'fulfilled').length;

  return {
    success: successCount > 0,
    sent: successCount,
    total: subscriptions.length
  };
}

// Expose globally for scheduler
global.sendPushNotification = sendPushNotification;

const dev = process.env.NODE_ENV !== 'production';
const hostname = '::'; // Listen on all interfaces (IPv6 + IPv4)
const port = parseInt(process.env.PORT, 10) || 3005;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Enable HTTPS for push notifications (requires secure context)
const useHttps = process.env.USE_HTTPS === 'true';

// Terminal manager for raw PTY sessions (legacy)
class TerminalManager {
  constructor() {
    this.terminals = new Map();
  }

  createTerminal(sessionId, cwd = process.env.HOME || '/root') {
    log(`[TerminalManager] createTerminal called - sessionId: ${sessionId}, cwd: ${cwd}`);

    if (this.terminals.has(sessionId)) {
      log(`[TerminalManager] Terminal already exists for session: ${sessionId}`, 'WARN');
      return this.terminals.get(sessionId);
    }

    // Check if this is a tmux session name (starts with 'holler-')
    const isTmuxSession = sessionId.startsWith('holler-');

    let ptyProcess;
    try {
      if (isTmuxSession) {
        // Attach to existing tmux session
        log(`[Terminal] Attaching to tmux session: ${sessionId}`);
        const cleanEnv = { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
        delete cleanEnv.TMUX;
        delete cleanEnv.TMUX_PANE;
        ptyProcess = pty.spawn('tmux', ['-u', 'attach', '-t', sessionId], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: process.env.HOME,
          env: cleanEnv
        });
        log(`[Terminal] Attached to tmux session: ${sessionId}, pid: ${ptyProcess.pid}`);
      } else {
        // Fallback: spawn a fresh shell (for legacy behavior)
        const shell = process.env[os.platform() === 'win32' ? 'COMSPEC' : 'SHELL'];
        log(`[Terminal] Spawning shell: ${shell}, cwd: ${cwd}, platform: ${os.platform()}`);
        ptyProcess = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: cwd,
          env: { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
        });
        log(`[Terminal] PTY spawned successfully, pid: ${ptyProcess.pid}`);
      }
    } catch (error) {
      log(`[Terminal] Spawn error: ${error.message}`, 'ERROR');
      log(`[Terminal] Error code: ${error.code}, errno: ${error.errno}`, 'ERROR');
      log(`[Terminal] Stack: ${error.stack}`, 'ERROR');
      throw error;
    }

    const terminalData = {
      ptyProcess,
      sessionId,
      clients: new Set(),
      created: new Date(),
      isTmuxSession
    };

    this.terminals.set(sessionId, terminalData);
    log(`[Terminal] Created terminal for session: ${sessionId}, total terminals: ${this.terminals.size}`);

    return terminalData;
  }

  writeToTerminal(sessionId, data) {
    const terminal = this.terminals.get(sessionId);
    if (terminal && terminal.ptyProcess) {
      const preview = data.length > 100 ? data.substring(0, 100) + '...' : data;
      log(`[Terminal] Writing to ${sessionId}: ${JSON.stringify(preview)}`);
      terminal.ptyProcess.write(data);
      return true;
    }
    log(`[Terminal] Write failed - no terminal found for session: ${sessionId}`, 'WARN');
    return false;
  }

  resizeTerminal(sessionId, cols, rows) {
    const terminal = this.terminals.get(sessionId);
    if (terminal && terminal.ptyProcess) {
      try {
        terminal.ptyProcess.resize(cols, rows);
        log(`[Terminal] Resized ${sessionId} to ${cols}x${rows}`);
      } catch (e) {
        log(`[Terminal] Resize error for ${sessionId}: ${e.message}`, 'ERROR');
      }
    } else {
      log(`[Terminal] Resize failed - no terminal found for session: ${sessionId}`, 'WARN');
    }
  }

  killTerminal(sessionId) {
    const terminal = this.terminals.get(sessionId);
    if (terminal) {
      log(`[Terminal] Killing terminal: ${sessionId}, pid: ${terminal.ptyProcess.pid}`);
      // Reclaim the master fd deterministically — kill() alone can leak it on macOS.
      try { terminal.ptyProcess.kill(); } catch (e) { /* may already be dead */ }
      try { terminal.ptyProcess.destroy(); } catch (e) { /* socket may already be closed */ }
      this.terminals.delete(sessionId);
      log(`[Terminal] Killed terminal: ${sessionId}, remaining: ${this.terminals.size}`);
    } else {
      log(`[Terminal] Kill failed - no terminal found for session: ${sessionId}`, 'WARN');
    }
  }

  getTerminal(sessionId) {
    return this.terminals.get(sessionId);
  }
}

// Tmux session manager - keeps PTY connections alive for instant switching
class TmuxManager {
  constructor() {
    this.sessions = new Map();        // sessionName -> sessionData (with PTY)
    this.detachTimers = new Map();    // Grace period timers before killing PTY
    this.maxPoolSize = 10;            // Max PTYs to keep alive
    this.idleTimeout = 30 * 60 * 1000; // 30 min idle before cleanup
    // sessionName -> timestamp of last Ctrl+L write. DURABLE: persisted to disk
    // so the debounce below survives a server restart. The restart window is
    // EXACTLY when the double-Ctrl+L -> /clear regression bites — a restart
    // wiped an in-memory-only Map, so the fresh reconnect's server + client
    // redraws paired up and fired /clear. See loadCtrlLState / saveCtrlLState.
    this.ctrlLStatePath = join(os.homedir(), '.homestead', 'ctrl-l-state.json');
    this.lastCtrlL = this.loadCtrlLState();
  }

  // Load persisted last-Ctrl+L timestamps. Returns an empty Map on any error
  // (missing file, corrupt JSON) — a cold guard is no worse than today's bug,
  // and the source-level collapse (single \x0c per open) is the real backstop.
  loadCtrlLState() {
    try {
      if (existsSync(this.ctrlLStatePath)) {
        const raw = JSON.parse(readFileSync(this.ctrlLStatePath, 'utf-8'));
        return new Map(Object.entries(raw));
      }
    } catch (e) {
      log(`[TmuxManager] Could not load Ctrl+L state: ${e.message}`, 'WARN');
    }
    return new Map();
  }

  // Persist last-Ctrl+L timestamps synchronously. Called on every accepted
  // Ctrl+L so a restart mid-open still sees the just-written timestamp and
  // debounces the reconnect refresh against it.
  saveCtrlLState() {
    try {
      const dir = join(os.homedir(), '.homestead');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.ctrlLStatePath, JSON.stringify(Object.fromEntries(this.lastCtrlL)));
    } catch (e) {
      log(`[TmuxManager] Could not save Ctrl+L state: ${e.message}`, 'WARN');
    }
  }

  // Debounced Ctrl+L (screen-refresh) writes, per session.
  //
  // Claude Code has a native double-Ctrl+L -> /clear keyboard shortcut: two
  // \x0c bytes landing inside its double-tap window make Claude insert and FIRE
  // /clear, which WIPES the session's context. Ctrl+L refreshes originate from
  // MULTIPLE places and even MULTIPLE processes: the frontend (snapshot/retry
  // redraws in TerminalManager, arriving here via socket 'tmux:input') AND the
  // server itself (the tmux:attach refresh below). On a frontend refresh the
  // client reconnects -> server refresh + client refresh land as a PAIR, and a
  // client-only debounce cannot see the server's write. This server-side funnel
  // is the ONE place every \x0c passes through, so debouncing here blocks the
  // cross-process double-tap no matter which side emitted it.
  //
  // Only a LONE \x0c is treated as a refresh; real user input that merely
  // contains \x0c is written verbatim (never a redraw signal). 1500ms is wider
  // than Claude's double-tap window; a skipped redundant refresh costs nothing.
  static CTRL_L_DEBOUNCE_MS = 1500;
  writeCtrlL(sessionName) {
    const now = Date.now();
    const last = this.lastCtrlL.get(sessionName) ?? -Infinity;
    if (now - last < TmuxManager.CTRL_L_DEBOUNCE_MS) {
      return false; // A refresh already fired recently — skip to avoid a double-tap.
    }
    this.lastCtrlL.set(sessionName, now);
    this.saveCtrlLState(); // Durable — survives restart so the next reconnect debounces against it.
    return this.writeToSession(sessionName, '\x0c');
  }

  // Check if a tmux session exists
  // Build a clean env for tmux commands — strip stale TMUX/TMUX_PANE vars
  // that PM2 inherits from the shell it was launched in. These can cause
  // tmux to misbehave when creating or attaching to sessions.
  _tmuxEnv() {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return env;
  }

  sessionExists(sessionName) {
    try {
      execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { env: this._tmuxEnv() });
      return true;
    } catch {
      return false;
    }
  }

  // Create a tmux session with Claude for a given session name
  ensureSession(sessionName) {
    if (this.sessionExists(sessionName)) return;

    log(`[TmuxManager] Session ${sessionName} not found, creating it...`);

    // Resolve project directory from session name
    // Format: holler-{project} or holler-{project}--{branch}
    const nameWithoutPrefix = sessionName.replace('holler-', '');
    const homeDir = os.homedir();

    let projectDir;
    const stewardsDir = join(homeDir, '.homestead', 'stewards');

    // RULE 1: Check if this is a steward session
    // holler-venture--marketing--seo → stewards/venture/substewards/marketing/substewards/seo
    const stewardParts = nameWithoutPrefix.split('--');
    const stewardPath = join(stewardsDir, stewardParts.join('/substewards/'));
    if (existsSync(stewardPath) && existsSync(join(stewardPath, 'CLAUDE.md'))) {
      projectDir = stewardPath;
      log(`[TmuxManager] Resolved steward dir: ${projectDir}`);
    }

    // RULE 2: Check worktrees (for build sessions)
    if (!projectDir) {
      const worktreesDir = join(homeDir, '.worktrees');
      if (nameWithoutPrefix.includes('--')) {
        const [project, ...branchParts] = nameWithoutPrefix.split('--');
        const branch = branchParts.join('--');
        const worktreePath = join(worktreesDir, project, branch);
        if (existsSync(worktreePath)) {
          projectDir = worktreePath;
          log(`[TmuxManager] Resolved worktree dir: ${projectDir}`);
        }
      }
    }

    // RULE 3: Fall back to ~/code/{name}
    if (!projectDir) {
      let configCodeDir;
      try {
        const configPath = join(process.cwd(), 'homestead-config.json');
        if (existsSync(configPath)) {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'));
          configCodeDir = config.codeDir;
        }
      } catch (e) {
        log(`[TmuxManager] Could not read config: ${e.message}`, 'WARN');
      }
      const codeDir = configCodeDir || join(homeDir, 'code');
      projectDir = join(codeDir, nameWithoutPrefix);
    }

    if (!existsSync(projectDir)) {
      throw new Error(`Project directory not found: ${projectDir}`);
    }

    // Resolve Claude path — newest-version, not PATH-order (see lib/claude-resolver.js).
    const claudePath = resolveClaudePath();

    // Build --add-dir flags
    let addDirFlags = '';
    try {
      const dirList = execSync(`ls -d "${codeDir}"/*/`, { encoding: 'utf-8' });
      addDirFlags = dirList.trim().split('\n')
        .filter(d => d && !d.includes('node_modules'))
        .map(d => `--add-dir '${d.replace(/\/$/, '')}'`)
        .join(' ');
    } catch (e) {
      log(`[TmuxManager] Could not list code dirs: ${e.message}`, 'WARN');
    }

    // Fleet-wide rip-and-replace (2026-05-04): NO --continue. Every spawn is
    // fresh; HANDOFF.md is the bridge to the previous self. Conversation
    // accumulation is gone; stale-identity revival is gone.
    const baseFlags = `--dangerously-skip-permissions ${addDirFlags}`;
    const claudeCommand = `${claudePath} ${baseFlags}; zsh`;

    const tmuxEnv = this._tmuxEnv();

    log(`[TmuxManager] Creating session: ${sessionName} in ${projectDir}`);
    execSync(`tmux new-session -d -s ${sessionName} -c "${projectDir}" "${claudeCommand}"`, { env: tmuxEnv });

    // Set remain-on-exit so the session survives even if claude crashes during startup.
    // This prevents the race where the session dies before the PTY can attach.
    try {
      execSync(`tmux set-option -t ${sessionName} remain-on-exit on`, { env: tmuxEnv });
    } catch (e) {
      log(`[TmuxManager] Could not set remain-on-exit: ${e.message}`, 'WARN');
    }

    // Track whether we hit the bare-zsh fallback so we can skip the bootstrap
    // injection — operator visibility wins when the claude command died on first try.
    let hitBareZshFallback = false;

    // Verify the session actually survived creation
    if (!this.sessionExists(sessionName)) {
      log(`[TmuxManager] Session ${sessionName} died immediately after creation — retrying`, 'WARN');
      hitBareZshFallback = true;
      // Retry once with a simpler command (just zsh) so the session stays alive
      execSync(`tmux new-session -d -s ${sessionName} -c "${projectDir}" "zsh"`, { env: tmuxEnv });
      try {
        execSync(`tmux set-option -t ${sessionName} remain-on-exit on`, { env: tmuxEnv });
      } catch (e) { /* non-fatal */ }
      // Send the claude command into the live session
      const escapedCmd = claudeCommand.replace(/'/g, "'\\''");
      execSync(`tmux send-keys -t ${sessionName} '${escapedCmd}' Enter`, { env: tmuxEnv });
    }

    log(`[TmuxManager] Session ${sessionName} created successfully`);

    // Passive read-HANDOFF bootstrap for fresh-spawned UI attachments.
    //
    // Shape distinction: this is the human→machine sync path (operator opened
    // the homestead UI on a steward whose tmux died → PTY attachment fires
    // ensureSession). The dispatcher-driven path uses wakeFreshSpawn() in
    // queue-dispatcher.js, which is machine→machine async and includes a
    // marker-poll deadman + hard-failure escalation to holler-rooster. Here,
    // the operator IS the validator — no marker watch, no escalation. We just
    // tell the fresh Claude to read HANDOFF.md so its first response to the
    // operator carries the previous-self context.
    //
    // Skipped on the bare-zsh fallback path: that means the claude command
    // died on first try, the session is now sitting at a shell prompt with the
    // claude command sent via send-keys, and the operator likely needs to debug.
    // Injecting a bootstrap into a still-booting environment in that state
    // creates more confusion than help.
    //
    // Edge case (accepted, not mitigated): if the operator types into the
    // prompt during the 15s ready-poll, the bootstrap text appends to their
    // input and Enter sends a frankenmerge. Harmless — operator can Ctrl-C
    // and retype. Mitigation (pre-inject pane-check) adds complexity for a
    // benign failure mode.
    if (!hitBareZshFallback) {
      this._injectUiAttachBootstrap(sessionName, projectDir, tmuxEnv);
    }
  }

  /**
   * Inject a passive read-HANDOFF bootstrap into a freshly-spawned UI-attached
   * tmux session. Polls for the "bypass permissions on" footer (canonical
   * ready-state signature; ❯ Try regex breaks on U+00A0 NBSP) for up to 15s,
   * then injects via load-buffer + paste-buffer + sleep 0.5 + Enter.
   *
   * No marker-poll, no return value the caller checks. If the inject fails
   * for any reason, log and move on — the operator can read HANDOFF.md
   * manually if they want.
   */
  _injectUiAttachBootstrap(sessionName, projectDir, tmuxEnv) {
    const handoffPath = join(projectDir, 'HANDOFF.md');

    // Wait for ready-state.
    const READY_TIMEOUT_SEC = 15;
    let ready = false;
    for (let s = 1; s <= READY_TIMEOUT_SEC; s++) {
      try {
        const cap = execSync(`tmux capture-pane -t "=${sessionName}:" -p 2>/dev/null || true`, { encoding: 'utf-8', env: tmuxEnv });
        if (cap.includes('bypass permissions on')) {
          ready = true;
          break;
        }
      } catch { /* keep polling */ }
      try { execSync('sleep 1'); } catch { /* swallow */ }
    }
    if (!ready) {
      log(`[TmuxManager] ${sessionName}: claude did not reach ready-state within ${READY_TIMEOUT_SEC}s — skipping bootstrap inject`, 'WARN');
      return;
    }

    const bootstrap = [
      `You were just spawned fresh on UI attachment (NO --continue, no scrollback). The operator opened the homestead UI on this steward.`,
      ``,
      `Your first action: read ${handoffPath}. That file is the bridge to your previous self — what you were working on, what you owe, who's waiting.`,
      ``,
      `This is the human→machine path: the operator is here, no queued walkie is waiting two ticks behind. After reading HANDOFF.md, surface the headline ("you were doing X, waiting on Y") and let the operator drive from there.`,
      ``,
      `You have NO scrollback, so before you act on anything ambiguous, RE-GROUND against past conversations: call the mcp__presenter__search_history tool with a keyword from your current work (a feature name, a person, a decision). It returns past presenter cards newest-first with BOTH sides — what Josh was asked and exactly how he replied. Leave the query empty to see the most recent cards. Do this FIRST when a HANDOFF item is unclear rather than guessing what was already decided.`,
    ].join('\n');

    const tempFile = join(os.tmpdir(), `ui-attach-bootstrap-${Date.now()}-${process.pid}.txt`);
    const bufName = `ui-attach-${Date.now()}-${process.pid}`;
    try {
      writeFileSync(tempFile, bootstrap);
      execSync(`tmux load-buffer -b "${bufName}" "${tempFile}"`, { env: tmuxEnv });
      execSync(`tmux paste-buffer -b "${bufName}" -t "=${sessionName}:" -d`, { env: tmuxEnv });
      execSync('sleep 0.5');
      execSync(`tmux send-keys -t "=${sessionName}:" Enter`, { env: tmuxEnv });
      log(`[TmuxManager] ${sessionName}: read-HANDOFF bootstrap injected`);
    } catch (e) {
      log(`[TmuxManager] ${sessionName}: bootstrap inject failed (non-fatal): ${e.message}`, 'WARN');
    } finally {
      try { unlinkSync(tempFile); } catch { /* swallow */ }
    }
  }

  // Deterministically reclaim a PTY's OS resources — critically the /dev/ptmx
  // MASTER FD. node-pty's kill() only SIGHUPs the child and relies on an exit
  // cascade to eventually destroy the socket; on macOS that cascade sometimes
  // never fires ("sometimes the socket never gets closed" — unixTerminal.js),
  // leaking the master fd forever. destroy() forces _close() + socket.destroy()
  // synchronously, which is the ONLY reliable way to hand the fd back to the OS.
  // Call this on EVERY path that abandons a PTY (natural exit, destroy, detach,
  // evict) — never on subscribe/unsubscribe (those keep the PTY warm).
  static _reclaimPty(ptyProcess) {
    if (!ptyProcess) return;
    try { ptyProcess.kill(); } catch (e) { /* child may already be dead */ }
    try { ptyProcess.destroy(); } catch (e) { /* socket may already be closed */ }
  }

  // Get or create a PTY for a session (keeps it alive in pool)
  getOrCreatePty(sessionName) {
    // Cancel any pending grace-period detach — client reconnected in time
    if (this.detachTimers.has(sessionName)) {
      clearTimeout(this.detachTimers.get(sessionName));
      this.detachTimers.delete(sessionName);
      log(`[TmuxManager] Cancelled pending detach for ${sessionName} — client reconnected`);
    }

    // If we already have a live PTY, return it
    if (this.sessions.has(sessionName)) {
      const session = this.sessions.get(sessionName);
      session.lastAccessed = Date.now();
      log(`[TmuxManager] Reusing existing PTY for: ${sessionName}`);
      return session;
    }

    // Ensure the tmux session exists
    this.ensureSession(sessionName);

    // Evict oldest session if at capacity
    this._evictIfNeeded();

    // Spawn a PTY that attaches to the tmux session
    let ptyProcess;
    try {
      ptyProcess = pty.spawn('tmux', ['-u', 'attach-session', '-t', sessionName], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        env: { ...this._tmuxEnv(), TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
      });
      log(`[TmuxManager] Created new PTY for: ${sessionName}, pid: ${ptyProcess.pid}`);
    } catch (error) {
      log(`[TmuxManager] Failed to create PTY: ${error.message}`, 'ERROR');
      throw error;
    }

    const sessionData = {
      ptyProcess,
      sessionName,
      clients: new Map(),        // socketId -> { dataHandler, socket }
      created: Date.now(),
      lastAccessed: Date.now(),
      dataListeners: new Set()   // All registered data handlers
    };

    // Single persistent 'exit' listener per PTY: removes from pool AND fans
    // out tmux:exit to every currently-subscribed socket. Per-socket once('exit')
    // registrations would leak across reattaches because PTYs are warm-pooled.
    ptyProcess.on('exit', (exitCode) => {
      log(`[TmuxManager] PTY exited for ${sessionName}, code: ${exitCode}`);
      for (const { socket } of sessionData.clients.values()) {
        if (socket && socket.connected) {
          socket.emit('tmux:exit', sessionName, exitCode);
        }
      }
      this.sessions.delete(sessionName);
      // PRIMARY LEAK FIX: the child exiting does NOT reliably close the master
      // fd on macOS. Reclaim it explicitly now that we're dropping the session.
      TmuxManager._reclaimPty(ptyProcess);
    });

    this.sessions.set(sessionName, sessionData);
    log(`[TmuxManager] Pool size: ${this.sessions.size}/${this.maxPoolSize}`);

    return sessionData;
  }

  // Subscribe a socket to a session's output
  subscribe(sessionName, socketId, dataHandler, socket) {
    const session = this.getOrCreatePty(sessionName);

    // Socket ref is used by the persistent 'exit' listener in getOrCreatePty
    // to fan out tmux:exit without re-registering once('exit') per attach.
    session.clients.set(socketId, { dataHandler, socket });

    // Register the data handler on PTY
    session.ptyProcess.on('data', dataHandler);
    session.dataListeners.add(dataHandler);

    log(`[TmuxManager] Subscribed ${socketId} to ${sessionName}, clients: ${session.clients.size}`);

    return session;
  }

  // Unsubscribe a socket from a session (but keep PTY alive!)
  unsubscribe(sessionName, socketId) {
    const session = this.sessions.get(sessionName);
    if (!session) return;

    const clientData = session.clients.get(socketId);
    if (clientData) {
      // Remove this client's data handler
      session.ptyProcess.removeListener('data', clientData.dataHandler);
      session.dataListeners.delete(clientData.dataHandler);
      session.clients.delete(socketId);
      log(`[TmuxManager] Unsubscribed ${socketId} from ${sessionName}, remaining clients: ${session.clients.size}`);
    }

    // NOTE: We do NOT kill the PTY here - it stays warm in the pool
  }

  // Legacy method for backward compat
  attachToSession(sessionName) {
    return this.getOrCreatePty(sessionName);
  }

  writeToSession(sessionName, data) {
    const session = this.sessions.get(sessionName);
    if (session && session.ptyProcess) {
      session.lastAccessed = Date.now();
      session.ptyProcess.write(data);
      return true;
    }
    return false;
  }

  resizeSession(sessionName, cols, rows) {
    const session = this.sessions.get(sessionName);
    if (session && session.ptyProcess) {
      try {
        session.ptyProcess.resize(cols, rows);
        log(`[TmuxManager] Resized ${sessionName} to ${cols}x${rows}`);
      } catch (e) {
        log(`[TmuxManager] Resize error: ${e.message}`, 'ERROR');
      }
    }
  }

  // Force-kill a PTY (only when tmux session is destroyed)
  destroySession(sessionName) {
    const session = this.sessions.get(sessionName);
    if (session) {
      log(`[TmuxManager] Destroying PTY for: ${sessionName}`);
      TmuxManager._reclaimPty(session.ptyProcess);
      this.sessions.delete(sessionName);
      this.detachTimers.delete(sessionName);
    }
  }

  // Detach with optional grace period for reconnection
  detachSession(sessionName, immediate = false) {
    const session = this.sessions.get(sessionName);
    if (!session) return;

    if (immediate) {
      log(`[TmuxManager] Immediately detaching from session: ${sessionName}`);
      TmuxManager._reclaimPty(session.ptyProcess);
      this.sessions.delete(sessionName);
      this.detachTimers.delete(sessionName);
      return;
    }

    // Grace period: wait 30s before killing PTY — client might reconnect
    if (this.detachTimers.has(sessionName)) return; // already scheduled

    log(`[TmuxManager] Scheduling detach for ${sessionName} in 30s (grace period)`);
    const timer = setTimeout(() => {
      const s = this.sessions.get(sessionName);
      if (s && s.clients.size === 0) {
        log(`[TmuxManager] Grace period expired, detaching: ${sessionName}`);
        TmuxManager._reclaimPty(s.ptyProcess);
        this.sessions.delete(sessionName);
      } else {
        log(`[TmuxManager] Grace period expired but clients reconnected, keeping: ${sessionName}`);
      }
      this.detachTimers.delete(sessionName);
    }, 30000);

    this.detachTimers.set(sessionName, timer);
  }

  getSession(sessionName) {
    return this.sessions.get(sessionName);
  }

  // Evict oldest idle session if at capacity
  _evictIfNeeded() {
    if (this.sessions.size < this.maxPoolSize) return;

    // Find oldest session with no active clients
    let oldest = null;
    let oldestTime = Infinity;

    for (const [name, session] of this.sessions) {
      if (session.clients.size === 0 && session.lastAccessed < oldestTime) {
        oldest = name;
        oldestTime = session.lastAccessed;
      }
    }

    if (oldest) {
      log(`[TmuxManager] Evicting idle session: ${oldest}`);
      this.destroySession(oldest);
    }
  }

  // Periodic cleanup of truly idle sessions (no clients for 30+ min)
  cleanupIdle() {
    const now = Date.now();
    for (const [name, session] of this.sessions) {
      if (session.clients.size === 0 && (now - session.lastAccessed) > this.idleTimeout) {
        log(`[TmuxManager] Cleaning up idle session: ${name}`);
        this.destroySession(name);
      }
    }
  }
}

/**
 * Enforce guest access: returns true if the request was blocked (response sent).
 * Owner = full access, Guest = /guest + /api/guest/* + /_next/*, Unknown = /no-access + /_next/*
 */
function enforceGuestAccess(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname || '/';

  // Always allow static assets and Next.js internals
  if (pathname.startsWith('/_next/') || pathname.startsWith('/favicon') || pathname.startsWith('/icon-') || pathname.startsWith('/sw.js') || pathname.startsWith('/manifest')) {
    return false;
  }

  const identity = guestManager.getIdentity(req);

  // Attach identity to request for downstream use
  req.guestIdentity = identity;

  if (identity.role === 'owner') {
    return false; // Full access
  }

  if (identity.role === 'guest') {
    // Allow: /guest, /api/guest/*, /no-access
    if (pathname === '/guest' || pathname.startsWith('/api/guest/') || pathname === '/no-access') {
      return false;
    }
    // Block everything else → redirect to /guest
    res.writeHead(302, { Location: '/guest' });
    res.end();
    return true;
  }

  // Unknown → only /no-access
  if (pathname === '/no-access') {
    return false;
  }
  res.writeHead(302, { Location: '/no-access' });
  res.end();
  return true;
}

app.prepare().then(() => {
  if (IS_PROD_CHECKOUT) {
    // Initialize the persistent job scheduler
    log('[Scheduler] Initializing recurring job scheduler...', 'STARTUP');
    jobScheduler.initialize();

    // Expose scheduler globally so API routes can access it
    global.jobScheduler = jobScheduler;
    log('[Scheduler] Job scheduler exposed globally', 'STARTUP');
  } else {
    // Worktree dev server: DO NOT boot the scheduler. It would read this
    // worktree's own (possibly stale) recurring-jobs.json and fire real
    // job_failure_alerts to the fleet. This is the exact 2026-08-04 leak.
    log('[Scheduler] SKIPPED — not prod checkout (worktree dev server); fleet scheduler stays inert', 'STARTUP');
  }

  // Walkie-talkie queue routes
  function handleHealthRoute(req, res, parsedUrl) {
    if (parsedUrl.pathname === '/api/health' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, boot_id: BOOT_ID }));
      return true;
    }
    return false;
  }

  function handleQueueRoutes(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname || '';

    // GET /api/queue/stats — tiny payload with just counts (for badge updates)
    if (pathname === '/api/queue/stats' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      const queue = queueDispatcher.readQueue();
      const stats = { total: queue.length, active: 0, pending: 0, dispatched: 0, delivered: 0 };
      for (const item of queue) {
        const s = item.status;
        if (s === 'pending') { stats.pending++; stats.active++; }
        else if (s === 'dispatched') { stats.dispatched++; stats.active++; }
        else if (s === 'delivered') { stats.delivered++; stats.active++; }
      }
      res.writeHead(200);
      res.end(JSON.stringify(stats));
      return true;
    }

    // GET /api/queue — read the walkie-talkie queue (supports ?limit=N&offset=N)
    if (pathname === '/api/queue' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      const queue = queueDispatcher.readQueue();
      const q = parsedUrl.query || {};
      const total = queue.length;
      const hasLimit = q.limit !== undefined;
      const limit = hasLimit ? Math.max(0, parseInt(q.limit, 10) || 0) : null;
      const offset = Math.max(0, parseInt(q.offset, 10) || 0);
      const slice = hasLimit ? queue.slice(offset, offset + limit) : queue;
      res.writeHead(200);
      res.end(JSON.stringify({ queue: slice, total, limit: hasLimit ? limit : total, offset }));
      return true;
    }

    // DELETE /api/queue/:id — remove a queue item
    const deleteMatch = pathname.match(/^\/api\/queue\/(.+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      res.setHeader('Content-Type', 'application/json');
      const id = decodeURIComponent(deleteMatch[1]);
      // Async, serialized removal (event-loop wedge fix): no more inline sync
      // readFileSync+filter+writeFileSync on this per-request path.
      queueDispatcher.removeItem(id)
        .then((removed) => {
          if (!removed) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Item not found' }));
          } else {
            res.writeHead(200);
            res.end(JSON.stringify({ deleted: true, id }));
          }
        })
        .catch((err) => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        });
      return true;
    }

    // POST /api/queue — enqueue a walkie-talkie message
    if (pathname === '/api/queue' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      // Log socket/TCP errors so a failed inbound send is no longer silent.
      // (A pure in-transit failure never reaches here — this covers the case
      // where the connection lands then breaks mid-request. See project memory
      // project_presenter_send_failure_no_persistence_no_logging_gap.)
      req.on('error', (err) => {
        log(`[POST /api/queue] request socket error — send NOT enqueued: ${err.message}`, 'ERROR');
      });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { target_session, message_override } = data;
          if (!target_session) {
            log(`[POST /api/queue] rejected 400 — missing target_session. Body (first 200 chars): ${String(body).slice(0, 200)}`, 'WARN');
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'target_session is required' }));
            return;
          }
          const message = message_override || JSON.stringify({ type: data.type || 'action', instruction: data.message || '' });

          // Dedup + throttle gate, only when source === 'uncaught-error'
          // AND target is holler-homestead (per charter — uncaught-error pipe
          // is scoped to that one target; other targets bypass the gate).
          // Non-error walkies are unaffected.
          if (data.source === 'uncaught-error' && target_session === 'holler-homestead') {
            const classification = classifyUncaughtError(message);
            if (classification.action !== 'allow') {
              log(`[uncaught-error] ${classification.action}: ${classification.signature.slice(0, 80)}`, 'INFO');
              res.writeHead(200);
              res.end(JSON.stringify({ success: true, suppressed: classification.action }));
              return;
            }
            log(`[uncaught-error] allow: ${classification.signature.slice(0, 80)}`, 'INFO');
          }

          const item = await queueDispatcher.enqueue(target_session, message);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, item }));
        } catch (err) {
          log(`[POST /api/queue] rejected 400 — invalid JSON: ${err.message}. Body (first 200 chars): ${String(body).slice(0, 200)}`, 'WARN');
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // POST /api/queue/confirm — confirm receipt of a walkie-talkie message
    if (pathname === '/api/queue/confirm' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { id, confirmed_by: confirmedBy } = JSON.parse(body);
          if (!id) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'id is required' }));
            return;
          }
          // TRI-STATE (2026-09-01). confirm() now returns an object:
          //   {confirmed:true}                      — just confirmed
          //   {confirmed:true, already:true}        — already confirmed (live OR archived)
          //   {confirmed:false, reason:'not_found'} — genuinely unknown id
          // The old bare bool collapsed "already confirmed then archived" into
          // the same `false` as "never existed", and the fleet drop-detector
          // read that as a dropped message — re-raising corrections for walkies
          // that had in fact been delivered and confirmed on time.
          const result = await queueDispatcher.confirm(id, confirmedBy);
          res.writeHead(result && result.confirmed ? 200 : 404);
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // GET /api/fast-chat/:session — fast conversation file reader (bypasses Next.js)
    const fastChatMatch = pathname.match(/^\/api\/fast-chat\/(.+)$/);
    if (fastChatMatch && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      const sessionName = decodeURIComponent(fastChatMatch[1]);
      const home = require('os').homedir();
      const filePath = require('path').join(home, '.homestead', 'conversations', `${sessionName}.json`);
      // Fallback to /tmp for backwards compat
      const tmpPath = `/tmp/claude-session-${sessionName}-conversation.json`;
      const { existsSync, readFileSync } = require('fs');
      const actualPath = existsSync(filePath) ? filePath : (existsSync(tmpPath) ? tmpPath : null);
      if (!actualPath) {
        res.writeHead(200);
        res.end(JSON.stringify({ messages: [] }));
        return true;
      }
      try {
        const content = readFileSync(actualPath, 'utf-8');
        const data = JSON.parse(content);
        const exchanges = (data.exchanges || []).slice(-100);
        const messages = [];
        exchanges.forEach((ex, i) => {
          if (ex.user) messages.push({ id: `user-${i}`, role: 'user', content: ex.user, timestamp: data.last_updated || new Date().toISOString() });
          if (ex.assistant) messages.push({ id: `assistant-${i}`, role: 'assistant', content: ex.assistant, timestamp: data.last_updated || new Date().toISOString() });
        });
        res.writeHead(200);
        res.end(JSON.stringify({ messages, sessionId: data.session_id, projectName: data.project_name, cwd: data.cwd }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ messages: [], error: err.message }));
      }
      return true;
    }

    // GET /api/fast-activity/:session — fast activity file reader (bypasses Next.js)
    const fastActivityMatch = pathname.match(/^\/api\/fast-activity\/(.+)$/);
    if (fastActivityMatch && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      const sessionName = decodeURIComponent(fastActivityMatch[1]);
      const activityPath = `/tmp/claude-session-${sessionName}-activity.json`;
      const { existsSync, readFileSync } = require('fs');
      if (!existsSync(activityPath)) {
        res.writeHead(200);
        res.end(JSON.stringify({ activities: [], is_working: false }));
        return true;
      }
      try {
        const content = readFileSync(activityPath, 'utf-8');
        const data = JSON.parse(content);
        // Return last 50 activities + working state
        const activities = (data.activities || []).slice(-50);
        res.writeHead(200);
        res.end(JSON.stringify({
          activities,
          is_working: data.is_working || false,
          current_tool: data.current_tool || null,
          session_id: data.session_id || null,
          cwd: data.cwd || null
        }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ activities: [], error: err.message }));
      }
      return true;
    }

    return false;
  }

  // Custom routes for presenter (must use same module instance as setIo)
  function handlePresenterRoutes(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname || '';
    if (!pathname.startsWith('/api/presenter/')) return false;

    res.setHeader('Content-Type', 'application/json');

    // GET /api/presenter/queue
    if (pathname === '/api/presenter/queue' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ queue: presenterQueue.getQueue() }));
      return true;
    }

    // POST /api/presenter/queue
    if (pathname === '/api/presenter/queue' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { title, message, buttons, input, priority, category, session_id, callback_session, source, component, componentProps, reminder_ack, potato_id, status, recap } = data;
          if (!title || !message) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'title and message are required' }));
            return;
          }
          if (!Array.isArray(buttons) || buttons.length === 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'buttons[] required' }));
            return;
          }
          // Edge-of-the-API session_id guard. Same check runs again inside
          // presenterQueue.addItem() to catch in-process callers — but we
          // validate here too so HTTP clients get a structured 400 instead
          // of a thrown exception turning into a 500.
          const sessionCheck = presenterQueue.validateSessionId(session_id);
          if (!sessionCheck.ok) {
            res.writeHead(400);
            res.end(JSON.stringify({
              error: presenterQueue.buildSessionIdRejectionMessage(sessionCheck),
              code: 'INVALID_SESSION_ID',
              reason: sessionCheck.reason,
              sent_session_id: sessionCheck.sentValue,
              allowed_prefixes: sessionCheck.allowedPrefixes,
              allowed_literal_session_ids: sessionCheck.allowedLiterals,
            }));
            return;
          }
          const item = presenterQueue.addItem({ title, message, buttons, input, priority, category, session_id, callback_session, source, component, componentProps, reminder_ack, potato_id, status, recap });
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, id: item.id, item, queued: true }));
        } catch (err) {
          // FORCED_REMINDER_UNLOCK_REQUIRED — the card-quality gate blocked this
          // send (no fresh unlock stamp, or a stale stamp). addItem() is the
          // single source of truth for the gate; the HTTP edge converts the throw
          // to a structured 400 carrying the echoed rules so the message tool
          // relays them to the steward as an actionable rejection instead of a
          // 500. Card-path only — walkies never hit this.
          if (err && err.code === 'FORCED_REMINDER_UNLOCK_REQUIRED') {
            res.writeHead(400);
            res.end(JSON.stringify({
              error: err.message,
              code: 'FORCED_REMINDER_UNLOCK_REQUIRED',
              reason: err.gateReason || null,
            }));
            return;
          }
          // INVALID_SESSION_ID can still surface here if validation drifts
          // between the edge check and addItem(); return a 400 for that case.
          if (err && err.code === 'INVALID_SESSION_ID') {
            res.writeHead(400);
            res.end(JSON.stringify({
              error: err.message,
              code: 'INVALID_SESSION_ID',
              reason: err.validation && err.validation.reason,
              sent_session_id: err.validation && err.validation.sentValue,
              allowed_prefixes: err.validation && err.validation.allowedPrefixes,
              allowed_literal_session_ids: err.validation && err.validation.allowedLiterals,
            }));
            return;
          }
          // NAKED_CARD_LINK — card carries a bare/unlabeled URL. addItem()
          // throws this (single source of truth for the title-gate); the HTTP
          // edge converts it to a structured 400 so the present_to_user tool
          // relays a clean, actionable error back to the steward instead of a 500.
          if (err && err.code === 'NAKED_CARD_LINK') {
            res.writeHead(400);
            res.end(JSON.stringify({
              error: err.message,
              code: 'NAKED_CARD_LINK',
              reason: err.linkScan && err.linkScan.reason,
              naked_url: err.linkScan && err.linkScan.url,
            }));
            return;
          }
          // LAZY_CARD_LINK_LABEL — link has a host-ish label (localhost, an IP,
          // a *.ts.net host, host:port, or the URL's own hostname). Same
          // structured-400 treatment as NAKED so the teaching message reaches
          // the steward instead of a 500.
          if (err && err.code === 'LAZY_CARD_LINK_LABEL') {
            res.writeHead(400);
            res.end(JSON.stringify({
              error: err.message,
              code: 'LAZY_CARD_LINK_LABEL',
              reason: err.linkScan && err.linkScan.reason,
              lazy_label: err.linkScan && err.linkScan.label,
              url: err.linkScan && err.linkScan.url,
            }));
            return;
          }
          // DUPLICATE_CARD_LINK_TITLE — the link's name already belongs to a
          // DIFFERENT saved link (or another link on this same card). Structured
          // 400 so the "two links can't share a name" message reaches the steward.
          if (err && err.code === 'DUPLICATE_CARD_LINK_TITLE') {
            res.writeHead(400);
            res.end(JSON.stringify({
              error: err.message,
              code: 'DUPLICATE_CARD_LINK_TITLE',
            }));
            return;
          }
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // POST /api/presenter/respond
    if (pathname === '/api/presenter/respond' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { id, button, text, keepCard, sendId } = JSON.parse(body);
          log(`[Presenter] respond POST received: id=${id}, button=${button}, text=${text ? text.substring(0, 80) : '(none)'}${keepCard ? ' (keepCard)' : ''}${sendId ? ` sendId=${sendId}` : ''}`);
          if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'id is required' })); return; }

          // Special: _walkie_ prefix means route transcript to walkie-talkie queue.
          // Goes through queueDispatcher.enqueue so the walkie:enqueued socket
          // event fires — the presenter's bottom-bar send promise resolves off
          // that signal (replacing the old 24-35s queue poll that produced
          // fake "voice send failed" toasts when transcription was slow).
          if (id.startsWith('_walkie_') && text) {
            const targetSession = id.substring('_walkie_'.length);
            // enqueue() is async now (event-loop wedge fix); fire-and-forget with
            // a .catch so a rejection is logged, not left unhandled. The socket
            // 'walkie:enqueued' event (emitted inside enqueue after the write
            // commits) is what resolves the presenter send promise, so the HTTP
            // 200 here can return immediately without awaiting the disk write.
            const message = JSON.stringify({ type: 'action', from: 'josh-presenter', instruction: text });
            Promise.resolve(queueDispatcher.enqueue(targetSession, message))
              .catch((qErr) => console.error('[Presenter] Walkie-talkie route error:', qErr));
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, routed: 'walkie-talkie', target: targetSession }));
            return;
          }

          const feedback = presenterQueue.respondToItem(id, { button, text, keepCard: !!keepCard, sendId });
          if (!feedback) { log(`[Presenter] respond FAILED: item ${id} not found`); res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found' })); return; }
          // Idempotent replay of a send whose first response was lost on a flaky
          // client link: the reply already reached the steward, so report success
          // (no re-delivery happened) — this is what flips the phone's stuck
          // "retry never works" into "Sent" without double-sending.
          if (feedback._idempotent) {
            log(`[Presenter] respond IDEMPOTENT (already delivered): id=${id}, button=${button}`);
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, alreadyDelivered: true, feedback }));
            return;
          }
          log(`[Presenter] respond SUCCESS: id=${id}, button=${button}`);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, feedback }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // POST /api/presenter/run-command  { stewardId, runValue }
    // Bookmark-store-allowlisted bridge: lets a non-Electron client (APK, browser)
    // ask the laptop's Electron presenter to execute a saved scripted bookmark.
    // The command itself is never trusted from the body — server reads the saved
    // bookmark store and matches `runValue` (trimmed) against the entries for
    // `stewardId`. Only on a hit does the server emit the socket event to the
    // registered electron client(s) carrying the command pulled FROM the store.
    if (pathname === '/api/presenter/run-command' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { stewardId, runValue } = JSON.parse(body || '{}');
          if (typeof stewardId !== 'string' || !stewardId.trim() || typeof runValue !== 'string' || !runValue.trim()) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'stewardId and runValue are required' }));
            return;
          }
          const sid = stewardId.trim();
          const needle = runValue.trim();
          // Read bookmark store fresh — never cache. Store is small, write rate low.
          let store = {};
          try {
            const fs = require('fs');
            const path = require('path');
            const file = path.join(process.cwd(), 'data/steward-bookmarks.json');
            if (fs.existsSync(file)) {
              store = JSON.parse(fs.readFileSync(file, 'utf-8')) || {};
            }
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to read bookmark store: ' + err.message }));
            return;
          }
          const list = Array.isArray(store[sid]) ? store[sid] : [];
          const match = list.find(b => b && typeof b.run === 'string' && b.run.trim() === needle);
          if (!match) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Command does not match any saved scripted bookmark for this steward' }));
            return;
          }
          // Find a registered electron client to deliver to.
          const command = match.run;
          let delivered = 0;
          if (global.io && global.io.sockets && global.io.sockets.sockets) {
            for (const [, socket] of global.io.sockets.sockets) {
              if (socket.presenterClientType === 'electron') {
                socket.emit('presenter:exec-shell', { command });
                delivered++;
              }
            }
          }
          if (delivered === 0) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'No electron presenter connected to receive the command' }));
            return;
          }
          console.log(`[run-command] origin=apk-http stewardId=${sid} command=${command.slice(0, 200)} delivered=${delivered}`);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, delivered }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // POST /api/presenter/dismiss
    if (pathname === '/api/presenter/dismiss' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'id is required' })); return; }
          const feedback = presenterQueue.dismissItem(id);
          if (!feedback) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found' })); return; }
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, dismissed: id }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // POST /api/presenter/update-recap  { id, recap?, status? }
    // Backfill / correct the recap (and optionally blocked/weigh_in/fyi status) on an
    // EXISTING card. Cards otherwise only get a recap at creation; the urgency
    // view falls back to the card title when recap is missing, which reads as
    // stale. Lets a steward set a real project-level status recap on cards
    // already in the queue. Broadcasts `presenter:item-updated`.
    if (pathname === '/api/presenter/update-recap' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { id, recap, status } = JSON.parse(body);
          if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'id is required' })); return; }
          if (recap === undefined && status === undefined) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'provide recap and/or status' })); return;
          }
          if (status !== undefined && status !== 'blocked' && status !== 'weigh_in' && status !== 'fyi') {
            res.writeHead(400); res.end(JSON.stringify({ error: 'status must be "blocked", "weigh_in", or "fyi"' })); return;
          }
          const updated = presenterQueue.setCardMeta(id, { recap, status });
          if (!updated) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found' })); return; }
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, id, recap: updated.recap, status: updated.status }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // POST /api/presenter/toggle-pin/:id  { pinned?: boolean }
    // Set or toggle the `pinned` flag on a card. Pinned cards are excluded
    // from bulk-dismiss (they can still be dismissed individually). Body is
    // optional: if `pinned` is present, forces that value; otherwise toggles.
    // Broadcasts `presenter:item-updated`.
    const pinMatch = pathname.match(/^\/api\/presenter\/toggle-pin\/([a-f0-9]{12})$/);
    if (pinMatch && req.method === 'POST') {
      const id = pinMatch[1];
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          let desired = null;
          if (body) {
            const parsed = JSON.parse(body);
            if (typeof parsed.pinned === 'boolean') desired = parsed.pinned;
          }
          const current = presenterQueue.getQueue().find(c => c.id === id);
          if (!current) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found' })); return; }
          const next = desired === null ? !current.pinned : desired;
          const updated = presenterQueue.setPinned(id, next);
          if (!updated) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found' })); return; }
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, id, pinned: updated.pinned }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // POST /api/presenter/mark-seen/:id
    // Feature 2 "play/timeline" view (Josh 2026-08-25): stamp `seen_at` on a card
    // the first time the timeline surfaces it front-and-center. First-lay-eyes
    // wins — markSeen never overwrites an existing stamp. Same id regex as
    // toggle-pin ([a-f0-9]{12}, matches randomBytes(6)) so a malformed id 404s
    // cleanly. Broadcasts `presenter:item-updated` with { seen_at }.
    const seenMatch = pathname.match(/^\/api\/presenter\/mark-seen\/([a-f0-9]{12})$/);
    if (seenMatch && req.method === 'POST') {
      const id = seenMatch[1];
      const updated = presenterQueue.markSeen(id);
      if (!updated) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found' })); return true; }
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, id, seen_at: updated.seen_at }));
      return true;
    }

    // POST /api/presenter/rewrite-session  { oldSession, newSession }
    // Rewrite callback_session AND session_id old→new on every live card that
    // still carries the old name. Used when a conversational worker's session is
    // renamed by cutover (holler-X--foreman--Y → holler-X--Y) — open cards
    // stamped with the old name would misroute Josh's reply otherwise. Runs
    // in-process against the server's own `queue` (single source of truth), so
    // it can never race the server's own writes. Returns { rewritten, count }.
    if (pathname === '/api/presenter/rewrite-session' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { oldSession, newSession } = JSON.parse(body);
          if (!oldSession || !newSession) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'oldSession and newSession are required' })); return;
          }
          const result = presenterQueue.rewriteSessionRefs(oldSession, newSession);
          if (result.error) { res.writeHead(400); res.end(JSON.stringify({ error: result.error })); return; }
          log(`[Presenter] rewrite-session: ${oldSession} → ${newSession}, rewrote ${result.count} card(s): ${result.rewritten.join(', ') || '(none)'}`);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // POST /api/presenter/bulk-dismiss  { ids: [...] }
    // Dismisses many cards at once. Emits one `presenter:bulk-resolved` socket
    // event with all dismissed IDs. Pinned IDs are skipped server-side.
    // Returns { dismissed, notFound, skippedPinned }.
    if (pathname === '/api/presenter/bulk-dismiss' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { ids } = JSON.parse(body);
          if (!Array.isArray(ids) || ids.length === 0) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'ids must be a non-empty array' })); return;
          }
          const result = presenterQueue.bulkDismissItems(ids);
          log(`[Presenter] bulk-dismiss: dismissed=${result.dismissed.length} notFound=${result.notFound.length}`);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
      });
      return true;
    }

    // POST /api/presenter/triage-resolve  per Triage Dispatch Contract §2.
    // Body: { triage_session, joshua_response, groups: [...], culled: [...] }
    // Atomic relay+dismiss per card. Pinned cards relay but are never dismissed.
    // Idempotent on triage_session ≥24h. Walkies sent with type:"feedback".
    if (pathname === '/api/presenter/triage-resolve' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
          return;
        }
        try {
          const result = await triageResolve.resolveTriage(parsed);
          log(`[Presenter] triage-resolve session=${result.triage_session} dismissed=${result.dismissed.length} pinned_relayed=${result.pinned_relayed_not_dismissed.length} not_found=${result.not_found.length} atomic_failures=${result.atomic_failures.length} idempotent_replay=${result.idempotent_replay}`);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
          log(`[Presenter] triage-resolve error: ${err.message}`, 'ERROR');
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return true;
    }

    // GET /api/presenter/card/:cardId — lookup metadata for a card by id,
    // searching both the live queue and every history archive.
    const cardMatch = pathname.match(/^\/api\/presenter\/card\/([a-f0-9]{12})$/);
    if (cardMatch && req.method === 'GET') {
      const cardId = cardMatch[1];
      // Live queue first.
      const liveQueue = presenterQueue.getQueue();
      const live = liveQueue.find(c => c.id === cardId);
      if (live) {
        res.writeHead(200);
        res.end(JSON.stringify({
          id: live.id,
          title: live.title,
          timestamp: live.timestamp,
          session_id: live.session_id,
          callback_session: live.callback_session,
          source: live.source || null,
          state: 'open',
        }));
        return true;
      }
      // History scan — iterate every session history file and search for the id.
      try {
        const historyDir = require('path').join(process.cwd(), 'data', 'presenter-history');
        const fs = require('fs');
        if (fs.existsSync(historyDir)) {
          const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
          for (const file of files) {
            try {
              const history = JSON.parse(fs.readFileSync(require('path').join(historyDir, file), 'utf-8'));
              if (!Array.isArray(history)) continue;
              const hit = history.find(c => c && c.id === cardId);
              if (hit) {
                res.writeHead(200);
                res.end(JSON.stringify({
                  id: hit.id,
                  title: hit.title,
                  timestamp: hit.timestamp,
                  session_id: hit.session_id,
                  callback_session: hit.callback_session,
                  source: hit.source || null,
                  state: hit.feedback && hit.feedback.dismissed ? 'dismissed' : 'responded',
                  resolved_at: hit.resolved_at || null,
                }));
                return true;
              }
            } catch { /* skip bad file */ }
          }
        }
      } catch (err) {
        log(`[Presenter] card lookup scan error: ${err.message}`);
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Card not found', id: cardId }));
      return true;
    }

    // GET /api/presenter/status/:id
    const statusMatch = pathname.match(/^\/api\/presenter\/status\/(.+)$/);
    if (statusMatch && req.method === 'GET') {
      const status = presenterQueue.getDeliveryStatus(statusMatch[1]);
      if (!status) { res.writeHead(404); res.end(JSON.stringify({ error: 'Item not found' })); }
      else { res.writeHead(200); res.end(JSON.stringify(status)); }
      return true;
    }

    // GET /api/presenter/history-search?q=&steward=&limit=
    // Cross-steward archive search. q = text in title/message/feedback,
    // steward = substring filter on session_id (e.g. "givegrove"),
    // limit = cap (default 200, max 2000). Returns newest-first across stewards.
    if (pathname === '/api/presenter/history-search' && req.method === 'GET') {
      const results = presenterQueue.searchAllHistory({
        q: parsedUrl.query.q,
        steward: parsedUrl.query.steward,
        stewardExact: parsedUrl.query.stewardExact,
        limit: parsedUrl.query.limit,
      });
      res.writeHead(200);
      res.end(JSON.stringify({ results, count: results.length }));
      return true;
    }

    // GET /api/presenter/unified-log?steward=<sessionId>&limit=N
    // Read-time merge of every existing message store (live cards + archived
    // history + walkie queue) into one chronological log for a steward. NO new
    // persistent store — this only reads what already exists. Powers the mobile
    // Presenter's unified message log (Recent + History collapsed into one view).
    if (pathname === '/api/presenter/unified-log' && req.method === 'GET') {
      const entries = presenterQueue.getUnifiedLog(parsedUrl.query.steward, {
        limit: parsedUrl.query.limit,
      });
      res.writeHead(200);
      res.end(JSON.stringify({ entries, count: entries.length }));
      return true;
    }

    // GET /api/presenter/history-stewards — steward index for the History
    // surface's filter dropdown. Returns [{ session_id, count }, ...].
    if (pathname === '/api/presenter/history-stewards' && req.method === 'GET') {
      const stewards = presenterQueue.listHistoryStewards();
      res.writeHead(200);
      res.end(JSON.stringify(stewards));
      return true;
    }

    // GET /api/presenter/history/:sessionId
    const historyMatch = pathname.match(/^\/api\/presenter\/history\/(.+)$/);
    if (historyMatch && req.method === 'GET') {
      const history = presenterQueue.getHistory(decodeURIComponent(historyMatch[1]));
      res.writeHead(200);
      res.end(JSON.stringify(history));
      return true;
    }

    // 2026-04-28 Joshua's phone-trackpad ask: when he taps "→ Card" or
    // "→ Steward" on his phone, he wants the claim routed to whatever
    // his DESKTOP Electron presenter has focused, not the phone's own
    // presenter (which is irrelevant — he uses the phone as a remote
    // control for his Mac). The Electron app POSTs to this endpoint on
    // every focused-card / selected-steward change; the Mac PhoneMouse
    // companion GETs it when the phone fires a claim.
    if (pathname === '/api/presenter/desktop-current') {
      if (req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(global.__presenterDesktopCurrent || { cardId: '', selectedSteward: '' }));
        return true;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            // Accept either field independently — partial updates are fine.
            const prev = global.__presenterDesktopCurrent || { cardId: '', selectedSteward: '' };
            global.__presenterDesktopCurrent = {
              cardId: typeof data.cardId === 'string' ? data.cardId : prev.cardId,
              selectedSteward: typeof data.selectedSteward === 'string' ? data.selectedSteward : prev.selectedSteward,
            };
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, current: global.__presenterDesktopCurrent }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
          }
        });
        return true;
      }
    }

    return false;
  }

  // Create server - HTTPS if enabled, otherwise HTTP
  let server;
  if (useHttps) {
    const httpsOptions = {
      key: readFileSync(join(__dirname, 'server-key.pem')),
      cert: readFileSync(join(__dirname, 'server-cert.pem'))
    };
    // Force no-store on presenter static assets so mobile WebView never
    // serves a stale app.js/style.css/index.html. Joshua was seeing stale
    // code on mobile causing visible bugs that were already fixed server-side.
    function applyPresenterNoCache(req, res, parsedUrl) {
      const p = parsedUrl.pathname || '';
      if (p === '/presenter' || p === '/presenter/' || p.startsWith('/presenter/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }
    server = createHttpsServer(httpsOptions, async (req, res) => {
      try {
        const parsedUrl = parse(req.url, true);
        if (handleHealthRoute(req, res, parsedUrl)) return;
        const blocked = enforceGuestAccess(req, res, parsedUrl);
        if (blocked) return;
        if (handleQueueRoutes(req, res, parsedUrl)) return;
        if (handlePresenterRoutes(req, res, parsedUrl)) return;
        applyPresenterNoCache(req, res, parsedUrl);
        await handle(req, res, parsedUrl);
      } catch (err) {
        console.error('Error occurred handling', req.url, err);
        res.statusCode = 500;
        res.end('internal server error');
      }
    });
    log('[Server] HTTPS mode enabled', 'STARTUP');
  } else {
    function applyPresenterNoCache(req, res, parsedUrl) {
      const p = parsedUrl.pathname || '';
      if (p === '/presenter' || p === '/presenter/' || p.startsWith('/presenter/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }
    server = createHttpServer(async (req, res) => {
      try {
        const parsedUrl = parse(req.url, true);
        if (handleHealthRoute(req, res, parsedUrl)) return;
        const blocked = enforceGuestAccess(req, res, parsedUrl);
        if (blocked) return;
        if (handleQueueRoutes(req, res, parsedUrl)) return;
        if (handlePresenterRoutes(req, res, parsedUrl)) return;
        applyPresenterNoCache(req, res, parsedUrl);
        await handle(req, res, parsedUrl);
      } catch (err) {
        console.error('Error occurred handling', req.url, err);
        res.statusCode = 500;
        res.end('internal server error');
      }
    });
  }

  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    },
    pingInterval: 10000,   // Ping every 10s (default 25s) — detect dead connections faster
    pingTimeout: 5000,     // 5s to respond (default 20s)
  });

  // Expose io globally for API routes (e.g., /api/navigate)
  global.io = io;

  // Wire up presenter queue with Socket.IO for real-time broadcasting
  presenterQueue.setIo(io);
  // Wire up walkie-talkie queue dispatcher too — broadcasts walkie:enqueued /
  // walkie:confirmed so the presenter UI can resolve send-promises from an
  // explicit signal instead of polling /api/queue (which produced fake error
  // toasts when the poll outran transcription or steward ack speed).
  queueDispatcher.setIo(io);

  // --- Real-time session status + activity broadcasting ---
  // Server polls activity files every 5s, broadcasts changes to all clients
  let lastBroadcastedStatuses = {};
  let lastBroadcastedActivity = {};

  setInterval(() => {
    const fs = require('fs');
    const path = require('path');
    try {
      const files = fs.readdirSync('/tmp').filter(f => f.startsWith('claude-session-') && f.endsWith('-activity.json'));
      const newStatuses = {};
      const activityUpdates = {};

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join('/tmp', file), 'utf-8');
          const data = JSON.parse(content);
          const sessionName = data.tmux_session;
          if (!sessionName) continue;

          // Session status
          const status = data.is_working ? 'working' : 'waiting';
          newStatuses[sessionName] = { status };

          // Activity: check if last activity changed
          const activities = data.activities || [];
          const lastActivity = activities.length > 0 ? activities[activities.length - 1] : null;
          const lastKey = lastActivity ? `${lastActivity.id}-${lastActivity.phase}` : '';
          if (lastKey && lastBroadcastedActivity[sessionName] !== lastKey) {
            lastBroadcastedActivity[sessionName] = lastKey;
            activityUpdates[sessionName] = {
              activities: activities.slice(-10),
              is_working: data.is_working,
              current_tool: data.current_tool
            };
          }
        } catch {}
      }

      // Broadcast status changes
      const statusChanged = JSON.stringify(newStatuses) !== JSON.stringify(lastBroadcastedStatuses);
      if (statusChanged) {
        lastBroadcastedStatuses = newStatuses;
        io.emit('presenter:status-update', newStatuses);
      }

      // Broadcast activity updates
      if (Object.keys(activityUpdates).length > 0) {
        io.emit('presenter:activity-update', activityUpdates);
      }
    } catch {}
  }, 5000);

  // --- Real-time thinking capture via tmux pane ---
  // For working sessions, capture visible pane content every 3 seconds
  let lastPaneContent = {};
  const { exec } = require('child_process');
  setInterval(() => {
    // Only capture for sessions that are currently working
    for (const [sessionName, statusData] of Object.entries(lastBroadcastedStatuses)) {
      if (statusData.status !== 'working') continue;
      exec(`tmux capture-pane -t "${sessionName}" -p -S -10 2>/dev/null`, { timeout: 2000 }, (err, stdout) => {
        if (err || !stdout) return;
        const lines = stdout.trim();
        // Skip if same as last capture
        if (lastPaneContent[sessionName] === lines) return;
        lastPaneContent[sessionName] = lines;

        // Extract the most recent text block (after the last ⏺ or ── separator)
        const lineArr = lines.split('\n');
        let thoughtLines = [];
        for (let i = lineArr.length - 1; i >= 0; i--) {
          const line = lineArr[i].trim();
          // Stop at prompt separator or tool indicator
          if (line.startsWith('──') || line.startsWith('❯') || line === '') {
            if (thoughtLines.length > 0) break;
            continue;
          }
          thoughtLines.unshift(line);
        }
        const thought = thoughtLines.join(' ').trim();
        if (thought && thought.length > 5) {
          io.emit('presenter:thinking', {
            session: sessionName,
            text: thought.substring(0, 300),
            timestamp: new Date().toISOString()
          });
        }
      });
    }
  }, 3000);

  const terminalManager = new TerminalManager();
  const tmuxManager = new TmuxManager();

  io.on('connection', (socket) => {
    log(`[Socket] Client connected: ${socket.id}, address: ${socket.handshake.address}`);

    // Guard: disconnect guests from terminal streaming
    const socketIdentity = guestManager.getIdentity(socket.request);
    if (socketIdentity.role !== 'owner') {
      log(`[Socket] Disconnecting non-owner: ${socket.id} (role: ${socketIdentity.role}, login: ${socketIdentity.login})`);
      socket.disconnect(true);
      return;
    }

    // ===== TMUX SESSION HANDLERS =====
    // Track which sessions this socket is subscribed to (for cleanup)
    const subscribedSessions = new Set();

    socket.on('tmux:attach', (rawSessionName) => {
      // Decode URI-encoded session names (e.g., %2F -> /)
      const sessionName = decodeURIComponent(rawSessionName);
      log(`[Socket] tmux:attach - session: ${sessionName}, client: ${socket.id}`);

      try {
        // Create data handler for this client
        let dataReceived = 0;
        const dataHandler = (data) => {
          dataReceived++;
          if (dataReceived <= 3) {
            log(`[Socket] Forwarding PTY data to ${socket.id} for ${sessionName} (chunk ${dataReceived}, ${data.length} bytes)`);
          }
          socket.emit('tmux:output', data);
        };

        // Subscribe to session (creates PTY if needed, or reuses existing).
        // PTY 'exit' is fanned out by a persistent listener in TmuxManager.getOrCreatePty;
        // a per-socket once('exit') here would leak across reattaches (warm-pooled PTYs).
        const session = tmuxManager.subscribe(sessionName, socket.id, dataHandler, socket);
        subscribedSessions.add(sessionName);

        // Signal ready and refresh screen
        // Use shorter delay since PTY may already be warm
        const isWarm = session.clients.size > 1 || (Date.now() - session.created) > 1000;
        const readyDelay = isWarm ? 50 : 100;

        setTimeout(() => {
          log(`[Socket] Emitting tmux:ready for ${sessionName} to client ${socket.id} (warm: ${isWarm})`);
          socket.emit('tmux:ready', sessionName);
          // Refresh screen with Ctrl+L to get current terminal state (debounced
          // so it never pairs with a client-side refresh -> Claude's /clear).
          tmuxManager.writeCtrlL(sessionName);
        }, readyDelay);

      } catch (error) {
        log(`[Socket] tmux:attach error: ${error.message}`, 'ERROR');
        socket.emit('tmux:error', `Failed to attach: ${error.message}`);
      }
    });

    socket.on('tmux:input', (sessionName, data) => {
      // A lone Ctrl+L is a screen-refresh, not user keystrokes — route it through
      // the per-session debounce so a client refresh can never pair with the
      // server's own attach refresh and trigger Claude's double-Ctrl+L -> /clear.
      // Any other data (incl. input that merely contains \x0c) is written verbatim.
      if (data === '\x0c') {
        tmuxManager.writeCtrlL(sessionName);
      } else {
        tmuxManager.writeToSession(sessionName, data);
      }
    });

    socket.on('tmux:resize', (sessionName, cols, rows) => {
      tmuxManager.resizeSession(sessionName, cols, rows);
    });

    socket.on('tmux:snapshot', (rawSessionName, opts, callback) => {
      // Support both (name, callback) and (name, opts, callback) signatures
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      const sessionName = decodeURIComponent(rawSessionName);
      const { cols, rows } = opts || {};
      const tmuxEnv = tmuxManager._tmuxEnv();
      try {
        // If client sent dimensions, resize tmux pane first so capture matches xterm
        if (cols && rows) {
          try {
            execSync(`tmux resize-pane -t "${sessionName}" -x ${cols} -y ${rows}`, { timeout: 1000, env: tmuxEnv });
          } catch (resizeErr) {
            // Non-fatal — capture at current size
          }
        }
        // Capture plain text (no -e flag — tmux escape sequences garble xterm.js)
        // Colors come through the normal pty pipeline via Ctrl+L redraw after snapshot
        const content = execSync(
          `tmux capture-pane -t "${sessionName}" -p`,
          { encoding: 'utf-8', timeout: 3000, env: tmuxEnv }
        );
        if (typeof callback === 'function') callback({ success: true, data: content });
      } catch (err) {
        log(`[Socket] tmux:snapshot error for ${sessionName}: ${err.message}`, 'WARN');
        if (typeof callback === 'function') callback({ success: false, error: err.message });
      }
    });

    // Resize-free capture for the presenter's clean-scrollback buffer. Unlike
    // tmux:snapshot (which resizes the pane every call and would flicker the
    // live desk view), this only reads the current visible frame — polled every
    // ~500ms by the in-app tmux viewer to reconstruct clean scroll-up history.
    socket.on('tmux:capture', (rawSessionName, callback) => {
      const sessionName = decodeURIComponent(rawSessionName);
      const tmuxEnv = tmuxManager._tmuxEnv();
      try {
        const content = execSync(
          `tmux capture-pane -t "${sessionName}" -p`,
          { encoding: 'utf-8', timeout: 2000, env: tmuxEnv }
        );
        if (typeof callback === 'function') callback({ success: true, data: content });
      } catch (err) {
        if (typeof callback === 'function') callback({ success: false, error: err.message });
      }
    });

    socket.on('tmux:scroll', (rawSessionName, direction, lines) => {
      const sessionName = decodeURIComponent(rawSessionName);
      const dir = direction === 'up' ? 'up' : 'down';
      const n = Math.max(1, Math.min(lines || 1, 15));
      try {
        // Enter copy-mode (idempotent) and scroll N lines via tmux directly
        // This bypasses Claude Code's mouse handling which eats scroll events
        execSync(
          `tmux copy-mode -t "${sessionName}" 2>/dev/null; tmux send-keys -t "${sessionName}" -N ${n} -X scroll-${dir}`,
          { timeout: 1000, stdio: 'pipe', env: tmuxManager._tmuxEnv() }
        );
      } catch (err) {
        // Non-fatal — scroll just won't work for this tick
      }
    });

    socket.on('tmux:detach', (sessionName) => {
      log(`[Socket] tmux:detach - session: ${sessionName}, client: ${socket.id}`);
      // Unsubscribe but keep PTY warm
      tmuxManager.unsubscribe(sessionName, socket.id);
      subscribedSessions.delete(sessionName);
    });

    // Clean up all subscriptions when socket disconnects
    socket.on('disconnect', () => {
      log(`[Socket] Client ${socket.id} disconnecting, cleaning up ${subscribedSessions.size} subscriptions`);
      for (const sessionName of subscribedSessions) {
        tmuxManager.unsubscribe(sessionName, socket.id);
        // If no clients left, start grace period instead of immediate kill
        const session = tmuxManager.getSession(sessionName);
        if (session && session.clients.size === 0) {
          log(`[Socket] No clients left for ${sessionName}, starting grace period`);
          tmuxManager.detachSession(sessionName); // uses 30s grace period
        }
      }
      subscribedSessions.clear();
    });

    // ===== DOCS FILE WATCHER HANDLERS =====
    // Track active watchers for this socket
    const docWatchers = new Map();

    socket.on('docs:watch', (projectPath) => {
      log(`[Socket] docs:watch - path: ${projectPath}, client: ${socket.id}`);

      // Clean up existing watcher for this path if any
      if (docWatchers.has(projectPath)) {
        docWatchers.get(projectPath).close();
      }

      const planPath = join(projectPath, 'PLAN.md');
      const statePath = join(projectPath, 'STATE.md');

      // Debounce to avoid rapid-fire events
      let debounceTimer = null;
      const notifyChange = (file) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          log(`[DocsWatcher] File changed: ${file}`);
          // Read and emit the updated content
          const docs = {
            plan: existsSync(planPath) ? readFileSync(planPath, 'utf-8') : null,
            state: existsSync(statePath) ? readFileSync(statePath, 'utf-8') : null,
          };
          socket.emit('docs:updated', projectPath, docs);
        }, 300);
      };

      // Watch the directory for changes to PLAN.md and STATE.md
      try {
        const watcher = watch(projectPath, (eventType, filename) => {
          if (filename === 'PLAN.md' || filename === 'STATE.md') {
            notifyChange(filename);
          }
        });

        docWatchers.set(projectPath, watcher);
        log(`[DocsWatcher] Watching ${projectPath} for PLAN.md/STATE.md changes`);

        watcher.on('error', (err) => {
          log(`[DocsWatcher] Watch error for ${projectPath}: ${err.message}`, 'ERROR');
        });
      } catch (err) {
        log(`[DocsWatcher] Failed to watch ${projectPath}: ${err.message}`, 'ERROR');
      }
    });

    socket.on('docs:unwatch', (projectPath) => {
      log(`[Socket] docs:unwatch - path: ${projectPath}, client: ${socket.id}`);
      if (docWatchers.has(projectPath)) {
        docWatchers.get(projectPath).close();
        docWatchers.delete(projectPath);
      }
    });

    // Clean up doc watchers on disconnect
    socket.on('disconnect', () => {
      docWatchers.forEach((watcher, path) => {
        log(`[DocsWatcher] Cleaning up watcher for ${path} on disconnect`);
        watcher.close();
      });
      docWatchers.clear();
    });

    // ===== LEGACY TERMINAL HANDLERS =====

    socket.on('terminal:create', (sessionId, cwd) => {
      log(`[Socket] terminal:create event - sessionId: ${sessionId}, cwd: ${cwd || 'default'}, client: ${socket.id}`);

      try {
        const terminal = terminalManager.createTerminal(sessionId, cwd);
        terminal.clients.add(socket.id);
        log(`[Socket] Added client ${socket.id} to terminal ${sessionId}, total clients: ${terminal.clients.size}`);

        // Send ready event
        log(`[Socket] Emitting terminal:ready for session: ${sessionId}`);
        socket.emit('terminal:ready', sessionId);

        // Only auto-start for non-tmux sessions
        // For tmux sessions, Claude is already running in the session
        if (!terminal.isTmuxSession) {
          // Auto-start Claude Code in project directory after a brief delay
          log(`[Socket] Scheduling auto-start commands for session: ${sessionId}`);
          setTimeout(() => {
            if (terminal.ptyProcess) {
              log(`[Socket] Executing auto-start: cd /root/project`);
              terminal.ptyProcess.write('cd /root/project\n');
              setTimeout(() => {
                log(`[Socket] Executing auto-start: clear`);
                terminal.ptyProcess.write('clear\n');
                setTimeout(() => {
                  // Interpolate the ABSOLUTE resolved claude path — a bare `claude`
                  // token is re-resolved by this local shell via PATH, which grabs
                  // the stale /opt/homebrew build under launchd → 404. See
                  // lib/claude-resolver.js.
                  const claudeBin = resolveClaudePath();
                  log(`[Socket] Executing auto-start: IS_SANDBOX=1 ${claudeBin} --dangerously-skip-permissions`);
                  terminal.ptyProcess.write(`IS_SANDBOX=1 ${claudeBin} --dangerously-skip-permissions\n`);
                }, 100);
              }, 100);
            } else {
              log(`[Socket] Auto-start failed - ptyProcess is null for session: ${sessionId}`, 'ERROR');
            }
          }, 500);
        } else {
          log(`[Socket] Skipping auto-start for tmux session: ${sessionId}`);
        }

        // Forward PTY data to client
        terminal.ptyProcess.on('data', (data) => {
          // Don't log every data event - too spammy
          socket.emit('terminal:output', sessionId, data);
        });

        // Handle PTY exit
        terminal.ptyProcess.on('exit', (exitCode) => {
          log(`[Terminal] Process exited with code ${exitCode} for session: ${sessionId}`);
          socket.emit('terminal:exit', sessionId, { exitCode });
          terminalManager.killTerminal(sessionId);
        });

      } catch (error) {
        log(`[Terminal] Error creating terminal for session ${sessionId}: ${error.message}`, 'ERROR');
        log(`[Terminal] Error stack: ${error.stack}`, 'ERROR');
        socket.emit('terminal:error', sessionId, error.message);
      }
    });

    socket.on('terminal:input', (sessionId, data) => {
      // Already logged in writeToTerminal
      terminalManager.writeToTerminal(sessionId, data);
    });

    socket.on('terminal:resize', (sessionId, cols, rows) => {
      // Already logged in resizeTerminal
      terminalManager.resizeTerminal(sessionId, cols, rows);
    });

    socket.on('terminal:kill', (sessionId) => {
      log(`[Socket] terminal:kill event for session: ${sessionId}, client: ${socket.id}`);
      terminalManager.killTerminal(sessionId);
      socket.emit('terminal:killed', sessionId);
    });

    // Legacy terminal disconnect cleanup (separate from tmux cleanup above)
    socket.on('disconnect', () => {
      log(`[Socket] Client disconnected: ${socket.id}`);
      // Clean up legacy terminals if no clients left
      terminalManager.terminals.forEach((terminal, sessionId) => {
        terminal.clients.delete(socket.id);
        log(`[Socket] Removed client ${socket.id} from terminal ${sessionId}, remaining: ${terminal.clients.size}`);
        if (terminal.clients.size === 0) {
          log(`[Terminal] No clients left, killing terminal: ${sessionId}`);
          terminalManager.killTerminal(sessionId);
        }
      });
    });
  });

  // Periodic cleanup of idle PTY sessions (every 5 minutes)
  setInterval(() => {
    tmuxManager.cleanupIdle();
  }, 5 * 60 * 1000);

  log(`[Server] Starting ${useHttps ? 'HTTPS' : 'HTTP'} server on ${hostname}:${port}`, 'STARTUP');
  server.listen(port, hostname, (err) => {
    if (err) {
      // LOAD-BEARING: drain log line to disk before crash unwinds process.
      // log() now queues to a stream; throwing immediately would race the flush.
      logStream.write(`[${new Date().toISOString()}] [ERROR] [Server] Failed to start: ${err.message}\n`);
      logStream.end(() => { throw err; });
      return;
    }
    log(`[Server] Ready on http://${hostname}:${port}`, 'STARTUP');
    log(`[Server] Socket.IO server running`, 'STARTUP');
    log(`[Server] PTY pool enabled (max ${tmuxManager.maxPoolSize} sessions)`, 'STARTUP');
    log(`[Server] Log file: ${LOG_FILE}`, 'STARTUP');

    // Probe 1: event-loop utilization, sampled every 30s (diffed against prior sample)
    let prevElu = performance.eventLoopUtilization();
    setInterval(() => {
      const nextElu = performance.eventLoopUtilization();
      const diff = performance.eventLoopUtilization(nextElu, prevElu);
      prevElu = nextElu;
      log(`[ELU] util=${diff.utilization.toFixed(3)}`, 'PROBE');
    }, 30_000);

    // Probe 2: self-ping latency to /api/health every 60s; WARN if >5s
    const http = require('http');
    setInterval(() => {
      const start = process.hrtime.bigint();
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 30_000 }, (res2) => {
        res2.resume();
        res2.on('end', () => {
          const rtMs = Number(process.hrtime.bigint() - start) / 1e6;
          log(`[SELFPING] rt_ms=${rtMs.toFixed(1)}`, 'PROBE');
          if (rtMs > 5000) {
            log(`[SELFPING WARN] rt_ms=${rtMs.toFixed(1)}`, 'WARN');
          }
        });
      });
      req.on('error', (err) => {
        const rtMs = Number(process.hrtime.bigint() - start) / 1e6;
        log(`[SELFPING] rt_ms=${rtMs.toFixed(1)} error=${err.code || err.message}`, 'PROBE');
        if (rtMs > 5000) {
          log(`[SELFPING WARN] rt_ms=${rtMs.toFixed(1)} error=${err.code || err.message}`, 'WARN');
        }
      });
      req.on('timeout', () => req.destroy(new Error('selfping_timeout')));
    }, 60_000);

    // Probe 4: event-loop lag via setImmediate-delta, sampled every 5s.
    // baseline: measure on this branch's HEAD pre-Tier-1 for 30+ min;
    // post-merge: measure on this branch's HEAD post-Tier-1 for 30+ min;
    // expected: P95 lag drops materially (REPORT.md predicts compound-sync-syscall
    // pollution as the dominant blocker — async-ify drains the loop).
    setInterval(() => {
      const scheduledAt = Date.now();
      setImmediate(() => {
        const lagMs = Date.now() - scheduledAt;
        log(`[EL-LAG] ms=${lagMs}`, 'PROBE');
        if (lagMs > 200) log(`[EL-LAG WARN] ms=${lagMs}`, 'WARN');
      });
    }, 5000);

    // Steward queue dispatcher — file watcher + 10s fallback
    const QUEUE_FILE = require('path').join(require('os').homedir(), '.homestead', 'queue.json');
    let dispatchDebounce = null;
    // These dispatcher methods are async (they route writes through the queue
    // mutex). Called fire-and-forget below, so a rejected write would otherwise
    // escape as an unhandledRejection and — on Node >=15 — terminate this very
    // :3005 process. Swallow+log so a transient write failure can't crash the
    // server this dispatch loop is meant to keep alive.
    const swallow = (label) => (e) =>
      log(`[Server] ${label} failed: ${e && e.message ? e.message : e}`, 'ERROR');
    function runDispatch() {
      queueDispatcher.tick().catch(swallow('runDispatch.tick'));
      queueDispatcher.processTimers().catch(swallow('runDispatch.processTimers'));
      // Drain terminal (confirmed/failed/skipped) items to dated archives every
      // tick. Cheap: early-returns unless something has lingered past the grace
      // window. This is what keeps queue.json small so the per-tick JSON.parse
      // stays fast across the whole fleet.
      queueDispatcher.cleanQueue().catch(swallow('runDispatch.cleanQueue'));
    }

    // ── GATE: autonomous dispatch loop (prod checkout only) ──────────────────
    // This loop ticks + delivers + CLEANS the SHARED ~/.homestead/queue.json on a
    // timer with NO user request. A worktree server running it means TWO processes
    // delivering/cleaning the same fleet queue = cross-process corruption + phantom
    // deliveries. Request-driven enqueue/confirm (the POST /api/queue routes) stay
    // un-gated below — those are user actions, not autonomous fleet machinery.
    if (IS_PROD_CHECKOUT) {
      // Ensure queue file exists before watching
      if (!require('fs').existsSync(QUEUE_FILE)) {
        require('fs').writeFileSync(QUEUE_FILE, '[]');
      }

      // Immediate dispatch on queue file change (debounced to 500ms)
      try {
        require('fs').watch(QUEUE_FILE, () => {
          if (dispatchDebounce) clearTimeout(dispatchDebounce);
          dispatchDebounce = setTimeout(runDispatch, 500);
        });
        log('[Server] Watching queue file for instant dispatch', 'STARTUP');
      } catch (e) {
        log(`[Server] Could not watch queue file, relying on polling: ${e.message}`, 'STARTUP');
      }

      // Fallback: poll every 10s in case fs.watch misses events
      setInterval(runDispatch, 10000);
    } else {
      log('[Server] Dispatch loop SKIPPED — not prod checkout (worktree dev server); shared queue.json untouched by autonomous machinery', 'STARTUP');
    }

    // Potato-tracker corrections-officer HEARTBEAT (READ-only for now).
    // Runs a heartbeat pass every 5s — matching the settled "two checks 5s apart"
    // cadence. Each pass reads every open potato's holder is_working signal and
    // advances the two-strike suspicion state machine (potato-tracker.heartbeatPass).
    //
    // 🛑 GATE-B HOLD: this loop deliberately takes NO ACTION on the suspects it
    // returns. Ringing the holder, the false-alarm REVERSAL (flip is_working back),
    // and the genuine-stuck Rooster-raise all read/write the SAME is_working signal
    // that lib/check-stalled-workers.js reads and Rooster's pane-classifier uses —
    // that reconciliation is Rooster's call and must clear GATE-B before it's
    // hardened. Until then we only READ + log suspects so the mechanism can be
    // observed live without colliding with the existing stall watchdog.
    //
    // ── GATE: potato heartbeat (prod checkout only) ──────────────────────────
    // rings holders + raises Rooster (real fleet walkies) on a timer. A worktree
    // server running this = phantom rings/raises to the fleet.
    if (IS_PROD_CHECKOUT) try {
      const potatoTracker = require('./lib/potato-tracker');
      const HEARTBEAT_MS = parseInt(process.env.POTATO_HEARTBEAT_MS || '5000', 10);
      setInterval(() => {
        let suspects;
        try {
          ({ suspects } = potatoTracker.heartbeatPass());
        } catch (e) {
          log(`[PotatoHeartbeat] pass error (non-fatal): ${e.message}`, 'WARN');
          return;
        }
        if (suspects && suspects.length) {
          // Reversal (GATE-B cleared, Rooster Option A): re-confirm on read + pane
          // fallback → silent stand-down OR ring; genuinely-stuck-after-ring →
          // raise Rooster. NEVER writes is_working. Async; errors are swallowed so
          // the interval can never crash the server.
          potatoTracker.processSuspects(suspects)
            .then((r) => {
              if (r && (r.rang.length || r.raised.length || r.stoodDown.length)) {
                log(`[PotatoHeartbeat] reversal: stoodDown=${r.stoodDown.length} rang=${r.rang.length} raised=${r.raised.length}`, 'INFO');
              }
            })
            .catch((e) => log(`[PotatoHeartbeat] processSuspects error (non-fatal): ${e.message}`, 'WARN'));
        }
      }, HEARTBEAT_MS);
      log('[Server] Potato-tracker heartbeat started (reversal LIVE — Option A, never writes is_working)', 'STARTUP');
    } catch (e) {
      log(`[Server] Potato-tracker heartbeat not started: ${e.message}`, 'STARTUP');
    }
    else log('[Server] Potato heartbeat SKIPPED — not prod checkout (worktree dev server)', 'STARTUP');

    // ── GATE: steward auto-committer (prod checkout only) ────────────────────
    // Auto-commits changes under ~/.homestead/stewards/ to the SHARED stewards git
    // repo. A worktree server committing to that shared repo = fleet-state corruption.
    if (IS_PROD_CHECKOUT) {
      // Steward file watcher — auto-commits strategy/action changes
      stewardWatcher.start();

      // Status-transition tracker — records when each session's status last
      // CHANGED (working↔waiting↔idle), persisted so the presenter's worker rows
      // show real status-change age, not last-tool-activity age. Loads prior
      // transitions from its /tmp file on start so they survive a restart.
      // Gated with the steward watcher: it's an autonomous periodic writer to the
      // machine-global /tmp/claude-status-transitions.json that the prod server owns;
      // a second (worktree) writer would race + corrupt the presenter's status source.
      try {
        statusTransitionTracker.start();
      } catch (e) {
        log(`[Server] Status-transition tracker not started: ${e.message}`, 'STARTUP');
      }
    } else {
      log('[Server] Steward watcher + status-transition tracker SKIPPED — not prod checkout (worktree dev server); shared stewards repo + status file untouched', 'STARTUP');
    }

    // ── GATE: session restore (prod checkout only) ───────────────────────────
    // Spawns tmux sessions (fleet actors). A worktree server spawning the fleet's
    // sessions on boot = phantom/duplicate steward spawns.
    if (!IS_PROD_CHECKOUT) {
      log('[SessionRestore] SKIPPED — not prod checkout (worktree dev server); no tmux session spawns', 'STARTUP');
    } else
    // Restore previously active sessions (fast boot after reboot/sleep)
    (function restoreSessions() {
      const snapshotFile = join(os.homedir(), '.homestead', 'data', 'active-sessions.json');
      try {
        if (!existsSync(snapshotFile)) return;
        const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf-8'));
        const savedSessions = snapshot.sessions || [];
        if (!savedSessions.length) return;

        // Check which sessions are already alive
        let alive = [];
        try {
          alive = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' })
            .trim().split('\n').filter(Boolean);
        } catch {}

        const toStart = savedSessions.filter(s => !alive.includes(s));
        if (!toStart.length) {
          log(`[SessionRestore] All ${savedSessions.length} sessions already alive`, 'STARTUP');
          return;
        }

        log(`[SessionRestore] Restoring ${toStart.length} sessions (${alive.length} already alive)...`, 'STARTUP');

        // Resolve claude path — newest-version, not PATH-order (see lib/claude-resolver.js).
        const claudePath = resolveClaudePath();

        // Build --add-dir flags
        const codeDir = join(os.homedir(), 'code');
        let addDirFlags = '';
        try {
          addDirFlags = execSync(`ls -d "${codeDir}"/*/`, { encoding: 'utf-8' })
            .trim().split('\n')
            .filter(d => d && !d.includes('node_modules'))
            .map(d => `--add-dir '${d.replace(/\/$/, '')}'`)
            .join(' ');
        } catch {}

        const baseFlags = `--dangerously-skip-permissions ${addDirFlags}`;
        let started = 0;

        for (const sessionName of toStart) {
          try {
            // Resolve session directory using steward-resolver
            const resolver = require('./lib/steward-resolver');
            const result = resolver.resolveTarget(sessionName);
            const sessionDir = result.valid ? result.directory : null;

            if (!sessionDir || !existsSync(sessionDir)) {
              log(`[SessionRestore] Skipping ${sessionName} — directory not found`, 'WARN');
              continue;
            }

            // Fleet-wide rip-and-replace (2026-05-04): NO --continue on SessionRestore.
            // SessionRestore stays minimal — tmux-session-existence, not session-readiness.
            // Fresh-spawn restored sessions come up empty (no scrollback). The next walkie
            // arriving for a restored session goes through the dispatcher's normal wake-async
            // path (queue-dispatcher.js scheduleAsyncWake) which DOES inject the marker-first
            // bootstrap pointing at HANDOFF.md. Two-tick delivery: tick 1 spawns fresh-empty,
            // tick 2 (when walkie arrives) wakes via wakeFreshSpawn → bootstrap → marker →
            // original walkie. Self-correcting; no thundering-herd of N sessions all running
            // 45s ready-poll + marker-deadman in parallel at server startup.
            const claudeCmd = `${claudePath} ${baseFlags}; zsh`;
            execSync(`tmux new-session -d -s "${sessionName}" -c "${sessionDir}" "${claudeCmd}"`, { stdio: 'pipe' });
            started++;
          } catch (e) {
            log(`[SessionRestore] Failed to start ${sessionName}: ${e.message}`, 'WARN');
          }
        }

        log(`[SessionRestore] Restored ${started}/${toStart.length} sessions`, 'STARTUP');
      } catch (e) {
        log(`[SessionRestore] Error: ${e.message}`, 'ERROR');
      }
    })();

    // Auto-start whisper-server for voice transcription
    (function startWhisperServer() {
      const WHISPER_PORT = 8178;
      const WHISPER_MODEL = join(os.homedir(), 'Library/Application Support/town.mullet.WhisperVillage/WhisperModels/ggml-large-v3-turbo-q5_0.bin');

      // Check if already running
      try {
        execSync(`lsof -ti:${WHISPER_PORT}`, { stdio: 'pipe' });
        log(`[Whisper] Already running on port ${WHISPER_PORT}`, 'STARTUP');
        return;
      } catch (e) {
        // Not running — start it
      }

      if (!existsSync(WHISPER_MODEL)) {
        log(`[Whisper] Model not found: ${WHISPER_MODEL}`, 'WARN');
        return;
      }

      log(`[Whisper] Starting whisper-server on port ${WHISPER_PORT}...`, 'STARTUP');
      // stdio→fd (not pipe) so whisper's per-line chatter never crosses Node's event loop.
      // Tail /tmp/whisper-server.log + .err for whisper progress (was inline in homestead-server.log).
      const fs = require('fs');
      const WHISPER_LOG = '/tmp/whisper-server.log';
      const WHISPER_ERR = '/tmp/whisper-server.err';
      const whisperOutFd = fs.openSync(WHISPER_LOG, 'a');
      const whisperErrFd = fs.openSync(WHISPER_ERR, 'a');
      const whisperProc = spawn('/opt/homebrew/bin/whisper-server', [
        '--model', WHISPER_MODEL,
        '--port', String(WHISPER_PORT),
        '--host', '0.0.0.0',
        // Anti-decode-loop guards (2026-09-09). Josh trails off mid-phrase
        // ("do you want to...") and the decoder latches onto its own
        // completion and repeats it — measured up to 142x. Default
        // --max-context is -1 (UNLIMITED), which is what lets the decoder
        // feed on its own prior output and sustain the loop.
        //
        // 10 of 49 measured cases END INSIDE the loop with no recovery line,
        // so Josh's following words were LOST outright. Volume does NOT
        // predict harm: the 142x and 137x cases both recover harmlessly,
        // while a 5x case truncates. So these guards must suppress ALL
        // loops, not just long ones.
        '--max-context', '64',
        '--entropy-thold', '2.80',
      ], {
        stdio: ['ignore', whisperOutFd, whisperErrFd],
        // detached:true + unref() so whisper OUTLIVES a :3005 restart.
        // Was false: whisper was a child of the Node process, so every `pm2
        // restart homestead` (including the 6-hourly cron_restart) killed
        // :8178 and Josh's dictation went dead until someone noticed. The
        // guard above already no-ops when the port is held, so a surviving
        // whisper is simply adopted by the new server rather than duplicated.
        detached: true,
      });
      // Don't keep the parent's event loop alive on whisper's account.
      whisperProc.unref();

      whisperProc.on('error', (err) => {
        log(`[Whisper] Failed to start: ${err.message}`, 'ERROR');
      });
      whisperProc.on('exit', (code) => {
        log(`[Whisper] Exited with code ${code} (stdout→${WHISPER_LOG}, stderr→${WHISPER_ERR})`, 'WARN');
        try { fs.closeSync(whisperOutFd); } catch {}
        try { fs.closeSync(whisperErrFd); } catch {}
      });

      // Give it a moment, then verify
      setTimeout(() => {
        try {
          execSync(`lsof -ti:${WHISPER_PORT}`, { stdio: 'pipe' });
          log(`[Whisper] Server confirmed running on port ${WHISPER_PORT}`, 'STARTUP');
        } catch (e) {
          log(`[Whisper] Server failed to start on port ${WHISPER_PORT}`, 'ERROR');
        }
      }, 3000);
    })();

    // FCM session watcher — DISABLED. Presenter tool handles notifications now.
    // fcmSessionWatcher.start();

    // Belt-and-suspenders archive sweep. The primary drain now runs on every
    // dispatcher tick (see runDispatch), so terminal items normally leave the
    // live queue within ~a minute. This periodic call is a safety net in case
    // the tick path ever stalls.
    // ── GATE: writes the SHARED queue.json on a timer (prod checkout only).
    if (IS_PROD_CHECKOUT)
    setInterval(() => {
      queueDispatcher.cleanQueue().catch(swallow('safety-sweep.cleanQueue'));
    }, 6 * 60 * 60 * 1000);
  });
});
