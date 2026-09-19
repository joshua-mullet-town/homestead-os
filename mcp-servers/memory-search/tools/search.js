/**
 * memory_search tool
 *
 * Search across Steward's memory files using BM25 ranking.
 */

import { search, getStats } from '../lib/search.js';

export const searchTool = {
  name: 'memory_search',
  description: `Search through Steward's memory files (daily logs and long-term MEMORY.md) using keyword search.
Returns ranked results with file paths, sections, and snippets.
Use this to recall past decisions, find what was worked on, or look up project details.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query - keywords or phrases to find in memories'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
        default: 10
      },
      scope: {
        type: 'string',
        enum: ['all', 'daily', 'long-term'],
        description: 'Where to search: "all" (default), "daily" (only daily logs), or "long-term" (only MEMORY.md)',
        default: 'all'
      },
      dateFrom: {
        type: 'string',
        description: 'Only include results from this date onwards (YYYY-MM-DD format)'
      },
      dateTo: {
        type: 'string',
        description: 'Only include results up to this date (YYYY-MM-DD format)'
      }
    },
    required: ['query']
  },

  async execute(args) {
    const { query, limit = 10, scope = 'all', dateFrom, dateTo } = args;

    if (!query || query.trim().length === 0) {
      return { error: 'Query cannot be empty' };
    }

    try {
      const results = await search(query, { limit, scope, dateFrom, dateTo });

      if (results.length === 0) {
        return {
          message: `No memories found matching "${query}"`,
          results: []
        };
      }

      return {
        message: `Found ${results.length} memories matching "${query}"`,
        results: results.map(r => ({
          file: r.file,
          section: r.section,
          date: r.date || 'long-term',
          relevance: r.score,
          snippet: r.snippet
        }))
      };
    } catch (error) {
      return { error: `Search failed: ${error.message}` };
    }
  }
};

export const statsTool = {
  name: 'memory_stats',
  description: 'Get statistics about the memory search index - total chunks, files, last update time.',
  inputSchema: {
    type: 'object',
    properties: {}
  },

  async execute() {
    try {
      const stats = await getStats();
      return stats;
    } catch (error) {
      return { error: `Failed to get stats: ${error.message}` };
    }
  }
};
