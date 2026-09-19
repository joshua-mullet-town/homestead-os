# HANDOFF — dispatcher: confirmed items RE-DELIVER in a loop (v2)

**Session:** holler-homestead--dispatcher-redelivery-loop-v2
**Branch:** holler-homestead--foreman--dispatcher-redelivery-loop-v2 (worktree: this dir)
**Role:** Foreman-spawned Worker. Grad route: Worker → Auditor → Foreman → Scribe.
**Cycled at:** 2026-08-03 ~14:57 ET, context pressure (~89%). Root cause FOUND + PROVEN, fix
Green-lit + SCOPE-FINALIZED by Foreman at exactly 2 files. **BOTH A files code-complete + syntax-clean.**
NOT deployed, NOT verified, instrumentation NOT stripped. OPEN QUESTION is now RESOLVED (see below).

## ONE-LINE STATE
Root cause = raw `writeFileSync(queue.json)` writers that BYPASS the dispatcher's
`mutateQueue` mutex → they race cleanQueue's atomic write → resurrect already-archived
confirmed items into the live queue → those loop/re-deliver + get re-archived. Fix A
(Green-lit) = route the IN-PROCESS raw writers through `mutateQueue`/`enqueue`.

## WHAT'S DECIDED (Foreman + Homestead — do NOT relitigate)
- Diagnosis CONFIRMED by Homestead independently (job-scheduler.js:400-425 raw bypass).
- **Fix A = NOW.** Fix B (cross-process MCP writers → POST :3005) = SEPARATE later charter. Do NOT scope-creep A into B.
- **DO NOT TOUCH:** confirm-wins guard queue-dispatcher.js:1776, the walkie_submit storm-fix, the :1514 deliverNow guard. All three correct/graduated. Hard requirement.
- **DO NOT TOUCH** cross-process MCP writers (set-timer.js, pull-next-message.js, thread.js, broadcast.js) — that's B.

## EXACT NEXT ACTION (both A fixes are DONE — you're at the LANDING phase)
1. Read `handoff/instrumentation-and-prod-state.md` FIRST (landing sequence + strip steps).
2. STRIP the `[REDELIV-TRIP]` instrumentation from the worktree `lib/queue-dispatcher.js`
   (restore clean from scratchpad backup or older commit; grep-verify 0 trip lines). Commit.
