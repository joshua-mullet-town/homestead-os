import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

/**
 * Find session file by tmux session name
 */
function findSessionFileByTmux(tmuxSession: string): string | null {
  if (!existsSync(SESSIONS_DIR)) return null;

  const files = readdirSync(SESSIONS_DIR);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const filePath = join(SESSIONS_DIR, file);
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (content.tmuxSession === tmuxSession) {
        return filePath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * POST - Mark a session as read
 * Body: { session: "holler-homestead" }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session } = body;

    if (!session) {
      return NextResponse.json({ error: 'Missing session' }, { status: 400 });
    }

    const filePath = findSessionFileByTmux(session);
    if (!filePath) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Read current content
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));

    // Mark as read
    content.read = true;

    // Write back
    writeFileSync(filePath, JSON.stringify(content, null, 2));

    return NextResponse.json({ success: true, session, read: true });
  } catch (err) {
    console.error('[session-read] Error:', err);
    return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 });
  }
}
