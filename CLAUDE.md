# CRITICAL: APK Install Rules

> **FIRST, THE DELIVERY PATH: Joshua installs the APK, not you.** You build it and
> copy it to the updater path; he taps "⬆ UPDATE AVAILABLE" in the app. ADB is
> normally NOT available (USB unplugged, adb-over-network refused), so the rules
> below apply only in the rare case you genuinely have a device attached — they
> are not an instruction to go find a way to install it yourself. Full path and
> the reasoning: **Android App (APK) → Building and Deploying**, below.

**NEVER run `adb uninstall`. ALWAYS use `adb install -r` to update in place.** Uninstalling wipes all app data and permissions. The `-r` flag replaces the existing app while preserving everything.

```bash
# CORRECT - update in place:
adb install -r app/build/outputs/apk/debug/app-debug.apk

# WRONG - NEVER DO THIS:
adb uninstall com.homestead.mobile
```

# CRITICAL: After ANY ADB install, re-grant ALL permissions yourself
**Do NOT ask the user to toggle permissions. Do it via ADB immediately after install.**
(Only relevant when you actually installed via ADB. An in-app update — the normal
path, where Joshua taps UPDATE — preserves permissions and needs none of this.)

```bash
# Runtime permissions
adb shell appops set com.homestead.mobile android:get_usage_stats allow
adb shell pm grant com.homestead.mobile android.permission.ACCESS_COARSE_LOCATION
adb shell pm grant com.homestead.mobile android.permission.CAMERA
adb shell pm grant com.homestead.mobile android.permission.RECORD_AUDIO
adb shell pm grant com.homestead.mobile android.permission.READ_CONTACTS
adb shell pm grant com.homestead.mobile android.permission.READ_PHONE_STATE
adb shell pm grant com.homestead.mobile android.permission.CALL_PHONE
adb shell pm grant com.homestead.mobile android.permission.READ_CALL_LOG
adb shell pm grant com.homestead.mobile android.permission.SEND_SMS
adb shell pm grant com.homestead.mobile android.permission.READ_SMS
adb shell pm grant com.homestead.mobile android.permission.RECEIVE_SMS
adb shell pm grant com.homestead.mobile android.permission.POST_NOTIFICATIONS

# System services (these CAN be enabled via ADB, no manual toggle needed)
adb shell cmd notification allow_listener com.homestead.mobile/com.homestead.mobile.HomesteadNotificationListener
# Accessibility service is auto-preserved on -r install, but if lost:
# adb shell settings put secure enabled_accessibility_services com.homestead.mobile/com.homestead.mobile.HomesteadAccessibilityService
```

---

# Homestead - Mobile Interface for Claude Code

## What This Is

Homestead is a **mobile-friendly web interface** for controlling Claude Code sessions running on your Mac. It lets you:

1. **Manage Sessions** - View, create, and destroy tmux sessions running Claude Code
2. **Terminal Access** - Full terminal from your phone via xterm.js + Socket.IO
3. **Voice Dictation** - Record voice, transcribe with Whisper, send to terminal
4. **Chat View** - See conversation history in a readable chat bubble format
5. **Dev Server Preview** - View running Next.js apps in an iframe
6. **Git Status** - Quick view of uncommitted changes
7. **Per-Session Settings** - Themes, font sizes stored per project

**Target User:** You, coding from your phone while away from your desk.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     YOUR MAC                            │
│  (clamshell mode, always on, plugged in)               │
│                                                         │
│  ┌─────────────────┐    ┌─────────────────────────┐    │
│  │  Homestead      │    │  tmux sessions          │    │
│  │  Server         │◄──►│  - holler-homestead     │    │
│  │  (Next.js +     │    │  - holler-givegroove    │    │
│  │   Socket.IO)    │    │  - holler-mullet-town   │    │
│  │  Port 3005      │    │  (each running claude)  │    │
│  └────────▲────────┘    └─────────────────────────┘    │
│           │                                             │
└───────────│─────────────────────────────────────────────┘
            │ Socket.IO + HTTP
            │
