import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const HOMESTEAD_DIR = join(homedir(), '.homestead');
const CONFIG_FILE = join(HOMESTEAD_DIR, 'guests.json');

function ensureDir() {
  if (!existsSync(HOMESTEAD_DIR)) mkdirSync(HOMESTEAD_DIR, { recursive: true });
}

function loadConfig() {
  ensureDir();
  if (!existsSync(CONFIG_FILE)) {
    const defaults = { owner: 'joshuamullet@gmail.com', guests: [] as Guest[] };
    writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

function saveConfig(config: ReturnType<typeof loadConfig>) {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
  profilePic: string | null;
  sharedSession: SharedSession;
  personalSessions: PersonalSession[];
  enabled: boolean;
  createdAt: string;
  lastSeen: string | null;
}

async function sessionIsAlive(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/** GET /api/guests — list all guests with session status */
export async function GET() {
  const config = loadConfig();
  const guests = await Promise.all(config.guests.map(async (g: Guest) => ({
    ...g,
    sharedSessionAlive: g.sharedSession ? await sessionIsAlive(g.sharedSession.sessionName) : false,
    personalSessions: await Promise.all((g.personalSessions || []).map(async (s: PersonalSession) => ({
      ...s,
      alive: await sessionIsAlive(s.sessionName),
    }))),
  })));
  return NextResponse.json({ owner: config.owner, guests });
}

/** POST /api/guests — add a guest { login, name?, profilePic? } */
export async function POST(request: NextRequest) {
  const { login, name, profilePic } = await request.json();
  if (!login || typeof login !== 'string') {
    return NextResponse.json({ error: 'login is required' }, { status: 400 });
  }

  const config = loadConfig();
  if (config.guests.find((g: Guest) => g.login === login)) {
    return NextResponse.json({ error: 'Guest already exists' }, { status: 409 });
  }

  const shortName = login.split('@')[0].replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const guest: Guest = {
    login,
    name: name || shortName,
    shortName,
    profilePic: profilePic || null,
    sharedSession: {
      sessionName: `holler-guest-${shortName}`,
      sessionDir: join(HOMESTEAD_DIR, 'guest-sessions', shortName),
    },
    personalSessions: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    lastSeen: null,
  };
  config.guests.push(guest);
  saveConfig(config);
  return NextResponse.json({ guest });
}

/** PUT /api/guests — update guest { login, enabled? } */
export async function PUT(request: NextRequest) {
  const { login, enabled } = await request.json();
  if (!login) {
    return NextResponse.json({ error: 'login is required' }, { status: 400 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === login);
  if (!guest) {
    return NextResponse.json({ error: 'Guest not found' }, { status: 404 });
  }

  if (typeof enabled === 'boolean') guest.enabled = enabled;
  saveConfig(config);
  return NextResponse.json({ guest });
}

/** DELETE /api/guests?login=xxx — remove guest */
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const login = searchParams.get('login');
  if (!login) {
    return NextResponse.json({ error: 'login query param is required' }, { status: 400 });
  }

  const config = loadConfig();
  const before = config.guests.length;
  config.guests = config.guests.filter((g: Guest) => g.login !== login);
  if (config.guests.length === before) {
    return NextResponse.json({ error: 'Guest not found' }, { status: 404 });
  }
  saveConfig(config);
  return NextResponse.json({ success: true });
}
