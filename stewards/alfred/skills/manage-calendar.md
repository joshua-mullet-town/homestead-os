# manage-calendar — Creating & Maintaining Joshua's Calendar Events

Everything about how Joshua wants calendar events handled lives here. **Read this before creating or updating any event.** Josh asked for this file explicitly (2026-09-11) because the rules were accumulating across CLAUDE.md, rules.md and family-dates.md faster than anyone could hold them: *"I'm nervous that we're getting too much of this instruction... could you whip yourself up a skill so you don't have to keep them all in your brain?"*

Everything below is a Josh directive unless marked otherwise. When he gives a new calendar preference, **it gets added HERE**, not scattered elsewhere.

---

## 1. Invite <<REPLACE: a household member>> on anything they share

**Add `<<REPLACE: a household member email>>` as an attendee at CREATION time.** Don't ask first, don't retrofit later.

- Her address is Josh-confirmed (contact id 681, "<<REPLACE: a contact alias>>" = <<REPLACE: a household member>>).
- Use `sendUpdates: "all"` on real events so she actually gets the invite. Use `"none"` on recurring markers far out — a notification about something eight months away is noise.

**Scope — "includes them both" is BROADER than "an event they physically attend together."**

⛔ I got this wrong once: I left <<REPLACE: a household member>> off his family's birthdays, reasoning they were "reminders for Josh, not plans they attend as a unit." **He overruled it.** His family's birthdays are *her in-laws'* birthdays — she has as much reason to see them coming as he does.

- ✅ **Include her by default on anything family or household.**
- ❌ **Leave her off only genuinely solo items** — his work meetings, his volleyball, his own commitments.
- ❌ Don't duplicate when someone else already organized it with her on it (e.g. an event <<REPLACE: a household member>> herself created).

---

## 2. Reminder lead times — never leave the default

Google's 10-minute default is, in his words, **"almost never what I want."** Always set `reminders.overrides` explicitly; never `useDefault: true`.

His baseline: *"an hour ahead of time and a day ahead of time is really my jam"* — then more for anything he must not forget or could accidentally book over.

| Tier | What it covers | Reminders |
|---|---|---|
| **Must-not-forget** | <<REPLACE: a household member>>'s birthday, their anniversary, his child's birthday — things needing real planning runway | 28d + 7d + 1d + 1hr |
| **Standard family** | His birthday, parents', sisters', parents' anniversary | 7d + 1d + 1hr |
| **Real events with a time** | Parties, appointments, anything he travels to | 7d + 1d + 2hr |
| **Trivial note-to-self** | Small personal reminders | 1hr, or 15min |

### 🚨 Google's hard ceiling: 28 days

**40320 minutes (28 days / 4 weeks) is the MAXIMUM lead time. Anything longer is SILENTLY DISCARDED — no error, no warning.**

Verified 2026-09-11: I set 86400 (60 days) on <<REPLACE: a household member>>'s birthday and got back four overrides instead of five, with the 60-day one simply gone. Re-sending five overrides all ≤40320 (including an `email` one) — all five accepted. So the cap is on **lead time**, not count.

- Max **5 overrides** per event. `method` is `popup` or `email`.
- ⚠️ **Test the longest value first** when trying a new lead time. A silent drop is exactly how you end up telling Josh you did something you didn't.

### ⭐ When he wants more than 4 weeks, I own it

Josh wants **~2 months' warning on <<REPLACE: a household member>>'s birthday**. Calendar cannot do it. **So I card him myself** — early January for her March 7. The ceiling is Google's constraint; covering it is my job, not an excuse.

**Standing obligation:** any date where he asks for more than a month's notice goes on my own watch list, not just the calendar.

---

## 3. Always tell him what I set

His explicit ask: *"when you create an event automatically, you can just tell me what you set the notifications at, and then I can confirm whether or not I want more or less."*

One line in the card naming the lead times. Cheap for me, and it lets him correct the tier without having to ask what I chose.

---

## 4. A start time is not always a commitment

⛔ **Do NOT compute "conflicts" from two overlapping evening items.**

Josh, correcting me 2026-09-11: *"for evening plans for me and <<REPLACE: a household member>> that's going to be always up in the air... it's just five o'clock just to remind us... there's no conflicts here — we're just going to wait till <<REPLACE: a family contact>> gets here at 5:20 and then we're going to leave for the event whenever."*

