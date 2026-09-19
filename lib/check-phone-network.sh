#!/bin/bash
# check-phone-network.sh — Phone-off-network alarm (the "Alfred goes blind" watchdog)
#
# WHY THIS EXISTS
#   Alfred learns about Slack + texts ONLY through the phone's notification tray,
#   which reaches the Mac over Tailscale. When Josh's phone drops off the tailnet
#   (Tailscale off / phone off wifi), THREE things go dark at once and today NOTHING
#   alarms:
#     - Alfred goes blind to all Slack + incoming texts.
#     - 2FA/login codes (SMS) can't be read by the fleet → reauth flows stall.
#   The old health check treated phone-unreachable as "informational, not counted",
#   so this failure was silent. This script makes it LOUD — but lightweight.
#
# THE OUT-OF-BAND CATCH (load-bearing)
#   The alarm fires precisely WHEN the phone is off-tailnet — so it CANNOT use the
#   phone bridge (http://<<REPLACE: your Tailscale IP>>:8888/sms/send, what sms-alerter.py uses): that
#   bridge is dead exactly then. The only sender that survives is Twilio's REST API
#   (cloud → Josh's cellular, no tailnet needed). Creds: ~/.twilio-cli/config.json.
#   Verified live: HTTP 200 on Messages endpoint, prior delivered SMS to Josh's number.
#
# ROUTING BY FIXABILITY (Josh's spec)
#   - Phone off-tailnet  → Josh can fix in 10s from his phone → DIRECT Twilio text to
#                          Josh. Rooster is NOT pinged.
#   - Tailscale UP but a source is broken (Gmail auth dead, etc.) → Rooster may be able
#                          to fix it → walkie holler-rooster first (existing path in
#                          check-connections.sh handles Gmail reauth; this script only
#                          walkies Rooster for the notif-server-down case).
#
# EDGE-TRIGGERED / SIMMER (no nagging)
#   One text per on→off transition. Silent while the phone stays off. A second text
#   only fires after the phone comes back ON and later goes OFF again (off→on→off).
#   State tracked in a small JSON file. A benign brief blip is absorbed by the
#   CONSECUTIVE-miss threshold below (does not fire on the first miss).
#
# THRESHOLD (not-noisy half of the ask)
#   Josh's phone goes off-network routinely (overnight, off-wifi). We only declare
#   "off-network" after N consecutive unreachable observations. At the cron cadence
#   below (every ~5 min via check-connections.sh's 15-min job... see wiring note), that
#   is ~15-20 min of sustained darkness before a single text goes out.

set -uo pipefail   # NOT -e: a probe failure is data, not a script abort.

# ── Config ───────────────────────────────────────────────────────────
PHONE_TAILSCALE_NAME="pixel-9a-1"          # Josh's phone device name in `tailscale status`
PHONE_IP="<<REPLACE: your Tailscale IP>>"                # Josh's phone tailnet IP (bridge :8888)
STATE_FILE="$HOME/.homestead/stewards/rooster/workers/watchdog/phone-network-alarm-state.json"
PHONE_CONFIG_PATH="$HOME/.homestead/secrets/joshua-phone.txt"
TWILIO_CONFIG="$HOME/.twilio-cli/config.json"
TWILIO_FROM="+15744440820"              # this account's SMS-capable Twilio number
QUEUE_FILE="$HOME/.homestead/queue.json"

# N consecutive unreachable observations before we call it "off-network" and text.
# Tuned so a brief blip never cries wolf; sustained darkness does.
# 2026-08-27: raised 3→6 (15min→30min at */5 cron). Alfred flagged the "turn
# Tailscale on" self-text fired ~10x/week, always arriving AFTER the phone was
# already back on (it reached Alfred via phone-push = phone on-network) = pure
# noise to Josh. Root cause: Josh's phone genuinely drops off-tailnet ~15min
# nightly (Android overnight wifi/Tailscale cycling), which cleared the old
# 15-min threshold and fired, then self-recovered before the text landed. 30min
# filters the routine nightly cycle while still catching a genuinely-dark-for-
# 30min+ phone (a real problem Josh would want to act on). The recovery/reset
# path + the :8888 bridge safety-guard were both verified WORKING — this is a
# sensitivity tune, not a bug fix.
CONSECUTIVE_THRESHOLD="${PHONE_NET_THRESHOLD:-6}"

# SAME treatment for the on-tailnet-but-:8888-bridge-down branch. Josh's phone is on
# flaky cellular (Tailscale 'direct' over mobile data), so the bridge goes unreachable
# for ~10s windows then recovers. A SINGLE missed :8888 probe must NOT walkie Rooster —
# only a SUSTAINED bridge-down (N consecutive misses) does. Mirrors the Tailscale
# threshold machinery above; own counter so the two episodes never cross-contaminate.
BRIDGE_CONSECUTIVE_THRESHOLD="${PHONE_BRIDGE_THRESHOLD:-3}"

