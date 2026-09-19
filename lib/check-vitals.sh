#!/bin/bash
# check-vitals.sh — Check machine vitals
# CPU load, memory pressure, disk space

set -euo pipefail

FAILURES=0

# CPU load (1 min average)
LOAD=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}' || echo "0")
CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo "4")
echo "[cpu_load] $LOAD (${CORES} cores)"

# Memory pressure
MEM_PRESSURE=$(memory_pressure 2>/dev/null | grep "System-wide memory free percentage" | awk '{print $NF}' || echo "unknown")
echo "[memory_free] $MEM_PRESSURE"

# Disk space (root volume)
DISK_USED=$(df -h / 2>/dev/null | tail -1 | awk '{print $5}' || echo "unknown")
echo "[disk_used] $DISK_USED"

# Check thresholds
DISK_PCT=$(echo "$DISK_USED" | tr -d '%')
if [ "$DISK_PCT" -gt 90 ] 2>/dev/null; then
  echo "[WARN] Disk usage above 90%"
  FAILURES=$((FAILURES + 1))
fi

echo ""
if [ $FAILURES -gt 0 ]; then
  echo "$FAILURES vital(s) above threshold"
  exit 1
else
  echo "All vitals OK"
fi
