// Homestead Service Worker for Push Notifications
// Version: 5 - Fixed push subscription recovery

const CACHE_VERSION = 'v5';

// VAPID public key - injected during service worker registration
// This gets set via postMessage from the main thread
let vapidPublicKey = null;

self.addEventListener('install', (event) => {
  console.log('[SW] Service worker installed, version:', CACHE_VERSION);
  // Clear any old caches
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          console.log('[SW] Deleting old cache:', cacheName);
          return caches.delete(cacheName);
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Service worker activated');
  event.waitUntil(clients.claim());
});

// Listen for VAPID key from main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SET_VAPID_KEY') {
    vapidPublicKey = event.data.vapidPublicKey;
    console.log('[SW] VAPID key received');
  }
});

// Handle incoming push notifications
self.addEventListener('push', (event) => {
  console.log('[SW] Push received:', event);

  let data = {
    title: 'Steward',
    body: 'You have a notification',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: {}
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      data = {
        title: payload.title || data.title,
        body: payload.body || data.body,
        icon: payload.icon || data.icon,
        badge: payload.badge || data.badge,
        data: payload.data || {}
      };
    } catch (e) {
      console.error('[SW] Error parsing push data:', e);
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    vibrate: [200, 100, 200],
    data: data.data,
    requireInteraction: true, // Keep notification visible until user interacts
    actions: data.data.actions || []
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event);

  event.notification.close();

  const data = event.notification.data || {};
  const actionUrl = data.url || data.action_url || '/';

  // Handle action button clicks
  if (event.action) {
    console.log('[SW] Action clicked:', event.action);
    // Could handle specific action buttons here
  }

  // Open or focus the app with the action URL
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Try to focus an existing window
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.navigate(actionUrl);
            return client.focus();
          }
        }
        // No existing window, open new one
        if (clients.openWindow) {
          return clients.openWindow(actionUrl);
        }
      })
  );
});

// Handle subscription changes (when subscription is invalidated)
self.addEventListener('pushsubscriptionchange', (event) => {
  console.log('[SW] Push subscription changed - attempting to re-subscribe');

  if (!vapidPublicKey) {
    console.error('[SW] Cannot re-subscribe: VAPID key not available');
    return;
  }

  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
    })
    .then((subscription) => {
      console.log('[SW] Re-subscribed successfully');
      // Send new subscription to server
      return fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription)
      });
    })
    .then((response) => {
      if (response.ok) {
        console.log('[SW] New subscription saved to server');
      } else {
        console.error('[SW] Failed to save new subscription');
      }
    })
    .catch((err) => {
      console.error('[SW] Re-subscription failed:', err);
    })
  );
});

// Helper function to convert VAPID key
function urlBase64ToUint8Array(base64String) {
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
