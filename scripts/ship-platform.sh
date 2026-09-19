#!/bin/bash
#
# ship-platform.sh — take edited Homestead platform code LIVE on :3005.
#
# :3005 is a custom Next server (server.js -> next({dev})). There is no
# hot-reload path we depend on for shipping: a code change is INERT until
# it's been built and the pm2 app restarted. This script is that ritual —
# ONE command that produces a fresh production build, restarts the app, and
# LOUDLY verifies the new code is actually serving. Green means shipped.
# Red (non-zero exit) means nothing changed and you must not claim it did.
#
# Usage:  bash scripts/ship-platform.sh
#
# It always builds and restarts the PRODUCTION app (pm2 name "homestead",
# cwd ~/code/homestead) regardless of where this script is invoked from —
# worktrees edit code, but pm2 only ever runs the production checkout.

set -euo pipefail

# ---- config -----------------------------------------------------------------
PROD_DIR="<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead"
PM2_APP="homestead"
URL="http://localhost:3005"
HEALTH_PATH="/api/stewards"   # functional endpoint: must return valid JSON

# Resolve tools explicitly — pm2/node live under nvm and launchd/cron shells
# don't always have them on PATH.
NODE="$(command -v node || echo <<REPLACE: your home dir, e.g. /Users/you>>/.nvm/versions/node/v22.22.0/bin/node)"
PM2="$(command -v pm2 || echo <<REPLACE: your home dir, e.g. /Users/you>>/.nvm/versions/node/v22.22.0/bin/pm2)"

# ---- output helpers ---------------------------------------------------------
BOLD="$(printf '\033[1m')"; RED="$(printf '\033[31m')"; GREEN="$(printf '\033[32m')"
YELLOW="$(printf '\033[33m')"; RESET="$(printf '\033[0m')"

say()  { echo "${BOLD}[ship]${RESET} $*"; }
ok()   { echo "${GREEN}${BOLD}  ✓ $*${RESET}"; }
step() { echo "${YELLOW}${BOLD}==> $*${RESET}"; }

# Print "<pid> <restart_time> <node_env>" for the pm2 app. Used to prove the
# server is a genuinely NEW process after restart (not the same one still up).
pm2_identity() {
  "$PM2" jlist 2>/dev/null | "$NODE" -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try {
        const p = JSON.parse(d).find(x => x.pm2_env.name === process.argv[1]);
        if (!p) { console.log("MISSING"); return; }
        const env = (p.pm2_env.env && p.pm2_env.env.NODE_ENV) || p.pm2_env.NODE_ENV || "unset";
        console.log(`${p.pid} ${p.pm2_env.restart_time} ${env}`);
      } catch { console.log("MISSING"); }
    });' "$PM2_APP"
}

fail() {
  echo ""
  echo "${RED}${BOLD}══════════════════════════════════════════════════════${RESET}"
  echo "${RED}${BOLD}  ✗ SHIP FAILED — code is NOT live. $*${RESET}"
  echo "${RED}${BOLD}══════════════════════════════════════════════════════${RESET}"
  exit 1
}

START_TS=$(date +%s)

# ---- 0. sanity --------------------------------------------------------------
[ -d "$PROD_DIR" ] || fail "production dir not found: $PROD_DIR"
[ -x "$NODE" ] || fail "node not found (looked at: $NODE)"
[ -x "$PM2" ]  || fail "pm2 not found (looked at: $PM2)"
cd "$PROD_DIR"

# ---- 1. capture pre-build BUILD_ID -----------------------------------------
# Capture FIRST so the post-build comparison proves the build actually ran.
OLD_BUILD_ID=""
if [ -f "$PROD_DIR/.next/BUILD_ID" ]; then
  OLD_BUILD_ID="$(cat "$PROD_DIR/.next/BUILD_ID")"
fi
say "pre-build BUILD_ID: ${OLD_BUILD_ID:-<none>}"

# ---- 2. build ---------------------------------------------------------------
# next.config.ts sets ignoreBuildErrors:true so TS won't block. No
# output:'standalone' — this is a custom server; do NOT add it.
# In PROD mode this build IS the live code the server serves. In dev mode the
# server recompiles from source itself, so here the build is a pre-flight that
# still catches compile/lint breakage before the restart — same ritual either
# way, which is the point: it doesn't change when :3005 flips to prod.
step "Building (next build)…"
if ! "$PROD_DIR/node_modules/.bin/next" build; then
  fail "next build exited non-zero."
fi
ok "build complete"

# ---- 3. restart the app -----------------------------------------------------
# Capture the running server's identity BEFORE restart. This is the real
# liveness anchor: a genuine restart produces a NEW pid and increments
# restart_time. In dev mode (next({dev:true})) the restart is ALSO what
# recompiles current source into the running server — so "new process +
# serving valid content" is the correct liveness proof, independent of any
# .next/BUILD_ID (which a dev server never reads).
OLD_IDENT="$(pm2_identity)"
OLD_PID="$(echo "$OLD_IDENT" | awk '{print $1}')"
OLD_RESTARTS="$(echo "$OLD_IDENT" | awk '{print $2}')"
say "pre-restart server: pid=$OLD_PID restarts=$OLD_RESTARTS"

# --update-env is LOAD-BEARING: it re-reads ecosystem.config.js env so an
# eventual NODE_ENV flip actually takes effect on restart.
step "Restarting pm2 app '$PM2_APP' (--update-env)…"
if ! "$PM2" restart "$PM2_APP" --update-env >/dev/null 2>&1; then
  fail "pm2 restart '$PM2_APP' failed."
