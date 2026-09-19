# Discovery — make bookmark-add real-time on the presenter, without compounding polling

**Worker:** `holler-homestead--foreman--bookmarks-realtime-discovery`
**Date:** 2026-06-02
**Plan node:** `bookmarks-realtime-discovery-no-new-polling` (`/plan/children/1/children/50`)
**Charter:** report only, no code changes. Recommendation + tradeoffs. Joshua picks the path.

---

## 0. Joshua's ask, verbatim

> Could you go ahead and do some discovery on how we can make that real-time instead of it being something I have to use a reload for? And I want to avoid us just compounding all these different polling mechanisms. So either we can easily piggyback off of an existing one or we use even a more clever system if we can.

Hard constraint: **avoid compounding polling.** This report evaluates piggyback options first; clever alternatives are only proposed if no piggyback exists. A piggyback **does** exist (TL;DR below).

---

## TL;DR

**Recommendation: piggyback the existing Socket.IO channel.** Add a single server-side `io.emit('presenter:bookmarks-updated', { session_name })` in `app/api/bookmarks/route.ts` after each successful POST/DELETE, and a matching `socketIo.on('presenter:bookmarks-updated', ...)` handler in `electron-presenter/renderer/app.js` that re-runs the existing `/api/bookmarks` hydrate path.

- **Zero new mechanisms.** No new SSE stream, no new WebSocket, no new file watcher, no new polling loop.
- **Reuses the same `io` instance** already wired up at `server.js:1515` (`global.io = io`).
- **Reuses the existing hydrate code path** at `electron-presenter/renderer/app.js:6431-6453` — the bookmark IIFE already knows how to refetch + re-render from `/api/bookmarks`.
- **Matches the pattern Homestead already uses for ~6 other live updates** (`presenter:status-update`, `presenter:activity-update`, `presenter:item-updated`, `presenter:bulk-resolved`, `walkie:enqueued`, `walkie:confirmed`, `session:created`, `session:deleted`).

The implementation is ~5 lines server-side and ~5 lines client-side. The Socket.IO channel is the obvious piggyback — it is *literally* what every other "presenter refreshes when server-side state changes" feature already does today.

---

## 1. Current state — what reloads today, and why

### The pain (verified)

Joshua adds a bookmark via the manage-steward-bookmarks skill:

```bash
curl -s -X POST http://localhost:3005/api/bookmarks \
  -H 'Content-Type: application/json' \
  -d '{"session_name": "...", "bookmarks": [...], "mode": "append"}'
```

The POST handler at `app/api/bookmarks/route.ts:56-96` writes `data/steward-bookmarks.json` and returns 200. **It does not emit any socket event, fire any walkie, or signal any other channel.**

### Why the presenter doesn't see it until reload

The presenter renderer (`electron-presenter/renderer/app.js:6418-6453`) hydrates bookmarks **once at startup**:

```js
(async () => {
  try {
    const res = await fetch('/api/bookmarks');
    if (!res.ok) return;
    const serverStore = await res.json();
    // ...merges into localStorage + closure `bookmarks` object
    if (selectedSteward) {
      updatePillLabel(selectedSteward);
      if (openState[selectedSteward]) render();
    }
  } catch (err) {
    console.warn('[bookmarks] server hydrate failed:', err);
  }
})();
```

After that IIFE returns, the `bookmarks` object lives in closure and is mutated only by local UI actions (the manual add/remove buttons in the dropdown). There is no subscription to any server-pushed event, so a steward-initiated POST is invisible until the renderer reloads and the IIFE re-runs.

This matches the language in `feedback_bookmark_means_native_presenter_chip`: *"renderer caches in closure at startup."*

### Surfaces affected

- **Electron presenter (laptop)** — affected.
- **APK presenter (phone)** — affected. Same `app.js` (symlinked from `public/presenter/app.js` → `electron-presenter/renderer/app.js`).
- **Mobile web presenter** — affected. Same `app.js`.
- **Homestead `/` dashboard, `/admin`, sidebar** — *not* affected. `grep -rn "bookmarks" app/ --include="*.tsx"` finds zero consumers. Bookmarks are presenter-only on the client side.

So "the presenter" is the whole surface that needs the fix, exactly matching Joshua's phrasing.

---

## 2. Enumeration — every real-time channel the presenter is plugged into today

Source: `electron-presenter/renderer/app.js` (lines 83-158) and `server.js` (lines 1515-1615, 1620-1900, 1924-1949).

