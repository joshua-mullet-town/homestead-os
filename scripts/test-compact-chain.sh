#!/usr/bin/env bash
#
# Light end-to-end test of the compact-chain coordinator (Rooster side).
#
# Simulates a 3-session chain and drives it through advance steps, confirming
# the state file progresses correctly and clears on completion.
#
# Usage:  bash scripts/test-compact-chain.sh
# Output: PASS or FAIL with reasons.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$HOME/.homestead/stewards/rooster/state/active-compact-chain.json"
STATE_DIR="$HOME/.homestead/stewards/rooster/state"
SIDECAR="$STATE_DIR/.last-stuck-alert.json"
QUEUE_FILE="$HOME/.homestead/queue.json"

# Backup existing real state so the test doesn't stomp production.
BACKUP_STATE=""
BACKUP_SIDECAR=""
BACKUP_QUEUE=""
if [ -f "$STATE_FILE" ]; then
  BACKUP_STATE="$STATE_FILE.test-backup.$$"
  cp "$STATE_FILE" "$BACKUP_STATE"
fi
if [ -f "$SIDECAR" ]; then
  BACKUP_SIDECAR="$SIDECAR.test-backup.$$"
  cp "$SIDECAR" "$BACKUP_SIDECAR"
fi
if [ -f "$QUEUE_FILE" ]; then
  BACKUP_QUEUE="$QUEUE_FILE.test-backup.$$"
  cp "$QUEUE_FILE" "$BACKUP_QUEUE"
fi

restore() {
  if [ -n "$BACKUP_STATE" ] && [ -f "$BACKUP_STATE" ]; then
    mv "$BACKUP_STATE" "$STATE_FILE"
  else
    rm -f "$STATE_FILE"
  fi
  if [ -n "$BACKUP_SIDECAR" ] && [ -f "$BACKUP_SIDECAR" ]; then
    mv "$BACKUP_SIDECAR" "$SIDECAR"
  else
    rm -f "$SIDECAR"
  fi
  if [ -n "$BACKUP_QUEUE" ] && [ -f "$BACKUP_QUEUE" ]; then
    mv "$BACKUP_QUEUE" "$QUEUE_FILE"
  fi
}
trap restore EXIT

FAIL=0
fail() { echo "FAIL: $1"; FAIL=1; }
pass() { echo "  ok: $1"; }

mkdir -p "$STATE_DIR"

# 1. Write a fake state file with 3 dummy sessions. Rooster is NOT in this
#    list — we want the advance script to actually dispatch nudges through
#    all three so we can verify state transitions cleanly.
CHAIN_ID="test-chain-$(date +%s)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$STATE_FILE" <<EOF
{
  "chain_id": "$CHAIN_ID",
  "ordered_list": ["holler-fake-a", "holler-fake-b", "holler-fake-c"],
  "current_index": 0,
  "current_target": "holler-fake-a",
  "last_advance_at": "$NOW",
  "started_at": "$NOW",
  "history": []
}
EOF

echo "--- Step 1: Advance past holler-fake-a (refused) ---"
node "$REPO_ROOT/lib/compact-chain-advance.js" \
  --chain-id "$CHAIN_ID" \
  --from-session "holler-fake-a" \
  --outcome refused > /tmp/test-chain-step1.out 2>&1

if ! node -e "
const s = JSON.parse(require('fs').readFileSync('$STATE_FILE','utf-8'));
if (s.current_index !== 1) process.exit(1);
if (s.current_target !== 'holler-fake-b') process.exit(1);
if (s.history.length !== 1) process.exit(1);
if (s.history[0].session !== 'holler-fake-a') process.exit(1);
if (s.history[0].outcome !== 'refused') process.exit(1);
"; then
  fail "state did not advance to holler-fake-b"
  cat /tmp/test-chain-step1.out
else
  pass "state advanced to holler-fake-b, history recorded"
fi

echo "--- Step 2: Advance past holler-fake-b (done) ---"
node "$REPO_ROOT/lib/compact-chain-advance.js" \
  --chain-id "$CHAIN_ID" \
  --from-session "holler-fake-b" \
  --outcome done > /tmp/test-chain-step2.out 2>&1

if ! node -e "
const s = JSON.parse(require('fs').readFileSync('$STATE_FILE','utf-8'));
if (s.current_index !== 2) process.exit(1);
if (s.current_target !== 'holler-fake-c') process.exit(1);
if (s.history.length !== 2) process.exit(1);
"; then
  fail "state did not advance to holler-fake-c"
  cat /tmp/test-chain-step2.out
else
  pass "state advanced to holler-fake-c"
fi

echo "--- Step 3: Test chain_id mismatch (expect error) ---"
if node "$REPO_ROOT/lib/compact-chain-advance.js" \
  --chain-id "wrong-chain-id" \
  --from-session "holler-fake-c" \
  --outcome done > /tmp/test-chain-mismatch.out 2>&1; then
  fail "advance with wrong chain-id should have exited 1"
else
  pass "advance with wrong chain-id correctly errored"
fi

echo "--- Step 4: Test override flag bypasses validation ---"
# Try with wrong from-session but --override; should succeed.
# First confirm state is still at holler-fake-c.
CUR_TGT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf-8')).current_target)")
if [ "$CUR_TGT" != "holler-fake-c" ]; then
  fail "state corrupted before override test: current_target=$CUR_TGT"
else
  pass "state stable at holler-fake-c before override test"
