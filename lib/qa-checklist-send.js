#!/usr/bin/env node
/**
 * Send a QA test checklist to Josh's tray.
 *
 * Usage:
 *   node lib/qa-checklist-send.js <file.json>
 *   node lib/qa-checklist-send.js -            # read JSON from stdin
 *   node lib/qa-checklist-send.js --show <id>  # print what Josh currently sees
 *
 * The server REJECTS a bad checklist at send time. This wrapper surfaces the
 * rejection loudly and exits non-zero, so a steward cannot mistake "refused"
 * for "sent".
 */

const { readFileSync } = require('fs');

const HOSTS = [
  'http://localhost:3005',
  'http://joshuas-macbook-air.tail84bb3b.ts.net:3005',
];

async function call(path, options) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      return await fetch(`${host}/api/qa-checklists${path}`, options);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not reach the checklist store on any host: ${lastErr && lastErr.message}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--show') {
    const res = await call(`?id=${encodeURIComponent(args[1] || '')}`, {});
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (!args[0]) {
    console.error('Usage: qa-checklist-send.js <file.json | ->');
    process.exit(2);
  }

  const raw = args[0] === '-' ? readFileSync(0, 'utf-8') : readFileSync(args[0], 'utf-8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`That file isn't valid JSON: ${err.message}`);
    process.exit(2);
  }

  const res = await call('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();

  if (res.status === 422 && body.rejected) {
    console.error('\n  ✗ CHECKLIST REJECTED — Josh has NOT seen this.\n');
    for (const p of body.problems || []) console.error(`    • ${p}`);
    console.error('\n  Fix these and resend. This is a hard gate, not a flake —');
    console.error('  retrying the same payload will fail the same way.\n');
    process.exit(1);
  }

  if (!res.ok || !body.success) {
    console.error(`Send failed (${res.status}): ${body.error || 'unknown error'}`);
    process.exit(1);
  }

  console.log(`  ✓ Sent to Josh's tray — "${payload.title}" (version ${body.version})`);
  console.log(`    id: ${body.id}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
