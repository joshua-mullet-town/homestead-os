import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Filter storage location
const FILTERS_FILE = path.join(os.homedir(), '.homestead', 'notification-filters.json');

export interface NotificationFilter {
  id: string;
  packageName: string;           // Required - which app
  titlePattern?: string;         // Optional - regex or contains match on title
  textPattern?: string;          // Optional - regex or contains match on text
  ongoingOnly?: boolean;         // Only filter if it's an ongoing notification
  enabled: boolean;              // Can toggle filters on/off
  createdAt: number;
  description?: string;          // Human-readable description of what this blocks
}

function ensureDir() {
  const dir = path.dirname(FILTERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadFilters(): NotificationFilter[] {
  try {
    ensureDir();
    if (fs.existsSync(FILTERS_FILE)) {
      const content = fs.readFileSync(FILTERS_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('[NotificationFilters] Error loading filters:', err);
  }
  return [];
}

function saveFilters(filters: NotificationFilter[]): boolean {
  try {
    ensureDir();
    fs.writeFileSync(FILTERS_FILE, JSON.stringify(filters, null, 2));
    return true;
  } catch (err) {
    console.error('[NotificationFilters] Error saving filters:', err);
    return false;
  }
}

// GET - get all filters
export async function GET() {
  const filters = loadFilters();
  return NextResponse.json({ filters });
}

// POST - add a new filter
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { packageName, titlePattern, textPattern, ongoingOnly, description } = body;

    if (!packageName) {
      return NextResponse.json({ error: 'packageName is required' }, { status: 400 });
    }

    const filters = loadFilters();

    const newFilter: NotificationFilter = {
      id: `filter-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      packageName,
      titlePattern: titlePattern || undefined,
      textPattern: textPattern || undefined,
      ongoingOnly: ongoingOnly || false,
      enabled: true,
      createdAt: Date.now(),
      description: description || undefined,
    };

    filters.push(newFilter);

    if (saveFilters(filters)) {
      return NextResponse.json({ success: true, filter: newFilter });
    } else {
      return NextResponse.json({ error: 'Failed to save filter' }, { status: 500 });
    }
  } catch (err) {
    console.error('[NotificationFilters] POST error:', err);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

// PUT - update a filter
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const filters = loadFilters();
    const index = filters.findIndex(f => f.id === id);

    if (index === -1) {
      return NextResponse.json({ error: 'Filter not found' }, { status: 404 });
    }

    // Update filter fields
    filters[index] = {
      ...filters[index],
      ...updates,
      id: filters[index].id, // Don't allow changing ID
      createdAt: filters[index].createdAt, // Don't change created time
    };

    if (saveFilters(filters)) {
      return NextResponse.json({ success: true, filter: filters[index] });
    } else {
      return NextResponse.json({ error: 'Failed to save filter' }, { status: 500 });
    }
  } catch (err) {
    console.error('[NotificationFilters] PUT error:', err);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

// DELETE - remove a filter
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const filters = loadFilters();
    const newFilters = filters.filter(f => f.id !== id);

    if (newFilters.length === filters.length) {
      return NextResponse.json({ error: 'Filter not found' }, { status: 404 });
    }

    if (saveFilters(newFilters)) {
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json({ error: 'Failed to save filters' }, { status: 500 });
    }
  } catch (err) {
    console.error('[NotificationFilters] DELETE error:', err);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
