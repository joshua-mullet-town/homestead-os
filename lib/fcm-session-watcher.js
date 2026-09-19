/**
 * FCM Session Watcher
 *
 * Polls claude session statuses and sends FCM push notifications
 * when a session transitions from working → waiting.
 */

const { readFileSync, writeFileSync, existsSync } = require('fs');
const path = require('path');

const SERVICE_ACCOUNT_PATH = '<<REPLACE: your home dir, e.g. /Users/you>>/.homestead/firebase-service-account.json';
const TOKEN_FILE = '/tmp/homestead-fcm-tokens.json';
const POLL_INTERVAL = 15_000; // 15 seconds

// Track previous statuses
const previousStatuses = new Map();
let admin = null;
let intervalId = null;

function ensureFirebaseInit() {
  if (admin && admin.apps && admin.apps.length > 0) return true;
  try {
    if (!existsSync(SERVICE_ACCOUNT_PATH)) {
      console.log('[FCM Watcher] No service account file found at', SERVICE_ACCOUNT_PATH);
      return false;
    }
    admin = require('firebase-admin');
    const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[FCM Watcher] Firebase Admin initialized');
    return true;
  } catch (e) {
    console.error('[FCM Watcher] Firebase init error:', e.message || e);
    return false;
  }
}

function getTokens() {
  if (!existsSync(TOKEN_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

async function fetchSessionStatuses() {
  try {
    const response = await fetch('http://localhost:3005/api/claude-sessions?raw=true');
    if (!response.ok) return new Map();

    const data = await response.json();
    const sessions = data.sessions || [];

    const statuses = new Map();
    for (const session of sessions) {
      const tmuxSession = session.tmuxSession || session.tmux_session || '';
      const status = session.status || 'idle';
      if (tmuxSession) {
        statuses.set(tmuxSession, status);
      }
    }
    return statuses;
  } catch {
    return new Map();
  }
}

async function sendPushNotification(sessionName) {
  if (!admin) return;

  const tokens = getTokens();
  if (tokens.length === 0) {
    console.log('[FCM Watcher] No registered tokens, skipping push');
    return;
  }

  const stripped = sessionName.replace('holler-', '');
  const displayName = stripped.includes('--')
    ? `${stripped.split('--')[0]} (${stripped.split('--')[1]})`
    : stripped;

  try {
    const message = {
      tokens,
      data: {
        sessionName,
        status: 'waiting',
      },
      notification: {
        title: 'Session ready',
        body: `${displayName} is waiting for input`,
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'homestead_session_ready',
          sound: 'default',
        },
      },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`[FCM Watcher] Push sent for ${sessionName}: ${response.successCount}/${tokens.length} delivered`);

    // Clean invalid tokens
    if (response.failureCount > 0) {
      const validTokens = tokens.filter((_, i) => response.responses[i].success);
      if (validTokens.length < tokens.length) {
        writeFileSync(TOKEN_FILE, JSON.stringify(validTokens, null, 2));
        console.log(`[FCM Watcher] Cleaned ${tokens.length - validTokens.length} invalid tokens`);
      }
    }
  } catch (e) {
    console.error(`[FCM Watcher] Push failed for ${sessionName}:`, e.message || e);
  }
}

async function poll() {
  const statuses = await fetchSessionStatuses();

  if (statuses.size === 0) {
    console.log('[FCM Watcher] Poll: no sessions found');
    return;
  }

  const summary = [];
  for (const [sessionName, newStatus] of statuses) {
    const prevStatus = previousStatuses.get(sessionName);
    const shortName = sessionName.replace('holler-', '');
    summary.push(`${shortName}: ${prevStatus || '?'} → ${newStatus}`);

    if (prevStatus === 'working' && newStatus === 'waiting') {
      console.log(`[FCM Watcher] 🔔 ${sessionName}: working → waiting — sending push!`);
      await sendPushNotification(sessionName);
    }

    previousStatuses.set(sessionName, newStatus);
  }

  console.log(`[FCM Watcher] Poll: ${summary.join(' | ')}`);
}

function start() {
  if (!ensureFirebaseInit()) {
    console.log('[FCM Watcher] Skipping — Firebase not configured');
    return;
  }

  console.log(`[FCM Watcher] Starting (polling every ${POLL_INTERVAL / 1000}s)`);

  // Initial poll to seed statuses (after a delay to let the server start)
  setTimeout(() => poll(), 5000);

  intervalId = setInterval(poll, POLL_INTERVAL);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[FCM Watcher] Stopped');
  }
}

module.exports = { start, stop };
