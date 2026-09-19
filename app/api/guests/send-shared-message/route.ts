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

interface Guest {
  login: string;
  name: string;
  sharedSession: SharedSession;
  enabled: boolean;
}

/** POST /api/guests/send-shared-message — owner sends message to a guest's shared session */
export async function POST(request: NextRequest) {
  const { guestLogin, message } = await request.json();

  if (!guestLogin || !message || typeof message !== 'string') {
    return NextResponse.json({ error: 'guestLogin and message are required' }, { status: 400 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === guestLogin);
  if (!guest) {
    return NextResponse.json({ error: 'Guest not found' }, { status: 404 });
  }

  const sessionName = guest.sharedSession?.sessionName;
  if (!sessionName) {
    return NextResponse.json({ error: 'No shared session configured' }, { status: 400 });
  }

  // Check session exists
  try {
    await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
  } catch {
    return NextResponse.json({ error: 'Session not running' }, { status: 404 });
  }

  // Derive owner name
  const ownerLogin = config.owner || '';
  const ownerLocal = ownerLogin.split('@')[0] || 'Josh';
  const ownerName = ownerLocal.charAt(0).toUpperCase() + ownerLocal.slice(1);

  // Prefix with owner name
  const injectedMessage = `[${ownerName}]: ${message}`;

  const tempFile = join(tmpdir(), `tmux-owner-msg-${randomUUID()}.txt`);
  await writeFile(tempFile, injectedMessage, 'utf-8');

  try {
    await execAsync(`tmux load-buffer "${tempFile}"`);
    await execAsync(`tmux paste-buffer -t "${sessionName}"`);

    await new Promise((resolve) => setTimeout(resolve, 500));
    await execAsync(`tmux send-keys -t "${sessionName}" Enter`);

    console.log(`[owner-send] ${ownerName} -> ${sessionName}: ${message.substring(0, 50)}...`);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to send: ${msg}` }, { status: 500 });
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}
