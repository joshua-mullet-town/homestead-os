'use strict';

// REGRESSION TEST — the escalation LADDER fires from the REAL heartbeat timer loop
// alone, with NO hand-driven steps.
//
// This is the test that stops the 2026-07-21 class of bug from recurring. The
// original isolated proof hand-called processSuspects TWICE, which masked a
// dead-end-state bug: once a potato was RUNG (suspicion.reported=true), the single
// 5s heartbeat re-fed it to processSuspects exactly ZERO more times, so it sat
// "rung, never raised" forever while its strike counter climbed without bound. The
// live prod ledger showed potato-...-ava9u8 at 45+ strikes, reported=true, still
// open, never raised. reported=true had become a TERMINAL state instead of a rung
// on the escalation ladder.
//
// The fix (heartbeatPass RE-SURFACE branch) re-pushes a rung-but-still-stuck potato
// back into suspects[] once ring-grace has elapsed, so processSuspects visits it a
// SECOND time and RAISES. This test asserts the full ladder —
//   born → detect (2 strikes) → RING → [ring-grace] → RE-SURFACE → RAISE
// — happens driven ONLY by the real setInterval loop that server.js runs, feeding
// exactly one heartbeatPass()→processSuspects(suspects) per tick. If the raise ever
// depended on a hand-driven double-call, this test would NOT pass, because it never
// hand-calls processSuspects.
//
// Hermetic: temp ledger, no real activity file, a holder session that does not
// exist in tmux (so paneReconfirmWorking returns captured:false → not working →
// proceeds to ring), and a local stub HTTP server standing in for :3005/api/queue
// that records every ring and raise. No dependency on the live server, Rooster, or
// any real steward session.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ── FAST TIMINGS — set BEFORE requiring the module (constants read at require) ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-ladder-'));
const LEDGER = path.join(TMP, 'potato-tracker.json');

// A holder that does NOT exist as a tmux session and has NO activity file:
//   - readHolderActivity: file absent → { working:false, fresh:false } → strikes advance.
//   - paneReconfirmWorking: tmux capture fails → { working:false, captured:false } → ring.
const HOLDER = 'holler-nonexistent-idle-holder-for-ladder-test';

// Stub /api/queue recorder — stand-in for the live Homestead server.
let stubServer;
let stubPort;
const posted = []; // every /api/queue POST body, parsed

function startStub() {
  return new Promise((resolve) => {
    stubServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { posted.push(JSON.parse(body)); } catch { posted.push({ _raw: body }); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, item: { id: `stub-${posted.length}` } }));
      });
    });
    stubServer.listen(0, '127.0.0.1', () => {
      stubPort = stubServer.address().port;
      resolve();
    });
  });
}

// Classify a recorded POST as a RING vs a RAISE by the envelope shape ringHolder /
// raiseRooster produce. Both go to /api/queue with message_override = a JSON string.
function classifyPosts() {
  const rings = [];
  const raises = [];
  for (const p of posted) {
    let env;
    try { env = JSON.parse(p.message_override); } catch { continue; }
    if (env && env.from === 'potato-corrections-officer') {
      // raiseRooster carries a `.potato` payload object; ringHolder does not.
      if (env.potato) raises.push({ post: p, env });
      else rings.push({ post: p, env });
    }
  }
  return { rings, raises };
}

let potato; // module under test

before(async () => {
  await startStub();

  process.env.POTATO_LEDGER_FILE = LEDGER;
  process.env.HOMESTEAD_URL = `http://127.0.0.1:${stubPort}`;
  process.env.POTATO_ROOSTER_SESSION = 'holler-stub-rooster';
  // Fast state machine: 1 heartbeat/250ms, strike interval 300ms (also doubles as
  // the ring-grace threshold the RE-SURFACE + raise branches compare against),
  // grace 0 so the seeded potato is a candidate immediately.
  process.env.POTATO_HEARTBEAT_MS = '250';
  process.env.POTATO_STRIKE_INTERVAL_MS = '300';
  process.env.POTATO_HEARTBEAT_GRACE_MS = '0';
  process.env.POTATO_ACTIVITY_STALE_MS = '120000';
  process.env.POTATO_STANDDOWN_COOLDOWN_MS = '4000';
  // Escalation floors (prod: 45s ring / 90s raise) scaled down to the test clock so
  // the ladder still exercises the REAL floor code path rather than bypassing it —
  // the seeded potato is born ~1s in the past, so these are crossed almost at once.
  process.env.POTATO_RING_FLOOR_MS = '200';
  process.env.POTATO_RAISE_FLOOR_MS = '400';
  // Point the no-outbound-since-birth scan at this test's empty tmp dir, NOT the
  // live fleet queue — the seeded holder must read as having sent nothing, and the
  // test must never depend on (or be perturbed by) real fleet traffic.
  process.env.POTATO_QUEUE_DIR = TMP;

  potato = require('../lib/potato-tracker');
});

