/**
 * REAL unit tests for the presenter history search feature.
 *
 * Two layers under test:
 *   1. searchAllHistory() in lib/presenter-queue.js — the actual cross-steward
 *      search. Tests run it against REAL fixture JSON files written to disk in a
 *      temp `data/presenter-history/` dir. Because HISTORY_DIR is resolved from
 *      process.cwd() at require-time, we chdir into the temp dir BEFORE
 *      requiring the module. No mocks, no stubs — real fs reads.
 *   2. formatCard() in tools/searchHistory.js — the tool wrapper's both-sides
 *      shaping. Verified in isolation (pure function, exported for test).
 *
 * Run: node --test mcp-servers/presenter/tools/searchHistory.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, writeFileSync, rmSync } = require('fs');
const { join } = require('path');
const os = require('os');

// ---- Fixture setup: a temp CWD with real archive files ---------------------

const TMP_ROOT = join(os.tmpdir(), `presenter-history-test-${process.pid}`);
const HISTORY_DIR = join(TMP_ROOT, 'data', 'presenter-history');

// Build a card the way archiveItem() stores it: original presentation fields
// plus resolved_at and a feedback object (button/text or dismissed).
function card({ session, title, message, button, text, dismissed, resolved_at }) {
  return {
    title,
    message,
    resolved_at,
    session_id: session,
    feedback: dismissed
      ? { type: 'feedback', dismissed: true }
      : { type: 'feedback', button: button || null, text: text || '' },
  };
}

// Two stewards, prefix-sharing session_ids on purpose so the exact/substring
// steward filter has something real to discriminate.
const HOMESTEAD = 'holler-homestead';
const HOMESTEAD_FOREMAN = 'holler-homestead--foreman';
const GIVEGROVE = 'holler-givegrove';

// Timestamps chosen so recency ordering is unambiguous. Larger = newer.
const T = { oldest: 1000, mid: 2000, newer: 3000, newest: 4000 };

function writeFixtures() {
  mkdirSync(HISTORY_DIR, { recursive: true });

  writeFileSync(
    join(HISTORY_DIR, `${HOMESTEAD}.json`),
    JSON.stringify([
      card({
        session: HOMESTEAD,
        title: 'Deploy the widget',
        message: 'Ready to ship the pricing widget?',
        button: 'Approve',
        text: 'yes ship it',
        resolved_at: T.mid,
      }),
      card({
        session: HOMESTEAD,
        title: 'Dismissed card',
        message: 'This one Josh swiped away',
        dismissed: true,
        resolved_at: T.oldest,
      }),
    ])
  );

  writeFileSync(
    join(HISTORY_DIR, `${HOMESTEAD_FOREMAN}.json`),
    JSON.stringify([
      card({
        session: HOMESTEAD_FOREMAN,
        title: 'Foreman question',
        message: 'Should the foreman gate the merge?',
        button: 'No',
        text: 'let it go through, but keyword is widget',
        resolved_at: T.newest,
      }),
    ])
  );

  writeFileSync(
    join(HISTORY_DIR, `${GIVEGROVE}.json`),
    JSON.stringify([
      card({
        session: GIVEGROVE,
        title: 'Auction feature',
        message: 'Enable live bidding?',
        button: 'Approve',
        text: 'go',
        resolved_at: T.newer,
      }),
    ])
  );
}

// Chdir into the fixture root, THEN require the module so HISTORY_DIR resolves
// to our temp data dir. Cache the require.
let searchAllHistory;
test.before(() => {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  writeFixtures();
  process.chdir(TMP_ROOT);
  ({ searchAllHistory } = require('../../../lib/presenter-queue.js'));
});

test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// ---- searchAllHistory: BOTH SIDES ------------------------------------------

test('returns BOTH sides — the card Josh saw AND how he replied', () => {
  const results = searchAllHistory({ q: 'pricing widget' });
  assert.equal(results.length, 1);
  const r = results[0];
  // Josh's side (what he was shown):
  assert.equal(r.title, 'Deploy the widget');
  assert.equal(r.message, 'Ready to ship the pricing widget?');
  // Josh's reply side (present, not dropped):
  assert.ok(r.feedback, 'feedback must be present');
  assert.equal(r.feedback.button, 'Approve');
  assert.equal(r.feedback.text, 'yes ship it');
});

// ---- keyword matches across title / message / feedback.text ----------------

test('keyword matches in the card TITLE', () => {
  const results = searchAllHistory({ q: 'Auction' });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Auction feature');
});

test('keyword matches in the card MESSAGE', () => {
  const results = searchAllHistory({ q: 'live bidding' });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Auction feature');
});

test('keyword matches in JOSH\'S REPLY text (feedback.text)', () => {
  // "let it go through" lives ONLY in feedback.text of the foreman card —
  // not in any title or message. This proves both-sides search.
  const results = searchAllHistory({ q: 'let it go through' });
  assert.equal(results.length, 1);
  assert.equal(results[0]._session_id, HOMESTEAD_FOREMAN);
  assert.equal(results[0].feedback.text, 'let it go through, but keyword is widget');
});

test('keyword "widget" spans a title on one card and a reply on another', () => {
  // "widget" appears in HOMESTEAD's title/message and in FOREMAN's reply text.
  const results = searchAllHistory({ q: 'widget' });
  assert.equal(results.length, 2);
  const sids = results.map(r => r._session_id);
  assert.ok(sids.includes(HOMESTEAD));
  assert.ok(sids.includes(HOMESTEAD_FOREMAN));
});

test('case-insensitive matching', () => {
  assert.equal(searchAllHistory({ q: 'AUCTION' }).length, 1);
  assert.equal(searchAllHistory({ q: 'auction' }).length, 1);
});

test('no query returns ALL cards (recent-first browse mode)', () => {
  const results = searchAllHistory({});
  assert.equal(results.length, 4); // 2 homestead + 1 foreman + 1 givegrove
});

// ---- steward filter: substring AND exact -----------------------------------

test('steward substring filter narrows to matching session_ids', () => {
  // "homestead" substring matches BOTH holler-homestead and
  // holler-homestead--foreman (the prefix-sharing sibling).
  const results = searchAllHistory({ steward: 'homestead' });
  const sids = new Set(results.map(r => r._session_id));
  assert.ok(sids.has(HOMESTEAD));
  assert.ok(sids.has(HOMESTEAD_FOREMAN));
  assert.ok(!sids.has(GIVEGROVE));
});

test('stewardExact locks to a single archive, excluding prefix siblings', () => {
  // Exact match on holler-homestead must NOT pull in holler-homestead--foreman.
  const results = searchAllHistory({ steward: HOMESTEAD, stewardExact: true });
  const sids = new Set(results.map(r => r._session_id));
  assert.ok(sids.has(HOMESTEAD));
  assert.ok(!sids.has(HOMESTEAD_FOREMAN), 'exact must exclude the --foreman sibling');
});

test('stewardExact honors truthy string forms and rejects "0"/"false"', () => {
  const strict = searchAllHistory({ steward: HOMESTEAD, stewardExact: '1' });
  assert.ok(!new Set(strict.map(r => r._session_id)).has(HOMESTEAD_FOREMAN));

  // "0" / "false" must fall back to substring behavior (sibling included).
  const loose = searchAllHistory({ steward: 'homestead', stewardExact: '0' });
  assert.ok(new Set(loose.map(r => r._session_id)).has(HOMESTEAD_FOREMAN));
});

// ---- recency ordering (newest-first) ---------------------------------------

test('results are ordered newest-first across ALL stewards', () => {
  const results = searchAllHistory({});
  const times = results.map(r => r.resolved_at);
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepEqual(times, sorted, 'must be strictly newest-first');
  // Concretely: foreman(newest) → givegrove(newer) → homestead ship(mid) → dismissed(oldest)
  assert.equal(results[0].resolved_at, T.newest);
  assert.equal(results[results.length - 1].resolved_at, T.oldest);
});

// ---- limit cap -------------------------------------------------------------

test('limit caps the number of results (keeping the newest)', () => {
  const results = searchAllHistory({ limit: 2 });
  assert.equal(results.length, 2);
  // The two newest survive the cap.
  assert.equal(results[0].resolved_at, T.newest);
  assert.equal(results[1].resolved_at, T.newer);
});

test('limit is clamped to a sane minimum (garbage/zero -> default, not 0)', () => {
  // parseInt('0') || 200 -> 200; ensures a bad limit never returns nothing.
  const results = searchAllHistory({ limit: 0 });
  assert.equal(results.length, 4);
});
