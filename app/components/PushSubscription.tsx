'use client';

import { useEffect, useState } from 'react';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function PushSubscription() {
  const [status, setStatus] = useState<'loading' | 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed' | 'resubscribing'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    async function setupPush() {
      // Check if push is supported
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setStatus('unsupported');
        return;
      }

      if (!VAPID_PUBLIC_KEY) {
        setError('VAPID key not configured');
        setStatus('unsupported');
        return;
      }

      try {
        // Register service worker
        const registration = await navigator.serviceWorker.register('/sw.js');
        console.log('[Push] Service worker registered:', registration.scope);

        // Wait for the service worker to be ready
        await navigator.serviceWorker.ready;

        // Send VAPID key to service worker for pushsubscriptionchange handling
        if (registration.active) {
          registration.active.postMessage({
            type: 'SET_VAPID_KEY',
            vapidPublicKey: VAPID_PUBLIC_KEY
          });
        }

        // Check notification permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setStatus('denied');
          return;
        }

        // Check existing subscription
        let subscription = await registration.pushManager.getSubscription();
        let needsNewSubscription = !subscription;

        // If we have an existing subscription, validate it with the server
        if (subscription) {
          console.log('[Push] Existing subscription found, validating...');
          try {
            const validateResponse = await fetch('/api/push/validate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            const validateResult = await validateResponse.json();

            if (validateResult.valid === false) {
              console.log('[Push] Subscription invalid, will create new one:', validateResult.reason);
              setStatus('resubscribing');
              setShowBanner(true);
              // Unsubscribe the invalid subscription
              await subscription.unsubscribe();
              needsNewSubscription = true;
            } else {
              console.log('[Push] Subscription validated successfully');
            }
          } catch (err) {
            console.warn('[Push] Validation check failed, assuming valid:', err);
          }
        }

        if (needsNewSubscription) {
          // Create new subscription
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource
          });
          console.log('[Push] New subscription created');
        }

        // Send subscription to server (always sync, in case endpoint changed)
        const response = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription!.toJSON())
        });

        if (response.ok) {
          setStatus('subscribed');
          console.log('[Push] Subscription saved to server');
        } else {
          throw new Error('Failed to save subscription');
        }

      } catch (err) {
        console.error('[Push] Setup error:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
        setStatus('unsubscribed');
      }
    }

    setupPush();
  }, []);

  // Show banner when push needs attention (visible in production)
  if (showBanner && (status === 'resubscribing' || status === 'denied' || status === 'unsubscribed')) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-yellow-600 text-black px-4 py-2 text-sm flex items-center justify-between">
        <span>
          {status === 'resubscribing' && '🔄 Push subscription expired, resubscribing...'}
          {status === 'denied' && '🔕 Push notifications denied - enable in browser settings'}
          {status === 'unsubscribed' && `⚠️ Push notification error: ${error || 'Unknown'}`}
        </span>
        <button
          onClick={() => setShowBanner(false)}
          className="text-black hover:text-gray-700 font-bold"
        >
          ✕
        </button>
      </div>
    );
  }

  // Show success banner briefly after resubscribing
  if (showBanner && status === 'subscribed') {
    // Auto-hide after 3 seconds
    setTimeout(() => setShowBanner(false), 3000);
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-green-600 text-white px-4 py-2 text-sm flex items-center justify-between">
        <span>✓ Push notifications restored!</span>
        <button
          onClick={() => setShowBanner(false)}
          className="text-white hover:text-gray-200 font-bold"
        >
          ✕
        </button>
      </div>
    );
  }

  // Dev-only status indicator (bottom right, subtle)
  if (process.env.NODE_ENV === 'development') {
    return (
      <div className="fixed bottom-2 right-2 text-xs opacity-50 hover:opacity-100 transition-opacity">
        {status === 'loading' && '🔔 Loading...'}
        {status === 'subscribed' && '🔔 Push OK'}
        {status === 'resubscribing' && '🔄 Resubscribing...'}
        {status === 'denied' && '🔕 Push denied'}
        {status === 'unsupported' && '❌ Push unsupported'}
        {status === 'unsubscribed' && '⚠️ Push error'}
        {error && <span className="text-red-500 ml-1">{error}</span>}
      </div>
    );
  }

  return null;
}
