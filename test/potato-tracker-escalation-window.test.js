'use strict';

/**
 * ESCALATION-WINDOW REGRESSION (false-alarm fix, 2026-08-31).
 *
 * THE BUG (measured, not inferred — across all 131 ledger potatoes carrying both a
 * ring and a raise): ring→raise was min 4.8s / MEDIAN 9.995s, and birth→raise was
 * MEDIAN 34s with 86/131 raises firing under a minute. Ten seconds is less than one
 * tool call, so a steward that read Josh's card and STARTED WORKING got raised to
 * Rooster before it could finish a single Bash call. Live case: holler-homestead was
 * rung + raised while actively re-laning ten cards and spawning a worker — doing
 * exactly what the potato asked for, flagged as stuck.
 *
 * WHY IT MATTERS: false alarms train stewards and Rooster to treat DROPPED-MESSAGE
 * ALERTS as background static. That's alert fatigue, and it's exactly when a REAL
 * dropped message slips through. So these tests pin BOTH directions:
 *   1. a working steward mid-multi-step-turn is never raised, and
 *   2. a genuinely dark holder STILL raises — the fix must not buy quiet by
 *      introducing a false negative.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-window-'));
const LEDGER = path.join(TMP, 'potato-tracker.json');
const HOLDER = 'holler-window-test-holder';

// ── stub /api/queue so a ring/raise is observable without touching the fleet ──
const posts = [];
let stubServer, stubPort;

function startStub() {
  return new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { posts.push(JSON.parse(body)); } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ item: { id: `stub-${posts.length}` } }));
      });
    });
    stubServer.listen(0, '127.0.0.1', () => {
      stubPort = stubServer.address().port;
      resolve();
    });
  });
}

/** Split observed posts into rings (to the holder) and raises (to Rooster). */
function classify() {
  const out = { rings: [], raises: [] };
  for (const p of posts) {
    let env;
    try { env = JSON.parse(p.message_override); } catch { continue; }
    if (p.target_session === 'holler-stub-rooster' && env.potato) out.raises.push(p);
    else if (p.target_session === HOLDER) out.rings.push(p);
  }
  return out;
}

/** Seed one OPEN potato born `ageMs` in the past. */
function seed(potatoModule, ageMs) {
  const bornIso = new Date(Date.now() - ageMs).toISOString();
  const id = potatoModule.generatePotatoId();
  fs.writeFileSync(LEDGER, JSON.stringify({
    potatoes: {
      [id]: {
        potato_id: id,
        status: 'open',
        origin_queue_id: `window-test-${id}`,
        origin_surface: 'bottom-bar',
        holder: HOLDER,
        born_at: bornIso,
        updated_at: bornIso,
        chain: [{ holder: HOLDER, at: bornIso, via: 'birth' }],
        suspicion: null,
        closed_at: null,
        closed_by: null,
        closing_queue_id: null,
      },
    },
  }, null, 2));
  return id;
}

/** Write a queue archive containing one outbound FROM the holder at `whenMs`. */
function writeHolderOutbound(whenMs) {
  const d = new Date(whenMs);
  const f = path.join(TMP, `queue-archive-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`);
  fs.writeFileSync(f, JSON.stringify([{
    id: 'outbound-1',
    target_session: 'holler-somebody-else',
    // The holder walkied SOMEONE ELSE — not this thread. That still proves it's alive.
    message: JSON.stringify({ type: 'action', from: HOLDER, instruction: 'working on it' }),
    status: 'confirmed',
    created_at: d.toISOString(),
  }], null, 2));
  return f;
}

/** Run the real server.js heartbeat loop shape until `done()` or timeout. */
async function runLoop(potatoModule, ms, done) {
  const timer = setInterval(() => {
    let suspects;
    try { ({ suspects } = potatoModule.heartbeatPass()); } catch { return; }
    if (suspects && suspects.length) potatoModule.processSuspects(suspects).catch(() => {});
  }, 100);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100)); // eslint-disable-line no-await-in-loop
    if (done && done()) break;
  }
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 250)); // let in-flight writes settle
}

let potato;

before(async () => {
  await startStub();
  process.env.POTATO_LEDGER_FILE = LEDGER;
  process.env.POTATO_QUEUE_DIR = TMP;
  process.env.HOMESTEAD_URL = `http://127.0.0.1:${stubPort}`;
  process.env.POTATO_ROOSTER_SESSION = 'holler-stub-rooster';
  process.env.POTATO_HEARTBEAT_GRACE_MS = '0';
  process.env.POTATO_STRIKE_INTERVAL_MS = '150';
  process.env.POTATO_ACTIVITY_STALE_MS = '120000';
  process.env.POTATO_STANDDOWN_COOLDOWN_MS = '300';
  // Prod floors are 45s ring / 90s raise. Scaled to the test clock; the seeded
  // potato's simulated AGE is what crosses (or doesn't cross) them.
  process.env.POTATO_RING_FLOOR_MS = '3000';
  process.env.POTATO_RAISE_FLOOR_MS = '6000';
  potato = require('../lib/potato-tracker');
});

