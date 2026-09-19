import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const READ_STATE_FILE = join(process.cwd(), 'data/presenter-read-state.json');

// global.io is wired in server.js:1531. Tolerate boot race — if io isn't ready
// yet, skip the emit; clients see the change on the next hydrate / reload.
function emitReadStateUpdated(payload: Record<string, true>) {
  const io = (globalThis as unknown as { io?: { emit: (e: string, p: unknown) => void } }).io;
  if (io) io.emit('presenter:read-state-updated', payload);
}

type Store = Record<string, true>;

function readStore(): Store {
  if (!existsSync(READ_STATE_FILE)) return {};
  try {
    const raw = readFileSync(READ_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Store = {};
    for (const k of Object.keys(parsed)) {
      if ((parsed as Record<string, unknown>)[k]) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  const dir = dirname(READ_STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(READ_STATE_FILE, JSON.stringify(store, null, 2));
}

export async function GET() {
  return NextResponse.json(readStore());
}

// INVARIANT: do not add `await` between readStore() and writeStore() — the
// read-mutate-write must stay synchronous so concurrent POSTs cannot interleave.
// Accepts either { itemId: "..." } (single) or { itemIds: ["...", ...] } (batch).
// Batch form exists because the renderer debounces rapid card flips and needs to
// persist the whole burst, not just the last id.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const ids: string[] = [];
    if (typeof body?.itemId === 'string' && body.itemId.trim()) {
      ids.push(body.itemId.trim());
    }
    if (Array.isArray(body?.itemIds)) {
      for (const v of body.itemIds) {
        if (typeof v === 'string' && v.trim()) ids.push(v.trim());
      }
    }
    if (ids.length === 0) {
      return NextResponse.json({ success: false, error: 'Missing itemId or itemIds' }, { status: 400 });
    }
    const store = readStore();
    const newlyRead: Record<string, true> = {};
    let dirty = false;
    for (const id of ids) {
      if (!store[id]) {
        store[id] = true;
        newlyRead[id] = true;
        dirty = true;
      }
    }
    if (dirty) writeStore(store);
    // Always emit even if no-op so any in-flight client gets the ack shape;
    // empty payload is a cheap no-op on the listener side.
    emitReadStateUpdated(dirty ? newlyRead : {});
    return NextResponse.json({ success: true, count: Object.keys(newlyRead).length });
  } catch (err) {
    console.error('[ReadState] POST error:', err);
    return NextResponse.json({ success: false, error: 'Failed to write read-state' }, { status: 500 });
  }
}
