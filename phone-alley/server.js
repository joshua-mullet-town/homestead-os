const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { URL } = require('url');
const { createProxyMiddleware } = require('http-proxy-middleware');

const SERVICE = 'phone-alley';
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 3009);

const HOMESTEAD_TARGET = process.env.HOMESTEAD_TARGET || 'http://127.0.0.1:3005';
const WATCHDOG_TARGET = process.env.WATCHDOG_TARGET || 'http://127.0.0.1:3007';
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 10000);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 4000);
// Long-running paths (whisper transcription is synchronous and can take 60-120s
// for multi-minute recordings). Must exceed homestead's own LOCAL_WHISPER timeout (300s).
const LONG_PROXY_TIMEOUT_MS = Number(process.env.LONG_PROXY_TIMEOUT_MS || 360000);

const SENTINEL_DIR = path.join(os.homedir(), '.homestead', 'alley');
const SENTINEL_PATH = path.join(SENTINEL_DIR, 'health.sentinel');

fs.mkdirSync(SENTINEL_DIR, { recursive: true });

const startedAt = Date.now();

function writeSentinel() {
  const payload = {
    service: SERVICE,
    version: VERSION,
    pid: process.pid,
    port: PORT,
    started_at: startedAt,
    written_at: Date.now(),
    uptime_sec: Math.round((Date.now() - startedAt) / 1000),
  };
  const tmp = SENTINEL_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, SENTINEL_PATH);
  return payload;
}

// === SETUP ===
const app = express();

// === ENDPOINT HANDLERS (alley-routes-core owns this block) ===
//
// Critical: only the path-prefixes listed below get express.json() + the local
// router. Everything else under /api/* must reach the request body intact so
// the homestead catch-all proxy below can forward it (e.g. APK posts to
// /api/guests/send-shared-message). Applying express.json() globally would
// consume the stream before the proxy sees it, producing "empty reply" on POST.
const LOCAL_API_PREFIXES = [
  '/restart',
  '/nuclear-restart',
  '/firebase-login',
  '/dev-servers',
  '/dev-server',
  '/phone/test',
  '/alley',
];

const apiRouter = require('./lib/routes-api');
const apiJson = express.json();
app.use('/api', (req, res, next) => {
  const owned = LOCAL_API_PREFIXES.some(
    (p) => req.path === p || req.path.startsWith(p + '/')
  );
  if (!owned) return next(); // skip JSON + router; fall through to proxy below
  apiJson(req, res, (err) => {
    if (err) return next(err);
    apiRouter(req, res, next);
  });
});

// === RETRY-ON-502 MIDDLEWARE (silent-retry-during-homestead-restart) ===
//
// Homestead gets restarted ~60×/day when fleet Workers ship code. Each restart
// is a 3-5s blackout. A phone tap during that window normally surfaces the
// literal "failed gateway" toast (the proxy 502 message bubbles up to the UI).
// This middleware silently retries those POSTs once after RETRY_DELAY_MS — long
// enough for the new homestead process to be listening — so Joshua doesn't see
// the toast for routine restart-window misses.
//
// Scope is intentionally narrow: only small-bodied write endpoints the phone
// surfaces toasts for. Multipart uploads (transcribe-and-send) are NOT in the
// list because buffering multi-MB audio just to maybe-retry is wasteful and the
// long-proxy timeout (360s) gives whisper itself plenty of headroom.
const RETRYABLE_PATHS = [
  '/api/queue',
  '/api/presenter/respond',
  '/api/presenter/dismiss',
  '/api/guests/send-shared-message',
];
const RETRYABLE_METHODS = new Set(['POST', 'PATCH', 'PUT']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Dedicated non-keep-alive agent so every forwardOnce socket is torn down after
// its single request instead of being parked for reuse. Combined with the
// explicit upstream.destroy() on each terminal path below, this stops the
// connect-to-:3005 fds from lingering in CLOSED state and accumulating (the
// phone-alley-closed-socket-leak). Self-proxying to homestead means every leaked
// fd is one this same pid holds open, so the leak is entirely ours to reclaim.
const forwardAgent = new http.Agent({ keepAlive: false });

function forwardOnce(method, urlString, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(urlString);
    // Resolve at most once, and always release the socket fd on the way out.
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      // destroy() closes the underlying socket fd regardless of which terminal
      // path we took (end, error, or timeout). Safe to call even after a clean
      // response — it's a no-op once the request has already ended.
      upstream.destroy();
      resolve(result);
    };

    const upstream = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      headers,
      timeout: PROXY_TIMEOUT_MS,
      agent: forwardAgent,
    }, (upstreamRes) => {
      const respChunks = [];
      upstreamRes.on('data', (c) => respChunks.push(c));
      upstreamRes.on('end', () => finish({
        statusCode: upstreamRes.statusCode,
        headers: upstreamRes.headers,
        body: Buffer.concat(respChunks),
      }));
      upstreamRes.on('error', (err) => finish({ error: err.message }));
    });
    upstream.on('error', (err) => finish({ error: err.message }));
    upstream.on('timeout', () => finish({ error: 'Upstream timeout' }));
    if (body && body.length) upstream.write(body);
    upstream.end();
  });
}

