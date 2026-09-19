import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const ENABLED_FILE = join(DATA_DIR, 'watcher-enabled-sessions.json');

function loadEnabledSessions(): string[] {
  try {
    if (existsSync(ENABLED_FILE)) {
      return JSON.parse(readFileSync(ENABLED_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Error loading watcher enabled sessions:', err);
  }
  return [];
}

function saveEnabledSessions(sessions: string[]): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(ENABLED_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error('Error saving watcher enabled sessions:', err);
  }
}

/**
 * GET - List all sessions with watcher enabled
 */
export async function GET() {
  const sessions = loadEnabledSessions();
  return NextResponse.json({ sessions });
}

/**
 * POST - Enable or disable watcher for a session
 * Body: { session: "holler-homestead", enabled: true }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session, enabled } = body;

    if (!session) {
      return NextResponse.json({ error: 'Missing session' }, { status: 400 });
    }

    const sessions = loadEnabledSessions();
    const index = sessions.indexOf(session);

    if (enabled && index === -1) {
      sessions.push(session);
    } else if (!enabled && index !== -1) {
      sessions.splice(index, 1);
    }

    saveEnabledSessions(sessions);

    return NextResponse.json({ success: true, session, enabled, sessions });
  } catch (err) {
    console.error('[watcher-enabled] Error:', err);
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
  }
}