after(() => {
  if (stubServer) stubServer.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('full escalation ladder fires from the real heartbeat timer alone (no hand-driven steps)', async () => {
  // Seed one OPEN potato whose holder is idle-with-rock. born_at pushed 1s into the
  // past so HEARTBEAT_GRACE (0) is trivially satisfied on the very first pass.
  const bornIso = new Date(Date.now() - 1000).toISOString();
  const id = potato.generatePotatoId();
  const ledger = {
    potatoes: {
      [id]: {
        potato_id: id,
        status: 'open',
        origin_queue_id: 'ladder-test-origin',
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
  };
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));

  // ── THE REAL LOOP — byte-for-byte the shape server.js runs (server.js:2169). ──
  // Exactly one heartbeatPass()→processSuspects(suspects) per tick. NO manual
  // double-call anywhere. This is the whole point of the regression test.
  const HEARTBEAT_MS = parseInt(process.env.POTATO_HEARTBEAT_MS, 10);
  let loopErr = null;
  const timer = setInterval(() => {
    let suspects;
    try {
      ({ suspects } = potato.heartbeatPass());
    } catch (e) {
      loopErr = e;
      return;
    }
    if (suspects && suspects.length) {
      potato.processSuspects(suspects).catch((e) => { loopErr = e; });
    }
  }, HEARTBEAT_MS);

  // Poll the ledger until the potato is RAISED (or we time out). We assert on the
  // durable ledger state the same way the live prod smoke reads it.
  const deadline = Date.now() + 8000;
  let rec;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (loopErr) break;
    rec = potato.getPotato(id);
    if (rec && rec.suspicion && rec.suspicion.raised) break;
  }
  /* eslint-enable no-await-in-loop */
  clearInterval(timer);
  // Give any in-flight processSuspects a beat to settle its ledger write.
  await new Promise((r) => setTimeout(r, 300));

  assert.strictEqual(loopErr, null, `heartbeat loop threw: ${loopErr && loopErr.stack}`);

  rec = potato.getPotato(id);
  assert.ok(rec, 'potato still exists in ledger');

  // ── LADDER ASSERTIONS ──
  // Rung: the holder was rung exactly the once (reported→rang_at stamped).
  assert.ok(rec.suspicion, 'suspicion state recorded');
  assert.ok(rec.suspicion.rang_at, 'RING rung — suspicion.rang_at stamped');

  // Raised: the terminal rung fired FROM THE TIMER. This is what the dead-end bug
  // prevented — reported=true short-circuited the re-feed and raised never became
  // true no matter how long the loop ran.
  assert.strictEqual(rec.suspicion.raised, true, 'RAISED — escalation reached Rooster');
  assert.ok(rec.suspicion.raised_at, 'raised_at stamped');

  // The chain records both hops in order: ring-holder then raise-rooster.
  const vias = (rec.chain || []).map((c) => c.via);
  assert.ok(vias.includes('ring-holder'), 'chain records the ring hop');
  assert.ok(vias.includes('raise-rooster'), 'chain records the raise hop');
  assert.ok(
    vias.indexOf('ring-holder') < vias.indexOf('raise-rooster'),
    'ring precedes raise in the chain (correct ladder order)',
  );

  // ── STUB-SIDE ASSERTIONS — the real HTTP walkies went out, exactly once each. ──
  const { rings, raises } = classifyPosts();
  assert.strictEqual(rings.length, 1, `holder rung exactly once (got ${rings.length})`);
  assert.strictEqual(raises.length, 1, `Rooster raised exactly once (got ${raises.length})`);

  // Ring targets the holder; raise targets Rooster and carries the full context.
  assert.strictEqual(rings[0].post.target_session, HOLDER, 'ring went to the holder');
  assert.strictEqual(raises[0].post.target_session, 'holler-stub-rooster', 'raise went to Rooster');
  assert.strictEqual(raises[0].env.potato.potato_id, id, 'raise carries the potato_id');
  assert.strictEqual(raises[0].env.potato.holder, HOLDER, 'raise carries the holder');
  assert.ok(Array.isArray(raises[0].env.potato.chain), 'raise carries the chain[] for point-to-source');
});

test('DEAD-END REGRESSION: strikes must not climb past the ring without a raise being recorded', async () => {
  // The precise failure the prod smoke caught: reported=true became terminal and the
  // strike counter climbed unbounded (45+) while raised stayed false. Here we let the
  // real loop run WELL PAST the point where a raise should have fired, then assert
  // that IF the holder was ever rung, a raise was also recorded. A rung-but-never-
  // raised potato after ample ring-grace is exactly the dead-end and must fail.
  const bornIso = new Date(Date.now() - 1000).toISOString();
  const id = potato.generatePotatoId();
  const ledger = potato.readLedger();
  ledger.potatoes[id] = {
    potato_id: id,
    status: 'open',
    origin_queue_id: 'ladder-test-deadend',
    origin_surface: 'bottom-bar',
    holder: HOLDER,
    born_at: bornIso,
    updated_at: bornIso,
    chain: [{ holder: HOLDER, at: bornIso, via: 'birth' }],
    suspicion: null,
    closed_at: null,
    closed_by: null,
    closing_queue_id: null,
  };
  potato.writeLedger(ledger);

  const HEARTBEAT_MS = parseInt(process.env.POTATO_HEARTBEAT_MS, 10);
  let loopErr = null;
  const timer = setInterval(() => {
    let suspects;
    try {
      ({ suspects } = potato.heartbeatPass());
    } catch (e) { loopErr = e; return; }
    if (suspects && suspects.length) {
      potato.processSuspects(suspects).catch((e) => { loopErr = e; });
    }
  }, HEARTBEAT_MS);

  // Run for a long stretch relative to strike interval (300ms) — many passes, plenty
  // of ring-grace windows. A dead-end would rack up strikes here without raising.
  await new Promise((r) => setTimeout(r, 5000));
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 300));

  assert.strictEqual(loopErr, null, `heartbeat loop threw: ${loopErr && loopErr.stack}`);

  const rec = potato.getPotato(id);
  assert.ok(rec && rec.suspicion, 'suspicion state exists after a long run');

  if (rec.suspicion.rang_at) {
    // Once rung, and given we ran far past ring-grace, a raise MUST have happened.
    assert.strictEqual(
      rec.suspicion.raised, true,
      'rung potato that ran well past ring-grace MUST have been raised — a rung-but-never-raised '
      + 'potato is the dead-end-state bug (reported=true short-circuited the re-feed)',
    );
  }
});
