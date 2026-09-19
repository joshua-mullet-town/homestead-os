#!/usr/bin/env node
// check-daily-scans.js — Track 2 daily scan watchdog logic.
// Invoked by check-daily-scans.sh (from Rooster's recurring job every 30m).
// Queries Firestore for active customers, checks scan state for today (ET),
// decides: stay quiet / dispatch walkie to Audit Ops / escalate to Joshua.

const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-write');

// Resolve external deps from the covered-bridge app (where they're installed).
const CB_MODULES = '<<REPLACE: your home dir, e.g. /Users/you>>/code/covered-bridge/node_modules';
const dotenv = require(path.join(CB_MODULES, 'dotenv'));
const admin = require(path.join(CB_MODULES, 'firebase-admin'));

dotenv.config({
  path: '<<REPLACE: your home dir, e.g. /Users/you>>/code/covered-bridge/.env.local',
});

const PROJECT_ROOT = process.cwd();
const WALKIE_QUEUE_FILE = path.join(
  process.env.HOME,
  '.homestead',
  'siswapts',
  'queue.json',
);
const AUDIT_OPS_SESSION = 'holler-venture--audit-ops';
const DISPATCH_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const STALE_PENDING_MS = 2 * 60 * 60 * 1000; // 2 hours
const ESCALATION_HOUR_ET = 8;
const DISPATCH_HOUR_ET = 0; // midnight ET

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[daily-scans-watchdog] ${new Date().toISOString()} ${msg}`);
}

function initAdmin() {
  if (admin.apps.length) return admin.firestore();

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(
    /\\n/g,
    '\n',
  );
  const projectId = process.env.FIREBASE_PROJECT_ID || 'covered-bridge-dev';

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin credentials missing (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)',
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  return admin.firestore();
}

// Current date in Eastern time, "YYYY-MM-DD" format.
function todayInET() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
}

// Current hour (0-23) in Eastern time.
function currentHourET() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(fmt.format(new Date()), 10);
}

async function loadActiveCustomers(db) {
  const snap = await db
    .collection('leads')
    .where('subscriptionStatus', '==', 'active')
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadTodaysScans(db, scanDate) {
  const snap = await db
    .collection('scans')
    .where('scanDate', '==', scanDate)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function bucketCustomers(customers, scans) {
  const byCustomer = new Map();
  for (const s of scans) {
    byCustomer.set(s.leadId, s);
  }

  const now = Date.now();
  const complete = [];
  const inProgress = [];
  const stale = [];
  const errored = [];
  const missing = [];

  for (const c of customers) {
    const scan = byCustomer.get(c.id);
    if (!scan) {
      missing.push(c);
      continue;
    }
    if (scan.status === 'completed') {
      complete.push(c);
    } else if (scan.status === 'error') {
      errored.push(c);
    } else if (scan.status === 'pending') {
      const startedAt =
        scan.startedAt && scan.startedAt.toMillis
          ? scan.startedAt.toMillis()
          : 0;
      if (now - startedAt > STALE_PENDING_MS) {
        stale.push(c);
      } else {
        inProgress.push(c);
      }
    } else {
      missing.push(c);
    }
  }

  return { complete, inProgress, stale, errored, missing };
}

async function loadDispatchState(db) {
  const doc = await db.collection('config').doc('dailyScans').get();
  if (!doc.exists) return {};
  return doc.data();
}

async function saveDispatchState(db, data) {
  await db
    .collection('config')
    .doc('dailyScans')
    .set(data, { merge: true });
}

async function escalationAlreadySent(db, scanDate) {
  const snap = await db
    .collection('escalations')
    .where('type', '==', 'daily-scans-missed')
    .where('scanDate', '==', scanDate)
    .limit(1)
    .get();
  return !snap.empty;
}

// Internal Ops /api/ops/escalate writes its own escalations/{id} doc,
// so we don't do a local recordEscalation. The escalationAlreadySent()
// dedup check still works because both paths write to the same collection
// with type=daily-scans-missed.


function dispatchWalkie(leadIds, scanDate) {
  // Append to the homestead walkie-talkie queue
  const queue = JSON.parse(fs.readFileSync(WALKIE_QUEUE_FILE, 'utf-8'));
  const hasPending = queue.some(
    (q) =>
      q.target_session === AUDIT_OPS_SESSION &&
      q.status === 'pending' &&
      typeof q.message === 'string' &&
      q.message.includes('enact_daily_scans'),
  );
  if (hasPending) {
    log('Dispatch walkie already pending in queue, skipping');
    return false;
  }

  queue.push({
    id: Date.now() + '-daily-scans-dispatch',
    target_session: AUDIT_OPS_SESSION,
    type: 'action',
    message: JSON.stringify({
      type: 'action',
      trigger: 'enact_daily_scans',
      from: 'venture-daily-scans-watchdog',
      scanDate,
      leadIds,
      instruction:
        'Daily scan dispatch. Spawn a sub-worker per leadId. Each worker creates a scans/{scanId} doc with status=pending, runs the audit + diff, and writes the result. Do not block on long-running workers - return immediately after spawning.',
    }),
    status: 'pending',
    created_at: new Date().toISOString(),
    attempts: 0,
  });
  writeFileAtomicSync(WALKIE_QUEUE_FILE, JSON.stringify(queue, null, 2)); // atomic (torn-read fix 2026-08-25)
  return true;
}

async function sendEscalationSMS(scanDate, needAttention) {
  // Internal Ops owns the Twilio wrapper. We POST to their /api/ops/escalate
  // endpoint on the covered-bridge Next.js app and they proxy to Twilio.
  // Contract locked with Internal Ops 2026-04-10.
  const missingCount = needAttention.length;
  const message =
    `Covered Bridge: daily scans incomplete. ${missingCount} customer(s) ` +
    `missing or errored as of 8am ET on ${scanDate}. Check the Rooster UI.`;

  const endpoint =
    process.env.OPS_ESCALATE_URL || 'http://localhost:3002/api/ops/escalate';
  const secret = process.env.OPS_ESCALATE_SECRET || '';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Secret': secret,
      },
      body: JSON.stringify({
        type: 'daily-scans-missed',
        message,
        scanDate,
        missingCount,
        customerIds: needAttention.map((c) => c.id),
        severity: 'warn',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const result = await res.json().catch(() => ({}));
    log(
      `Escalation POSTed to ${endpoint}. escalationId=${result.escalationId || '?'} smsSent=${result.smsSent || '?'}`,
    );
  } catch (err) {
    log(`ESCALATION FAILED: ${err.message}. Intended message: "${message}"`);
    throw err;
  }
}

async function main() {
  const db = initAdmin();
  const scanDate = todayInET();
  const hourET = currentHourET();

  log(`Starting run. scanDate=${scanDate} hourET=${hourET}`);

  const customers = await loadActiveCustomers(db);
  if (customers.length === 0) {
    log('No active customers. Exiting quiet.');
    return;
  }
  log(`Active customers: ${customers.length}`);

  const scans = await loadTodaysScans(db, scanDate);
  log(`Scans for ${scanDate}: ${scans.length}`);

  const buckets = bucketCustomers(customers, scans);
  log(
    `Buckets: complete=${buckets.complete.length} inProgress=${buckets.inProgress.length} stale=${buckets.stale.length} errored=${buckets.errored.length} missing=${buckets.missing.length}`,
  );

  const needAttention = [...buckets.stale, ...buckets.errored, ...buckets.missing];

  if (needAttention.length === 0) {
    log('All scans accounted for. Exiting quiet.');
    return;
  }

  // Not yet midnight ET: nothing to do until day rolls over.
  if (hourET < DISPATCH_HOUR_ET) {
    log('Before midnight ET, nothing to dispatch yet. Exiting.');
    return;
  }

  // Dispatch path
  if (buckets.inProgress.length === 0) {
    const state = await loadDispatchState(db);
    const lastDispatchAt =
      state && state.lastDispatchAt && state.lastDispatchAt.toMillis
        ? state.lastDispatchAt.toMillis()
        : 0;
    const sinceLast = Date.now() - lastDispatchAt;
    if (state.lastDispatchScanDate === scanDate && sinceLast < DISPATCH_COOLDOWN_MS) {
      log(
        `Dispatch cooldown: last dispatch ${Math.round(sinceLast / 1000)}s ago for ${scanDate}, skipping dispatch this cycle.`,
      );
    } else {
      const dispatched = dispatchWalkie(
        needAttention.map((c) => c.id),
        scanDate,
      );
      if (dispatched) {
        log(`Dispatched walkie to Audit Ops for ${needAttention.length} customer(s).`);
        await saveDispatchState(db, {
          lastDispatchAt: admin.firestore.FieldValue.serverTimestamp(),
          lastDispatchScanDate: scanDate,
        });
      }
    }
  } else {
    log(`${buckets.inProgress.length} scan(s) in progress, not dispatching.`);
  }

  // Escalation path
  if (hourET >= ESCALATION_HOUR_ET) {
    const alreadySent = await escalationAlreadySent(db, scanDate);
    if (alreadySent) {
      log(`Escalation already sent today for ${scanDate}, not re-sending.`);
    } else {
      try {
        await sendEscalationSMS(scanDate, needAttention);
        log(`Escalation POSTed for ${scanDate}.`);
      } catch (err) {
        log(
          `Escalation path failed but continuing: ${err.message}. Will retry on next cycle.`,
        );
      }
    }
  }
}

main()
  .then(() => {
    log('Run complete.');
    process.exit(0);
  })
  .catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exit(1);
  });
