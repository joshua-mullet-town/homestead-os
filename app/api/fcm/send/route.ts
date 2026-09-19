import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import admin from 'firebase-admin';

const TOKEN_FILE = '/tmp/homestead-fcm-tokens.json';
const SERVICE_ACCOUNT_PATH = '<<REPLACE: your home dir, e.g. /Users/you>>/.homestead/firebase-service-account.json';

// Initialize Firebase Admin once
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[FCM] Firebase Admin initialized');
  } catch (e) {
    console.error('[FCM] Failed to initialize Firebase Admin:', e);
  }
}

function getTokens(): string[] {
  if (!existsSync(TOKEN_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * POST /api/fcm/send
 * Sends a push notification to all registered devices.
 *
 * Supports two formats:
 * 1. Session notification: { sessionName: string, status: string }
 * 2. Custom notification:  { title: string, body: string, data?: Record<string, string>, channelId?: string, silent?: boolean }
 *
 * `silent: true` sends with no sound and min notification priority. It exists
 * for the notification DELIVERY PROBE (lib/health-checks.js), which has to push
 * a real notification every 30 minutes to prove delivery works — but must not
 * buzz Joshua while doing it. Josh, 2026-09-18, on getting banner+sound from a
 * self-test every half hour: "some automated process is fucking going on. What
 * the hell is that?" He chose "make it silent, keep the test."
 *
 * ⚠️ On Android 8+ the CHANNEL's importance governs heads-up banners, so this
 * flag cannot make an IMPORTANCE_HIGH channel fully silent on its own — the
 * probe's notification is also removed from the tray within seconds. Do NOT
 * "fix" that by moving the probe to a quiet channel: it deliberately tests the
 * presenter channel, the one Joshua's cards actually use.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionName, status, title, body: notifBody, data, channelId, silent } = body;

    // Require either sessionName or title
    if (!sessionName && !title) {
      return NextResponse.json({ error: 'sessionName or title is required' }, { status: 400 });
    }

    const tokens = getTokens();
    if (tokens.length === 0) {
      return NextResponse.json({ error: 'No registered devices' }, { status: 404 });
    }

    let message: admin.messaging.MulticastMessage;

    if (title) {
      // Custom notification (used by navigate-home, alerts, etc.)
      message = {
        tokens,
        data: {
          type: 'custom',
          ...(data || {}),
        },
        notification: {
          title,
          body: notifBody || '',
        },
        android: {
          priority: 'high' as const,
          notification: {
            channelId: channelId || 'homestead_alerts',
            // A silent push carries no sound at all; omitting the key is not
            // enough, and 'default' is what was buzzing him every 30 minutes.
            ...(silent
              ? { defaultSound: false, defaultVibrateTimings: false,
                  vibrateTimingsMillis: [0], priority: 'min' as const,
                  localOnly: true }
              : { sound: 'default' }),
          },
        },
      };
    } else {
      // Session notification (original format)
      const stripped = sessionName.replace('holler-', '');
      const displayName = stripped.includes('--')
        ? `${stripped.split('--')[0]} (${stripped.split('--')[1]})`
        : stripped;

      message = {
        tokens,
        data: {
          type: 'session_ready',
          sessionName,
          status: status || 'waiting',
        },
        notification: {
          title: 'Session ready',
          body: `${displayName} is waiting for input`,
        },
        android: {
          priority: 'high' as const,
          notification: {
            channelId: 'homestead_session_ready',
            sound: 'default',
          },
        },
      };
    }

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`[FCM] Sent to ${response.successCount}/${tokens.length} devices`);

    // Remove invalid tokens
    if (response.failureCount > 0) {
      const validTokens = tokens.filter((_, i) => response.responses[i].success);
      if (validTokens.length < tokens.length) {
        const { writeFileSync } = await import('fs');
        writeFileSync(TOKEN_FILE, JSON.stringify(validTokens, null, 2));
        console.log(`[FCM] Cleaned ${tokens.length - validTokens.length} invalid tokens`);
      }
    }

    return NextResponse.json({
      success: true,
      sent: response.successCount,
      failed: response.failureCount,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[FCM] Send error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    endpoint: '/api/fcm/send',
    usage: 'POST with { sessionName, status } or { title, body, data?, channelId? }',
    firebaseInitialized: admin.apps.length > 0,
  });
}
