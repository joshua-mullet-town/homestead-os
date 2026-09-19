const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pm2 = require('./pm2');
const devServers = require('./devServers');
const firebase = require('./firebase');
const phone = require('./phone');

const PM2_LOGS_DIR = path.join(os.homedir(), '.pm2', 'logs');

const router = express.Router();

const HOMESTEAD_SERVICE = 'homestead';

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function fail(res, err, fallbackStatus = 500) {
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'Unknown error';
  const status =
    code === 'INVALID_SERVICE_NAME' ||
    code === 'INVALID_PROJECT_NAME' ||
    code === 'UNKNOWN_PROJECT'
      ? 400
      : code === 'SERVICE_NOT_FOUND' || code === 'PROJECT_DIR_MISSING' || code === 'FIREBASE_CLI_MISSING'
      ? 404
      : code === 'SERVICE_RESTART_TIMEOUT'
      ? 504
      : fallbackStatus;
  return res.status(status).json({ ok: false, error: { code, message, ...(err.last ? { detail: err.last } : {}) } });
}

const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => fail(res, err));

// POST /api/restart — restart homestead (the default user-visible action)
router.post(
  '/restart',
  asyncRoute(async (_req, res) => {
    const before = await pm2.restart(HOMESTEAD_SERVICE);
    const proc = await pm2.waitForOnline(HOMESTEAD_SERVICE);
    ok(res, {
      service: HOMESTEAD_SERVICE,
      previous_pid: before.previous_pid,
      previous_restart_count: before.previous_restart_count,
      current_pid: proc.pid,
      current_restart_count: proc.pm2_env?.restart_time ?? null,
      status: proc.pm2_env?.status,
    });
  })
);

// POST /api/restart/:service — restart any PM2 service by name
router.post(
  '/restart/:service',
  asyncRoute(async (req, res) => {
    const name = req.params.service;
    const before = await pm2.restart(name);
    const proc = await pm2.waitForOnline(name);
    ok(res, {
      service: name,
      previous_pid: before.previous_pid,
      previous_restart_count: before.previous_restart_count,
      current_pid: proc.pid,
      current_restart_count: proc.pm2_env?.restart_time ?? null,
      status: proc.pm2_env?.status,
    });
  })
);

// POST /api/nuclear-restart — restart every PM2 service
router.post(
  '/nuclear-restart',
  asyncRoute(async (_req, res) => {
    const before = await pm2.restartAll();
    const after = await pm2.jlist();
    const services = before.map((b) => {
      const now = after.find((p) => p.name === b.name);
      return {
        name: b.name,
        previous_pid: b.previous_pid,
        previous_restart_count: b.previous_restart_count,
        current_pid: now?.pid ?? null,
        current_restart_count: now?.pm2_env?.restart_time ?? null,
        status: now?.pm2_env?.status ?? 'unknown',
      };
    });
    // Give PM2 a moment, then re-check anything not yet online
    const stragglers = services.filter((s) => s.status !== 'online');
    for (const s of stragglers) {
      try {
        const proc = await pm2.waitForOnline(s.name, { timeoutMs: 8000 });
        s.current_pid = proc.pid;
        s.current_restart_count = proc.pm2_env?.restart_time ?? null;
        s.status = proc.pm2_env?.status;
      } catch (err) {
        s.status = 'restart_timeout';
      }
    }
    ok(res, { services });
  })
);

// POST /api/firebase-login — kick off firebase login in a tmux session
router.post(
  '/firebase-login',
  asyncRoute(async (_req, res) => {
    const info = await firebase.launchLogin();
    ok(res, {
      session: info.session,
      log_path: info.log_path,
      firebase_cli: info.firebase_cli,
      message: 'firebase login launched in tmux — complete browser auth, then session self-exits',
    });
  })
);

// GET /api/dev-servers — list known dev servers + running state
router.get(
  '/dev-servers',
  asyncRoute(async (_req, res) => {
    const servers = await devServers.list();
    ok(res, { servers });
  })
);

// POST /api/dev-server/:project/start — start a known dev server
router.post(
  '/dev-server/:project/start',
  asyncRoute(async (req, res) => {
    const result = await devServers.start(req.params.project);
    ok(res, result);
  })
);

// POST /api/dev-server/:project/stop — stop a known dev server
router.post(
  '/dev-server/:project/stop',
  asyncRoute(async (req, res) => {
    const result = await devServers.stop(req.params.project);
    ok(res, result);
  })
);

