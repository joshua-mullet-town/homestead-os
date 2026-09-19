#!/bin/bash
# Alert Triage System Tests
# Run these against a running Homestead server with the alert-triage code

BASE_URL="${1:-https://localhost:3005}"
CURL_OPTS="-sk"  # -s silent, -k ignore SSL cert
PASS=0
FAIL=0

echo "Testing Alert Triage System at $BASE_URL"
echo "==========================================="
echo ""

# Helper function
test_result() {
  if [ "$1" = "true" ]; then
    echo "  ✓ $2"
    ((PASS++))
  else
    echo "  ✗ $2"
    ((FAIL++))
  fi
}

# Clean up any existing test alerts
echo "Cleanup: Removing test alerts..."
curl $CURL_OPTS -X DELETE "$BASE_URL/api/alerts/test-alert-1" > /dev/null 2>&1
curl $CURL_OPTS -X DELETE "$BASE_URL/api/alerts/test-alert-2" > /dev/null 2>&1
curl $CURL_OPTS -X DELETE "$BASE_URL/api/alerts/test-snooze" > /dev/null 2>&1

echo ""
echo "1. Create Alert (POST /api/alerts)"
RESULT=$(curl $CURL_OPTS -X POST "$BASE_URL/api/alerts" \
  -H "Content-Type: application/json" \
  -d '{"id":"test-alert-1","source":"email","urgency":"soon","title":"Test Alert 1","context":"Test context","details":"Test details","suggested_action":"Do something"}')
SUCCESS=$(echo "$RESULT" | grep -c '"success":true')
test_result "$([ $SUCCESS -eq 1 ] && echo true)" "Created alert successfully"

echo ""
echo "2. List Alerts (GET /api/alerts)"
RESULT=$(curl $CURL_OPTS "$BASE_URL/api/alerts")
HAS_ALERT=$(echo "$RESULT" | grep -c '"test-alert-1"')
test_result "$([ $HAS_ALERT -ge 1 ] && echo true)" "Alert appears in list"

echo ""
echo "3. Get Single Alert (GET /api/alerts/:id)"
RESULT=$(curl $CURL_OPTS "$BASE_URL/api/alerts/test-alert-1")
HAS_TITLE=$(echo "$RESULT" | grep -c '"title":"Test Alert 1"')
test_result "$([ $HAS_TITLE -eq 1 ] && echo true)" "Can retrieve single alert"

echo ""
echo "4. Duplicate Rejection (POST /api/alerts with same ID)"
RESULT=$(curl $CURL_OPTS -X POST "$BASE_URL/api/alerts" \
  -H "Content-Type: application/json" \
  -d '{"id":"test-alert-1","source":"email","urgency":"soon","title":"Duplicate"}')
IS_CONFLICT=$(echo "$RESULT" | grep -c '"duplicate":true')
test_result "$([ $IS_CONFLICT -eq 1 ] && echo true)" "Duplicate alert rejected with 409"

echo ""
echo "5. Snooze Alert (PATCH /api/alerts/:id)"
RESULT=$(curl $CURL_OPTS -X PATCH "$BASE_URL/api/alerts/test-alert-1" \
  -H "Content-Type: application/json" \
  -d '{"action":"snooze","snooze_duration":3600000}')
IS_SNOOZED=$(echo "$RESULT" | grep -c '"status":"snoozed"')
test_result "$([ $IS_SNOOZED -eq 1 ] && echo true)" "Alert snoozed successfully"

echo ""
echo "6. Complete Alert (PATCH /api/alerts/:id)"
# Create a new alert to complete
curl $CURL_OPTS -X POST "$BASE_URL/api/alerts" \
  -H "Content-Type: application/json" \
  -d '{"id":"test-alert-2","source":"slack","urgency":"immediate","title":"Test Alert 2"}' > /dev/null

RESULT=$(curl $CURL_OPTS -X PATCH "$BASE_URL/api/alerts/test-alert-2" \
  -H "Content-Type: application/json" \
  -d '{"action":"complete"}')
IS_COMPLETED=$(echo "$RESULT" | grep -c '"status":"completed"')
test_result "$([ $IS_COMPLETED -eq 1 ] && echo true)" "Alert completed successfully"

echo ""
echo "7. Filter by Status (GET /api/alerts?status=snoozed)"
RESULT=$(curl $CURL_OPTS "$BASE_URL/api/alerts?status=snoozed")
HAS_SNOOZED=$(echo "$RESULT" | grep -c '"test-alert-1"')
test_result "$([ $HAS_SNOOZED -ge 1 ] && echo true)" "Can filter by status"

echo ""
echo "8. Exclude Completed (GET /api/alerts without includeCompleted)"
RESULT=$(curl $CURL_OPTS "$BASE_URL/api/alerts")
NO_COMPLETED=$(echo "$RESULT" | grep -c '"test-alert-2"')
test_result "$([ $NO_COMPLETED -eq 0 ] && echo true)" "Completed alerts excluded by default"

echo ""
echo "9. Include Completed (GET /api/alerts?includeCompleted=true)"
RESULT=$(curl $CURL_OPTS "$BASE_URL/api/alerts?includeCompleted=true")
HAS_COMPLETED=$(echo "$RESULT" | grep -c '"test-alert-2"')
test_result "$([ $HAS_COMPLETED -ge 1 ] && echo true)" "Can include completed alerts"

echo ""
echo "10. Delete Alert (DELETE /api/alerts/:id)"
RESULT=$(curl $CURL_OPTS -X DELETE "$BASE_URL/api/alerts/test-alert-1")
IS_SUCCESS=$(echo "$RESULT" | grep -c '"success":true')
test_result "$([ $IS_SUCCESS -eq 1 ] && echo true)" "Alert deleted successfully"

echo ""
echo "11. Snooze Expiration Test"
# Create alert with very short snooze (1ms in the past)
curl $CURL_OPTS -X POST "$BASE_URL/api/alerts" \
  -H "Content-Type: application/json" \
  -d '{"id":"test-snooze","source":"email","urgency":"soon","title":"Snooze Test"}' > /dev/null

# Set snoozed_until to past
PAST_TIME=$(date -u -v-1M +"%Y-%m-%dT%H:%M:%SZ")
curl $CURL_OPTS -X PATCH "$BASE_URL/api/alerts/test-snooze" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"snoozed\",\"snoozed_until\":\"$PAST_TIME\"}" > /dev/null

# Fetch alerts LIST to trigger processSnoozes, then check the specific alert
RESULT=$(curl $CURL_OPTS "$BASE_URL/api/alerts?status=pending")
IS_PENDING=$(echo "$RESULT" | grep -c '"test-snooze"')
test_result "$([ $IS_PENDING -eq 1 ] && echo true)" "Expired snooze returns to pending"

# Cleanup
echo ""
echo "Cleanup..."
curl $CURL_OPTS -X DELETE "$BASE_URL/api/alerts/test-alert-2" > /dev/null 2>&1
curl $CURL_OPTS -X DELETE "$BASE_URL/api/alerts/test-snooze" > /dev/null 2>&1

echo ""
echo "==========================================="
echo "Results: $PASS passed, $FAIL failed"
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi
