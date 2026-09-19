import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const GMAIL_MCP_DIR = path.join(process.env.HOME || '', '.gmail-mcp');
const CREDENTIALS_FILE = path.join(GMAIL_MCP_DIR, 'credentials.json');
const OAUTH_KEYS_FILE = path.join(GMAIL_MCP_DIR, 'gcp-oauth.keys.json');

// Gmail scopes we need
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

interface OAuthKeys {
  installed: {
    client_id: string;
    client_secret: string;
  };
}

/**
 * GET /api/reauth/gmail
 *
 * Returns the OAuth URL to start authentication
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  // Check current status
  if (action === 'status') {
    try {
      const creds = await readFile(CREDENTIALS_FILE, 'utf-8');
      const parsed = JSON.parse(creds);
      return NextResponse.json({
        hasCredentials: true,
        hasRefreshToken: !!parsed.refresh_token,
      });
    } catch {
      return NextResponse.json({
        hasCredentials: false,
        hasRefreshToken: false,
      });
    }
  }

  // Generate OAuth URL
  try {
    if (!existsSync(OAUTH_KEYS_FILE)) {
      return NextResponse.json({
        error: 'OAuth keys file not found at ~/.gmail-mcp/gcp-oauth.keys.json',
      }, { status: 500 });
    }

    const keysContent = await readFile(OAUTH_KEYS_FILE, 'utf-8');
    const keys: OAuthKeys = JSON.parse(keysContent);
    const clientId = keys.installed.client_id;

    // Build OAuth URL - redirect to our callback on port 3005
    // For "installed app" OAuth, Google allows localhost with any port
    const redirectUri = 'http://localhost:3005/oauth2callback';
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent'); // Force consent to get refresh token

    return NextResponse.json({
      authUrl: authUrl.toString(),
      redirectUri,
    });

  } catch (err) {
    console.error('[Gmail Reauth] Error generating auth URL:', err);
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Failed to generate auth URL',
    }, { status: 500 });
  }
}

/**
 * POST /api/reauth/gmail
 *
 * Exchange authorization code for tokens
 */
export async function POST(request: NextRequest) {
  try {
    const { code } = await request.json();

    if (!code) {
      return NextResponse.json({
        error: 'Authorization code required',
      }, { status: 400 });
    }

    console.log('[Gmail Reauth] Exchanging auth code for tokens...');

    // Load OAuth keys
    const keysContent = await readFile(OAUTH_KEYS_FILE, 'utf-8');
    const keys: OAuthKeys = JSON.parse(keysContent);
    const clientId = keys.installed.client_id;
    const clientSecret = keys.installed.client_secret;

    // Exchange code for tokens
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const redirectUri = 'http://localhost:3005/oauth2callback';

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error('[Gmail Reauth] Token exchange failed:', tokenData);
      return NextResponse.json({
        error: tokenData.error_description || tokenData.error || 'Token exchange failed',
      }, { status: 400 });
    }

    if (!tokenData.refresh_token) {
      console.error('[Gmail Reauth] No refresh token in response:', tokenData);
      return NextResponse.json({
        error: 'No refresh token received. You may need to revoke access and try again.',
      }, { status: 400 });
    }

    // Save credentials
    const credentials = {
      type: 'authorized_user',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenData.refresh_token,
    };

    await writeFile(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
    console.log('[Gmail Reauth] Credentials saved successfully');

    // Update channel health
    try {
      const healthFile = path.join(process.cwd(), 'data', 'channel-health.json');
      if (existsSync(healthFile)) {
        const healthData = JSON.parse(await readFile(healthFile, 'utf-8'));
        healthData.channels.gmail = {
          status: 'connected',
          last_checked: new Date().toISOString(),
          last_success: new Date().toISOString(),
          error: null,
        };
        healthData.last_full_check = new Date().toISOString();
        await writeFile(healthFile, JSON.stringify(healthData, null, 2));
      }
    } catch (e) {
      console.error('[Gmail Reauth] Failed to update health file:', e);
    }

    return NextResponse.json({
      success: true,
      message: 'Gmail authenticated successfully',
    });

  } catch (err) {
    console.error('[Gmail Reauth] Error:', err);
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Authentication failed',
    }, { status: 500 });
  }
}
