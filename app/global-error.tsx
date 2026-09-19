'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const route = typeof window !== 'undefined' ? window.location.pathname : '';
    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const timestamp = new Date().toISOString();

    const envelope = {
      type: 'action',
      source: 'uncaught-error',
      from: 'web-client',
      error_message: error.message,
      error_stack: error.stack || '',
      error_digest: error.digest || null,
      route,
      user_agent: userAgent,
      timestamp,
    };

    fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_session: 'holler-homestead',
        source: 'uncaught-error',
        message_override: JSON.stringify(envelope),
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
      })
      .catch((err) => {
        console.error('[global-error] walkie unreachable:', err);
      })
      .finally(() => {
        setTimeout(() => reset(), 0);
      });
  }, [error, reset]);

  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: 'transparent' }} />
    </html>
  );
}
