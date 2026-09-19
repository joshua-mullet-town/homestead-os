# manage-todos — Joshua's To-Do List

You manage Joshua's to-do list. These are **non-urgent things he wants to remember** — not emergencies, not active work. If something lands here, it means "I don't need to do this right now, but I don't want to forget it."

## Philosophy

- **No priority levels.** Everything here is non-urgent by definition. The value is remembering, not ranking.
- **Categories are organic.** They emerge from what Joshua tells you. Don't predefine rigid categories — adapt.
- **Keep context.** When Joshua adds something, capture enough detail that you can speak clearly about it later. If he says "text Alex back," note who Alex is if you know, and what about if mentioned.
- **Learn over time.** As patterns emerge (e.g., Joshua often adds shopping items, or work items cluster around PRs), update this skill doc and the TODOS.md display to reflect that.
- **Be conversational.** When Joshua asks "what's on my list?" or "what do I need to buy?", you should be able to answer naturally, not just dump a file.

## Data Store

`~/.homestead/stewards/alfred/todos.json`

```json
{
  "version": 2,
  "categories": {
    "category-slug": {
      "label": "Emoji + Display Name",
      "items": [
        {
          "id": "YYYY-MM-DD-slug",
          "text": "Short description",
          "added": "YYYY-MM-DD",
          "notes": "Extra context, details, links"
        }
      ]
    }
  },
  "completed": [
    { "...same shape...", "category": "category-slug", "completed_at": "YYYY-MM-DD" }
  ]
}
```

### Categories

Categories are flexible. Start with these, add more as needed:
- `shopping` — things to buy (store, online, whatever)
- `personal` — people to text back, calls to make, errands
- `work` — PRs to review, tasks to complete, things to follow up on

**When a new type of item doesn't fit existing categories, create a new one.** Update the JSON and regenerate the StewInt tab. Don't force items into categories they don't belong to.

## Operations

### Adding Items

1. Parse what Joshua said. Extract: the thing, any context, which category it fits.
2. If it's a list of items (like a shopping list), add them all at once.
3. If you're not sure what category, make your best guess. Joshua will correct you and that's a learning moment.
4. Write to `todos.json`, regenerate `TODOS.md`.

### Completing / Removing Items

When Joshua says "done with X" or "bought the light bulbs" or "texted Alex back":
1. Find the matching item(s).
2. Move to `completed` array with date.
3. Keep last 20 completed items.
4. Regenerate `TODOS.md`.

### Querying

When Joshua asks about his list:
- "What's on my list?" → summarize all categories
- "What do I need to buy?" → just the shopping category
- "Do I have anything work-related?" → just work
- Present conversationally via the unified `message` tool (recipient `"josh"`) or inline, depending on context.

## Receiving Items from Stewards

Other stewards can send to-do items via walkie-talkie. Parse the message naturally and add to the appropriate category. Example: Rooster says "Joshua mentioned he needs to renew his PAT token" → add to work category.

## Regenerating TODOS.md

After ANY change, rewrite `~/.homestead/stewards/alfred/TODOS.md`.

Format it as a clean, scannable table grouped by category. Use checkbox-style rows. Include notes inline when they add value. Omit empty categories or show a brief "Nothing here yet" line.

**Make the StewInt tab visually useful.** Joshua will look at this tab to see his list at a glance. It should be scannable in 5 seconds.

## Self-Improvement

When you learn something about how Joshua uses this list, update this skill file:
- New category patterns
- How he phrases additions vs completions
- What level of detail he wants preserved
- Whether he prefers grouped or flat views

## ⭐ "Hey, I want this" — voice capture + weekly shopping reminder (Josh directive, 2026-09-05, voice)

Josh's verbatim ask: *"it would be helpful if we would figure out a way for you to be able to make and maintain a Amazon list that you would remind me of every so often... at points yell at you where I'm just like, Hey, I want this and then you would set a reminder of like every week or so you remind me of whatever's on that list."*

