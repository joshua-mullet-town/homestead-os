import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import webpush from 'web-push';

const SUBSCRIPTIONS_FILE = path.join(process.cwd(), 'push-subscriptions.json');

// Configure web-push with VAPID keys
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:<<REPLACE: your email>>';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

interface PushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  data?: {
    action_url?: string;
    request_id?: string;
    [key: string]: unknown;
  };
}

async function loadSubscriptions(): Promise<PushSubscription[]> {
  try {
    if (existsSync(SUBSCRIPTIONS_FILE)) {
      const content = await readFile(SUBSCRIPTIONS_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('[Push Send] Error loading subscriptions:', err);
  }
  return [];
}

async function saveSubscriptions(subscriptions: PushSubscription[]) {
  await writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
}

/**
 * POST /api/push/send
 *
 * Send a push notification to all subscribed devices
 *
 * Body:
 * {
 *   "title": "Notification title",
 *   "body": "Notification body",
 *   "action_url": "/2fa-input?request_id=xxx" (optional)
 *   "request_id": "unique-id" (optional)
 * }
 */
export async function POST(request: NextRequest) {
  console.log('[Push Send] === START REQUEST ===');

  try {
    console.log('[Push Send] VAPID_PUBLIC_KEY set:', !!VAPID_PUBLIC_KEY);
    console.log('[Push Send] VAPID_PRIVATE_KEY set:', !!VAPID_PRIVATE_KEY);

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      console.log('[Push Send] ERROR: VAPID keys not configured');
      return NextResponse.json(
        { success: false, error: 'VAPID keys not configured' },
        { status: 500 }
      );
    }

    const body = await request.json();
    console.log('[Push Send] Request body:', JSON.stringify(body));

    const { title, body: messageBody, action_url, request_id, icon, badge } = body;

    if (!title || !messageBody) {
      console.log('[Push Send] ERROR: Missing title or body');
      return NextResponse.json(
        { success: false, error: 'Missing title or body' },
        { status: 400 }
      );
    }

    const subscriptions = await loadSubscriptions();
    console.log('[Push Send] Loaded subscriptions:', subscriptions.length);

    if (subscriptions.length === 0) {
      console.log('[Push Send] ERROR: No subscriptions found');
      return NextResponse.json(
        { success: false, error: 'No subscriptions found' },
        { status: 404 }
      );
    }

    // Log subscription details
    subscriptions.forEach((sub, i) => {
      console.log(`[Push Send] Subscription ${i + 1}: endpoint=${sub.endpoint.substring(0, 60)}...`);
    });

    const payload: PushPayload = {
      title,
      body: messageBody,
      icon: icon || '/icon-192.png',
      badge: badge || '/icon-192.png',
      data: {
        action_url: action_url || '/',
        request_id: request_id || null
      }
    };
    console.log('[Push Send] Payload:', JSON.stringify(payload));

    const results = {
      sent: 0,
      failed: 0,
      expired: [] as string[],
      errors: [] as string[]
    };

    // Send to all subscriptions
    await Promise.all(
      subscriptions.map(async (subscription, index) => {
        console.log(`[Push Send] Sending to subscription ${index + 1}...`);
        try {
          const response = await webpush.sendNotification(
            subscription,
            JSON.stringify(payload),
            {
              TTL: 60 * 60, // 1 hour
              urgency: 'high'
            }
          );
          results.sent++;
          console.log(`[Push Send] SUCCESS for subscription ${index + 1}:`, response.statusCode);
        } catch (err: any) {
          results.failed++;
          results.errors.push(`Sub ${index + 1}: ${err.message} (status: ${err.statusCode})`);
          console.error(`[Push Send] FAILED for subscription ${index + 1}:`, {
            message: err.message,
            statusCode: err.statusCode,
            body: err.body,
            endpoint: subscription.endpoint.substring(0, 60)
          });

          // If subscription is expired or invalid, mark for removal
          if (err.statusCode === 404 || err.statusCode === 410) {
            results.expired.push(subscription.endpoint);
            console.log(`[Push Send] Marking subscription ${index + 1} as expired`);
          }
        }
      })
    );

    // Remove expired subscriptions
    if (results.expired.length > 0) {
      const validSubscriptions = subscriptions.filter(
        s => !results.expired.includes(s.endpoint)
      );
      await saveSubscriptions(validSubscriptions);
      console.log(`[Push Send] Removed ${results.expired.length} expired subscriptions`);
    }

    console.log('[Push Send] === FINAL RESULTS ===', results);

    return NextResponse.json({
      success: results.sent > 0,
      sent: results.sent,
      failed: results.failed,
      expiredRemoved: results.expired.length,
      errors: results.errors
    });

  } catch (err: any) {
    console.error('[Push Send] UNCAUGHT ERROR:', err.message, err.stack);
    return NextResponse.json(
      { success: false, error: 'Failed to send notification', details: err.message },
      { status: 500 }
    );
  }
}
