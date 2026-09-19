// Seam test for the REAL production path:
//   present_to_user (MCP tool) → HTTP POST /api/presenter/queue → tool result.
//
// The addItem() unit tests prove the guard fires; THIS test proves the MCP
// tool surfaces the rejection LOUDLY instead of swallowing the 400 and
// reporting success:true (the silent-card-loss bug the Auditor caught).
//
// We mock global.fetch so nothing touches the real server on :3005. present.js
// is ESM (mcp-servers/presenter is "type":"module"), so this test is .mjs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { presentTool } from '../mcp-servers/presenter/tools/present.js';

const QUEUE_URL = 'http://localhost:3005/api/presenter/queue';
let origFetch;

beforeEach(() => { origFetch = global.fetch; });
afterEach(() => { global.fetch = origFetch; });

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const baseCard = {
  title: 'T',
  message: 'M',
  buttons: ['OK'],
};

test('naked-link 400 from server → tool returns success:false, rejected, code, error', async () => {
  let hitFallback = false;
  global.fetch = async (url) => {
    if (String(url) === QUEUE_URL) {
      return jsonResponse(400, {
        error: 'Your presenter card was rejected because it contains a bare/naked link with no human-readable title: https://x.com',
        code: 'NAKED_CARD_LINK',
        reason: 'naked_url',
        naked_url: 'https://x.com',
      });
    }
    // Any other fetch (Electron /health fallback) — record and fail it so we
    // can assert the tool did NOT fall through to the unguarded fallback.
    hitFallback = true;
    return jsonResponse(500, {});
  };

  const result = await presentTool.execute({ ...baseCard, message: 'https://x.com' });
  assert.strictEqual(result.success, false, 'must NOT report success on a rejected card');
  assert.strictEqual(result.rejected, true);
  assert.strictEqual(result.status, 400);
  assert.strictEqual(result.code, 'NAKED_CARD_LINK');
  assert.match(result.error, /naked link/i);
  assert.strictEqual(hitFallback, false, 'a real 400 rejection must NOT fall through to the Electron fallback');
});

test('invalid-session 400 also surfaces as success:false (guard parity)', async () => {
  global.fetch = async (url) => {
    if (String(url) === QUEUE_URL) {
      return jsonResponse(400, { error: 'bad session', code: 'INVALID_SESSION_ID' });
    }
    return jsonResponse(500, {});
  };
  const result = await presentTool.execute({ ...baseCard });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, 'INVALID_SESSION_ID');
});

test('happy path 200 → success:true, queued (labeled/no-link card accepted)', async () => {
  global.fetch = async (url) => {
    if (String(url) === QUEUE_URL) {
      return jsonResponse(200, { success: true, id: 'abc123', item: { id: 'abc123' }, queued: true });
    }
    // pollDeliveryStatus hits /api/presenter/status/<id>. Report fully
    // delivered so it resolves after the first 1s tick instead of looping 8×.
    return jsonResponse(200, { fully_delivered: true, acks: { electron: 1 }, elapsed_ms: 10 });
  };
  const result = await presentTool.execute({ ...baseCard, message: 'no link here' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.queued, true);
});