### Channel A — Socket.IO (`socketIo = io(SERVER_URL)`)

| Field | Value |
|---|---|
| What | Bidirectional Socket.IO connection between every presenter client and the Node server |
| Where it lives | `server.js:1515` (`global.io = io`); client connects at `app.js:91` (`socketIo = io(SERVER_URL)`) |
| When it fires | Per-event, server-pushed; no fixed cadence |
| Who subscribes | All presenter clients (Electron, APK, mobile web) |
| Frequency | Event-driven; some events do have server-side timers feeding them (status/activity = 5s, thinking = 3s — but those are server-internal, not new pollers on the client) |
| Extensible? | **Yes, trivially.** It is type-multiplexed by event name: `socketIo.on('<event-name>', cb)`. Adding a new event type is the pattern. |
| Current events server→presenter | `presenter:new-item`, `presenter:item-resolved`, `presenter:bulk-resolved`, `presenter:item-updated`, `presenter:status-update`, `presenter:activity-update`, `presenter:thinking`, `walkie:enqueued`, `walkie:confirmed`, `session:created`, `session:deleted` |
| Current events presenter→server | `presenter:register`, `presenter:ack`, `presenter:exec-shell`, terminal handlers |
| Maintenance cost of adding one more event | ~5 lines server + ~5 lines client. No new connection, no new lifecycle code. |

**This is the piggyback channel.** Multiple completed Homestead features have already used this exact pattern to remove polling-based UIs in favor of explicit signals — `walkie:enqueued`/`walkie:confirmed` literally exists because polling `/api/queue` was producing fake "send failed" toasts (see `app.js:110-121, 168-220`). The retire-the-poll-add-an-event move has precedent.

### Channel B — Queue dispatcher (walkie-talkie)

| Field | Value |
|---|---|
| What | File watcher + 10s fallback poll on `~/.homestead/queue.json`; ticks the dispatcher to deliver walkie messages |
| Where it lives | `server.js:1924-1949` |
| When it fires | On `fs.watch` event (debounced 500ms) OR every 10s as a fallback |
| Who subscribes | Server-internal only — dispatcher then injects messages into target tmux sessions; emits `walkie:enqueued` / `walkie:confirmed` over Channel A to update presenter UI |
| Frequency | Bursty per file-change; capped at one dispatcher tick per 500ms |
| Extensible for bookmarks? | Conceptually yes, but it would require routing bookmark-add through the walkie queue — wrong semantics. Bookmarks are not session-targeted messages. |

**Reject for bookmarks.** Wrong shape: this channel exists to deliver targeted messages to specific tmux sessions, not to broadcast state changes to UI clients. Repurposing it for bookmark broadcasts would conflate two systems that today have a clean separation.

### Channel C — Activity/status poll (server-internal, 5s)

| Field | Value |
|---|---|
| What | Server reads `/tmp/claude-session-*-activity.json` every 5s, diffs, broadcasts changes |
| Where it lives | `server.js:1530-1576` |
| When it fires | Every 5s |
| Who subscribes | Pushes to presenter via Channel A (`presenter:status-update`, `presenter:activity-update`) |
| Extensible? | Already feeds Channel A — adding bookmark-watch here would mean adding a second `setInterval` body that reads `data/steward-bookmarks.json` every 5s. **That's net-new polling. Joshua's constraint blocks this.** |

**Reject for bookmarks.** Adding a `data/steward-bookmarks.json` watch into this interval *is* the compounding-polling pattern Joshua warned against. Worse, it would also add a 5s latency floor for a feature that today writes through `route.ts` in a single tick.

### Channel D — Thinking capture (server-internal, 3s tmux capture-pane)

`server.js:1582-1615`. Emits `presenter:thinking`. Same shape as C — server-internal poller that feeds Channel A. Same rejection: not for bookmarks.

### Channel E — fs.watch on `~/.homestead/queue.json`

Already counted under Channel B. Note that **`fs.watch` is the existing pattern Homestead uses when it wants to react to file changes without polling.** That's relevant for the "clever alternative" section below.

### Channel F — Periodic cleanup (`tmuxManager.cleanupIdle`, 5min)

`server.js:1909-1911`. Pure server-internal housekeeping. Not a candidate.

### Channel G — Static-asset cache-bust / no-store headers on presenter static files

`server.js:1452` (header setting). Not a real-time channel — just a cache directive. Not relevant.

### Channel H — `presenterQueue.setIo(io)` and `queueDispatcher.setIo(io)`

