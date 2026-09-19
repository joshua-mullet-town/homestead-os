/**
 * Presenter Queue Manager
 *
 * Server-side source of truth for presenter items.
 * Persists to disk, broadcasts via Socket.IO, writes feedback to walkie-talkie queue.
 * Tracks delivery acknowledgments from connected clients (Electron, mobile).
 */

const { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } = require('fs');
const { writeFileAtomicSync } = require('./atomic-write');
const { join } = require('path');
const crypto = require('crypto');
const os = require('os');
const { scanCardForLink, buildNakedLinkRejectionMessage, buildLazyLabelRejectionMessage } = require('./card-link-scanner');
const cardLinksStore = require('./card-links-store');
const forcedReminderGate = require('./forced-reminder-gate');

// Potato tracker — drop-detection ledger. Loaded defensively so a tracker fault
// can never break card delivery or feedback routing. Here it only BIRTHS a potato
// when Josh replies to a card (feedback path, source='presenter'). Closing is NOT
// driven by the card path anymore — the pure-code model closes at the enqueue
// chokepoint on the holder's next outbound. Never gates or alters a card.
let potatoTracker = null;
try {
  potatoTracker = require('./potato-tracker.js');
} catch (e) {
  console.error('[PresenterQueue] potato-tracker unavailable (non-fatal):', e.message);
  potatoTracker = null;
}

const DATA_DIR = join(process.cwd(), 'data');
const QUEUE_FILE = join(DATA_DIR, 'presenter-queue.json');
const HISTORY_DIR = join(DATA_DIR, 'presenter-history');
const SISWAPTS_QUEUE = join(os.homedir(), '.homestead', 'queue.json');
const SERVICE_ACCOUNT_PATH = join(os.homedir(), '.homestead', 'firebase-service-account.json');
const TOKEN_FILE = '/tmp/homestead-fcm-tokens.json';
const STEWARDS_DIR = join(os.homedir(), '.homestead', 'stewards');

// Special-case literal session_ids permitted alongside the holler-<top> prefix
// allowlist. These are non-tmux callers Joshua has reviewed and approved.
// job-scheduler: backstop card dispatcher in lib/job-scheduler.js. Future
// cleanup may rename it to fit the holler- pattern, but that touches more
// surfaces and Joshua hasn't reviewed those yet.
const SPECIAL_CASE_SESSION_IDS = new Set(['job-scheduler']);

// Read top-level steward names from ~/.homestead/stewards/. Filenames like
// threads.json/timers.json are filtered out — only directories represent
// stewards. Computed fresh on each call so allowlist tracks the live fleet
// (no restart required when a new steward is added).
function getStewardAllowlist() {
  try {
    return readdirSync(STEWARDS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

// Validate session_id against the allowlist. Returns { ok: true } or
// { ok: false, reason, sentValue, allowedPrefixes, allowedLiterals }.
// Reason codes: 'missing' | 'unknown_literal' | 'invalid_prefix'.
function validateSessionId(session_id) {
  const stewards = getStewardAllowlist();
  const allowedPrefixes = stewards.map(s => `holler-${s}`);
  const allowedLiterals = Array.from(SPECIAL_CASE_SESSION_IDS);

  if (session_id === undefined || session_id === null || session_id === '') {
    return { ok: false, reason: 'missing', sentValue: session_id, allowedPrefixes, allowedLiterals };
  }
  if (typeof session_id !== 'string') {
    return { ok: false, reason: 'missing', sentValue: String(session_id), allowedPrefixes, allowedLiterals };
  }
  if (session_id === 'unknown') {
    return { ok: false, reason: 'unknown_literal', sentValue: session_id, allowedPrefixes, allowedLiterals };
  }
  if (SPECIAL_CASE_SESSION_IDS.has(session_id)) {
    return { ok: true };
  }
  for (const prefix of allowedPrefixes) {
    if (session_id === prefix || session_id.startsWith(prefix + '-') || session_id.startsWith(prefix + '--')) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'invalid_prefix', sentValue: session_id, allowedPrefixes, allowedLiterals };
}

// Build a human-friendly rejection message naming exactly what was wrong,
// the value that was sent, and the full allowlist. Joshua's bar: a confused
// human reading this should know instantly what to send and where.
function buildSessionIdRejectionMessage(result) {
  const { reason, sentValue, allowedPrefixes, allowedLiterals } = result;
  const prefixList = allowedPrefixes.join(', ');
  const literalList = allowedLiterals.join(', ');
  let problem;
  if (reason === 'missing') {
    problem = `Your POST to /api/presenter/queue was rejected because it had no session_id field (or it was empty). Every presenter card must declare which steward it came from so Joshua's sidebar can bucket it correctly — cards without a valid session_id used to silently land in an invisible "unknown" bucket and never reach Joshua.`;
  } else if (reason === 'unknown_literal') {
    problem = `Your POST to /api/presenter/queue was rejected because session_id was the literal string "unknown". This used to be the silent default for missing/invalid session_ids and orphaned cards in an invisible bucket. It's now explicitly forbidden.`;
  } else {
    problem = `Your POST to /api/presenter/queue was rejected because session_id="${sentValue}" doesn't match any known top-level steward. Every card must be attributable to one of Joshua's stewards.`;
  }
  return [
    problem,
    ``,
    `What you sent: ${JSON.stringify(sentValue)}`,
    ``,
    `What's accepted:`,
    `  - Anything starting with one of these prefixes (substewards/workers OK, e.g. "holler-venture--lawsuit"):`,
    `      ${prefixList}`,
    `  - These exact literal session_ids:`,
    `      ${literalList}`,
    ``,
    `How to fix: if you're a tmux-resident Claude session, your session_id is the output of \`tmux display-message -p '#S'\` and should already start with "holler-". If you're a non-tmux service that needs a new literal added to the allowlist, ask Joshua before adding — don't bypass this check. The allowlist is computed live from \`~/.homestead/stewards/\` (top-level dirs) plus the special-case literals above.`,
  ].join('\n');
}

let firebaseAdmin = null;

let queue = [];

// Delivery tracking: itemId -> { electron: timestamp|null, mobile: timestamp|null }
const deliveryStatus = new Map();

// Idempotency ledger for respondToItem. On a flaky connection (the phone over
// Tailscale), the POST /api/presenter/respond can REACH the server and be fully
// processed — feedback delivered, card removed — but the HTTP RESPONSE gets
// dropped before the browser sees it. The client then shows "failed" and
// re-POSTs the identical reply. Without this ledger the retry 404s (the card is
// already gone) so the UI is stuck forever on a reply that WAS delivered, and a
// keepCard reply would be delivered a SECOND time. Both maps let a duplicate
// respond return the original outcome idempotently — no 404, no double-send.
//   resolvedItems:  id     -> { feedback, ts }  (records default resolves where
//                                                the card leaves the queue)
//   processedSends: sendId -> { feedback, ts }  (client-supplied per-send key;
//                                                covers keepCard, where the card
//                                                survives and id alone can't tell
//                                                a genuine re-reply from a retry)
const resolvedItems = new Map();
const processedSends = new Map();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 min — well past any retry window

function rememberIdempotent(map, key, feedback) {
  if (!key) return;
  map.set(key, { feedback, ts: Date.now() });
  // Opportunistic prune so the maps can't grow unbounded on a long-lived server.
  if (map.size > 500) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, v] of map) { if (v.ts < cutoff) map.delete(k); }
  }
}

function recallIdempotent(map, key) {
  if (!key) return null;
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > IDEMPOTENCY_TTL_MS) { map.delete(key); return null; }
  return entry.feedback;
}

function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

function loadQueue() {
  try {
    if (existsSync(QUEUE_FILE)) {
      queue = JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
    }
  } catch {
    queue = [];
  }
  return queue;
}

function saveQueue() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    // ATOMIC (torn-read fix 2026-08-25): temp+rename so a concurrent reader
    // never sees a half-written presenter-queue.json.
    writeFileAtomicSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (err) {
    console.error('[PresenterQueue] Failed to save:', err.message);
  }
}

function getQueue() {
  return queue;
}

/**
 * Human-friendly rejection message for a DUPLICATE link title (same name, a
 * different url) — the stateful uniqueness gate. Names the collision + how to
 * fix, mirroring the naked/lazy reject tone. The lesson lands at the failure
 * point: two links can't share a name, so give this one a distinct content name.
 */
function buildDuplicateTitleRejectionMessage({ title, url, existingUrl, scope }) {
  const where = scope || 'your saved Links list';
  return [
    `Your presenter card was rejected because a link would create a DUPLICATE name in ${where}: "${title}"`,
    ``,
    `A link named "${title}" already points at a DIFFERENT url:`,
    `  existing: ${existingUrl}`,
    `  this one: ${url}`,
    ``,
    `Two links can't share a name — Joshua's Links list would show two identical-looking "${title}" entries he can't tell apart. There shouldn't be a chance for that.`,
    ``,
    `How to fix — remake the card giving THIS link a distinct name that describes its own CONTENT:`,
    `  ❌ two links both named "${title}"`,
    `  ✅ "${title} — Approach Plan"  vs  "${title} — Volume Strategy"  (or whatever each actually is)`,
    ``,
    `NOTE: re-saving the SAME url (to refresh its title) is always fine — this only fires when a name would be reused for a DIFFERENT link.`,
  ].join('\n');
}

