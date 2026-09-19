#!/bin/bash
# PM2 Startup Script for launchd
# This script is called by com.PM2 LaunchAgent on boot.
# It starts the PM2 daemon and resurrects saved processes.
#
# Logs to /tmp/pm2-startup.log (persistent across PM2 restarts, cleared on reboot)

# Raise FD soft limit. launchd hands children 256 by default; Next dev's
# fs.watch hits it and routes start 404-ing because lazy compile can't
# register new watchers. Hard limit is unlimited, so this is safe.
ulimit -n 65536

LOG="/tmp/pm2-startup.log"
PM2="<<REPLACE: your home dir, e.g. /Users/you>>/.nvm/versions/node/v22.22.0/lib/node_modules/pm2/bin/pm2"
NODE="<<REPLACE: your home dir, e.g. /Users/you>>/.nvm/versions/node/v22.22.0/bin/node"
DUMP="<<REPLACE: your home dir, e.g. /Users/you>>/.pm2/dump.pm2"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [pm2-startup] $1" >> "$LOG"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [pm2-startup] $1"
}

log "=========================================="
log "=== PM2 STARTUP SCRIPT INVOKED ==="
log "=========================================="
log "PID: $$"
log "PPID: $PPID"
log "USER: $(whoami)"
log "HOME: $HOME"
log "PATH: $PATH"
log "PWD: $(pwd)"
log "Node version: $($NODE --version 2>&1)"
log "PM2 path: $PM2"
log "PM2 exists: $([ -f "$PM2" ] && echo 'YES' || echo 'NO')"
log "Dump file exists: $([ -f "$DUMP" ] && echo 'YES' || echo 'NO')"
if [ -f "$DUMP" ]; then
  log "Dump file size: $(wc -c < "$DUMP") bytes"
  log "Dump file modified: $(stat -f '%Sm' "$DUMP" 2>/dev/null || stat -c '%y' "$DUMP" 2>/dev/null)"
fi

# Check if PM2 daemon is already running
PM2_PID_FILE="<<REPLACE: your home dir, e.g. /Users/you>>/.pm2/pm2.pid"
if [ -f "$PM2_PID_FILE" ]; then
  EXISTING_PID=$(cat "$PM2_PID_FILE")
  if kill -0 "$EXISTING_PID" 2>/dev/null; then
    log "PM2 daemon already running at PID $EXISTING_PID"
    log "Will check if processes are alive..."
    RUNNING=$("$PM2" jlist 2>/dev/null | "$NODE" -e "
      let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try{const p=JSON.parse(d);console.log(p.filter(x=>x.pm2_env.status==='online').length+'/'+p.length+' online')}
        catch(e){console.log('parse-error')}
      })
    " 2>&1)
    log "Current PM2 status: $RUNNING"
    if echo "$RUNNING" | grep -qE "^[1-9][0-9]*/"; then
      log "Processes appear healthy: $RUNNING"
      log "=== PM2 STARTUP COMPLETE (already running) ==="
      exit 0
    else
      log "No healthy processes (status: $RUNNING), will resurrect..."
    fi
  else
    log "Stale PM2 PID file found (PID $EXISTING_PID not running), will start fresh"
    rm -f "$PM2_PID_FILE"
  fi
else
  log "No PM2 PID file found, starting fresh"
fi

# Kill any orphaned PM2 God daemon
log "Checking for orphaned PM2 processes..."
ORPHANS=$(pgrep -f "PM2.*God Daemon" 2>/dev/null)
if [ -n "$ORPHANS" ]; then
  log "Found orphaned PM2 God daemon PIDs: $ORPHANS"
  log "Killing orphans..."
  "$PM2" kill >> "$LOG" 2>&1
  sleep 2
  log "Orphan cleanup done"
else
  log "No orphaned PM2 processes found"
fi

# Start PM2 and resurrect
log "--- Starting PM2 resurrect ---"
RESURRECT_OUTPUT=$("$PM2" resurrect 2>&1)
RESURRECT_EXIT=$?
log "PM2 resurrect exit code: $RESURRECT_EXIT"
log "PM2 resurrect output:"
echo "$RESURRECT_OUTPUT" | while IFS= read -r line; do
  log "  | $line"
done

# Verify processes came up
sleep 3
log "--- Post-resurrect verification ---"
STATUS_OUTPUT=$("$PM2" list 2>&1)
log "PM2 list output:"
echo "$STATUS_OUTPUT" | while IFS= read -r line; do
  log "  | $line"
done

# Kick any process that resurrect left in a non-online state.
# If PM2 daemon was killed mid-stop on shutdown (SIGTERM race), the
# dump.pm2 captures status=stopped for that process and `pm2 resurrect`
# honors that, leaving the service down across reboot. Treat every dump
# entry as required — if it's not online after resurrect, explicitly start it.
log "--- Kicking any non-online processes from resurrect ---"
KICK_LIST=$("$PM2" jlist 2>/dev/null | "$NODE" -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try {
      const procs = JSON.parse(d);
      procs.filter(p => p.pm2_env.status !== 'online')
           .forEach(p => console.log(p.pm2_env.name + '|' + p.pm2_env.status));
    } catch(e) { console.error('parse-error:', e.message); }
  })
" 2>&1)
if [ -n "$KICK_LIST" ]; then
  log "Found non-online processes to kick:"
  echo "$KICK_LIST" | while IFS='|' read -r name status; do
    [ -z "$name" ] && continue
    log "  -> starting $name (was $status)"
    "$PM2" start "$name" >> "$LOG" 2>&1
  done
  sleep 3
  log "Post-kick PM2 list:"
  "$PM2" list 2>&1 | while IFS= read -r line; do log "  | $line"; done
else
  log "All processes online after resurrect — nothing to kick."
fi

# Check each process individually
JLIST=$("$PM2" jlist 2>/dev/null)
PROCESS_REPORT=$( echo "$JLIST" | "$NODE" -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try {
      const procs = JSON.parse(d);
      procs.forEach(p => {
        const env = p.pm2_env;
        console.log(JSON.stringify({
          name: env.name,
          status: env.status,
          pid: p.pid,
          restart_time: env.restart_time,
          uptime: env.pm_uptime ? Date.now() - env.pm_uptime : 'N/A',
          script: env.pm_exec_path
        }));
      });
    } catch(e) {
      console.log('ERROR: ' + e.message);
    }
  })
" 2>&1)
log "Process details:"
echo "$PROCESS_REPORT" | while IFS= read -r line; do
  log "  | $line"
done

# Save the dump so next resurrect has fresh state
log "Saving PM2 process list for future resurrects..."
"$PM2" save >> "$LOG" 2>&1
log "PM2 save exit code: $?"

log "=== PM2 STARTUP COMPLETE ==="
log "=========================================="

# IMPORTANT: This script must NOT exit if launchd KeepAlive is false.
# Since pm2 resurrect is a one-shot command, we exit cleanly.
exit 0
