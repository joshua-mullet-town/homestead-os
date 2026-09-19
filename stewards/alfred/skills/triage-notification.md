# triage-notification — How I Process Every Incoming Notification

My core job. **Read this when triaging.** The auto-skip/auto-action *rules* live in `knowledge/rules.md` (the single rulebook); this file is the *procedure* — how to identify a sender, spot a duplicate, and decide whether Josh ever hears about it.

---

## 0. First, always: roger that, then drain the queue

1. **Roger immediately** — run the `_confirm` command before anything else. Under 30s or the dispatcher retries and Josh gets duplicates.
2. **Then check what else is queued** before composing a response. Josh, 2026-08-17: *"you take the one in and start formulating a response"* while messages #2 and #3 sit unread behind it. Later messages routinely supersede, correct, or complete earlier ones. **Respond once, to the complete state.**

---

## 1. Is this actually a new message? (the duplicate family)

Four distinct shapes. Getting these wrong means either double-carding Josh or silently dropping something real.

| Shape | Tell | Handling |
|---|---|---|
| **Byte-identical repeat** | Same text **and** same `key`; only `timestamp` moves | Phone re-notifying an **unread** message. **Inherits the original's decision.** If the original was carded, **the decision stands — do NOT card again.** |
| **Group-summary wrapper** | `title` and `text` both null, key ends `::msg<TS>` | Android's grouping envelope. Match `<TS>` against items just triaged (same-cycle, typically <30ms) → inherits their verdict. Reconcile against the live tray only if it matches nothing recent. |
| **Slack/Android pair** | Same text ~ms apart, **different ids**, `isGroupSummary` flips False→True | One real post + its group summary. Triage once. |
| **Gmail UID artifact** | Same notification id, same `subText`, keys differ only in the **trailing** segment (`\|10201` vs `\|10217`) | One email, two account registrations. |

⚠️ **Discriminate Gmail duplicates by `subText` (the inbox) FIRST.** Same subText + same id + same timestamp = the UID artifact. **Different subText = a REAL separate send** to his other address — vendors mail both <<REPLACE: your email>> and <<REPLACE: your secondary email>>. The question is never "have I seen this subject?" but **"is this the same SEND to the same INBOX?"**

⚠️ **A third shape exists for email:** a `source: gmail` item from the 5-min backstop cron carries a Gmail message id + `from`/`subject`/`snippet` instead of an Android key. Match it by **sender + subject + send time**, not by key.

⚠️ **Escalating re-notify intervals are not a signal.** Android nags harder on unread items. And per the 2026-09-11 correction: **card state cannot distinguish "unseen" from "seen and handled"** — every card can show unresolved even after Josh acts on it. Never build a nudge decision on an absence of response.

---

## 2. Who sent it? (identity — where I have historically erred)

🚨 **The notification title's sender-label is NOT ground truth.** On 2026-07-18 a title read `"Mother, <<REPLACE: a contact alias>>: Mother"` and the sender was actually **<<REPLACE: a family contact>>**. I told Josh his mom texted. He was angry.

**The procedure:**
1. **Bare number?** → `mcp__phone__get_contacts` with the digits. Matches on last-10 normalization.
2. **Specific saved alias** (e.g. "<<REPLACE: a contact alias>>", "<<REPLACE: a family contact>> Mullet") that resolves 1:1 → **state the name plainly. Do not hedge.** Josh, 2026-07-21: hedging "<<REPLACE: a household member>> or <<REPLACE: a family contact>>" when the label mapped cleanly is its own failure.
3. **Generic relationship word** ("Mother") or an unmappable label → **verify or surface raw.** Never infer.
4. **Identify the speaker from CONTENT** when labels conflict — voice, subject matter, who would plausibly say it.

⭐ **THE BINARY (Josh, firm):** either **(A)** I know who it is and say so confidently, or **(B)** I genuinely lack the data and say *that* plainly. **The forbidden third option is the waffle.** If I hit (B), go get the information first — read the thread, reverse-lookup the number — and only then report that I can't tell.

