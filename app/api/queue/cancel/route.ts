import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const QUEUE_FILE = join(homedir(), '.homestead', 'queue.json');

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

// POST — cancel a pending queue item by removing it
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { id } = body;

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  const queue = readQueue();
  const idx = queue.findIndex((item: { id: string }) => item.id === id);
  if (idx === -1) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }

  const removed = queue.splice(idx, 1);
  writeQueue(queue);

  return NextResponse.json({ success: true, cancelled: removed[0] });
}
