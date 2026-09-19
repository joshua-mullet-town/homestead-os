# Build Manager UI Plan

## How SwiftBar Works

SwiftBar is a macOS app that turns bash scripts into menu bar items. Here's the key insight:

**Your script's stdout IS the menu.** Every time the script runs, whatever it prints becomes the menu bar icon + dropdown. The script re-runs on a timer (e.g., every 1 second) or on demand.

This means: **the agent can completely change the interface at any time** by writing new data to a JSON file. The script reads the JSON and renders whatever's in it.

### Example: The menu shows 3 items, Josh clicks "Next", now it shows 2 items with a different first item. The agent updated the JSON, SwiftBar re-ran the script, new menu appeared.

### What SwiftBar CAN Do:
- Show any text as the menu bar title (e.g., `🔨 3` = hammer + queue count)
- Dropdown with clickable items (each triggers a bash command)
- Submenus (nested items)
- SF Symbols icons on items
- Colors, fonts, bold/italic on items
- Separators between sections
- Items that trigger ANY bash command when clicked
- Force refresh via: `open -g "swiftbar://refreshplugin?name=build-manager"`

### What SwiftBar CANNOT Do:
- No inline text input fields (must use AppleScript dialog for text entry)
- No checkboxes or toggles (items are just clickable text)
- No custom layouts (it's a standard macOS dropdown menu)

### The Combo Approach:
- **SwiftBar** = persistent menu bar presence + clickable actions (Next, Skip, queue list)
- **AppleScript dialogs** = text input, decision prompts, attention-grabbing alerts
- **notify_user MCP** = browser-based testing overlays (navigate to page + show instructions)

The agent orchestrates all three. It picks the right tool for the moment.

---

## What We're Building

### Piece 1: SwiftBar Plugin (`~/.homestead/swiftbar-plugins/build-manager.1s.sh`)

A bash script that reads `~/.homestead/build-manager-queue.json` and renders the menu.

The JSON file structure:
```json
{
  "count": 3,
  "current": {
    "session": "holler-homestead",
    "summary": "Added dark mode toggle. Pre-test passed.",
    "status": "presenting"
  },
  "items": [
    {"session": "holler-GiveGrove", "summary": "Waiting for approval on donation form"},
    {"session": "holler-mullet-town", "summary": "Has a question about routing"}
  ]
}
```

What the menu looks like:
```
🔨 3                          ← menu bar title (always visible)
─────────────────────────────
  Now: holler-homestead       ← current item being presented
  "Added dark mode toggle"
─────────────────────────────
  ▸ Next                      ← click → writes {"action":"next"} to commands file
  ▸ Skip                      ← click → writes {"action":"skip"}
  ▸ Respond...                ← click → opens AppleScript text input dialog
─────────────────────────────
  Queue:
  • holler-GiveGrove          ← informational
  • holler-mullet-town
─────────────────────────────
  ▸ Refresh                   ← force re-read
```

When Josh clicks a button, SwiftBar runs a bash command that writes to `~/.homestead/build-manager-commands.json`. The build manager agent reads that file to know what Josh did.

### Piece 2: Presenter Library (`lib/presenter.js`)

A CLI tool any agent can call. Three modes:

```bash
# Alert dialog (blocks until response)
node lib/presenter.js alert \
  --title "Build Manager" \
  --message "holler-homestead is ready" \
  --buttons "Skip,View,Approve"
# Returns: {"button": "Approve"}

# Alert with text input
node lib/presenter.js alert \
  --title "Build Manager" \
  --message "What should the agent do?" \
  --input "approve the changes" \
  --buttons "Cancel,Send"
# Returns: {"button": "Send", "text": "approve the changes"}

# List picker
node lib/presenter.js pick \
  --title "Queue" \
  --message "3 sessions need attention" \
  --items "holler-homestead,holler-GiveGrove,holler-mullet-town"
# Returns: {"selected": "holler-GiveGrove"}

# Notification (fire and forget)
node lib/presenter.js notify \
  --title "Build Manager" \
  --message "2 items remaining"

# Update SwiftBar queue state
node lib/presenter.js queue-update \
  --data '{"count":3,"current":{"session":"holler-homestead","summary":"Ready"},"items":[]}'
# Writes JSON + triggers SwiftBar refresh
```

### Piece 3: ACTION.md (the queue workflow)

Seed the action agent's playbook with:
- How to maintain the presentation queue
- When a session is ready → pre-test → add to queue → update SwiftBar
- When presenting → use presenter.js alert
- Parse response → route accordingly
- After response → immediately present next
- "Next" from SwiftBar → skip current, present next

---

## The End-to-End Flow

1. Build manager detects sessions that need attention (action comes in, or it's monitoring)
2. Action agent pre-tests: reads session context, gathers PLAN.md/STATE.md/conversation, verifies output
3. Adds to queue, updates SwiftBar menu bar → Josh sees `🔨 3`
4. When Josh is ready (clicks Next in SwiftBar, or finishes previous item):
   - AppleScript dialog pops up: "holler-homestead finished. Pre-test passed. [Skip] [View] [Approve]"
   - Josh clicks Approve → build manager routes approval to the session
   - Josh clicks View → notify_user MCP opens browser to the right page
   - Josh clicks Skip → moves to next item
5. Immediately after response → next dialog chains in, or SwiftBar shows "Queue empty"
6. If Josh typed feedback → two-step dispatch (execute correction + learn from it)

---

## Implementation Order

1. Install SwiftBar (`brew install --cask swiftbar`)
2. Create the plugin bash script
3. Create `lib/presenter.js` CLI tool
4. Test the combo: write JSON → see SwiftBar update → click button → read command
5. Seed ACTION.md with queue workflow
6. Wire it all together with the build manager agent

---

## Files to Create

| File | Purpose |
|------|---------|
| `~/.homestead/swiftbar-plugins/build-manager.1s.sh` | Menu bar plugin |
| `lib/presenter.js` | CLI tool for dialogs + queue updates |
| `~/.homestead/build-manager-queue.json` | Queue state (SwiftBar reads) |
| `~/.homestead/build-manager-commands.json` | User commands (SwiftBar writes) |

## Files to Update

| File | Change |
|------|--------|
| `~/.homestead/siswapts/build-manager/ACTION.md` | Seed with queue workflow |
