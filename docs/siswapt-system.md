# Siswapt System Definition

**Self-Improving Strategy With All-Powerful Tooling**

This is the reference doc for the Siswapt pattern.

---

## What Is a Siswapt?

A template for self-improving agents. Each Siswapt has:

| Component | Purpose | Starts As |
|-----------|---------|-----------|
| `CLAUDE.md` | Job description + agent role instructions + shared tools reference | Written by creator |
| `STRATEGY.md` | Pure operational strategy. How to do the job well. Only the Theorist updates it. Can spawn sub-docs as needed. | Simple seed from creator |
| `interactions.json` | Every interaction logged here. Stats baked into each entry. Schema evolves as the Theorist decides what's worth tracking. | Empty array |

### Three Agents

1. **Foreman** — receives all messages, dispatches to subagents, owns interactions.json (logging + stats), reaches Joshua directly by walkie (the unified `message` tool with recipient "josh"), and serves as the user's direct tap-in point.
2. **Doer** — spawned by the Foreman when work needs doing. Reads STRATEGY.md, does the work, returns results.
3. **Theorist** — spawned by the Foreman when user gives feedback. Owns STRATEGY.md and controls the stat schema. The only agent that updates strategy.

### Who Controls What

- **Foreman** = organizer. Runs the pipeline, logs data, walkies Joshua. Classifies feedback (build vs doer vs both) and routes accordingly.
- **Doer** = executor. Reads STRATEGY.md, acts on sessions, returns what it did and why. Also delivers build feedback to session agents when needed.
- **Theorist** = strategist. Controls how the system improves. Owns STRATEGY.md, owns `tools/` (analytics scripts), tells the Foreman what stats to track. Must be critical and unbiased.

---

## interactions.json — The Data Layer

The central data store for each Siswapt. Each entry accumulates data over its lifecycle:

```json
{
  "id": 1,
  "timestamp": "ISO timestamp",
  "session": "holler-givegroove",
  "query": "what was the agent asked to do",
  "response": "what the Doer did",
  "thinking": "why it made those decisions",
  "feedback": "user feedback text",
  "sentiment": "positive|negative",
  "category": "testing|deployment|code-review|...",
  "strategy_updated": true,
  "update_category": "testing"
}
```

- Fields are filled progressively — starts sparse at intake, grows as feedback comes in
- The schema evolves naturally. New fields appear as the Theorist decides what's worth tracking. Old entries missing new fields are just ignored.
- This IS the stats. No separate stats file. Scripts can aggregate later (acceptance rate by category, which sessions need help, etc.)
- Start flat JSON. May mature to SQLite when the Theorist decides it's time.

---

## STRATEGY.md — Pure Operational Strategy

- Contains only strong operational guidance — how to do the job well. Nothing else.
- Only the Theorist updates it
- Can spawn sub-docs as needed
- Growth only happens on verified discoveries (confirmed by feedback), not speculatively
- On every feedback cycle, the Theorist decides:
  1. Should I update STRATEGY.md? (add patterns, strengthen language, correct mistakes)
  2. Should I change what stats we're tracking in interactions.json?
  3. Should I create/update sub-docs or tools?
  4. Or is everything already solid? (no-op is a valid answer)

### Feedback Decision Rules

- **Positive feedback + strong existing language** → No-op. We're nailing it.
- **Positive feedback + weak/no language** → Add it as a proven pattern or strengthen existing mention.
- **Negative feedback** → Investigate and update so it's handled better next time.

---

## Theorist Analytics Tools

The Theorist owns a `tools/` directory inside each siswapt for scripts that analyze interactions.json.

- **Purpose:** Ground decisions in data, not vibes. Positive/negative ratios, trend lines, category breakdowns, per-session performance.
- **Build as needed.** Start with obvious stuff (good vs bad count), grow as the data grows.
- **Any language.** Shell, node, python — whatever gets the job done.
- **Delete dead tools.** If a script stops being useful, remove it.

### Stats Accountability

Every stat the Foreman tracks must **earn its keep.**

- Be critical, not flaky. Each stat should answer: "Is this agent helping Josh or not?"
- Watch for dead stats — fields that never change or never inform decisions. Kill them.
- Watch for bias — don't track things that make the agent look good. Track things that reveal truth.
- Be definitive. "Trending well" or "trending poorly" with evidence. Not "might be improving."
- Review periodically — does any of this actually matter? Would decisions change without it?

