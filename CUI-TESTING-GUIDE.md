# CUI Testing Guide

## What is CUI?

**CUI = "Common Agent UI"** - It's a modern web application that gives you a prettier, mobile-friendly interface to interact with Claude Code instead of using the raw terminal.

Think of it like this:
- **Before:** Raw terminal with xterm.js (clunky on mobile)
- **With CUI:** Chat-style web UI with mobile optimization

## ✅ CUI is Now Running!

**Access URL:**
```
http://localhost:3001#token=993093cbf9c71678d44675ca879c5a9c
```

**From your phone on local network:**
1. Find your Mac's IP address (it's `<<REPLACE: your LAN IP>>` based on your network)
2. Open: `http://<<REPLACE: your LAN IP>>:3001#token=993093cbf9c71678d44675ca879c5a9c`

## What CUI Actually Does

### Backend
- Wraps the **real Claude Code CLI** (uses `@anthropic-ai/claude-code` package)
- Runs Claude Code sessions in the background
- Manages multiple concurrent sessions
- Stores session history in SQLite database

### Frontend
- Modern React web UI (NOT a terminal)
- Chat-style interface for talking to Claude
- Mobile-responsive design
- PWA support (add to home screen)

### Mobile-Specific Features
✅ **iOS Dictation** - Voice input powered by Gemini 2.5 Flash (requires HTTPS + Google API key)
✅ **Responsive Design** - Works well on mobile browsers
✅ **Push Notifications** - Get notified when tasks complete
✅ **Background Tasks** - Sessions continue running after closing browser
✅ **Mobile Navigation** - Touch-friendly UI

## Does CUI Have ALL Claude Code Features?

Let me check what's supported...

### ✅ Confirmed Features (From README):
- **Slash commands** - `/init`, `/help`, etc. all work
- **File references** - `@file.txt` syntax works
- **Context tracking** - Full Claude Code context management
- **Tool usage** - All Claude Code tools (Read, Write, Edit, Bash, etc.)
- **Session management** - Fork, resume, archive conversations
- **Multi-model support** - Can use different LLM providers
- **Autocompletion** - Same as CLI
- **History** - Automatically scans `~/.claude/` for existing sessions

### ❓ Unknown (Need to Test):
- **Mobile keyboard shortcuts** - How well do slash commands work on mobile keyboard?
- **Context display** - Can you see remaining context tokens?
- **Terminal output** - How are Bash command outputs displayed?
- **File diffs** - How are code edits shown in the UI?

### ⚠️ Potential Limitations:
- **Dictation requires HTTPS** - iOS only allows microphone on secure connections
  - Need Caddy reverse proxy or similar for production
  - Need Google Gemini API key
- **No direct terminal access** - It's a chat UI, not a terminal emulator
  - Pro: Better for mobile
  - Con: Can't see raw terminal if you prefer that

## Testing Checklist

### On Your Computer (http://localhost:3001):
1. ✅ **Open the URL** - See if the UI loads
2. ❓ **Start a conversation** - Try asking Claude to do something
3. ❓ **Test slash commands** - Type `/help` and see what shows up
4. ❓ **Test file references** - Try `@package.json` or similar
5. ❓ **Check context display** - Can you see token count anywhere?
6. ❓ **Test tools** - Ask Claude to read a file, see how output looks
7. ❓ **Background tasks** - Start a task, close browser, reopen - is it still running?

### On Your Phone (http://<<REPLACE: your LAN IP>>:3001):
1. ❓ **Open URL on mobile browser** (Safari on iOS, Chrome on Android)
2. ❓ **Test mobile responsiveness** - Does it look good on small screen?
3. ❓ **Test typing** - Can you easily type messages on mobile keyboard?
4. ❓ **Test slash commands on mobile** - Can you type `/` easily?
5. ❓ **Test `@` file references** - Mobile keyboard friendly?
6. ❓ **Try to add to home screen** (PWA test)
7. ❌ **Dictation** - Won't work on HTTP (need HTTPS setup)

## What I Need You To Report Back

### Critical Questions:
1. **Does the UI load?** (localhost and mobile)
2. **Can you start a Claude Code session?**
3. **Do slash commands work?** (`/help`, `/init`, etc.)
4. **Can you see context/token usage?**
5. **How does mobile experience feel?** (better than terminal? worse?)
6. **Are code diffs/edits readable on mobile?**
7. **Is anything obviously broken or missing?**

### Comparison to Terminal:
- **Better:** What's improved compared to your xterm.js terminal?
- **Worse:** What's missing or harder to use?
- **Mobile:** Is this actually more mobile-friendly?

## Configuration Files

CUI created these on your system:
- **Config:** `~/.cui/config.json` - Server settings, auth token
- **Database:** `~/.cui/session-info.db` - Session metadata
- **MCP Config:** Temp file for Model Context Protocol integration

## Next Steps Based on Testing

### If It Works Great:
1. We can adapt CUI's UI patterns to Homestead
2. Add HTTPS (Caddy) for iOS dictation
3. Set up Google Gemini API key for voice input
4. Maybe even replace your terminal view with CUI's approach

### If It's Missing Features:
1. Identify what's missing
2. Decide if we build custom (Agent SDK approach)
3. Or stick with enhanced xterm.js terminal

### If It's Not Mobile-Friendly:
1. Try the Agent SDK custom UI approach instead
2. Or do incremental xterm.js improvements

## How to Stop CUI

CUI is running in the background. To stop it:
```bash
# Find the process
ps aux | grep "cui-server"

# Kill it
pkill -f "cui-server"
```

Or I can stop it for you when you're done testing.

## Location

CUI source code is at:
```
<<REPLACE: your home dir, e.g. /Users/you>>/code/cui/
```

You can explore the code if you want to see how they built it!

---

## TL;DR

1. **Open:** http://localhost:3001#token=993093cbf9c71678d44675ca879c5a9c
2. **Test:** Try using it like you would Claude Code CLI
3. **Report:** Tell me what works, what doesn't, and if mobile feels better
4. **Decide:** Keep using it? Adapt it? Try something else?
