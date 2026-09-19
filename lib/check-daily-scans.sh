#!/bin/bash
# check-daily-scans.sh — Covered Bridge daily scan watchdog
#
# Invoked by Rooster every 30 minutes via the venture-daily-scans-watchdog
# recurring job.
#
# Queries Firestore for active customers, checks whether each has a scan
# for today (Eastern time), and either stays quiet, walkie-talkies Audit
# Ops to dispatch scans, or escalates to Joshua via SMS.
#
# Full spec: ~/.homestead/stewards/venture/substewards/audit-ops/TRACK-2-SPEC.md

set -euo pipefail

LOCK_FILE="/tmp/daily-scans-watchdog.lock"
WORKER_SCRIPT="<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/lib/check-daily-scans.js"

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -lt 600 ]; then
    echo "Previous watchdog run still in flight (lock age ${LOCK_AGE}s), exiting"
    exit 0
  fi
  echo "Stale lock file (${LOCK_AGE}s old), clearing"
  rm -f "$LOCK_FILE"
fi

touch "$LOCK_FILE"
trap "rm -f $LOCK_FILE" EXIT

# Run the actual logic in Node so we can talk to Firestore
cd <<REPLACE: your home dir, e.g. /Users/you>>/code/covered-bridge
node "$WORKER_SCRIPT"
