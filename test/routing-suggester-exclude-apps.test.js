'use strict';

/**
 * routing-suggester: optional `exclude_apps[]` rule guard.
 *
 * THE BUG THIS LOCKS DOWN: "Sarah Webber" is Josh's SISTER (Google Messages builds
 * group-thread TITLES from participant names, so her name lands in the sender identity
 * of every family text) AND separately a GiveGrove bug reporter. Before this guard the
 * givegrove-sarah-webber rule fired on family SMS. Her real GG reports arrive via
 * email/Slack, never via Messages.
 *
 * Uses the ROUTING_TABLE_PATH env override with a temp fixture table so the real table
 * (Alfred's, live) is never read or touched. The env var must be set BEFORE the module
 * is required, since ROUTING_TABLE_PATH is resolved at module load.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MESSAGES = 'com.google.android.apps.messaging';

const FIXTURE = {
  rules: [
    {
      id: 'givegrove-sarah-webber',
      match: { names: ['Sarah Webber'], phones: [], emails: [] },
      suggested_steward: 'holler-givegrove',
      topic: 'GiveGrove bug reports',
      exclude_apps: [MESSAGES],
    },
    {
      // No exclude_apps — must behave exactly as before (backward compat).
      id: 'givegrove-david',
      match: { names: ['David Kim'], phones: [], emails: [] },
      suggested_steward: 'holler-givegrove',
      topic: 'GiveGrove bug reports',
    },
  ],
};

const tmpTable = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'routing-suggester-test-')),
  'routing-table.json'
);
fs.writeFileSync(tmpTable, JSON.stringify(FIXTURE, null, 2));
process.env.ROUTING_TABLE_PATH = tmpTable;

const { suggestSteward, excludedByApp } = require('../lib/routing-suggester');

// (a) THE FIX: family SMS from Messages whose TITLE contains her name → no longer GG.
test('(a) phone notification from Messages with "Sarah Webber" in title → NOT givegrove', () => {
  const n = {
    source: 'phone',
    packageName: MESSAGES,
    appName: 'Messages',
    title: 'Sarah Webber, Mom, Josh',
    text: '<<REPLACE: a family contact>> is in the ER, will update when we know more',
  };
  assert.strictEqual(suggestSteward(n), null);
});

test('(a2) exclusion holds even when her name is in the BODY too', () => {
  const n = {
    source: 'phone',
    packageName: MESSAGES,
    appName: 'Messages',
    title: 'Family',
    text: 'Sarah Webber: heading over now',
  };
  assert.strictEqual(suggestSteward(n), null);
});

test('(a3) exclusion matches on appName alone (no packageName), case-insensitively', () => {
  const n = {
    source: 'phone',
    appName: '  COM.GOOGLE.ANDROID.APPS.MESSAGING ',
    title: 'Sarah Webber',
    text: 'dinner sunday?',
  };
  assert.strictEqual(suggestSteward(n), null);
});

// (b) Her real GG reports still route — gmail has no packageName/appName, so inert.
test('(b) gmail notification from Sarah with GG content → STILL givegrove', () => {
  const n = {
    source: 'gmail',
    from: 'Sarah Webber <sarah@example.com>',
    subject: 'Auction page bug',
    snippet: 'The bidding button is broken on mobile.',
  };
  const r = suggestSteward(n);
  assert.ok(r, 'expected a suggestion');
  assert.strictEqual(r.suggested_steward, 'holler-givegrove');
  assert.strictEqual(r.matched_rule_id, 'givegrove-sarah-webber');
});

test('(b2) her name from a DIFFERENT app (Slack) still routes to givegrove', () => {
  const n = {
    source: 'phone',
    packageName: 'com.Slack',
    appName: 'Slack',
    title: 'Sarah Webber',
    text: 'GG checkout is erroring',
  };
  const r = suggestSteward(n);
  assert.ok(r);
  assert.strictEqual(r.suggested_steward, 'holler-givegrove');
});

// (c) A rule without exclude_apps is completely unaffected.
test('(c) rule without exclude_apps still matches from Messages', () => {
  const n = {
    source: 'phone',
    packageName: MESSAGES,
    appName: 'Messages',
    title: 'David Kim',
    text: 'GG report: totals are off',
  };
  const r = suggestSteward(n);
  assert.ok(r);
  assert.strictEqual(r.suggested_steward, 'holler-givegrove');
  assert.strictEqual(r.matched_rule_id, 'givegrove-david');
});

// --- helper-level unit checks (backward compat + malformed input) ---

test('excludedByApp: absent / empty / non-array exclude_apps → false', () => {
  const n = { packageName: MESSAGES };
  assert.strictEqual(excludedByApp({ match: {} }, n), false);
  assert.strictEqual(excludedByApp({ match: {}, exclude_apps: [] }, n), false);
  assert.strictEqual(excludedByApp({ match: {}, exclude_apps: 'nope' }, n), false);
  assert.strictEqual(excludedByApp({ match: {}, exclude_apps: null }, n), false);
});

test('excludedByApp: reads exclude_apps under match{} too (forward compat)', () => {
  const rule = { match: { exclude_apps: [MESSAGES] } };
  assert.strictEqual(excludedByApp(rule, { packageName: MESSAGES }), true);
  assert.strictEqual(excludedByApp(rule, { packageName: 'com.Slack' }), false);
});

test('excludedByApp: gmail shape (no packageName/appName) → false, never throws', () => {
  const rule = { match: {}, exclude_apps: [MESSAGES] };
  assert.strictEqual(excludedByApp(rule, { from: 'a@b.com' }), false);
  assert.strictEqual(excludedByApp(rule, null), false);
  assert.strictEqual(excludedByApp(rule, {}), false);
});

test('excludedByApp: non-string entries in exclude_apps are ignored, not fatal', () => {
  const rule = { match: {}, exclude_apps: [null, 42, {}, MESSAGES] };
  assert.strictEqual(excludedByApp(rule, { packageName: MESSAGES }), true);
  assert.strictEqual(excludedByApp(rule, { packageName: 'com.other' }), false);
});

// --- fail-open must survive the change ---

test('fail-open: missing table → null, never throws', () => {
  const missing = path.join(os.tmpdir(), 'routing-suggester-does-not-exist.json');
  const prev = process.env.ROUTING_TABLE_PATH;
  try {
    // Re-require with a fresh cache so the module resolves the bad path at load.
    delete require.cache[require.resolve('../lib/routing-suggester')];
    process.env.ROUTING_TABLE_PATH = missing;
    const fresh = require('../lib/routing-suggester');
    assert.strictEqual(fresh.suggestSteward({ title: 'Sarah Webber' }), null);
  } finally {
    process.env.ROUTING_TABLE_PATH = prev;
    delete require.cache[require.resolve('../lib/routing-suggester')];
  }
});

test('fail-open: malformed JSON table → null, never throws', () => {
  const bad = path.join(os.tmpdir(), `routing-suggester-bad-${Date.now()}.json`);
  fs.writeFileSync(bad, '{ this is not json');
  const prev = process.env.ROUTING_TABLE_PATH;
  try {
    delete require.cache[require.resolve('../lib/routing-suggester')];
    process.env.ROUTING_TABLE_PATH = bad;
    const fresh = require('../lib/routing-suggester');
    assert.strictEqual(fresh.suggestSteward({ title: 'Sarah Webber' }), null);
  } finally {
    process.env.ROUTING_TABLE_PATH = prev;
    delete require.cache[require.resolve('../lib/routing-suggester')];
    fs.unlinkSync(bad);
  }
});
