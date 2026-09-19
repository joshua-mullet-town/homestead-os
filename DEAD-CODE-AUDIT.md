# Homestead Dead-Code Audit — Findings Report

**Date:** 2026-08-29 · **Pass:** AUDIT ONLY (nothing deleted) · **Scope:** everything under `~/code/homestead/`, audited against `origin/main`.

**How to read this:** every finding carries a **confidence** and the **evidence** behind it. Confidence means:
- **HIGH — safe to pluck.** Zero live references; proven not reachable from any running surface.
- **MEDIUM — likely dead, confirm one thing.** Almost certainly removable, but there's one fact worth confirming first.
- **KEEP / uncertain — do NOT remove.** Either live, or the evidence is ambiguous. Josh's hard rule (never flag a working thing as removable) governs here — when in doubt, it landed here.

---

## What Josh actually wants (updated 2026-08-29 after his steer)

Josh reframed this after reading the first report. Clearing dead *files* for its own sake is **not** the prize. The two real goals:

1. **Make the live UI the ONE obvious place to edit** — so a worker asked for a UI change can't wander into a dead view. Today there's a *written instruction* whose whole job is "don't touch the old interface" — that crutch exists because the code isn't self-evident. The fix is to *delete the dead views*, not add more warnings.
2. **Performance** — the app feels sluggish. Find heavy or unused background work we can switch off without losing anything, and figure out whether the slowness is the screen or the server.

