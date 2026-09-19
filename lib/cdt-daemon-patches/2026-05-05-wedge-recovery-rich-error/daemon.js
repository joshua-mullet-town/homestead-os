// CDT Daemon — persistent chrome-devtools-mcp multiplexer.
//
// Fans N Claude Code MCP clients in over Streamable HTTP at :9223/mcp,
// out to ONE stdio child running `chrome-devtools-mcp --browserUrl 127.0.0.1:9222`.
//
// tools/call is serialized through a FIFO mutex with a 60s per-hold timeout.
// tools/list, prompts/list, resources/list, and friends pass through in parallel.

import { randomUUID } from 'node:crypto';
import express from 'express';

import { Server as McpServerLL } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  isInitializeRequest,
  // Request schemas
  PingRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  // Result schemas
  EmptyResultSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  ListPromptsResultSchema,
  GetPromptResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  CompleteResultSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { FifoMutex } from './lib/mutex.js';

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const PORT = Number(process.env.CDT_DAEMON_PORT || 9223);
const BIND_HOST = process.env.CDT_DAEMON_HOST || '127.0.0.1';
const BROWSER_URL = process.env.CDT_BROWSER_URL || 'http://127.0.0.1:9222';
const TOOL_CALL_TIMEOUT_MS = Number(process.env.CDT_TOOL_CALL_TIMEOUT_MS || 60_000);
// Max time a waiter sits in the queue before we return a "held by X, check on them" message
// instead of running their tool call. They can retry; meanwhile the holder keeps working.
const WAITER_TIMEOUT_MS = Number(process.env.CDT_WAITER_TIMEOUT_MS || 30_000);
const BACKEND_CMD = process.env.CDT_BACKEND_CMD || 'npx';
const BACKEND_ARGS = (process.env.CDT_BACKEND_ARGS
  ? process.env.CDT_BACKEND_ARGS.split(' ')
  : ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', BROWSER_URL]);

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}
function warn(...args) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] WARN`, ...args);
}
function err(...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ERROR`, ...args);
}

// ------------------------------------------------------------------
// Shared backend MCP client (stdio -> chrome-devtools-mcp)
// ------------------------------------------------------------------
let backendClient = null;
let backendServerInfo = null;   // { name, version }
let backendCapabilities = null; // ServerCapabilities

// FIFO mutex — only tools/call goes through this.
const mutex = new FifoMutex({
  timeoutMs: TOOL_CALL_TIMEOUT_MS,
  onTimeout: ({ session, tool, heldMs, targetId, targetUrl }) => {
    // Append-only enhancement: include targetId/targetUrl when the daemon
    // resolved them at acquire-time via getActiveWedgeTarget(). Older log
    // parsers see the same prefix; new parsers (cdt-tab-watcher) capture the
    // optional trailing fields and skip the snapshot-diff fallback.
    const targetSuffix = targetId
      ? ` targetId=${targetId} targetUrl=${targetUrl}`
      : '';
    warn(`tools/call hard-timeout: session=${session} tool=${tool} heldMs=${heldMs}${targetSuffix} — force-released`);
  },
});

// ------------------------------------------------------------------
// Wedge-target hint resolver
// ------------------------------------------------------------------
// For tools that operate on the backend's #selectedPage (click, fill, etc.),
// we can't know the target ID from the request params alone — it's implicit
// in the chrome-devtools-mcp child's in-memory state. Instead we query Chrome
// directly via /json/list at acquire time and identify the FIRST page-target
// matching wedge-prone URL patterns. This is a heuristic anchored at T+0 of
// the wedge (not T+60s when other tabs may have changed). Fail-closed when
// multiple wedge-prone tabs are open — the cdt-tab-watcher's snapshot-diff
// layer + its own hard rule (empty candidate → no eviction) handle the
// ambiguous case without ever wrong-evicting.
const INTERESTING_TOOLS = new Set([
  'click', 'fill', 'fill_form', 'type_text', 'take_snapshot',
  'navigate_page', 'drag', 'hover', 'press_key',
]);
const WEDGE_PRONE_URL_SUBSTRINGS = ['/admin/', '/checkout/', '/edit'];
const WEDGE_TARGET_CACHE_TTL_MS = 500;

