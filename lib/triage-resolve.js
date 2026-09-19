// Triage resolve primitive — implements contract §2 of
// ~/.homestead/stewards/homestead/library/platform/presenter/triage-dispatch-contract.md
//
// Atomic relay+dismiss for a single triage_session. Idempotent on triage_session
// (stash kept ≥24h). Pinned cards relay but never dismiss.
//
// Walkies are written through queueDispatcher.enqueue with type:"feedback"
// (NOT type:"action") because relays are answers, not directives — senders
// roger-and-file, not roger-and-act.

const { join } = require('path');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');

const presenterQueue = require('./presenter-queue');
const queueDispatcher = require('./queue-dispatcher');

const STASH_FILE = join(process.cwd(), 'data', 'triage-resolve-stash.json');
const STASH_TTL_MS = 24 * 60 * 60 * 1000; // contract §2: ≥24h

function loadStash() {
  try {
    if (!existsSync(STASH_FILE)) return {};
    return JSON.parse(readFileSync(STASH_FILE, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function saveStash(stash) {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(STASH_FILE, JSON.stringify(stash, null, 2));
  } catch (err) {
    console.error('[TriageResolve] Failed to save stash:', err.message);
  }
}

function pruneStash(stash) {
  const cutoff = Date.now() - STASH_TTL_MS;
  let changed = false;
  for (const [key, entry] of Object.entries(stash)) {
    if (!entry || !entry.completed_at || entry.completed_at < cutoff) {
      delete stash[key];
      changed = true;
    }
  }
  return changed;
}

// Build the relay envelope a sender will receive. Verbatim-tone-preservation:
// joshua_response and relay_message_per_sender pass through unedited.
function buildRelayEnvelope({ triage_session, topic, group_other_sources, joshua_response, relay_message_per_sender }) {
  return {
    type: 'feedback',
    source: 'triage-relay',
    triage_session,
    topic,
    other_sources_in_group: group_other_sources,
    relay_message: relay_message_per_sender,
    joshua_response,
  };
}

/**
 * Resolve a triage_session.
 *
 * payload:
 *   {
 *     triage_session: string,
 *     joshua_response: string,
 *     groups: [{ topic, card_ids: [], relay_message_per_sender }],
 *     culled: [{ card_id, reason }]      // informational only
 *   }
 *
 * Returns:
 *   {
 *     triage_session,
 *     idempotent_replay: boolean,        // true if this was a duplicate call
 *     relays: [{ card_id, target_session, queued: boolean, error?: string }],
 *     dismissed: [card_id],
 *     pinned_relayed_not_dismissed: [card_id],
 *     not_found: [card_id],
 *     atomic_failures: [{ card_id, reason }]   // contract §2 atomicity
 *   }
 */
// ASYNC (event-loop wedge fix): queueDispatcher.enqueue() is now async, and the
// atomicity contract (§2) requires the relay walkie to actually COMMIT before we
// dismiss the card — so we must await it. resolveTriage is therefore async; its
// one in-process caller (server.js /api/presenter/triage-resolve) awaits it.
async function resolveTriage(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload must be an object');
  }
  const { triage_session, joshua_response, groups, culled } = payload;
  if (!triage_session || typeof triage_session !== 'string') {
    throw new Error('triage_session is required');
  }
  if (typeof joshua_response !== 'string') {
    throw new Error('joshua_response must be a string');
  }
  if (!Array.isArray(groups)) {
    throw new Error('groups must be an array');
  }

  // Idempotency check (contract §2): repeated calls with same triage_session
  // are no-ops after first success.
  const stash = loadStash();
  pruneStash(stash);
  if (stash[triage_session]) {
    return { ...stash[triage_session].result, idempotent_replay: true };
  }

  const queue = presenterQueue.getQueue();

  const relays = [];
  const dismissed = [];
  const pinned_relayed_not_dismissed = [];
  const not_found = [];
  const atomic_failures = [];

  for (const group of groups) {
    if (!group || !Array.isArray(group.card_ids)) continue;
    const topic = group.topic || '';
    const relay_message_per_sender = group.relay_message_per_sender || '';

    // Compute "other senders in this group" so each sender's relay can list
    // who else got Joshua's same answer (skill-side relay text recommendation).
    const sourcesInGroup = [];
    for (const cid of group.card_ids) {
      const it = queue.find(i => i.id === cid);
      if (it) sourcesInGroup.push(it.session_id);
    }

    for (const card_id of group.card_ids) {
      const item = queue.find(i => i.id === card_id);
      if (!item) {
        not_found.push(card_id);
        continue;
      }
      const target = item.callback_session || item.session_id;
      const otherSources = sourcesInGroup.filter(s => s !== item.session_id);

      const envelope = buildRelayEnvelope({
        triage_session,
        topic,
        group_other_sources: otherSources,
        joshua_response,                          // verbatim
        relay_message_per_sender,                 // verbatim
      });

      // ---- Atomicity (contract §2): relay + dismiss for one card must
      // both succeed or both fail. We enqueue the walkie first; if that
      // succeeds, only then dismiss. If walkie throws, surface as failure.
      let relayQueued = false;
      let relayError = null;
      try {
        await queueDispatcher.enqueue(target, JSON.stringify(envelope));
        relayQueued = true;
      } catch (err) {
        relayError = err.message || String(err);
      }

      relays.push({ card_id, target_session: target, queued: relayQueued, error: relayError || undefined });

      if (!relayQueued) {
        atomic_failures.push({ card_id, reason: 'relay_walkie_failed: ' + (relayError || 'unknown') });
        continue; // do NOT dismiss when relay failed
      }

      // Pinned-card carve-out (contract §2 / §5): relay fires, dismiss does NOT.
      if (item.pinned) {
        pinned_relayed_not_dismissed.push(card_id);
        continue;
      }

      try {
        const r = presenterQueue.dismissItem(card_id);
        if (r && r.dismissed) {
          dismissed.push(card_id);
        } else {
          // Relay queued but dismiss returned null (race — card already gone).
          // Not an atomic failure: the relay is still informational and the
          // card is already off Joshua's queue. Treat as success.
          dismissed.push(card_id);
        }
      } catch (err) {
        // Relay went out, dismiss threw — surface as atomic failure per
        // contract §2 ("silent partial state is a critical failure mode").
        atomic_failures.push({
          card_id,
          reason: 'dismiss_failed_after_relay: ' + (err.message || String(err)),
        });
      }
    }
  }

  // culled[] is informational only (contract §2 explicit).
  const culledCount = Array.isArray(culled) ? culled.length : 0;

  const result = {
    triage_session,
    idempotent_replay: false,
    relays,
    dismissed,
    pinned_relayed_not_dismissed,
    not_found,
    atomic_failures,
    culled_count: culledCount,
  };

  // Stash result for ≥24h idempotency.
  stash[triage_session] = {
    completed_at: Date.now(),
    result,
  };
  saveStash(stash);

  return result;
}

module.exports = {
  resolveTriage,
};