**What I got wrong:** I saw a 5:00 festival and a 5:20 guest, declared them mutually impossible, and sent it **blocked + urgent**. There was no conflict. My *verification* had been good — I'd confirmed <<REPLACE: a household member>> organized it and Josh had accepted — but **confirming an event is real is not the same as confirming its time is rigid.** Two different questions; I answered the second with evidence for the first.

- **Casual/windowed events** (festivals, markets, drop-in things, "let's go to X") — the start time is a **reminder marker**. A 5–7 window is joinable at 5:45.
- **A REAL conflict still exists** when both items are genuinely fixed: a reservation, a ticketed start, a medical appointment, a flight, someone else's hard deadline.
- **The test:** can the thing absorb a late arrival? Not: do two blocks overlap on a grid?
- ✅ He did **not** object to the reminder itself — *"just to remind us"* reads as welcome. Keep sending leave-time notices; send them **fyi**, and state the **window**, not the instant.

---

## 5. Leave-time notices (the killer feature)

When a `calendar_event_upcoming` trigger fires:

1. **Get his live location** — `mcp__phone__get_location`. Check the fix age; a stale one is worth noting.
2. **Look up the venue in `knowledge/places.md` FIRST.** Many are already there with drive times. Only research genuinely new places (Google Maps only — never Apple Maps, per `skills/directions.md`).
   🚨 **A STORED DRIVE TIME IS ONLY USABLE IF IT WAS ROUTED. If the entry says "estimate"/"not Maps-routed", ROUTE IT BEFORE QUOTING IT** — open `google.com/maps/dir/<origin>/<destination>` with `mcp__chrome-devtools__new_page` + `take_snapshot` and read the "Driving N min" off the a11y tree. **Straight-line math was off by ~2x on 2026-09-15 (said 20 min, actual 11) and Josh caught it.** ⛔ Never pass a haversine guess to him as a flat number.
   ⭐ **GIVE TWO CUES, NOT ONE: a GET-READY ping (~15 min before leaving, Josh's ask) and the WALK-OUT-THE-DOOR ping.** He may already have his own alarm — ask/assume it is the get-ready one and make yours the departure one.
3. **Compute leave time = event start − travel time**, and give him the *walk-out-the-door* moment, not just the event time.
4. **Card it as `fyi`** unless something is genuinely fixed and genuinely clashing.
5. **Append any new address to `knowledge/places.md`** so the next calculation is free.

---

## 6. Where things live

- **`knowledge/family-dates.md`** — the birthday/anniversary dates themselves, their confidence levels, and which reminder tier each got.
- **`knowledge/places.md`** — addresses and drive times.
- **Phone contacts** — the canonical identity store. <<REPLACE: a household member>>'s invite address lives on contact 681.
- **This file** — how to *handle* calendar work. New calendar preferences from Josh land here.

---

## 7. Known event IDs (the recurring set, created 2026-09-11)

| Event | ID |
|---|---|
| 🎂 Josh's birthday (Sep 20) | `g7uvbqgb85framfatfmmdd7on8` |
| 🎂 <<REPLACE: a household member>>'s birthday (Mar 7) | `1mhlakvbvpeej1b1f3bri5n360` |
| 🎂 his child's birthday (May 9) | `nvjt6i9bh41637i6dh66r06gmo` |
| 🎂 <<REPLACE: a family contact>>'s birthday (Mar 19 — **unconfirmed**) | `0tblcboppgids6kosc0gfp0lf4` |
| 🎂 his sister-in-law's birthday (Mar 31) | `gn1kfl22borgevh7hcskukd7h4` |
| 🎂 Dad's birthday (Mar 30) | `si304hc58u8apv00k440bmpfis` |
| 💍 Josh & <<REPLACE: a household member>>'s anniversary (May 17) | `da3011ncbd7u5rsiu54i7dmk60` |
| 💍 Mom & Dad's anniversary (Mar 29) | `nf0oa2kp13f62ilcb61o8asdks` |
| 🎂 Birthday celebration (Sun Sep 20, 4:30) | `f72p75vq6q05ag4t0fq04cf1m4` |

⚠️ **<<REPLACE: a family contact>>'s date is uncertain** — Josh said *"I think March 19th"* while stating every other date flatly. The event title itself carries "— date unconfirmed." Confirm before acting on it.
⚠️ **March is dense** — 7th, 19th, 29th, 30th, 31st. Five dates, four in the last three days. Give him **one consolidated heads-up in late February**, not five pings.
