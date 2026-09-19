import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

/**
 * Test-fixture upload for QA checklists.
 *
 * A steward POSTs a file here and gets back { name, url, size }, which goes in
 * a step's `files` array. The file is written under public/qa-files/ so it is
 * served as ordinary static content -- which is what makes it download on
 * whatever device Josh is holding, phone included. Nothing bespoke.
 *
 * public/qa-files/ is gitignored: these are runtime fixtures, not source, and
 * they must not bloat the repo.
 */

const FILES_DIR = join(process.cwd(), 'public/qa-files');

// Generous enough for a real spreadsheet or export, small enough that nobody
// parks a video here.
const MAX_BYTES = 25 * 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, { status: init?.status ?? 200, headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** Keep the on-disk name readable but harmless -- no traversal, no spaces. */
function safeName(raw: string): string {
  const base = (raw || 'file').split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 80);
  return cleaned || 'file';
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get('file');

    if (!file || typeof file === 'string') {
      return json({
        success: false,
        error: 'Send the file as multipart/form-data under the field name "file".',
      }, { status: 400 });
    }

    const blob = file as File;
    const bytes = Buffer.from(await blob.arrayBuffer());

    if (bytes.length === 0) {
      return json({ success: false, error: 'That file is empty.' }, { status: 400 });
    }
    if (bytes.length > MAX_BYTES) {
      return json({
        success: false,
        error: `That file is ${(bytes.length / 1024 / 1024).toFixed(1)}MB; the limit is 25MB. Test fixtures should be small.`,
      }, { status: 413 });
    }

    const original = safeName(blob.name || 'file');
    // Prefix with a short random id so two stewards uploading "items.csv"
    // don't clobber each other.
    const stored = `${crypto.randomBytes(6).toString('hex')}-${original}`;

    if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true });
    writeFileSync(join(FILES_DIR, stored), bytes);

    return json({
      success: true,
      file: {
        name: original,
        // Served by the [name] route, NOT as a static public/ file: Next
        // snapshots public/ at build time, so a runtime upload would 404
        // until the next build -- which defeats attach-now-tap-now.
        url: `/api/qa-checklists/files/${encodeURIComponent(stored)}`,
        size: bytes.length,
      },
    });
  } catch (err) {
    console.error('[QA files] upload error:', err);
    return json({ success: false, error: 'Upload failed.' }, { status: 500 });
  }
}