3. Walkie holler-homestead--auditor to MERGE the branch (you're blocked from merging main).
4. After merge, DEPLOY (merge restarts prod; pm2 restart if needed) + prove LOADED
   (mtime<pm2-start, on-disk==HEAD, dispatcher has 0 trip lines, both fixes present).
5. MEASURE: baseline vs after archive-forensics (handoff/proof-commands.md). rooster-watchdog-classifier
   dups → 0; total dup-archive collapses; **compute the RESIDUAL resurrection count (separate-process
   racers) — REQUIRED field in the DONE bundle** (it scopes B).
6. Walkie holler-rooster: "capture done, resume safety-net purges."
7. DONE bundle → holler-homestead--foreman (archive forensics + on-disk==HEAD + residual number).

## ✅ OPEN QUESTION — RESOLVED by Foreman (was: which files are in-process?)
Foreman corrected the scope (msg 1785783468244): **A = exactly 2 files** (job-scheduler +
presenter-queue). The trigger-*/check-* files ARE separate-process (my grep was right) → they're B
(POST to :3005), NOT mutex. Do NOT touch them this cycle. Full split in `handoff/scope-A-files.md`.

## WORK ALREADY DONE (this worktree) — BOTH A FILES CODE-COMPLETE ✅
- ✅ `lib/job-scheduler.js` — `dispatchRoosterFailureAlert` @400-425 → `mutateQueue(...)` fire-and-forget.
  Syntax-clean. COMMITTED on branch (autosave c6133a665c). DOMINANT culprit. No circular-require risk.
- ✅ `lib/presenter-queue.js` — `writeFeedbackToQueue` @899 raw write to SISWAPTS_QUEUE → `mutateQueue(...)`
  fire-and-forget (.catch→console.error). Syntax-clean. In WORKING TREE (autosave will commit it).
  Caller @748 ignores return; itemId/targetSession/messageStr preserved for the potato block.
- ⏳ REMAINING: strip instrumentation → Auditor merge → deploy → verify → bundle. That's it.

## 🔴 INSTRUMENTATION IS LIVE IN PROD — MUST STRIP BEFORE LANDING
I added `[REDELIV-TRIP]` console.logs to `lib/queue-dispatcher.js` (12 lines: deliverNow
entry+post-write, tick Phase1 reset, tick write-back guard, tick SYNC-BODY duration, cleanQueue
FIRE+ARCHIVE). Additive logging only, zero behavior change.
- RUNNING in prod: I `cp`'d the instrumented dispatcher to ~/code/homestead + `pm2 restart homestead`
  → now pid 90465, restart #68.
- **Autosave committed the instrumentation to BOTH main (commit f89efdbf65) AND this worktree branch
  (commit 0270b4d734).** Must be reverted/stripped before the clean fix lands.
- STRIP via: restore `/private/tmp/claude-501/-Users-joshuamullet--worktrees-homestead-dispatcher-redelivery-loop-v2/6a1ac77c-2488-411d-9e48-1446a562d5c9/scratchpad/queue-dispatcher.PROD-CLEAN.js`
  (my pre-instrumentation prod backup) OR `git show` an older commit. Then rebuild-if-needed + pm2 restart.
- See `handoff/instrumentation-and-prod-state.md` for full detail + the autosave hazard.

## PROOF GATE (Foreman's — empirical, NOT unit)
- Baseline: TODAY ~154-159 ids archived 2+ times in `~/.homestead/queue-archive-2026-08-03.json`; top culprit `*-job-failure-rooster-watchdog-classifier`.
- After A deploys: (a) rooster-watchdog-classifier resurrections → ZERO, (b) total dup-archive count collapses, measured live over comparable window.
- RESTART HAZARD: prove fix LOADED (mtime < pm2 process-start) + resurrections dropping live.
- Commands in `handoff/proof-commands.md`.

## COORDINATION STATE
- **Rooster (holler-rooster) PAUSED its manual queue.json drains** at my request. **YOU MUST WALKIE
  holler-rooster to RESUME** when done measuring — I never sent the all-clear.
- Foreman (holler-homestead--foreman): awaiting DONE bundle (re-verifies archive forensics + on-disk==HEAD).
  Flag Foreman when A verified → it opens the B design convo with Homestead.
- Landing: I CANNOT merge to main (blocked). holler-homestead--auditor merges → then I deploy + live-verify.
- Collision: clear. Only other Worker = worker-row-display (status-transition-tracker/presenter). Zero overlap with queue-dispatcher/job-scheduler.

## SELF-HALT GATE (already done — don't repeat)
Scratch start event already appended for session
`holler-homestead--foreman--dispatcher-redelivery-loop-v2`. (Note: tmux session name lacks the
`--foreman--` segment; `lib worker-append-scratch` REJECTS the bare name — override with
`STEWARD_SESSION=holler-homestead--foreman--dispatcher-redelivery-loop-v2 lib worker-append-scratch ...`.)

## DICTIONARY — read the archive doc matching your task
| Doc | Read when |
|-----|-----------|
| `handoff/root-cause.md` | Full proven mechanism + forensic evidence (the "why"). Mirror at scratchpad/ROOT_CAUSE.md. |
| `handoff/scope-A-files.md` | Before converting ANY file — per-file exec-context + fix pattern. |
| `handoff/instrumentation-and-prod-state.md` | Before stripping instrumentation / any pm2 restart / prod git action. |
| `handoff/proof-commands.md` | When measuring baseline/after archive forensics + dwell distribution. |

---
_(Any content below is a STALE handoff from a prior task on this reused branch — IGNORE it.)_
