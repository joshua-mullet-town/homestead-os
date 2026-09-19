import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const BOOKMARKS_FILE = join(process.cwd(), 'data/steward-bookmarks.json');

// global.io is wired in server.js:1515. App Router routes run in the same Node
// process via the custom server, so they can read it here. If io isn't ready
// yet (server boot race) we just skip the emit — clients still see the change
// on the next hydrate / reload.
function emitBookmarksUpdated(sessionName: string) {
  const io = (globalThis as unknown as { io?: { emit: (e: string, p: unknown) => void } }).io;
  if (io) io.emit('presenter:bookmarks-updated', { session_name: sessionName });
}

// A bookmark is either a URL bookmark (url set) or a script bookmark (run set).
// XOR — never both. Existing url bookmarks round-trip unchanged.
type Bookmark = { label: string; url?: string; run?: string };
type Store = Record<string, Bookmark[]>;

// Joshua can only see the top-steward's bookmark panel, so sub/worker
// bookmark writes are force-routed to the top steward's collection. The
// top-steward session is the prefix before the first `--` in the chain
// (e.g. `holler-homestead--auditor`, a re-homed worker `holler-homestead--xyz`,
// or legacy `holler-homestead--foreman--xyz` → `holler-homestead`). Dual-read-
// safe: keys off the FIRST `--`, not the `--foreman--` infix.
function resolveTopSteward(sessionName: string): string {
  const idx = sessionName.indexOf('--');
  return idx === -1 ? sessionName : sessionName.slice(0, idx);
}

function readStore(): Store {
  if (!existsSync(BOOKMARKS_FILE)) return {};
  try {
    const raw = readFileSync(BOOKMARKS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  const dir = dirname(BOOKMARKS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(BOOKMARKS_FILE, JSON.stringify(store, null, 2));
}

function sanitize(bm: unknown): Bookmark | null {
  if (!bm || typeof bm !== 'object') return null;
  const b = bm as Record<string, unknown>;
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  const run = typeof b.run === 'string' ? b.run.trim() : '';
  if (!url && !run) return null;
  // XOR: if both supplied, url wins and run is dropped (callers shouldn't send both)
  if (url) {
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : url;
    return { label, url };
  }
  const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : run;
  return { label, run };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const session = searchParams.get('session');
  const store = readStore();
  if (session) {
    return NextResponse.json({ session_name: session, bookmarks: store[session] || [] });
  }
  return NextResponse.json(store);
}

// INVARIANT: do not add `await` between readStore() and writeStore() below — the
// read-mutate-write must stay synchronous so concurrent POSTs cannot interleave.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sessionName = typeof body?.session_name === 'string' ? body.session_name.trim() : '';
    if (!sessionName) {
      return NextResponse.json({ success: false, error: 'Missing session_name' }, { status: 400 });
    }
    const targetSession = resolveTopSteward(sessionName);
    const incoming = Array.isArray(body?.bookmarks) ? body.bookmarks : [];
    const cleaned = incoming.map(sanitize).filter((b): b is Bookmark => !!b);
    const requestedMode = body?.mode === 'replace' ? 'replace' : 'append';
    // The presenter's pushToServer() hardcodes mode='replace' with the
    // CLIENT's view of bookmarks[stewardId]. When we reroute (sub/worker →
    // top-steward), that client-view does NOT contain the top-steward's
    // real collection, so honoring replace would clobber the top-steward's
    // bookmarks with whatever the sub-pill had cached. Fall back to append
    // so the new entries merge into the top-steward's existing collection.
    const mode = (requestedMode === 'replace' && targetSession !== sessionName) ? 'append' : requestedMode;

    // Dedupe key is prefixed by type so a url bookmark and a run bookmark with
    // identical strings (unlikely but possible) don't collide.
    const keyOf = (b: Bookmark) => b.url ? `url:${b.url}` : `run:${b.run}`;
    const store = readStore();
    let merged: Bookmark[];
    if (mode === 'replace') {
      const seen = new Set<string>();
      merged = [];
      for (const b of cleaned) {
        const k = keyOf(b);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(b);
      }
    } else {
      const existing = store[targetSession] || [];
      const byKey = new Map<string, Bookmark>();
      for (const b of existing) byKey.set(keyOf(b), b);
      for (const b of cleaned) byKey.set(keyOf(b), b); // incoming wins on label collision
      merged = Array.from(byKey.values());
    }

    store[targetSession] = merged;
    writeStore(store);
    emitBookmarksUpdated(targetSession);
    return NextResponse.json({ success: true, session_name: targetSession, bookmarks: merged });
  } catch (err) {
    console.error('[Bookmarks] POST error:', err);
    return NextResponse.json({ success: false, error: 'Failed to write bookmarks' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const session = searchParams.get('session');
    const url = searchParams.get('url');
    const run = searchParams.get('run');
    if (!session) {
      return NextResponse.json({ success: false, error: 'Missing session' }, { status: 400 });
    }
    const targetSession = resolveTopSteward(session);
    const store = readStore();
    if (!store[targetSession]) {
      return NextResponse.json({ success: true, session_name: targetSession, bookmarks: [] });
    }
    if (url) {
      store[targetSession] = store[targetSession].filter((b) => b.url !== url);
    } else if (run) {
      store[targetSession] = store[targetSession].filter((b) => b.run !== run);
    } else {
      delete store[targetSession];
    }
    writeStore(store);
    emitBookmarksUpdated(targetSession);
    return NextResponse.json({ success: true, session_name: targetSession, bookmarks: store[targetSession] || [] });
  } catch (err) {
    console.error('[Bookmarks] DELETE error:', err);
    return NextResponse.json({ success: false, error: 'Failed to delete bookmark' }, { status: 500 });
  }
}
