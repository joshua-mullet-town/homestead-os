'use client';

import { useEffect, useRef } from 'react';

/**
 * WakeLock component - prevents screen from dimming/sleeping
 * Uses the Screen Wake Lock API (supported on iOS Safari 16.4+ and most modern browsers)
 */
export default function WakeLock() {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let mounted = true;

    const requestWakeLock = async () => {
      // Check if Wake Lock API is supported
      if (!('wakeLock' in navigator)) {
        console.log('[WakeLock] Wake Lock API not supported');
        return;
      }

      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        console.log('[WakeLock] Wake lock acquired');

        // Listen for release (e.g., when tab becomes hidden)
        wakeLockRef.current.addEventListener('release', () => {
          console.log('[WakeLock] Wake lock released');
        });
      } catch (err) {
        // This can happen if the page is not visible or user denied permission
        console.log('[WakeLock] Failed to acquire:', err);
      }
    };

    // Request wake lock on mount
    requestWakeLock();

    // Re-acquire wake lock when page becomes visible again
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && mounted) {
        requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);

      // Release wake lock on unmount
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, []);

  // This component renders nothing
  return null;
}