function addItem({ title, message, buttons, input, priority, category, session_id, callback_session, source, component, componentProps, reminder_ack, potato_id, status, recap }) {
  // Hard reject invalid session_ids so cards never land in an invisible bucket.
  // Same guard runs at the API edge (server.js POST /api/presenter/queue) — this
  // backstop catches in-process callers (lib/job-scheduler.js, lib/triage-resolve.js,
  // lib/check-location-reminders.js) that bypass the HTTP path. Throwing here is
  // intentional: a card the sidebar can't bucket is worse than a loud failure.
  const validation = validateSessionId(session_id);
  if (!validation.ok) {
    const err = new Error(buildSessionIdRejectionMessage(validation));
    err.code = 'INVALID_SESSION_ID';
    err.validation = validation;
    throw err;
  }

  // FORCED-REMINDER GATE — the active-enforcement descendant of the passive
  // _reminder trailer (below, in respondToItem). Runs FIRST among the quality
  // gates: the forced pause is about the sender re-reading the card-quality
  // rules before ANY other check, so it fires before link-scanning. A card send
  // that isn't unlocked with a fresh timestamp is BLOCKED here and the rules are
  // echoed back — same typed-throw lineage as INVALID_SESSION_ID/NAKED_CARD_LINK,
  // surfaced as a structured 400 by the HTTP edge and relayed to the steward as
  // {success:false, rejected:true}. This lives on the CARD path ONLY — never the
  // universal walkie dispatcher — so steward-to-steward walkies are untouched.
  const gateNow = Date.now();
  const gate = forcedReminderGate.checkGate({ sessionId: session_id, reminderAck: reminder_ack, nowMs: gateNow });
  if (!gate.pass) {
    const err = new Error(gate.message);
    err.code = 'FORCED_REMINDER_UNLOCK_REQUIRED';
    err.gateReason = gate.reason;
    throw err;
  }

  // Auto-scan the card for a URL. Title-gated: a labeled link is saved+pinned
  // to the card-links interface; a bare/naked link is HARD-rejected back to the
  // steward (same throw-style as INVALID_SESSION_ID above); a card with no link
  // passes untouched. This lives inside addItem() so BOTH the HTTP edge
  // (server.js) AND in-process callers (job-scheduler, triage-resolve,
  // check-location-reminders) are covered with zero divergence. See
  // lib/card-link-scanner.js for the locked title rule.
  const linkScan = scanCardForLink({ title, message, buttons });
  if (linkScan.reject) {
    if (linkScan.reason === 'lazy_label') {
      const err = new Error(buildLazyLabelRejectionMessage(linkScan));
      err.code = 'LAZY_CARD_LINK_LABEL';
      err.linkScan = linkScan;
      throw err;
    }
    const err = new Error(buildNakedLinkRejectionMessage(linkScan));
    err.code = 'NAKED_CARD_LINK';
    err.linkScan = linkScan;
    throw err;
  }

  // Name-uniqueness gate (STATEFUL). Every labeled link about to be saved gets a
  // title-collision check against (a) the EXISTING saved Links list for this top
  // steward and (b) OTHER links on this same card. A collision = SAME title +
  // DIFFERENT url — two entries Joshua couldn't tell apart in his Links list.
  // Re-saving the SAME url (with same or updated title) is NOT a collision —
  // that's the living-record refresh at card-links-store.js. HARD-reject like the
  // naked/lazy gates so a second "localhost" never gets a CHANCE to persist.
  if (linkScan.found) {
    const uniqCandidates = Array.isArray(linkScan.allLabeled) && linkScan.allLabeled.length
      ? linkScan.allLabeled
      : (linkScan.saved ? [linkScan.saved] : []);
    // Track titles claimed by THIS card (title -> first url) to catch intra-card
    // collisions (two links on one card sharing a name but pointing elsewhere).
    const cardTitles = new Map();
    for (const candidate of uniqCandidates) {
      if (!candidate || !candidate.title || !candidate.url) continue;
      const key = candidate.title.trim().toLowerCase();
      const cleanUrl = candidate.url.trim();

      // Intra-card: same title already used on this card for a DIFFERENT url.
      const priorUrl = cardTitles.get(key);
      if (priorUrl !== undefined && priorUrl !== cleanUrl) {
        const err = new Error(buildDuplicateTitleRejectionMessage({
          title: candidate.title,
          url: candidate.url,
          existingUrl: priorUrl,
          scope: 'this same card',
        }));
        err.code = 'DUPLICATE_CARD_LINK_TITLE';
        throw err;
      }
      if (priorUrl === undefined) cardTitles.set(key, cleanUrl);

      // Against the existing saved list.
      const collision = cardLinksStore.findTitleCollision(session_id, candidate);
      if (collision) {
        const err = new Error(buildDuplicateTitleRejectionMessage({
          title: candidate.title,
          url: candidate.url,
          existingUrl: collision.url,
          scope: 'your saved Links list',
        }));
        err.code = 'DUPLICATE_CARD_LINK_TITLE';
        throw err;
      }
    }
  }

  // Past every gate — this card is committing. (The forced-reminder gate has no
  // per-sender state to advance post-redesign: every in-scope direct approach to
  // Joshua is armed and must carry a fresh stamp; the old burst clock is retired.)
  const id = generateId();
  const item = {
    id,
    session_id,
    callback_session: callback_session || session_id,
    title,
    message,
    buttons,
    input: true,
    priority: priority || 'normal',
    category: category || null,
    source: source || null,
    component: component || null,
    componentProps: componentProps || null,
    potato_id: potato_id || null,
    // 3-lane docket (2026-08-21). status + recap are hard-required at the
    // present_to_user tool edge, so cards from stewards always carry them. We
    // PERSIST them on the item here — previously they were silently dropped, so
    // the docket had nothing to render and fell back to the card TITLE. Now the
    // docket renders off status (the lane) + recap (the short line). In-process
    // system callers that omit them fall back to a swipe-safe 'fyi' with null
    // recap (the docket then shows the title only for those legacy alarms).
    status: (status === 'blocked' || status === 'weigh_in' || status === 'fyi') ? status : 'fyi',
    recap: (typeof recap === 'string' && recap.trim()) ? recap.trim() : null,
    pinned: false,
    timestamp: Date.now(),
  };

  if (priority === 'urgent') {
    queue.splice(1, 0, item);
  } else {
    queue.push(item);
  }

  // Initialize delivery tracking
  deliveryStatus.set(id, {
    queued_at: Date.now(),
    acks: {},
    connected_clients: getConnectedClientCount(),
  });

  saveQueue();
  broadcast('presenter:new-item', item);
  sendPresenterPush(item);

  // POTATO LOOP-CLOSE — the card path IS a holder outbound and MUST close.
  // The pure-code model closes a potato the instant its HOLDER sends its next
  // outbound to anyone. Walkie sends hit that close at the enqueue chokepoint
  // (queue-dispatcher.js) via envelope.from-match. But a CARD send to Josh goes
  // through addItem() — NOT enqueue() — so without this hook a steward that
  // answers Josh with a card (and no preceding walkie) never closes its potato.
  // The corrections officer then rings it 15s later — which lands on Josh as a
  // redundant SECOND message. That is the exact double-tap Josh reported
  // (2026-07-24). The old assumption here ("the holder always walkied BEFORE
  // carding") is frequently false — carding Josh is often the ONLY outbound.
  // Fix: a card SEND from steward X closes any open potato held by X, identical
  // to a walkie. Holder identity = callback_session (fallback session_id). No
  // potato_id echo, no message envelope needed — senderSession-match is the whole
  // contract. Best-effort: a tracker hiccup must never break card delivery.
  try {
    if (potatoTracker) {
      const holderSession = callback_session || session_id;
      const closed = potatoTracker.recordCloseFromQueueItem({ queueItemId: id, senderSession: holderSession });
      if (closed && closed.length) {
        for (const rec of closed) broadcast('potato:closed', { potato_id: rec.potato_id, closed_by: rec.closed_by });
      }
    }
  } catch (e) {
    console.error('[PresenterQueue] potato close (card path) failed (non-fatal):', e.message);
  }

  // Auto-save + pin EVERY labeled link on the card (a card may carry more than
  // one). Rolls up to the top steward. Deduped by url so the same link appearing
  // in both text and a button is saved once. Broadcast a single re-hydrate signal
  // after all saves so the presenter card-links pill refreshes without a reload.
  // Best-effort: a store write failure must never block the card from delivering.
  if (linkScan.found) {
    const candidates = Array.isArray(linkScan.allLabeled) && linkScan.allLabeled.length
      ? linkScan.allLabeled
      : (linkScan.saved ? [linkScan.saved] : []);
    const seenUrls = new Set();
    let topStewardId = null;
    for (const candidate of candidates) {
      if (!candidate || !candidate.url || seenUrls.has(candidate.url)) continue;
      seenUrls.add(candidate.url);
      try {
        // Pass the card's human source label so the store can show a friendly
        // worker name (Josh 2026-08-14 "who made this link"). The worker itself
        // is derived from session_id's "--" suffix inside saveLink.
        const result = cardLinksStore.saveLink(session_id, candidate, undefined, { source });
        if (result) topStewardId = result.topStewardId;
      } catch (err) {
        console.error('[PresenterQueue] Failed to auto-save card link:', err.message);
      }
    }
    if (topStewardId) {
      broadcast('presenter:card-links-updated', { session_name: topStewardId });
    }
  }

  return item;
}