These are not separate channels; they hand the same `io` instance to library modules so those modules can `io.emit` over Channel A. Reinforces that Channel A is the canonical "push state to presenter clients" mechanism.

### Summary

Channel A (Socket.IO) is the **only** general-purpose, type-multiplexed, presenter-subscribed, bidirectional channel that already exists. All other "real-time" features in the system either feed Channel A (B, C, D) or are unrelated to UI updates (F, G). **Piggybacking A is the only option that doesn't compound polling.**

---

## 3. Piggyback options + tradeoffs

### Option 1 — `presenter:bookmarks-updated` over Socket.IO (RECOMMENDED)

**Server side** (`app/api/bookmarks/route.ts`):

```ts
// After successful writeStore(store) in POST and DELETE:
const io = (globalThis as any).io;
if (io) io.emit('presenter:bookmarks-updated', { session_name: sessionName });
```

(Note: `globalThis.io` is already set at `server.js:1515`. App-Router route handlers can read it since they run in the same Node process when launched via the custom `server.js`. Verify in implementation; if not directly accessible from a Next.js route handler context, the standard workaround is to attach the emit to the same module that writes `data/steward-bookmarks.json` and have `server.js` import + re-export, or to forward via a tiny internal helper. This is a 5-line implementation detail, not an architectural concern.)

**Client side** (`electron-presenter/renderer/app.js`, inside the bookmark IIFE around line 6453):

```js
if (typeof socketIo !== 'undefined' && socketIo) {
  socketIo.on('presenter:bookmarks-updated', async (payload) => {
    // Refetch using the existing hydrate path
    try {
      const res = await fetch('/api/bookmarks');
      if (!res.ok) return;
      const serverStore = await res.json();
      // ... same merge as initial hydrate ...
      if (selectedSteward) {
        updatePillLabel(selectedSteward);
        if (openState[selectedSteward]) render();
      }
    } catch {}
  });
}
```

(The exact factoring — extract the hydrate body into a named function vs. inline — is an implementation choice.)

**Tradeoffs:**

| Pro | Con |
|---|---|
| Zero new mechanisms; pure piggyback | Server route handler needs access to the shared `io` instance — minor wiring question, not architectural (see note above) |
| ~10 lines total | If `socketIo` is undefined (Electron pre-load, network blip), the bookmark stays invisible until next reload — same failure mode as today, no regression |
| Reuses the existing hydrate code path; consistent with how all other live presenter state works | Fires on **any** bookmark mutation, not just adds — so the client refetches even when the change came from itself. Cheap (full store is small JSON) and harmless. |
| Latency: instant (microseconds from POST → emit → client refetch) | If `payload.session_name` doesn't equal the presenter's currently-selected steward, a refetch still happens. Trivial cost; could be optimized later to only refetch when relevant. |
| Pattern precedent: `walkie:enqueued`, `walkie:confirmed`, `session:created`, `session:deleted` all do exactly this | None of significance. |

**Why this is the right call:** Adding an event type to an existing Socket.IO channel is **not "another polling mechanism"** — it's the opposite. Joshua's constraint is about not stacking new `setInterval` loops or new subscription channels. This proposal adds **zero** of those. The presenter Socket.IO connection is already open, already authenticated as owner, already type-multiplexed; the additional cost is one event name registered in two places.

### Option 2 — Smart-fetch on dropdown open (lazy revalidation)

**Concept:** Re-hydrate `/api/bookmarks` every time the user opens the bookmarks dropdown. No event channel needed.

**Tradeoffs:**

| Pro | Con |
|---|---|
| Zero new mechanisms — purely client-side | NOT real-time. Joshua has to open the dropdown to see the change. He explicitly said "real-time instead of having to reload" — opening a dropdown is the same UX class as reloading. |
| Trivially correct | Doesn't solve the stated problem. |

**Reject.** Doesn't meet Joshua's "real-time" framing — only narrowly avoids the literal "reload" word.

### Option 3 — Hook bookmark write into `walkie:enqueued` route

**Concept:** Make the bookmark POST handler enqueue a self-targeted walkie message so the dispatcher emits `walkie:enqueued` and presenter UIs refresh on that.

**Reject.** Conceptually abusive: the walkie channel exists to ferry messages between sessions. Repurposing its signal as a generic "presenter state changed" pulse leaks bookmark semantics into the walkie infrastructure. Maintenance hazard for future readers. Channel A direct-emit is the clean version of this idea.

---

## 4. Clever alternatives (only if piggyback truly infeasible — included for completeness)