app.use(async (req, res, next) => {
  if (!RETRYABLE_METHODS.has(req.method)) return next();
  if (!RETRYABLE_PATHS.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return next();
  }

  const headers = { ...req.headers };
  delete headers.host;
  if (body.length) headers['content-length'] = String(body.length);

  const targetUrl = `${HOMESTEAD_TARGET}${req.originalUrl}`;
  let result = await forwardOnce(req.method, targetUrl, headers, body);

  const shouldRetry = result.error || result.statusCode === 502 || result.statusCode === 503;
  if (shouldRetry) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    result = await forwardOnce(req.method, targetUrl, headers, body);
  }

  if (result.error) {
    if (!res.headersSent) {
      res.writeHead(502, {
        'content-type': 'application/json',
        'x-alley-routed-to': 'homestead-retry',
        'x-alley-retry-outcome': 'failed-after-retry',
      });
      res.end(JSON.stringify({ error: 'bad_gateway', target: HOMESTEAD_TARGET, detail: result.error }));
    }
    return;
  }

  const responseHeaders = { ...result.headers };
  responseHeaders['x-alley-routed-to'] = 'homestead-retry';
  responseHeaders['x-alley-retry-outcome'] = shouldRetry ? 'recovered-on-retry' : 'first-try-ok';
  res.writeHead(result.statusCode, responseHeaders);
  res.end(result.body);
});

// === PROXY MIDDLEWARE (alley-tailscale-funnel-rewrite owns this block) ===
//
// Routing rules — public Tailscale Funnel → :3009 fans out internally:
//   /api/*             → handled locally by routes-core router (above)
//   /watchdog/*        → http://127.0.0.1:3007  (legacy watchdog, retired by old-watchdog-retirement leaf)
//   /_alley            → handled locally (identity probe — renamed from old `/`)
//   /health            → handled locally (PM2 healthcheck)
//   everything else    → http://127.0.0.1:3005  (homestead UI: /, /_next/*, etc.)
//
// `X-Alley-Routed-To` response header stamps every proxied response so audit
// tests can prove the request actually traversed alley (not a leftover direct route).

const watchdogProxy = createProxyMiddleware({
  target: WATCHDOG_TARGET,
  changeOrigin: true,
  pathRewrite: { '^/watchdog': '' },
  ws: true,
  xfwd: true,
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
  on: {
    proxyRes: (proxyRes) => {
      proxyRes.headers['x-alley-routed-to'] = 'watchdog-legacy';
    },
    error: (err, _req, res) => {
      if (res && !res.headersSent && typeof res.writeHead === 'function') {
        res.writeHead(502, { 'content-type': 'application/json', 'x-alley-routed-to': 'watchdog-legacy' });
        res.end(JSON.stringify({ error: 'bad_gateway', target: WATCHDOG_TARGET, detail: err.message }));
      }
    },
  },
});

app.use('/watchdog', watchdogProxy);

// === HEALTH / IDENTITY ===
app.get('/health', (_req, res) => {
  const payload = writeSentinel();
  res.set('x-alley-routed-to', 'local');
  res.json({ ok: true, ...payload, sentinel: SENTINEL_PATH });
});

app.get('/_alley', (_req, res) => {
  res.set('x-alley-routed-to', 'local');
  res.json({ service: SERVICE, version: VERSION, port: PORT, targets: { homestead: HOMESTEAD_TARGET, watchdog: WATCHDOG_TARGET } });
});

// === HOMESTEAD UI CATCH-ALL (must be last) ===
const homesteadProxy = createProxyMiddleware({
  target: HOMESTEAD_TARGET,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
  on: {
    proxyRes: (proxyRes) => {
      proxyRes.headers['x-alley-routed-to'] = 'homestead';
    },
    error: (err, _req, res) => {
      if (res && !res.headersSent && typeof res.writeHead === 'function') {
        res.writeHead(502, { 'content-type': 'application/json', 'x-alley-routed-to': 'homestead' });
        res.end(JSON.stringify({ error: 'bad_gateway', target: HOMESTEAD_TARGET, detail: err.message }));
      }
    },
  },
});

// Long-running variant — same target, same response stamping, but minutes-long
// timeout so synchronous transcription endpoints don't 502 mid-whisper.
const homesteadLongProxy = createProxyMiddleware({
  target: HOMESTEAD_TARGET,
  changeOrigin: true,
  ws: false,
  xfwd: true,
  proxyTimeout: LONG_PROXY_TIMEOUT_MS,
  timeout: LONG_PROXY_TIMEOUT_MS,
  on: {
    proxyRes: (proxyRes) => {
      proxyRes.headers['x-alley-routed-to'] = 'homestead-long';
    },
    error: (err, _req, res) => {
      if (res && !res.headersSent && typeof res.writeHead === 'function') {
        res.writeHead(502, { 'content-type': 'application/json', 'x-alley-routed-to': 'homestead-long' });
        res.end(JSON.stringify({ error: 'bad_gateway', target: HOMESTEAD_TARGET, detail: err.message }));
      }
    },
  },
});

// Route whisper-bound paths to the long-timeout proxy BEFORE the catch-all.
// Mounting via app.use(path, proxy) would strip the mount path; instead we
// intercept at '/' and dispatch by URL so the original path reaches homestead
// intact. /api/transcribe-and-send is the APK upload path; /api/transcribe is
// the desktop VoiceRecorder transcribe-only path.
const LONG_PROXY_PATHS = ['/api/transcribe-and-send', '/api/transcribe'];
app.use((req, res, next) => {
  if (LONG_PROXY_PATHS.some((p) => req.url === p || req.url.startsWith(p + '?') || req.url.startsWith(p + '/'))) {
    return homesteadLongProxy(req, res, next);
  }
  next();
});

app.use('/', homesteadProxy);

const server = app.listen(PORT, () => {
  writeSentinel();
  console.log(`[${SERVICE}] listening on :${PORT} — proxying / → ${HOMESTEAD_TARGET}, /watchdog → ${WATCHDOG_TARGET}`);
});

// Upgrade events for WebSocket support through both proxies (Next.js HMR, watchdog sockets if any)
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/watchdog')) {
    watchdogProxy.upgrade(req, socket, head);
  } else {
    homesteadProxy.upgrade(req, socket, head);
  }
});
