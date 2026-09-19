#!/usr/bin/env bash
# Behavioral parity check: phone-alley (:3009) vs old watchdog (:3007).
#
# For each shared endpoint, curl both ports, normalize via `jq -S` (sorted
# keys), strip values that are KNOWN to differ (PIDs, timestamps, hosts),
# then diff. Anything outside the allow-list is a parity break.
#
# Run:  bash phone-alley/test/parity-check.sh
#
# Exit 0 = parity (modulo allow-list). Exit 1 = parity break.
#
# WHAT THIS COVERS
#   - GET /api/dev-servers      — read-only port scan
#   - GET /api/phone/test       — read-only phone probe
#   - POST /api/restart/<bogus> — failure-mode shape (unknown service)
#
# WHAT THIS DOES NOT COVER (and why)
#   - POST /api/restart, /api/nuclear-restart, /api/firebase-login,
#     /api/dev-server/<project>/start|stop — these are DESTRUCTIVE and
#     running them under parity check would restart the real fleet
#     multiple times. The destructive endpoints' OUTCOMES are tested in
#     test.mjs against an isolated PM2 namespace; their parity with the
#     old watchdog is demonstrated by the side-by-side manual curl
#     transcript in the graduation bundle.
#
# ALLOW-LIST OF EXPECTED DIFFERENCES
#   - .data envelope: NEW alley wraps responses in {ok, data}; OLD
#     watchdog returns the bare response. We normalize by unwrapping
#     alley's .data field before comparison.
#   - .error.code on failure: NEW alley uses a structured error envelope
#     ({ok:false, error:{code, message}}); OLD watchdog returns
#     {success:false, message:'...'}. We don't expect strict equality on
#     failure responses — instead we assert BOTH return non-success +
#     SOMETHING resembling an error message.
#   - .pids: lists of PIDs WILL differ between hosts/restarts. Stripped.
#   - .timestamp / .ts / dates: stripped.
#   - .reachable: phone might be up for one curl and down for the next.
#     We accept either value as long as both responses have the field.

set -uo pipefail

OLD=${OLD_BASE:-http://127.0.0.1:3007}
NEW=${NEW_BASE:-http://127.0.0.1:3009}
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

PASS=0
FAIL=0
NOTES=()

note()  { NOTES+=("$*"); }
pass()  { PASS=$((PASS + 1)); echo "  PASS"; }
fail()  { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }

# Sorted-key normalization that strips known-volatile fields.
norm() {
  jq -S '
    walk(
      if type == "object" then
        del(.pids, .timestamp, .ts, .uptime, .uptime_sec, .pid, .started_at, .written_at, .current_pid, .previous_pid, .current_restart_count, .previous_restart_count, .restarts, .memory, .cpu, .data_value)
      else . end
    )
  '
}

echo "=== Parity check: $OLD  vs  $NEW ==="
echo

# -------------------------------------------------------------------------
# 1) GET /api/dev-servers — read-only port scan
# -------------------------------------------------------------------------
echo "[1] GET /api/dev-servers"
curl -sS "$OLD/api/dev-servers" > "$TMP/old.json"
curl -sS "$NEW/api/dev-servers" > "$TMP/new.json"

cat "$TMP/old.json" | norm > "$TMP/old.norm"
# Unwrap alley's .data envelope to compare apples-to-apples
cat "$TMP/new.json" | jq '.data // .' | norm > "$TMP/new.norm"

if diff -u "$TMP/old.norm" "$TMP/new.norm" > "$TMP/diff" 2>&1; then
  pass
else
  echo "  diff:"
  sed 's/^/    /' "$TMP/diff"
  fail "dev-servers shape mismatch outside allow-list"
fi

# -------------------------------------------------------------------------
# 2) GET /api/phone/test — read-only phone probe
# -------------------------------------------------------------------------
echo "[2] GET /api/phone/test"
curl -sS "$OLD/api/phone/test" > "$TMP/old.json"
curl -sS "$NEW/api/phone/test" > "$TMP/new.json"

OLD_HAS=$(cat "$TMP/old.json" | jq 'has("host") and has("port")')
NEW_HAS=$(cat "$TMP/new.json" | jq '.data | has("host") and has("port")')

if [[ "$OLD_HAS" == "true" && "$NEW_HAS" == "true" ]]; then
  pass
  note "phone/test: both report host+port; reachable values not asserted (network state varies)"
else
  fail "phone/test shape: old has host+port=$OLD_HAS, new has host+port=$NEW_HAS"
fi

# -------------------------------------------------------------------------
# 3) POST /api/restart/<bogus> — failure-mode shape
# -------------------------------------------------------------------------
echo "[3] POST /api/restart/<bogus> — failure shape"
OLD_CODE=$(curl -s -o "$TMP/old.json" -w "%{http_code}" -X POST "$OLD/api/restart/this-service-does-not-exist-zzz")
NEW_CODE=$(curl -s -o "$TMP/new.json" -w "%{http_code}" -X POST "$NEW/api/restart/this-service-does-not-exist-zzz")

# OLD watchdog returns 200 with {success:false,message:'...'}; NEW alley returns
# 4xx with {ok:false,error:{code,message}}. We assert BOTH indicate failure
# (their own way) — strict parity NOT expected, that's an INTENTIONAL upgrade.
# Use `if has() then` because jq's // operator treats false as "missing".
OLD_OK=$(cat "$TMP/old.json" | jq -r 'if has("success") then (.success|tostring) elif has("ok") then (.ok|tostring) else "missing" end')
NEW_OK=$(cat "$TMP/new.json" | jq -r 'if has("ok") then (.ok|tostring) else "missing" end')

if [[ "$OLD_OK" == "false" && "$NEW_OK" == "false" ]]; then
  pass
  note "restart/<bogus>: OLD returned http=$OLD_CODE with success=false (200-with-success-flag pattern); NEW returned http=$NEW_CODE with ok=false (proper http-status envelope). NEW behavior is BETTER — this is a documented allow-list item."
else
  fail "restart/<bogus> failure mode: OLD ok=$OLD_OK NEW ok=$NEW_OK (both should be false)"
fi

# -------------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------------
echo
echo "=== Parity check summary ==="
echo "Pass: $PASS    Fail: $FAIL"
if [[ "${#NOTES[@]}" -gt 0 ]]; then
  echo
  echo "Notes (allow-list items):"
  for n in "${NOTES[@]}"; do
    echo "  - $n"
  done
fi
echo
if [[ "$FAIL" -gt 0 ]]; then
  echo "PARITY BREAK"
  exit 1
fi
echo "PARITY OK (modulo documented allow-list)"
exit 0