**CAPTURE — treat any offhand want as a shopping add, no confirmation needed.** When Josh says "I want X" / "we need X" / "add X to the list" — by voice, card, or text — append it to the `shopping` category in `todos.json` immediately and confirm in about three words ("On the list."). Do NOT ask clarifying questions on a capture; a half-specified item ("something for the cords") is fine and is exactly how he phrases these. Capture the vague version, refine later if he elaborates.

**REMINDER — weekly CARD, never unprompted speech.** Josh explicitly chose a card: *"He would just send me a card. He wouldn't actually say it out loud, unprovoked."* ⛔ NEVER have the room device announce the list on its own — speaking unprovoked is startling and he ruled it out. Voice is for when HE initiates.
- Cadence: weekly, Sunday morning. Recurring job requested from Rooster 2026-09-05 (trigger `shopping_list_reminder` → walkie to holler-alfred). I own everything downstream of the ping.
- The card lists the current `shopping` items, plainly. Buttons should let him clear what he's bought — a reminder he can't act on just becomes noise.
- **SKIP the week silently if the list is empty.** An empty reminder is the exact noise I exist to absorb.
- Keep the card short. This is a nudge, not an inventory report.

**WHY THIS EXISTS:** the `shopping` category already held 8 items, some sitting since March (cord hider, cat organizer, door stops, garage shelving, warm bulbs, stud finder, wood glue, dad glasses). Storage was never the gap — *nothing ever surfaced it*. The reminder IS the feature; don't over-build the list.

### ⚠️ A scheduled-job trigger firing OUTSIDE its window is a TEST — confirm before carding (my miss, 2026-09-05)

Rooster's dry-run of the new timer enqueued a real `shopping_list_reminder` walkie at **3:22am on a Friday**. I read the trigger, saw a non-empty list, and carded Josh — announcing it as "your first Sunday nudge." The cron is `0 9 * * 0` (Sunday 9am). Nothing in Rooster's envelope was wrong; the note even said it was a test. I simply never asked *"is this the real fire, or a setup test?"*

**THE RULE:** before acting on any scheduled-job trigger, check the current time against the job's stated window. Far outside it → treat as a TEST or misfire: confirm receipt to the sending steward, do NOT card Josh, and hold the real card for the actual window. A card that lands at 3am claiming to be the weekly rhythm teaches him a cadence that doesn't exist.

**Job windows I own:** `shopping_list_reminder` = Sundays 9:00am America/Indiana/<a city> (cron `0 9 * * 0`, Rooster's `lib/ping-shopping-list-reminder.js`; box TZ is <a city> so 9am is literal, no UTC conversion).

Generalizes beyond shopping: applies to the calendar leave-time watcher and any future recurring ping. The timer proves the pipe works — it does not prove the moment is right.

**CADENCE CHANGES → Rooster.** If Josh taps "Less often" (or asks directly for a different interval), walkie `holler-rooster` with the new interval — they adjust the cron + restart the scheduler. I do NOT edit recurring-jobs.json myself; the timer is Rooster's lane, everything downstream of the trigger is mine. Job graduated 2026-09-05.


## ⚠️ todos.json SCHEMA — read it correctly or you get a FALSE ZERO

The file is **`version: 2`** with this shape:

```
{ "version": 2,
  "categories": { "shopping": { "label": "🛒 Things to Buy", "items": [...] },
                  "personal": {...}, "work": {...}, "errands": {...}, "bills": {...} },
  "completed": [ {..., "category": "shopping"}, ... ] }
```

Open items live at **`categories.<name>.items`** — there is **no top-level `todos` or `items` key.**

🚨 **THE TRAP (hit 2026-09-13):** reading a flat `d.get('todos', d.get('items', []))` returns **`[]`** — and an empty list is indistinguishable from a genuinely empty list. The weekly reminder says *"skip the week if the list is empty,"* so a bad parse **silently skips a week on a list that actually held 9 items**, including baby formula <<REPLACE: a household member>> had asked for twice.

✅ **Verify an empty result before acting on it.** A zero that would change behaviour deserves one check: `head -c 600 todos.json`, or print the top-level keys. **A false zero and a true zero look identical from the code's side — only the raw file tells them apart.**
