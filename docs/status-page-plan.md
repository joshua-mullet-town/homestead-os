# Home Page Cleanup & Status Page Consolidation

## Context

The home page header is cluttered — on mobile it's too wide with McpStatusBar (`C:X MCP:X ⚰X 1.2GB`), scheduler button, push notifications bell, server restart, and refresh all competing for space. Below it, the channel health bar adds more noise. Most of this isn't directly related to dev work. The goal: move all ops/monitoring stuff to a dedicated `/status` page and leave the home page as a clean session launcher.

## What Changes

### 1. New `/status` page
**New file:** `app/status/page.tsx`

Single scrollable mobile-friendly page with these sections:

**Header:** "STATUS" title + back arrow + refresh button

**Section A — System Resources:** Full MCP breakdown in card format (not a tiny pill). Claude processes, MCP count, orphans, total memory. Kill buttons. Reuses data from `/api/mcp-status`. Basically the McpStatusBar dropdown content rendered as a full card.

**Section B — Channel Health:** 2-column grid from the scheduler page (`app/scheduler/page.tsx` lines 331-385). Harvester status pill. Re-auth tap actions for Gmail/SMS. "X/Y Connected" summary.

**Section C — Scheduled Jobs:** Job list from scheduler page (lines 387-471). Enable/disable toggle, run-now, delete, next fire time. Includes the fixed cron parser functions (`getNextCronTime`, `formatCron`, `formatTimeUntil`).

**Section D — Push Quick Test:** One card with status indicator + device count + single "TEST PUSH" button. Success/error feedback. Link to `/debug-push` for advanced testing.

**Section E — Server Management:** Rebuild & restart buttons (moved from home header). Status feedback.

### 2. Simplified home page header
**File:** `app/page.tsx`

New header layout:
```
HOMESTEAD          [1.8GB] [STATUS] [REFRESH]
```

- **Keep:** "HOMESTEAD" title, Refresh button
- **Add:** `MemoryPill` component — just total GB with severity color, taps to `/status`
- **Add:** Status icon → navigates to `/status` (replaces calendar, bell, server buttons)
- **Remove:** Full McpStatusBar, Scheduler button, PushNotifications bell, Server restart button
- **Remove:** Entire channel health status bar (lines 683-758)
- **Remove:** Gmail re-auth modal and all its state/logic (moves to `/status`)
- **Remove:** `handleRestartServer`, `channelHealth`, `harvesterStatus`, `serverRestarting` state + fetches

### 3. New `MemoryPill` component
**New file:** `app/components/MemoryPill.tsx`

~30 lines. Polls `/api/mcp-status` every 10s. Renders just total GB in a small pill with severity color (green <2GB, yellow 2-4GB, red >4GB). Clicking navigates to `/status`.

### 4. Session header — NO CHANGES
`app/session/[project]/layout.tsx` keeps full McpStatusBar with dropdown, restart, kill. Untouched.

## Files to Create
- `app/status/page.tsx` — New status dashboard
- `app/components/MemoryPill.tsx` — Compact memory-only pill for home header

## Files to Modify
- `app/page.tsx` — Strip header, remove channel health bar, remove server restart, remove Gmail re-auth modal, replace McpStatusBar with MemoryPill + status link

## Files Referenced (copy patterns from)
- `app/scheduler/page.tsx` — Channel health grid (331-385), jobs list (387-471), cron parser (43-107)
- `app/components/McpStatusBar.tsx` — MCP data fetching, dropdown content (193-321), `severityColor`/`formatGb` helpers
- `app/debug-push/page.tsx` — Push send logic for the quick test button
- `app/components/PushNotifications.tsx` — Subscription status check

## Implementation Order
1. Create `MemoryPill.tsx` — small standalone component
2. Create `app/status/page.tsx` — build the full status page, pulling UI patterns from scheduler and McpStatusBar
3. Simplify `app/page.tsx` — swap in MemoryPill + status link, remove everything else

## Verification
- Open home page on phone — header should be clean: title, memory pill, status icon, refresh
- Tap memory pill or status icon → navigates to `/status`
- Status page shows: MCP resources, channel health grid, scheduled jobs, push test button, server restart
- Session header unchanged — still has full McpStatusBar with dropdown
- `/scheduler` and `/debug-push` still work as standalone pages
