import { NextResponse, type NextRequest } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const STEWARDS_DIR = join(homedir(), '.homestead', 'stewards');

function validateFile(file: string | null): string | null {
  if (!file || !file.endsWith('.json')) return 'Must specify a .json file';
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return 'Invalid filename';
  return null;
}

// GET /api/stewards/:id/data?file=todos.json
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = req.nextUrl.searchParams.get('file');
  const err = validateFile(file);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const filePath = join(STEWARDS_DIR, id, file!);
  if (!existsSync(filePath)) return NextResponse.json({ error: 'File not found' }, { status: 404 });

  try {
    const data = JSON.parse(await readFile(filePath, 'utf-8'));
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}

// POST /api/stewards/:id/data?file=todos.json
// Actions: { action: "complete", category: "shopping", itemId: "..." }
//          { action: "remove", category: "shopping", itemId: "..." }
//          { action: "remove-completed", itemId: "..." }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = req.nextUrl.searchParams.get('file');
  const err = validateFile(file);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const filePath = join(STEWARDS_DIR, id, file!);
  if (!existsSync(filePath)) return NextResponse.json({ error: 'File not found' }, { status: 404 });

  try {
    const body = await req.json();
    const data = JSON.parse(await readFile(filePath, 'utf-8'));
    const { action, category, itemId } = body;

    if (action === 'complete' && category && itemId) {
      const cat = data.categories?.[category];
      if (!cat) return NextResponse.json({ error: 'Category not found' }, { status: 404 });

      const itemIndex = cat.items.findIndex((i: { id: string }) => i.id === itemId);
      if (itemIndex === -1) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

      const [item] = cat.items.splice(itemIndex, 1);
      data.completed = data.completed || [];
      data.completed.unshift({
        ...item,
        category,
        completed_at: new Date().toISOString().split('T')[0],
      });
      // Keep last 20 completed
      if (data.completed.length > 20) data.completed = data.completed.slice(0, 20);

    } else if (action === 'remove' && category && itemId) {
      const cat = data.categories?.[category];
      if (!cat) return NextResponse.json({ error: 'Category not found' }, { status: 404 });
      cat.items = cat.items.filter((i: { id: string }) => i.id !== itemId);

    } else if (action === 'remove-completed' && itemId) {
      data.completed = (data.completed || []).filter((i: { id: string }) => i.id !== itemId);

    } else if (action === 'restore' && itemId) {
      const completed = data.completed || [];
      const itemIndex = completed.findIndex((i: { id: string }) => i.id === itemId);
      if (itemIndex === -1) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

      const [item] = completed.splice(itemIndex, 1);
      const targetCategory = item.category || 'personal';
      const { category: _cat, completed_at: _at, ...cleanItem } = item;
      if (!data.categories[targetCategory]) {
        data.categories[targetCategory] = { label: targetCategory, items: [] };
      }
      data.categories[targetCategory].items.push(cleanItem);

    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to update file' }, { status: 500 });
  }
}