function acknowledgeDelivery(itemId, clientType) {
  const status = deliveryStatus.get(itemId);
  if (status) {
    status.acks[clientType] = Date.now();
    console.log(`[PresenterQueue] ACK from ${clientType} for item ${itemId}`);
  }
}

function getDeliveryStatus(itemId) {
  const status = deliveryStatus.get(itemId);
  if (!status) return null;

  const acks = status.acks;
  const elapsed = Date.now() - status.queued_at;

  return {
    id: itemId,
    queued_at: status.queued_at,
    elapsed_ms: elapsed,
    connected_clients: status.connected_clients,
    acks,
    ack_count: Object.keys(acks).length,
    fully_delivered: Object.keys(acks).length >= status.connected_clients && status.connected_clients > 0,
  };
}

// --- History ---

function archiveItem(item, feedback) {
  const sessionId = (item.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const historyFile = join(HISTORY_DIR, `${sessionId}.json`);
  let history = [];
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    if (existsSync(historyFile)) {
      history = JSON.parse(readFileSync(historyFile, 'utf-8'));
    }
  } catch { history = []; }

  history.unshift({
    ...item,
    resolved_at: Date.now(),
    feedback,
  });

  // Keep last 1000 items per session (was 100 — Joshua wants long-term browseable history)
  if (history.length > 1000) history = history.slice(0, 1000);
  writeFileAtomicSync(historyFile, JSON.stringify(history, null, 2)); // atomic (torn-read fix 2026-08-25)
}

function getHistory(sessionId) {
  const safe = (sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const historyFile = join(HISTORY_DIR, `${safe}.json`);
  try {
    if (existsSync(historyFile)) {
      return JSON.parse(readFileSync(historyFile, 'utf-8'));
    }
  } catch {}
  return [];
}

// Cross-steward search across every archive file in HISTORY_DIR.
// Filters: q (text in title/message), steward (substring match on session_id;
// or exact match when stewardExact is truthy), limit (max results, default 200).
// Returns newest-first across all stewards, each item annotated with
// `_session_id` for the UI to group/show.
//
// stewardExact is needed because session_ids share prefixes — e.g. filtering
// to "holler-homestead" via substring would also pull in "holler-homestead--
// foreman" history. The History surface's "filter to active steward" mode
// passes stewardExact=1 to lock to a single archive file.
function searchAllHistory({ q, steward, stewardExact, limit } = {}) {
  const max = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 2000);
  const needle = (q || '').toLowerCase().trim();
  const stewardFilter = (steward || '').toLowerCase().trim();
  const exact = !!stewardExact && stewardExact !== '0' && stewardExact !== 'false';
  let files = [];
  try {
    if (!existsSync(HISTORY_DIR)) return [];
    files = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
  } catch { return []; }

  // Sanitize the same way archiveItem() does, so the client can pass a raw
  // session_id and we'll find the matching archive file deterministically.
  const sanitizedExact = exact ? (steward || '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() : '';

  const out = [];
  for (const file of files) {
    const sid = file.replace(/\.json$/, '');
    if (exact) {
      if (sid.toLowerCase() !== sanitizedExact) continue;
    } else if (stewardFilter && sid.toLowerCase().indexOf(stewardFilter) === -1) continue;
    let items = [];
    try {
      items = JSON.parse(readFileSync(join(HISTORY_DIR, file), 'utf-8')) || [];
    } catch { continue; }
    for (const item of items) {
      if (needle) {
        const haystack = (
          (item.title || '') + ' ' +
          (item.message || '') + ' ' +
          (item.feedback && item.feedback.text ? item.feedback.text : '')
        ).toLowerCase();
        if (haystack.indexOf(needle) === -1) continue;
      }
      out.push({ ...item, _session_id: sid });
    }
  }
  out.sort((a, b) => (b.resolved_at || b.timestamp || 0) - (a.resolved_at || a.timestamp || 0));
  return out.slice(0, max);
}

// Lightweight steward index — names + counts — for the History surface
// to populate its steward filter dropdown without pulling all card content.
function listHistoryStewards() {
  try {
    if (!existsSync(HISTORY_DIR)) return [];
    return readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const sid = f.replace(/\.json$/, '');
        let count = 0;
        try {
          const items = JSON.parse(readFileSync(join(HISTORY_DIR, f), 'utf-8'));
          count = Array.isArray(items) ? items.length : 0;
        } catch {}
        return { session_id: sid, count };
      })
      .filter(s => s.count > 0)
      .sort((a, b) => a.session_id.localeCompare(b.session_id));
  } catch { return []; }
}

