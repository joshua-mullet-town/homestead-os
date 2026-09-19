import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const SUBSCRIPTIONS_FILE = path.join(process.cwd(), 'push-subscriptions.json');

/**
 * GET /api/push/test
 *
 * Health check endpoint for push notifications.
 * Returns whether there's an active subscription.
 */
export async function GET() {
  try {
    if (!existsSync(SUBSCRIPTIONS_FILE)) {
      return NextResponse.json({
        hasSubscription: false,
        error: 'No subscriptions file'
      });
    }

    const content = await readFile(SUBSCRIPTIONS_FILE, 'utf-8');
    const subscriptions = JSON.parse(content);

    return NextResponse.json({
      hasSubscription: subscriptions.length > 0,
      count: subscriptions.length
    });

  } catch (err) {
    console.error('[Push Test] Error:', err);
    return NextResponse.json({
      hasSubscription: false,
      error: 'Failed to check subscriptions'
    }, { status: 500 });
  }
}