// GET /api/phone/test — ping the phone API health endpoint
router.get(
  '/phone/test',
  asyncRoute(async (_req, res) => {
    const result = await phone.fetchHealth();
    ok(res, result);
  })
);

// GET /api/alley/logs?stream=out|error&lines=N&since=<bytes>
//   Tails phone-alley PM2 logs. Returns last `lines` lines (default 200, max 2000)
//   from chosen stream (default out). If `since` is set, returns content appended
//   to the file past that byte offset (for true tail-style polling), capped at 256KB.
router.get(
  '/alley/logs',
  asyncRoute(async (req, res) => {
    const stream = req.query.stream === 'error' ? 'error' : 'out';
    const linesReq = Math.min(2000, Math.max(1, parseInt(req.query.lines, 10) || 200));
    const since = req.query.since != null ? parseInt(req.query.since, 10) : null;
    const file = path.join(PM2_LOGS_DIR, `phone-alley-${stream}.log`);

    if (!fs.existsSync(file)) {
      return ok(res, { stream, file, size: 0, lines: [], content: '' });
    }

    const stat = fs.statSync(file);
    const size = stat.size;

    if (since != null && since >= 0 && since <= size) {
      const MAX = 256 * 1024;
      const start = Math.max(since, size - MAX);
      const fd = fs.openSync(file, 'r');
      try {
        const len = size - start;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        return ok(res, {
          stream,
          file,
          size,
          since,
          truncated: start > since,
          content: buf.toString('utf-8'),
        });
      } finally {
        fs.closeSync(fd);
      }
    }

    // Fallback: read last N lines via tail-from-end
    const MAX_TAIL = 512 * 1024;
    const start = Math.max(0, size - MAX_TAIL);
    const fd = fs.openSync(file, 'r');
    let buf;
    try {
      const len = size - start;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    const all = buf.toString('utf-8').split('\n');
    const lines = all.slice(-linesReq);
    ok(res, { stream, file, size, lines });
  })
);

// GET /api/alley/logs/view — minimal mobile-friendly HTML tail viewer
//   Auto-polls /api/alley/logs every 2s. Toggle stream out/error. No JS framework.
router.get('/alley/logs/view', (_req, res) => {
  res.set('content-type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>phone-alley logs</title>
<style>
  body{margin:0;background:#1d2021;color:#ebdbb2;font-family:inherit;font-size:16px}
  header{position:sticky;top:0;background:#3c3836;padding:8px 12px;display:flex;gap:12px;align-items:center;border-bottom:1px solid #504945;z-index:1}
  header button{background:#504945;color:#ebdbb2;border:1px solid #665c54;padding:4px 10px;font:inherit;cursor:pointer}
  header button.active{background:#fe8019;color:#1d2021}
  header .meta{margin-left:auto;font-size:12px;color:#928374}
  pre{margin:0;padding:8px 12px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.35}
  .err{color:#fb4934}
</style></head>
<body>
<header>
  <button id="b-out" class="active">stdout</button>
  <button id="b-error">stderr</button>
  <span class="meta" id="meta">—</span>
</header>
<pre id="log">loading…</pre>
<script>
let stream='out', cursor=null;
const el=document.getElementById('log'), meta=document.getElementById('meta');
const bOut=document.getElementById('b-out'), bErr=document.getElementById('b-error');
function setStream(s){stream=s;cursor=null;el.textContent='loading…';bOut.classList.toggle('active',s==='out');bErr.classList.toggle('active',s==='error');tick();}
bOut.onclick=()=>setStream('out');bErr.onclick=()=>setStream('error');
async function tick(){
  try{
    const u=cursor==null?'/api/alley/logs?stream='+stream+'&lines=500':'/api/alley/logs?stream='+stream+'&since='+cursor;
    const r=await fetch(u,{cache:'no-store'});const j=await r.json();
    if(!j.ok){meta.textContent='err';return;}
    const d=j.data;meta.textContent=stream+' · '+d.size+'B';
    if(cursor==null){el.textContent=(d.lines||[]).join('\\n');}
    else if(d.content){el.textContent+=d.content;}
    cursor=d.size;
    el.scrollIntoView({block:'end'});window.scrollTo(0,document.body.scrollHeight);
  }catch(e){meta.textContent='net err';}
}
setStream('out');setInterval(tick,2000);
</script>
</body></html>`);
});

module.exports = router;
