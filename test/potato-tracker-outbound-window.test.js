/**
 * REGRESSION: hasNoOutboundSinceBirth must answer about a WINDOW, not "ever".
 *
 * Two real bugs, both found live on 2026-09-03 after holler-givegrove was raised to
 * Rooster for a potato it had answered:
 *
 *  1. NO UPPER BOUND. The scan matched any send after birth, ignoring its own `nowMs`
 *     argument — so it "found" evidence from AFTER the moment being judged. As a live
 *     gate it could excuse a holder using a card not yet written; as a backtest it
 *     silently concluded "this gate would have suppressed nothing" because every
 *     replay saw the holder's later sends.
 *
 *  2. LOCAL-VS-UTC ARCHIVE NAME. Archives are written by UTC date
 *     (`ts.slice(0, 10)`), but the scan rebuilt the filename from LOCAL date parts.
 *     At UTC-4 that is a 4-hour blind window every night (20:00–24:00 local) in which
 *     a holder's sends were invisible and the gate reported a false "no outbound".
 *
 * Both tests use a FIXTURE queue dir (POTATO_QUEUE_DIR) with sends at known times, so
 * they assert real behavior rather than a source-level guard. Each fails on the old
 * code: #1 finds the future send, #2 finds nothing at all in the dark window.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOLDER = 'holler-fixture-steward';

function makeQueueDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-outbound-'));
  for (const [name, items] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(items, null, 2));
  }
  return dir;
}

const send = (createdAt, from = HOLDER) => ({
  id: `q-${createdAt}`,
  target_session: 'someone-else',
  created_at: createdAt,
  message: JSON.stringify({ type: 'feedback', from, instruction: 'work output' }),
});

// Load the module against a fixture queue dir (config is read at require time).
// POTATO_QUEUE_DIR is restored after each test: leaving it set leaks into any suite
// that runs later in the same process/shell and points the live tracker at a temp dir.
const PRIOR_QUEUE_DIR = process.env.POTATO_QUEUE_DIR;
function restoreEnv() {
  if (PRIOR_QUEUE_DIR === undefined) delete process.env.POTATO_QUEUE_DIR;
  else process.env.POTATO_QUEUE_DIR = PRIOR_QUEUE_DIR;
  delete require.cache[require.resolve('../lib/potato-tracker.js')];
}
test.afterEach(restoreEnv);
process.on('exit', restoreEnv);

function loadWith(queueDir) {
  process.env.POTATO_QUEUE_DIR = queueDir;
  const p = require.resolve('../lib/potato-tracker.js');
  delete require.cache[p];
  return require(p);
}

test('upper bound: a send AFTER the judged moment must not count as evidence', () => {
  // Holder sends at 01:16:33. We judge at 01:12:12 — before that send existed.
  const dir = makeQueueDir({
    'queue.json': [send('2026-09-03T01:16:33.571Z')],
  });
  const pt = loadWith(dir);
  const rec = { potato_id: 'p', holder: HOLDER, born_at: '2026-09-03T01:10:37.435Z' };

  const atRaise = pt.hasNoOutboundSinceBirth(rec, Date.parse('2026-09-03T01:12:12.292Z'));
  assert.strictEqual(atRaise.noOutbound, true,
    'must report NO outbound: the only send happens 4min after the moment judged');
  assert.strictEqual(atRaise.foundAt, null);

  // Sanity (guards against a vacuous pass): judged AFTER the send, it must find it.
  const later = pt.hasNoOutboundSinceBirth(rec, Date.parse('2026-09-03T01:20:00Z'));
  assert.strictEqual(later.noOutbound, false, 'finder must still work inside the window');
  assert.strictEqual(later.foundAt, '2026-09-03T01:16:33.571Z');
});

test('archive lookup: a send in the UTC-vs-local dark window is still found', () => {
  // 01:16 UTC on 09-03 is 21:16 LOCAL on 09-02 at UTC-4. The archive is named by UTC
  // date, so the old local-date filename (queue-archive-2026-09-02) missed this file.
  const dir = makeQueueDir({
    'queue.json': [],
    'queue-archive-2026-09-03.json': [send('2026-09-03T01:16:33.571Z')],
  });
  const pt = loadWith(dir);
  const rec = { potato_id: 'p', holder: HOLDER, born_at: '2026-09-03T01:10:37.435Z' };

  const r = pt.hasNoOutboundSinceBirth(rec, Date.parse('2026-09-03T01:20:00Z'));
  assert.strictEqual(r.noOutbound, false,
    'must find the archived send even though its UTC date != the local date');
  assert.strictEqual(r.foundAt, '2026-09-03T01:16:33.571Z');
});

test('a holder with no sends at all still escalates (gate does not blanket-suppress)', () => {
  const dir = makeQueueDir({
    'queue.json': [send('2026-09-03T01:16:33.571Z', 'holler-somebody-else')],
  });
  const pt = loadWith(dir);
  const rec = { potato_id: 'p', holder: HOLDER, born_at: '2026-09-03T01:10:37.435Z' };
  const r = pt.hasNoOutboundSinceBirth(rec, Date.parse('2026-09-03T01:20:00Z'));
  assert.strictEqual(r.noOutbound, true, 'another steward’s send must not excuse this holder');
});
