/**
 * Calendar Upcoming-Event Watcher (Layer 1)
 *
 * Lightweight script — no Claude, no MCP. Reads Google Calendar for both of Josh's
 * accounts directly via the OAuth refresh tokens on disk, and walkies Alfred
 * (holler-alfred) when an event FIRST enters the ~150-minute-out window (2.5hr
 * before start). Alfred owns ALL downstream: travel time via Google Maps,
 * leave-time math, and the Josh card. This job's ONLY responsibility is to
 * reliably wake Alfred EXACTLY ONCE per event when it crosses into the window.
 *
 * Runs every 5 min via scheduler (recurring-jobs.json → rooster-calendar-upcoming-check).
 *
 * Calendar access: a cron script cannot use the google-calendar MCP tool, so we
 * refresh the on-disk OAuth tokens (~/.config/google-calendar-mcp/tokens.json)
 * against the shared OAuth client (~/.gmail-mcp/gcp-oauth.keys.json — same client
 * check-notifications.js uses for Gmail) and hit the Calendar v3 REST API.
 *   - tokens key "normal"  → <<REPLACE: your email>>  (reported to Alfred as "joshua")
 *   - tokens key "jory"    → <<REPLACE: your secondary email>> (reported to Alfred as "jory")
 *   ("personal" shares joshua's refresh token — a dupe of "normal", so we skip it.)
 *
 * Fire condition: event start is within LOOKAHEAD_MIN (150) minutes AND still in
 * the future. Fired ONCE per event via a dedupe state file keyed by the specific
 * event/instance id (recurring events use the per-instance id, so each occurrence
 * pings once).
 *
 * Edge cases:
 *   - All-day events (start.date, no start.dateTime) → SKIP (no leave-time meaning).
 *   - Events with no location → still ping (Alfred decides if leave-time applies).
 *
 * State file: data/calendar-upcoming-state.json
 *   { "fired_event_ids": ["<id>", ...], "last_run": "<ISO>" }
 * Model: same "persist fired ids, dedupe against the set" shape as the seen-key
 * sets in check-notifications.js.
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-write');
const http = require('http');
const https = require('https');

const STATE_FILE = path.join(process.cwd(), 'data', 'calendar-upcoming-state.json');
const QUEUE_FILE = path.join(require('os').homedir(), '.homestead', 'queue.json');
const TOKENS_FILE = path.join(require('os').homedir(), '.config', 'google-calendar-mcp', 'tokens.json');
const OAUTH_KEYS_FILE = path.join(require('os').homedir(), '.gmail-mcp', 'gcp-oauth.keys.json');

const LOOKAHEAD_MIN = 150;                 // fire when an event is this many minutes out
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// tokens.json key -> label Alfred expects in the payload. "personal" is a dupe of
// "normal" (same refresh_token = <<REPLACE: your email>>), so it is intentionally omitted.
const ACCOUNTS = [
  { tokenKey: 'normal', label: 'joshua' },
  { tokenKey: 'jory',   label: 'jory' },
];

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [CalUpcoming] ${msg}`);
}

// ─── State (dedupe) ──────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) {
    log(`Error loading state: ${err.message}`, 'WARN');
  }
  return { fired_event_ids: [], last_run: null };
}

function saveState(state) {
  state.last_run = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── HTTP helpers ────────────────────────────────────────────────────

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.request(url, { timeout: 15000, ...options }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

// ─── Google Calendar ─────────────────────────────────────────────────

function loadOAuthClient() {
  const keys = JSON.parse(fs.readFileSync(OAUTH_KEYS_FILE, 'utf-8'));
  const c = keys.installed || keys.web;
  if (!c || !c.client_id || !c.client_secret) throw new Error('OAuth client creds missing');
  return c;
}

async function getAccessToken(client, refreshToken) {
  const result = await postForm('https://oauth2.googleapis.com/token', {
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (result.data.access_token) return result.data.access_token;
  throw new Error(`token refresh failed: ${JSON.stringify(result.data).slice(0, 200)}`);
}

/**
 * List upcoming (non-recurring-expanded) events for one account in the window
 * [now, now + LOOKAHEAD_MIN]. singleEvents=true expands recurring series into
 * per-instance events, so each occurrence carries its own instance id (which is
 * what we dedupe on).
 */
