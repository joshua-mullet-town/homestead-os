'use strict';

// Integration test for the link guard AS IT LIVES inside presenter-queue.addItem().
// This is the single enforcement point both the HTTP edge (server.js POST
// /api/presenter/queue) and every in-process caller (job-scheduler,
// triage-resolve, check-location-reminders) funnel through — so proving it here
// proves there is NO divergence between the two paths.
//
// Runs in an isolated temp cwd so DATA_DIR (cwd/data) and the card-links store
// both resolve into temp and never touch real data. presenter-queue.js reads
// cwd at require-time, so we chdir BEFORE requiring it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let origCwd;
let pq;
let cardStore;

// A real top steward (dir exists under ~/.homestead/stewards) so validateSessionId passes.
const SUB_SESSION = 'holler-homestead--foreman--presenter-card-link-autosave';
const TOP = 'holler-homestead';

before(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'additem-guard-'));
  process.chdir(tmpDir);
  pq = require('../lib/presenter-queue');
  cardStore = require('../lib/card-links-store');
});

after(() => {
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function baseCard(extra) {
  return Object.assign({
    title: 'T',
    message: 'M',
    buttons: ['OK'],
    session_id: SUB_SESSION,
  }, extra);
}

test('NO link → card passes untouched (no throw, no store write)', () => {
  const item = pq.addItem(baseCard({ title: 'Build done', message: 'All green' }));
  assert.ok(item && item.id);
  // No card-links file written for a no-link card.
  assert.strictEqual(cardStore.getLinks(SUB_SESSION).length, 0);
});

test('labeled link → card accepted AND link saved+pinned, rolled up to top', () => {
  const before = cardStore.getLinks(TOP).length;
  const item = pq.addItem(baseCard({
    title: 'PR up',
    message: 'See [the pull request](https://github.com/x/y/pull/9)',
  }));
  assert.ok(item && item.id);
  const links = cardStore.getLinks(TOP);
  assert.strictEqual(links.length, before + 1);
  const saved = links.find((l) => l.url === 'https://github.com/x/y/pull/9');
  assert.ok(saved, 'link should be saved');
  assert.strictEqual(saved.title, 'the pull request');
  assert.strictEqual(saved.last_opened, null);
  assert.ok(typeof saved.created_at === 'number');
});

test('button-labeled link → saved', () => {
  const item = pq.addItem(baseCard({
    title: 'Site up',
    message: 'ok',
    buttons: [{ label: 'Open live site', url: 'https://live.example.com' }, 'Dismiss'],
  }));
  assert.ok(item && item.id);
  const saved = cardStore.getLinks(TOP).find((l) => l.url === 'https://live.example.com');
  assert.ok(saved);
  assert.strictEqual(saved.title, 'Open live site');
});

test('naked link → HARD REJECT with code NAKED_CARD_LINK and actionable message', () => {
  assert.throws(
    () => pq.addItem(baseCard({ title: 'Look', message: 'https://naked.example.com/x' })),
    (err) => {
      assert.strictEqual(err.code, 'NAKED_CARD_LINK');
      assert.match(err.message, /https:\/\/naked\.example\.com\/x/);
      assert.match(err.message, /title/i);
      return true;
    }
  );
});

test('naked-link reject does NOT enqueue the card', () => {
  const queuedBefore = pq.getQueue().length;
  try {
    pq.addItem(baseCard({ title: 'x', message: 'https://another-naked.example.com' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'NAKED_CARD_LINK');
  }
  assert.strictEqual(pq.getQueue().length, queuedBefore, 'rejected card must not be queued');
});

test('session_id guard still fires (link guard does not shadow it)', () => {
  assert.throws(
    () => pq.addItem(baseCard({ session_id: 'unknown', message: 'no link here' })),
    (err) => err.code === 'INVALID_SESSION_ID'
  );
});

test('invalid session + naked link → session guard wins (runs first)', () => {
  assert.throws(
    () => pq.addItem(baseCard({ session_id: 'unknown', message: 'https://naked.example.com' })),
    (err) => err.code === 'INVALID_SESSION_ID'
  );
});

// ===========================================================================
// FIX 2 — LAZY host-ish label rejected at the addItem gate
// ===========================================================================

test('lazy label "localhost" → HARD REJECT code LAZY_CARD_LINK_LABEL, teaching msg', () => {
  assert.throws(
    () => pq.addItem(baseCard({
      title: 'Doc',
      message: 'ok',
      buttons: [{ label: 'localhost', url: 'http://localhost:8947/cv-approach-plan.html' }],
    })),
    (err) => {
      assert.strictEqual(err.code, 'LAZY_CARD_LINK_LABEL');
      assert.match(err.message, /content/i);
      assert.match(err.message, /CV Approach Plan/); // worked example in the message
      return true;
    }
  );
});

test('lazy-label reject does NOT enqueue and does NOT save', () => {
  const queuedBefore = pq.getQueue().length;
  const savedBefore = cardStore.getLinks(TOP).length;
  try {
    pq.addItem(baseCard({
      title: 'x',
      message: '[127.0.0.1](http://127.0.0.1:3000/x)',
    }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(err.code, 'LAZY_CARD_LINK_LABEL');
  }
  assert.strictEqual(pq.getQueue().length, queuedBefore, 'rejected card must not be queued');
  assert.strictEqual(cardStore.getLinks(TOP).length, savedBefore, 'nothing saved on reject');
});

test('content label on a localhost URL → ACCEPTED + saved (label is what matters)', () => {
  const item = pq.addItem(baseCard({
    title: 'Doc',
    message: 'Read the [CV Approach Plan](http://localhost:8947/cv-approach-plan.html).',
  }));
  assert.ok(item && item.id);
  const saved = cardStore.getLinks(TOP).find((l) => l.url === 'http://localhost:8947/cv-approach-plan.html');
  assert.ok(saved);
  assert.strictEqual(saved.title, 'CV Approach Plan');
});

// ===========================================================================
// FIX 1 — NAME UNIQUENESS at the addItem gate (the sharp edge)
// ===========================================================================

test('same title + DIFFERENT url vs saved list → HARD REJECT DUPLICATE_CARD_LINK_TITLE', () => {
  // Seed the store with a first content-named link.
  pq.addItem(baseCard({
    title: 'First',
    message: '[Approach Plan](https://uniq.example.com/one)',
  }));
  const queuedBefore = pq.getQueue().length;
  // A second card reusing that name for a DIFFERENT url must be rejected.
  assert.throws(
    () => pq.addItem(baseCard({
      title: 'Second',
      message: '[Approach Plan](https://uniq.example.com/two)',
    })),
    (err) => {
      assert.strictEqual(err.code, 'DUPLICATE_CARD_LINK_TITLE');
      assert.match(err.message, /Approach Plan/);
      assert.match(err.message, /https:\/\/uniq\.example\.com\/one/); // names the existing url
      assert.match(err.message, /https:\/\/uniq\.example\.com\/two/); // names the new url
      return true;
    }
  );
  assert.strictEqual(pq.getQueue().length, queuedBefore, 'rejected card must not be queued');
  // The store still has exactly the one original link — no second "Approach Plan".
  const dupes = cardStore.getLinks(TOP).filter((l) => l.title === 'Approach Plan');
  assert.strictEqual(dupes.length, 1);
});

test('BOUNDARY: same url + UPDATED title → REFRESH, not a duplicate (must not break)', () => {
  pq.addItem(baseCard({
    title: 'v1',
    message: '[Old Name](https://refresh.example.com/doc)',
  }));
  const before = cardStore.getLinks(TOP).filter((l) => l.url === 'https://refresh.example.com/doc');
  assert.strictEqual(before.length, 1);
  // Re-post the SAME url with a NEW title — this is a living-record refresh, NOT
  // a collision. Must succeed and update the title in place.
  const item = pq.addItem(baseCard({
    title: 'v2',
    message: '[New Name](https://refresh.example.com/doc)',
  }));
  assert.ok(item && item.id);
  const after = cardStore.getLinks(TOP).filter((l) => l.url === 'https://refresh.example.com/doc');
  assert.strictEqual(after.length, 1, 'still exactly one record for that url');
  assert.strictEqual(after[0].title, 'New Name', 'title refreshed in place');
});

test('different title + different url → BOTH persist (distinct names are fine)', () => {
  const startCount = cardStore.getLinks(TOP).length;
  pq.addItem(baseCard({ title: 'A', message: '[Volume Strategy](https://distinct.example.com/vol)' }));
  pq.addItem(baseCard({ title: 'B', message: '[Core Growth Deep-Dive](https://distinct.example.com/core)' }));
  const links = cardStore.getLinks(TOP);
  assert.strictEqual(links.length, startCount + 2);
  assert.ok(links.find((l) => l.title === 'Volume Strategy'));
  assert.ok(links.find((l) => l.title === 'Core Growth Deep-Dive'));
});

test('SAME card carrying TWO links with the SAME title (diff urls) → reject (intra-card collision)', () => {
  const queuedBefore = pq.getQueue().length;
  assert.throws(
    () => pq.addItem(baseCard({
      title: 'Two links, one name',
      message: '[Report](https://intra.example.com/a)\n[Report](https://intra.example.com/b)',
    })),
    (err) => {
      assert.strictEqual(err.code, 'DUPLICATE_CARD_LINK_TITLE');
      assert.match(err.message, /Report/);
      return true;
    }
  );
  assert.strictEqual(pq.getQueue().length, queuedBefore, 'rejected card must not be queued');
  // Neither link leaked into the store.
  assert.strictEqual(cardStore.getLinks(TOP).filter((l) => l.title === 'Report').length, 0);
});

test('SAME card carrying the SAME url twice under one title → fine (dedup, not a collision)', () => {
  // A card that repeats one link (e.g. once in text, once as a button) under the
  // same name is deduped by url — NOT an intra-card title collision.
  const item = pq.addItem(baseCard({
    title: 'Repeated link',
    message: 'See the [Design Doc](https://onceurl.example.com/d).',
    buttons: [{ label: 'Design Doc', url: 'https://onceurl.example.com/d' }, 'OK'],
  }));
  assert.ok(item && item.id);
  const saved = cardStore.getLinks(TOP).filter((l) => l.url === 'https://onceurl.example.com/d');
  assert.strictEqual(saved.length, 1, 'saved once');
  assert.strictEqual(saved[0].title, 'Design Doc');
});

// ===========================================================================
// FIX #1 (integration) — link inside a button's `run` command. This is the
// exact hole that bit Josh: the tool's own docs push toward
// { label:'Watch Demo', run:'open http://…' }, which used to sail through
// completely unscanned. Prove the guard now catches it end-to-end.
// ===========================================================================

test('button run with LABEL + url → accepted AND saved under the button label', () => {
  const item = pq.addItem(baseCard({
    title: 'Demo',
    message: 'launch it',
    buttons: [{ label: 'Watch Demo', run: 'open https://demo.example.com/run-btn' }, 'Skip'],
  }));
  assert.ok(item && item.id);
  const saved = cardStore.getLinks(TOP).find((l) => l.url === 'https://demo.example.com/run-btn');
  assert.ok(saved, 'run-button link should be saved');
  assert.strictEqual(saved.title, 'Watch Demo');
});

test('button run with url but NO descriptive label → HARD REJECT NAKED_CARD_LINK', () => {
  const queuedBefore = pq.getQueue().length;
  assert.throws(
    () => pq.addItem(baseCard({
      title: 'Open',
      message: 'go',
      buttons: [{ run: 'open https://runonly-naked.example.com/x' }],
    })),
    (err) => {
      assert.strictEqual(err.code, 'NAKED_CARD_LINK');
      assert.match(err.message, /runonly-naked\.example\.com/);
      return true;
    }
  );
  assert.strictEqual(pq.getQueue().length, queuedBefore, 'rejected run-button card must not queue');
});

// ===========================================================================
// FIX #2 (integration) — scheme-less URLs at the addItem gate. Path-required:
// a bare host with a /path (or www.*) is a link; a bare domain in prose is not.
// ===========================================================================

test('scheme-less url with path + label → accepted AND saved (normalized to https)', () => {
  const item = pq.addItem(baseCard({
    title: 'Repo',
    message: 'Source: github.com/homestead/schemeless-app',
  }));
  assert.ok(item && item.id);
  const saved = cardStore.getLinks(TOP).find((l) => l.url === 'https://github.com/homestead/schemeless-app');
  assert.ok(saved, 'scheme-less link should be saved, normalized to https');
  assert.match(saved.title, /Source/i);
});

test('naked scheme-less url (host.tld/path, no label) → HARD REJECT NAKED_CARD_LINK', () => {
  assert.throws(
    () => pq.addItem(baseCard({ title: 'x', message: 'schemeless-naked.example.com/report' })),
    (err) => {
      assert.strictEqual(err.code, 'NAKED_CARD_LINK');
      assert.match(err.message, /schemeless-naked\.example\.com\/report/);
      return true;
    }
  );
});

test('bare domain mentioned in prose (no path) → card passes untouched (no false reject)', () => {
  const item = pq.addItem(baseCard({
    title: 'Vendor note',
    message: 'we still route DNS through acme.io for now',
  }));
  assert.ok(item && item.id, 'prose that merely names a domain must NOT be rejected');
});
