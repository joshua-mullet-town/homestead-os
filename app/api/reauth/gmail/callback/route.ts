import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/reauth/gmail/callback
 *
 * OAuth callback handler - Google redirects here with the auth code.
 * We redirect to the reauth page with the code as a query param.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    console.error('[Gmail OAuth Callback] Error:', error);
    return NextResponse.redirect(
      new URL(`/reauth/gmail?error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code) {
    console.error('[Gmail OAuth Callback] No code received');
    return NextResponse.redirect(
      new URL('/reauth/gmail?error=no_code', request.url)
    );
  }

  console.log('[Gmail OAuth Callback] Received auth code, redirecting to complete flow');

  // Redirect to the reauth page with the code
  // The page will then POST to /api/reauth/gmail to exchange it
  return NextResponse.redirect(
    new URL(`/reauth/gmail?code=${encodeURIComponent(code)}`, request.url)
  );
}
