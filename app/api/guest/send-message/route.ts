import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { randomUUID } from 'crypto';

const CONFIG_FILE = join(homedir(), '.homestead', 'guests.json');

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { owner: '', guests: [] };
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

interface SharedSession {
  sessionName: string;
  sessionDir: string;
}

interface PersonalSession {
  name: string;
  sessionName: string;
  sessionDir: string;
}

interface Guest {
  login: string;
  name: string;
  shortName: string;
  sharedSession: SharedSession;
  personalSessions: PersonalSession[];
  enabled: boolean;
  // Legacy
  sessionName?: string;
}

/** POST /api/guest/send-message — inject message into guest's session */
export async function POST(request: NextRequest) {
  const tsLogin = request.headers.get('tailscale-user-login');
  if (!tsLogin) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === tsLogin && g.enabled);
  if (!guest) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const { message } = await request.json();
  if (!message || typeof message !== 'string') {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  // Determine which session to target
  const { searchParams } = new URL(request.url);
  const sessionParam = searchParams.get('session');

  let targetSessionName: string;
  let isSharedSession: boolean;

  if (sessionParam && sessionParam !== 'shared') {
    // Personal session
    const personalSession = (guest.personalSessions || []).find((s: PersonalSession) => s.name === sessionParam);
    if (!personalSession) {
      return NextResponse.json({ error: 'Personal session not found' }, { status: 404 });
    }
    targetSessionName = personalSession.sessionName;
    isSharedSession = false;
  } else {
    // Default: shared session
    targetSessionName = guest.sharedSession?.sessionName || guest.sessionName || '';
    isSharedSession = true;
  }

  if (!targetSessionName) {
    return NextResponse.json({ error: 'No session configured' }, { status: 404 });
  }

  // Check session exists
  try {
    await execAsync(`tmux has-session -t "${targetSessionName}" 2>/dev/null`);
  } catch {
    return NextResponse.json({ error: 'Session not running' }, { status: 404 });
  }

  // Prefix with sender name for shared sessions only
  const injectedMessage = isSharedSession ? `[${guest.name}]: ${message}` : message;

  // Inject via tmux load-buffer + paste-buffer (same pattern as inject-message)
  const tempFile = join(tmpdir(), `tmux-guest-msg-${randomUUID()}.txt`);
  await writeFile(tempFile, injectedMessage, 'utf-8');

  try {
    await execAsync(`tmux load-buffer "${tempFile}"`);
    await execAsync(`tmux paste-buffer -t "${targetSessionName}"`);

    // Wait for paste to render before sending Enter
    await new Promise((resolve) => setTimeout(resolve, 500));
    await execAsync(`tmux send-keys -t "${targetSessionName}" Enter`);

    console.log(`[guest-send] ${guest.login} -> ${targetSessionName}: ${message.substring(0, 50)}...`);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to send: ${msg}` }, { status: 500 });
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}
