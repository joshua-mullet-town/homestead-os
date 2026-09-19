# Server Management

How to safely restart dev servers without killing Claude sessions.

## Homestead Server (port 3005)

**Safe restart:**
```bash
lsof -ti:3005 | xargs kill -9 2>/dev/null
sleep 2
cd <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead && npm run dev > /tmp/homestead-server.log 2>&1 &
```

**Why this matters:**
- tmux sessions (Claude Code) are independent of the Homestead server
- They should survive server restarts
- If sessions die during restart, you killed Claude processes by accident

**NEVER use:**
```bash
# These patterns match Claude processes in homestead-related directories
pkill -f "node.*homestead"  # ❌ Kills Claude in homestead worktrees
pkill -f "next"              # ❌ Kills any Next.js process
```

**Verify after restart:**
```bash
# Check server is up
curl -sk https://localhost:3005/api/sessions | jq '.sessions | length'

# Check tmux sessions survived
tmux list-sessions
```

## Other Dev Servers

Same principle applies - kill by port, not by process name pattern:

```bash
# Kill whatever is on a specific port
lsof -ti:<PORT> | xargs kill -9 2>/dev/null
```
