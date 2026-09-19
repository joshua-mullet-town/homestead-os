# Potato-Tracker (Pass-the-Rock Drop-Detection) — Design Doc

**Author:** holler-homestead--foreman--potato-tracker (Phase-2 Worker)
**Status:** Skeleton + ledger + heartbeat-READ BUILT & unit-verified. **Reversal HELD behind GATE-B.**
**Reviewer (GATE-B):** holler-rooster — owns the `is_working`-signal reconciliation.
**Plan node:** one-tool-phase-2-pass-the-rock-drop-detection-tracker

---

## 0. TL;DR for the reviewer

Josh's kill-the-Foreman premise: *"if a message is ever dropped, that steward gets rung → always results in a card back to Josh."* This tracker is that guarantee. Every Josh-originated message becomes a uniquely-identified **potato** tracked to a **single current holder**; if the holder goes stuck-with-rock, a **corrections officer** rings the holder; the loop closes only when some steward cards Josh carrying that potato's id.

**I built everything up to the reversal seam and STOPPED.** The one thing I need from you: **the reconciliation call for the `is_working` signal**, because the corrections-officer reversal reads/writes the SAME `/tmp/claude-session-<name>-activity.json` signal that `lib/check-stalled-workers.js` reads and your pane-classifier uses. Two detectors, one signal, opposite actions. Details in §5. I will not harden the reversal until you clear it.

---

## 1. What is a potato (settled spec — not up for review)

- **Per-message identity (Q3):** every message Josh sends = THAT specific potato, unique `potato_id`. Loop closes only when ANY steward passed that potato cards Josh carrying that id. 1..N stewards/cards per potato.
- **Single-holder (Q2):** only the LAST steward currently holding the potato is on the hook. Passing the rock onward moves the holder pointer *fully*; the original sender is NOT kept on the hook. (Holder may escalate to the original; the tracker rings the holder.)
- The old 10s "every-vs-first-in-burst" question is Phase-1 and out of scope here.

These are Josh-answered and binding. Nothing below changes them.

---

## 2. Where a potato is born / moves / closes (verified anchors, 2026-07-21)

All Josh→steward traffic lands in `~/.homestead/queue.json`. Verified the two real Josh-origin entry paths:

| Event | Choke point (file:fn) | Envelope discriminator |
|---|---|---|
| **BIRTH** — bottom-bar fresh send | `server.js` POST `/api/presenter/respond` (`_walkie_` prefix) → `queue-dispatcher.enqueue()` | `from === 'josh-presenter'` |
| **BIRTH** — card reply feedback | `presenter-queue.js respondToItem()` → `writeFeedbackToQueue()` (writes queue.json directly, bypasses `enqueue()`) | `source === 'presenter'` |
| **PASS** — steward→steward walkie | `dispatchToSteward()` → POST `/api/queue` → `enqueue()` | `from === '<sender session>'` (NOT josh) |
| **CLOSE** — card to Josh with potato_id | `presenter-queue.js addItem()` | card carries `potato_id` |

**Scope guard honored:** ordinary steward↔steward traffic (from = a session, not `josh-presenter`, not `source:presenter`) is NOT a potato. The steward↔steward walkie path is UNCHANGED — the tracker only *observes* at enqueue; it never gates, slows, or rewrites a walkie.

