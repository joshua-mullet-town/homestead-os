/**
 * Sales Feedback Watcher Trigger
 * Runs the watch-feedback.js script. If new feedback found, sends to Sales via walkie-talkie.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-write');

const SCRIPT = '<<REPLACE: your home dir, e.g. /Users/you>>/.homestead/stewards/venture/substewards/sales/evals/watch-feedback.js';
const QUEUE_FILE = path.join(require('os').homedir(), '.homestead', 'queue.json');
const TARGET = 'holler-venture--sales';

try {
  const output = execSync(`node "${SCRIPT}"`, { encoding: 'utf-8', timeout: 30000, cwd: path.dirname(SCRIPT) }).trim();
  if (!output) {
    console.log('No new feedback');
    process.exit(0);
  }

  let result;
  try { result = JSON.parse(output); } catch { console.log('Non-JSON output:', output); process.exit(0); }

  if (!result.hasNewFeedback) {
    console.log('No new feedback');
    process.exit(0);
  }

  const taskId = `${Date.now()}-sales-feedback`;
  const instruction = result.message || `New sales chat feedback: ${result.count} record(s). Review and improve prompts.`;

  // Send to Sales
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  queue.push({
    id: taskId,
    target_session: TARGET,
    type: 'action',
    message: JSON.stringify({
      type: 'action',
      from: 'holler-rooster',
      trigger: 'sales_feedback',
      instruction,
    }),
    status: 'pending',
    created_at: new Date().toISOString(),
    attempts: 0,
  });
  writeFileAtomicSync(QUEUE_FILE, JSON.stringify(queue, null, 2)); // atomic (torn-read fix 2026-08-25)
  console.log(`Sent ${result.count} feedback notification(s) to Sales`);
} catch (err) {
  if (err.status === 0) { console.log('No new feedback'); process.exit(0); }
  console.error('Error:', err.message);
  process.exit(1);
}
