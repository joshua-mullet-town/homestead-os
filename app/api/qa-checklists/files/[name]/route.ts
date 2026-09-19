import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';

/**
 * Serves an uploaded QA test fixture.
 *
 * These CANNOT be served as plain static files out of public/: Next snapshots
 * public/ at build time, so a fixture uploaded at runtime 404s until the next
 * build. Josh's whole point is that a steward attaches a file and he taps it
 * moments later -- so it is served through a route that reads from disk on
 * every request.
 */

const FILES_DIR = join(process.cwd(), 'public/qa-files');

const TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  // basename() strips any traversal attempt -- only files directly inside
  // FILES_DIR are reachable.
  const safe = basename(name || '');
  if (!safe || safe.startsWith('.')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const path = join(FILES_DIR, safe);
  if (!existsSync(path)) {
    return NextResponse.json({ error: 'No such test file' }, { status: 404 });
  }

  const body = readFileSync(path);
  // The stored name carries a random prefix for collision safety; hand the
  // original back so Josh's download is named something he recognises.
  const original = safe.replace(/^[0-9a-f]{12}-/, '') || safe;

  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': TYPES[extname(safe).toLowerCase()] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${original}"`,
      'Content-Length': String(body.length),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    },
  });
}
