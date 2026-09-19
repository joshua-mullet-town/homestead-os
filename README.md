# Homestead

A personal multi-agent system. Long-running Claude Code sessions ("stewards"), each
owning a domain — notification triage, a codebase, infrastructure — that talk to each
other, run scheduled work, and surface decisions to one person through a phone app.

This is a **public mirror of a working system**, not a product. It runs on one person's
Mac today. Read on before trying to launch it.

---

## Honest status: can you run this?

**Partly, and not in an afternoon.** What you're looking at was assembled over a long
period, one permission and one integration at a time. It has never been installed from
scratch by anyone, including its author. Expect to be porting, not installing.

### What it genuinely requires

| Requirement | Why | Negotiable? |
|---|---|---|
| **macOS** | ~33 files use `osascript`, `launchctl`, macOS paths | Not really |
| **tmux** | **82 call sites across 76 files.** Every steward *is* a tmux session | No — this is the architecture |
| **pm2** | Process supervision for the server and workers | Swappable with effort |
| **Node + a C toolchain** | `node-pty` compiles natively (`node-gyp rebuild`) | No |
| **Claude Code** | The stewards are Claude Code sessions | No |

### What is yours to supply

Search the tree for `<<REPLACE` — every spot needing your value says what it wants:

```
grep -rn '<<REPLACE' .
```

**Start with these two — nothing runs until they're right:**
- `ecosystem.config.js` — pm2 process definitions (3 markers)
- `recurring-jobs.json` — scheduled jobs (16 markers)

Most other markers sit in prose and logs, where a name or address was simply mentioned.
Those are redaction artifacts, not settings. Ignore them.

### Hardcoded ports

`3000 3002 3005 3007 8080 8178 8179 8947 9222` — 3005 is the main server.

### Not included

The Android APK (build it from `mobile/`), any credentials, and personal data. The
Firebase values are removed; `SECRETS_SETUP.md` describes the pattern for supplying
your own.

---

## Rough shape

```
app/          Next.js UI + ~102 API routes
lib/          the working parts — dispatch, scheduling, health checks
mcp-servers/  8 MCP servers (phone, walkie-talkie, memory, …)
mobile/       Android app (Kotlin) — phone notifications in, cards out
stewards/     agent instructions; stewards/alfred is a full worked example
watchdog/     liveness monitoring
```

**If you only read one thing,** read `stewards/alfred/knowledge/rules.md`. It's the
decision-making of one agent, written down — and nearly every rule exists because
something went wrong once. That's the interesting artifact here, more than the code.

---

## License / expectations

Shared as reference. No support, no guarantee it runs anywhere but the machine it
grew on. Fork it and take the ideas.
