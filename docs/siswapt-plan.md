# Siswapt UI — Dedicated Interface for Agent Workers

**Priority: TOP — Current Focus**

## The Problem

Siswapts (like one-interface, future alert-worker retrofit) are agent workers that look like sessions but aren't the same as dev sessions. They need:
- Their own section in the UI (not lumped in with dev sessions in the right gutter)
- A specialized page layout (different right-side panel content than dev sessions)
- Quick access without polluting keyboard navigation for dev sessions

## UI Design Decisions

### Right Gutter: Separate Section
- Siswapts keep the robot icon in the right gutter (already there for alert-worker)
- They are NOT included in the quick-nav session list (no keyboard shortcuts to cycle through them)
- Clicking the robot icon expands a siswapt picker to the left
- Clicking a siswapt navigates to its dedicated page

### Siswapt Session Page — DONE
- Same overall layout as dev sessions: terminal on left, panel on right
- Terminal tab + Chat tab (same as dev sessions)
- **Right-side panel is different** — instead of Plan/State/Docs:
  - **ACTION.md** — the siswapt's operational playbook
  - **STRATEGY.md** — how the siswapt improves over time
  - **responses.json** — the feedback/interaction log
  - **Queue** — pending items for this siswapt from queue.json

### What This Means for Alert Worker
- Alert worker currently shows Queue + Situations in its right panel
- It stays as-is for now (it has custom needs)
- When we retrofit it as a siswapt later, it'll get the universal layout

---

## Implementation Status

### 1. Exclude siswapts from session quick-nav — DONE
### 2. Siswapt session page layout — DONE
### 3. API support — DONE
### 4. Siswapt path resolution in sessions API — DONE

### 5. Siswapt picker UI — TODO
- Robot icon in gutter → click expands a list of ALL siswapt sessions to the left
- Currently: clicking the single bot icon navigates directly to one-interface
- Needed: a picker/flyout that lists all available siswapts when there are multiple

---
---

# Build the One-Interface Manager — First Siswapt

> Siswapt system definition: [docs/siswapt-system.md](docs/siswapt-system.md)

**Goal:** Build the One-Interface Manager as our first Siswapt. This is experimental — we expect it to change. The concept is solid, the implementation will be a living experiment.

**Why this one first:** It's in your face constantly. You'll be able to critique and tweak it in real time as you work.

---

## Phase 0: Prove We Can Send a Message via Queue — DONE

### ~~0.1 Create the directory structure~~ ✓
### ~~0.2 Create a persistent tmux session for the Siswapt~~ ✓
### ~~0.3 Build the queue dispatcher~~ ✓
### ~~0.4 Test it~~ ✓

---

## Phase 1: Shared Infrastructure — DONE

### ~~1.1 Add queue dispatcher to Homestead scheduler~~ ✓
### ~~1.2 Set up the file watcher for auto-commits~~ ✓

---

## Phase 2: Define the One-Interface Manager

### 2.1 The Job
Manage responding to all running Claude Code instances from one place:
- Read the most recent chat + PLAN.md + STATE.md for each active session
- Summarize what each session is doing / waiting for
- Prepare suggested responses for Josh to approve, modify, or reject
- Pre-test, prepare quick actions, auto-respond to common patterns
- **Immediacy:** Pops up as soon as you respond — you're either giving feedback to the manager or acting on what it prepared

### 2.2 Decisions to make

| Decision | Options | Notes |
|----------|---------|-------|
| **Trigger timing** | On session status change? Polled every N seconds? On-demand only? | Needs to feel immediate |
| **Where it runs** | Its own persistent tmux session? Ephemeral per-cycle? | Persistent = always ready, ephemeral = lighter |
| **Output format** | JSON file that Homestead UI reads? Terminal output? Both? | UI would be ideal for mobile |
| **Feedback interface** | Thumbs up/down in Homestead UI? Text response? Terminal? | Must be frictionless from phone |
| **Which sessions it manages** | All holler-* sessions? Only ones with "waiting" status? Configurable? | Start with "waiting" sessions only |

### 2.3 Write CLAUDE.md
The constitution. Defines:
- The job (above)
- How to route to action vs feedback subagents
- Reference to `../all/` for shared tools
- How to handle stats inline (log to responses.json at intake/output/feedback)
- How to handle direct user input

### 2.4 Write initial STRATEGY.md
The seed improvement plan. Starts simple:
- "We just started. Record everything. Track good/bad feedback."
- "When ACTION.md nears 350 lines, consolidate patterns."
- "Review responses.json weekly for improvement opportunities."

### 2.5 Write initial ACTION.md
Starts blank — recording phase. After first few interactions it'll have:
- What sessions looked like when it was asked to prepare responses
- What responses it prepared
- What feedback Josh gave

### 2.6 Initialize responses.json
Empty array: `[]`

---

## Phase 3: Litmus Test

**Prove the pipeline works end-to-end before anything else.**

1. Queue an action to the one-interface Siswapt
2. Main agent receives it, logs to responses.json (intake stats)
3. Action agent reads the waiting sessions, prepares a response suggestion
4. Main agent logs the output to responses.json (output stats)
5. Josh sees the suggestion, gives feedback (thumbs up/down + optional text)
6. Main agent logs the feedback to responses.json (feedback stats)
7. Feedback agent receives it, reads ACTION.md + STRATEGY.md + responses.json
8. Feedback agent decides if anything should change (probably not on first run)

**If this loop works, we're in business.** Everything after is refinement.

---

## Phase 4: Iterate

- Use it daily
- Give feedback constantly
- Watch ACTION.md grow from blank → raw logs → patterns → actual strategy
- Watch STRATEGY.md evolve as the feedback agent learns what works
- Adjust trigger timing, output format, feedback interface based on what feels right
- When it's solid, retrofit Alert Worker as the second Siswapt using the same pattern

---

## Open Questions

- How does the one-interface manager read other sessions' conversations? (conversation.json files? Claude session JSONL? tmux capture-pane?)
- Should the manager have access to all MCP servers or a limited set?
- Demo mode — when does this kick in? After completing a /todo-list? Manual trigger?
- Terminal-only or does it need a Homestead UI page?