let wedgeTargetCache = { resolvedAt: 0, result: null };

async function getActiveWedgeTarget() {
  const now = Date.now();
  if (now - wedgeTargetCache.resolvedAt < WEDGE_TARGET_CACHE_TTL_MS) {
    return wedgeTargetCache.result;
  }
  let result = { targetId: null, targetUrl: null, ambiguous: false, candidates: [] };
  try {
    const ac = new AbortController();
    // 200ms fail-fast: /json/list is normally <50ms. Above that we'd rather
    // miss the hint and fall through to the watcher's snapshot-diff layer
    // (which has its own hard rule against wrong-evict) than impose a
    // latency tax on every first-of-batch INTERESTING_TOOLS call when Chrome
    // is slow under memory/event pressure.
    const timer = setTimeout(() => ac.abort(), 200);
    const res = await fetch(`${BROWSER_URL}/json/list`, { signal: ac.signal });
    clearTimeout(timer);
    if (res.ok) {
      const arr = await res.json();
      const candidates = arr.filter(t =>
        t.type === 'page' &&
        WEDGE_PRONE_URL_SUBSTRINGS.some(s => t.url.includes(s))
      );
      if (candidates.length === 1) {
        result.targetId = candidates[0].id;
        result.targetUrl = candidates[0].url;
      } else if (candidates.length > 1) {
        result.ambiguous = true;
        result.candidates = candidates.map(t => ({ id: t.id, url: t.url }));
      }
      // candidates.length === 0 → leaves null result (nothing to hint).
    }
  } catch (_e) { /* swallow — null result is fine */ }
  wedgeTargetCache = { resolvedAt: now, result };
  return result;
}

