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

// DELETE — remove a queue item by id
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const queue = readQueue();
  const filtered = queue.filter((item: { id: string }) => item.id !== id);

  if (filtered.length === queue.length) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }

  writeQueue(filtered);
  return NextResponse.json({ deleted: true, id });
}
