#!/bin/bash
# Turn OFF Outdoor Lights via Homestead Mobile API
# Runs at 9:00 PM via cron

PHONE_API="http://100.84.84.102:8888"
LOG_FILE="/tmp/outdoor-lights.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$LOG_FILE"
}

# Check if phone is reachable
if ! curl -s --connect-timeout 5 "$PHONE_API/health" > /dev/null 2>&1; then
    log "ERROR: Phone not reachable"
    exit 1
fi

# Wake screen and unlock
curl -s -X POST "$PHONE_API/screen/wake" > /dev/null
sleep 0.5
curl -s -X POST "$PHONE_API/screen/swipe" \
    -H "Content-Type: application/json" \
    -d '{"startX": 540, "startY": 2000, "endX": 540, "endY": 500, "durationMs": 100}' > /dev/null
sleep 0.5

# Go home first
curl -s -X POST "$PHONE_API/screen/home" > /dev/null
sleep 0.5

# Open Kasa
curl -s -X POST "$PHONE_API/screen/click" \
    -H "Content-Type: application/json" \
    -d '{"text": "Kasa"}' > /dev/null
sleep 2

# Get current state of Outdoor Lights
STATUS=$(curl -s "$PHONE_API/screen/content" | grep -o '"Outdoor Lights, Status [^"]*"' | head -1)

if echo "$STATUS" | grep -q "on"; then
    log "Outdoor Lights ON - turning OFF"
    # Tap the toggle icon (right side of Outdoor Lights row)
    curl -s -X POST "$PHONE_API/screen/tap" \
        -H "Content-Type: application/json" \
        -d '{"x": 959, "y": 1066}' > /dev/null
    sleep 1
    log "SUCCESS: Turned OFF Outdoor Lights"
else
    log "Outdoor Lights already OFF - no action needed"
fi

# Go back home
curl -s -X POST "$PHONE_API/screen/home" > /dev/null
