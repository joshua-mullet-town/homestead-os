#!/bin/bash
# Toggle Outdoor Lights via Homestead Mobile API
# Runs every 5 minutes via cron

PHONE_API="http://100.84.84.102:8888"
LOG_FILE="/tmp/outdoor-lights-toggle.log"

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

if echo "$STATUS" | grep -q "off"; then
    log "Outdoor Lights currently OFF - turning ON"
    ACTION="turning ON"
else
    log "Outdoor Lights currently ON - turning OFF"
    ACTION="turning OFF"
fi

# Tap the toggle icon (right side of Outdoor Lights row)
# Toggle icon bounds: left=906, top=1013, right=1013, bottom=1120
# Center: x=959, y=1066
curl -s -X POST "$PHONE_API/screen/tap" \
    -H "Content-Type: application/json" \
    -d '{"x": 959, "y": 1066}' > /dev/null

sleep 1

# Go back home
curl -s -X POST "$PHONE_API/screen/home" > /dev/null

log "SUCCESS: Toggled Outdoor Lights ($ACTION)"
