import { NextResponse, type NextRequest } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const STEWARDS_DIR = join(homedir(), '.homestead', 'stewards');

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const stewardJsonPath = join(STEWARDS_DIR, id, 'steward.json');

  if (!existsSync(stewardJsonPath)) {
    return NextResponse.json({ error: 'Steward not found' }, { status: 404 });
  }

  try {
    const data = JSON.parse(await readFile(stewardJsonPath, 'utf-8'));
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to read steward.json' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const stewardJsonPath = join(STEWARDS_DIR, id, 'steward.json');

  if (!existsSync(stewardJsonPath)) {
    return NextResponse.json({ error: 'Steward not found' }, { status: 404 });
  }

  try {
    const existing = JSON.parse(await readFile(stewardJsonPath, 'utf-8'));
    const updates = await req.json();

    // Only allow updating specific fields
    const allowedFields = ['shorthand', 'icon', 'color', 'name'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        existing[field] = updates[field];
      }
    }

    // Validate shorthand length
    if (existing.shorthand && existing.shorthand.length > 4) {
      return NextResponse.json({ error: 'Shorthand must be 4 characters or fewer' }, { status: 400 });
    }

    await writeFile(stewardJsonPath, JSON.stringify(existing, null, 2) + '\n');
    return NextResponse.json(existing);
  } catch (e) {
    return NextResponse.json({ error: 'Failed to update steward.json' }, { status: 500 });
  }
}
