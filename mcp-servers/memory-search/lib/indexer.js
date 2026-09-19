/**
 * Memory Indexer
 *
 * Scans Homestead's memory files and builds a searchable index.
 * Splits markdown by headings (## and ###) to create chunks.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

// Derive HOMESTEAD_DIR from this file's location (mcp-servers/memory-search/lib/ is 3 levels down)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOMESTEAD_DIR = join(__dirname, '..', '..', '..');
const MEMORY_DIR = join(HOMESTEAD_DIR, 'memory');
const MEMORY_FILE = join(HOMESTEAD_DIR, 'MEMORY.md');
const INDEX_FILE = join(HOMESTEAD_DIR, 'mcp-servers/memory-search/data/index.json');

/**
 * Parse a markdown file into chunks split by headings
 * @param {string} content - The markdown content
 * @param {string} filePath - Path to the file (for metadata)
 * @returns {Array} Array of chunk objects
 */
function parseMarkdownIntoChunks(content, filePath) {
  const chunks = [];
  const lines = content.split('\n');
  const fileName = basename(filePath);

  // Extract date from filename if it's a daily log (YYYY-MM-DD.md)
  const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  const date = dateMatch ? dateMatch[1] : null;

  let currentSection = [];
  let currentHeading = 'Top';
  let parentHeading = null;

  for (const line of lines) {
    // Check for ## heading (major section)
    if (line.startsWith('## ')) {
      // Save previous chunk if it has content
      if (currentSection.length > 0) {
        const chunkContent = currentSection.join('\n').trim();
        if (chunkContent) {
          chunks.push({
            file: filePath,
            section: parentHeading ? `${parentHeading} > ${currentHeading}` : currentHeading,
            content: chunkContent,
            date,
            heading_level: currentHeading === 'Top' ? 0 : (parentHeading ? 3 : 2)
          });
        }
      }
      parentHeading = line.slice(3).trim();
      currentHeading = parentHeading;
      currentSection = [];
    }
    // Check for ### heading (subsection)
    else if (line.startsWith('### ')) {
      // Save previous chunk if it has content
      if (currentSection.length > 0) {
        const chunkContent = currentSection.join('\n').trim();
        if (chunkContent) {
          chunks.push({
            file: filePath,
            section: parentHeading ? `${parentHeading} > ${currentHeading}` : currentHeading,
            content: chunkContent,
            date,
            heading_level: currentHeading === 'Top' ? 0 : (parentHeading ? 3 : 2)
          });
        }
      }
      currentHeading = line.slice(4).trim();
      currentSection = [];
    }
    else {
      currentSection.push(line);
    }
  }

  // Don't forget the last chunk
  if (currentSection.length > 0) {
    const chunkContent = currentSection.join('\n').trim();
    if (chunkContent) {
      chunks.push({
        file: filePath,
        section: parentHeading ? `${parentHeading} > ${currentHeading}` : currentHeading,
        content: chunkContent,
        date,
        heading_level: currentHeading === 'Top' ? 0 : (parentHeading ? 3 : 2)
      });
    }
  }

  return chunks;
}

/**
 * Get all memory files and their modification times
 * @returns {Promise<Array>} Array of {path, mtime} objects
 */
async function getMemoryFiles() {
  const files = [];

  // Add MEMORY.md if it exists
  if (existsSync(MEMORY_FILE)) {
    const stats = await stat(MEMORY_FILE);
    files.push({ path: MEMORY_FILE, mtime: stats.mtimeMs });
  }

  // Add all daily logs
  if (existsSync(MEMORY_DIR)) {
    const dailyFiles = await readdir(MEMORY_DIR);
    for (const file of dailyFiles) {
      if (file.endsWith('.md')) {
        const filePath = join(MEMORY_DIR, file);
        const stats = await stat(filePath);
        files.push({ path: filePath, mtime: stats.mtimeMs });
      }
    }
  }

  return files;
}

/**
 * Build or update the search index
 * @param {boolean} force - Force full reindex even if files haven't changed
 * @returns {Promise<Object>} The index object
 */
export async function buildIndex(force = false) {
  const files = await getMemoryFiles();

  // Load existing index if available
  let existingIndex = { chunks: [], fileMtimes: {}, lastUpdated: 0 };
  if (!force && existsSync(INDEX_FILE)) {
    try {
      const indexContent = await readFile(INDEX_FILE, 'utf-8');
      existingIndex = JSON.parse(indexContent);
    } catch (e) {
      // Index corrupted, will rebuild
    }
  }

  // Check which files need reindexing
  const filesToReindex = [];
  const currentMtimes = {};

  for (const { path, mtime } of files) {
    currentMtimes[path] = mtime;
    if (force || !existingIndex.fileMtimes[path] || existingIndex.fileMtimes[path] < mtime) {
      filesToReindex.push(path);
    }
  }

  // If nothing changed, return existing index
  if (filesToReindex.length === 0) {
    return existingIndex;
  }

  // Remove chunks from files that will be reindexed
  let chunks = existingIndex.chunks.filter(chunk => !filesToReindex.includes(chunk.file));

  // Also remove chunks from files that no longer exist
  const currentPaths = new Set(files.map(f => f.path));
  chunks = chunks.filter(chunk => currentPaths.has(chunk.file));

  // Index the changed files
  for (const filePath of filesToReindex) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const newChunks = parseMarkdownIntoChunks(content, filePath);
      chunks.push(...newChunks);
    } catch (e) {
      console.error(`Error indexing ${filePath}:`, e.message);
    }
  }

  // Build the new index
  const newIndex = {
    chunks,
    fileMtimes: currentMtimes,
    lastUpdated: Date.now(),
    stats: {
      totalChunks: chunks.length,
      totalFiles: files.length,
      reindexedFiles: filesToReindex.length
    }
  };

  // Save the index
  const { writeFile, mkdir } = await import('fs/promises');
  const indexDir = join(HOMESTEAD_DIR, 'mcp-servers/memory-search/data');
  if (!existsSync(indexDir)) {
    await mkdir(indexDir, { recursive: true });
  }
  await writeFile(INDEX_FILE, JSON.stringify(newIndex, null, 2));

  return newIndex;
}

/**
 * Load the current index (building if necessary)
 * @returns {Promise<Object>} The index object
 */
export async function loadIndex() {
  return buildIndex(false);
}

/**
 * Force a full reindex
 * @returns {Promise<Object>} The index object
 */
export async function reindex() {
  return buildIndex(true);
}

export { HOMESTEAD_DIR, MEMORY_DIR, MEMORY_FILE, INDEX_FILE };
