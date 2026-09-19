/**
 * Venture Enact Plan Trigger
 * Every 10 min, wakes the Venture steward to check in on whoever needs attention
 * to keep the Master Plan moving forward.
 *
 * Venture handles ALL the logic — reads PLAN_TRACKER.md + TRACKS array,
 * decides who to check in on, walkie-talkies them if needed, updates tracker,
 * presents to Joshua on significant events.
 *
 * This trigger is dumb. It just wakes Venture up.
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-write');

const QUEUE_FILE = path.join(require('os').homedir(), '.homestead', 'queue.json');
const TARGET = 'holler-venture';

try {
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));

  // Dedup — skip if there's already a pending enact-plan message
  const hasPending = queue.some(q =>
    q.target_session === TARGET &&
    q.status === 'pending' &&
    q.message && q.message.includes('enact plan check-in')
  );

  if (hasPending) {
    console.log('Skipped: pending enact-plan message already in queue');
    process.exit(0);
  }

  queue.push({
    id: `${Date.now()}-venture-enact-plan`,
    target_session: TARGET,
    type: 'action',
    message: JSON.stringify({
      type: 'action',
      from: 'holler-rooster',
      trigger: 'venture_enact_plan',
      instruction: 'enact plan check-in',
    }),
    status: 'pending',
    created_at: new Date().toISOString(),
    attempts: 0,
  });

  writeFileAtomicSync(QUEUE_FILE, JSON.stringify(queue, null, 2)); // atomic (torn-read fix 2026-08-25)
  console.log(`Queued enact-plan check-in for ${TARGET}`);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