### Instrumentation actually wired (this branch)
- `lib/potato-tracker.js` — NEW durable module. Ledger at `~/.homestead/potato-tracker.json` (separate store; queue.json drains terminal items after 60s so history can't live there).
- `queue-dispatcher.enqueue()` — observes birth (bottom-bar) OR pass (steward→steward). Single choke point; birth and pass are mutually exclusive per item. Wrapped in try/catch — a tracker fault can never break dispatch.
- `presenter-queue.writeFeedbackToQueue()` — observes birth (card-reply). Wrapped.
- `presenter-queue.addItem()` — observes loop-close when the card carries `potato_id`. Wrapped; runs AFTER the card commits so it can't affect delivery.
- `potato_id` threaded end-to-end through the real card path: `message` tool inputSchema (DECLARED — the Claude Code MCP client strips undeclared args; this is the exact Phase-1 `reminder_ack` defect, so declaring it is mandatory) → `dispatchToJosh()` → server `/api/presenter/queue` route → `addItem()`.
- Socket events `potato:born` / `potato:passed` emitted for a future UI (additive; no consumer required).

---

## 3. Ledger record shape

`~/.homestead/potato-tracker.json`:
```json
{ "potatoes": { "<potato_id>": {
  "potato_id": "potato-<ts>-<rand>",
  "status": "open" | "closed",
  "origin_queue_id": "<queue item id>",      // idempotency key for birth
  "origin_surface": "bottom-bar" | "card-reply",
  "holder": "<current single holder session>",
  "born_at": "<iso>", "updated_at": "<iso>",
  "chain": [ { "holder","at","via":"birth|pass|close","from?","card_id?" } ],
  "suspicion": null | { "first_strike_at","last_check_at","strikes","reported" },
  "last_pass_queue_id": "<queue id>",         // idempotency key for pass
  "closed_at","closed_by","closing_card_id"
} } }
```
Full `chain[]` is kept for forensics and for the "point to the source" escalation Josh described.

**Idempotency:** birth keyed on `origin_queue_id`, pass keyed on `last_pass_queue_id`, close is a no-op if already closed. The dispatcher re-reads the queue every tick, so observers MUST be idempotent — they are.

---

## 4. Heartbeat / corrections officer (READ half — BUILT)

Runs every **5s** in `server.js` (`heartbeatPass()`), matching Josh's "two checks 5s apart."

Per open potato past a grace window (`HEARTBEAT_GRACE_MS`, default 15s so a just-passed holder isn't rung before picking up the walkie):

1. Read holder `is_working` + `updated_at` from `/tmp/claude-session-<holder>-activity.json` (same reader shape as `check-stalled-workers.js`; a file older than `ACTIVITY_STALE_MS`=120s is `fresh:false`).
2. **Holder working (fresh)** → clear suspicion. A working holder is NEVER a suspect. *(This is the passive form of "no false alarm" — see §5 for the active reversal.)*
3. **Holder not working** → first observation records strike 1; a second observation ≥ `STRIKE_INTERVAL_MS` (5s) later, still not-working, marks the potato **SUSPECT** (two checks 5s apart). Marked `reported` so it doesn't re-flag every pass.

`heartbeatPass()` returns the suspects and **takes no action**. Unit-verified: working holders never flagged, stuck holder flagged only on the 2nd strike, no re-flag, suspicion clears when a holder resumes work.

---

## 5. ⚠️ THE REVERSAL SEAM — what I need from Rooster (GATE-B)

The settled spec's next three steps after a potato goes SUSPECT:

1. **Ring the current holder** — an EXPLICIT walkie to the holder (single-holder; NOT a broadcast — there is no auto-broadcast to steward walkies).
2. **THE REVERSAL** — if the holder turns out to actually still be working (false alarm), flip its status BACK to working and DO NOT accuse. "Corrections officer that fixes false alarms, not a barker."
3. **Genuine-stuck** holder → raise Rooster (real alert) → card to Josh carrying the potato_id → loop closes.

### The collision, concretely
- `lib/check-stalled-workers.js` (5-min cron): reads the SAME `is_working` + `updated_at`, flags card-less + silent>300s **Workers**, walkies the Worker's **Foreman**. NOTIFY-ONLY — it never writes `is_working`. Snooze via `lib/stall-snooze.js` → `/tmp/stall-check-snooze.json`.
- Your **pane-classifier** also does stuck-session detection off the same surface.
- My corrections officer reads the same signal on a **5s** cadence (vs 5min), targets **any holder** (top steward OR worker), and — in step 2 — the reversal *writes* `is_working` back to true.

### The specific hazard I want your call on
**Who owns `is_working`, and may the corrections officer write it?** The activity file is written by three Claude Code hooks (`tool_activity.py` sets `is_working=true` on every tool call; `stop.py` sets it false at turn end; `user_prompt_submit.py`). So:
- A literal file-flip of `is_working=true` by the corrections officer is **racy and transient** — the holder's next hook event overwrites it within one tool call. It also *masks* the holder from `check-stalled-workers` (which skips `is_working===true`), which may be desired or may hide a real stall.

I see three candidate reconciliations (your call — I'll build whichever you pick, or your own):

- **(A) Never write `is_working`.** Treat the "reversal" as a *re-confirm on read*: before ringing, the corrections officer re-reads the freshest activity + optionally a tmux-pane fallback; if the holder is genuinely fresh, it stands down silently (no ring, no accuse) and records a short internal cooldown on that potato. `is_working` stays hook-owned. **(My recommendation — avoids the write race entirely and keeps one writer for the signal.)**
- **(B) Shared hold flag.** Reversal writes a dedicated `/tmp/potato-corrections-hold-<name>.json` (NOT `is_working`), and `check-stalled-workers` learns to honor it (like it honors snooze). Requires a small, coordinated edit to `check-stalled-workers` — which the charter says *reconcile, don't fork*, so this is a coordinated change you'd sign off.
- **(C) Reuse stall-snooze.** On a false alarm, the corrections officer snoozes the stall-check for that holder via `stall-snooze.js` so the two detectors don't double-ring. (Note: stall-snooze is keyed by *worker* session and only affects the 5-min Foreman ping, not your pane-classifier — so this may be partial.)

**Also for your call:** should a genuine-stuck raise go to **you** (holler-rooster) as the charter says, and then you decide the card-to-Josh? Or should the corrections officer card Josh directly with the potato_id? The charter says "raises Rooster (the real alert)," so my default is: corrections officer → walkie holler-rooster with the stuck potato → you own the card decision. Confirm or redirect.

### What I will NOT do until you clear this
No ringing, no `is_working` write, no Rooster-raise wiring. The heartbeat currently only READs + logs suspects. The reversal state machine (steps 1–3) stays a documented stub in `heartbeatPass()`.

---

## 6. Live proof plan (real MCP client — graduation bar)

All six exercised through the real `message` tool, transcripts captured (raw-HTTP is the exact bypass that masked Phase-1):
(a) Josh msg → potato tracked to holder w/ unique id;
(b) real stuck holder (silent-with-rock past heartbeat) → corrections officer detects (2 checks 5s apart) → rings current holder;
(c) a card actually lands on Josh's presenter queue carrying that potato_id → loop closes;
(d) false-alarm: holder still working → status stays working, no accuse, no Rooster raise;
(e) steward↔steward walkie unchanged — live round-trip, zero new friction;
(f) sender-is-Josh discriminator — ordinary steward traffic creates NO potato.

Steps (b),(d) depend on the reversal → gated behind your review. (a),(c),(e),(f) are provable now.

---

## 7. Files touched
- `lib/potato-tracker.js` (NEW) — ledger + observers + heartbeat READ + stubbed reversal seam.
- `lib/potato-tracker-DESIGN.md` (NEW — this doc).
- `lib/queue-dispatcher.js` — defensive require + birth/pass observation in `enqueue()`.
- `lib/presenter-queue.js` — defensive require + birth observation in `writeFeedbackToQueue()` + close observation + `potato_id` on card item in `addItem()`.
- `server.js` — `potato_id` threaded through `/api/presenter/queue` route + 5s READ-only heartbeat interval.
- `mcp-servers/walkie-talkie/tools/message.js` — `potato_id` DECLARED in inputSchema + forwarded.
- `mcp-servers/walkie-talkie/lib/message-dispatch.js` — `potato_id` forwarded in `dispatchToJosh()` payload.

**Collision note (three-way):** shares `lib/presenter-queue.js` + `server.js` with the unified-log-v2 Worker. My edits are in different functions (`writeFeedbackToQueue`, `addItem`, `/api/presenter/queue` POST) than theirs (`getUnifiedLog` ~502-640, `/api/presenter/unified-log` GET). Will pull main + coordinate before merge.