// getUnifiedLog — READ-TIME MERGE of every existing message store into a single
// chronological log for one steward. NO new persistent store is created; this
// only READS the three stores that already exist:
//   1. presenter-queue.json (live cards from stewards → Josh, unresolved)
//   2. presenter-history/<sid>.json (resolved cards → Josh + Josh's reply)
//   3. ~/.homestead/queue.json (walkie: steward↔steward + Josh feedback replies)
//
// Each returned entry is normalized to a common envelope:
//   { kind, id, ts, direction, counterparty, title, body, status,
//     reply, replyButton, isJosh }
// where direction ∈ {received, sent, steward}:
//   - received: a card the steward sent TO Josh
//   - sent:     Josh's reply to a card (extracted from card.feedback)
//   - steward:  steward↔steward walkie traffic (hidden unless the toggle is off)
//
// `sessionId` scopes to one steward (its top-level name + all its sub-sessions).
// onlyMine=false is applied by the CLIENT (this returns everything; the client's
// reused "only my messages" toggle filters direction==='steward' out).
function getUnifiedLog(sessionId, { limit } = {}) {
  const max = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 2000);

  // Josh's #3: the log is now GLOBAL by default — every steward's traffic in
  // one chronological view — because steward↔steward chatter is invisible if
  // the log silently narrows to the selected steward. An empty/`*` steward
  // means "all messages"; a real session id keeps the old per-steward scope
  // (the client's "only this steward" toggle drives that). The client applies
  // the actual filtering now; the server just returns the full merged log so
  // the two toggles can slice it without re-fetching.
  const unscoped = !sessionId || sessionId === '*';

  // The steward scope: the selected session plus anything sharing its top-level
  // steward name. A session id is `holler-<top>[--<sub>[--<sub>]]`, where <top>
  // may itself contain single dashes (e.g. holler-crowne-vault, holler-big-
  // jims-plates). The sub-session delimiter is the DOUBLE dash, so the true
  // top-level id is everything BEFORE the first `--`. Match by that prefix so
  // every sub-session of a steward folds into its log.
  const wantTop = unscoped ? null : sessionId.split('--')[0].toLowerCase();
  const inScope = (sid) => {
    if (unscoped) return true;
    const top = (sid || '').split('--')[0].toLowerCase();
    return top === wantTop;
  };

  const out = [];

  // --- 1 + 2: presenter cards (live + archived) → Josh RECEIVED, and any
  // Josh reply inside a resolved card → Josh SENT. ---
  const cards = [];
  try {
    for (const item of getQueue()) {
      if (inScope(item.session_id)) cards.push({ ...item, _archived: false });
    }
  } catch {}
  // Archived cards live one-file-per-sub-session; sweep every file whose name is
  // in this steward's scope (a steward has many sub-session archives).
  try {
    if (existsSync(HISTORY_DIR)) {
      for (const file of readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'))) {
        const sid = file.replace(/\.json$/, '');
        if (!inScope(sid.replace(/_/g, '-'))) continue;
        let items = [];
        try { items = JSON.parse(readFileSync(join(HISTORY_DIR, file), 'utf-8')) || []; } catch { continue; }
        for (const it of items) cards.push({ ...it, _session_id: sid, _archived: true });
      }
    }
  } catch {}

  for (const card of cards) {
    const cpSid = card.session_id || (card._session_id || '').replace(/_/g, '-');
    // The card itself: steward → Josh (RECEIVED by Josh).
    out.push({
      kind: 'card',
      id: card.id,
      ts: card.timestamp || 0,
      direction: 'received',
      counterparty: cpSid,
      title: card.title || '',
      body: card.message || '',
      status: card._archived ? 'resolved' : 'live',
      // A card is NEVER "queued" — it was delivered to Josh the moment it
      // appeared on his presenter. Josh's #4: the queued badge over-fired
      // because live cards carried status='pending' and the client painted
      // every one "⏳ queued". `queued` is the single source of truth for the
      // badge now; only genuinely-undispatched walkie items set it true.
      queued: false,
      isJosh: false,
    });
    // Josh's reply lives on the resolved card's feedback. Surface it as a
    // SEPARATE entry so the log reads as a back-and-forth (Josh SENT).
    const fb = card.feedback;
    if (fb && !fb.dismissed && (fb.text || fb.button)) {
      out.push({
        kind: 'reply',
        id: card.id + '::reply',
        ts: card.resolved_at || card.timestamp || 0,
        direction: 'sent',
        counterparty: cpSid,
        title: '',
        body: fb.text || '',
        replyButton: fb.button || '',
        status: 'resolved',
        queued: false,
        isJosh: true,
      });
    }
  }

  // --- 3: walkie queue (~/.homestead/queue.json) → steward↔steward traffic +
  // Josh feedback envelopes. Direction inferred from the parsed envelope. ---
  try {
    if (existsSync(SISWAPTS_QUEUE)) {
      const wq = JSON.parse(readFileSync(SISWAPTS_QUEUE, 'utf-8')) || [];
      for (const item of wq) {
        if (!inScope(item.target_session)) continue;
        let env = {};
        try {
          let p = JSON.parse(item.message);
          if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
          if (p && typeof p === 'object') env = p;
        } catch {}
        const from = env.from || '';
        const isJoshFeedback = env.source === 'presenter';
        const body = env.instruction || env.feedback || env.text || env.message || env.title || (typeof item.message === 'string' ? item.message : '');
        const ts = item.created_at ? new Date(item.created_at).getTime() : 0;
        // Walkie lifecycle: pending → dispatched → confirmed (or failed).
        // Josh's #4: ONLY a genuinely-undispatched item (`pending`) is queued.
        // `dispatched` means it already reached the target and is awaiting a
        // roger-that (surfaced as "sending", not queued); `confirmed`/`failed`
        // are terminal. The old code defaulted a missing status to 'pending'
        // and the client badged pending||dispatched — so every already-sent
        // item read "queued". Default a missing status to 'confirmed' (the
        // queue only retains active items; anything without a status has been
        // processed) so the badge cannot over-fire.
        const st = item.status || 'confirmed';
        out.push({
          kind: isJoshFeedback ? 'reply' : 'walkie',
          id: item.id,
          ts,
          direction: isJoshFeedback ? 'sent' : 'steward',
          counterparty: isJoshFeedback ? item.target_session : (from || item.target_session),
          from,
          target: item.target_session,
          title: '',
          body,
          status: st,
          queued: st === 'pending',
          sending: st === 'dispatched',
          failed: st === 'failed',
          isJosh: isJoshFeedback,
        });
      }
    }
  } catch {}

  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out.slice(0, max);
}