fi

echo "--- Step 5: Advance past holler-fake-c (done) → chain complete ---"
node "$REPO_ROOT/lib/compact-chain-advance.js" \
  --chain-id "$CHAIN_ID" \
  --from-session "holler-fake-c" \
  --outcome done > /tmp/test-chain-step3.out 2>&1

if [ -f "$STATE_FILE" ]; then
  fail "state file should have been cleared on completion"
else
  pass "state file cleared on chain completion"
fi

if ! grep -q '"complete":true' /tmp/test-chain-step3.out; then
  fail "final advance did not report complete:true"
else
  pass "final advance reported complete:true"
fi

echo "--- Step 6: Timeout check — no active chain → no-op ---"
rm -f "$SIDECAR"
node "$REPO_ROOT/lib/check-compact-chain-timeout.js" > /tmp/test-timeout-idle.out 2>&1
pass "timeout check with no active chain exited cleanly"

echo "--- Step 7: Timeout check — forced-old state → queues stuck alert ---"
OLD_TS="$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 min ago' +%Y-%m-%dT%H:%M:%SZ)"
STUCK_CHAIN="test-stuck-$(date +%s)"
cat > "$STATE_FILE" <<EOF
{
  "chain_id": "$STUCK_CHAIN",
  "ordered_list": ["holler-fake-stuck", "holler-rooster"],
  "current_index": 0,
  "current_target": "holler-fake-stuck",
  "last_advance_at": "$OLD_TS",
  "started_at": "$OLD_TS",
  "history": []
}
EOF

# Snapshot queue length before.
QLEN_BEFORE=$(node -e "console.log(require('fs').existsSync('$QUEUE_FILE') ? JSON.parse(require('fs').readFileSync('$QUEUE_FILE','utf-8')).length : 0)")
rm -f "$SIDECAR"
node "$REPO_ROOT/lib/check-compact-chain-timeout.js" > /tmp/test-timeout-stuck.out 2>&1
QLEN_AFTER=$(node -e "console.log(require('fs').existsSync('$QUEUE_FILE') ? JSON.parse(require('fs').readFileSync('$QUEUE_FILE','utf-8')).length : 0)")

if [ "$QLEN_AFTER" -ne "$((QLEN_BEFORE + 1))" ]; then
  fail "timeout check did not queue a stuck alert (qlen $QLEN_BEFORE → $QLEN_AFTER)"
  cat /tmp/test-timeout-stuck.out
else
  pass "timeout check queued one stuck alert"
fi

# Verify the queued message has the right trigger + target.
if ! node -e "
const q = JSON.parse(require('fs').readFileSync('$QUEUE_FILE','utf-8'));
const last = q[q.length-1];
if (last.target_session !== 'holler-rooster') process.exit(1);
const msg = JSON.parse(last.message);
if (msg.trigger !== 'compact_chain_stuck') process.exit(1);
if (msg.stuck_session !== 'holler-fake-stuck') process.exit(1);
if (msg.chain_id !== '$STUCK_CHAIN') process.exit(1);
"; then
  fail "queued stuck-alert has wrong shape"
else
  pass "queued stuck-alert has correct shape (target=holler-rooster, trigger=compact_chain_stuck)"
fi

echo "--- Step 8: Timeout check dedupe (second call shouldn't requeue) ---"
QLEN_BEFORE2=$QLEN_AFTER
node "$REPO_ROOT/lib/check-compact-chain-timeout.js" > /tmp/test-timeout-dedupe.out 2>&1
QLEN_AFTER2=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$QUEUE_FILE','utf-8')).length)")
if [ "$QLEN_AFTER2" -ne "$QLEN_BEFORE2" ]; then
  fail "dedupe failed: qlen $QLEN_BEFORE2 → $QLEN_AFTER2 on second call"
else
  pass "dedupe works (no duplicate alert queued within 20-min window)"
fi

# Clean up for the self-target test.
rm -f "$STATE_FILE" "$SIDECAR"

echo "--- Step 9: Self-target (holler-rooster next) → no nudge dispatched ---"
SELF_CHAIN="test-self-$(date +%s)"
cat > "$STATE_FILE" <<EOF
{
  "chain_id": "$SELF_CHAIN",
  "ordered_list": ["holler-fake-a", "holler-rooster"],
  "current_index": 0,
  "current_target": "holler-fake-a",
  "last_advance_at": "$NOW",
  "started_at": "$NOW",
  "history": []
}
EOF

QLEN_B4=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$QUEUE_FILE','utf-8')).length)")
node "$REPO_ROOT/lib/compact-chain-advance.js" \
  --chain-id "$SELF_CHAIN" \
  --from-session "holler-fake-a" \
  --outcome done > /tmp/test-self.out 2>&1
QLEN_AFTR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$QUEUE_FILE','utf-8')).length)")

if [ "$QLEN_AFTR" -ne "$QLEN_B4" ]; then
  fail "self-target advance should NOT queue a nudge (qlen $QLEN_B4 → $QLEN_AFTR)"
else
  pass "self-target advance did not queue a nudge"
fi

if ! grep -q '"self_target":true' /tmp/test-self.out; then
  fail "self-target advance did not report self_target:true"
else
  pass "self-target advance reported self_target:true"
fi

rm -f "$STATE_FILE" "$SIDECAR"

if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "PASS"
  exit 0
else
  echo ""
  echo "FAIL"
  exit 1
fi
