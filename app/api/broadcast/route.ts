import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SISWAPTS_DIR = join(homedir(), '.homestead', 'stewards');
const QUEUE_FILE = join(SISWAPTS_DIR, 'queue.json');
const SKIP = new Set(['.git', 'all', 'queue.json']);

function readQueue() {
  try {
    if (!existsSync(QUEUE_FILE)) return [];
    return JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// ATOMIC (torn-read fix 2026-08-25): temp+rename so a concurrent dispatcher read
// never sees a half-written queue.json.
function writeQueue(queue: unknown[]) {
  const tmp = `${QUEUE_FILE}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(queue, null, 2));
  renameSync(tmp, QUEUE_FILE);
}

function getStewardNames(): string[] {
  try {
    return readdirSync(SISWAPTS_DIR).filter(entry => {
      if (SKIP.has(entry)) return false;
      try {
        return statSync(join(SISWAPTS_DIR, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * POST /api/broadcast
 *
 * Send a message to ALL steward sessions at once.
 *
 * Body:
 *   message: string (required) — the instruction text
 *   type: "action" | "feedback" (default: "action")
 *   from: string (optional) — sender identity (default: "api")
 *   exclude: string[] (optional) — steward names to skip
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { message, type, from, exclude } = body;

  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  const msgType = type || 'action';
  const sender = from || 'api';
  const excludeSet = new Set(exclude || []);

  const stewardNames = getStewardNames().filter(name => !excludeSet.has(name));

  if (!stewardNames.length) {
    return NextResponse.json({ error: 'No stewards found' }, { status: 404 });
  }

  const queue = readQueue();
  const queued: { target: string; id: string }[] = [];

  for (const name of stewardNames) {
    const targetSession = `holler-${name}`;
    const envelope = JSON.stringify({
      type: msgType,
      from: sender,
      broadcast: true,
      instruction: message,
    });

    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      target_session: targetSession,
      type: msgType,
      message: envelope,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    queue.push(item);
    queued.push({ target: targetSession, id: item.id });
  }

  writeQueue(queue);

  return NextResponse.json({
    broadcast: true,
    count: queued.length,
    targets: queued,
  });
}
