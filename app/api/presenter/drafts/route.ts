import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const DRAFTS_FILE = join(process.cwd(), 'data/presenter-drafts.json');

// global.io is wired in server.js:1545. Tolerate boot race — if io isn't ready
// yet, skip the emit; clients see the change on the next hydrate / reload.
function emitDraftsUpdated(payload: { key: string; value: string }) {
  const io = (globalThis as unknown as { io?: { emit: (e: string, p: unknown) => void } }).io;
  if (io) io.emit('presenter:drafts-updated', payload);
}

type Store = Record<string, string>;

function readStore(): Store {
  if (!existsSync(DRAFTS_FILE)) return {};
  try {
    const raw = readFileSync(DRAFTS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Store = {};
    for (const k of Object.keys(parsed)) {
      const v = (parsed as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  const dir = dirname(DRAFTS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DRAFTS_FILE, JSON.stringify(store, null, 2));
}

export async function GET() {
  return NextResponse.json(readStore());
}

// INVARIANT: do not add `await` between readStore() and writeStore() — the
// read-mutate-write must stay synchronous so concurrent POSTs cannot interleave.
// Body: { key: string, value: string }. Empty string DELETES the key (mirrors
// the existing setDraft semantics — saveDraft('', ...) was the localStorage
// remove path).
export async function POST(request: NextRequest) {
  try {
    const raw = await request.text();
    if (!raw) {
      return NextResponse.json({ success: false, error: 'Empty body' }, { status: 400 });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
    }
    const b = body as { key?: unknown; value?: unknown } | null;
    const key = typeof b?.key === 'string' ? b.key.trim() : '';
    const value = typeof b?.value === 'string' ? b.value : '';
    if (!key) {
      return NextResponse.json({ success: false, error: 'Missing key' }, { status: 400 });
    }
    const store = readStore();
    if (value === '') {
      if (store[key] !== undefined) {
        delete store[key];
        writeStore(store);
      }
    } else {
      if (store[key] !== value) {
        store[key] = value;
        writeStore(store);
      }
    }
    emitDraftsUpdated({ key, value });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[Drafts] POST error:', err);
    return NextResponse.json({ success: false, error: 'Failed to write draft' }, { status: 500 });
  }
}