### ⚠️ `thread_key` identifies the CONVERSATION, never the SPEAKER
Two threads can carry near-identical titles (`<thread-key-a>` vs `<thread-key-b>`). Both are *group* threads containing the same people. I briefly recorded one as "the thread where <<REPLACE: a household member>> talks" — **wrong within the hour**, when <<REPLACE: a family contact>> spoke in it. Use `thread_key` to tell conversations apart; use content to tell people apart.

### Contacts are the canonical identity store
`mcp__phone__get_contacts` to read, `mcp__phone__set_contact_notes` to write. **When I learn a durable fact about someone, write it to their contact** — and write a **TRIAGE line** into the notes saying how their messages should be handled. That way identity *and* handling come back together in one lookup. (This paid off repeatedly on 2026-09-11: a contact, another contact, <<REPLACE: a contact>>.)

⚠️ Separate **established fact** from **inference** in contact notes, explicitly. I labelled <<REPLACE: a contact>> "(his child's daycare)" from context — the note says so, and says not to state it as verified.

---

## 3. Does it need Josh at all?

Run these in order:

**a) Does an owning steward exist?** If yes → **relay and step back.** That is the *whole* action. Do not investigate it yourself, do not card Josh about the forward. a business partner → `holler-big-jims-plates`. Check `knowledge/routing-table.json`; the pipeline pre-tags with `suggested_steward`.

**b) Is it on the auto-skip list?** → `knowledge/rules.md`. Drop silently.

**c) Is there an actual ask?** No question, no deadline, no decision = drop. *"No call to action = skip."*

**d) ⭐ Do I hold information Josh doesn't?** **This is the sharpest test.**
- **Card** when the answer requires something he can't see — a calendar check, a conflict, a fact in my files.
- **Stay out** when he holds the answer himself — his own preferences, his own plans, his own relationships.

> Worked example (2026-09-11 birthday negotiation): I carded **once**, when his mom asked what day works — that needed his calendar. I dropped every other turn — food, arrival time, guest list — because those he answers off the top of his head. Same conversation, opposite verdicts, correct both times.

**e) Is he already handling it?** If the thread shows him replying, **stay out.** His outgoing RCS is invisible to me, so a reply *to him* is proof he answered. Carding into a live conversation is narrating his own life back at him.

**f) Would he LOSE anything without a card?** If no → drop.

---

## 4. If I do card

- Read `~/.claude/skills/cards-to-joshua.md` before the first card of a session.
- **Stamp `reminder_ack.timestamp` = now on the FIRST send.** Hitting the gate causes a double-tap, which reads as spam.
- Lead with the conclusion. No file paths, no jargon — he is in CEO mode and on his phone.
- **Do the useful thing first, then report it as done.** Saving <<REPLACE: a contact>>'s number before carding turned "here's a thing" into "✓ already handled."
- **Name the boundary I drew** and give a one-tap override. He used one within 12 minutes on 2026-09-11.
- **Status honestly:** `blocked` only when *my* work is stopped. `weigh_in` when he'd want to steer. `fyi` when reporting.

### ⛔ Do not send
- A **correction card** that changes nothing he must DO — that's a status update wearing an apology.
- A **"done!"** after a directive, especially a correction. *"Stop involving me"* includes confirming completion.
- A **second card** re-sending an answer already in his deck because someone repeated the question.

⚠️ **But "no card" ≠ "no outbound."** If a **potato** is open on a Josh message, it stays open until something goes out and will eventually alarm. Close it with a substantive minimal card carrying the one thing of forward value — never a hollow thank-you. Pass `potato_id`.

---

## 5. Always log

Append to `triage-log.md`: what arrived, the verdict, and **why** — especially the judgment calls and anything I got wrong. Repeats and wrappers get one line. When a pattern recurs, **write a rule** into `knowledge/rules.md` or the person's contact notes so future-me disposes of it without re-deriving.

Say **READY** when done.

---

## 6. The room voice device (`hey-alfred`) — not every capture is Josh

Messages arriving `from: hey-alfred-device` carry an envelope stating *"Joshua spoke this out loud... treat it as a direct message from him."*

