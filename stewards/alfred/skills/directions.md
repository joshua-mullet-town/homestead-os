# directions — Find a Place + Hand Joshua a Tap-to-Open Maps Link

When Joshua asks for directions to anywhere — known or unknown — your job is to deliver a **tappable Google Maps URL** in a presenter card, fast. He's usually on the road. Speed matters more than thoroughness.

## The Golden Pattern (validated 2026-04-25)

Joshua's exact praise on the rep that landed:
> "I loved how you presented the information this second time around with the Google Maps. I use Google Maps. Don't ever feel like you need to show me Apple Maps."

The winning card had:
- Place name + address bolded at the top
- A single tappable Google Maps directions URL **in the message body** (not in a button — buttons don't work on mobile presenter)
- One short sentence of context ("Right on CR 17, ~5 min from your house, multiple ball diamonds")
- Buttons for confirmation: 👍 Got it / Wrong place — keep looking

## The URL Format

Always use this Google Maps directions URL shape (works on phone, opens directly into the Maps app):

```
https://www.google.com/maps/dir/?api=1&destination=NAME,+ADDRESS,+CITY,+STATE+ZIP
```

URL-encode spaces as `+`. Replace commas with `,+`. Example:
```
https://www.google.com/maps/dir/?api=1&destination=<venue>,+<street address>,+<a local place>,+IN+<zip>
```

If origin matters (rare — phone defaults to current location), add `&origin=...` in the same shape. Usually omit it; Maps uses GPS.

**Never include Apple Maps.** Joshua doesn't use it. Don't clutter the card.

## Resolution Order

1. **Check `knowledge/places.md` first.** If Joshua asks for "my parents' house" or "the ballpark where my nephews play" or any nickname/relationship he's already taught me — pull the address from there immediately. No research.

2. **If it's a new place he describes vaguely** ("a baseball diamond near CR 17 surrounded by churches"):
   - Use Chrome DevTools to drive Google Maps directly: `https://www.google.com/maps/search/QUERY/@LAT,LNG,ZOOM`
   - Center on his neighborhood (41.6420,-85.9550 covers south <a local place> / CR 17) when relevant.
   - The `[role="feed"]` element on a Maps search result page exposes name + address + reviews in clean text. Grab the top match that fits his description.
   - One web search is fine to get oriented, but **don't get stuck in WebSearch loops** — Chrome DevTools on Google Maps is the reliable path.

3. **If the place is something he just told me** ("I work at <<REPLACE: your employer>>" → he gave that fact, not a "find it" request) → save to places.md, don't surface a directions card unless he asks.

## Speed Targets

- **Known place** (in places.md): card delivered in under 30 seconds.
- **Unknown place with strong description**: under 2 minutes. If you're past 2 min, ship what you've got with a "if this is wrong, tell me" button rather than keep researching.

## The Card Template

```
title: "Directions → {PLACE_SHORT_NAME}"
priority: "urgent"  (he's on the road)
category: "situation"

message:
**{Full Place Name} — {Full Address}**

Tap to open in Google Maps:
{URL}

{One-sentence context: distance from his house, what makes this the right one, any ambiguity flag.}

buttons: ["👍 Got it", "Wrong place — keep looking"]
```

## Saving New Places to the Address Book

Whenever Joshua tells me **any address or named place** — whether or not it's part of a directions request — append it to `knowledge/places.md` immediately. The whole reason this skill exists is so I never re-research the same place twice.

If Joshua tells me a relationship ("my parents live at...") + an address, save both. The relationship/nickname is how he'll ask for it next time.

## When You're Uncertain

If you find multiple candidate places and can't pick confidently:
- Pick the most likely one and ship it with the "Wrong place — keep looking" button.
- Mention the runners-up in a single line: "If wrong, alternates: X (on Y St), Z (on W Ave)."
- Don't make him wait while you investigate further. He can tap a button if it's wrong.

Per Joshua's standing feedback: tight questions, not walls. Don't card him with "which of these three?" while he's driving. Pick. Ship. Let him correct if needed.
