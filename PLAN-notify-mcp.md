# Notify MCP Server

## Goal
Replace the `notify-ready-to-test.mjs` script with an MCP server that any Claude Code session can use to get the user's attention, navigate them to a specific page, and show test instructions.

## Why
- The current script lives in `~/.claude/skills/todo-list/scripts/notify-ready-to-test.mjs` and uses shell args with janky regex for line breaks
- As an MCP server, any project's Claude Code session can call it with structured params
- No shell escaping, no `<br>` hacks — instructions are just an array of strings
- Can grow with richer tools over time

## MCP Tools

### `notify_user`
Get the user's attention on a specific browser page with an overlay.

**Params:**
- `url` (string, required) — URL to open/navigate to
- `feature` (string, required) — Feature name shown in overlay header
- `instructions` (string[], required) — Array of instruction steps (each becomes a line)
- `session_id` (string, optional) — tmux session ID for sending feedback back. Auto-detected if omitted.

**Behavior:**
1. Opens/navigates Chrome (via CDP on port 9222) to the URL
2. Waits for page load
3. Injects the floating overlay with feature name + instructions
4. Activates the tab and brings Chrome to front
5. Plays a sound alert
6. Overlay has "Works!" button and issue textarea — both send feedback back to the calling Claude Code session via Homestead's inject-message API

### `dismiss_overlay` (future)
Dismiss the test overlay programmatically.

### `check_overlay_status` (future)
Check if user has interacted with the overlay yet.

## Architecture
- Standalone MCP server following the same pattern as `mcp-servers/memory-search/`
- Uses MCP SDK with stdio transport
- Uses CDP (Chrome DevTools Protocol) on port 9222 for browser control
- Overlay injection is the same DOM injection approach as the current script
- Feedback routing uses Homestead's existing `/api/sessions/inject-message` endpoint

---

## Implementation Plan

### Phase 1: Create MCP Server Structure
- [ ] Create `mcp-servers/notify/` directory
- [ ] Create `package.json` with MCP SDK dependency and `ws` for WebSocket
- [ ] Create `index.js` — main server entry point following memory-search pattern
- [ ] Create `tools/notify.js` — the `notify_user` tool implementation

### Phase 2: Port Core Functionality to `tools/notify.js`
- [ ] Extract CDP helper functions from `notify-ready-to-test.mjs`:
  - `waitForPageInList()` — find page by unique ID in CDP list
  - `waitForPageReady()` — poll page until loaded
  - `injectDiv()` — inject overlay via Runtime.evaluate
  - `activateTab()` — CDP activate endpoint
- [ ] Extract macOS helpers:
  - `openUrl()` — `open -a "Google Chrome"` with debug profile
  - `bringChromeToFront()` — osascript
  - `playSound()` — afplay system sound
  - `checkDevServer()` — verify dev server is responding

### Phase 3: Wire Up Tool Interface
- [ ] Define `notify_user` tool schema (url, feature, instructions[], session_id?)
- [ ] Implement `execute()` function:
  1. Validate params
  2. Check dev server is alive
  3. Open URL with unique test ID
  4. Wait for page in CDP list
  5. Wait for page ready
  6. Inject overlay (convert instructions array to HTML list)
  7. Activate tab + bring Chrome to front + play sound
  8. Return success response

### Phase 4: Overlay Improvements
- [ ] Simplify overlay injection — remove the regex hacks for line breaks
- [ ] Instructions as array → numbered list in HTML
- [ ] Keep: draggable, resizable, opacity slider, localStorage persistence
- [ ] Keep: "Works!" button and issue textarea with Homestead feedback

### Phase 5: Integration
- [ ] Run `npm install` in `mcp-servers/notify/`
- [ ] Test locally: `echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"notify_user","arguments":{"url":"http://localhost:3000","feature":"Test","instructions":["Step 1","Step 2"]}},"id":1}' | node index.js`
- [ ] Add to Claude Code global settings (`~/.claude/settings.json` mcpServers)
- [ ] Test from a real Claude Code session

### Phase 6: Cleanup
- [ ] Update `~/.claude/skills/todo-list/SKILL.md` to reference MCP tool instead of script
- [ ] Update `~/.claude/skills/todo-list/TESTING.md` to reference MCP tool
- [ ] Keep `notify-ready-to-test.mjs` as fallback (or delete if MCP works perfectly)

---

## File Structure
```
mcp-servers/notify/
├── package.json
├── index.js              # MCP server entry point
├── tools/
│   └── notify.js         # notify_user tool
└── lib/
    ├── cdp.js            # CDP helpers (wait, inject, activate)
    └── macos.js          # macOS helpers (open, sound, focus)
```

## Dependencies
- `@modelcontextprotocol/sdk` — MCP server framework
- `ws` — WebSocket for CDP communication

## Source Reference
Port logic from: `~/.claude/skills/todo-list/scripts/notify-ready-to-test.mjs`
