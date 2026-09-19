import { NextRequest, NextResponse } from 'next/server';

// In-memory store for 2FA codes
// Format: { [request_id]: { code: string, timestamp: number } }
const codeStore: Map<string, { code: string; timestamp: number }> = new Map();

// Clean up codes older than 5 minutes
const CODE_TTL_MS = 5 * 60 * 1000;

function cleanupOldCodes() {
  const now = Date.now();
  for (const [requestId, data] of codeStore.entries()) {
    if (now - data.timestamp > CODE_TTL_MS) {
      codeStore.delete(requestId);
    }
  }
}

/**
 * POST /api/2fa-response
 *
 * Store a 2FA code for a request
 *
 * Body:
 * {
 *   "request_id": "unique-id",
 *   "code": "123456"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const { request_id, code } = await request.json();

    if (!request_id || !code) {
      return NextResponse.json(
        { success: false, error: 'Missing request_id or code' },
        { status: 400 }
      );
    }

    // Clean up old codes
    cleanupOldCodes();

    // Store the code
    codeStore.set(request_id, {
      code: code.toString(),
      timestamp: Date.now()
    });

    console.log(`[2FA Response] Stored code for ${request_id}: ${code}`);

    return NextResponse.json({
      success: true,
      message: 'Code stored'
    });

  } catch (err) {
    console.error('[2FA Response] Error storing code:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to store code' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/2fa-response?request_id=xxx
 *
 * Poll for a 2FA code
 * Returns the code if available, or null if not yet submitted
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const requestId = searchParams.get('request_id');

    if (!requestId) {
      return NextResponse.json(
        { success: false, error: 'Missing request_id' },
        { status: 400 }
      );
    }

    // Clean up old codes
    cleanupOldCodes();

    const data = codeStore.get(requestId);

    if (data) {
      // Code found - return it and optionally remove it
      const shouldConsume = searchParams.get('consume') !== 'false';
      if (shouldConsume) {
        codeStore.delete(requestId);
        console.log(`[2FA Response] Code consumed for ${requestId}`);
      }

      return NextResponse.json({
        success: true,
        code: data.code,
        age_ms: Date.now() - data.timestamp
      });
    }

    // No code yet
    return NextResponse.json({
      success: true,
      code: null,
      message: 'No code submitted yet'
    });

  } catch (err) {
    console.error('[2FA Response] Error fetching code:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch code' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/2fa-response?request_id=xxx
 *
 * Delete a pending 2FA request (cleanup)
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const requestId = searchParams.get('request_id');

    if (!requestId) {
      return NextResponse.json(
        { success: false, error: 'Missing request_id' },
        { status: 400 }
      );
    }

    const existed = codeStore.has(requestId);
    codeStore.delete(requestId);

    return NextResponse.json({
      success: true,
      deleted: existed
    });

  } catch (err) {
    console.error('[2FA Response] Error deleting code:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to delete code' },
      { status: 500 }
    );
  }
}