// respondToItem — deliver Joshua's reply (plus the card's own context:
// title/message/buttons/input) to the steward that raised the card.
//
// keepCard (Josh 2026-07-10): when true, the reply + context is delivered to
// the steward EXACTLY as a normal respond, but the card is NOT removed from
// the presenter queue — it survives so Joshua can keep it on screen and reply
// again later. This is the per-card "send without dismissing" path. When
// keepCard is false (the default), behavior is unchanged: respond archives,
// removes, broadcasts resolution, and dismisses the phone notification.
function respondToItem(id, { button, text, dismissed, keepCard, sendId }) {
  // Idempotency: a retry of a send that already went through (its HTTP response
  // was lost on the way back to a flaky client) must return the ORIGINAL outcome
  // — never re-deliver, never 404. Check the per-send key first (covers keepCard,
  // where the card is still in the queue), then the resolved-item ledger (covers
  // the default path, where the card has already left the queue).
  const priorBySend = recallIdempotent(processedSends, sendId);
  if (priorBySend) return { ...priorBySend, _idempotent: true };

  const item = queue.find(i => i.id === id);
  if (!item) {
    const priorById = recallIdempotent(resolvedItems, id);
    if (priorById) return { ...priorById, _idempotent: true };
    return null;
  }

  // Build feedback with full original presentation context
  const feedback = {
    type: 'feedback',
    source: 'presenter',
    presenter_id: id,
    title: item.title,
    message: item.message,
    buttons: item.buttons,
    input: item.input,
    category: item.category,
    button: button,
    text: text || '',
    dismissed: dismissed || false,
    kept_open: !!keepCard,
    // Deterministic, unconditional reminder baked into every presenter feedback
    // envelope. Josh watches only the presenter card window — a steward that
    // answers in the terminal is invisible to him. This trailer fires on every
    // card reply, no LLM decision, so no steward can drift into terminal replies.
    _reminder: '⛔ If you are going to respond to Joshua, you MUST use the present_to_user tool — NOT terminal text. Every reply to Joshua goes through the presenter card. No exceptions.',
  };

  // Write feedback to walkie-talkie queue for delivery to the agent
  if (item.callback_session) {
    writeFeedbackToQueue(item.callback_session, feedback);
  }

  // No-dismiss path: the steward got the reply + context, but the card stays
  // in the queue. Skip archive/remove/resolve-broadcast/dismiss-push entirely.
  if (keepCard) {
    // Remember by send key only — the card stays live, so id alone would wrongly
    // dedup a legitimate second reply to the same card. A retry of THIS send
    // carries the same sendId and returns idempotently instead of re-delivering.
    rememberIdempotent(processedSends, sendId, feedback);
    return feedback;
  }

  // Dismiss-implies-seen (Rooster edge, 2026-08-25): if Josh acted on this card
  // from somewhere other than the timeline (sidebar reply, etc.) it may never
  // have been surfaced-and-seen. Backfill seen_at so the archived record is
  // honest and it can't read as "new" anywhere. (It's leaving the live queue
  // here, so the timeline can't resurface it regardless — this just keeps the
  // history consistent.) First-lay-eyes-wins: only set if unset.
  if (!item.seen_at) item.seen_at = Date.now();

  // Archive before removing
  archiveItem(item, feedback);

  // Remove from queue and clean up delivery tracking
  queue = queue.filter(i => i.id !== id);
  deliveryStatus.delete(id);
  saveQueue();
  broadcast('presenter:item-resolved', { id, feedback });

  // Dismiss the phone notification for this card
  sendPresenterDismissPush(id);

  // Record the resolve so a retry (whose first HTTP response was lost) returns
  // this same outcome idempotently instead of 404-ing on the now-absent card.
  rememberIdempotent(resolvedItems, id, feedback);
  rememberIdempotent(processedSends, sendId, feedback);

  return feedback;
}

/**
 * Mark a card as SEEN by Josh (Feature 2 "play/timeline" view, 2026-08-25).
 *
 * The timeline surfaces the newest card Josh HASN'T laid eyes on yet, one at a
 * time, with the rest stacking behind by arrival order. That requires a real
 * "Josh saw this" flag distinct from deliveryStatus (reached the device) and
 * respondToItem (Josh ACTED). We stamp `seen_at` (Date.now() ms, same unit as
 * `timestamp`) the first time the timeline brings a card front-and-center.
 *
 * FIRST-LAY-EYES WINS: only sets seen_at if it's currently unset. A card is
 * seen exactly once; a later re-surface must never bump the stamp (that would
 * reshuffle the "newest-unseen" ordering under Josh). Rooster-confirmed schema
 * (2026-08-25): on-card field, atomic via saveQueue → writeFileAtomicSync, no
 * consumer chokes on the extra field. Returns the item, or null if not found.
 */
function markSeen(id) {
  const item = queue.find(i => i.id === id);
  if (!item) return null;
  if (item.seen_at) return item; // already seen — never overwrite
  item.seen_at = Date.now();
  saveQueue();
  broadcast('presenter:item-updated', { id, fields: { seen_at: item.seen_at } });
  return item;
}

/**
 * Toggle (or explicitly set) the `pinned` flag on a queue item. Pinned items
 * are excluded from bulk-dismiss operations (they can still be dismissed
 * individually). Returns the updated item or null if not found.
 */
function setPinned(id, pinned) {
  const item = queue.find(i => i.id === id);
  if (!item) return null;
  item.pinned = !!pinned;
  saveQueue();
  broadcast('presenter:item-updated', { id, fields: { pinned: item.pinned } });
  return item;
}

/**
 * Backfill / correct the `recap` (and optionally `status`) on an EXISTING card.
 * Cards otherwise only get a recap at creation time; the urgency view falls back
 * to the card title when a recap is missing, which reads as stale. This lets a
 * steward set a real project-level status recap (and flip blocked/weigh_in/fyi) on
 * cards already in the queue. Mutates the server's in-memory `queue` IN-PROCESS
 * and persists via saveQueue(), so it can never race a concurrent server write.
 * Returns the updated item, or null if not found.
 */
