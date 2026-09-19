import { NextRequest, NextResponse } from 'next/server';

// The card-links store is a CommonJS module shared with lib/presenter-queue.js
// (addItem auto-save path) so the read-mutate-write logic never diverges
// between the auto-save and the renderer-driven GET/POST/DELETE here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require('@/lib/card-links-store');

type CardLink = { title: string; url: string; created_at: number; last_opened: number | null; pinned?: boolean };

// global.io is wired in server.js. App Router routes run in the same Node
// process via the custom server, so they can read it here. If io isn't ready
// yet (server boot race) we skip the emit — clients hydrate on next reload.
function emitCardLinksUpdated(sessionName: string) {
  const io = (globalThis as unknown as { io?: { emit: (e: string, p: unknown) => void } }).io;
  if (io) io.emit('presenter:card-links-updated', { session_name: sessionName });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const session = searchParams.get('session');
  if (session) {
    return NextResponse.json({ session_name: store.resolveTopSteward(session), links: store.getLinks(session) });
  }
  return NextResponse.json(store.readStore());
}

// POST — either auto-save a labeled link, mark one opened, or bulk-record.
// Body shapes:
//   { session_name, link: { title, url } }   → save (append-merge, roll-up)
//   { session_name, opened_url }              → touch last_opened
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sessionName = typeof body?.session_name === 'string' ? body.session_name.trim() : '';
    if (!sessionName) {
      return NextResponse.json({ success: false, error: 'Missing session_name' }, { status: 400 });
    }

    // Pin / unpin a single link (Josh 2026-09-09 three-dot menu). Pinned links
    // are exempt from the stale-link prune, so this is the "keep this one" flag.
    if (typeof body?.pin_url === 'string' && body.pin_url.trim()) {
      const result = store.setPinned(sessionName, body.pin_url.trim(), !!body.pinned);
      if (!result) {
        return NextResponse.json({ success: false, error: 'Link not found' }, { status: 404 });
      }
      emitCardLinksUpdated(result.topStewardId);
      return NextResponse.json({ success: true, session_name: result.topStewardId, links: result.links });
    }

    if (typeof body?.opened_url === 'string' && body.opened_url.trim()) {
      const result = store.touchLink(sessionName, body.opened_url.trim());
      if (!result) {
        return NextResponse.json({ success: false, error: 'Link not found' }, { status: 404 });
      }
      emitCardLinksUpdated(result.topStewardId);
      return NextResponse.json({ success: true, session_name: result.topStewardId, links: result.links });
    }

    const link = body?.link;
    if (!link || typeof link !== 'object') {
      return NextResponse.json({ success: false, error: 'Missing link {title,url}' }, { status: 400 });
    }
    // Pass through an optional source label so a renderer-driven save records
    // the same friendly worker name the auto-save path does (Josh 2026-08-14
    // "who made this link"). The worker is derived from sessionName's "--"
    // suffix inside saveLink; only stamped on FIRST save.
    const source = typeof body?.source === 'string' ? body.source : undefined;
    const result = store.saveLink(sessionName, { title: link.title, url: link.url }, undefined, { source });
    if (!result) {
      return NextResponse.json({ success: false, error: 'Link requires both a title and a url' }, { status: 400 });
    }
    emitCardLinksUpdated(result.topStewardId);
    return NextResponse.json({ success: true, session_name: result.topStewardId, links: result.links });
  } catch (err) {
    console.error('[CardLinks] POST error:', err);
    return NextResponse.json({ success: false, error: 'Failed to write card links' }, { status: 500 });
  }
}

// DELETE — forget a single link (?url=...) or the whole collection.
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const session = searchParams.get('session');
    const url = searchParams.get('url');
    if (!session) {
      return NextResponse.json({ success: false, error: 'Missing session' }, { status: 400 });
    }
    const result = store.forgetLink(session, url || undefined) as { topStewardId: string; links: CardLink[] };
    emitCardLinksUpdated(result.topStewardId);
    return NextResponse.json({ success: true, session_name: result.topStewardId, links: result.links });
  } catch (err) {
    console.error('[CardLinks] DELETE error:', err);
    return NextResponse.json({ success: false, error: 'Failed to delete card link' }, { status: 500 });
  }
}
