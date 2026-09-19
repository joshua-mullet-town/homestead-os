/**
 * Location Reminder Checker
 *
 * Checks the phone's current GPS location against pending location-based reminders.
 * If the user is within the radius of a reminder's location, triggers it via presenter.
 *
 * Data file: data/location-reminders.json
 * Format:
 * {
 *   "known_locations": {
 *     "home": { "latitude": 39.123, "longitude": -84.456, "label": "Home" },
 *     "work": { "latitude": 39.789, "longitude": -84.012, "label": "Work" }
 *   },
 *   "reminders": [
 *     {
 *       "id": "abc123",
 *       "location_name": "home",
 *       "reminder_text": "Take out the trash",
 *       "latitude": 39.123,
 *       "longitude": -84.456,
 *       "radius_meters": 200,
 *       "enabled": true,
 *       "one_shot": true,
 *       "created_at": "2026-03-21T22:00:00Z",
 *       "last_triggered": null,
 *       "cooldown_minutes": 60
 *     }
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const DATA_FILE = path.join(process.cwd(), 'data', 'location-reminders.json');
const NAV_STATE_FILE = path.join(process.cwd(), 'data', 'nav-home-state.json');
const PHONE_BASE_URL = process.env.PHONE_API_URL || 'http://<<REPLACE: your Tailscale IP>>:8888';
const HOMESTEAD_URL = 'http://localhost:3005';
const HOME_RADIUS_METERS = 2500; // Consider "home" within this radius

function log(msg, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] [LocationReminder] ${msg}`);
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (err) {
    log(`Error loading data: ${err.message}`, 'ERROR');
  }
  return { known_locations: {}, reminders: [] };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Error saving data: ${err.message}`, 'ERROR');
  }
}

/**
 * Haversine distance between two lat/lng points in meters
 */
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Fetch JSON from a URL
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? require('https') : http;
    protocol.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Parse error: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

/**
 * POST JSON to a URL
 */
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Timeout')));
    req.write(JSON.stringify(body));
    req.end();
  });
}

function loadNavState() {
  try {
    if (fs.existsSync(NAV_STATE_FILE)) return JSON.parse(fs.readFileSync(NAV_STATE_FILE, 'utf-8'));
  } catch {}
  return { away_from_home: false, card_dismissed: false, card_id: null };
}

function saveNavState(state) {
  fs.writeFileSync(NAV_STATE_FILE, JSON.stringify(state, null, 2));
}

async function checkNavigateHome(location, data) {
  const home = data.known_locations?.home;
  if (!home) return; // No home location set

  const distFromHome = distanceMeters(
    location.latitude, location.longitude,
    home.latitude, home.longitude
  );

  const navState = loadNavState();
  const isHome = distFromHome <= HOME_RADIUS_METERS;

  if (isHome) {
    // Arrived home — reset state
    if (navState.away_from_home) {
      log('Arrived home — resetting navigate-home state');
      saveNavState({ away_from_home: false, card_dismissed: false, card_id: null });
    }
    return;
  }

  // Away from home
  if (!navState.away_from_home) {
    // Just left home
    navState.away_from_home = true;
    navState.card_dismissed = false;
    navState.card_id = null;
    saveNavState(navState);
  }

  // Show navigate-home notification if not dismissed
  if (!navState.card_dismissed) {
    // Only send once (check if we already sent one)
    if (navState.card_id) return;

    const distKm = (distFromHome / 1000).toFixed(1);

    // Send FCM push notification to phone (tappable, opens Google Maps)
    // Use address if available for better navigation accuracy, fall back to coordinates
    const navDest = home.address
      ? encodeURIComponent(home.address)
      : `${home.latitude},${home.longitude}`;
    const navUri = home.address
      ? `google.navigation:q=${encodeURIComponent(home.address)}`
      : `google.navigation:q=${home.latitude},${home.longitude}`;

    try {
      await postJson(`${HOMESTEAD_URL}/api/fcm/send`, {
        title: '🏠 Navigate Home',
        body: `You're ${distKm}km from home. Tap to navigate.`,
        data: {
          action: 'navigate_home',
          uri: navUri,
          url: `https://www.google.com/maps/dir/?api=1&destination=${navDest}&travelmode=driving`,
        },
      });
      log(`Navigate-home push sent (${distKm}km from home)`);
    } catch (err) {
      log(`Failed to send navigate-home push: ${err.message}`, 'WARN');
    }

    // Also send presenter card (for Mac/web UI)
    try {
      const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${navDest}&travelmode=driving`;
      const result = await postJson(`${HOMESTEAD_URL}/api/presenter/queue`, {
        session_id: 'holler-rooster',
        callback_session: 'holler-rooster',
        title: '🏠 Navigate Home',
        message: `You're ${distKm}km from home.`,
        buttons: [
          { label: 'Navigate Home', run: `curl -s -X POST http://<<REPLACE: your Tailscale IP>>:8888/app/launch -H "Content-Type: application/json" -d '{"uri":"${navUri}"}' && open "${mapsUrl}"` },
          'Dismiss',
        ],
        priority: 'normal',
        category: 'situation',
      });
      if (result.id) {
        navState.card_id = result.id;
        saveNavState(navState);
      }
    } catch (err) {
      log(`Failed to send navigate-home presenter card: ${err.message}`, 'WARN');
    }
  }
}

