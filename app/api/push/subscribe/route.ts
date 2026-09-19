import { NextRequest, NextResponse } from 'next/server';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const SUBSCRIPTIONS_FILE = path.join(process.cwd(), 'push-subscriptions.json');

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
    console.error('[Push Subscribe] Error loading subscriptions:', err);
  }
  return [];
}

async function saveSubscriptions(subscriptions: PushSubscription[]) {
  await writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
}

/**
 * POST /api/push/subscribe
 *
 * Save a new push subscription
 */
export async function POST(request: NextRequest) {
  try {
    const subscription = await request.json() as PushSubscription;

    if (!subscription.endpoint || !subscription.keys) {
      return NextResponse.json(
        { success: false, error: 'Invalid subscription format' },
        { status: 400 }
      );
    }

    const subscriptions = await loadSubscriptions();

    // Check if this endpoint already exists
    const existingIndex = subscriptions.findIndex(
      s => s.endpoint === subscription.endpoint
    );

    const subscriptionWithTimestamp = {
      ...subscription,
      createdAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      // Update existing subscription
      subscriptions[existingIndex] = subscriptionWithTimestamp;
      console.log('[Push Subscribe] Updated existing subscription');
    } else {
      // Add new subscription
      subscriptions.push(subscriptionWithTimestamp);
      console.log('[Push Subscribe] Added new subscription');
    }

    await saveSubscriptions(subscriptions);

    return NextResponse.json({
      success: true,
      message: 'Subscription saved',
      totalSubscriptions: subscriptions.length
    });

  } catch (err) {
    console.error('[Push Subscribe] Error:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to save subscription' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/push/subscribe
 *
 * Check subscription status
 */
export async function GET(request: NextRequest) {
  try {
    const subscriptions = await loadSubscriptions();

    return NextResponse.json({
      success: true,
      count: subscriptions.length,
      hasSubscriptions: subscriptions.length > 0
    });

  } catch (err) {
    console.error('[Push Subscribe] Error:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to check subscriptions' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/push/subscribe
 *
 * Remove a subscription
 */
export async function DELETE(request: NextRequest) {
  try {
    const { endpoint } = await request.json();

    if (!endpoint) {
      return NextResponse.json(
        { success: false, error: 'Missing endpoint' },
        { status: 400 }
      );
    }

    const subscriptions = await loadSubscriptions();
    const filtered = subscriptions.filter(s => s.endpoint !== endpoint);

    if (filtered.length === subscriptions.length) {
      return NextResponse.json({
        success: false,
        error: 'Subscription not found'
      }, { status: 404 });
    }

    await saveSubscriptions(filtered);

    return NextResponse.json({
      success: true,
      message: 'Subscription removed',
      remainingSubscriptions: filtered.length
    });

  } catch (err) {
    console.error('[Push Subscribe] Error:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to remove subscription' },
      { status: 500 }
    );
  }
}
