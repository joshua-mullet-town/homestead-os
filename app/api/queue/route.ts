import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const QUEUE_FILE = join(homedir(), '.homestead', 'queue.json');

// ASYNC read/write (event-loop wedge fix). NOTE: in production this route is
// shadowed by server.js's own /api/queue handlers (they intercept and return
// before Next.js), but keep it non-blocking anyway so no path can synchronously
// parse/stringify the whole queue on the request loop.
async function readQueue() {
  try {
    return JSON.parse(await readFile(QUEUE_FILE, 'utf-8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

async function writeQueue(queue: unknown[]) {
  // Atomic: write temp then rename so a concurrent reader never sees a partial file.
  const tmp = `${QUEUE_FILE}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(queue, null, 2));
  await rename(tmp, QUEUE_FILE);
}

// GET — read the queue
export async function GET() {
  const queue = await readQueue();
  return NextResponse.json({ queue });
}

// POST — enqueue a structured message
// Required: target_session, type ("action" | "feedback")
// For action: session (tmux session name to act on) OR message_override (raw JSON string)
// For feedback: response_id (which response entry), feedback (text)
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { target_session, type, session, response_id, feedback, message_override } = body;

  if (!target_session) {
    return NextResponse.json({ error: 'target_session is required' }, { status: 400 });
  }

  if (!type || !['action', 'feedback'].includes(type)) {
    return NextResponse.json({ error: 'type is required: "action" or "feedback"' }, { status: 400 });
  }

  if (type === 'action' && !session && !message_override) {
    return NextResponse.json({ error: 'action requires "session" or "message_override"' }, { status: 400 });
  }

  if (type === 'feedback' && (!response_id || !feedback)) {
    return NextResponse.json({ error: 'feedback requires "response_id" and "feedback"' }, { status: 400 });
  }

  // Build message: use override if provided, otherwise build from fields
  const message = message_override || JSON.stringify({
    type,
    ...(type === 'action' ? { session } : { response_id, feedback }),
  });

  const queue = await readQueue();
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    target_session,
    type,
    message,
    status: 'pending',
    created_at: new Date().toISOString()
  };
  queue.push(item);
  await writeQueue(queue);

  return NextResponse.json({ item });
}
