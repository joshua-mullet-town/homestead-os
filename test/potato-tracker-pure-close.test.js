'use strict';

// PURE-CODE CLOSE test — the redesign Josh approved (envelope-storage model REJECTED).
//
// Asserts the pure-code accountability model end-to-end at the tracker layer:
//   • BIRTH on a Josh-originated enqueue (bottom-bar from='josh-presenter' AND
//     card-reply source='presenter') records a tracker-side owed-response.
//   • CLOSE on the HOLDER's next outbound to ANYONE (envelope.from === holder),
//     observed at the enqueue chokepoint — no potato_id echo, no card, no _queue_id
//     guessing. One outbound closes ALL of that holder's open potatoes.
//   • The corrections-officer ring/raise (from='potato-corrections-officer') MUST
//     NEVER close a potato — a ring can't close its own potato.
//   • FLAG-SIDE HARDENING: a mid-compose pane (esc-to-interrupt OR a live streaming
//     token-counter timer) reads as WORKING so a between-turns idle gap is never
//     mis-flagged.
//
// Hermetic: a temp ledger, no live server, no tmux. Exercises the exact functions
// the enqueue chokepoint (queue-dispatcher.js) calls.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-pure-close-'));
const LEDGER = path.join(TMP, 'potato-tracker.json');

let potato;

before(() => {
  process.env.POTATO_LEDGER_FILE = LEDGER;
  potato = require('../lib/potato-tracker');
});