┌───────────▼─────────────────────────────────────────────┐
│                    YOUR PHONE                           │
│  Connected via local network or Tailscale VPN          │
│  Browser → http://<<REPLACE: your LAN IP>>:3005                      │
└─────────────────────────────────────────────────────────┘
```

**Key Points:**
- Uses your **Claude Max subscription** (no API costs)
- tmux sessions **persist** even if you disconnect
- Works over **local network** or **Tailscale** for remote access

---

## Running Homestead

```bash
cd <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead
npm run dev  # Runs node server.js on port 3005
```

Access from:
- Mac: `http://localhost:3005`
- Phone (local): `http://<<REPLACE: your LAN IP>>:3005` (your Mac's IP)
- Phone (remote): Via Tailscale IP

---

## Project Structure

### Key Files

```
/app
  /page.tsx                    # Home - project list, start sessions
  /terminal/[sessionId]/       # Terminal view (xterm.js)
  /session/[project]/          # Session page with tabs (terminal, preview, docs, git)
  /components/
    VoiceRecorder.tsx          # Voice recording + terminal controls
    SessionTabs.tsx            # Session tabs in bottom bar
    ChatView.tsx               # Chat bubble view of conversation
    GlobalVoiceRecorder.tsx    # Wrapper for VoiceRecorder
  /context/
    SessionContext.tsx         # Global state (sessions, themes, settings)
  /api/
    /sessions/                 # tmux session management
    /chat-messages/            # Conversation history from hooks
    /dev-server/               # Dev server status
    /session/[project]/        # Docs and git status

/server.js                     # Custom Next.js server with Socket.IO + node-pty
/lib/
  claude-session.ts            # Read Claude's .jsonl session files
```

### How Terminal Works

1. **server.js** manages tmux sessions via node-pty
2. Socket.IO streams terminal I/O to the browser
3. xterm.js renders the terminal in the browser
4. Voice recordings are transcribed and sent as terminal input

### How Chat View Works

Claude Code hooks (`~/.claude/hooks/`) write conversation data:
- `user_prompt_submit.py` - Captures user messages
- `stop.py` - Captures assistant responses

Files written to `/tmp/claude-session-{tmux-session}-conversation.json`

ChatView polls these files and displays as chat bubbles.

---

## Technical Notes

### node-pty Version
**CRITICAL:** Must use node-pty v1.0.0, NOT v1.1.0
- v1.1.0 causes `posix_spawnp failed` error on macOS

### Socket.IO Connection
Client uses dynamic host for mobile access:
```typescript
const socketUrl = typeof window !== 'undefined'
  ? `http://${window.location.hostname}:3005`
  : 'http://localhost:3005';
```

### Session Naming
tmux sessions are named `holler-{project}` (e.g., `holler-homestead`)

---

## Memory System

### STATE.md - What We Know (The Past)
- Completed work, lessons learned
- Newest entries at top with timestamps

### PLAN.md - What We're Doing (The Future)
- Current tasks, next steps
- Priority order descending

### Rules (STRICT)
- **No cruft** - Only document what we explicitly discussed and agreed on
- **No fluff** - No verbose explanations, no "we decided to..." narratives
- **Bullet points over paragraphs** - Get to the point
- **If in doubt, leave it out** - Less is more
- Never add speculative future ideas unless Josh asked for them

---

## Stack

- **Frontend:** Next.js 16, React 19, Tailwind CSS v3.4
- **Terminal:** Socket.IO v4.8, node-pty v1.0.0, xterm.js v6.0
- **Backend:** Custom Next.js server (server.js)
- **Themes:** Gruvbox variants (Dark, Hard, Light, Soft)
- **Fonts:** VT323 (terminal), system fonts (UI)

---

## Worktree Workflow (MANDATORY)

**NEVER edit files directly in `~/code/homestead` (production).** All development happens in worktrees.

### How It Works

1. **Production** lives at `~/code/homestead` on the `main` branch
2. **Development** happens in worktrees at `~/.worktrees/homestead/<branch-name>`
3. A `guard-production.sh` hook **blocks** direct edits to production from worktree sessions
4. The **only** way to get changes into production is via `/worktree merge`

### The Workflow

```
1. Create worktree:     /worktree <branch-name>
2. Make edits in:       ~/.worktrees/homestead/<branch-name>
3. Merge to production: /worktree merge
```

### What `/worktree merge` Does

1. **Auto-commits** any uncommitted changes (so nothing is lost)
2. **Merges main INTO your branch** (conflicts resolved in worktree, never production)
3. **Merges your branch INTO main** with `git merge --no-ff` (NOT `--ff-only`)
4. **Restarts the server** from production

### CRITICAL: Use `--no-ff` when merging into main

**NEVER use `git merge --ff-only` when merging a branch into main.** Always use `git merge --no-ff`.

Why: `.gitattributes` has `merge=ours` for PLAN.md and STATE.md. This keeps each branch's plan/state files separate — main keeps its own, branches keep theirs. But `--ff-only` bypasses merge strategies entirely (no merge commit = no strategy applied), which causes branch PLAN.md to overwrite main's.

### Why This Matters

- Production (`~/code/homestead`) runs the server on port 3005
- Worktrees are isolated copies for development
- This prevents accidental overwrites and lost work
- PLAN.md and STATE.md are per-branch — never cross-contaminate
- All agents must follow this - no exceptions

### Commands

| Command | Description |
|---------|-------------|
| `/worktree <branch>` | Create new worktree and optionally spin up session |
| `/worktree list` | Show all worktrees and their session status |
| `/worktree merge` | Merge current worktree into production |
| `/worktree down <branch>` | Destroy worktree and kill session |
| `/worktree restart` | Kill and restart current session |

---

## Important Instructions

- **YOU control the servers** - Don't ask user to run commands, do it yourself
- Do what's asked; nothing more, nothing less
- NEVER create files unless absolutely necessary
- ALWAYS prefer editing existing files over creating new ones
- **ALWAYS use worktree workflow** - Never push directly to main

---

## Password Vault (Biometric-Gated)

A hardware-backed password vault lives on Josh's phone. Any agent can access it via the `get_password` MCP tool — but it requires Josh's fingerprint every time.

### How to access

1. Register the MCP server in your session's `.mcp.json`:
```json
{
  "mcpServers": {
    "passwords": {
      "command": "node",
      "args": ["<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/mcp-servers/passwords/index.js"]
    }
  }
}
```

2. Call the tool:
```
mcp__passwords__get_password({ reason: "why you need it" })
```

3. Josh scans his fingerprint on his Pixel 6.

4. The tool returns `{ success: true, content: "...full vault text..." }` — the entire vault as plaintext. Parse it yourself to find what you need.

### How it works
- AES-256-GCM encryption key is **hardware-backed** (Android Keystore, TEE/StrongBox)
- Key **never leaves the phone** — decryption happens on-device after biometric auth
- Vault contents synced from a Google Doc via `sync.js`
- Phone API endpoints: `/vault/sync`, `/vault/read`, `/vault/status` on port 8888

### Vault format
The vault is unstructured text — service names followed by credentials. Example:
```
chase:
<<REPLACE: your-secondary-account>>
myPassword123

github:
<<REPLACE: your secondary email>>
anotherPassword
```

Parse by searching for the service name, then grab the lines below it.

### If the tool fails
- Check phone is reachable: `curl http://<<REPLACE: your phone Tailscale IP (tailscale ip -4 on the device)>>:8888/health`
- If "Connection refused" — the Homestead app isn't running on Josh's phone
- If "fetch failed" — phone may be asleep or Tailscale is down
- The tool wakes the screen automatically before requesting biometric

### Re-syncing the vault
If the Google Doc has been updated:
```bash
node <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/mcp-servers/passwords/sync.js
```
This fetches the doc and re-encrypts it on the phone (requires fingerprint).

---

## Android App (APK)

The Android app lives in `/mobile` and wraps the web interface in a native shell.

### Building and Deploying

**JOSHUA INSTALLS THE APK, NOT YOU.** You build it and put it where the app can
find it; he taps the "⬆ UPDATE AVAILABLE" banner inside the app on his own
phone. That is the whole delivery path.

> Josh 2026-09-09: *"include in the future instructions that joshua will push the
> download button on his side — you don't have to do that."*

Do NOT try to install it yourself. ADB is normally unavailable (USB unplugged,
and adb-over-network refused), so `adb install` is not the path — and you should
not go hunting for a way around that. Build, copy, tell him. He taps.

```bash
# 1. Build (from your worktree, or from prod main — see the shared-file warning below)
cd <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/mobile && ./gradlew assembleDebug

# 2. Put it where the in-app updater looks. THIS is the delivery step.
cp <worktree>/mobile/app/build/outputs/apk/debug/app-debug.apk \
   <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/mobile/app/build/outputs/apk/debug/app-debug.apk

# 3. Confirm the updater sees it — expect available:true at your new size/time
curl -s http://localhost:3005/api/mobile-update
```

Then your card says: **open the app and tap UPDATE.**

The app compares the file's `lastModified` against the last download time, so a
fresh copy with a newer timestamp is what raises the banner.

**Each tap costs Joshua something — batch your changes.** Every fix that needs a
new APK is another interruption for him. Get as much right as you can before
asking, and expect that a mistake mid-task means asking again.

### Verifying on the phone WITHOUT driving his screen

Josh uses this phone all day, and there is normally no screenshot endpoint and no
accessibility service, so you cannot see what is on his screen. Two rules that
fall out of that, both learned the hard way:

1. **Never blind-tap his live screen to test.** Add a diagnostic endpoint in
   `ApiServerService.kt` instead — `/wallpaper-debug` and `/rail-debug` are the
   existing examples. Read the LIVE state (does the window actually exist?), not
   a mirror of what the code last decided.
2. **Prefer a self-recording log over remote-driving.** Driving the phone to force
   a test state loses a race with his screen timeout — holding the app foreground
   long enough to switch modes AND raise a keyboard does not reliably work.
   `/rail-debug/history` is the pattern that does: the feature records each
   distinct decision with its inputs, his ordinary use writes the evidence, and
   you read it back later. No screen time needed, and it captures real behaviour
   rather than a driven simulation.

**Always carry a build marker** in such an endpoint (e.g. `railBuild`) and bump it
on every behavioural change, so a fix can never be "verified" against an install
that predates it. Note `wallpaperFixBuild` reports the *service process's* build
rather than the installed one — a new endpoint's mere existence is a stronger
signal, since the old build 404s it.

### App Structure

- **HomesteadFragment** - Main WebView (loads `/`)
- **StatusFragment** - Native status screen
- **RemoteFragment** - Remote control WebView (loads `/remote`)
- **HomesteadBottomBar** - Custom bottom navigation (HOME, STATUS, REMOTE, TYPE, MIC)
- **MainActivity** - Fragment management and input handling




<!-- creed-reaches-cwd -->
# Your worker creed (HOW you work — read this first)

The steward creed below is MANDATORY and governs how you operate,
how you reach Joshua, and how you finish. It is imported here because
this directory is your cwd; the creed itself lives outside it.

@<<REPLACE: your home dir, e.g. /Users/you>>/.homestead/stewards/homestead/workers/worker-time-pill/CLAUDE.md
