/**
 * Marketing Check Customer Acquisition Trigger
 *
 * Every 10 min, wakes Marketing to check in on Customer Acquisition sub-sub-steward.
 * Marketing reads the CA session's tmux screen, sees if they're still grinding
 * prospect research, wakes them up if stalled.
 *
 * Stop condition: Marketing manually disables this job when 20 verified prospects exist,
 * or walkies Rooster to kill it.
 *
 * Trigger is dumb. It just fires a walkie-talkie to Marketing.
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-write');

const QUEUE_FILE = path.join(require('os').homedir(), '.homestead', 'queue.json');
const TARGET = 'holler-venture--marketing';

try {
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));

  // Dedup — skip if there's already a pending CA check message
  const hasPending = queue.some(q =>
    q.target_session === TARGET &&
    q.status === 'pending' &&
    q.message && q.message.includes('check on customer acquisition')
  );

  if (hasPending) {
    console.log('Skipped: pending CA check message already in queue');
    process.exit(0);
  }

  queue.push({
    id: `${Date.now()}-marketing-check-ca`,
    target_session: TARGET,
    type: 'action',
    message: JSON.stringify({
      type: 'action',
      from: 'holler-rooster',
      trigger: 'marketing_check_customer_acquisition',
      instruction: 'check on customer acquisition - are they still grinding prospects?',
    }),
    status: 'pending',
    created_at: new Date().toISOString(),
    attempts: 0,
  });

  writeFileAtomicSync(QUEUE_FILE, JSON.stringify(queue, null, 2)); // atomic (torn-read fix 2026-08-25)
  console.log(`Queued customer acquisition check for ${TARGET}`);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