# Override hooks for testing (never set in prod):
#   PHONE_NET_TEST_TAILSCALE=off|on   → skip real tailscale, force the branch
#   PHONE_NET_DRY_RUN=1               → log the SMS instead of sending it
#   PHONE_NET_STATE_FILE=/path        → use an alternate state file (unit tests)
[ -n "${PHONE_NET_STATE_FILE:-}" ] && STATE_FILE="$PHONE_NET_STATE_FILE"

log() { echo "[$(date -u +%FT%TZ)] [PhoneNetAlarm] $*" >&2; }

# ── Tailscale detection ──────────────────────────────────────────────
# Returns "on" if the phone is reachable on the tailnet, "off" otherwise.
# A device that is off-tailnet shows "offline" (or "-"/"last seen") on its
# `tailscale status` line; an online phone shows "active"/"idle" + a direct/relay
# endpoint. We treat presence of "offline" OR absence of the line as off.
detect_tailscale() {
  if [ "${PHONE_NET_TEST_TAILSCALE:-}" = "off" ]; then echo "off"; return; fi
  if [ "${PHONE_NET_TEST_TAILSCALE:-}" = "on" ];  then echo "on";  return; fi

  local line
  line="$(tailscale status 2>/dev/null | grep -F "$PHONE_TAILSCALE_NAME" || true)"
  if [ -z "$line" ]; then
    # Phone not in peer list at all → off-tailnet.
    echo "off"; return
  fi
  if echo "$line" | grep -qi "offline"; then
    echo "off"; return
  fi
  echo "on"
}

# ── State (edge tracking + consecutive-miss counter) ─────────────────
# State shape: { "phone_state": "on"|"off"|"unknown", "consecutive_misses": N,
#                "last_alerted_edge": "off"|null,
#                "bridge_misses": N, "last_bridge_alerted_edge": "down"|null,
#                "updated_at": iso }
# The bridge_* fields mirror the Tailscale edge-tracking pair for the
# on-tailnet-but-:8888-down branch (FIX: cellular-flap hardening). They live
# independently so the Tailscale off-episode and the bridge-down episode never
# clobber each other's counters.
load_state() {
  if [ -f "$STATE_FILE" ]; then cat "$STATE_FILE"; else echo '{}'; fi
}

read_state_field() {  # $1=json  $2=field  $3=default
  echo "$1" | node -e "
    let d={}; try{ d=JSON.parse(require('fs').readFileSync(0,'utf8')||'{}'); }catch(e){}
    const v=d['$2']; process.stdout.write(v===undefined||v===null?'$3':String(v));
  " 2>/dev/null || echo "$3"
}

save_state() {  # $1=phone_state $2=consecutive_misses $3=last_alerted_edge
                # $4=bridge_misses $5=last_bridge_alerted_edge
  mkdir -p "$(dirname "$STATE_FILE")"
  local tmp="${STATE_FILE}.tmp.$$"
  node -e "
    const fs=require('fs');
    fs.writeFileSync('$tmp', JSON.stringify({
      phone_state: '$1',
      consecutive_misses: Number('$2'),
      last_alerted_edge: ('$3'==='null'||'$3'==='') ? null : '$3',
      bridge_misses: Number('${4:-0}'),
      last_bridge_alerted_edge: ('${5:-null}'==='null'||'${5:-}'==='') ? null : '${5}',
      updated_at: new Date().toISOString()
    }, null, 2));
  " 2>/dev/null && mv "$tmp" "$STATE_FILE"
}

