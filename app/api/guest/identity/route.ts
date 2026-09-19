import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
  profilePic: string | null;
  sharedSession: SharedSession;
  personalSessions: PersonalSession[];
  enabled: boolean;
}

async function sessionIsAlive(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/** GET /api/guest/identity — returns identity from Tailscale headers */
export async function GET(request: NextRequest) {
  const tsLogin = request.headers.get('tailscale-user-login');
  const tsName = request.headers.get('tailscale-user-name');
  const tsPic = request.headers.get('tailscale-user-profile-pic');

  if (!tsLogin) {
    return NextResponse.json({
      role: 'unknown',
      login: null,
      name: null,
      profilePic: null,
      sharedSession: null,
      personalSessions: [],
    });
  }

  const config = loadConfig();

  // Derive owner name
  const ownerLogin = config.owner || '';
  const ownerLocal = ownerLogin.split('@')[0] || 'Josh';
  const ownerName = ownerLocal.charAt(0).toUpperCase() + ownerLocal.slice(1);

  if (tsLogin === config.owner) {
    return NextResponse.json({
      role: 'owner',
      login: tsLogin,
      name: tsName || 'Owner',
      profilePic: tsPic || null,
      sharedSession: null,
      personalSessions: [],
    });
  }

  const guest = config.guests.find((g: Guest) => g.login === tsLogin && g.enabled);
  if (guest) {
    // Build shared session info with alive status
    const sharedSession = guest.sharedSession ? {
      ...guest.sharedSession,
      alive: await sessionIsAlive(guest.sharedSession.sessionName),
    } : null;

    // Build personal sessions with alive status
    const personalSessions = await Promise.all((guest.personalSessions || []).map(async (s: PersonalSession) => ({
      ...s,
      alive: await sessionIsAlive(s.sessionName),
    })));

    return NextResponse.json({
      role: 'guest',
      login: guest.login,
      name: guest.name,
      shortName: guest.shortName,
      profilePic: guest.profilePic || tsPic || null,
      sharedSession,
      personalSessions,
      projects: guest.projects || [],
      ownerName,
    });
  }

  return NextResponse.json({
    role: 'unknown',
    login: tsLogin,
    name: tsName || null,
    profilePic: tsPic || null,
    sharedSession: null,
    personalSessions: [],
  });
}
