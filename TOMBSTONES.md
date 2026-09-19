# TOMBSTONES

Decommissioned mechanisms recorded so we don't rebuild them. Each entry says
**what** it was, **why** it was removed, and an explicit **do-not-rebuild** note.

---

## /clear self-condense mechanism — removed 2026-07-07

Josh authorized removal (Homestead Top card `ef81e79ccc90`, GO 2026-07-07). This
was a family of **token-savers** that made stewards `/clear` (or nightly-compact)
themselves to shrink context. All triggers were already decommissioned from the
live scheduler; this cleanup removed the dead code, the buggy script, and the
dead creed instructions that still told stewards the mechanism was live.

**⚠️ This removal did NOT target or stop any witnessed interactive `/clear`
event.** Those are a separate investigation (injection pathways). This was
dormant-hazard cleanup of dead token-savers only. Do not frame it as a clears fix.

### What was removed

1. **Nightly compactor chain (SPEC 2 sequential + Rooster-coordinated).**
   Files removed from `lib/deprecated/`:
   - `aggressive-compactor.js` — fired the first compact-nudge at 8pm Indy.
   - `compact-nudge-builder.js` — built the nudge walkie payloads.
   - `compact-chain-advance.js` — advanced the chain one step per steward.
   - `compact-chain-state.js` — persisted the ordered-list + cursor.
   - `check-compact-chain-timeout.js` — watched for a stalled chain (every 2 min).

   These were already dead: no live code imported them, no cron/launchd fired
   them, and no `active-compact-chain.json` state existed. The scheduled job
   (`condense-and-clear`) had already been removed from `recurring-jobs.json`.

2. **`~/.claude/skills/post-handoff-clear.sh`** — the self-`/clear` script. After
   a steward wrote `HANDOFF.md`, this touched a flag, queued a self-resume walkie,
   and sent `/clear` to its own tmux session to save tokens. It carried a
   **latent prefix-match hazard** in its session→steward resolution
   (`${SESSION_NAME#holler-}` / `%%--*`). Deleted, along with its bolt-on doc
   `~/.claude/skills/handoff-extras.md` and the `## Handoff Extras` section in
   `~/.claude/CLAUDE.md` (both only existed to serve this script).

3. **Stale scheduler labels** in `app/components/stewints/SchedulerInt.tsx`
   `JOB_META`: `condense-and-clear`, `ask-auto-compact`,
   `compact-chain-timeout-check`. These were display-only strings with no matching
   live job in `recurring-jobs.json` (orphaned labels).

4. **Dead creed blocks** — the `## Compact/Clear Etiquette` section (and its
   nested `### Compact-chain handshake` subsection) across ~33 steward creed
   files (`CLAUDE.md` + Library templates + `steward-manager` create-* skills),
   fleet-wide across all Steadings. Each told stewards to respond to
   `nightly-compact-nudge` / `josh-direct-compact-nudge` and to run
   `post-handoff-clear.sh`. The `steward-manager` create-steward / create-steading
   skills additionally **propagated** this block into every newly-created steward —
   that propagation was neutralized so new stewards no longer inherit it. Each
   stripped block was replaced with an inline tombstone comment.

   Two **non-live** files also carried the dead block with dangling references to
   the deleted `post-handoff-clear.sh` and were tombstoned for completeness (they
   are NOT live creeds — the live `homestead/CLAUDE.md` and `rooster/CLAUDE.md`
   were already migrated to sleep-and-wake):
   - `~/.homestead/stewards/homestead/CLAUDE.pre-steading.md` — a pre-migration
     archive snapshot.
   - `~/.homestead/stewards/rooster/PROPOSED_LEAN_CLAUDE.md` — a never-adopted
     lean-creed draft.

### What was KEPT (do not confuse with the above)

The **sleep-and-wake** mechanism is the surviving lean-context path and does NOT
`/clear`:
- `lib/check-idle-stewards.js` — idle detector (4hr threshold).
- `~/.claude/skills/handoff.md` — the handoff-writing skill.
- Flow: steward goes idle → writes `HANDOFF.md` → its Claude PID is killed
  (tmux session stays alive) → on the next walkie, the dispatcher fresh-spawns
  Claude and its first action is reading `HANDOFF.md`.

Both were verified to contain zero `/clear`, `post-handoff`, or `condense`
references. The `last-was-clear.flag` handling that remains in
`lib/queue-dispatcher.js` is vestigial (per `lib/job-scheduler.js` — the flag is
no longer read for branching) and harmless; it also serves the wake path, so it
was left in place.

### DO NOT REBUILD

Do not re-introduce a self-`/clear` flow, a nightly compact-nudge chain, or a
`post-handoff-clear.sh`-style script. If context-size management is needed, use
sleep-and-wake. Reviving the compact chain is explicitly forbidden — see also
Rooster's `domain.decommissioned_do_not_revive`.
