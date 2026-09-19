#!/bin/bash
# check-qa-marathon.sh — Watchdog for the QA marathon session
# Ensures holler-venture--audit-ops--qa stays alive and working.
# Called by the Rooster's qa-marathon-watchdog scheduled job (every 15 min).

set -euo pipefail

SESSION="holler-venture--audit-ops--qa"
ACTIVITY_FILE="/tmp/claude-session-${SESSION}-activity.json"
CWD="$HOME/.homestead/stewards/venture/substewards/audit-ops/substewards/qa"

# Resolve the NEWEST-version claude binary — NOT PATH-order. Under the launchd
# env /opt/homebrew/bin (stale 1.0.65, retired-model opus alias → 404) precedes
# ~/.local/bin (current). Probe candidates by --version, pick highest semver.
resolve_claude_path() {
  local best="" best_key=0 bin ver key
  local candidates=("$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude)
  local which_claude
  which_claude=$(which claude 2>/dev/null) && candidates+=("$which_claude")
  for bin in "${candidates[@]}"; do
    [ -x "$bin" ] || continue
    ver=$("$bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    [ -n "$ver" ] || continue
    # Zero-pad each component to a sortable integer key (supports up to 999).
    key=$(echo "$ver" | awk -F. '{ printf "%03d%03d%03d", $1, $2, $3 }')
    if [ "$key" -gt "$best_key" ]; then best_key=$key; best=$bin; fi
  done
  if [ -n "$best" ]; then echo "$best"
  elif [ -x "$HOME/.local/bin/claude" ]; then echo "$HOME/.local/bin/claude"
  else which claude 2>/dev/null || echo "$HOME/.local/bin/claude"
  fi
}
CLAUDE_PATH=$(resolve_claude_path)

# Build --add-dir flags
ADD_DIRS=""
for dir in "$HOME/code"/*/; do
  [ -d "$dir" ] && ADD_DIRS="$ADD_DIRS --add-dir \"$dir\""
done

# 1. Check if tmux session exists
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "SESSION MISSING — starting fresh"
  eval tmux new-session -d -s "$SESSION" -c "$CWD" "\"$CLAUDE_PATH\" --dangerously-skip-permissions $ADD_DIRS; zsh"
  echo '{"is_working":false}' > "$ACTIVITY_FILE"
  echo "STARTED"
  exit 0
fi

# 2. Check if Claude is running (not just a shell)
SCREEN=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -5)
if echo "$SCREEN" | grep -qE '^\$|^joshuamullet@|^❯ $|Resume this session'; then
  echo "CLAUDE DEAD (shell prompt) — restarting fresh"
  tmux send-keys -t "$SESSION" "\"$CLAUDE_PATH\" --dangerously-skip-permissions $ADD_DIRS" Enter
  echo '{"is_working":false}' > "$ACTIVITY_FILE"
  echo "RESTARTED"
  exit 0
fi

# 3. Session exists and Claude is running — ping audit-ops for status
echo "OK — session alive and Claude running"

# Send status check request to audit-ops via walkie-talkie
QUEUE_FILE="$HOME/.homestead/queue.json"
node -e "
const fs = require('fs');
const queue = JSON.parse(fs.readFileSync('$QUEUE_FILE', 'utf-8'));
// Dedup: skip if there's already a pending QA status check
const hasPending = queue.some(q =>
  q.target_session === 'holler-venture--audit-ops' &&
  q.status === 'pending' &&
  q.message.includes('qa_status_check')
);
if (hasPending) {
  console.log('Status check already queued, skipping');
  process.exit(0);
}
queue.push({
  id: Date.now() + '-qa-status-ping',
  target_session: 'holler-venture--audit-ops',
  type: 'action',
  message: JSON.stringify({
    type: 'action',
    trigger: 'qa_status_check',
    from: 'qa-marathon-watchdog',
    instruction: 'QA Marathon status check (every 10 min). How is QA progressing? Check holler-venture--audit-ops--qa and report a brief status update. If stuck or idle, investigate and nudge.'
  }),
  status: 'pending',
  created_at: new Date().toISOString(),
  attempts: 0
});
// ATOMIC (torn-read fix 2026-08-25): temp+rename so the dispatcher never reads
// a half-written queue.json. rename() within one fs is atomic.
const tmp='$QUEUE_FILE'+'.tmp-'+process.pid+'-'+Date.now();
fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
fs.renameSync(tmp, '$QUEUE_FILE');
console.log('Status check sent to audit-ops');
" 2>/dev/null

echo "STATUS CHECK PINGED"
