'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { io as socketIO } from 'socket.io-client';

/**
 * Listens for 'navigate' Socket.IO events and navigates the browser.
 * Used by mobile app to switch what the Mac's browser is showing.
 */
export default function RemoteNavigator() {
  const router = useRouter();

  useEffect(() => {
    const socketUrl = typeof window !== 'undefined'
      ? `http://${window.location.hostname}:3005`
      : 'http://localhost:3005';

    const socket = socketIO(socketUrl, {
      transports: ['websocket', 'polling'],
    });

    socket.on('navigate', (data: { path: string }) => {
      if (data.path) {
        console.log('[RemoteNavigator] Navigating to:', data.path);
        router.push(data.path);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [router]);

  return null;
}
