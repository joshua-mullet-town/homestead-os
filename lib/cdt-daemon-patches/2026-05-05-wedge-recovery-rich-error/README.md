# cdt-daemon patch: 2026-05-05 — wedge recovery rich error message

## Discoverability hook

If you're grepping for any of these in this repo and landed here:
**wedge**, **rich error**, **cdt-daemon**, **cdt-tab-watcher**, **chrome-devtools-mcp**,
**onPerCallTimeout**, **buildWedgeRecoveryMessage**, **gh-1470**, **/admin/ wedge**,
**`Requesting main frame too early`** — you found the right place.

## What this is

A breadcrumb / paper-trail copy of the daemon.js and mutex.js patches Joshua
asked the cdt-tab-watcher Worker to ship on 2026-05-05. The runtime
source-of-truth for the cdt-daemon lives at
`~/.homestead/services/cdt-daemon/` outside any git repo (orphan service dir).
This directory exists so future Workers grepping the homestead repo CAN
find the work.

## Why orphan services

Joshua's `~/.homestead/services/` directory holds long-running launchd
services (cdt-daemon, cdt-tab-watcher, etc.) that aren't part of homestead's
Next.js app. They were never folded into the homestead git repo. When this
patch shipped, Foreman flagged that question for follow-up: "should the
orphan services be brought under version control?" — but that's a separate
Worker, not this one.

## What changed

Two files in the production daemon dir get edited (atomic copy from this
breadcrumb to `~/.homestead/services/cdt-daemon/`):

### `daemon.js` (+~60 lines)

In `wrappedToolCall`:
- New per-call closure variable `hardTimeoutInfo` captures whether THIS
  hold experienced a mutex hard-timeout.
- `mutex.acquire(...)` is called with a new `onPerCallTimeout` hook that
  populates `hardTimeoutInfo` when the timer fires.
- `await backendClient.request(...)` is now wrapped in `try/catch` so a
  thrown backend error is captured rather than propagated.
- After the backend call resolves (success OR error), if `hardTimeoutInfo`
  is non-null, `buildWedgeRecoveryMessage(...)` returns a wedge-recovery
  `CallToolResult` to the calling steward. Otherwise the original
  result/error flows through unchanged.

New function `buildWedgeRecoveryMessage`:
- Composes a steward-readable explanation: which tab (URL or "snapshot-diff
  fallback identified it"), known wedge class (gh-1470 Vue admin form),
  watcher auto-evicted, re-nav safe but may re-wedge.
- Success path: prepends explanation as a new `content[0]` text block, keeps
  the original tool result content.
- Error path: returns `isError: true` with explanation + underlying error
  message as the only content block.

### `lib/mutex.js` (+5 lines)

`acquire(...)` accepts a new optional `onPerCallTimeout` hook. When the
mutex's timer fires (hard-timeout), the per-call hook is invoked alongside
the existing global `onTimeout` callback. Purely additive — old callers
that don't pass `onPerCallTimeout` see no behavior change.

## What this fixes (user-facing)

Before: when chrome-devtools-mcp gets wedged on a Vue admin form,
the cdt-daemon hits its 60s mutex hard-timeout, the cdt-tab-watcher
auto-evicts the wedging tab, and… the calling steward sees nothing
explaining what happened. The backend call either returns clean
post-eviction state (looking like nothing was wrong) or returns a
generic CDP error with no context. The recovery is invisible.

After: the calling steward gets a structured "[chrome-devtools recovery
notice]" prepended to their tool result, naming the evicted tab, the wedge
class, and what they should do next.

Joshua's framing: *"the timeout error returned to the steward must carry an
explanation."*

## Where to verify

- Worktree: `~/.worktrees/homestead/cdt-tab-watcher/cdt-daemon/` (the
  test-rig copy that ran the smoke).
- Production: `~/.homestead/services/cdt-daemon/` (the live launchd target
  — atomic copy from this branch lands there).
- Smoke-test results: `~/.worktrees/homestead/cdt-tab-watcher/test-proof/SMOKE-TEST-RESULTS.md`.

## Re-running the smoke test

Steps documented in `test-proof/SMOKE-TEST-RESULTS.md` under "Test rig
topology." TL;DR:

```bash
# Isolated headless Chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir=/tmp/smoke-test-chromium-profile \
  --no-first-run --no-default-browser-check --headless=new --disable-gpu &

# Isolated daemon copy
cd ~/.worktrees/homestead/cdt-tab-watcher/cdt-daemon
CDT_BROWSER_URL=http://127.0.0.1:9333 \
CDT_DAEMON_PORT=9334 \
CDT_TOOL_CALL_TIMEOUT_MS=15000 \
node daemon.js > /tmp/smoke-test-rig/daemon.log 2>&1 &

# Isolated watcher copy
cd ~/.worktrees/homestead/cdt-tab-watcher
CDT_CHROME_URL=http://127.0.0.1:9333 \
CDT_DAEMON_LOG_PATH=/tmp/smoke-test-rig/daemon.log \
CDT_WATCHER_OFFSET_PATH=/tmp/smoke-test-rig/watcher.offset \
node watcher.js > /tmp/smoke-test-rig/watcher.log 2>&1 &

# Throwaway Claude with isolated MCP config
cat > /tmp/smoke-test-rig/throwaway-mcp.json <<EOF
{ "mcpServers": { "chrome-devtools": { "type": "http", "url": "http://127.0.0.1:9334/mcp" } } }
EOF

# Open admin/vote tab
curl -X PUT "http://127.0.0.1:9333/json/new?https://givegrove-mullet.web.app/are-we-backwards-compatible-tho/admin/vote"

# Drive a wedge
echo "Use chrome-devtools take_snapshot, then list_pages. Show both responses verbatim." | \
  claude --print --strict-mcp-config \
  --mcp-config /tmp/smoke-test-rig/throwaway-mcp.json \
  --dangerously-skip-permissions --model haiku
```