# ── Twilio out-of-band SMS ───────────────────────────────────────────
# Sends via Twilio REST (cloud → cellular). Survives phone-off-tailnet, unlike the
# :8888 bridge. Honors PHONE_NET_DRY_RUN=1 (log, don't send). Returns 0 on success.
send_twilio_sms() {  # $1=message
  local message="$1" to sid key secret

  if [ ! -f "$PHONE_CONFIG_PATH" ]; then
    log "ABORT: phone number config missing at $PHONE_CONFIG_PATH — cannot text Josh."
    return 1
  fi
  to="$(tr -d '[:space:]' < "$PHONE_CONFIG_PATH")"
  if ! echo "$to" | grep -Eq '^\+[0-9]{10,15}$'; then
    log "ABORT: phone config not E.164 (got: $to)"; return 1
  fi

  if [ ! -f "$TWILIO_CONFIG" ]; then
    log "ABORT: Twilio config missing at $TWILIO_CONFIG"; return 1
  fi
  sid="$(node -e "process.stdout.write((JSON.parse(require('fs').readFileSync('$TWILIO_CONFIG','utf8')).profiles.default||{}).accountSid||'')" 2>/dev/null)"
  key="$(node -e "process.stdout.write((JSON.parse(require('fs').readFileSync('$TWILIO_CONFIG','utf8')).profiles.default||{}).apiKey||'')" 2>/dev/null)"
  secret="$(node -e "process.stdout.write((JSON.parse(require('fs').readFileSync('$TWILIO_CONFIG','utf8')).profiles.default||{}).apiSecret||'')" 2>/dev/null)"
  if [ -z "$sid" ] || [ -z "$key" ] || [ -z "$secret" ]; then
    log "ABORT: Twilio creds incomplete in $TWILIO_CONFIG"; return 1
  fi

  if [ "${PHONE_NET_DRY_RUN:-}" = "1" ]; then
    log "DRY_RUN: would text $to: \"$message\""
    return 0
  fi

  local http
  http="$(curl -s -m 15 -o /dev/null -w '%{http_code}' \
    -u "$key:$secret" \
    "https://api.twilio.com/2010-04-01/Accounts/$sid/Messages.json" \
    --data-urlencode "To=$to" \
    --data-urlencode "From=$TWILIO_FROM" \
    --data-urlencode "Body=$message")"
  if [ "$http" = "201" ] || [ "$http" = "200" ]; then
    log "SMS sent to $to via Twilio (HTTP $http)"
    return 0
  fi
  log "SMS send FAILED (HTTP $http)"
  return 1
}

# ── Rooster walkie (non-Tailscale, fixable-by-Rooster branch) ────────
walkie_rooster_notif_server_down() {
  node -e "
    const fs=require('fs');
    let q=[]; try{ q=JSON.parse(fs.readFileSync('$QUEUE_FILE','utf8')); }catch(e){}
    // Dedup: don't stack identical pending alerts.
    const dup=q.some(x=>x.target_session==='holler-rooster'&&x.status==='pending'&&
      typeof x.message==='string'&&x.message.includes('phone_notif_server_down'));
    if(dup){ process.exit(0); }
    q.push({
      id: Date.now()+'-phone-notif-server-down',
      target_session:'holler-rooster', type:'action',
      message: JSON.stringify({ type:'action', trigger:'phone_notif_server_down',
        from:'check-phone-network',
        detail:'Phone is ON the tailnet but its notification bridge (:8888) is unreachable — Alfred is blind to Slack/texts even though the phone is online. Likely the Homestead mobile app / listener stopped. Rooster: investigate before escalating to Josh.' }),
      status:'pending', created_at:new Date().toISOString(), attempts:0
    });
    // ATOMIC (torn-read fix 2026-08-25): temp+rename so the dispatcher never
    // reads a half-written queue.json. rename() within one fs is atomic.
    const tmp='$QUEUE_FILE'+'.tmp-'+process.pid+'-'+Date.now();
    fs.writeFileSync(tmp, JSON.stringify(q,null,2));
    fs.renameSync(tmp, '$QUEUE_FILE');
  " 2>/dev/null && log "Walkied Rooster: phone_notif_server_down"
}

