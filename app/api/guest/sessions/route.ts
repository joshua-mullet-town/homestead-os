import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const HOMESTEAD_DIR = join(homedir(), '.homestead');
const CONFIG_FILE = join(HOMESTEAD_DIR, 'guests.json');

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { owner: '', guests: [] };
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

function saveConfig(config: ReturnType<typeof loadConfig>) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

interface PersonalSession {
  name: string;
  sessionName: string;
  sessionDir: string;
}

interface SharedSession {
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
}

async function sessionIsAlive(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/** GET /api/guest/sessions — list personal sessions with alive status */
export async function GET(request: NextRequest) {
  const tsLogin = request.headers.get('tailscale-user-login');
  if (!tsLogin) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === tsLogin && g.enabled);
  if (!guest) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const sessions = await Promise.all((guest.personalSessions || []).map(async (s: PersonalSession) => ({
    ...s,
    alive: await sessionIsAlive(s.sessionName),
  })));

  return NextResponse.json({ sessions });
}

/** POST /api/guest/sessions — create personal session { name } */
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

  const { name } = await request.json();
  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  // Validate name
  const cleanName = name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  if (!cleanName || cleanName.length > 30) {
    return NextResponse.json({ error: 'Invalid session name (alphanumeric + hyphens, max 30 chars)' }, { status: 400 });
  }

  if (!guest.personalSessions) guest.personalSessions = [];
  if (guest.personalSessions.length >= 5) {
    return NextResponse.json({ error: 'Maximum 5 personal sessions allowed' }, { status: 400 });
  }
  if (guest.personalSessions.find((s: PersonalSession) => s.name === cleanName)) {
    return NextResponse.json({ error: 'Session already exists' }, { status: 409 });
  }

  const session: PersonalSession = {
    name: cleanName,
    sessionName: `holler-gp-${guest.shortName}-${cleanName}`,
    sessionDir: join(HOMESTEAD_DIR, 'guest-sessions', guest.shortName, cleanName),
  };

  // Create session directory
  if (!existsSync(session.sessionDir)) {
    mkdirSync(session.sessionDir, { recursive: true });
  }

  // Build projects section for CLAUDE.md
  const projects = (guest as Record<string, unknown>).projects as { name: string; path: string; description?: string }[] || [];
  let projectsSection = '';
  if (projects.length > 0) {
    projectsSection = `\n## Your Projects\n\nYou have access to the following projects:\n\n`;
    for (const p of projects) {
      projectsSection += `### ${p.name}\n- **Path:** \`${p.path}\`\n`;
      if (p.description) {
        projectsSection += `- ${p.description}\n`;
      }
      const projectClaudeMd = join(p.path, 'CLAUDE.md');
      if (existsSync(projectClaudeMd)) {
        const content = readFileSync(projectClaudeMd, 'utf-8');
        projectsSection += `\n<details>\n<summary>Project Instructions (from ${p.name}/CLAUDE.md)</summary>\n\n${content}\n</details>\n`;
      }
      projectsSection += '\n';
    }
  }

  // Write CLAUDE.md for personal session
  const claudeMd = `# Personal Session: ${guest.name}

This is ${guest.name}'s personal coding session.
Be helpful and conversational.
${projectsSection}`;
  writeFileSync(join(session.sessionDir, 'CLAUDE.md'), claudeMd);

  // Resolve claude path
  let claudePath: string;
  try {
    const { stdout } = await execAsync('which claude');
    claudePath = stdout.trim();
  } catch {
    claudePath = join(homedir(), '.local', 'bin', 'claude');
  }

  // Build --add-dir flags for each project
  const addDirs = projects.map(p => `--add-dir "${p.path}"`).join(' ');

  // Start in project dir if session name matches a project, otherwise session dir
  const matchingProject = projects.find(p => p.name === cleanName);
  const startDir = matchingProject ? matchingProject.path : session.sessionDir;

  // Spawn tmux session with Claude
  const claudeCommand = `${claudePath} --dangerously-skip-permissions ${addDirs}; zsh`;
  try {
    await execAsync(`tmux new-session -d -s "${session.sessionName}" -c "${startDir}" "${claudeCommand}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to create session: ${msg}` }, { status: 500 });
  }

  // Save to config
  guest.personalSessions.push(session);
  saveConfig(config);

  return NextResponse.json({ session: { ...session, alive: true } });
}

/** DELETE /api/guest/sessions — kill and remove personal session { name } */
export async function DELETE(request: NextRequest) {
  const tsLogin = request.headers.get('tailscale-user-login');
  if (!tsLogin) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === tsLogin && g.enabled);
  if (!guest) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const { name } = await request.json();
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const session = (guest.personalSessions || []).find((s: PersonalSession) => s.name === name);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Kill tmux session if running
  try {
    await execAsync(`tmux kill-session -t "${session.sessionName}" 2>/dev/null`);
  } catch {
    // Not running, that's fine
  }

  // Remove from config
  guest.personalSessions = guest.personalSessions.filter((s: PersonalSession) => s.name !== name);
  saveConfig(config);

  return NextResponse.json({ success: true });
}
