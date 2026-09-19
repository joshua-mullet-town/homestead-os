# Chrome Debug Profile & Rosetta Fix

## The Problem

Two issues were discovered when setting up Chrome for MCP DevTools automation:

1. **Chrome 136+ Security Change**: `--remote-debugging-port` no longer works with your default profile. You must use `--user-data-dir` to point to a separate profile directory.

2. **Rosetta Performance Issue**: Chrome on Apple Silicon was silently running via Rosetta (x86 emulation) instead of native ARM64, causing **84% CPU usage** on renderer processes.

## Symptoms of Rosetta Issue

- Chrome is extremely slow/sluggish
- Renderer processes showing 70-100% CPU in Activity Monitor
- Running `lsof -p <chrome-pid> | grep rosetta` shows references to Rosetta runtime

## The Fix

### 1. Create Debug Profile Directory

```bash
mkdir -p ~/chrome-debug-profile
```

### 2. Always Launch with `arch -arm64`

The key fix is forcing ARM64 architecture when launching Chrome:

```bash
/usr/bin/arch -arm64 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 \
    --user-data-dir="$HOME/chrome-debug-profile" \
    --no-first-run \
    --no-default-browser-check
```

### 3. Launcher Scripts

**CLI Script** (`~/.local/bin/chrome-debug`):
```bash
#!/bin/bash
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEBUG_PORT=9222
PROFILE_DIR="$HOME/chrome-debug-profile"

if lsof -i :$DEBUG_PORT >/dev/null 2>&1; then
    echo "Chrome debug already running on port $DEBUG_PORT"
    osascript -e 'tell application "Google Chrome" to activate' 2>/dev/null
    exit 0
fi

echo "Launching Chrome with remote debugging on port $DEBUG_PORT..."
/usr/bin/arch -arm64 "$CHROME_APP" \
    --remote-debugging-port=$DEBUG_PORT \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    "$@" &

sleep 2
if lsof -i :$DEBUG_PORT >/dev/null 2>&1; then
    echo "✅ Chrome debug running on port $DEBUG_PORT"
else
    echo "❌ Failed to start Chrome debug"
    exit 1
fi
```

**Dock App** (`~/Applications/Chrome Debug.app/Contents/MacOS/Chrome Debug`):
```bash
#!/bin/bash
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEBUG_PORT=9222
PROFILE_DIR="<<REPLACE: your home dir, e.g. /Users/you>>/chrome-debug-profile"

if /usr/sbin/lsof -i :$DEBUG_PORT 2>/dev/null | grep -q LISTEN; then
    /usr/bin/osascript -e 'tell application "Google Chrome" to activate' 2>/dev/null
    exit 0
fi

exec /usr/bin/arch -arm64 "$CHROME_APP" \
    --remote-debugging-port=$DEBUG_PORT \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check
```

## Diagnosing the Issue

### Check if Chrome is using Rosetta

```bash
# Get Chrome process IDs
pgrep -f "Google Chrome"

# Check for Rosetta references (should return 0 for native ARM64)
lsof -p <pid> | grep -c rosetta
```

### Check CPU usage

```bash
ps aux | grep "Google Chrome" | grep -v grep | awk '{print $2, $3, $4}'
```

- **Before fix**: 84% CPU on renderer processes
- **After fix**: ~11% CPU on renderer processes

### Reset LaunchServices (if needed)

If Chrome keeps launching in Rosetta mode:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -kill -r -domain local -domain system -domain user
```

Then relaunch Chrome with `arch -arm64`.

## Why This Happens

Chrome on Apple Silicon includes both x86_64 and ARM64 binaries (universal binary). macOS can silently choose the x86 version in certain scenarios:

- "Open using Rosetta" was checked in Finder's Get Info at some point
- A stale LaunchServices preference from an old install
- Profile migration from an Intel Mac

The `arch -arm64` prefix explicitly forces the native ARM64 binary, bypassing any cached preferences.

## Files Created

| File | Purpose |
|------|---------|
| `~/chrome-debug-profile/` | Isolated profile directory (stores logins/cookies) |
| `~/.local/bin/chrome-debug` | CLI launcher script |
| `~/Applications/Chrome Debug.app` | Dock app with custom "DBG" badge icon |
| `~/Library/LaunchAgents/com.user.chrome-debug.plist` | LaunchAgent for auto-start (optional) |

## Usage

Once set up, any Claude session can use the `mcp__chrome-devtools__*` tools to:
- Navigate to authenticated pages
- Take screenshots
- Fill forms
- Click elements
- Check network requests
- Run JavaScript

The debug profile persists your logins, so you don't have to re-authenticate.
