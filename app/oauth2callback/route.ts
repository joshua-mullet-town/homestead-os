import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /oauth2callback
 *
 * OAuth callback handler - Google redirects here with the auth code.
 * We redirect to the homepage with the code as a query param.
 * The homepage modal will handle the token exchange.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    console.error('[OAuth Callback] Error:', error);
    return NextResponse.redirect(
      new URL(`/?error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code) {
    console.error('[OAuth Callback] No code received');
    return NextResponse.redirect(
      new URL('/?error=no_code', request.url)
    );
  }

  console.log('[OAuth Callback] Received auth code, redirecting to complete flow');

  // Redirect to homepage with the code
  // The homepage modal will handle the token exchange
  return NextResponse.redirect(
    new URL(`/?code=${encodeURIComponent(code)}`, request.url)
  );
}