async function listUpcoming(token, nowMs) {
  const timeMin = new Date(nowMs).toISOString();
  const timeMax = new Date(nowMs + LOOKAHEAD_MIN * 60 * 1000).toISOString();
  const url =
    `${CALENDAR_API}/calendars/primary/events` +
    `?timeMin=${encodeURIComponent(timeMin)}` +
    `&timeMax=${encodeURIComponent(timeMax)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=50`;
  const res = await request(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200) {
    throw new Error(`list events HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  return res.data.items || [];
}

// ─── Walkie-talkie to Alfred (queue write) ───────────────────────────
// Same mechanism check-notifications.js uses: append to ~/.homestead/queue.json
// with target_session=holler-alfred; the dispatcher delivers when Alfred is ready.

function sendToAlfred(payload) {
  const queue = fs.existsSync(QUEUE_FILE)
    ? JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'))
    : [];
  const id = `${Date.now()}-calup-${payload.event_id}`;
  queue.push({
    id,
    target_session: 'holler-alfred',
    type: 'action',
    message: JSON.stringify(payload),
    status: 'pending',
    created_at: new Date().toISOString(),
    attempts: 0,
  });
  writeFileAtomicSync(QUEUE_FILE, JSON.stringify(queue, null, 2)); // atomic (torn-read fix 2026-08-25)
  log(`Pinged Alfred for "${payload.summary}" (${payload.calendar}, queue id: ${id})`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const state = loadState();
  const fired = new Set(state.fired_event_ids || []);
  const nowMs = Date.now();

  let client;
  try {
    client = loadOAuthClient();
  } catch (err) {
    log(`Cannot load OAuth client: ${err.message}`, 'ERROR');
    console.log(JSON.stringify({ triggered: false, reason: 'oauth_client_missing', error: err.message }));
    return;
  }

  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
  } catch (err) {
    log(`Cannot read tokens: ${err.message}`, 'ERROR');
    console.log(JSON.stringify({ triggered: false, reason: 'tokens_missing', error: err.message }));
    return;
  }

  const pinged = [];
  let scanned = 0;

  for (const acct of ACCOUNTS) {
    const tk = tokens[acct.tokenKey];
    if (!tk || !tk.refresh_token) {
      log(`No refresh_token for account "${acct.tokenKey}", skipping`, 'WARN');
      continue;
    }

    let token;
    try {
      token = await getAccessToken(client, tk.refresh_token);
    } catch (err) {
      log(`Auth failed for "${acct.label}": ${err.message}`, 'ERROR');
      continue;
    }

    let events;
    try {
      events = await listUpcoming(token, nowMs);
    } catch (err) {
      log(`List failed for "${acct.label}": ${err.message}`, 'ERROR');
      continue;
    }

    for (const e of events) {
      scanned++;

      // All-day events have start.date (no start.dateTime) → SKIP, no leave-time meaning.
      if (!e.start || !e.start.dateTime) continue;

      const startMs = new Date(e.start.dateTime).getTime();
      if (!Number.isFinite(startMs)) continue;

      // Only events still in the future (timeMin already bounds this, but a start
      // exactly at/behind now would carry no leave-time value).
      if (startMs <= nowMs) continue;

      const minutesOut = (startMs - nowMs) / 60000;
      if (minutesOut > LOOKAHEAD_MIN) continue; // not yet in the window

      // Dedupe: fire ONCE per event/instance id. singleEvents=true gives each
      // recurring occurrence its own id, so occurrences ping independently.
      if (fired.has(e.id)) continue;

      const payload = {
        trigger: 'calendar_event_upcoming',
        event_id: e.id,
        calendar: acct.label,
        summary: e.summary || '(no title)',
        start: e.start.dateTime,
        end: (e.end && (e.end.dateTime || e.end.date)) || null,
        location: e.location || null,
        attendees: Array.isArray(e.attendees) ? e.attendees.length : 0,
        lookahead_min: LOOKAHEAD_MIN,
      };

      try {
        sendToAlfred(payload);
        fired.add(e.id);
        pinged.push({ event_id: e.id, calendar: acct.label, summary: payload.summary, minutes_out: Math.round(minutesOut) });
      } catch (err) {
        log(`Failed to ping Alfred for ${e.id}: ${err.message}`, 'ERROR');
      }
    }
  }

  // Persist fired ids. Prune ids for events that can no longer be in any future
  // window (older than LOOKAHEAD_MIN in the past) so the set doesn't grow forever
  // while never re-firing anything still live. We keep only recently-fired ids by
  // capping the set — but since ids are opaque we simply keep the full set bounded
  // by dropping the oldest when it grows large. Fired events are already past-window
  // once started, so unbounded growth is the only risk; a generous cap handles it.
  let firedList = Array.from(fired);
  const MAX_FIRED = 500;
  if (firedList.length > MAX_FIRED) firedList = firedList.slice(firedList.length - MAX_FIRED);
  state.fired_event_ids = firedList;
  saveState(state);

  if (pinged.length === 0) {
    log(`No new events entered the ${LOOKAHEAD_MIN}min window (scanned ${scanned})`);
    console.log(JSON.stringify({ triggered: false, reason: 'nothing_new', scanned }));
    return;
  }

  log(`Done: pinged Alfred for ${pinged.length} event(s)`);
  console.log(JSON.stringify({ triggered: true, count: pinged.length, pinged, scanned }));
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`, 'ERROR');
  process.exit(1);
});