// Build the "who's holding it" CallToolResult returned to a waiter that timed out.
// isError:true so Claude treats it as a tool failure but still gets the message text.
//
// We DO NOT tell the waiter to walkie-talkie the holder — walkies only deliver
// when a session is idle, so if the holder is truly working or stuck, the message
// won't land until too late. Instead, we teach the waiter to peek at the holder's
// tmux pane directly, which always works regardless of holder state.
function buildHoldMessage({ waitedMs, holder, waiterTool }) {
  const holderSession = holder?.session || 'unknown-session';
  const holderTool = holder?.tool || 'unknown-tool';
  const heldSec = Math.round((holder?.heldMs ?? 0) / 1000);
  const waitedSec = Math.round(waitedMs / 1000);
  const text = [
    `Chrome DevTools is currently held by another session.`,
    ``,
    `  - Holder session:  ${holderSession}`,
    `  - Holder's tool:   ${holderTool}`,
    `  - Held for:        ${heldSec}s`,
    `  - You waited:      ${waitedSec}s`,
    `  - Your request:    ${waiterTool}`,
    ``,
    `Before retrying, you should diagnose whether they're actually working or stuck.`,
    `The right way to check is to peek at their tmux pane directly — this works`,
    `whether they're mid-turn, stuck at a prompt, or errored out. Do NOT walkie-talkie`,
    `them: walkies only deliver when a session is idle, so an active/stuck Claude`,
    `won't see the message until it's too late.`,
    ``,
    `Run this from your Bash tool:`,
    ``,
    `  tmux capture-pane -t ${holderSession} -p -S -50`,
    ``,
    `Interpret what you see:`,
    `  - Active Claude UI with spinner / tool output scrolling → they're working; wait and retry.`,
    `  - Frozen mid-turn with no new output for a while → likely stuck; consider Rooster-escalating.`,
    `  - A "Do you want to proceed?" permission prompt → they're blocked waiting on a human; Rooster can approve.`,
    `  - An error stack or API failure → they're broken; escalate to Rooster (holler-rooster) via walkie-talkie.`,
    `  - A shell prompt ($ or %) → Claude crashed; escalate to Rooster immediately.`,
    ``,
    `Then: if they're fine, just retry your tool call — the queue is FIFO so you'll`,
    `go through once they release the lock.`,
  ].join('\n');
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

async function startBackend() {
  log(`Spawning backend: ${BACKEND_CMD} ${BACKEND_ARGS.join(' ')}`);
  const transport = new StdioClientTransport({
    command: BACKEND_CMD,
    args: BACKEND_ARGS,
    env: { ...process.env },
    // 'ignore' silences chrome-devtools-mcp's noisy "No handler registered for
    // issue code PerformanceIssue" stderr spam. Set to 'inherit' for debugging.
    stderr: process.env.CDT_BACKEND_STDERR || 'ignore',
  });

  const client = new McpClient(
    { name: 'cdt-daemon-client', version: '1.0.0' },
    {
      capabilities: {
        // We're just a passthrough; advertise nothing special.
      },
    }
  );

  await client.connect(transport);
  backendClient = client;
  backendServerInfo = client.getServerVersion() || { name: 'chrome-devtools-mcp', version: 'unknown' };
  backendCapabilities = client.getServerCapabilities() || {};
  log('Backend connected.');
  log(`Backend server: ${JSON.stringify(backendServerInfo)}`);
  log(`Backend capabilities: ${JSON.stringify(backendCapabilities)}`);
}

async function stopBackend() {
  if (backendClient) {
    try {
      await backendClient.close();
    } catch (e) {
      warn(`Error closing backend client: ${e?.message || e}`);
    }
    backendClient = null;
  }
}

// ------------------------------------------------------------------
// Per-Claude-client server factory
// ------------------------------------------------------------------
// Each Claude session gets its own McpServer instance (keeps session state
// clean). All of them share the single backendClient + mutex.
function createProxyServer(sessionId) {
  const caps = backendCapabilities || {};
  const server = new McpServerLL(
    { name: 'cdt-daemon', version: '1.0.0' },
    {
      // Mirror the backend's capabilities so clients see the same surface.
      capabilities: caps,
      instructions: `Shared chrome-devtools-mcp proxy (session ${sessionId || 'n/a'}).`,
    }
  );

  // Helper to forward a request to the backend with the correct result schema.
  async function forward(method, params, resultSchema) {
    if (!backendClient) throw new Error('Backend MCP client not connected');
    return await backendClient.request({ method, params: params ?? {} }, resultSchema);
  }

  // --- Ping is always allowed ---
  server.setRequestHandler(PingRequestSchema, async () => forward('ping', {}, EmptyResultSchema));

  // --- Tools ---
  if (caps.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (req) =>
      forward('tools/list', req.params, ListToolsResultSchema)
    );
    // Serialized through the mutex.
    server.setRequestHandler(CallToolRequestSchema, async (req) => wrappedToolCall(req, sessionId));
  }

  // --- Prompts ---
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (req) =>
      forward('prompts/list', req.params, ListPromptsResultSchema)
    );
    server.setRequestHandler(GetPromptRequestSchema, async (req) =>
      forward('prompts/get', req.params, GetPromptResultSchema)
    );
  }

  // --- Resources ---
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
      forward('resources/list', req.params, ListResourcesResultSchema)
    );
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
      forward('resources/templates/list', req.params, ListResourceTemplatesResultSchema)
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
      forward('resources/read', req.params, ReadResourceResultSchema)
    );
    if (caps.resources.subscribe) {
      server.setRequestHandler(SubscribeRequestSchema, async (req) =>
        forward('resources/subscribe', req.params, EmptyResultSchema)
      );
      server.setRequestHandler(UnsubscribeRequestSchema, async (req) =>
        forward('resources/unsubscribe', req.params, EmptyResultSchema)
      );
    }
  }

  // --- Completion ---
  if (caps.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (req) =>
      forward('completion/complete', req.params, CompleteResultSchema)
    );
  }

  // --- Logging ---
  if (caps.logging) {
    server.setRequestHandler(SetLevelRequestSchema, async (req) =>
      forward('logging/setLevel', req.params, EmptyResultSchema)
    );
  }

  return server;
}

