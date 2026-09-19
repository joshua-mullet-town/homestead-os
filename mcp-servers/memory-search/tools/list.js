/**
 * memory_list tool
 *
 * List available memory files with metadata.
 */

import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { MEMORY_DIR, MEMORY_FILE } from '../lib/indexer.js';

export const listTool = {
  name: 'memory_list',
  description: `List available memory files.
- Shows all daily logs and the long-term MEMORY.md
- Returns file dates, sizes, and modification times
- Optionally filter by date range`,
  inputSchema: {
    type: 'object',
    properties: {
      dateFrom: {
        type: 'string',
        description: 'Only include files from this date onwards (YYYY-MM-DD)'
      },
      dateTo: {
        type: 'string',
        description: 'Only include files up to this date (YYYY-MM-DD)'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of files to return (default: 30)',
        default: 30
      }
    }
  },

  async execute(args) {
    const { dateFrom, dateTo, limit = 30 } = args || {};

    try {
      const files = [];

      // Add MEMORY.md if it exists
      if (existsSync(MEMORY_FILE)) {
        const stats = await stat(MEMORY_FILE);
        files.push({
          type: 'long-term',
          identifier: 'long-term',
          file: MEMORY_FILE,
          size: stats.size,
          modified: new Date(stats.mtimeMs).toISOString()
        });
      }

      // Add daily logs
      if (existsSync(MEMORY_DIR)) {
        const dailyFiles = await readdir(MEMORY_DIR);

        for (const file of dailyFiles) {
          if (!file.endsWith('.md')) continue;

          // Extract date from filename
          const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
          if (!dateMatch) continue;

          const date = dateMatch[1];

          // Apply date filters
          if (dateFrom && date < dateFrom) continue;
          if (dateTo && date > dateTo) continue;

          const filePath = join(MEMORY_DIR, file);
          const stats = await stat(filePath);

          files.push({
            type: 'daily',
            identifier: date,
            date,
            file: filePath,
            size: stats.size,
            modified: new Date(stats.mtimeMs).toISOString()
          });
        }
      }

      // Sort daily logs by date descending (most recent first)
      const longTerm = files.filter(f => f.type === 'long-term');
      const daily = files
        .filter(f => f.type === 'daily')
        .sort((a, b) => b.date.localeCompare(a.date));

      // Combine and limit
      const result = [...longTerm, ...daily].slice(0, limit);

      return {
        success: true,
        count: result.length,
        totalDaily: daily.length,
        hasLongTerm: longTerm.length > 0,
        files: result
      };
    } catch (error) {
      return { error: `Failed to list memories: ${error.message}` };
    }
  }
};
