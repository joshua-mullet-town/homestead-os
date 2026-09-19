#!/bin/bash
# run-health-checks.sh — Runs system health check scripts
# Called by the Rooster's system-health-check scheduled job (every 15 min).

set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS=""
FAILURES=0

run_check() {
  local name="$1"
  local script="$2"

  if [ -f "$script" ]; then
    local output
    if output=$(bash "$script" 2>&1); then
      RESULTS="${RESULTS}[${name}] OK\n${output}\n\n"
    else
      RESULTS="${RESULTS}[${name}] FAILED\n${output}\n\n"
      FAILURES=$((FAILURES + 1))
    fi
  else
    RESULTS="${RESULTS}[${name}] SKIP: script not found at ${script}\n\n"
  fi
}

# Run each health check
run_check "connections" "$TOOLS_DIR/check-connections.sh"
run_check "vitals" "$TOOLS_DIR/check-vitals.sh"
run_check "homestead" "$TOOLS_DIR/check-homestead.sh"

# Output summary
echo -e "$RESULTS"
if [ $FAILURES -gt 0 ]; then
  echo "Health check completed with $FAILURES failure(s)"
  exit 1
else
  echo "All health checks passed"
fi
