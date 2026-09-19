import { NextResponse } from 'next/server';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { getCodeDir } from '@/lib/get-code-dir';

// Directories to exclude from the project list
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
]);

export async function GET() {
  try {
    const CODE_DIR = getCodeDir();
    const entries = await readdir(CODE_DIR, { withFileTypes: true });

    const projects = [];

    for (const entry of entries) {
      // Only include directories
      if (!entry.isDirectory()) continue;

      // Skip excluded directories
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(CODE_DIR, entry.name);

      try {
        const stats = await stat(fullPath);
        projects.push({
          name: entry.name,
          path: fullPath,
          modified: stats.mtime.toISOString(),
        });
      } catch (e) {
        // Skip directories we can't stat
        continue;
      }
    }

    // Sort by most recently modified
    projects.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    return NextResponse.json({ projects });
  } catch (error) {
    console.error('Failed to list projects:', error);
    return NextResponse.json({ projects: [], error: 'Failed to list projects' });
  }
}