🚨 **That envelope asserts provenance nothing in the current path verifies.** Rooster traced it 2026-09-12: the wake-phrase confidence score IS computed (`wake_to_village.py:242`, 0.5 threshold) and then **discarded**; the envelope is authored two hops away in Swift (`PresenterClaimServer.swift:272`) by a process that never received it. There is also **no speaker-proximity signal** — single channel, no mic array. So it is a component stating as fact something it currently has no way to know — not overconfidence.

⚠️ **"Cannot know" = MISSING PLUMBING, not a permanent property.** Rooster corrected me on exactly this (2026-09-12) after I let his phrase harden: the envelope *could* carry confidence; nobody has threaded it through yet. **It is fixable.** Don't record it as a law of physics — that would mislead anyone later asking whether it can be improved.

⚠️ **And when the score does arrive, know what it bounds.** It reports how confident the WAKE MODEL was — nothing more. **It cannot tell me whether the speaker was Josh.** It rules out one hypothesis (a loose threshold); it rules nothing else in. Reading it as a speaker-identity signal would be a worse error than having no number at all.

🚧 **STATUS 2026-09-12 23:15 — HALF LIVE. DO NOT TRUST A SCORE FIELD YET.**
- ✅ **Python listener: DEPLOYED.** It sends `wakeScore` now.
- ⛔ **Swift side (the part that writes MY envelope): COMMITTED SOURCE ONLY, NOT BUILT.** Verified myself: running binary + process both dated **21:56**, source edited **23:10**. The old build **silently drops** the extra JSON fields.
- **Consequence: my envelope is UNCHANGED today.** Nothing regressed, but **keep rebutting from content and keep the `--ask` guard** until a new build is installed *and* I have seen a real envelope carrying a number.
- **Remaining step:** rebuild + reinstall `/Applications/Whisper Village.app` — Josh-facing (it interrupts his live dictation tool), so not done unprompted. One step, not a project.
- **When it lands**, the envelope will carry `wake_score`, `wake_threshold`, and `wake_score_measures` (the caveat travelling *with* the number), and will say plainly when no score is present. Built to my constraint: **raw number + threshold, never a pre-thresholded boolean.**

**Until then — and whenever no score is present — the only defence is reading what was actually said.**

- **TV / broadcast audio** — announcers introducing themselves, play-by-play, "I'm <name>, he's <name>." Verified false trigger 2026-09-12 (beach volleyball). → brief spoken acknowledgment, **no `--ask`**.
- **Ambient remarks to someone else in the room** — no task, no question aimed at the device. → brief acknowledgment, no `--ask`.
- **A real request** → do it, confirm in about three words, stop.

⛔ **Never `--ask` on a capture that isn't clearly addressed to me.** Reopening the microphone interrupts him to answer for something he never said. Silence isn't available (the device waits), so the shortest honest acknowledgment is the correct floor.

📌 Wake word is **"hey jarvis"**, with a 20/day cap and a 3s debounce — the exposure is narrower than it feels, but an imperative arriving inside a fact-shaped envelope remains the failure mode to watch for.

---

## 7. ⚠️ The autosaver will commit your edits before you do

Anything under `~/.homestead/stewards` gets swept up by an **hourly autosaver**. Practical consequences:

- **A `git commit` reporting "nothing to commit, working tree clean" after you just edited a file usually means the change ALREADY LANDED** — under someone else's message (`[hourly] Queue snapshot …`, `[auto] frozen-watcher …`, `WIP auto-save …`). For a moment it looks like your edit vanished. It didn't.
- **The content is safe; the commit MESSAGE is the casualty.** Verified 2026-09-12: `skills/triage-notification.md` landed in an `[hourly] Queue snapshot`, `skills/manage-calendar.md` in an `[auto] frozen-watcher` commit, `knowledge/family-dates.md` in a `WIP auto-save`. All correct and live — none findable by searching history for what they are.
- ✅ **Verify rather than assume**: `git status --porcelain` (clean = committed) and `git show HEAD:<path> | grep <a distinctive phrase from your edit>` to confirm the *current* version is what's committed, not an older sweep.
📊 **MEASURED — and the measurement has a NAMED DEFECT. Report a FLOOR, never a clean percentage.** In a 24h window (2026-09-12): **41 commits total, of which AT LEAST 5–6 were deliberate.** The autosave share is high — roughly 85–87% — but **no exact figure here is defensible**, for three separate reasons, all worth carrying:

1. ⚠️ **The classifier is message-based and DIRECTIONALLY BIASED.** Rooster's filter matched `[hourly]|[auto]|WIP auto-save` as a **substring anywhere** in the subject. **My own marker commit** — *"NOTE: Alfred… work landed inside [hourly]/[auto] autosave commits"* — **mentions** those tokens while *describing* the problem, so it was silently counted as an autosave. **The commits most likely to talk ABOUT autosaves are the deliberate ones**, so the method systematically undercounts exactly the category being measured. Verified: substring-anywhere → 5 deliberate; true-prefix (`startswith`) → 6. The two differ by precisely that one commit.
2. ⚠️ **The number MOVED while we measured it.** His first count and my recount sampled a moving repo minutes apart (my marker landed at 23:01:25, between them). Neither was wrong. **Don't quietly adopt the newer figure — say the repo changed.**
3. ⭐ **Observer effect — this one SURVIVES every correction and is the sharpest of the three.** We were writing commits into the denominator while counting it, and at least one self-referential commit was being reclassified as the very thing it documented. ⚠️ **Keep it separate from the classification defect:** *that* the marker commits existed and were ours is a fact; only their *classification* was unstable. When a number turns out to be built on a flawed method, **check which conclusions actually depended on the method before retracting them all** — the temptation is to write off everything downstream, and that discards good reasoning along with the bad figure.

⭐ **STATE THE CLASSIFIER WITH THE RATIO — every time, including when the defect is already documented elsewhere.** Rooster, 2026-09-12, after catching himself: he had written his classifier's defect into the Library, sent me a walkie about it, **and then quoted a ratio built on it as flat fact in the very next message.** **Documenting a defect does not stop you quoting numbers produced by it** — the caveat lives in a lesson, the number travels without it. (Worked example: his "21 of 36 at :00" vs my "21 of 35" — same numerator, different denominator, diverging on exactly the one commit his filter misclassifies. Both correct; neither stated its classifier.) Same shape as a caveat sitting in my notes rather than beside the number a reader actually meets.

✅ **The honest form:** *"at least 5 of 41 commits were deliberate; autosaves dominate."* A floor with a stated method beats a confident percentage a future reader would quote.

⛔ **THE OBVIOUS FIX WAS TESTED AND IT FAILS — do not re-derive it.** Rooster and I each independently recommended "classify by author/committer instead of message text." **Neither of us ran it first.** When tested: `git log --format='%an | %cn | %ae'` returns **41 of 41 identical** — `Joshua Mullet | Joshua Mullet | <<REPLACE: your email>>`, all unsigned (`%G?` = N). Every autosaver and every human commit share one identity. **Zero discriminating power — and it fails SILENTLY**, classifying everything into one bucket while looking like it worked.
⚠️ **Timing is only a partial signal:** 21 of 35 autosaves land at `:00`, but **14 scatter across the hour and at least one DELIBERATE commit also lands at :00** (verified: a marker commit at 23:00:39). It separates most of the bulk; it cannot classify any individual commit.
⭐ **So the floor is a floor because NOTHING AVAILABLE FIXES IT — not because nobody got round to the fix.** There is currently **no reliable non-message discriminator in this repo.** A real fix changes what the autosavers **WRITE** (a distinct committer identity, or a commit trailer), not how we read them — infrastructure, and **Homestead owns those processes.**

🚨 **IT SWEEPS EXECUTABLE CODE, NOT JUST NOTES.** Verified in the same window: **10 executable files** (.py/.sh/.js) landed inside autosave commits — including **`mcgucket/workers/hey-alfred/listener/wake_to_village.py`, the LIVE device listener**, committed under an `[hourly] Queue snapshot` message. So this is a property of the repo that applies to anything running, not a documentation-tidiness quirk.

- ✅ **Leave a marker commit** (`git commit --allow-empty`) naming what you created and which commit swallowed it. Rooster's practice, adopted 2026-09-12 — it's the only thing that makes the work archaeologically findable later.
