import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const DATA_FILE = join(process.cwd(), 'data', 'location-reminders.json');

interface KnownLocation {
  latitude: number;
  longitude: number;
  label: string;
}

interface Reminder {
  id: string;
  location_name: string;
  reminder_text: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  enabled: boolean;
  one_shot: boolean;
  cooldown_minutes: number;
  created_at: string;
  last_triggered: string | null;
}

interface LocationData {
  known_locations: Record<string, KnownLocation>;
  reminders: Reminder[];
}

function loadData(): LocationData {
  try {
    if (existsSync(DATA_FILE)) {
      return JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch {}
  return { known_locations: {}, reminders: [] };
}

function saveData(data: LocationData) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * GET /api/location-reminders
 * List all reminders and known locations
 */
export async function GET() {
  const data = loadData();
  return NextResponse.json(data);
}

/**
 * POST /api/location-reminders
 * Add a new reminder or known location
 *
 * Body for reminder:
 * { type: "reminder", location_name: "home", reminder_text: "...", radius_meters?: 200, one_shot?: true, cooldown_minutes?: 60 }
 *
 * Body for known location:
 * { type: "location", name: "home", latitude: 39.123, longitude: -84.456, label?: "Home" }
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const data = loadData();

  if (body.type === 'location') {
    const { name, latitude, longitude, label } = body;
    if (!name || latitude == null || longitude == null) {
      return NextResponse.json({ error: 'name, latitude, and longitude are required' }, { status: 400 });
    }
    data.known_locations[name.toLowerCase()] = {
      latitude,
      longitude,
      label: label || name,
    };
    saveData(data);
    return NextResponse.json({ success: true, location: data.known_locations[name.toLowerCase()] });
  }

  if (body.type === 'reminder') {
    const { location_name, reminder_text, latitude, longitude, radius_meters, one_shot, cooldown_minutes } = body;

    if (!reminder_text) {
      return NextResponse.json({ error: 'reminder_text is required' }, { status: 400 });
    }

    // Resolve coordinates from known location or explicit lat/lng
    let lat = latitude;
    let lng = longitude;
    let locName = location_name;

    if (location_name && !latitude) {
      const known = data.known_locations[location_name.toLowerCase()];
      if (!known) {
        return NextResponse.json({
          error: `Unknown location "${location_name}". Known: ${Object.keys(data.known_locations).join(', ') || 'none'}`,
        }, { status: 400 });
      }
      lat = known.latitude;
      lng = known.longitude;
      locName = known.label || location_name;
    }

    if (lat == null || lng == null) {
      return NextResponse.json({ error: 'Either location_name (known) or latitude/longitude required' }, { status: 400 });
    }

    const reminder: Reminder = {
      id: randomUUID().substring(0, 8),
      location_name: locName,
      reminder_text,
      latitude: lat,
      longitude: lng,
      radius_meters: radius_meters || 200,
      enabled: true,
      one_shot: one_shot !== false,
      cooldown_minutes: cooldown_minutes || 60,
      created_at: new Date().toISOString(),
      last_triggered: null,
    };

    data.reminders.push(reminder);
    saveData(data);
    return NextResponse.json({ success: true, reminder });
  }

  return NextResponse.json({ error: 'type must be "reminder" or "location"' }, { status: 400 });
}

/**
 * DELETE /api/location-reminders?id=xxx
 * Remove a reminder, or ?location=name to remove a known location
 */
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const data = loadData();

  const id = searchParams.get('id');
  if (id) {
    data.reminders = data.reminders.filter(r => r.id !== id);
    saveData(data);
    return NextResponse.json({ success: true });
  }

  const location = searchParams.get('location');
  if (location) {
    delete data.known_locations[location.toLowerCase()];
    saveData(data);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'id or location parameter required' }, { status: 400 });
}

/**
 * PATCH /api/location-reminders?id=xxx
 * Update a reminder (enable/disable, snooze, etc.)
 */
export async function PATCH(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'id parameter required' }, { status: 400 });
  }

  const body = await request.json();
  const data = loadData();
  const idx = data.reminders.findIndex(r => r.id === id);

  if (idx < 0) {
    return NextResponse.json({ error: 'Reminder not found' }, { status: 404 });
  }

  if (body.enabled !== undefined) data.reminders[idx].enabled = body.enabled;
  if (body.reminder_text) data.reminders[idx].reminder_text = body.reminder_text;
  if (body.radius_meters) data.reminders[idx].radius_meters = body.radius_meters;
  if (body.snooze_minutes) {
    // Push last_triggered forward to create a cooldown
    data.reminders[idx].last_triggered = new Date().toISOString();
    data.reminders[idx].cooldown_minutes = body.snooze_minutes;
  }

  saveData(data);
  return NextResponse.json({ success: true, reminder: data.reminders[idx] });
}
