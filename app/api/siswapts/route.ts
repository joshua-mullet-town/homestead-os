import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const SISWAPTS_DIR = join(homedir(), '.homestead', 'stewards');

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');
  const doc = searchParams.get('doc');

  // GET /api/stewards?name=build-manager&doc=STRATEGY.md — read a specific doc
  if (name && doc) {
    const allowedDocs = ['STRATEGY.md', 'CLAUDE.md', 'interactions.json'];
    if (!allowedDocs.includes(doc)) {
      return NextResponse.json({ error: 'Invalid doc name' }, { status: 400 });
    }

    const filePath = join(SISWAPTS_DIR, name, doc);
    if (!existsSync(filePath)) {
      return NextResponse.json({ content: null });
    }

    try {
      const content = await readFile(filePath, 'utf-8');
      return NextResponse.json({ content });
    } catch {
      return NextResponse.json({ content: null });
    }
  }

  // GET /api/stewards?name=build-manager — get queue items for a specific steward
  if (name) {
    const queuePath = join(SISWAPTS_DIR, 'queue.json');
    let queue: any[] = [];
    try {
      if (existsSync(queuePath)) {
        queue = JSON.parse(await readFile(queuePath, 'utf-8'));
        // Filter to items targeting this steward's session
        queue = queue.filter((item: any) => item.target_session === name);
      }
    } catch {
      queue = [];
    }

    return NextResponse.json({ queue });
  }

  // GET /api/stewards — list all stewards
  if (!existsSync(SISWAPTS_DIR)) {
    return NextResponse.json({ stewards: [] });
  }

  try {
    const entries = await readdir(SISWAPTS_DIR, { withFileTypes: true });
    const stewards: { name: string; hasStrategy: boolean; hasInteractions: boolean }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'all' || entry.name === '.git') continue;

      const dir = join(SISWAPTS_DIR, entry.name);
      stewards.push({
        name: entry.name,
        hasStrategy: existsSync(join(dir, 'STRATEGY.md')),
        hasInteractions: existsSync(join(dir, 'interactions.json')),
      });
    }

    return NextResponse.json({ stewards });
  } catch {
    return NextResponse.json({ stewards: [] });
  }
}