after(() => {
  if (stubServer) stubServer.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('THE REGRESSION: a young potato is never rung or raised inside one tool call', async () => {
  posts.length = 0;
  // Born 1s ago — under BOTH floors. This is the exact 10s-median bug: the holder
  // has barely had time to read the card, let alone answer it.
  const id = seed(potato, 1000);
  await runLoop(potato, 1500);

  const rec = potato.getPotato(id);
  assert.ok(!rec.suspicion || !rec.suspicion.rang_at, 'must NOT ring inside the ring floor');
  assert.ok(!rec.suspicion || !rec.suspicion.raised, 'must NOT raise inside the raise floor');
  const { rings, raises } = classify();
  assert.strictEqual(rings.length, 0, 'no ring walkie went out');
  assert.strictEqual(raises.length, 0, 'no raise reached Rooster');
});

test('NO-OUTBOUND GATE: a holder that has sent ANYTHING since birth is never escalated', async () => {
  posts.length = 0;
  // Old enough to clear BOTH floors — only the outbound gate can save it. This is
  // the "working but hasn't answered THIS card yet" steward: it walkied someone
  // else, which proves it is alive and composing, not dark.
  const id = seed(potato, 60000);
  writeHolderOutbound(Date.now() - 5000); // after birth, before now
  await runLoop(potato, 1500);

  const rec = potato.getPotato(id);
  assert.ok(!rec.suspicion || !rec.suspicion.raised, 'a demonstrably-sending holder is never raised');
  const { raises } = classify();
  assert.strictEqual(raises.length, 0, 'no raise reached Rooster');
  assert.strictEqual(rec.suspicion.last_standdown_reason.startsWith('outbound-since-birth'), true,
    'stood down for the right reason (outbound evidence), not by accident');

  fs.rmSync(writeHolderOutbound(Date.now() - 5000)); // clean up for later tests
});

test('SAFETY DIRECTION: a genuinely dark holder past the floors STILL rings and raises', async () => {
  posts.length = 0;
  // Zero outbound, no activity file, pane uncapturable (session doesn't exist), and
  // old enough to clear both floors. This is a REAL dropped Josh message. The whole
  // fix is worthless — worse than worthless — if this case goes quiet.
  const id = seed(potato, 120000);
  await runLoop(potato, 6000, () => {
    const r = potato.getPotato(id);
    return r && r.suspicion && r.suspicion.raised;
  });

  const rec = potato.getPotato(id);
  assert.ok(rec.suspicion.rang_at, 'genuinely stuck holder was RUNG');
  assert.strictEqual(rec.suspicion.raised, true, 'genuinely stuck holder was RAISED to Rooster');
  const vias = (rec.chain || []).map((c) => c.via);
  assert.ok(vias.indexOf('ring-holder') < vias.indexOf('raise-rooster'), 'ladder order preserved');

  const { rings, raises } = classify();
  assert.strictEqual(rings.length, 1, 'rung exactly once');
  assert.strictEqual(raises.length, 1, 'raised exactly once');
  assert.strictEqual(raises[0].target_session, 'holler-stub-rooster', 'raise went to Rooster');
});

test('DEAD-END GUARD: a floor-held potato re-surfaces once it ages past the floor', async () => {
  posts.length = 0;
  // Born just under the ring floor. The first pass marks it reported=true but holds
  // the ring — and `reported` is what stops re-flagging. Without the floor-held
  // re-surface branch this potato would be flagged once and then sit SILENT FOREVER
  // (rang_at is never stamped, so the rang-based re-surface can't fire either) —
  // a false negative that silences a real dropped message. It must escalate as it ages.
  const id = seed(potato, 2500); // < 3000ms ring floor, crosses it ~0.5s in
  await runLoop(potato, 7000, () => {
    const r = potato.getPotato(id);
    return r && r.suspicion && r.suspicion.raised;
  });

  const rec = potato.getPotato(id);
  assert.ok(rec.suspicion.rang_at, 'floor-held potato eventually RANG (did not dead-end)');
  assert.strictEqual(rec.suspicion.raised, true, 'floor-held potato eventually RAISED');
});

test('INVARIANT HELD: the corrections officer\'s own ring never counts as holder outbound', async () => {
  // A ring is the TRACKER's notification, not the holder's send. If it counted as
  // outbound evidence, a ring would excuse the very potato it's about — the same
  // trap the close path guards with the CORRECTIONS_OFFICER_FROM exclusion.
  const bornIso = new Date(Date.now() - 60000).toISOString();
  const f = path.join(TMP, 'queue.json');
  fs.writeFileSync(f, JSON.stringify([{
    id: 'ring-1',
    target_session: HOLDER,
    message: JSON.stringify({ type: 'action', from: potato.CORRECTIONS_OFFICER_FROM, instruction: 'ring' }),
    status: 'confirmed',
    created_at: new Date(Date.now() - 5000).toISOString(),
  }], null, 2));

  const res = potato.hasNoOutboundSinceBirth({ holder: HOLDER, born_at: bornIso });
  assert.strictEqual(res.noOutbound, true, 'officer ring is NOT holder outbound — escalation still permitted');
  fs.rmSync(f);
});

test('FAIL-OPEN: an unreadable queue file never silently excuses a stuck holder', async () => {
  // Safety direction: we suppress only on POSITIVE evidence of work. A torn or
  // unparsable queue file is not evidence, so escalation stays permitted.
  const f = path.join(TMP, 'queue.json');
  fs.writeFileSync(f, '{ this is not valid json');
  const res = potato.hasNoOutboundSinceBirth({
    holder: HOLDER,
    born_at: new Date(Date.now() - 60000).toISOString(),
  });
  assert.strictEqual(res.noOutbound, true, 'unreadable queue → fail OPEN (escalation allowed)');
  fs.rmSync(f);
});
