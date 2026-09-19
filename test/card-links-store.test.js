'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The store keys off process.cwd()/data/steward-card-links.json. Run every
// test in an isolated temp cwd so we never touch the real data file, and
// require the module fresh AFTER chdir so CARD_LINKS_FILE resolves into temp.
let tmpDir;
let origCwd;
let store;

before(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-links-store-'));
  process.chdir(tmpDir);
  store = require('../lib/card-links-store');
});

after(() => {
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // Clear the store file between tests.
  try { fs.rmSync(store.CARD_LINKS_FILE, { force: true }); } catch {}
});

test('resolveTopSteward strips at first "--"', () => {
  assert.strictEqual(store.resolveTopSteward('holler-homestead'), 'holler-homestead');
  assert.strictEqual(store.resolveTopSteward('holler-homestead--foreman--xyz'), 'holler-homestead');
  assert.strictEqual(store.resolveTopSteward('holler-givegrove--worker'), 'holler-givegrove');
});

test('saveLink creates a living record with created_at + null last_opened', () => {
  const res = store.saveLink('holler-homestead', { title: 'Dash', url: 'https://d.example.com' }, 1000);
  assert.strictEqual(res.topStewardId, 'holler-homestead');
  assert.strictEqual(res.added, true);
  assert.deepStrictEqual(res.links, [{ title: 'Dash', url: 'https://d.example.com', created_at: 1000, last_opened: null }]);
});

test('sub-steward link rolls UP to top steward ONLY', () => {
  store.saveLink('holler-homestead--foreman--card-link-autosave', { title: 'PR', url: 'https://pr.example.com' }, 2000);
  const raw = JSON.parse(fs.readFileSync(store.CARD_LINKS_FILE, 'utf-8'));
  // Only the top steward key exists — no sub key.
  assert.deepStrictEqual(Object.keys(raw), ['holler-homestead']);
  assert.strictEqual(raw['holler-homestead'][0].url, 'https://pr.example.com');
  // getLinks by the sub session resolves to the same top collection.
  const viaSub = store.getLinks('holler-homestead--foreman--x');
  assert.strictEqual(viaSub.length, 1);
});

test('re-saving same url dedupes and preserves created_at + last_opened', () => {
  store.saveLink('holler-homestead', { title: 'Old', url: 'https://x.example.com' }, 100);
  store.touchLink('holler-homestead', 'https://x.example.com', 500);
  const res = store.saveLink('holler-homestead', { title: 'New Title', url: 'https://x.example.com' }, 999);
  assert.strictEqual(res.links.length, 1);
  assert.strictEqual(res.added, false);
  assert.strictEqual(res.links[0].title, 'New Title');     // title refreshed
  assert.strictEqual(res.links[0].created_at, 100);        // preserved
  assert.strictEqual(res.links[0].last_opened, 500);       // preserved
});

test('saveLink rejects missing title or url', () => {
  assert.strictEqual(store.saveLink('holler-homestead', { title: '', url: 'https://x.com' }), null);
  assert.strictEqual(store.saveLink('holler-homestead', { title: 'x', url: '' }), null);
  assert.strictEqual(store.saveLink('', { title: 'x', url: 'https://x.com' }), null);
});

test('touchLink updates last_opened by url', () => {
  store.saveLink('holler-homestead', { title: 'A', url: 'https://a.example.com' }, 1);
  const res = store.touchLink('holler-homestead', 'https://a.example.com', 12345);
  assert.strictEqual(res.links[0].last_opened, 12345);
});

test('touchLink on unknown url → null', () => {
  store.saveLink('holler-homestead', { title: 'A', url: 'https://a.example.com' }, 1);
  assert.strictEqual(store.touchLink('holler-homestead', 'https://nope.example.com', 9), null);
});

test('forgetLink removes a single link by url', () => {
  store.saveLink('holler-homestead', { title: 'A', url: 'https://a.example.com' }, 1);
  store.saveLink('holler-homestead', { title: 'B', url: 'https://b.example.com' }, 2);
  const res = store.forgetLink('holler-homestead', 'https://a.example.com');
  assert.strictEqual(res.links.length, 1);
  assert.strictEqual(res.links[0].url, 'https://b.example.com');
});

test('forgetLink with no url clears the whole collection', () => {
  store.saveLink('holler-homestead', { title: 'A', url: 'https://a.example.com' }, 1);
  const res = store.forgetLink('holler-homestead');
  assert.deepStrictEqual(res.links, []);
});

test('forget via sub-steward session resolves to top collection', () => {
  store.saveLink('holler-homestead', { title: 'A', url: 'https://a.example.com' }, 1);
  const res = store.forgetLink('holler-homestead--foreman', 'https://a.example.com');
  assert.deepStrictEqual(res.links, []);
});

// ===========================================================================
// FIX 1 — findTitleCollision: same-title + diff-url collides; same-url refreshes
// ===========================================================================

test('findTitleCollision: same title + DIFFERENT url → returns the collision', () => {
  store.saveLink('holler-homestead', { title: 'localhost', url: 'http://localhost:8947/a.html' }, 1);
  const hit = store.findTitleCollision('holler-homestead', { title: 'localhost', url: 'http://localhost:8947/b.html' });
  assert.ok(hit, 'should detect a collision');
  assert.strictEqual(hit.url, 'http://localhost:8947/a.html');
});

test('findTitleCollision: same title + SAME url → null (that is a refresh, not a dup)', () => {
  store.saveLink('holler-homestead', { title: 'Dash', url: 'https://d.example.com' }, 1);
  const hit = store.findTitleCollision('holler-homestead', { title: 'Dash', url: 'https://d.example.com' });
  assert.strictEqual(hit, null);
});

test('findTitleCollision: DIFFERENT title + different url → null (distinct name is fine)', () => {
  store.saveLink('holler-homestead', { title: 'Approach Plan', url: 'https://a.example.com' }, 1);
  const hit = store.findTitleCollision('holler-homestead', { title: 'Volume Strategy', url: 'https://b.example.com' });
  assert.strictEqual(hit, null);
});

test('findTitleCollision: case-insensitive + trimmed title match', () => {
  store.saveLink('holler-homestead', { title: 'Localhost', url: 'https://a.example.com' }, 1);
  const hit = store.findTitleCollision('holler-homestead', { title: '  localhost ', url: 'https://b.example.com' });
  assert.ok(hit, 'title match should ignore case + surrounding whitespace');
});

test('findTitleCollision: resolves via sub-steward session to the top collection', () => {
  store.saveLink('holler-homestead', { title: 'Doc', url: 'https://a.example.com' }, 1);
  const hit = store.findTitleCollision('holler-homestead--foreman--x', { title: 'Doc', url: 'https://b.example.com' });
  assert.ok(hit, 'sub-steward should see the top steward saved list');
});

test('findTitleCollision: empty title → null (nothing to collide)', () => {
  store.saveLink('holler-homestead', { title: 'A', url: 'https://a.example.com' }, 1);
  assert.strictEqual(store.findTitleCollision('holler-homestead', { title: '', url: 'https://b.example.com' }), null);
});
