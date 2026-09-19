#!/bin/bash
# check-connections.sh — Check external connection health
# Phone (Tailscale), Gmail API, Google Calendar API, Homestead server
# If Gmail or Calendar auth is expired, queues a re-auth message for the Rooster.

set -euo pipefail

FAILURES=0
AUTH_FAILURES=""

# 1. Phone — HTTP GET to Tailscale IP
PHONE_IP="<<REPLACE: your Tailscale IP>>"
if curl -s --connect-timeout 5 --max-time 8 "http://${PHONE_IP}:8888/health" >/dev/null 2>&1; then
  echo "[phone] OK"
else
  echo "[phone] UNREACHABLE (informational — phone off-network, not counted)"
fi

# 2. Homestead server
# NOTE: --max-time is critical. This script is invoked by the scheduler, which runs
# INSIDE the Homestead Node process via execSync. While execSync blocks, the Node
# event loop cannot respond to HTTP requests — so a curl to localhost:3005 with only
# --connect-timeout would hang forever (TCP connects via kernel backlog, but the
# response never comes). --max-time bounds the whole transfer and prevents deadlock.
if curl -s --connect-timeout 5 --max-time 8 "http://localhost:3005/api/jobs" >/dev/null 2>&1; then
  echo "[homestead] OK"
else
  echo "[homestead] DOWN"
  FAILURES=$((FAILURES + 1))
fi

# 3. Gmail API (refresh token test)
GMAIL_CREDS="$HOME/.gmail-mcp/credentials.json"
GMAIL_KEYS="$HOME/.gmail-mcp/gcp-oauth.keys.json"
if [ -f "$GMAIL_CREDS" ] && [ -f "$GMAIL_KEYS" ]; then
  GMAIL_RESULT=$(node -e "
    const fs = require('fs');
    const creds = JSON.parse(fs.readFileSync('$GMAIL_CREDS', 'utf-8'));
    const keys = JSON.parse(fs.readFileSync('$GMAIL_KEYS', 'utf-8'));
    const params = new URLSearchParams({
      client_id: keys.installed.client_id,
      client_secret: keys.installed.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token'
    });
    fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params, signal: AbortSignal.timeout(10000) })
      .then(r => r.json())
      .then(d => {
        if (d.access_token) return console.log('OK');
        // Only invalid_grant means the refresh token is actually dead.
        // Other error payloads (rate limit, 5xx) are transient.
        console.log(d.error === 'invalid_grant' ? 'AUTH_EXPIRED' : 'TRANSIENT');
      })
      .catch(() => console.log('TRANSIENT'));
  " 2>/dev/null)
  echo "[gmail] $GMAIL_RESULT"
  if [ "$GMAIL_RESULT" = "AUTH_EXPIRED" ]; then
    FAILURES=$((FAILURES + 1))
    AUTH_FAILURES="${AUTH_FAILURES}gmail,"
  elif [ "$GMAIL_RESULT" != "OK" ]; then
    # Transient (timeout/5xx, often machine-load induced) — do NOT trigger re-auth.
    echo "[gmail] transient failure, not treating as expired auth"
  fi
else
  echo "[gmail] NO_CREDENTIALS"
  FAILURES=$((FAILURES + 1))
fi

# 4. Google Calendar API (refresh token test)
CAL_TOKENS="$HOME/.config/google-calendar-mcp/tokens.json"
if [ -f "$CAL_TOKENS" ] && [ -f "$GMAIL_KEYS" ]; then
  CAL_RESULT=$(node -e "
    const fs = require('fs');
    const tokens = JSON.parse(fs.readFileSync('$CAL_TOKENS', 'utf-8'));
    const keys = JSON.parse(fs.readFileSync('$GMAIL_KEYS', 'utf-8'));
    const rt = (tokens.personal || tokens.normal || {}).refresh_token;
    if (!rt) { console.log('NO_TOKEN'); process.exit(0); }
    const params = new URLSearchParams({
      client_id: keys.installed.client_id,
      client_secret: keys.installed.client_secret,
      refresh_token: rt,
      grant_type: 'refresh_token'
    });
    fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params, signal: AbortSignal.timeout(10000) })
      .then(r => r.json())
      .then(d => {
        if (d.access_token) return console.log('OK');
        // Only invalid_grant means the refresh token is actually dead.
        // Other error payloads (rate limit, 5xx) are transient.
        console.log(d.error === 'invalid_grant' ? 'AUTH_EXPIRED' : 'TRANSIENT');
      })
      .catch(() => console.log('TRANSIENT'));
  " 2>/dev/null)
  echo "[calendar] $CAL_RESULT"
  if [ "$CAL_RESULT" = "AUTH_EXPIRED" ]; then
    FAILURES=$((FAILURES + 1))
    AUTH_FAILURES="${AUTH_FAILURES}calendar,"
  elif [ "$CAL_RESULT" != "OK" ]; then
    # Transient (timeout/5xx, often machine-load induced) — do NOT trigger re-auth.
    echo "[calendar] transient failure, not treating as expired auth"
  fi
else
  echo "[calendar] NO_TOKENS"
  FAILURES=$((FAILURES + 1))
fi

# If any Google auth expired, queue a re-auth message for the Rooster
if [ -n "$AUTH_FAILURES" ]; then
  echo ""
  echo "AUTH_EXPIRED: $AUTH_FAILURES"
  echo "Queuing re-auth for Rooster..."

  QUEUE_FILE="$HOME/.homestead/queue.json"
  node -e "
    const fs = require('fs');
    const queue = JSON.parse(fs.readFileSync('$QUEUE_FILE', 'utf-8'));
    // Dedup: check if there's already a pending reauth message
    const hasPending = queue.some(q =>
      q.target_session === 'holler-rooster' &&
      q.status === 'pending' &&
      q.message.includes('reauth_google')
    );
    if (hasPending) {
      console.log('Re-auth already queued, skipping');
      process.exit(0);
    }
    queue.push({
      id: Date.now() + '-healthcheck-reauth',
      target_session: 'holler-rooster',
      type: 'action',
      message: JSON.stringify({
        type: 'action',
        trigger: 'reauth_google',
        from: 'health-check',
        services: '${AUTH_FAILURES}'.split(',').filter(Boolean)
      }),
      status: 'pending',
      created_at: new Date().toISOString(),
      attempts: 0
    });
    // ATOMIC (torn-read fix 2026-08-25): temp+rename so the dispatcher never
    // reads a half-written queue.json. rename() within one fs is atomic.
    const tmp='$QUEUE_FILE'+'.tmp-'+process.pid+'-'+Date.now();
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
    fs.renameSync(tmp, '$QUEUE_FILE');
    console.log('Re-auth queued for Rooster');
  " 2>/dev/null
fi

echo ""
if [ $FAILURES -gt 0 ]; then
  echo "$FAILURES connection(s) failed"
  exit 1
else
  echo "All connections OK"
fi
