/**
 * BM25 Search Implementation
 *
 * Uses wink-bm25-text-search for ranking memory chunks.
 */

import bm25 from 'wink-bm25-text-search';
import { loadIndex } from './indexer.js';

// Search engine instance
let engine = null;
let indexedChunks = [];
let lastIndexUpdate = 0;

/**
 * Tokenizer for search - splits on whitespace and punctuation
 * @param {string} text - Text to tokenize
 * @returns {Array} Array of tokens
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')  // Replace punctuation with spaces
    .split(/\s+/)               // Split on whitespace
    .filter(t => t.length > 1); // Remove single-char tokens
}

/**
 * Initialize or refresh the search engine with current index
 * @returns {Promise<void>}
 */
async function initializeEngine() {
  const index = await loadIndex();

  // Skip if index hasn't changed
  if (engine && index.lastUpdated === lastIndexUpdate) {
    return;
  }

  // Create new engine
  engine = bm25();

  // Configure the engine
  engine.defineConfig({
    fldWeights: {
      content: 1,
      section: 2  // Boost matches in section titles
    },
    bm25Params: {
      k1: 1.2,  // Term saturation
      b: 0.75   // Length normalization
    }
  });

  // Define the document schema
  engine.definePrepTasks([
    (text) => tokenize(text)
  ]);

  // Add all chunks to the engine
  indexedChunks = index.chunks;
  for (let i = 0; i < indexedChunks.length; i++) {
    const chunk = indexedChunks[i];
    engine.addDoc({
      content: chunk.content,
      section: chunk.section
    }, i);
  }

  // Consolidate for searching
  engine.consolidate();
  lastIndexUpdate = index.lastUpdated;
}

/**
 * Search memories using BM25 ranking
 * @param {string} query - The search query
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results to return (default: 10)
 * @param {string} options.dateFrom - Filter results from this date (YYYY-MM-DD)
 * @param {string} options.dateTo - Filter results to this date (YYYY-MM-DD)
 * @param {string} options.scope - 'daily', 'long-term', or 'all' (default: 'all')
 * @returns {Promise<Array>} Array of search results with scores
 */
export async function search(query, options = {}) {
  const {
    limit = 10,
    dateFrom = null,
    dateTo = null,
    scope = 'all'
  } = options;

  // Initialize/refresh the engine
  await initializeEngine();

  if (!engine || indexedChunks.length === 0) {
    return [];
  }

  // Perform the search
  const rawResults = engine.search(query, limit * 3);  // Get more than needed for filtering

  // Map results back to chunks and apply filters
  const results = [];
  for (const [docId, score] of rawResults) {
    const chunk = indexedChunks[docId];
    if (!chunk) continue;

    // Apply scope filter
    if (scope === 'daily' && chunk.file.includes('MEMORY.md')) continue;
    if (scope === 'long-term' && !chunk.file.includes('MEMORY.md')) continue;

    // Apply date filters (only for daily logs)
    if (chunk.date) {
      if (dateFrom && chunk.date < dateFrom) continue;
      if (dateTo && chunk.date > dateTo) continue;
    }

    // Create result object
    results.push({
      file: chunk.file,
      section: chunk.section,
      date: chunk.date,
      score: Math.round(score * 1000) / 1000,
      snippet: createSnippet(chunk.content, query, 200)
    });

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Create a snippet from content, highlighting the query terms
 * @param {string} content - The full content
 * @param {string} query - The search query
 * @param {number} maxLength - Maximum snippet length
 * @returns {string} The snippet
 */
function createSnippet(content, query, maxLength = 200) {
  const queryTerms = tokenize(query);
  const contentLower = content.toLowerCase();

  // Find the best starting position (where most query terms appear)
  let bestStart = 0;
  let bestScore = 0;

  for (let i = 0; i < content.length - 50; i += 20) {
    const window = contentLower.slice(i, i + maxLength);
    let score = 0;
    for (const term of queryTerms) {
      if (window.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  // Extract snippet
  let snippet = content.slice(bestStart, bestStart + maxLength);

  // Clean up - try to start/end at word boundaries
  if (bestStart > 0) {
    const firstSpace = snippet.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 30) {
      snippet = '...' + snippet.slice(firstSpace + 1);
    } else {
      snippet = '...' + snippet;
    }
  }

  if (bestStart + maxLength < content.length) {
    const lastSpace = snippet.lastIndexOf(' ');
    if (lastSpace > snippet.length - 30) {
      snippet = snippet.slice(0, lastSpace) + '...';
    } else {
      snippet = snippet + '...';
    }
  }

  return snippet.replace(/\n+/g, ' ').trim();
}

/**
 * Get search engine stats
 * @returns {Promise<Object>} Stats about the search index
 */
export async function getStats() {
  const index = await loadIndex();
  return {
    totalChunks: index.chunks.length,
    totalFiles: Object.keys(index.fileMtimes).length,
    lastUpdated: new Date(index.lastUpdated).toISOString(),
    ...index.stats
  };
}
