/**
 * memory_get tool
 *
 * Read specific memory files by date or identifier.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { MEMORY_DIR, MEMORY_FILE } from '../lib/indexer.js';

export const getTool = {
  name: 'memory_get',
  description: `Read a specific memory file.
- Use date (YYYY-MM-DD) to get a daily log
- Use "long-term" or "memory" to get MEMORY.md
- Returns the full markdown content of the file`,
  inputSchema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'Date (YYYY-MM-DD) for daily logs, or "long-term"/"memory" for MEMORY.md'
      }
    },
    required: ['identifier']
  },

  async execute(args) {
    const { identifier } = args;

    if (!identifier || identifier.trim().length === 0) {
      return { error: 'Identifier cannot be empty' };
    }

    try {
      let filePath;
      let fileType;

      // Check if it's a request for long-term memory
      if (identifier.toLowerCase() === 'long-term' || identifier.toLowerCase() === 'memory') {
        filePath = MEMORY_FILE;
        fileType = 'long-term';
      } else {
        // Assume it's a date
        const datePattern = /^\d{4}-\d{2}-\d{2}$/;
        if (!datePattern.test(identifier)) {
          return {
            error: `Invalid identifier format. Use YYYY-MM-DD for daily logs or "long-term" for MEMORY.md`,
            provided: identifier
          };
        }
        filePath = join(MEMORY_DIR, `${identifier}.md`);
        fileType = 'daily';
      }

      if (!existsSync(filePath)) {
        return {
          error: `Memory file not found`,
          identifier,
          type: fileType,
          path: filePath
        };
      }

      const content = await readFile(filePath, 'utf-8');

      return {
        success: true,
        identifier,
        type: fileType,
        file: filePath,
        content
      };
    } catch (error) {
      return { error: `Failed to read memory: ${error.message}` };
    }
  }
};