Per charter step 4, these are listed only so Joshua can see the recommendation-space boundary. **None of these should be picked if Option 1 works**, which it does.

### 4a. Dedicated SSE stream `/api/bookmarks/stream`

A new SSE endpoint that holds connections open and pushes events on file changes.

| Pro | Con |
|---|---|
| Decouples bookmarks from the main Socket.IO traffic | **New mechanism.** Compounds against the constraint. |
| Standard, simple primitive | Now the presenter has TWO long-lived push connections (Socket.IO + SSE). |
| | Higher reconnection-state-management burden across mobile network blips. |

### 4b. Dedicated WebSocket on a separate path

Same shape as 4a but bidirectional. **Same rejection — adds a second connection.** Strictly worse than 4a because WebSocket is overkill for one-way state push.

### 4c. `fs.watch('data/steward-bookmarks.json')` → `io.emit`

Watch the JSON file directly with Node's `fs.watch`, debounce, emit on Channel A.

| Pro | Con |
|---|---|
| Catches mutations from *any* source (manual file edits, future write paths), not just `/api/bookmarks` POSTs | Currently the only writer IS `/api/bookmarks`. Solving for unknown future writers = YAGNI. |
| No coupling between the route handler and `io` | More moving parts than direct emit. Adds a file-watch lifecycle to maintain. |
| Pattern echoes the queue-file fs.watch at `server.js:1939` | Bookmark mutations are rarer than queue mutations; the queue file watch is justified by message-delivery latency requirements that don't apply here. |

**Defensible only if** Option 1 turns out to be wired in an awkward way (e.g., the App Router route handler genuinely cannot reach `globalThis.io`). Even then, route-handler→fs.watch→emit is a longer path than route-handler→emit; the wiring problem is solvable.

### 4d. Add bookmark-watch to the existing 5s activity-poll interval

Read `data/steward-bookmarks.json` inside the `setInterval` at `server.js:1530`, diff against last broadcast, emit on change.

**Reject.** This is literally "compound the polling" — adds a 5s latency floor to a feature that today is sub-millisecond on the write side, and bolts more responsibility onto an interval that already has a focused job (activity/status broadcast).

---

## 5. Ranked recommendation + rationale

1. **Option 1 — `presenter:bookmarks-updated` on Socket.IO.** Piggyback. ~10 lines. Real-time. Matches existing pattern. **Do this.**
2. (gap)
3. Option 4c — `fs.watch` + Channel A emit. Only as fallback if Option 1's wiring proves awkward.
4. (gap)
5. Everything else (4a, 4b, 4d, Option 2, Option 3) — reject.

**The rationale in one sentence:** Channel A is the dedicated, type-multiplexed, presenter-subscribed real-time push channel that Homestead has already standardized on for every comparable feature (session lifecycle, walkie state, queue state, status/activity), so the bookmark case is just "register one more event name."

---

## 6. What this report deliberately does NOT decide

- **UI surface for the bookmark-update visual.** Today the bookmarks dropdown re-renders on the next open and the pill label updates immediately via `updatePillLabel`. That's probably fine. If Joshua wants a flash/toast/animation when a new bookmark arrives mid-session, that's a separate, smaller follow-on.
- **Whether to dedupe self-originated emits.** The implementation can pass the originating client's socket id through and skip re-render for self-changes, but it's not necessary for correctness — refetching your own write is cheap.
- **Tabbing the report into Homestead `/admin`.** Per charter, that's follow-on once Joshua picks a path. Not in scope here.

---

## Appendix — source-of-truth references

- Bookmarks API route: `app/api/bookmarks/route.ts` (POST handler `:56-96`, DELETE handler `:98-124`)
- Bookmark storage: `data/steward-bookmarks.json`
- Presenter bookmark IIFE: `electron-presenter/renderer/app.js:6418-6453` (hydrate) and beyond (render, push)
- Socket.IO server bootstrap: `server.js:1515-1523` (`global.io = io`, `presenterQueue.setIo`, `queueDispatcher.setIo`)
- Existing Channel A event registry, client side: `app.js:83-158`
- Existing Channel A emits, server side: `server.js:1568, 1573, 1607` (and inside `lib/presenter-queue.js` and `lib/queue-dispatcher.js`, via the `setIo` plumbing)
- Queue-file fs.watch precedent: `server.js:1939-1949`
- Universal-memory entries consulted: `feedback_bookmark_means_native_presenter_chip`, `reference_steward_bookmarks_api`
