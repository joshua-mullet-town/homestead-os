#!/bin/bash
# check-homestead.sh — Check Homestead server health
# API responsiveness, job scheduler, presenter queue

set -euo pipefail

FAILURES=0

# API health
# NOTE: --max-time is critical. This script runs inside the Homestead server's
# event loop (via execSync in job-scheduler.js). While the scheduler blocks,
# the server can't answer localhost:3005 — without --max-time the curl hangs
# forever and we deadlock at the scheduler's 2-minute timeout.
if curl -s --connect-timeout 5 --max-time 8 "http://localhost:3005/api/jobs" | grep -q '"jobs"' 2>/dev/null; then
  echo "[api] OK"
else
  echo "[api] UNRESPONSIVE"
  FAILURES=$((FAILURES + 1))
fi

# Presenter queue depth
QUEUE_DEPTH=$(curl -s --connect-timeout 5 --max-time 8 "http://localhost:3005/api/presenter/queue" 2>/dev/null | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try { const q=JSON.parse(d); console.log((q.items||q.queue||[]).length); }
    catch { console.log('error'); }
  });
" 2>/dev/null || echo "error")
echo "[presenter_queue] $QUEUE_DEPTH items"

# tmux sessions count
TMUX_COUNT=$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')
echo "[tmux_sessions] $TMUX_COUNT"

echo ""
if [ $FAILURES -gt 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
else
  echo "Homestead healthy"
fi
