#!/bin/bash
# Watchdog health probe. Used by the 'watchdog-health' recurring job.
#
# Contract: exit 0 on healthy, non-zero on unhealthy. SPEC 1 tracker
# interprets any non-zero exit as a job failure — 2 consecutive misses
# walkie Rooster, 10 consecutive or 6h+ triggers an urgent presenter
# card. No local alert logic needed here; the scheduler handles it.
#
# Watchdog runs as a PM2 process on :3007. It's the service the phone
# recovery app hits, so keeping it alive is load-bearing.

set -u

PORT=3007
URL="http://localhost:${PORT}/"
TIMEOUT=5

CODE=$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null || echo "000")

if [ "$CODE" = "200" ]; then
  echo "watchdog OK (:${PORT} → 200)"
  exit 0
fi

echo "watchdog UNHEALTHY (:${PORT} → ${CODE})" >&2
exit 1
