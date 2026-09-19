import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import webpush from 'web-push';

const SUBSCRIPTIONS_FILE = path.join(process.cwd(), 'push-subscriptions.json');

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
  createdAt?: string;
}

async function loadSubscriptions(): Promise<PushSubscription[]> {
  try {
    if (existsSync(SUBSCRIPTIONS_FILE)) {
      const content = await readFile(SUBSCRIPTIONS_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('[Push Validate] Error loading subscriptions:', err);
  }
  return [];
}

async function saveSubscriptions(subscriptions: PushSubscription[]) {
  await writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
}

/**
 * POST /api/push/validate
 *
 * Validate a specific subscription by sending a silent test push
 * Also cleans up any stale subscriptions found
 *
 * Body: { endpoint: string } - the endpoint to validate
 *
 * Returns:
 * - valid: true/false - whether this specific subscription is valid
 * - cleaned: number - how many stale subscriptions were removed
 */
export async function POST(request: NextRequest) {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return NextResponse.json(
        { success: false, error: 'VAPID keys not configured' },
        { status: 500 }
      );
    }

    const { endpoint } = await request.json();

    if (!endpoint) {
      return NextResponse.json(
        { success: false, error: 'Missing endpoint' },
        { status: 400 }
      );
    }

    const subscriptions = await loadSubscriptions();
    const subscription = subscriptions.find(s => s.endpoint === endpoint);

    if (!subscription) {
      return NextResponse.json({
        success: true,
        valid: false,
        reason: 'not_found',
        message: 'Subscription not found on server'
      });
    }

    // Try to send a silent/invisible push to validate the subscription
    // We use a very short TTL so it expires quickly if not delivered
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({ type: 'validation_ping' }),
        { TTL: 0 } // Immediate expiry - just checking if endpoint is valid
      );

      console.log('[Push Validate] Subscription is valid:', endpoint.substring(0, 50));

      return NextResponse.json({
        success: true,
        valid: true,
        message: 'Subscription is valid'
      });
    } catch (err: any) {
      console.error('[Push Validate] Subscription invalid:', err.message);

      // 404 or 410 means the subscription is expired/invalid
      if (err.statusCode === 404 || err.statusCode === 410) {
        // Remove the invalid subscription
        const validSubscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
        await saveSubscriptions(validSubscriptions);

        return NextResponse.json({
          success: true,
          valid: false,
          reason: 'expired',
          message: 'Subscription expired and was removed',
          cleaned: 1
        });
      }

      // Other errors (network, etc) - subscription might still be valid
      return NextResponse.json({
        success: true,
        valid: null, // Unknown
        reason: 'error',
        message: `Validation failed: ${err.message}`
      });
    }

  } catch (err) {
    console.error('[Push Validate] Error:', err);
    return NextResponse.json(
      { success: false, error: 'Validation failed' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/push/validate
 *
 * Validate ALL subscriptions and clean up stale ones
 * This is useful to run periodically or on server startup
 */
export async function GET() {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return NextResponse.json(
        { success: false, error: 'VAPID keys not configured' },
        { status: 500 }
      );
    }

    const subscriptions = await loadSubscriptions();

    if (subscriptions.length === 0) {
      return NextResponse.json({
        success: true,
        total: 0,
        valid: 0,
        invalid: 0,
        cleaned: 0,
        message: 'No subscriptions to validate'
      });
    }

    const results = {
      valid: 0,
      invalid: 0,
      unknown: 0,
      expiredEndpoints: [] as string[]
    };

    // Validate each subscription
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            subscription,
            JSON.stringify({ type: 'validation_ping' }),
            { TTL: 0 }
          );
          results.valid++;
        } catch (err: any) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            results.invalid++;
            results.expiredEndpoints.push(subscription.endpoint);
          } else {
            results.unknown++;
          }
        }
      })
    );

    // Clean up expired subscriptions
    if (results.expiredEndpoints.length > 0) {
      const validSubscriptions = subscriptions.filter(
        s => !results.expiredEndpoints.includes(s.endpoint)
      );
      await saveSubscriptions(validSubscriptions);
      console.log(`[Push Validate] Cleaned ${results.expiredEndpoints.length} expired subscriptions`);
    }

    return NextResponse.json({
      success: true,
      total: subscriptions.length,
      valid: results.valid,
      invalid: results.invalid,
      unknown: results.unknown,
      cleaned: results.expiredEndpoints.length,
      message: results.invalid > 0
        ? `Removed ${results.invalid} expired subscription(s)`
        : 'All subscriptions are valid'
    });

  } catch (err) {
    console.error('[Push Validate] Error:', err);
    return NextResponse.json(
      { success: false, error: 'Validation failed' },
      { status: 500 }
    );
  }
}
