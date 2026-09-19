#!/usr/bin/env node
/**
 * Memory Commit Script
 *
 * Commits any uncommitted memory files to the repository.
 * Designed to run as a recurring job to ensure memories are backed up.
 *
 * Usage:
 *   node commit-memories.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOMESTEAD_DIR = path.resolve(__dirname, '..');
const MEMORY_DIR = path.join(HOMESTEAD_DIR, 'memory');

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] [MemoryCommit] ${message}`);
}

function commitMemories() {
  log('=== Memory Commit Start ===');

  // Check if memory directory exists
  if (!fs.existsSync(MEMORY_DIR)) {
    log('Memory directory does not exist, nothing to commit');
    return { committed: false, reason: 'no_memory_dir' };
  }

  // Check for uncommitted changes in memory/
  try {
    const status = execSync('git status --porcelain memory/', {
      encoding: 'utf-8',
      cwd: HOMESTEAD_DIR
    }).trim();

    if (!status) {
      log('No uncommitted memory files');
      return { committed: false, reason: 'nothing_to_commit' };
    }

    // Parse status to get file list
    const files = status.split('\n').map(line => {
      const file = line.slice(3); // Remove status prefix (e.g., " M ", "?? ")
      return file;
    });

    log(`Found ${files.length} uncommitted memory file(s):`);
    files.forEach(f => log(`  - ${f}`));

    // Stage memory files
    execSync('git add memory/', {
      encoding: 'utf-8',
      cwd: HOMESTEAD_DIR
    });

    // Create commit message
    const today = new Date().toISOString().split('T')[0];
    const commitMsg = `Backup memory files (${today})

Auto-committed by memory backup job.
Files: ${files.join(', ')}`;

    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      cwd: HOMESTEAD_DIR,
      env: { ...process.env, HOMESTEAD_AUTOSAVE: '1' }
    });

    log(`Committed ${files.length} memory file(s)`);

    // Push to origin
    try {
      execSync('git push origin main', {
        encoding: 'utf-8',
        cwd: HOMESTEAD_DIR,
        timeout: 30000
      });
      log('Pushed to origin');
    } catch (pushErr) {
      log(`Failed to push: ${pushErr.message}`, 'WARN');
      // Don't fail the job - local commit is still valuable
    }

    return {
      committed: true,
      files,
      pushed: true
    };

  } catch (err) {
    log(`Error: ${err.message}`, 'ERROR');
    return {
      committed: false,
      reason: 'error',
      error: err.message
    };
  }
}

// CLI usage
if (require.main === module) {
  const result = commitMemories();
  console.log('');
  console.log('Result:', JSON.stringify(result, null, 2));
}

module.exports = { commitMemories };
