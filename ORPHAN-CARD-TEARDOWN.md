# Orphan-card gate: BLOCKING → INFORMATIONAL (2026-09-18, Josh-directed)

⚠️ The changed files live OUTSIDE this repo (`~/.homestead/` is not version-controlled).
This file is the durable record; the code is live on disk fleet-wide.

## Josh's decision, verbatim
> "I think we can tear down all workers, yes. And um Yeah, I think I do want a warning of
> how many cards are outstanding before they tear down. Don't tear that yeah, before they
> tear down, yeah, don't tear that part out. Just do the other parts."

Two instructions: **KEEP the count, REMOVE the veto.**

## Why the veto was wrong (verified at source; steward-manager independently confirmed)
`lib/presenter-queue.js:761` calls `writeFeedbackToQueue(item.callback_session, ...)`
guarded only by `if (item.callback_session)` — **existence, never liveness**. And
`writeFeedbackToQueue` (:957) just writes `target_session` into the walkie queue. So a reply
to a card whose session is dead is **queued at a dead session and never read, with no error
to anyone**. An orphan card is **unanswerable**, not merely hard to find — blocking teardown
to "preserve" it preserved nothing.

Worse, it was self-defeating: because the block looked like an obstacle, workers
self-tore-down around the script, which is exactly how 35 dead cards accumulated
2026-08-12 → 2026-09-17.

## Files changed
| File | Change |
|---|---|
| `~/.homestead/lib/foreman-tools/check-orphan-cards.sh` | New `report_and_dismiss_orphan_cards()`: counts → prints every `id\|title` → dismisses → **returns 0**. Recovery ladder rewritten: **rung 1 ("keep the worker alive") RETIRED**. |
| `~/.homestead/lib/foreman-tools/teardown-substeward.sh` | Call site swapped to the report. exit-2-on-cards removed. `--acknowledge-orphan-cards` → accepted no-op. |
| `~/.homestead/lib/worker-creed/worker-shared.md` | Self-teardown path: tells workers the script **will not trap them on cards**, so there is no reason left to hand-roll. |

Backups: `*.bak-informational-2026-09-18` beside each file.

## Explicitly NOT changed
- **Unmerged-work gate still BLOCKS** (`safe_delete_branch`, ~L58-106) — verified byte-identical.
  Unmerged commits are genuinely LOST; a card is a receipt for already-approved work.
- Potato-close, leaked-dev-server reap, loaded-launchd-plist abort: untouched.
- Fail-closed on tooling error: an unreachable/unparseable queue is still fatal, so a parse
  failure can never silently report "0 cards".

## Result
- Active cards **99 → 64**. Orphans **35 → 0**. Per-steward badges now sum exactly to 64.
- Dismissed cards archived in full at `~/.homestead/orphan-cards-archived-2026-09-18.json`.
