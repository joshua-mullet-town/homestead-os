'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export const dynamic = 'force-dynamic';
import { Mail, RefreshCw, CheckCircle, XCircle, ArrowLeft, ExternalLink } from 'lucide-react';

type Status = 'idle' | 'loading' | 'redirecting' | 'exchanging' | 'success' | 'error';

function GmailReauthContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string>('');

  // Check for code or error in URL (from OAuth callback)
  useEffect(() => {
    const code = searchParams.get('code');
    const urlError = searchParams.get('error');

    if (urlError) {
      setError(urlError === 'no_code' ? 'No authorization code received' : urlError);
      setStatus('error');
      return;
    }

    if (code) {
      // We have an auth code - exchange it for tokens
      exchangeCode(code);
    }
  }, [searchParams]);

  async function exchangeCode(code: string) {
    setStatus('exchanging');
    setError('');

    try {
      const res = await fetch('/api/reauth/gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setStatus('success');
        // Clear the code from URL
        router.replace('/reauth/gmail');
      } else {
        setError(data.error || 'Token exchange failed');
        setStatus('error');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  }

  async function startAuth() {
    setStatus('loading');
    setError('');

    try {
      // Get the OAuth URL from our API
      const res = await fetch('/api/reauth/gmail');
      const data = await res.json();

      if (data.error) {
        setError(data.error);
        setStatus('error');
        return;
      }

      if (data.authUrl) {
        setStatus('redirecting');
        // Redirect to Google OAuth
        window.location.href = data.authUrl;
      } else {
        setError('No auth URL received');
        setStatus('error');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start auth');
      setStatus('error');
    }
  }

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => router.push('/')}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 style={{ fontFamily: 'VT323, monospace' }} className="text-2xl text-[#FFCC00]">
            GMAIL RE-AUTH
          </h1>
        </div>

        {/* Status Card */}
        <div className="bg-gray-900 border-2 border-gray-800 rounded-lg p-6 mb-6">
          <div className="flex items-center gap-4 mb-6">
            <div className={`p-4 rounded-full ${
              status === 'success' ? 'bg-green-900/50' :
              status === 'error' ? 'bg-red-900/50' :
              (status === 'loading' || status === 'redirecting' || status === 'exchanging') ? 'bg-blue-900/50' :
              'bg-gray-800'
            }`}>
              {status === 'success' ? (
                <CheckCircle size={32} className="text-green-500" />
              ) : status === 'error' ? (
                <XCircle size={32} className="text-red-500" />
              ) : (status === 'loading' || status === 'redirecting' || status === 'exchanging') ? (
                <RefreshCw size={32} className="text-blue-500 animate-spin" />
              ) : (
                <Mail size={32} className="text-[#FF6600]" />
              )}
            </div>
            <div>
              <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-white">
                {status === 'success' ? 'Authentication Complete' :
                 status === 'error' ? 'Authentication Failed' :
                 status === 'loading' ? 'Starting...' :
                 status === 'redirecting' ? 'Redirecting to Google...' :
                 status === 'exchanging' ? 'Completing Authentication...' :
                 'Gmail Token Expired'}
              </h2>
              <p className="text-gray-400 text-sm mt-1">
                {status === 'success' ? 'Gmail is now connected' :
                 status === 'error' ? 'Please try again' :
                 status === 'loading' ? 'Preparing OAuth flow...' :
                 status === 'redirecting' ? 'Opening Google sign-in...' :
                 status === 'exchanging' ? 'Saving credentials...' :
                 'Your Gmail refresh token has expired'}
              </p>
            </div>
          </div>

          {status === 'idle' && (
            <div className="space-y-4">
              <p className="text-gray-300 text-sm">
                Click the button below to sign in with Google and re-authorize Gmail access.
              </p>
              <button
                onClick={startAuth}
                className="w-full py-3 px-4 bg-[#FF6600] hover:bg-[#FF8833] text-black font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
                style={{ fontFamily: 'VT323, monospace' }}
              >
                <ExternalLink size={18} />
                SIGN IN WITH GOOGLE
              </button>
            </div>
          )}

          {(status === 'loading' || status === 'redirecting' || status === 'exchanging') && (
            <div className="text-center py-4">
              <p className="text-blue-400 text-sm">
                {status === 'exchanging'
                  ? 'Almost done...'
                  : 'Please wait...'}
              </p>
            </div>
          )}

          {status === 'success' && (
            <button
              onClick={() => router.push('/')}
              className="w-full py-3 px-4 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg transition-colors"
              style={{ fontFamily: 'VT323, monospace' }}
            >
              BACK TO HOME
            </button>
          )}

          {status === 'error' && (
            <div className="space-y-3">
              {error && (
                <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}
              <button
                onClick={startAuth}
                className="w-full py-3 px-4 bg-[#FF6600] hover:bg-[#FF8833] text-black font-bold rounded-lg transition-colors"
                style={{ fontFamily: 'VT323, monospace' }}
              >
                TRY AGAIN
              </button>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="p-4 bg-gray-900/50 rounded-lg text-sm text-gray-400">
          <p className="mb-2">
            <strong className="text-gray-300">Why does this happen?</strong>
          </p>
          <p>
            Google OAuth tokens expire after 7 days when the app is in &quot;testing&quot; mode.
            This is normal and just requires periodic re-authentication.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function GmailReauthPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-[#FFCC00]">Loading...</div>
      </div>
    }>
      <GmailReauthContent />
    </Suspense>
  );
}