beforeEach(() => {
  // Fresh empty ledger before each test.
  fs.writeFileSync(LEDGER, JSON.stringify({ potatoes: {} }, null, 2));
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ── helpers mirroring the enqueue chokepoint's two calls ──────────────────────

// The queue-dispatcher enqueue hook calls recordBirth first; if not a birth, it
// calls recordClose. This helper replays that exact branch for one enqueue.
function observeEnqueue({ queueItemId, targetSession, envelope }) {
  const message = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
  const born = potato.recordBirthFromQueueItem({ queueItemId, targetSession, message });
  if (born) return { born, closed: [] };
  const closed = potato.recordCloseFromQueueItem({ queueItemId, message });
  return { born: null, closed };
}

// ── BIRTH ─────────────────────────────────────────────────────────────────────

test('BIRTH: a bottom-bar Josh send (from=josh-presenter) records an owed-response held by the target', () => {
  const { born } = observeEnqueue({
    queueItemId: 'q-birth-1',
    targetSession: 'holler-crowne-vault',
    envelope: { type: 'action', from: 'josh-presenter', instruction: 'do the thing' },
  });
  assert.ok(born, 'a Josh bottom-bar send births a potato');
  assert.strictEqual(born.status, 'open');
  assert.strictEqual(born.holder, 'holler-crowne-vault');
  assert.strictEqual(born.origin_surface, 'bottom-bar');
  assert.strictEqual(born.origin_queue_id, 'q-birth-1');
});

test('BIRTH: a card-reply feedback (source=presenter) also births, tracked to the target', () => {
  const { born } = observeEnqueue({
    queueItemId: 'q-birth-2',
    targetSession: 'holler-givegrove',
    envelope: { type: 'feedback', source: 'presenter', feedback: 'looks good, keep going' },
  });
  assert.ok(born, 'a card reply births a potato');
  assert.strictEqual(born.holder, 'holler-givegrove');
  assert.strictEqual(born.origin_surface, 'card-reply');
});

test('BIRTH idempotency: re-observing the same enqueue id does not double-birth', () => {
  const args = {
    queueItemId: 'q-dup',
    targetSession: 'holler-x',
    envelope: { type: 'action', from: 'josh-presenter', instruction: 'hi' },
  };
  const first = observeEnqueue(args);
  const second = observeEnqueue(args);
  assert.ok(first.born, 'first observation births');
  assert.strictEqual(second.born, null, 'second observation of same queue id does NOT birth');
  assert.strictEqual(potato.listOpenPotatoes().length, 1, 'exactly one potato exists');
});

// ── CLOSE (the core of the redesign) ──────────────────────────────────────────

test('CLOSE: the holder\'s NEXT outbound to ANYONE closes the loop (send_message shape)', () => {
  const { born } = observeEnqueue({
    queueItemId: 'q1',
    targetSession: 'holler-crowne-vault',
    envelope: { type: 'action', from: 'josh-presenter', instruction: 'do the thing' },
  });
  assert.strictEqual(potato.getPotato(born.potato_id).status, 'open');

  // The holder sends a plain steward→steward walkie to SOMEONE ELSE (not Josh).
  const { born: born2, closed } = observeEnqueue({
    queueItemId: 'q2',
    targetSession: 'holler-steward-manager',
    envelope: { type: 'action', from: 'holler-crowne-vault', instruction: 'question for you' },
  });
  assert.strictEqual(born2, null, 'a steward send is not a birth');
  assert.strictEqual(closed.length, 1, 'the holder\'s next outbound closes exactly one potato');
  assert.strictEqual(closed[0].potato_id, born.potato_id);

  const rec = potato.getPotato(born.potato_id);
  assert.strictEqual(rec.status, 'closed', 'potato is CLOSED with no card, no potato_id echo');
  assert.strictEqual(rec.closed_by, 'holler-crowne-vault');
  assert.strictEqual(rec.closing_queue_id, 'q2');
  const vias = rec.chain.map(c => c.via);
  assert.deepStrictEqual(vias, ['birth', 'close'], 'chain records birth then close');
});

test('CLOSE: a thread reply (envelope.from = replying steward) ALSO closes the loop', () => {
  const { born } = observeEnqueue({
    queueItemId: 'q-thread-birth',
    targetSession: 'holler-rooster',
    envelope: { type: 'action', from: 'josh-presenter', instruction: 'weigh in on the thread' },
  });

  // reply_to_thread forwards to the next participant with from=<replying steward>
  // and a _thread_id inside the envelope — this is the holder's outbound.
  const { closed } = observeEnqueue({
    queueItemId: 'q-thread-fwd',
    targetSession: 'holler-homestead',
    envelope: { type: 'action', from: 'holler-rooster', instruction: '--- THREAD ...', _thread_id: 'thread-abc' },
  });
  assert.strictEqual(closed.length, 1, 'a thread reply from the holder closes the loop');
  assert.strictEqual(closed[0].potato_id, born.potato_id);
  assert.strictEqual(potato.getPotato(born.potato_id).status, 'closed');
});

test('CLOSE: one holder outbound closes ALL of that holder\'s open potatoes', () => {
  const a = observeEnqueue({ queueItemId: 'qa', targetSession: 'holler-h', envelope: { from: 'josh-presenter', instruction: '1' } }).born;
  const b = observeEnqueue({ queueItemId: 'qb', targetSession: 'holler-h', envelope: { from: 'josh-presenter', instruction: '2' } }).born;
  assert.strictEqual(potato.listOpenPotatoes().length, 2);

  const { closed } = observeEnqueue({ queueItemId: 'qc', targetSession: 'holler-other', envelope: { from: 'holler-h', instruction: 'answered' } });
  const closedIds = closed.map(r => r.potato_id).sort();
  assert.deepStrictEqual(closedIds, [a.potato_id, b.potato_id].sort(), 'both of the holder\'s potatoes close on one outbound');
  assert.strictEqual(potato.listOpenPotatoes().length, 0);
});

test('CLOSE only fires for the holder — an unrelated steward\'s send does NOT close', () => {
  const born = observeEnqueue({ queueItemId: 'q1', targetSession: 'holler-holderA', envelope: { from: 'josh-presenter', instruction: 'x' } }).born;
  const { closed } = observeEnqueue({ queueItemId: 'q2', targetSession: 'holler-z', envelope: { from: 'holler-someone-else', instruction: 'unrelated' } });
  assert.strictEqual(closed.length, 0, 'a non-holder send closes nothing');
  assert.strictEqual(potato.getPotato(born.potato_id).status, 'open', 'the potato stays open');
});

// ── THE INVARIANT: corrections-officer ring MUST NEVER close ───────────────────

test('INVARIANT: a corrections-officer ring (from=potato-corrections-officer) does NOT close the potato', () => {
  const born = observeEnqueue({ queueItemId: 'q1', targetSession: 'holler-stuck', envelope: { from: 'josh-presenter', instruction: 'x' } }).born;

  // The ring/raise post from the static identity. This runs through the SAME enqueue
  // chokepoint (postQueue → /api/queue → enqueue), so recordClose sees it — and must
  // refuse to close.
  const { closed } = observeEnqueue({
    queueItemId: 'q-ring',
    targetSession: 'holler-stuck',
    envelope: { type: 'action', from: 'potato-corrections-officer', instruction: '⛔ DROPPED-MESSAGE ALERT', potato_id: born.potato_id },
  });
  assert.strictEqual(closed.length, 0, 'a ring closes NOTHING');
  assert.strictEqual(potato.getPotato(born.potato_id).status, 'open', 'the potato the ring is ABOUT stays open — only the holder\'s own send closes it');

  // And prove the holder's OWN subsequent send still closes normally after a ring.
  const after = observeEnqueue({ queueItemId: 'q-holder', targetSession: 'holler-elsewhere', envelope: { from: 'holler-stuck', instruction: 'on it' } });
  assert.strictEqual(after.closed.length, 1, 'the holder\'s own send after a ring DOES close');
  assert.strictEqual(potato.getPotato(born.potato_id).status, 'closed');
});

test('INVARIANT: a raiseRooster escalation (from=potato-corrections-officer) does NOT close', () => {
  const born = observeEnqueue({ queueItemId: 'q1', targetSession: 'holler-stuck', envelope: { from: 'josh-presenter', instruction: 'x' } }).born;
  const { closed } = observeEnqueue({
    queueItemId: 'q-raise',
    targetSession: 'holler-rooster',
    envelope: { type: 'action', from: 'potato-corrections-officer', instruction: 'POTATO STUCK', potato: { potato_id: born.potato_id } },
  });
  assert.strictEqual(closed.length, 0, 'a raise closes nothing');
  assert.strictEqual(potato.getPotato(born.potato_id).status, 'open');
});

// ── NO REDUNDANT 2ND CARD ──────────────────────────────────────────────────────

test('NO REDUNDANT CARD: closing requires NO card and NO potato_id — the holder just sends', () => {
  const born = observeEnqueue({ queueItemId: 'q1', targetSession: 'holler-worker', envelope: { from: 'josh-presenter', instruction: 'fix the bug' } }).born;
  // Holder does its work and sends a normal walkie — NO potato_id anywhere, NO card.
  const { closed } = observeEnqueue({ queueItemId: 'q2', targetSession: 'holler-auditor', envelope: { from: 'holler-worker', instruction: 'PR ready for review' } });
  assert.strictEqual(closed.length, 1, 'the loop closes on the ordinary send — the redundant "card Josh to close" step is gone');
  assert.strictEqual(potato.getPotato(born.potato_id).status, 'closed');
  // recordCloseByCard no longer exists — prove the old card-echo API is gone.
  assert.strictEqual(typeof potato.recordCloseByCard, 'undefined', 'the fragile card-echo close API was removed');
  assert.strictEqual(typeof potato.recordPassFromQueueItem, 'undefined', 'the pass API was removed (holder outbound now closes, not passes)');
});

// ── FLAG-SIDE HARDENING (mid-compose gate) ─────────────────────────────────────

test('FLAG HARDENING: the pane-working matcher treats a live streaming token counter as WORKING', () => {
  const pats = potato.PANE_WORKING_PATTERNS;
  const isWorking = (tail) => pats.some((re) => re.test(tail));

  // esc to interrupt — canonical working marker.
  assert.ok(isWorking('some output\n  ⎿ running\nesc to interrupt'), 'esc-to-interrupt reads as working');
  // live streaming token counter — mid-stream, the Rooster-trap case (esc scrolled off).
  assert.ok(isWorking('  ✻ Composing… (42s · ↓ 669 tokens)'), 'streaming token timer reads as working');
  assert.ok(isWorking('  (12s · ↑ 1.2k tokens · esc to interrupt)'), 'full streaming line reads as working');
  // a genuinely idle bottom bar — NOT working (proceed to ring/raise).
  assert.ok(!isWorking('╭──────────╮\n│ ❯        │\n╰──────────╯\n  shift+tab to cycle'), 'an idle box is NOT working');
  assert.ok(!isWorking('Done. Ready for the next task.'), 'a past-tense completion line is NOT working');
});
