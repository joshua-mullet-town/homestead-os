/**
 * SEO Timer Trigger
 * Sends a walkie-talkie message to the SEO steward to kick off work.
 * Called by scheduler with config.task = "research" or "implementation"
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-write');

const QUEUE_FILE = path.join(require('os').homedir(), '.homestead', 'queue.json');
const TARGET = 'holler-venture--marketing--seo';

const task = process.argv[2] || 'research';
const taskId = `${Date.now()}-seo-${task}`;

const instructions = {
  research: 'SEO Research cycle. Read your CLAUDE.md, then: research SEO best practices, audit current state, check Google indexing for coveredbridge.live, analyze competitors, identify blog topics and content gaps, find organic growth opportunities (external posts, community contributions — helpful not spammy). Report findings to Marketing (holler-venture--marketing) when done.',
  implementation: 'SEO Implementation cycle. Read your CLAUDE.md, then: implement what research has identified. Write blogs, update meta tags, create pages, submit sitemaps, coordinate with Marketing Pages for page creation. If something needs Joshua\'s input, present through Marketing. Report progress to Marketing (holler-venture--marketing) when done.',
};

const instruction = instructions[task];
if (!instruction) {
  console.log('Unknown task:', task);
  process.exit(1);
}

try {
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));

  // Dedup — skip if there's already a pending SEO message of this type
  const hasPending = queue.some(q =>
    q.target_session === TARGET &&
    q.status === 'pending' &&
    q.message && q.message.includes(task === 'research' ? 'SEO Research cycle' : 'SEO Implementation cycle')
  );

  if (hasPending) {
    console.log(`Skipped: pending ${task} message already in queue`);
    process.exit(0);
  }

  queue.push({
    id: taskId,
    target_session: TARGET,
    type: 'action',
    message: JSON.stringify({
      type: 'action',
      from: 'holler-rooster',
      trigger: `seo_${task}`,
      instruction,
    }),
    status: 'pending',
    created_at: new Date().toISOString(),
    attempts: 0,
  });

  writeFileAtomicSync(QUEUE_FILE, JSON.stringify(queue, null, 2)); // atomic (torn-read fix 2026-08-25)
  console.log(`Queued SEO ${task} for ${TARGET}`);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