# ── Main ─────────────────────────────────────────────────────────────
main() {
  local state prev_phone_state prev_misses last_alerted prev_bridge_misses last_bridge_alerted
  state="$(load_state)"
  prev_phone_state="$(read_state_field "$state" phone_state unknown)"
  prev_misses="$(read_state_field "$state" consecutive_misses 0)"
  last_alerted="$(read_state_field "$state" last_alerted_edge null)"
  prev_bridge_misses="$(read_state_field "$state" bridge_misses 0)"
  last_bridge_alerted="$(read_state_field "$state" last_bridge_alerted_edge null)"

  local ts
  ts="$(detect_tailscale)"

  if [ "$ts" = "off" ]; then
    # Phone unreachable on tailnet. Increment the consecutive-miss counter.
    local misses=$((prev_misses + 1))

    if [ "$misses" -lt "$CONSECUTIVE_THRESHOLD" ]; then
      # Below threshold — could be a benign blip. Stay SILENT, just count.
      log "Phone off-tailnet (miss $misses/$CONSECUTIVE_THRESHOLD) — below threshold, silent."
      save_state "off_pending" "$misses" "$last_alerted" "$prev_bridge_misses" "$last_bridge_alerted"
      echo "[phone-network] OFF_PENDING ($misses/$CONSECUTIVE_THRESHOLD)"
      return 0
    fi

    # At/over threshold → declare OFF. Edge-trigger: only text if we haven't already
    # alerted for THIS off-episode (last_alerted != "off").
    if [ "$last_alerted" = "off" ]; then
      log "Phone still off-tailnet (miss $misses) — already alerted this episode, staying silent."
      save_state "off" "$misses" "off" "$prev_bridge_misses" "$last_bridge_alerted"
      echo "[phone-network] OFF (already alerted, silent)"
      return 0
    fi

    # SAFETY GUARD (defense-in-depth): never text "your phone is off" while we can
    # still reach it. Right before sending, re-confirm the phone is genuinely
    # unreachable on the tailnet (:8888 bridge). If the bridge answers, the tailscale
    # read was stale/wrong — abort the text, reset to on. This makes a FALSE
    # "phone off-network" text structurally impossible. Skipped under test override.
    if [ -z "${PHONE_NET_TEST_TAILSCALE:-}" ]; then
      if curl -s --connect-timeout 4 --max-time 6 "http://${PHONE_IP}:8888/health" >/dev/null 2>&1; then
        log "GUARD: tailscale read said off, but :8888 bridge is reachable — NOT texting (false positive averted). Resetting to on."
        save_state "on" 0 "null" "$prev_bridge_misses" "$last_bridge_alerted"
        echo "[phone-network] GUARD_ABORT (bridge reachable, no text)"
        return 0
      fi
    fi

    # Fresh on→off edge crossing the threshold → send ONE text.
    local msg="Hey — your phone's off-network (Tailscale down or off wifi). Right now Alfred can't see Slack or texts, and login/2FA codes can't be read. Turn Tailscale back on when you get a sec."
    if send_twilio_sms "$msg"; then
      save_state "off" "$misses" "off" "$prev_bridge_misses" "$last_bridge_alerted"
      log "Alerted Josh: phone off-network (edge on->off)."
      echo "[phone-network] OFF — texted Josh"
    else
      # Send failed — do NOT mark alerted, so a later run retries.
      save_state "off" "$misses" "$last_alerted" "$prev_bridge_misses" "$last_bridge_alerted"
      echo "[phone-network] OFF — text FAILED (will retry)"
    fi
    return 0
  fi

  # ts == "on": phone is on the tailnet. Reset the Tailscale off-episode so a future
  # drop re-alerts (off→on→off). This is the "on" leg of Tailscale edge tracking.
  # NB: we do NOT reset the bridge-episode fields here — the bridge-down episode is
  # tracked independently below (phone can be on-tailnet across many runs while the
  # bridge flaps in and out; its counter must persist run-to-run).
  if [ "$prev_phone_state" != "on" ]; then
    log "Phone back ON tailnet (was: $prev_phone_state). Resetting off-episode."
  fi

  # Phone is on-tailnet but the notification bridge could still be down (app crashed,
  # listener stopped) — OR just momentarily unreachable because Josh's phone is on
  # flaky cellular (Tailscale 'direct' over mobile data flaps for ~10s at a time).
  # That's the Rooster-fixable branch (walkie Rooster, don't text) — BUT it gets the
  # SAME N-consecutive-miss threshold + edge-trigger as the Tailscale branch above, so
  # a single transient blip is absorbed and only a SUSTAINED bridge-down walkies Rooster.
  if ! curl -s --connect-timeout 5 --max-time 8 "http://${PHONE_IP}:8888/health" >/dev/null 2>&1; then
    local bridge_misses=$((prev_bridge_misses + 1))

    if [ "$bridge_misses" -lt "$BRIDGE_CONSECUTIVE_THRESHOLD" ]; then
      # Below threshold — likely a cellular blip. Stay SILENT, just count.
      log "Bridge :8888 down (miss $bridge_misses/$BRIDGE_CONSECUTIVE_THRESHOLD) — below threshold, silent (likely cellular flap)."
      save_state "on" 0 "null" "$bridge_misses" "$last_bridge_alerted"
      echo "[phone-network] BRIDGE_DOWN_PENDING ($bridge_misses/$BRIDGE_CONSECUTIVE_THRESHOLD)"
      return 0
    fi

    # At/over threshold → sustained bridge-down. Edge-trigger: only walkie once per
    # bridge-down episode (last_bridge_alerted != "down").
    if [ "$last_bridge_alerted" = "down" ]; then
      log "Bridge still down (miss $bridge_misses) — already walkied Rooster this episode, staying silent."
      save_state "on" 0 "null" "$bridge_misses" "down"
      echo "[phone-network] ON_TAILNET_BUT_BRIDGE_DOWN (already walkied, silent)"
      return 0
    fi

    log "Phone ON tailnet but :8888 bridge unreachable for $bridge_misses consecutive checks → sustained, Rooster-fixable, walkieing Rooster."
    walkie_rooster_notif_server_down
    save_state "on" 0 "null" "$bridge_misses" "down"
    echo "[phone-network] ON_TAILNET_BUT_BRIDGE_DOWN — walkied Rooster"
    return 0
  fi

  # Bridge reachable → healthy. Reset the bridge-down episode so a future sustained
  # drop re-walkies (down→up→down), same edge semantics as the Tailscale leg.
  save_state "on" 0 "null" 0 "null"
  echo "[phone-network] OK"
  return 0
}

main "$@"
