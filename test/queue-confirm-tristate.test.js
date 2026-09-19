'use strict';

/**
 * CONFIRM TRI-STATE + REDELIVERY-CANCEL REGRESSION (2026-09-01).
 *
 * THE BUG (verified live): POST /api/queue/confirm is answered by server.js,
 * which returned queueDispatcher.confirm()'s BARE BOOLEAN as {confirmed:<bool>}.
 * Because it was a bare bool, two completely different outcomes collapsed into
 * the same `false`:
 *   - "already confirmed, then drained to the dated archive" (a SUCCESS), and
 *   - "this id never existed" (a real miss).
 * The fleet drop-detector reads `false` as "never confirmed / dropped", so a
 * roger-that for a message that HAD been delivered and confirmed on time
 * re-raised a correction and refired walkie-submit-stuck. Observed live: an item
 * archived as status:confirmed with attempts:3, confirm landed 21:05:20, and
 * redeliveries kept coming AFTER.
 *
 * Note the response itself CANNOT be the only oracle here — the same command
 * answered true-then-false purely on archiving TIMING. So these tests assert
 * against the item's PERSISTED state in queue.json / queue-archive-*.json as
 * well as the response, and drive the REAL cleanQueue() drain rather than
 * hand-placing an archive fixture.
 *
 * Two halves are pinned, because tri-state alone is not enough:
 *   1. TRI-STATE — how a LATER roger READS.
 *   2. REDELIVERY-CANCEL — a confirm must stop a delivery already sitting on the
 *      target's serialized chain from ever pasting. Without this the duplicate
 *      still lands and the loop survives in weaker form.
 *
 * All fixture ids are OBVIOUSLY SYNTHETIC and HOMESTEAD_DIR is redirected to a
 * throwaway dir, so the live fleet queue is never touched.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-confirm-tristate-'));
process.env.HOMESTEAD_DIR = TMP;

const QUEUE = path.join(TMP, 'queue.json');
const TODAY = new Date().toISOString().slice(0, 10);
const ARCHIVE = path.join(TMP, `queue-archive-${TODAY}.json`);

const MOD = path.join(__dirname, '..', 'lib', 'queue-dispatcher.js');
const qd = require(MOD);

const readQueue = () => JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const readArchive = () => JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
const reset = (items = []) => {
  fs.writeFileSync(QUEUE, JSON.stringify(items, null, 2));
  fs.writeFileSync(ARCHIVE, '[]');
};

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// ─────────────────────────── 1. TRI-STATE ───────────────────────────

test('genuinely unknown id → {confirmed:false, reason:"not_found"}', async () => {
  reset();
  const r = await qd.confirm('OBVIOUSLY-FAKE-PROBE-99999');
  assert.strictEqual(r.confirmed, false);
  assert.strictEqual(r.reason, 'not_found');
});

test('fresh pending id → {confirmed:true}, and the PERSISTED item is confirmed', async () => {
  const ID = 'SYNTHETIC-TEST-PENDING-00002';
  reset([{ id: ID, target_session: 'SYNTHETIC-TARGET', status: 'pending', message: 'x', attempts: 1 }]);

  const r = await qd.confirm(ID, 'SYNTHETIC-TARGET');
  assert.strictEqual(r.confirmed, true);
  assert.strictEqual(r.already, undefined, 'a first confirm must NOT report already:true');

  const stored = readQueue().find(i => i.id === ID);
  assert.strictEqual(stored.status, 'confirmed');
  assert.ok(stored.confirmed_at, 'confirmed_at must be persisted');
  assert.strictEqual(stored.confirmed_by, 'SYNTHETIC-TARGET');
});

test('already-confirmed id STILL LIVE → {confirmed:true, already:true}', async () => {
  const ID = 'SYNTHETIC-TEST-LIVE-00003';
  reset([{ id: ID, target_session: 'SYNTHETIC-TARGET', status: 'pending', message: 'x' }]);

  await qd.confirm(ID, 'SYNTHETIC-TARGET');
  const r = await qd.confirm(ID, 'SYNTHETIC-TARGET');

  assert.strictEqual(r.confirmed, true);
  assert.strictEqual(r.already, true);
  assert.strictEqual(r.archived, undefined, 'still live — must not claim it came from the archive');
  assert.strictEqual(readQueue().find(i => i.id === ID).status, 'confirmed',
    'a repeat confirm must be idempotent, not clobber the record');
});

test('LOAD-BEARING: confirmed then ARCHIVED → {confirmed:true, already:true} (was false)', async () => {
  const ID = 'SYNTHETIC-TEST-ARCHIVED-00004';
  reset([{
    id: ID, target_session: 'SYNTHETIC-TARGET', status: 'pending', message: 'x', attempts: 3,
    created_at: new Date(Date.now() - 3600000).toISOString(),
  }]);

  // (a)+(b) confirm it — this succeeds and is persisted
  const first = await qd.confirm(ID, 'SYNTHETIC-TARGET');
  assert.strictEqual(first.confirmed, true);
  assert.strictEqual(first.already, undefined);
  assert.strictEqual(readQueue().find(i => i.id === ID).status, 'confirmed');

  // (c) let it archive — age confirmed_at past ARCHIVE_GRACE_MS, then run the
  // REAL cleanQueue() so the drain under test is the production path.
  const aged = readQueue();
  aged.find(i => i.id === ID).confirmed_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  fs.writeFileSync(QUEUE, JSON.stringify(aged, null, 2));
  await qd.cleanQueue();

  assert.ok(!readQueue().find(i => i.id === ID), 'item should have drained OUT of the live queue');
  const archived = readArchive().find(i => i.id === ID);
  assert.ok(archived, 'item should be IN the dated archive');
  assert.strictEqual(archived.status, 'confirmed', 'archive record proves it was confirmed');
  assert.ok(archived.confirmed_at);

  // (d)+(e) confirm AGAIN — this is the exact call that used to read `false`
  // and drove the drop-detector to re-raise a correctly-delivered message.
  const second = await qd.confirm(ID, 'SYNTHETIC-TARGET');
  assert.strictEqual(second.confirmed, true, 'archived-but-confirmed must NOT read as a drop');
  assert.strictEqual(second.already, true);
  assert.strictEqual(second.archived, true, 'proves the archive-consult path actually ran');
});

test('unknown id with a POPULATED archive still → not_found (no over-matching)', async () => {
  reset([]);
  fs.writeFileSync(ARCHIVE, JSON.stringify([
    { id: 'SYNTHETIC-OTHER-ITEM-A', status: 'confirmed' },
    { id: 'SYNTHETIC-OTHER-ITEM-B', status: 'failed' },
  ], null, 2));

  const r = await qd.confirm('SYNTHETIC-NEVER-EXISTED-00005');
  assert.strictEqual(r.confirmed, false);
  assert.strictEqual(r.reason, 'not_found');
});

// ──────────────────── 2. REDELIVERY-CANCEL ────────────────────
//
// Drives the REAL deliverNow() serialized chain against an instrumented twin of
// the module whose injectNow is replaced by a gated stub. Gating item A holds
// the chain open, which is exactly the real-world window in which item B's
// roger-that can land while B is still queued behind A.

test('confirm CANCELS a delivery already queued on the target chain', async () => {
  const ID_A = 'SYNTHETIC-CANCEL-FIRST-000A';   // occupies the chain (gated)
  const ID_B = 'SYNTHETIC-CANCEL-TARGET-000B';  // queued BEHIND A; we confirm this one
  reset([
    { id: ID_A, target_session: 'SYNTHETIC-TARGET', status: 'pending', message: 'a' },
    { id: ID_B, target_session: 'SYNTHETIC-TARGET', status: 'pending', message: 'b' },
  ]);

  // Build the instrumented twin next to the original so its relative requires
  // still resolve. Removed in the finally below.
  let src = fs.readFileSync(MOD, 'utf8');
  src = src.replace(/async function injectNow\(sessionName, item\) \{/,
    `async function injectNow(sessionName, item) {
      global.__INJECT_CALLS.push(item.id);
      await global.__INJECT_GATE;
      return 'delivered';
    }
    async function __unusedRealInjectNow(sessionName, item) {`);
  src += '\nmodule.exports.__deliverNow = deliverNow;'
       + '\nmodule.exports.__cancelled = () => cancelledDeliveries;'
       + '\nmodule.exports.__inFlight = () => inFlightDeliveries;\n';
  const twin = path.join(__dirname, '..', 'lib', '.qd-tristate-test-twin.js');
  fs.writeFileSync(twin, src);

  try {
    global.__INJECT_CALLS = [];
    let releaseGate;
    global.__INJECT_GATE = new Promise(res => { releaseGate = res; });
    const twinMod = require(twin);

    const pA = twinMod.__deliverNow('SYNTHETIC-TARGET', { id: ID_A, message: 'a' });
    const pB = twinMod.__deliverNow('SYNTHETIC-TARGET', { id: ID_B, message: 'b' });
    await new Promise(r => setImmediate(r));

    assert.ok(global.__INJECT_CALLS.includes(ID_A), 'A should be inside injectNow, holding the chain');
    assert.ok(!global.__INJECT_CALLS.includes(ID_B), 'B must still be WAITING behind A');
    assert.ok(twinMod.__inFlight().has(ID_B));

    // The target rogers-that for B while B is still queued on the chain.
    const r = await twinMod.confirm(ID_B, 'SYNTHETIC-TARGET');
    assert.strictEqual(r.confirmed, true);
    assert.ok(twinMod.__cancelled().has(ID_B), 'confirm must mark the in-flight delivery cancelled');

    releaseGate();
    await pA; await pB;

    assert.ok(!global.__INJECT_CALLS.includes(ID_B),
      'B must NEVER paste after being confirmed — this is the duplicate-delivery fix');
    assert.strictEqual(global.__INJECT_CALLS.filter(x => x === ID_A).length, 1,
      'cancel must be surgical: A still delivers normally');

    const q = readQueue();
    const storedB = q.find(i => i.id === ID_B);
    assert.strictEqual(storedB.status, 'confirmed', 'B must not be downgraded back to dispatched');
    assert.strictEqual(storedB.dispatched_ready, undefined,
      'B must not have the Phase-1 retry ladder re-armed');
    assert.strictEqual(q.find(i => i.id === ID_A).status, 'dispatched',
      'the uncancelled item follows the normal path');

    assert.ok(!twinMod.__cancelled().has(ID_B), 'cancelledDeliveries must drain (no unbounded growth)');
    assert.ok(!twinMod.__inFlight().has(ID_B), 'inFlightDeliveries must drain');
  } finally {
    try { fs.unlinkSync(twin); } catch {}
  }
});
