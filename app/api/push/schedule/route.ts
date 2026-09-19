import { NextRequest, NextResponse } from 'next/server';

// The scheduler is initialized in server.js and exposed globally
declare global {
  var scheduler: {
    addJob: (params: { delaySeconds: number; title: string; body: string; data?: any }) => {
      id: string;
      fires_at: string;
      status: string;
    };
    removeJob: (id: string) => boolean;
    listJobs: () => Array<{
      id: string;
      title: string;
      body: string;
      created_at: string;
      fires_at: string;
    }>;
  } | undefined;
}

/**
 * POST /api/push/schedule
 * Schedule a push notification for later
 *
 * Body: {
 *   delay_seconds: number,  // seconds from now
 *   title: string,
 *   body: string,
 *   data?: object  // optional extra data
 * }
 *
 * Response: {
 *   id: string,
 *   fires_at: string (ISO timestamp),
 *   status: "scheduled"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { delay_seconds, title, body: notificationBody, data } = body;

    // Validate required fields
    if (typeof delay_seconds !== 'number' || delay_seconds < 0) {
      return NextResponse.json(
        { error: 'delay_seconds must be a non-negative number' },
        { status: 400 }
      );
    }

    if (!title || typeof title !== 'string') {
      return NextResponse.json(
        { error: 'title is required and must be a string' },
        { status: 400 }
      );
    }

    if (!notificationBody || typeof notificationBody !== 'string') {
      return NextResponse.json(
        { error: 'body is required and must be a string' },
        { status: 400 }
      );
    }

    // Check if scheduler is available
    if (!global.scheduler) {
      return NextResponse.json(
        { error: 'Scheduler not initialized. Server may be starting up.' },
        { status: 503 }
      );
    }

    // Schedule the job
    const result = global.scheduler.addJob({
      delaySeconds: delay_seconds,
      title,
      body: notificationBody,
      data,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[API] Error scheduling notification:', error);
    return NextResponse.json(
      { error: 'Failed to schedule notification' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/push/schedule
 * List all scheduled notifications
 */
export async function GET() {
  try {
    if (!global.scheduler) {
      return NextResponse.json(
        { error: 'Scheduler not initialized' },
        { status: 503 }
      );
    }

    const jobs = global.scheduler.listJobs();
    return NextResponse.json({ jobs });
  } catch (error) {
    console.error('[API] Error listing scheduled notifications:', error);
    return NextResponse.json(
      { error: 'Failed to list scheduled notifications' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/push/schedule?id=xxx
 * Cancel a scheduled notification
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { error: 'id parameter is required' },
        { status: 400 }
      );
    }

    if (!global.scheduler) {
      return NextResponse.json(
        { error: 'Scheduler not initialized' },
        { status: 503 }
      );
    }

    const removed = global.scheduler.removeJob(id);
    return NextResponse.json({ success: removed, id });
  } catch (error) {
    console.error('[API] Error canceling scheduled notification:', error);
    return NextResponse.json(
      { error: 'Failed to cancel scheduled notification' },
      { status: 500 }
    );
  }
}
