#!/usr/bin/env node
/**
 * Test script for the memory search MCP server
 *
 * Run: node test.js
 */

import { buildIndex, loadIndex, reindex } from './lib/indexer.js';
import { search, getStats } from './lib/search.js';
import { searchTool, statsTool } from './tools/search.js';
import { storeTool } from './tools/store.js';
import { getTool } from './tools/get.js';
import { listTool } from './tools/list.js';

async function test() {
  console.log('=== Steward Memory Search Tests ===\n');

  // Test 1: Build index
  console.log('1. Building index...');
  const index = await buildIndex(true); // Force rebuild
  console.log(`   ✓ Indexed ${index.stats.totalChunks} chunks from ${index.stats.totalFiles} files\n`);

  // Test 2: Get stats
  console.log('2. Getting stats...');
  const stats = await getStats();
  console.log(`   ✓ Stats:`, JSON.stringify(stats, null, 2), '\n');

  // Test 3: List memories
  console.log('3. Listing memory files...');
  const listResult = await listTool.execute({ limit: 10 });
  if (listResult.success) {
    console.log(`   ✓ Found ${listResult.count} files (${listResult.totalDaily} daily logs)`);
    if (listResult.files.length > 0) {
      console.log(`   Sample files:`, listResult.files.slice(0, 3).map(f => f.identifier).join(', '));
    }
  } else {
    console.log(`   ✗ Error: ${listResult.error}`);
  }
  console.log();

  // Test 4: Search for common terms
  console.log('4. Search tests...');
  const testQueries = ['homestead', 'memory', 'claude', 'session'];

  for (const query of testQueries) {
    const results = await search(query, { limit: 3 });
    if (results.length > 0) {
      console.log(`   ✓ "${query}": ${results.length} results`);
      console.log(`     Top result: ${results[0].section} (score: ${results[0].score})`);
    } else {
      console.log(`   - "${query}": no results`);
    }
  }
  console.log();

  // Test 5: Get specific memory
  console.log('5. Get memory file...');
  const getResult = await getTool.execute({ identifier: 'long-term' });
  if (getResult.success) {
    console.log(`   ✓ Got long-term memory (${getResult.content.length} chars)`);
  } else {
    console.log(`   - Long-term memory not found (expected if MEMORY.md doesn't exist)`);
  }

  // Try today's daily log
  const today = new Date().toISOString().split('T')[0];
  const todayResult = await getTool.execute({ identifier: today });
  if (todayResult.success) {
    console.log(`   ✓ Got today's log (${todayResult.content.length} chars)`);
  } else {
    console.log(`   - Today's log not found (expected if no activity today)`);
  }
  console.log();

  // Test 6: Search tool interface
  console.log('6. Search tool interface...');
  const toolResult = await searchTool.execute({ query: 'project', limit: 5 });
  console.log(`   ✓ Tool result: ${toolResult.message || toolResult.error}`);
  if (toolResult.results && toolResult.results.length > 0) {
    console.log(`   Sample: "${toolResult.results[0].snippet.slice(0, 80)}..."`);
  }
  console.log();

  console.log('=== All tests complete ===');
}

test().catch(console.error);