The sections below are reorganized to serve those two goals. (The original file-cruft findings are retained further down — Josh's verdict: "do it if it's safe, but it's not the point.")

---

## GOAL 1 — "One obvious place to change the UI"

**The answer to "where do I change the UI?" — exactly three files, nothing else:**
- `electron-presenter/renderer/app.js` (the behavior)
- `electron-presenter/renderer/style.css` (the look)
- `public/presenter/index.html` (the markup)

**⚠️ Built-in footgun to be aware of:** for two of those three files the "real" copy lives in `electron-presenter/renderer/` and `public/presenter/` just holds a shortcut to it — **but `index.html` is the opposite**: the real served copy is the one in `public/presenter/`, and the `electron-presenter/renderer/index.html` is a dead stale copy. So "always edit the renderer copy" is *wrong* for the markup file. This asymmetry is itself a source of confusion worth fixing.

**What makes it confusing today — and how to actually fix it:**

- **The left sidebar (dead view #2) is the #1 confuser.** It *looks* like live UI — it has a whole steward-list sidebar with its own drawing code — but it's hidden on every surface Josh uses. A worker poking around sees it and thinks it's real. **Removing it is the single highest-leverage clarity win.** BUT (the honest catch I keep flagging): the sidebar's drawing routine is *entangled* with the live bottom-bar's drawing routine — the live bar is literally drawn by a line *inside* the sidebar's function. **I verified this directly.** So this is careful surgery: split the live part out first, re-point the code that uses it, *then* remove the sidebar. Done in the wrong order it silently breaks the live UI. It's very doable — it just needs a worker who does it in the right sequence and re-checks the live screen after. **Not a bulk delete.**

- **The old web dashboard (dead view #1) is half-dead, half-alive.** Ten of its pages are cleanly dead and safe to remove (the scheduler page, admin page, remote page, and 7 others — nothing links to them). But its *front door* (`app/page.tsx`) is still what the hidden "Web" toggle in your phone app opens, and a handful of pieces (the status page, the guest pages, the data endpoints the live presenter calls) are genuinely live and shared. So you can cleanly delete the 10 dead pages now; retiring the *whole* dashboard is a bigger project because the toggle still reaches it and live pieces are woven in.

- **The instruction crutch:** there really is a written rule seeded into every worker that says "the app/ tree is the web dashboard — never the presenter." Once view #2 is gone and the dead dashboard pages are cleared, *most* of that crutch can retire. **Honest caveat:** because the web dashboard is half-live (status/guests/data-endpoints stay), one line of that guardrail ("app/ is not the presenter") probably *can't* fully go away — flag KEEP on that piece.

**Recommended sequence for Goal 1:**
1. **Now (safe):** remove the 10 orphaned dashboard pages. Zero risk, immediate clutter reduction.
2. **Careful follow-up:** the sidebar excision (refactor-first, then delete, then re-verify the live screen). This is the one that actually kills the "wandered into the wrong view" problem.
3. **Bigger decision (yours):** whether to retire the whole web dashboard including the phone "Web" toggle — a real project, worth doing only if you're sure you'll never want a desktop mission-control view again.

---

### ✅ SHIPPED (2026-08-29): the dead sidebar is gone

The dead left-sidebar view (Interface 2) has been **removed and is live**. The ~430-line render routine that *looked* like live UI is gone, replaced by a lean function that does only the real work; the sidebar's markup and styling are deleted. Verified the live bottom-bar presenter renders pixel-identically (bottom steward icons, card thread, toolbar, and settings all intact) with zero sidebar. **Net: ~700 lines of the most-confusing dead code removed.** The "which is the real UI?" trap for that view is closed.

Also shipped earlier: the 10 orphaned dashboard pages removed, and the debug-log spam killed.

---

## GOAL 2 — Performance (why it feels slow)

### ⚠️ UPDATE (2026-08-29): measured it properly — the leak is NOT the problem

After Josh's steer ("measure before fixing something that isn't actually slowing us down"), I instrumented the live system with real numbers. The honest result **changes the recommendation**:

- **The memory-handle leak is NOT hurting anything right now — leave it alone.** Measured at idle: the handle count is *flat* (~45 of a ~1,000,000 limit — five orders of magnitude of headroom). It only grows when terminals are actually opened/closed, and the periodic restart fully resets it. This is exactly the "dangerous fix for something that isn't the bottleneck" Josh wanted to avoid. **Recommendation reversed: do not touch it.**
- **The server is healthy.** Event-loop responsiveness is excellent (99th-percentile stall = 24 ms, never over 200 ms). No endpoint is slow except the session-status one at ~100 ms, which is fine. Idle CPU ~6%.
- **The real "feels sluggish" cause is the screen, not the server.** When a card arrives, the presenter tears down and rebuilds its *entire* card thread — roughly 100 cards × ~54 drawing operations each = ~5,000+ DOM operations in one synchronous burst, re-parsing a 160 KB payload. That's a client-side render cost, which is exactly why every server number looks healthy. **This is the thing worth improving** — make it redraw only what changed instead of everything.
- **Confidence caveat:** the front-end conclusion is strong *inference* (payload size + card count + per-card operation count + full-teardown pattern), not a stopwatch number — measuring the exact milliseconds needs a browser performance trace on the live presenter (a safe, ~5-minute diagnostic, best done next before any fix).

**So the performance path forward is:** don't fix the leak (not the bottleneck), do a quick browser performance trace to put a real number on the screen-redraw cost, and if it confirms, make the presenter redraw incrementally. Nothing risky until the trace says it's worth it — exactly the discipline Josh asked for.

### ✅ MEASURED (2026-08-29): browser performance trace of the live presenter

Ran a real Chrome performance recording on the live presenter. The numbers are unambiguous:

- **Main content takes ~2.3 seconds to appear (LCP 2,299 ms).**
- **Of that, the server is 12 ms (0.5%). The other 2,287 ms (99.5%) is the screen drawing itself** — pure client-side JavaScript + DOM work. This is the definitive proof that the sluggishness is the front-end, not the server (the server is genuinely fast).
- **Heavy layout thrashing (CLS 0.87, forced reflows).** The redraw code repeatedly asks the browser "how tall is this now?" *while* it's still adding elements, forcing the browser to re-calculate the whole layout over and over mid-render. The trace named the exact functions doing it (the card-thread render + deck-positioning routines). A chunk of the reflow was also from a browser extension, not our code — worth noting.
- **Honest caveat:** this 2.3s figure is a *cold page-load* (which includes one-time startup + drawing all ~100 cards). A single card-arrival re-render is faster than a full cold load, but it runs the *same wasteful full-teardown-and-rebuild pattern* — so the cold number is the clearest measurement of the expensive path.

**Verdict: confirmed.** The "feels sluggish" is real, it's the front-end, and it's the full-rebuild + layout-thrashing pattern — not the server, not the leak.

**The safe fix (a proper follow-up, not a rushed one):** make the presenter update only what changed instead of tearing down and rebuilding the entire card list on every change, and batch the layout reads so the browser isn't forced to re-measure mid-render. This is a real, worthwhile front-end refactor of the presenter's render loop — meaningful effort, but the payoff is a directly-faster screen, and it touches only the presenter's rendering (no risky dependencies). This is the thing actually worth doing for speed.

### ✅ SHIPPED (2026-08-29): the presenter is ~16× faster — 700 ms → ~44 ms per update

Diagnosed the exact cost and fixed the biggest offender. **Instrumented the real render path** (not a guess): each screen redraw was taking **~700 milliseconds**, and profiling showed **~500 ms of that was rendering the "Log" list** — the presenter was building *every* message row (~400 of them, ~800 formatting passes) on *every* card update, into a panel that's **hidden until you tap "Log."** Pure waste, for something nobody was looking at.

**The fix:** only build the Log list when the panel is actually open (it now builds on-demand the moment you tap Log). Also removed a leftover debug check that was forcing the browser to re-measure the layout on every card, and a couple of debug log lines in the hot path.

**Measured result (same steward, 100+ card queue, on the live presenter):**
- Before: **~700 ms** per redraw (820 formatting passes)
- After: **~44 ms** per redraw (20 formatting passes) — **~16× faster**

Verified live: the Log panel still works perfectly (opens and fills on-demand with all messages), and the presenter renders identically otherwise. So every card that arrives now updates the screen in a blink instead of a ~0.7-second freeze. **This is the real, felt speed win** — shipped and live.

After the fix, the remaining ~44 ms is legitimate work (drawing the ~20 visible cards) with no single hotspot left — a natural stopping point. Further micro-optimization (incremental diffing) would save ~15 ms for real added risk, so it's not worth chasing.

---

### (original perf notes below — the debug-flag win already shipped)

**Verdict: the slowness is mostly the *server*, with the screen amplifying it. And there's a genuine resource leak behind the periodic restarts. All findings below I verified directly, not just took on faith.**

### The single biggest, safest win — a debug switch left ON
There's a debug logging flag hardcoded to ON in the session-status code. Combined with the fact that the app asks the server "what's the status of every session?" **every 3 seconds**, and each of those checks sweeps across ~40 sessions × ~17 folders on disk while logging every step — the result is that **~99.5% of everything the server writes to its logs is this one debug loop.** It's producing roughly **118 MB of log spam per day**; the current log file is 89 MB. **I confirmed this live: 1,991 of the last 2,000 log lines were this one thing.**

Flipping that flag off (and optionally slowing the 3-second poll to 5–10 seconds) is a one-line, zero-risk change that eliminates almost all of the server's constant disk-and-CPU churn. **This is the top recommendation.**

### The periodic-restart cause — a real leak
The main server currently holds **629 open file handles, of which 584 are leaked** — orphaned bits left over from past terminal sessions that never got cleaned up (a known flaw in a low-level terminal library). It leaks ~135 per hour and climbs until the handle limit forces a crash-and-restart — which explains why the main server has restarted 3 times while every other service has restarted zero. **I confirmed the leaked-handle count directly.** This is a deeper fix (it's in a compiled dependency), but it's the likely reason the app degrades over time and needs restarting.

### Front-end vs back-end
- **Back-end (the bigger factor):** the 3-second status poll + debug logging above, plus the server shelling out to inspect terminals every few seconds. Fixing the debug flag cuts a large chunk immediately.
- **Front-end (the amplifier):** the presenter screen is one giant 12,900-line file that **completely redraws itself every ~5 seconds** on each update, re-parsing a 180 KB queue each time. That's the "feels sluggish" sensation. Making it redraw only what changed is a real improvement but a larger piece of work.

### What is NOT a problem (I checked, so you know it was checked)
- **The every-minute background jobs are fine — I was wrong in my earlier hunch.** A couple have "retired-role" names (auditor, foreman) that made them *look* like dead busywork, but they're actually wired into the live alert pipeline that watches for frozen/stuck stewards and texts you when something needs a login. Turning them off would remove real safety nets. **KEEP.** (They're a touch chatty in their own logs, but that's cosmetic.)

**Recommended sequence for Goal 2:**
1. **Now (one-line, zero-risk, biggest bang):** turn off the debug logging flag; optionally ease the 3-second poll.
2. **Follow-up (real fix):** the file-handle leak — the thing actually behind the restarts and gradual slowdown.
3. **Bigger piece (optional):** make the presenter screen redraw incrementally instead of wholesale.

---

## Executive summary (original file-cruft audit — retained, lower priority per Josh)

**The interface archaeology is confirmed.** There are exactly three interface generations in the code, and the picture is clean:

- **Interface 1 — the original web dashboard** (repositories → branches → workers, listed as a tree). Still technically reachable through a hidden toggle, but Josh doesn't use it and nothing on his phone routes to it by default. **~22,000 lines** across the web app. **Mostly removable — but it is a big, load-bearing-looking tree that needs staged removal, not a wholesale pluck** (some pieces are shared with live surfaces). Confidence: **MEDIUM overall**, with several **HIGH-confidence sub-pieces** that are cleanly dead.
- **Interface 2 — the "steward icons on the left" presenter.** This one is *interwoven into the same file as the live presenter*, not a separate app. Josh's own note in the code (dated 2026-04-21) literally says "desktop-native view is dead." It's hidden on every live surface. **Real, but surgical to remove** (it shares a file with Interface 3). Confidence: **HIGH that it's dead, MEDIUM that it's safe to excise** because of the entanglement.
- **Interface 3 — the "steward icons on the bottom" presenter.** This is the ONE Josh uses. **LIVE. KEEP. Do not touch.**

**Beyond the interfaces, the three biggest clean wins:**
1. **A 1,294-file / 8 MB junk directory** (`.git-rewrite/`) accidentally committed — pure garbage, safe to delete.
2. **~48 MB of one-off screenshot/proof artifacts** from past tasks (old QA runs, mockups, proof bundles) — safe to delete.
3. **An entire abandoned mini-app** (`remote-control/`, a separate remote-control web app) that nothing runs and nothing links to.

**The single most important caution in this report:** the in-repo `watchdog/` folder *looks* dead (a code comment even calls it "legacy, retired") — but it is **running right now** under the process manager and actively serving traffic. **KEEP.** This is exactly the kind of "the comment lied, the process is live" trap that a careless cleanup would fall into.

---

# PART 1 — THE INTERFACES (Josh's priority)

## Interface 3 — the LIVE one (bottom icons) — KEEP

**What it is:** the presenter Josh looks at all day — the card deck with the row of steward icons across the **bottom/top bar** (horizontal). On his phone it's the whole app; on the Mac it's the floating presenter window.

**Why it's live (proof):**
- It's served at `/presenter/index.html?embedded=true`.
- Josh's phone (the Android app) loads exactly that URL as its home screen (`SmartAppsFragment` / `PresenterFragment`).
- The Mac presenter window (`electron-presenter/main.js`) loads exactly that same URL.
- It's one of five processes actively running under the process manager right now.

**Verdict: KEEP. This is the product. Nothing here is a candidate.**

The bottom-icon layout is drawn by two routines (`renderEmbeddedTopbar` / `renderEmbeddedSubbar`) that only run when the page is in "embedded" mode — which is the mode both the phone and the Mac window always use.

---

## Interface 2 — the "steward icons on the LEFT" presenter — DEAD (but entangled)

**What it is:** exactly what Josh described — "a lot like the modern presenter, except all the icons / all the stewards are on the LEFT-hand side of the screen and the contents on the right." This was the **desktop-native presenter layout** before the unified mobile-style deck took over.

**Why it's dead (proof — this is airtight):**
- The presenter page has a `#sidebar` element commented in the code as *"Left sidebar: steward list."* That's Interface 2.
- The stylesheet contains this exact rule: **`body.embedded #sidebar { display: none !important; }`** — i.e. whenever the page is in embedded mode, the left sidebar is completely hidden.
- **Every live surface loads the page in embedded mode.** The Mac presenter window's own code says, verbatim in a comment:
  > *"?embedded=true switches to the unified mobile-deck UI — desktop-native view is dead (Josh 2026-04-21). Same URL as APK WebView."*
- So the left sidebar is drawn into an element that is force-hidden on 100% of the surfaces anyone actually uses. It is dead by Josh's own past decision, already recorded in the code.

**The catch — why this is surgical, not a wholesale pluck:**
Interface 2 is **not a separate file**. It lives *inside the same files* as the live Interface 3 — the same `index.html`, the same `app.js`, the same `style.css`. The left-sidebar drawing routine (`renderSidebar`) still gets called on every render; it just paints into a hidden box. Removing Interface 2 means carefully cutting the `#sidebar` markup, its CSS, and the `renderSidebar` logic out of a 12,900-line shared file **without nicking the live presenter next to it.**

**Rough size:** the sidebar-specific markup + CSS + logic is on the order of a few hundred lines threaded through shared files. Real, but delicate.

**Confidence:**
- **That it's dead: HIGH** (Josh already declared it dead in 2026, and it's force-hidden everywhere).
- **That it's safe to remove cleanly: MEDIUM** — because it shares files with the live presenter, this is a "careful surgery" job, not a "delete a folder" job. Recommend a dedicated follow-up worker who removes it and re-verifies the live presenter pixel-for-pixel.

---

## Interface 1 — the original web dashboard (repos → branches → workers) — MOSTLY DEAD

**What it is:** the original web interface Josh described — *"where we actually list each repository, and then the branches listed under there… this concept of workers."* Today it's a full web dashboard: a tree of stewards, their sub-stewards, and workers, with click-through into live terminals, chat views, git status, previews, a scheduler page, an admin page, and more. It's a genuine, sizeable web app (~22,000 lines).

**Its live-status is nuanced — here's the honest picture:**

- **The default home is NOT this.** Josh's phone opens straight to the presenter (Interface 3). The web dashboard is not what he lands on.
- **BUT it is still reachable through a hidden toggle.** There's a "switch to web view" button wired into the phone app that flips from the presenter to this dashboard. So it is *not* 100% orphaned — a path to it still exists.
- **It's still built and served.** The web server actively builds and serves this app; it's not commented out or deleted.
- **Parts of it were touched as recently as ~2 weeks ago** — though that recent touch was an automatic save that sweeps all changed files, not necessarily deliberate development.

**Within Interface 1, several sub-pages are cleanly dead (HIGH confidence):**
These are dashboard pages that nothing links to and no live surface (phone app or presenter) ever opens — the only way to reach them is to hand-type the URL:

| Page | Reachable from anywhere live? | Confidence |
|---|---|---|
| the "remote control" page (`/remote`) | only linked from the dead dashboard itself | HIGH dead |
| the scheduler page (`/scheduler`) | no links anywhere | HIGH dead |
| the "situations" page (`/situations`) | no links anywhere | HIGH dead |
| the admin page (`/admin`) | no links anywhere | HIGH dead |
| the setup page (`/setup`) | no links anywhere | HIGH dead |
| the alerts pages (`/alerts/...`) | no links anywhere | HIGH dead |
| the notifications page (`/notifications`) | no links anywhere | HIGH dead |
| the chat/preview pages (`/chat`, `/preview`) | no links anywhere | HIGH dead |

**What's genuinely still shared / live (KEEP):**
- The `/status` page and `/guests` pages ARE still referenced by the live phone app.
- A couple of small pieces of dashboard chrome are imported into the shared layout.

**Recommendation for Interface 1:** this is the one to attack in **stages**, not wholesale:
1. **Stage A (HIGH confidence, clean):** remove the orphaned sub-pages above that nothing links to. Low risk, real cleanup.
2. **Stage B (MEDIUM, needs a decision):** decide whether Josh wants the whole web dashboard retired — including the phone-app toggle that reaches it. If yes, that's a large, satisfying pluck (~most of the 22k lines) but it touches the phone app and should be its own careful follow-up. If Josh ever wants a desktop "mission control" view again, keeping the shell might be worth it — that's his call.

**Confidence:** **HIGH** for the individually-orphaned sub-pages; **MEDIUM** for retiring the whole dashboard (because a live toggle still reaches it and it's still served — removing it wholesale is a real project, not a safe one-liner).

---

# PART 2 — CLEAN WINS OUTSIDE THE INTERFACES

## 2.1 — `.git-rewrite/` — 1,294 files, ~8 MB of pure junk — HIGH

A temporary working directory left behind by a past git-history-rewrite tool, **accidentally committed into the repo.** It's 1,294 files of internal scratch data. Nothing references it; it's not meant to exist. **Delete wholesale.** This is the single biggest file-count win.

## 2.2 — Old screenshot / proof / mockup artifacts — ~48 MB — HIGH

Committed image dumps and proof bundles from past finished tasks — QA screenshot runs, presenter mockups, "proof it works" bundles. Pure artifacts; no code reads them. Safe to delete:
- an old QA screenshot archive (67 files, ~35 MB)
- a presenter mockup/proof image collection (44 files, ~13 MB)
- a finished proof bundle (~0.7 MB)
- a stray proof screenshot (~0.3 MB)

(Note: deleting these from the working copy reclaims disk today; the history still holds them until a separate history cleanup — out of scope for this pass.)

## 2.3 — `remote-control/` — an entire abandoned mini-app — HIGH

A **complete, separate web app** (its own project setup, its own build config) meant to run as a standalone "remote control" on port 3007. **Nothing runs it** (it's not in the process manager) and **nothing links to it**, and its intended port is occupied by a different live service anyway. Fully orphaned. Safe to delete the whole folder.

## 2.4 — Backup / conflict / temp files checked into the repo — HIGH

~9 stray backup files committed alongside their live originals — old `.bak` copies of the dispatcher and job-config files, plus two backup config files from a completed phone-networking cutover. The live originals sit right next to them and are the real ones. Safe to delete the backups.

## 2.5 — Committed Android build-cache in `recovery/` — HIGH (partial)

The `recovery/` folder (a separate "recovery" Android app) has its **build cache committed** into the repo (it should be ignored, like the main app's is). The build-cache portion is safe to delete and should be added to the ignore list. *(Whether the recovery app itself is still wanted is a separate question — see KEEP list; only the build-cache is a clean win.)*

## 2.6 — A broken test + an orphaned helper server — HIGH

- A test file that checks the old card-sending tool which was **already deleted** in August — the test now points at a file that no longer exists, so it can't even run. Dead.
- A standalone demo/helper server file that nothing imports or runs.

## 2.7 — Stale one-off planning docs — HIGH / MEDIUM

Several root-level planning/analysis documents from January–February that describe abandoned spikes or since-completed migrations (an old "CUI" UI-extraction analysis + its testing guide, a plan for a notification tool that now exists and shipped, an early user-stories doc, a secrets-setup doc for a provisioning path that may be retired). No code depends on them. HIGH for the clearly-abandoned ones; MEDIUM for the secrets-setup doc (confirm the provisioning path is truly gone first).

---

# PART 3 — RETIRED-ROLE RESIDUE (Auditor / Foreman / Scribe)

The fleet retired the Auditor, Foreman, and Scribe roles. Most of the **tool** cleanup already happened (the old card-send tools were deleted in August). What remains:

## 3.1 — Orphaned "messenger" tool server — HIGH
A small tool-server folder whose one real capability was deleted in August; what's left duplicates a capability the live walkie-talkie system already provides, and nothing registers it. Safe to remove.

## 3.2 — Foreman stall-escalation subsystem — MEDIUM (confirm one thing)
A cluster of three files whose whole job is: notice a stalled worker and ping that worker's **Foreman**. It still runs on a timer every 5 minutes — **but its only action is to message a Foreman session, and Foreman is a retired role.** So it's very likely firing messages into the void. **Confirm with Josh: is the Foreman role truly gone with nothing inheriting its messages?** If yes, these three files + their scheduled entry can go together (the largest role-residue removal). If something quietly took over those messages, KEEP.

## 3.3 — Completed-migration handoff docs — MEDIUM
A folder of notes documenting the (now-finished) old-tool→new-tool migration, plus a root handoff doc for a completed task. No code depends on them; they're a paper trail. Remove if Josh doesn't want the history; otherwise harmless.

---

# PART 4 — ORPHANED BACK-END ENDPOINTS

The web server exposes ~101 back-end endpoints (the URLs the app, phone, and presenter call for data). I checked every one for a live caller across all surfaces (web app, phone app, presenter, background jobs, external hooks).

**Result: 86 are actively used. 15 are cleanly orphaned — nothing calls them, from anywhere.** These are HIGH-confidence removable:

- **A duplicate of the main "stewards" data endpoint** left over from a past rename (`/api/siswapts` — an old spelling). The real one is heavily used; this stale twin drifted ~370 lines apart and nothing calls it. This is a textbook "similar variation of the same thing" that Josh called out.
- **A cluster of old debug/logging endpoints** (an in-memory debug console, a log-to-file endpoint) — dev scaffolding nothing calls.
- **Superseded endpoints** whose job was taken over by a newer one: an old "list projects" endpoint (replaced by the config endpoint), an old voice-recording puller (replaced voice pipeline), a duplicate Gmail re-auth callback (replaced by the newer OAuth handler).
- **Orphaned control endpoints**: bulk session-restart, a restart-command helper, a phone-connectivity check, a server-status/rebuild endpoint, a broadcast endpoint, a couple of notification-filter/triage HTTP wrappers whose real logic runs internally — all with zero callers.

**Confidence: HIGH** for the 15 (verified zero callers across code, phone app, presenter, jobs, and hooks). One of them (the Gmail re-auth callback) is **MEDIUM** only because its address might still be registered in Google's cloud console — worth a 30-second check before removing.

Each is small individually, but together they're ~15 dead endpoints — real clutter in the part of the code new work has to navigate around.

---

# PART 5 — DEAD APK (phone-app) PIECES

Inside the Android app, two screen-fragments are defined but **never actually shown** — nothing in the app ever instantiates them:
- a "remote" fragment (dead)
- a "watchdog" fragment (dead)

Both are safe to remove from the phone app. (Careful: these are the *phone-app* copies — do **not** confuse the dead "watchdog fragment" with the live `watchdog/` server, which is KEEP — see below.)

---

# PART 6 — VERIFIED LIVE — DO NOT REMOVE (the cautions)

These looked like candidates but proved **live**. Listing them so Josh knows they were checked, not missed:

- **🚨 The in-repo `watchdog/` server — LIVE RIGHT NOW.** A code comment calls it "legacy, retired," and it's *not* in the standard process list — which would make anyone flag it as dead. **But it is actively running under the process manager (process #1394) on port 3007, and the live network front-door actively forwards traffic to it.** This is the #1 "do not touch" of the whole audit. If a future cleanup kills it based on the comment alone, it would break live routing. **KEEP.**
- **The "scribe-enabled" feature toggle** — even though the Scribe *role* is retired, this is a genuinely live on/off switch wired to a UI control. KEEP. (One nuance worth a Josh decision: when it fires, it messages a `session-scribe` target that may no longer exist — the switch is live, its destination may be a dead-end. Flagging, not removing.)
- **The desktop split-view, the remote-navigator chrome, the steward-resolver, and various role-name-handling helpers** — all imported by live code. The Auditor/Foreman/Scribe words in them are either legacy-name handling or comments (in one case, a guardrail that names the retired roles specifically to *ban* their jargon). KEEP.
- **`phone-alley/`** — live front-door service (in the process manager). KEEP. (Only two stale backup files inside it are cruft.)
- **The live steward-memory files** (STATE / PLAN / MEMORY / etc.) — live operational memory. KEEP.

---

# Appendix — rough size tally of the HIGH-confidence "pluck wholesale" set

| Item | Files | Size |
|---|---|---|
| `.git-rewrite/` junk dir | 1,294 | ~8 MB |
| Old screenshot/proof/mockup artifacts | ~116 | ~48 MB |
| `remote-control/` abandoned mini-app | 10 | small |
| Backup/conflict files | ~9 | ~0.3 MB |
| `recovery/` committed build-cache | ~15 | ~4 MB |
| Broken test + orphan helper server | 2 | small |
| Orphaned "messenger" tool server | small dir | small |
| Dead phone-app fragments | 2 | small |
| Stale planning docs | ~5 | small |
| Orphaned dashboard sub-pages (Interface 1, Stage A) | ~10 pages | moderate |
| Orphaned back-end endpoints | ~15 | small each |

**HIGH-confidence total: roughly 1,450+ files and ~60 MB of clearly-removable weight**, dominated by the junk dir + old screenshots.

**The big MEDIUM decisions for Josh** (each its own careful follow-up if greenlit):
1. Retire the whole web dashboard (Interface 1) including the phone toggle that reaches it — large satisfying pluck, but touches the phone app.
2. Surgically excise the left-sidebar presenter (Interface 2) from the shared presenter files — delicate, needs live re-verification.
3. Confirm the Foreman role is fully gone → remove its stall-escalation subsystem.