function setCardMeta(id, { recap, status } = {}) {
  const item = queue.find(i => i.id === id);
  if (!item) return null;
  const fields = {};
  if (typeof recap === 'string') { item.recap = recap; fields.recap = recap; }
  if (status === 'blocked' || status === 'weigh_in' || status === 'fyi') { item.status = status; fields.status = status; }
  if (Object.keys(fields).length === 0) return item; // nothing to change
  saveQueue();
  broadcast('presenter:item-updated', { id, fields });
  return item;
}

/**
 * Rewrite session references (callback_session AND session_id) on live cards
 * old→new. Conversational-worker cutover renames a session
 * (holler-X--foreman--Y → holler-X--Y); any OPEN card stamped with the old name
 * at send-time would misroute Josh's reply after the rename. This mutates the
 * server's in-memory `queue` IN-PROCESS and persists via saveQueue(), so it can
 * never clobber (or be clobbered by) a concurrent server write — there is no
 * outside-the-server file edit. The server's `queue` is the single source of
 * truth after load; an outside JSON edit would be lost on the next saveQueue().
 *
 * Reusable across the remaining cutover waves. Returns
 * { rewritten: [ids], count, oldSession, newSession }.
 */
function rewriteSessionRefs(oldSession, newSession) {
  if (!oldSession || !newSession || typeof oldSession !== 'string' || typeof newSession !== 'string') {
    return { error: 'oldSession and newSession must be non-empty strings', rewritten: [], count: 0 };
  }
  const rewritten = [];
  for (const item of queue) {
    let touched = false;
    if (item.callback_session === oldSession) { item.callback_session = newSession; touched = true; }
    if (item.session_id === oldSession) { item.session_id = newSession; touched = true; }
    if (touched) rewritten.push(item.id);
  }
  if (rewritten.length) {
    saveQueue();
    for (const id of rewritten) {
      broadcast('presenter:item-updated', { id, fields: { callback_session: newSession, session_id: newSession } });
    }
  }
  return { rewritten, count: rewritten.length, oldSession, newSession };
}

function dismissItem(id) {
  const item = queue.find(i => i.id === id);
  if (!item) return null;

  // Dismiss-implies-seen (Rooster edge, 2026-08-25) — keep the archived record
  // honest; first-lay-eyes-wins.
  if (!item.seen_at) item.seen_at = Date.now();

  // Archive before removing
  archiveItem(item, { dismissed: true });

  // Silently remove from queue — no feedback sent to the agent
  queue = queue.filter(i => i.id !== id);
  deliveryStatus.delete(id);
  saveQueue();
  broadcast('presenter:item-resolved', { id, feedback: { dismissed: true } });

  // Dismiss the phone notification for this card
  sendPresenterDismissPush(id);

  return { dismissed: true };
}

/**
 * Dismiss many cards at once. Archives each, removes from queue, saves once,
 * emits ONE consolidated `presenter:bulk-resolved` socket event with the full
 * list of dismissed IDs. Phone dismiss pushes fire per-id (cheap).
 *
 * Pinned items are SKIPPED (they can still be dismissed individually via
 * dismissItem). Server is the source of truth for the pin filter — callers
 * can pass the full ID list without client-side filtering.
 *
 * Returns { dismissed: [ids...], notFound: [ids...], skippedPinned: [ids...] }.
 */
function bulkDismissItems(ids) {
  if (!Array.isArray(ids)) return { dismissed: [], notFound: [], skippedPinned: [] };
  const dismissed = [];
  const notFound = [];
  const skippedPinned = [];

  for (const id of ids) {
    const item = queue.find(i => i.id === id);
    if (!item) { notFound.push(id); continue; }
    if (item.pinned) { skippedPinned.push(id); continue; }
    if (!item.seen_at) item.seen_at = Date.now(); // dismiss-implies-seen
    archiveItem(item, { dismissed: true });
    queue = queue.filter(i => i.id !== id);
    deliveryStatus.delete(id);
    dismissed.push(id);
    sendPresenterDismissPush(id);
  }

  if (dismissed.length > 0) {
    saveQueue();
    broadcast('presenter:bulk-resolved', { ids: dismissed });
  }

  return { dismissed, notFound, skippedPinned };
}

function writeFeedbackToQueue(targetSession, feedback) {
  try {
    const itemId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const messageStr = JSON.stringify(feedback);
    const newItem = {
      id: itemId,
      target_session: targetSession,
      type: 'feedback',
      message: messageStr,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    // MUTEX-SAFE (confirmed-item redelivery-loop fix 2026-08-03): presenter-queue
    // runs IN the server event loop (required by server.js), so it shares the
    // dispatcher's mutateQueue single-flight lock. The old raw
    // readFileSync→push→writeFileSync on the walkie queue (SISWAPTS_QUEUE =
    // ~/.homestead/queue.json) BYPASSED that lock and could re-introduce an
    // already-archived confirmed item (resurrection race with cleanQueue). Route
    // the append through mutateQueue so it serializes with tick/confirm/cleanQueue.
    // Fire-and-forget: the caller does not await this write today.
    require('./queue-dispatcher')
      .mutateQueue(queue => { queue.push(newItem); return queue; })
      .catch((e) => console.error('[PresenterQueue] writeFeedbackToQueue mutateQueue failed:', e.message));

    // Potato BIRTH observation (card-reply path). This feedback envelope carries
    // source='presenter', the Josh-origin discriminator — so a card reply Josh
    // sends to a steward births a potato tracked to that steward. Non-blocking;
    // a tracker fault must never break feedback delivery.
    if (potatoTracker) {
      try {
        potatoTracker.recordBirthFromQueueItem({
          queueItemId: itemId,
          targetSession,
          message: messageStr,
        });
      } catch (e) {
        console.error('[PresenterQueue] potato observe (feedback birth) failed (non-fatal):', e.message);
      }
    }
  } catch (err) {
    console.error('[PresenterQueue] Failed to write feedback to queue:', err.message);
  }
}

// Socket.IO — set by server.js on startup
let ioInstance = null;

function setIo(io) {
  ioInstance = io;

  // Listen for ack events from clients
  io.on('connection', (socket) => {
    // Client identifies itself (electron, mobile-web, browser)
    socket.on('presenter:register', (clientType) => {
      socket.presenterClientType = clientType || 'unknown';
      console.log(`[PresenterQueue] Client registered: ${clientType} (${socket.id})`);
    });

    // Client acknowledges receiving an item
    socket.on('presenter:ack', (itemId) => {
      const clientType = socket.presenterClientType || 'unknown';
      acknowledgeDelivery(itemId, clientType);
    });
  });
}

function getConnectedClientCount() {
  if (!ioInstance) return 0;
  // Count sockets that have registered as presenter clients
  let count = 0;
  for (const [, socket] of ioInstance.sockets.sockets) {
    if (socket.presenterClientType) count++;
  }
  return count;
}

function broadcast(event, data) {
  if (ioInstance) {
    ioInstance.emit(event, data);
  }
}

// --- FCM Push Notifications ---

function ensureFirebase() {
  if (firebaseAdmin && firebaseAdmin.apps && firebaseAdmin.apps.length > 0) return true;
  try {
    if (!existsSync(SERVICE_ACCOUNT_PATH)) return false;
    // Reuse existing firebase-admin instance if already initialized by fcm-session-watcher
    firebaseAdmin = require('firebase-admin');
    if (!firebaseAdmin.apps || firebaseAdmin.apps.length === 0) {
      const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'));
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(serviceAccount),
      });
    }
    return true;
  } catch (e) {
    console.error('[PresenterQueue] Firebase init error:', e.message);
    return false;
  }
}

