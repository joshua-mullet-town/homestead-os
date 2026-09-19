/**
 * josh-walkie-sends — the recency/frequency ring's data source.
 *
 * Reads Josh's most-recent outbound walkie messages FROM THE WALKIE-TALKIE'S
 * OWN EXISTING LOG. Josh was explicit: "no duplicate data source. Just the
 * walkie-talkie tool is read every time for its logs." So this module invents
 * NO new tracker — it reads exactly what the queue already writes:
 *
 *   • ~/.homestead/queue.json                    (live, not-yet-archived items)
 *   • ~/.homestead/queue-archive-YYYY-MM-DD.json (rolling per-day archives the
 *                                                 dispatcher writes on purge)
 *
 * A Josh send is any queue item whose envelope `from` is one of JOSH_FROMS
 * (the tags the presenter/mobile bottom-bar stamps on Josh-originated sends —
 * server.js and app.js both stamp `josh-presenter`; the mobile path stamps
 * `josh-mobile`). Each send's `target_session` is the recipient; we attribute
 * it to the TOP-LEVEL steward it went to (a send to a substeward like
 * `holler-homestead--worker-row-display` attributes to `homestead`), because
 * the ring wraps the top-level steward icons in the presenter topbar/sidebar.
 *
 * Newest-first: we read the live queue, then archives newest-date-first, until
 * we've collected comfortably more than `limit` Josh sends, then sort by
 * created_at descending and take the top `limit`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOMESTEAD_DIR = path.join(os.homedir(), '.homestead');

// Envelope `from` tags that mean "Joshua sent this" (not a steward).
const JOSH_FROMS = new Set(['josh-presenter', 'josh-mobile']);

/**
 * Map a target session name to the top-level steward id its send attributes to.
 *   holler-homestead                     -> homestead
 *   holler-homestead--worker-row-display -> homestead
 *   holler-rooster--auditor              -> rooster
 * Returns null for empty/garbage.
 */
function topStewardId(target) {
  if (!target || typeof target !== 'string') return null;
  return target.replace(/^holler-/, '').split('--')[0] || null;
}

/**
 * Is this queue envelope a message JOSH sent to a steward? Josh reaches stewards
 * TWO ways, and BOTH must count for the recency ring — the bug that shipped
 * first only counted (1):
 *
 *   1. BOTTOM-BAR WALKIE — Josh types/dictates in the presenter bottom bar and
 *      picks a steward. Stamped `from: josh-presenter` (or `josh-mobile` on the
 *      Android path).
 *   2. CARD REPLY — Josh replies to a steward's card (the "Reply"/voice-response
 *      on a present_to_user card). This routes to the steward as a
 *      `type: 'feedback'` envelope with `source: 'presenter'` and a
 *      `presenter_id` — NOT tagged `from: josh-presenter`. These are still Josh
 *      talking to that steward (stewards don't reply to each other's cards), so
 *      they count. Missing them made the newest send (a card reply) invisible,
 *      so the ring's 3-o'clock slot lit the wrong steward.
 */
function isJoshSend(env) {
  if (!env) return false;
  if (JOSH_FROMS.has(env.from)) return true;                 // (1) bottom-bar walkie
  if (env.type === 'feedback' && env.source === 'presenter' && env.presenter_id) {
    return true;                                             // (2) card reply
  }
  return false;
}

function joshSendsFromItems(items) {
  const out = [];
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (!it || !it.message) continue;
    let env;
    try {
      env = JSON.parse(it.message);
    } catch {
      continue;
    }
    if (!isJoshSend(env)) continue;
    out.push({
      created_at: it.created_at || null,
      target: it.target_session || null,
      steward: topStewardId(it.target_session),
    });
  }
  return out;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Return Josh's last `limit` outbound walkie sends, newest first.
 * Each entry: { created_at, target, steward }.
 */
function getRecentJoshSends(limit = 30) {
  const collected = [];

  // 1) Live queue first — the freshest sends, before they're archived.
  const live = readJsonSafe(path.join(HOMESTEAD_DIR, 'queue.json'));
  if (Array.isArray(live)) collected.push(...joshSendsFromItems(live));

  // 2) Archives, newest-date-first. Read until we've got a healthy margin over
  //    `limit` (sends aren't evenly distributed per day, so overshoot then trim).
  let archives = [];
  try {
    archives = fs
      .readdirSync(HOMESTEAD_DIR)
      .filter((f) => /^queue-archive-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
  } catch {
    archives = [];
  }

  const MARGIN = limit * 2;
  for (const f of archives) {
    if (collected.length >= MARGIN) break;
    const data = readJsonSafe(path.join(HOMESTEAD_DIR, f));
    if (Array.isArray(data)) collected.push(...joshSendsFromItems(data));
  }

  // 3) Sort newest-first by created_at, take `limit`.
  collected.sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return tb - ta;
  });

  return collected.slice(0, limit);
}

/**
 * Convenience shape for the ring: the ordered steward-id list (newest first,
 * length <= limit) plus a per-steward count. The renderer uses `ordered` for
 * recency-clockwise fill and `counts` for count-based fill.
 */
function getRecencyRing(limit = 30) {
  const sends = getRecentJoshSends(limit);
  const ordered = sends.map((s) => s.steward);
  const counts = {};
  for (const s of ordered) {
    if (!s) continue;
    counts[s] = (counts[s] || 0) + 1;
  }
  return { limit, total: ordered.length, ordered, counts };
}

module.exports = { getRecentJoshSends, getRecencyRing, topStewardId, JOSH_FROMS };