// Mutex-wrapped tools/call handler (shared across all per-session servers).
// Waiters get a conversational "it's held by X, reach out to them" message if
// they wait longer than WAITER_TIMEOUT_MS instead of sitting silently forever.
async function wrappedToolCall(req, sessionId) {
  if (!backendClient) throw new Error('Backend MCP client not connected');
  const tool = req.params?.name || 'unknown';
  const session = sessionId || 'anon';

  // Resolve a wedge-target hint for tools that operate on the backend's
  // implicit #selectedPage. See getActiveWedgeTarget for rationale + fail-
  // closed semantics. Best-effort — never blocks tools/call on failure.
  let targetId = null;
  let targetUrl = null;
  if (INTERESTING_TOOLS.has(tool)) {
    const hint = await getActiveWedgeTarget();
    if (hint?.ambiguous) {
      log(`ambiguous_acquire_target session=${session} tool=${tool} candidates=${hint.candidates.length} urls=${JSON.stringify(hint.candidates.map(c => c.url))}`);
    } else if (hint?.targetId) {
      targetId = hint.targetId;
      targetUrl = hint.targetUrl;
    }
  }

  if (mutex.queueLength > 0 || mutex.locked) {
    log(`tools/call queued: session=${session} tool=${tool} queueLen=${mutex.queueLength} locked=${mutex.locked}`);
  }

  const waitStart = Date.now();

  // Race the mutex acquire against a waiter-side timeout. Winner is whichever
  // resolves first. If the timeout wins, we return a conversational error to
  // the waiter; the queue entry still exists so we must release it when our
  // turn eventually comes up (drain-and-discard).
  let release = null;
  // Captures the daemon's mutex hard-timeout info if it fires for THIS hold.
  // Set by mutex's per-call onPerCallTimeout hook. Read after the call returns.
  let hardTimeoutInfo = null;
  const onPerCallTimeout = (info) => { hardTimeoutInfo = info; };
  const timeoutSignal = Symbol('waiter-timeout');
  const acquirePromise = mutex.acquire({ session, tool, targetId, targetUrl, onPerCallTimeout }).then((r) => { release = r; return 'acquired'; });
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(timeoutSignal), WAITER_TIMEOUT_MS));

  const result = await Promise.race([acquirePromise, timeoutPromise]);

  if (result === timeoutSignal) {
    const holder = mutex.currentHolder();
    const waitedMs = Date.now() - waitStart;
    warn(`tools/call waiter-timeout: session=${session} tool=${tool} waitedMs=${waitedMs} holder=${holder?.session || 'n/a'}:${holder?.tool || 'n/a'}`);
    // Still drain our slot when it eventually comes up so we don't starve others.
    acquirePromise.then(() => release && release());
    return buildHoldMessage({ waitedMs, holder, waiterTool: tool });
  }

  let backendResult;
  let backendError = null;
  try {
    backendResult = await backendClient.request(
      { method: 'tools/call', params: req.params ?? {} },
      CallToolResultSchema
    );
  } catch (e) {
    backendError = e;
  } finally {
    if (release) release();
  }

  // Hard-timeout-aware response wrapping. If our mutex hard-timeout fired
  // during this hold, the cdt-tab-watcher likely evicted the wedging tab —
  // either at acquire-time (daemon-cooperation fast path, when targetId was
  // pre-resolved) or via snapshot-diff fallback. Surface that context to the
  // calling steward so the missing tab + recovery is explained, not silent.
  if (hardTimeoutInfo) {
    return buildWedgeRecoveryMessage({ hardTimeoutInfo, backendResult, backendError });
  }
  if (backendError) throw backendError;
  return backendResult;
}

