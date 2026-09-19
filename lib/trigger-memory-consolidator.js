#!/usr/bin/env node
/**
 * Memory Consolidator Trigger
 *
 * Runs daily to review yesterday's memory log and update MEMORY.md
 * with any durable facts worth keeping long-term.
 *
 * Usage:
 *   node trigger-memory-consolidator.js [YYYY-MM-DD]
 *
 * Default: Yesterday's date
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spawnWorker } = require('./spawn-worker');

// Derive HOMESTEAD_DIR from this file's location (lib/ is one level down)
const HOMESTEAD_DIR = path.resolve(__dirname, '..');
const CONSOLIDATOR_PROMPT = path.join(HOMESTEAD_DIR, 'prompts/memory-consolidator.md');
const LOG_FILE = '/tmp/memory-consolidator.log';

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] [MemoryConsolidator] ${message}`;
  console.log(logLine);

  try {
    fs.appendFileSync(LOG_FILE, logLine + '\n');
  } catch (e) { /* ignore */ }
}

/**
 * Get yesterday's date in YYYY-MM-DD format
 */
function getYesterdayDate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
}

/**
 * Build the consolidator prompt
 */
function buildConsolidatorPrompt(dateStr) {
  const dailyLogPath = path.join(HOMESTEAD_DIR, 'memory', `${dateStr}.md`);

  // Read the base prompt template
  let basePrompt;
  try {
    basePrompt = fs.readFileSync(CONSOLIDATOR_PROMPT, 'utf-8');
  } catch (err) {
    log(`Error reading consolidator prompt: ${err.message}`, 'ERROR');
    return null;
  }

  const fullPrompt = `${basePrompt}

---

## File to Process

- Date: ${dateStr}
- Path: ${dailyLogPath}

---

Please review this daily log and update MEMORY.md if needed.`;

  return fullPrompt;
}

/**
 * Main trigger function
 */
function triggerConsolidator(dateStr) {
  log(`=== Memory Consolidator Run Start ===`);
  log(`Processing date: ${dateStr}`);

  // Check if daily log exists
  const dailyLogPath = path.join(HOMESTEAD_DIR, 'memory', `${dateStr}.md`);

  if (!fs.existsSync(dailyLogPath)) {
    log(`No daily log found for ${dateStr}. Exiting.`);
    return { triggered: false, reason: 'no_daily_log', date: dateStr };
  }

  // Check file size - skip if empty or tiny
  const stats = fs.statSync(dailyLogPath);
  if (stats.size < 100) {
    log(`Daily log too small (${stats.size} bytes). Exiting.`);
    return { triggered: false, reason: 'log_too_small', date: dateStr, size: stats.size };
  }

  log(`Found daily log: ${dailyLogPath} (${stats.size} bytes)`);

  // Build the prompt
  const prompt = buildConsolidatorPrompt(dateStr);
  if (!prompt) {
    return { triggered: false, reason: 'prompt_build_failed', date: dateStr };
  }

  log('Spawning memory consolidator worker...');

  // Spawn the worker
  const spawnResult = spawnWorker(prompt, { cwd: HOMESTEAD_DIR });

  if (spawnResult.success) {
    log(`Worker spawned: ${spawnResult.sessionName}`);
    return {
      triggered: true,
      sessionName: spawnResult.sessionName,
      date: dateStr,
      logFile: spawnResult.logFile
    };
  } else {
    log(`Failed to spawn worker: ${spawnResult.error}`, 'ERROR');
    return {
      triggered: false,
      reason: 'spawn_failed',
      error: spawnResult.error,
      date: dateStr
    };
  }
}

// CLI usage
if (require.main === module) {
  // Use provided date or default to yesterday
  const dateStr = process.argv[2] || getYesterdayDate();
  const result = triggerConsolidator(dateStr);

  console.log('');
  console.log('Result:', JSON.stringify(result, null, 2));
}

module.exports = { triggerConsolidator };