fi
ok "pm2 restart issued"

# ---- 4. verify live ---------------------------------------------------------
step "Verifying live…"

# Give the restarted server a moment to bind the port before probing.
for i in $(seq 1 30); do
  if curl -s -o /dev/null "$URL" 2>/dev/null; then break; fi
  sleep 1
done

# (a) LIVENESS — the running server is a genuinely NEW process.
# Poll pm2 until the pid changes AND restart_time increments past the
# pre-restart value. This is what actually proves the restart took effect:
# in dev mode it means current source was recompiled into the live server;
# in prod mode it means the new build was loaded. Works in BOTH runtimes.
NEW_IDENT=""; NEW_PID=""; NEW_RESTARTS=""; NODE_ENV_LIVE="unset"
for i in $(seq 1 30); do
  NEW_IDENT="$(pm2_identity)"
  NEW_PID="$(echo "$NEW_IDENT" | awk '{print $1}')"
  NEW_RESTARTS="$(echo "$NEW_IDENT" | awk '{print $2}')"
  NODE_ENV_LIVE="$(echo "$NEW_IDENT" | awk '{print $3}')"
  # online (numeric pid), pid differs, and restart counter advanced.
  if [ "$NEW_IDENT" != "MISSING" ] && [ -n "$NEW_PID" ] && [ "$NEW_PID" != "0" ] \
     && [ "$NEW_PID" != "$OLD_PID" ] \
     && [ "${NEW_RESTARTS:-0}" -gt "${OLD_RESTARTS:-0}" ] 2>/dev/null; then
    break
  fi
  sleep 1
done
if [ "$NEW_IDENT" = "MISSING" ] || [ -z "$NEW_PID" ] || [ "$NEW_PID" = "0" ]; then
  fail "pm2 app '$PM2_APP' is not online after restart."
fi
if [ "$NEW_PID" = "$OLD_PID" ] || [ "${NEW_RESTARTS:-0}" -le "${OLD_RESTARTS:-0}" ] 2>/dev/null; then
  fail "server did not actually restart (pid $OLD_PID→$NEW_PID, restarts $OLD_RESTARTS→$NEW_RESTARTS) — old code may still be live."
fi
ok "server restarted: pid $OLD_PID→$NEW_PID, restarts $OLD_RESTARTS→$NEW_RESTARTS (NODE_ENV=$NODE_ENV_LIVE)"

# (b) root returns 200 from that new process.
# Follow redirects: since Interface 1 was retired (2026-09-03) the site root is
# a deliberate redirect to the presenter, so the bare code is 307. What matters
# is that the root ultimately lands on a real 200 page — which -L verifies, and
# which also catches a redirect pointing somewhere dead.
HTTP_CODE="$(curl -sL -o /dev/null -w '%{http_code}' "$URL" || echo 000)"
[ "$HTTP_CODE" = "200" ] || fail "$URL (following redirects) returned HTTP $HTTP_CODE (expected 200)."
ok "$URL → 200"

# (c) functional check — /api/stewards returns valid JSON, not just a 200.
# (verify-servers-functionally: a 200 on a stale/error body is not "live".)
HEALTH_BODY="$(curl -s "$URL$HEALTH_PATH" || echo '')"
echo "$HEALTH_BODY" | "$NODE" -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    try { const j=JSON.parse(d); if(!Array.isArray(j.stewards)) throw new Error("no stewards array"); }
    catch(e){ console.error(e.message); process.exit(1); }
  });' || fail "$HEALTH_PATH did not return valid JSON with a stewards array."
ok "$HEALTH_PATH → valid JSON"

# (d) BUILD_ID staleness proof — PROD MODE ONLY.
# A dev server (next({dev:true})) recompiles from source and never reads
# .next/BUILD_ID — it even wipes the file on startup — so a BUILD_ID diff
# proves nothing about what's live in dev. Only assert it when the live
# server is genuinely NODE_ENV=production and thus actually serves .next/.
BUILD_ID_LINE="(dev mode — no BUILD_ID; liveness proven by process restart above)"
if [ "$NODE_ENV_LIVE" = "production" ]; then
  [ -f "$PROD_DIR/.next/BUILD_ID" ] || fail "prod mode but no .next/BUILD_ID after build."
  NEW_BUILD_ID="$(cat "$PROD_DIR/.next/BUILD_ID")"
  if [ -n "$OLD_BUILD_ID" ] && [ "$NEW_BUILD_ID" = "$OLD_BUILD_ID" ]; then
    fail "BUILD_ID unchanged ($NEW_BUILD_ID) — build did not produce new output."
  fi
  ok "fresh BUILD_ID: $NEW_BUILD_ID (was: ${OLD_BUILD_ID:-<none>})"
  BUILD_ID_LINE="BUILD_ID: $NEW_BUILD_ID"
else
  say "skipping BUILD_ID check — live server is NODE_ENV=$NODE_ENV_LIVE (dev), which does not consume .next/BUILD_ID."
fi

# ---- 5. done ----------------------------------------------------------------
ELAPSED=$(( $(date +%s) - START_TS ))
echo ""
echo "${GREEN}${BOLD}══════════════════════════════════════════════════════${RESET}"
echo "${GREEN}${BOLD}  ✓ SHIPPED — code is LIVE on :3005${RESET}"
echo "${GREEN}${BOLD}    ${BUILD_ID_LINE}${RESET}"
echo "${GREEN}${BOLD}    elapsed:  ${ELAPSED}s${RESET}"
echo "${GREEN}${BOLD}══════════════════════════════════════════════════════${RESET}"
exit 0