// ------------------------------------------------------------------
// Wedge-recovery message builder
// ------------------------------------------------------------------
// When a tools/call hits the daemon's hard-timeout, the cdt-tab-watcher's job
// is to evict the wedging tab so subsequent calls aren't poisoned. From the
// CALLING steward's perspective the recovery is otherwise INVISIBLE — they
// just see a delayed result that may or may not reflect the post-eviction
// state. This function makes recovery legible: prepend a structured
// explanation block to the tool result so the steward knows what happened
// and can reason about safe re-navigation.
function buildWedgeRecoveryMessage({ hardTimeoutInfo, backendResult, backendError }) {
  const heldSec = Math.round((hardTimeoutInfo.heldMs ?? 0) / 1000);
  const tabClause = hardTimeoutInfo.targetUrl
    ? `the tab at ${hardTimeoutInfo.targetUrl}`
    : `the wedging tab (URL not pre-resolved at acquire-time; the watcher's snapshot-diff fallback identified it)`;
  const lines = [
    `[chrome-devtools recovery notice]`,
    ``,
    `Your "${hardTimeoutInfo.tool}" call exceeded the daemon's ${heldSec}s hard-timeout.`,
    `This is the gh-1470 wedge class — typically a Vue admin form (URL contains /admin/, /checkout/, or /edit) that hangs chrome-devtools-mcp's interaction layer.`,
    ``,
    `What the system did automatically:`,
    `  - The daemon force-released the lock so other sessions aren't starved.`,
    `  - The cdt-tab-watcher detected the hard-timeout and closed ${tabClause} via Chrome DevTools /json/close.`,
    `  - The watcher logs the eviction at /tmp/cdt-tab-watcher.log (event: eviction_attempted).`,
    ``,
    `What this means for you:`,
    `  - If your call returned a result below, it reflects state AFTER the wedging tab was evicted.`,
    `  - If your call errored, the error is from the underlying chrome-devtools-mcp call — wedge recovery still happened, but your specific tool call did not complete.`,
    `  - Re-navigating fresh to the same URL is safe BUT the page may re-wedge. If it does, the watcher will evict it again.`,
    `  - Consider whether you actually need to interact with the wedge-prone page, or whether a different surface (server log, API call, screenshot of a static page) gets you the same data without the wedge risk.`,
  ];
  // If backend returned a CallToolResult, prepend our explanation as a new
  // content text block. If it threw, surface as isError:true with our
  // explanation as the only text block.
  if (backendError) {
    lines.push('');
    lines.push(`Underlying error: ${backendError?.message || String(backendError)}`);
    return {
      isError: true,
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }
  // Successful CallToolResult — prepend explanation, preserve original content.
  const explanation = { type: 'text', text: lines.join('\n') };
  const originalContent = Array.isArray(backendResult?.content) ? backendResult.content : [];
  return {
    ...backendResult,
    content: [explanation, ...originalContent],
  };
}

// ------------------------------------------------------------------
// HTTP / Express
// ------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '32mb' }));

// Transports keyed by MCP session id.
const transports = Object.create(null);

app.get('/health', (_req, res) => {
  res.json({
    ok: backendClient != null,
    backend: backendServerInfo,
    backendCapabilities,
    sessions: Object.keys(transports).length,
    mutex: { locked: mutex.locked, queueLen: mutex.queueLength },
  });
});

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          log(`MCP session initialized: ${sid}`);
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          log(`MCP session closed: ${sid}`);
          delete transports[sid];
        }
      };

      const server = createProxyServer(transport.sessionId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    err(`Error handling MCP POST: ${e?.stack || e}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// SSE stream (GET) and session termination (DELETE) support per spec.
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session id');
    return;
  }
  try {
    await transports[sessionId].handleRequest(req, res);
  } catch (e) {
    err(`Error handling MCP GET: ${e?.stack || e}`);
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session id');
    return;
  }
  try {
    await transports[sessionId].handleRequest(req, res);
  } catch (e) {
    err(`Error handling MCP DELETE: ${e?.stack || e}`);
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
});

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
let httpServer = null;

async function main() {
  await startBackend();

  httpServer = app.listen(PORT, BIND_HOST, (error) => {
    if (error) {
      err(`Failed to bind HTTP server: ${error.message}`);
      process.exit(1);
    }
    log(`cdt-daemon listening on http://${BIND_HOST}:${PORT} (MCP endpoint: /mcp, health: /health)`);
  });
}

async function shutdown(signal) {
  log(`Received ${signal}, draining...`);
  // Stop accepting new HTTP work.
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }
  // Close each active transport.
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close?.();
    } catch (e) {
      warn(`Error closing transport ${sid}: ${e?.message || e}`);
    }
    delete transports[sid];
  }
  // Wait briefly for the mutex to drain.
  const start = Date.now();
  while (mutex.locked && Date.now() - start < 5_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await stopBackend();
  log('Clean shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch((e) => { err(e); process.exit(1); }); });
process.on('SIGINT', () => { shutdown('SIGINT').catch((e) => { err(e); process.exit(1); }); });
process.on('uncaughtException', (e) => { err(`uncaughtException: ${e?.stack || e}`); });
process.on('unhandledRejection', (e) => { err(`unhandledRejection: ${e?.stack || e}`); });

main().catch((e) => {
  err(`Fatal boot error: ${e?.stack || e}`);
  process.exit(1);
});
