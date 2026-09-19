/**
 * memory_store tool
 *
 * Write content to Homestead's memory files.
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { HOMESTEAD_DIR, MEMORY_DIR, MEMORY_FILE } from '../lib/indexer.js';

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get current time in readable format
 */
function getCurrentTime() {
  return new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York'
  }) + ' ET';
}

export const storeTool = {
  name: 'memory_store',
  description: `Write content to Homestead's memory.
- Set longTerm=true to append to MEMORY.md (for durable facts, preferences, lessons)
- Set longTerm=false (default) to append to today's daily log (for session notes, what happened)`,
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The content to store in memory (markdown format)'
      },
      section: {
        type: 'string',
        description: 'Section heading to add the content under (for daily logs). Will create ## heading if not exists.'
      },
      longTerm: {
        type: 'boolean',
        description: 'If true, writes to MEMORY.md. If false (default), writes to today\'s daily log.',
        default: false
      }
    },
    required: ['content']
  },

  async execute(args) {
    const { content, section, longTerm = false } = args;

    if (!content || content.trim().length === 0) {
      return { error: 'Content cannot be empty' };
    }

    try {
      if (longTerm) {
        // Append to MEMORY.md
        let existingContent = '';
        if (existsSync(MEMORY_FILE)) {
          existingContent = await readFile(MEMORY_FILE, 'utf-8');
        }

        // Find the right place to insert (before the footer if it exists)
        const footer = '*This file is curated long-term memory.';
        const footerIndex = existingContent.indexOf(footer);

        let newContent;
        if (footerIndex > 0) {
          newContent = existingContent.slice(0, footerIndex).trimEnd() +
            '\n\n' + content.trim() + '\n\n---\n\n' +
            existingContent.slice(footerIndex);
        } else {
          newContent = existingContent.trimEnd() + '\n\n---\n\n' + content.trim() + '\n';
        }

        await writeFile(MEMORY_FILE, newContent);

        return {
          success: true,
          message: 'Added to long-term memory (MEMORY.md)',
          file: MEMORY_FILE
        };
      } else {
        // Append to today's daily log
        const today = getTodayDate();
        const dailyFile = join(MEMORY_DIR, `${today}.md`);

        let existingContent = '';
        if (existsSync(dailyFile)) {
          existingContent = await readFile(dailyFile, 'utf-8');
        } else {
          // Create new daily file with header
          existingContent = `# ${today}\n\n`;
        }

        // Format the content with section if provided
        let formattedContent;
        if (section) {
          formattedContent = `\n## ${section} (~${getCurrentTime()})\n\n${content.trim()}\n`;
        } else {
          formattedContent = `\n${content.trim()}\n`;
        }

        await writeFile(dailyFile, existingContent.trimEnd() + '\n' + formattedContent);

        return {
          success: true,
          message: `Added to daily log (${today}.md)`,
          file: dailyFile,
          section: section || 'appended'
        };
      }
    } catch (error) {
      return { error: `Failed to store memory: ${error.message}` };
    }
  }
};