async function main() {
  const data = loadData();
  const activeReminders = data.reminders.filter(r => r.enabled);
  const hasHome = !!data.known_locations?.home;

  // Always check location if we have a home set (for navigate-home) OR if there are active reminders
  if (activeReminders.length === 0 && !hasHome) {
    log('No active reminders and no home location, skipping');
    console.log(JSON.stringify({ triggered: false, reason: 'nothing_to_check' }));
    return;
  }

  // Get phone location
  let location;
  try {
    const resp = await fetchJson(`${PHONE_BASE_URL}/location`);
    if (!resp.success || !resp.data) {
      log(`Location unavailable: ${resp.error || 'no data'}`, 'WARN');
      console.log(JSON.stringify({ triggered: false, reason: 'location_unavailable', error: resp.error }));
      return;
    }
    location = resp.data;
  } catch (err) {
    log(`Failed to get location: ${err.message}`, 'ERROR');
    console.log(JSON.stringify({ triggered: false, reason: 'phone_unreachable', error: err.message }));
    return;
  }

  // Skip if location is too old (more than 10 minutes)
  if (location.age_seconds > 600) {
    log(`Location too stale (${location.age_seconds}s old), skipping`, 'WARN');
    console.log(JSON.stringify({ triggered: false, reason: 'stale_location', age_seconds: location.age_seconds }));
    return;
  }

  log(`Location: ${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)} (±${Math.round(location.accuracy)}m, ${location.age_seconds}s old)`);

  // Check navigate-home feature
  await checkNavigateHome(location, data);

  const triggered = [];
  const now = Date.now();

  for (const reminder of activeReminders) {
    // Check cooldown (don't re-trigger within cooldown period)
    const cooldownMs = (reminder.cooldown_minutes || 60) * 60 * 1000;
    if (reminder.last_triggered) {
      const timeSinceLastTrigger = now - new Date(reminder.last_triggered).getTime();
      if (timeSinceLastTrigger < cooldownMs) {
        continue;
      }
    }

    // Calculate distance
    const dist = distanceMeters(
      location.latitude, location.longitude,
      reminder.latitude, reminder.longitude
    );

    const radius = reminder.radius_meters || 200;

    if (dist <= radius) {
      log(`MATCH: "${reminder.reminder_text}" — ${Math.round(dist)}m from ${reminder.location_name} (radius: ${radius}m)`);

      // Send via presenter
      try {
        await postJson(`${HOMESTEAD_URL}/api/presenter/queue`, {
          session_id: 'holler-rooster',
          callback_session: 'holler-rooster',
          title: `📍 ${reminder.location_name}`,
          message: reminder.reminder_text,
          buttons: ['Got it', 'Snooze 1h'],
          priority: 'normal',
          category: 'situation',
        });
        log(`Presenter card sent for: ${reminder.reminder_text}`);
      } catch (err) {
        log(`Failed to send presenter card: ${err.message}`, 'ERROR');
      }

      // Update last_triggered
      const idx = data.reminders.findIndex(r => r.id === reminder.id);
      if (idx >= 0) {
        data.reminders[idx].last_triggered = new Date().toISOString();

        // Disable one-shot reminders
        if (reminder.one_shot) {
          data.reminders[idx].enabled = false;
          log(`One-shot reminder "${reminder.reminder_text}" disabled after trigger`);
        }
      }

      triggered.push({
        id: reminder.id,
        text: reminder.reminder_text,
        location: reminder.location_name,
        distance_meters: Math.round(dist),
      });
    }
  }

  if (triggered.length > 0) {
    saveData(data);
  }

  const result = {
    triggered: triggered.length > 0,
    count: triggered.length,
    reminders: triggered,
    location: {
      lat: location.latitude.toFixed(4),
      lng: location.longitude.toFixed(4),
      accuracy: Math.round(location.accuracy),
    },
  };

  log(`Done: ${triggered.length} reminder(s) triggered`);
  console.log(JSON.stringify(result));
}

main().catch(err => {
  log(`Fatal error: ${err.message}`, 'ERROR');
  process.exit(1);
});