function getFcmTokens() {
  if (!existsSync(TOKEN_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

async function sendPresenterPush(item) {
  if (!ensureFirebase()) return;

  const tokens = getFcmTokens();
  if (tokens.length === 0) return;

  // Short fallback preview for the tray/lock-screen. The APK FETCHES the full
  // item by presenter_item_id and renders the FULL body (BigTextStyle) + the
  // card's own buttons as actions — real card bodies exceed the ~4KB FCM data
  // cap, so we never cram them into the push. This truncated string is only the
  // collapsed-preview fallback used if that fetch fails.
  const truncatedMessage = item.message.length > 100
    ? item.message.substring(0, 100) + '...'
    : item.message;

  try {
    // DATA-ONLY message (no `notification` block). Critical: when an FCM message
    // carries a `notification` block AND the app is backgrounded, Android renders
    // the tray notification ITSELF and never calls onMessageReceived — so the
    // APK's rich rendering (markdown-strip, full body, image, actions) would be
    // skipped exactly when Josh needs it (app in background). Data-only guarantees
    // onMessageReceived fires in both foreground and background. Title/body ride
    // in `data` as the fallback the APK shows if the full-item fetch fails.
    const message = {
      tokens,
      data: {
        type: 'presenter',
        presenter_item_id: item.id,
        title: item.title || 'Presenter',
        body: truncatedMessage,
      },
      android: {
        priority: 'high',
      },
    };

    const response = await firebaseAdmin.messaging().sendEachForMulticast(message);
    console.log(`[PresenterQueue] Push sent: ${response.successCount}/${tokens.length} delivered`);

    // ⚠️ "successCount" MEANS GOOGLE ACCEPTED IT — NOT THAT THE PHONE GOT IT.
    // FCM returns a real message id for a token that is no longer registered,
    // so this line can read 1/1 while the device receives nothing. That is not
    // a hypothetical: it ran for five days in Sep 2026. Do not treat this
    // number as delivery. See lib/health-checks.js -> checkPhoneNotifications,
    // which proves delivery by reading the phone's OWN notification tray.
    if (response.failureCount > 0) {
      const validTokens = tokens.filter((_, i) => response.responses[i].success);
      if (validTokens.length < tokens.length) {
        writeFileAtomicSync(TOKEN_FILE, JSON.stringify(validTokens, null, 2)); // atomic (torn-read fix 2026-08-25)
      }
      // 🚨 SAY SO OUT LOUD. The pruning above is correct and always was — but
      // it used to happen in total silence, so a device dropping off the list
      // left no trace anyone could find later. If EVERY token just failed,
      // nobody is receiving anything at all and that deserves to be shouted.
      response.responses.forEach((r, i) => {
        if (!r.success) {
          console.error(
            `[PresenterQueue] ⚠️ DEAD TOKEN retired: …${tokens[i].slice(-12)} `
            + `(${(r.error && r.error.code) || 'unknown'}) — that device will get `
            + `NOTHING until its app is opened and re-registers.`
          );
        }
      });
      if (validTokens.length === 0) {
        console.error(
          '[PresenterQueue] 🚨 NO DEVICES LEFT — every registered token was '
          + 'rejected. Notifications are going nowhere. Open the Homestead app '
          + 'on the phone to re-register.'
        );
      }
    }
  } catch (e) {
    console.error('[PresenterQueue] Push failed:', e.message);
  }
}

async function sendPresenterDismissPush(itemId) {
  if (!ensureFirebase()) return;

  const tokens = getFcmTokens();
  if (tokens.length === 0) return;

  try {
    const message = {
      tokens,
      data: {
        type: 'dismiss_presenter',
        presenter_item_id: itemId,
      },
      android: {
        priority: 'high',
      },
    };

    const response = await firebaseAdmin.messaging().sendEachForMulticast(message);
    console.log(`[PresenterQueue] Dismiss push sent for ${itemId}: ${response.successCount}/${tokens.length}`);
  } catch (e) {
    console.error('[PresenterQueue] Dismiss push failed:', e.message);
  }
}

// Initialize on require
loadQueue();

module.exports = {
  getQueue,
  addItem,
  respondToItem,
  dismissItem,
  bulkDismissItems,
  setPinned,
  markSeen,
  setCardMeta,
  rewriteSessionRefs,
  getHistory,
  searchAllHistory,
  listHistoryStewards,
  getUnifiedLog,
  setIo,
  loadQueue,
  acknowledgeDelivery,
  getDeliveryStatus,
  validateSessionId,
  buildSessionIdRejectionMessage,
};
