import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const REACTIONS_FILE = join(homedir(), '.homestead', 'message-reactions.json');

interface ReactionData {
  [sessionName: string]: {
    [messageId: string]: {
      [emoji: string]: string[]; // array of user names
    };
  };
}

async function loadReactions(): Promise<ReactionData> {
  try {
    if (!existsSync(REACTIONS_FILE)) return {};
    const content = await readFile(REACTIONS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveReactions(data: ReactionData): Promise<void> {
  const dir = join(homedir(), '.homestead');
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(REACTIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/** GET /api/guests/reactions?session=xxx — fetch all reactions for a session */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const session = searchParams.get('session');

  if (!session) {
    return NextResponse.json({ error: 'session is required' }, { status: 400 });
  }

  const data = await loadReactions();
  return NextResponse.json({ reactions: data[session] || {} });
}

/** POST /api/guests/reactions — toggle a reaction on a message */
export async function POST(request: NextRequest) {
  const { session, messageId, emoji, userName } = await request.json();

  if (!session || !messageId || !emoji || !userName) {
    return NextResponse.json(
      { error: 'session, messageId, emoji, and userName are required' },
      { status: 400 }
    );
  }

  const data = await loadReactions();

  if (!data[session]) data[session] = {};
  if (!data[session][messageId]) data[session][messageId] = {};
  if (!data[session][messageId][emoji]) data[session][messageId][emoji] = [];

  const users = data[session][messageId][emoji];
  const index = users.indexOf(userName);

  if (index >= 0) {
    // Remove reaction (toggle off)
    users.splice(index, 1);
    if (users.length === 0) delete data[session][messageId][emoji];
    if (Object.keys(data[session][messageId]).length === 0) delete data[session][messageId];
  } else {
    // Add reaction (toggle on)
    users.push(userName);
  }

  await saveReactions(data);
  return NextResponse.json({ reactions: data[session] || {} });
}
