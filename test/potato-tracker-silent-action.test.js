/**
 * REGRESSION: a card asking for SILENT execution must be clearable BY DOING THE WORK.
 *
 * ═══ THE LIVE DEFECT (GiveGrove, 2026-09-18) ═══
 * Josh's card 537b010ecf8a: "Press approve and I'll do it silently — no comment, just
 * the approval." GiveGrove approved PR #1639 with an empty body — exactly as asked —
 * and deliberately sent no card. recordCloseFromQueueItem() closes ONLY on an
 * outbound, so correct compliance produced zero outbounds and the potato could not
 * close. The officer rang it, and the ring extracted exactly the message Josh had said
 * not to send. Obeying was unfalsifiable innocence; the only way to clear the potato
 * was to disobey.
 *
 * Real timeline (GitHub's submitted_at + queue-archive-2026-09-18.json), reused below
 * as the fixture clock so this asserts against production timing, not convenient timing:
 *   02:08:47.899Z birth → 02:09:04Z approval done (17s) → 02:11:51.929Z ring (2m47s).
 *
 * ═══ 🚨 THE CONTROL THAT MAKES THIS TEST MEAN ANYTHING ═══
 * `activities[]` is a 20-ENTRY RING BUFFER, not a time window
 * (hooks/tool_activity.py: `activity["activities"][-20:]`). Measured live 2026-09-18,
 * buffer spans were 74s / 129s / 149s — ALL SHORTER THAN THE 180s RING FLOOR. So on
 * the real case the evidence of the approval was ALREADY EVICTED when the ring fired.
 *
 * A test that writes the tool calls and immediately checks for them passes on data
 * that WOULD NOT EXIST in production — it can only confirm. So the decisive test here
 * (`evicted buffer`) EVICTS the evidence before the ring, exactly as production does,
 * and still requires the potato to be spared. That is what the accumulate-every-5s
 * design exists for, and it is the test that fails against a naive ring-time read.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The live case's real clock.
const BORN = '2026-09-18T02:08:47.899Z';
const BORN_MS = Date.parse(BORN);
const WORK_MS = Date.parse('2026-09-18T02:09:04.000Z');   // approval submitted, +17s
const RING_MS = Date.parse('2026-09-18T02:11:51.929Z');   // ring fired, +2m47s

const HOLDER = 'holler-silent-fixture';
const ACTIVITY_FILE = `/tmp/claude-session-${HOLDER}-activity.json`;

const PRIOR = { ledger: process.env.POTATO_LEDGER_FILE };
function restoreEnv() {
  if (PRIOR.ledger === undefined) delete process.env.POTATO_LEDGER_FILE;
  else process.env.POTATO_LEDGER_FILE = PRIOR.ledger;
  delete require.cache[require.resolve('../lib/potato-tracker.js')];
  try { fs.unlinkSync(ACTIVITY_FILE); } catch {}
}
test.afterEach(restoreEnv);
process.on('exit', restoreEnv);

function load() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-silent-'));
  process.env.POTATO_LEDGER_FILE = path.join(dir, 'potato-tracker.json');
  const p = require.resolve('../lib/potato-tracker.js');
  delete require.cache[p];
  return require(p);
}

// One COMPLETED tool call, as the activity writer records it.
const toolCall = (atMs, tool = 'Bash', id = `t-${atMs}-${Math.random()}`) => ({
  id, tool, phase: 'complete',
  message: 'Done',
  timestamp: new Date(atMs - 500).toISOString(),
  completed_at: new Date(atMs).toISOString(),
});

function writeActivity(activities, { is_working = false, updatedMs = RING_MS } = {}) {
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify({
    tmux_session: HOLDER, is_working, current_tool: null,
    activities, updated_at: new Date(updatedMs).toISOString(),
  }));
}

function openPotato(potato) {
  const rec = {
    potato_id: 'potato-silent-test', status: 'open', holder: HOLDER,
    origin_surface: 'card-reply', born_at: BORN, updated_at: BORN,
    chain: [], suspicion: null,
  };
  potato.writeLedger({ potatoes: { [rec.potato_id]: rec } });
  return rec;
}

// ─────────────────────────────────────────────────────────────────────────────

test('THE LIVE CASE, with the buffer EVICTED before the ring (production timing)', () => {
  const potato = load();
  const rec = openPotato(potato);

  // 1. The silent approval happens at +17s and IS in the buffer at that moment.
  writeActivity([toolCall(WORK_MS, 'Bash'), toolCall(WORK_MS + 900, 'Bash')],
    { updatedMs: WORK_MS + 900 });

  // 2. The heartbeat samples it while it still exists (this is the fix).
  const seen = potato.accumulateSilentWork(rec, WORK_MS + 2000);
  assert.strictEqual(seen.toolCount, 2, 'heartbeat should capture the two completed calls');

  // 3. ⭐ THE BUFFER NOW EVICTS the evidence — 20 newer entries from other work,
  //    exactly as a live steward's ring buffer does inside 74-149s. The approval is
  //    GONE from the file by the time the ring would fire.
  const evicted = [];
  for (let i = 0; i < 20; i++) evicted.push(toolCall(WORK_MS + 5000 + i * 1000, 'Read'));
  writeActivity(evicted.slice(-20), { updatedMs: RING_MS });
  const onDisk = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf-8')).activities;
  assert.ok(!onDisk.some((a) => Date.parse(a.completed_at) === WORK_MS),
    'CONTROL: the approval must be evicted, or this test proves nothing');

  // 4. At RING TIME the accumulator still knows, because it PERSISTED the count.
  const atRing = potato.accumulateSilentWork(rec, RING_MS);
  assert.ok(atRing.hasWork,
    'holder that silently did the work must still read as worked AFTER eviction');

  // 5. End to end: the potato must NOT be rung.
  const res = potato.heartbeatPass(RING_MS);
  assert.ok(potato.getPotato(rec.potato_id).work.tools >= 2,
    'ledger must carry the durable work cursor');
  assert.strictEqual(res.suspects.filter((s) => s.potato_id === rec.potato_id).length, 0,
    'a holder that completed the silently-requested work must not become a suspect');
});

test('a naive ring-time read would MISS this case (why the accumulator exists)', () => {
  const potato = load();
  const rec = openPotato(potato);
  // Same eviction, but NO prior sampling — i.e. only looking at ring time.
  const evicted = [];
  for (let i = 0; i < 20; i++) evicted.push(toolCall(WORK_MS + 5000 + i * 1000, 'Read'));
  writeActivity(evicted, { updatedMs: RING_MS });
  // Fresh record with no accumulated cursor: the +17s approval is unfindable.
  const fresh = { ...rec, work: undefined };
  const seen = potato.accumulateSilentWork(fresh, RING_MS);
  assert.ok(!seen.sample.includes('Bash'),
    'the evicted approval is genuinely unrecoverable from the file alone');
});

test('a GENUINELY IDLE holder is still rung (the guarantee must not weaken)', () => {
  const potato = load();
  const rec = openPotato(potato);
  // Holder did NOTHING since birth: only pre-birth work, plus thinking/response noise.
  writeActivity([
    toolCall(BORN_MS - 60000, 'Bash'),                       // before Josh's message
    { id: 'th', tool: 'thinking', phase: 'complete', message: 'Done thinking',
      timestamp: new Date(BORN_MS + 1000).toISOString(),
      completed_at: new Date(BORN_MS + 2000).toISOString() },
    { id: 'rs', tool: 'response', phase: 'complete', message: 'talked',
      timestamp: new Date(BORN_MS + 3000).toISOString(),
      completed_at: new Date(BORN_MS + 4000).toISOString() },
  ], { updatedMs: RING_MS });

  const seen = potato.accumulateSilentWork(rec, RING_MS);
  assert.strictEqual(seen.toolCount, 0, 'pre-birth work + thinking/response are NOT evidence');
  assert.ok(!seen.hasWork, 'idle holder must not be excused');

  // Two strikes apart → it MUST still surface as a suspect.
  potato.heartbeatPass(RING_MS);
  const res = potato.heartbeatPass(RING_MS + 10000);
  assert.strictEqual(res.suspects.filter((s) => s.potato_id === rec.potato_id).length, 1,
    'a genuinely idle holder must still be flagged');
});

test('a STARTED-but-unfinished tool call is not evidence (a hung holder looks like that)', () => {
  const potato = load();
  const rec = openPotato(potato);
  writeActivity([
    { id: 'a', tool: 'Bash', phase: 'start', message: 'running',
      timestamp: new Date(BORN_MS + 1000).toISOString() },
    { id: 'b', tool: 'Bash', phase: 'start', message: 'running',
      timestamp: new Date(BORN_MS + 2000).toISOString() },
  ], { updatedMs: RING_MS });
  assert.ok(!potato.accumulateSilentWork(rec, RING_MS).hasWork,
    'unfinished calls must never excuse a potato');
});

test('the accumulator is IDEMPOTENT — re-sampling a lingering buffer cannot inflate it', () => {
  const potato = load();
  const rec = openPotato(potato);
  writeActivity([toolCall(WORK_MS, 'Bash'), toolCall(WORK_MS + 900, 'Bash')],
    { updatedMs: WORK_MS + 900 });
  // The same two entries sit in the buffer across many 5s heartbeat passes.
  for (let i = 0; i < 10; i++) potato.accumulateSilentWork(rec, WORK_MS + 3000 + i * 5000);
  assert.strictEqual(rec.work.tools, 2,
    'repeated sampling of the same entries must count them once, not 20 times');
});

test('FAILS TOWARD ESCALATING on a missing / torn activity file', () => {
  const potato = load();
  const rec = openPotato(potato);
  try { fs.unlinkSync(ACTIVITY_FILE); } catch {}
  assert.ok(!potato.accumulateSilentWork(rec, RING_MS).hasWork, 'missing file → no excuse');
  fs.writeFileSync(ACTIVITY_FILE, '{not json');
  assert.ok(!potato.accumulateSilentWork(rec, RING_MS).hasWork, 'torn file → no excuse');
});

test('work from the FUTURE cannot excuse a potato (backtest integrity)', () => {
  const potato = load();
  const rec = openPotato(potato);
  writeActivity([toolCall(RING_MS + 600000, 'Bash'), toolCall(RING_MS + 601000, 'Bash')],
    { updatedMs: RING_MS });
  assert.ok(!potato.accumulateSilentWork(rec, RING_MS).hasWork,
    'entries after nowMs must be ignored, or every historical replay self-confirms');
});

// The ring's own body. `potato-corrections-officer` is a STATIC IDENTITY, not a tmux
// session (verified 2026-09-18: `tmux has-session` fails, yet POST /api/queue returns
// 200 and queues the item pending forever — an undeliverable reply with no error).
// So the old "say so and I'll raise it" told the holder to do something that could
// not work. Asserted on the RENDERED INSTRUCTION, not the function source: the source
// contains a comment quoting the old wording, which would make a toString() check
// pass or fail for the wrong reason.
test('the ring no longer instructs a reply to a non-session (dead-end fix)', async () => {
  const potato = load();
  const rec = { potato_id: 'p', holder: HOLDER, origin_surface: 'card-reply', born_at: BORN };
  let sent = null;
  const http = require('http');
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      sent = JSON.parse(JSON.parse(b).message_override).instruction;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ item: { id: 'q1' } }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  process.env.HOMESTEAD_URL = `http://127.0.0.1:${srv.address().port}`;
  delete require.cache[require.resolve('../lib/potato-tracker.js')];
  const fresh = require('../lib/potato-tracker.js');
  await fresh.ringHolder(rec);
  await new Promise((r) => srv.close(r));
  delete process.env.HOMESTEAD_URL;

  assert.ok(sent, 'ring should have posted a body');
  assert.ok(!/say so and I'll raise it/.test(sent),
    'must not tell the holder to reply to a non-session');
  assert.ok(sent.includes('holler-rooster'),
    'must name Rooster — a REAL session — as the genuinely-stuck fallback');
  assert.ok(/silent/i.test(sent),
    'must tell a silently-instructed holder that work alone clears it');
});
