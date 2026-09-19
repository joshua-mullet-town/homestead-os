#!/usr/bin/env bash
# rescue-failed-recordings.sh
#
# When the normal Phone → Mac transcription pipeline breaks (Tailscale down,
# whisper-server unreachable, etc.), this script rescues recordings that were
# saved on the phone but never transcribed.
#
# Requirements:
#   - Phone connected via USB with ADB authorized
#   - whisper-server running locally on port 8178 (Homestead server auto-starts it)
#   - ffmpeg in PATH
#
# Usage:
#   bash scripts/rescue-failed-recordings.sh
#
# Output: prints a human-readable digest of every FAILED audio recording
# (id, timestamp, transcript) and writes the same digest to:
#   ~/Downloads/rescued-recordings-YYYYMMDD-HHMMSS.txt

set -euo pipefail

OUTDIR="$(mktemp -d "${TMPDIR:-/tmp}/rescue-recordings-XXXXXX")"
STAMP=$(date +%Y%m%d-%H%M%S)
DIGEST="$HOME/Downloads/rescued-recordings-${STAMP}.txt"
PKG="com.homestead.mobile"
WHISPER_URL="http://localhost:8178/inference"

cleanup() { rm -rf "$OUTDIR"; }
trap cleanup EXIT

# 1. ADB sanity
if ! command -v adb >/dev/null 2>&1; then
  echo "FATAL: adb not in PATH (install Android platform-tools)" >&2
  exit 1
fi
if ! adb get-state >/dev/null 2>&1; then
  echo "FATAL: no ADB device. Plug phone in via USB and authorize this Mac." >&2
  exit 1
fi

# 2. Whisper sanity
if ! curl -s --max-time 2 "${WHISPER_URL%/inference}/" >/dev/null; then
  echo "FATAL: whisper-server not reachable on $WHISPER_URL" >&2
  echo "  → Homestead server should auto-start it. Check 'lsof -i:8178'." >&2
  exit 1
fi

# 3. Pull history
echo "[rescue] pulling recording_history.json from phone..."
adb exec-out "run-as $PKG cat files/recording_history.json" \
  > "$OUTDIR/recording_history.json"

if [ ! -s "$OUTDIR/recording_history.json" ]; then
  echo "FATAL: empty recording_history.json — is com.homestead.mobile installed?" >&2
  exit 1
fi

# 4. Extract FAILED audio ids (oldest first so digest reads chronologically)
ID_LIST_FILE="$OUTDIR/failed_ids.txt"
jq -r '
  [.[] | select(.sendStatus == "FAILED" and .type == "AUDIO")]
  | sort_by(.timestamp)
  | .[].id
' "$OUTDIR/recording_history.json" > "$ID_LIST_FILE"

FAILED_COUNT=$(wc -l < "$ID_LIST_FILE" | tr -d ' ')
if [ "$FAILED_COUNT" -eq 0 ]; then
  echo "No FAILED audio recordings to rescue."
  exit 0
fi

echo "[rescue] found ${FAILED_COUNT} FAILED audio recording(s)"

# 5. Pull, convert, transcribe each one; write digest
{
  echo "RESCUED RECORDINGS — $(date)"
  echo "Source: phone $PKG"
  echo "Recordings rescued: ${FAILED_COUNT}"
  echo "================================================================"
  echo ""
} > "$DIGEST"

while IFS= read -r -u 3 id; do
  [ -z "$id" ] && continue
  M4A="$OUTDIR/rec_${id}.m4a"
  WAV="$OUTDIR/rec_${id}.wav"
  TS_MS=$(jq -r --arg id "$id" '.[] | select(.id == $id) | .timestamp' "$OUTDIR/recording_history.json")
  TS_HUMAN=$(date -r "$((TS_MS / 1000))" '+%Y-%m-%d %H:%M:%S')

  echo "[rescue] $id  ($TS_HUMAN)"

  if ! adb exec-out "run-as $PKG cat files/recordings/rec_${id}.m4a" > "$M4A" 2>/dev/null; then
    echo "  WARN: could not pull audio for $id"
    {
      echo "--- $id  $TS_HUMAN ---"
      echo "[rescue failed: audio file missing on phone]"
      echo ""
    } >> "$DIGEST"
    continue
  fi
  if [ ! -s "$M4A" ]; then
    {
      echo "--- $id  $TS_HUMAN ---"
      echo "[rescue failed: audio file empty]"
      echo ""
    } >> "$DIGEST"
    continue
  fi

  if ! ffmpeg -y -loglevel error -i "$M4A" -ar 16000 -ac 1 "$WAV" 2>/dev/null; then
    {
      echo "--- $id  $TS_HUMAN ---"
      echo "[rescue failed: ffmpeg conversion error]"
      echo ""
    } >> "$DIGEST"
    continue
  fi

  TEXT=$(curl -s --max-time 240 -X POST "$WHISPER_URL" \
    -F "file=@$WAV" \
    -F "response_format=json" \
    | jq -r '.text // "[transcription empty]"')

  {
    echo "--- $id  $TS_HUMAN ---"
    echo "$TEXT" | sed 's/^[[:space:]]*//' | sed '/^$/d'
    echo ""
  } >> "$DIGEST"
done 3< "$ID_LIST_FILE"

echo ""
echo "[rescue] digest written to: $DIGEST"
echo ""
cat "$DIGEST"
