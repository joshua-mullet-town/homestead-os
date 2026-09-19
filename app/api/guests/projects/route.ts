import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_FILE = join(homedir(), '.homestead', 'guests.json');

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { owner: '', guests: [] as Guest[] };
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

function saveConfig(config: ReturnType<typeof loadConfig>) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

interface Guest {
  login: string;
  projects?: { name: string; path: string; description?: string }[];
  [key: string]: unknown;
}

/** GET /api/guests/projects?login=... — get projects for a guest */
export async function GET(request: NextRequest) {
  const login = request.nextUrl.searchParams.get('login');
  if (!login) {
    return NextResponse.json({ error: 'login is required' }, { status: 400 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === login);
  if (!guest) {
    return NextResponse.json({ error: 'Guest not found' }, { status: 404 });
  }

  return NextResponse.json({ projects: guest.projects || [] });
}

/** POST /api/guests/projects — add a project to a guest { login, name, path, description? } */
export async function POST(request: NextRequest) {
  const { login, name, path, description } = await request.json();
  if (!login || !name || !path) {
    return NextResponse.json({ error: 'login, name, and path are required' }, { status: 400 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === login);
  if (!guest) {
    return NextResponse.json({ error: 'Guest not found' }, { status: 404 });
  }

  if (!guest.projects) guest.projects = [];
  if (guest.projects.find((p: { name: string }) => p.name === name)) {
    return NextResponse.json({ error: 'Project already assigned' }, { status: 400 });
  }

  guest.projects.push({ name, path, ...(description ? { description } : {}) });
  saveConfig(config);

  return NextResponse.json({ success: true, projects: guest.projects });
}

/** DELETE /api/guests/projects — remove a project from a guest { login, name } */
export async function DELETE(request: NextRequest) {
  const { login, name } = await request.json();
  if (!login || !name) {
    return NextResponse.json({ error: 'login and name are required' }, { status: 400 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === login);
  if (!guest) {
    return NextResponse.json({ error: 'Guest not found' }, { status: 404 });
  }

  if (!guest.projects) {
    return NextResponse.json({ error: 'No projects assigned' }, { status: 400 });
  }

  const before = guest.projects.length;
  guest.projects = guest.projects.filter((p: { name: string }) => p.name !== name);
  if (guest.projects.length === before) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  saveConfig(config);
  return NextResponse.json({ success: true, projects: guest.projects });
}