---

## The Feedback Loop

### Action Phase
1. Request comes in → Foreman logs intake to interactions.json (id, timestamp, session, query)
2. Foreman spawns Doer → Doer reads STRATEGY.md, does the work
3. Doer returns `What I Did` + `Why` → Foreman logs response + thinking
4. Foreman walkies Joshua (the `message` tool, recipient "josh") with default pattern: 👍 button + text box

### Feedback Phase
5. User responds — thumbs up (positive), text feedback, or both
6. Foreman **classifies the feedback:**
   - **Build feedback** — about the session's output (what's on screen, bugs, UX). Goes to the session agent via a Doer.
   - **Doer feedback** — about how the build manager approached the work. Goes to the Theorist.
   - **Both** — split and route both directions.
7. If build feedback → Doer delivers it to the session agent
8. If doer feedback → Theorist reads STRATEGY.md + interactions.json + runs analytics tools
9. Theorist returns: what docs were updated and what the changes were
10. Foreman logs feedback data + any doc updates to the interactions.json entry

### Feedback Classification

If Josh calls out the Doer directly or talks about how the agent worked → Doer feedback.
If Josh talks about the build output itself → build feedback.
If it's mixed, the Foreman splits and routes both.

---

## Primary Interface: Walkie Joshua

Reaching Joshua directly is how siswapts communicate with him — walkie him via the unified `message` tool with recipient "josh". Always use it.

- Posts to a persistent floating Electron window on Joshua's devices
- Items queue up — Josh handles one at a time
- His reply arrives later as feedback
- Buttons can carry shell commands for instant actions: `{ "label": "Watch Demo", "run": "open http://localhost:3000" }`

### Default Feedback Pattern

Keep it simple — Josh is juggling multiple things:
- **"👍"** button — thumbs up, everything's good
- **`input: true`** — always show the text box
- Action buttons (with shell commands) are for showing/doing things, not collecting feedback

---

## File Structure

All Siswapts live in `~/.homestead/siswapts/`. Git committed on every change.

```
~/.homestead/siswapts/
├── all/                        # Shared tools, techniques, instructions for ALL siswapts
│   ├── tools/
│   └── instructions/
├── build-manager/
│   ├── CLAUDE.md
│   ├── STRATEGY.md
│   ├── interactions.json
│   └── tools/                  # Theorist's analytics scripts
└── [future-siswapt]/
    ├── CLAUDE.md
    ├── STRATEGY.md
    ├── interactions.json
    └── tools/
```

- `all/` = shared infrastructure referenced by every Siswapt's CLAUDE.md (via `../all/`)
- `tools/` = Theorist's analytics scripts for analyzing interactions.json. Grows over time.
- Each Siswapt can create whatever sub-docs/files it needs inside its own directory
- STRATEGY.md is the entry point — it links to sub-docs as the system grows

---

## Version Control

**Not the agent's job.** An external file watcher monitors `~/.homestead/siswapts/*/` for changes.

| What changed | Commit cadence |
|--------------|---------------|
| `STRATEGY.md` | Immediately on every change |
| `interactions.json` | Once a day |
| Sub-docs, other files | Once a day |

---

## Future Siswapts

New siswapts follow the same 3-file pattern. Each starts lean and grows through feedback.

---

## FUTURE IDEAS

### Fixer Bot
- Periodically checks all Siswapts — if one has been "working" for 10+ min or unresponsive, attempts to fix/restart it

### Weekly Self-Review + Brain Swaps
- Each Siswapt reviews its own commits + interactions.json for the week
- Looks at all negative feedback, identifies patterns
- Gives itself an honest assessment: trending up, flat, or declining
- **Brain swaps:** Well-performing Siswapts share their strategy with struggling ones

### Evolution (A/B Testing)
- Low-performing Siswapts propose alternative strategies
- A/B split test the new approach vs current
- Only for underperformers — don't fix what works

### Multiplication
- Ask each Siswapt: "Are you doing more than one discrete task?"
- If yes, consider splitting into 2 Siswapts for quality

### Local-to-Cloud Escalation
- Prove a local model can handle routine work
- When it hits limits, escalates to a full Claude Code session
- Keeps credit usage minimal while maintaining full power access
