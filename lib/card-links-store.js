/**
 * Card-links store — the persistence layer behind the auto-saved card links
 * interface (the pill "up there with Bookmarks").
 *
 * Mirrors data/steward-bookmarks.json, but every entry is a LIVING record:
 *   data/steward-card-links.json → { topStewardId: [ { title, url, created_at, last_opened } ] }
 *
 * Sub/worker links roll UP to the top steward (prefix before first "--"), same
 * as bookmarks — Joshua only sees the top steward's panel.
 *
 * Shared by:
 *   - lib/presenter-queue.js addItem()  (auto-save on every labeled card link)
 *   - app/api/card-links/route.ts       (GET/POST/DELETE from the renderer)
 * so the read-mutate-write logic never diverges between the two.
 */

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');

const CARD_LINKS_FILE = join(process.cwd(), 'data', 'steward-card-links.json');

// Top-steward session is the prefix before the first "--" in the chain
// (e.g. "holler-homestead--auditor", or a re-homed worker
// "holler-homestead--xyz", or legacy "holler-homestead--foreman--xyz" →
// "holler-homestead"). Dual-read-safe: keys off the FIRST "--", not the
// "--foreman--" infix, so re-homed workers roll up correctly. Mirrors
// resolveTopSteward() in app/api/bookmarks/route.ts so sub-steward/worker links
// roll UP to the top steward's interface.
function resolveTopSteward(sessionName) {
  if (typeof sessionName !== 'string') return '';
  const idx = sessionName.indexOf('--');
  return idx === -1 ? sessionName : sessionName.slice(0, idx);
}

function readStore() {
  if (!existsSync(CARD_LINKS_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CARD_LINKS_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  const dir = dirname(CARD_LINKS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CARD_LINKS_FILE, JSON.stringify(store, null, 2));
}

function getLinks(sessionName) {
  const store = readStore();
  const top = resolveTopSteward(sessionName);
  return store[top] || [];
}

// The originating WORKER for a link (Josh 2026-08-14: "if a worker did make
// it, I want to see the worker that was associated with it"). Links roll up to
// the top steward, but the FULL sessionName carries who actually made it. If
// the session is a sub-session (has a "--"), the suffix after the first "--" is
// the worker's branch/name; the bare top steward (no "--") is Josh's own
// steward / the presenter UI, which is NOT a worker → no attribution.
// Returns '' when there's no worker to attribute.
function workerSuffixOf(sessionName) {
  if (typeof sessionName !== 'string') return '';
  const idx = sessionName.indexOf('--');
  return idx === -1 ? '' : sessionName.slice(idx + 2);
}

/**
 * Append-merge a link into the top steward's collection. Deduped by url —
 * re-saving the same url updates the title (incoming wins) but PRESERVES the
 * original created_at, created_by (the FIRST worker, per Josh's pick), and any
 * last_opened already recorded. Returns { topStewardId, links } (the full
 * merged list). Never throws on bad input — returns null when there's nothing
 * valid to save.
 *
 * opts.source is the human-readable card source label (e.g.
 * "workers-row-chip-front worker") — stored alongside the raw worker suffix so
 * the renderer can show a friendly name and fall back to the suffix.
 */
function saveLink(sessionName, { title, url }, nowMs, opts) {
  const cleanUrl = typeof url === 'string' ? url.trim() : '';
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  if (!cleanUrl || !cleanTitle) return null;

  const top = resolveTopSteward(sessionName);
  if (!top) return null;

  const store = readStore();
  const list = Array.isArray(store[top]) ? store[top].slice() : [];
  const now = typeof nowMs === 'number' ? nowMs : Date.now();

  const existingIdx = list.findIndex((e) => e && e.url === cleanUrl);
  if (existingIdx !== -1) {
    // Living record: refresh title, keep created_at + created_by + last_opened.
    const prev = list[existingIdx];
    list[existingIdx] = {
      ...prev,
      title: cleanTitle,
      url: cleanUrl,
    };
  } else {
    // First save = the ONLY time we stamp the originating worker (Josh chose
    // "first worker that made it" — later re-saves by anyone else never change
    // it, mirroring created_at). Blank for bare top-steward / presenter links.
    const worker = workerSuffixOf(sessionName);
    const label = opts && typeof opts.source === 'string' ? opts.source.trim() : '';
    list.push({
      title: cleanTitle,
      url: cleanUrl,
      created_at: now,
      last_opened: null,
      created_by: worker || null,
      created_by_label: worker ? (label || null) : null,
    });
  }

  store[top] = list;
  writeStore(store);
  return { topStewardId: top, links: list, added: existingIdx === -1 };
}

/**
 * Would saving { title, url } into the top steward's collection collide with an
 * EXISTING link that has the SAME title but a DIFFERENT url? That's the case
 * Joshua wants blocked — two links you can't tell apart by name.
 *
 * NOT a collision (returns null):
 *   - same url (any title): that's a living-record refresh, handled by saveLink.
 *   - a different title: distinct name, fine.
 *
 * Title match is case-insensitive + trimmed so "Localhost" and "localhost " are
 * treated as the same name. Returns the colliding existing entry, or null.
 */
function findTitleCollision(sessionName, { title, url }) {
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanUrl = typeof url === 'string' ? url.trim() : '';
  if (!cleanTitle) return null;
  const top = resolveTopSteward(sessionName);
  if (!top) return null;
  const list = getLinks(top);
  const key = cleanTitle.toLowerCase();
  for (const e of list) {
    if (!e || typeof e.title !== 'string') continue;
    // Same url = refresh, never a collision.
    if (typeof e.url === 'string' && e.url.trim() === cleanUrl) continue;
    if (e.title.trim().toLowerCase() === key) return e;
  }
  return null;
}

/**
 * Record that a link was opened/clicked — updates last_opened. Matched by url
 * within the top steward's collection. Returns { topStewardId, links } or null.
 */
function touchLink(sessionName, url, nowMs) {
  const cleanUrl = typeof url === 'string' ? url.trim() : '';
  if (!cleanUrl) return null;
  const top = resolveTopSteward(sessionName);
  const store = readStore();
  const list = Array.isArray(store[top]) ? store[top].slice() : [];
  const idx = list.findIndex((e) => e && e.url === cleanUrl);
  if (idx === -1) return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  list[idx] = { ...list[idx], last_opened: now };
  store[top] = list;
  writeStore(store);
  return { topStewardId: top, links: list };
}

/**
 * Pin / unpin a link by url within the top steward's collection (Josh
 * 2026-09-09: the per-row three-dot menu offers exactly Remove and Pin/Unpin).
 * A pinned link is EXEMPT from the stale-link prune below — pinning is how
 * Joshua says "keep this one regardless of whether I ever click it".
 * Returns { topStewardId, links } or null when the url isn't in the collection.
 */
function setPinned(sessionName, url, pinned) {
  const cleanUrl = typeof url === 'string' ? url.trim() : '';
  if (!cleanUrl) return null;
  const top = resolveTopSteward(sessionName);
  const store = readStore();
  const list = Array.isArray(store[top]) ? store[top].slice() : [];
  const idx = list.findIndex((e) => e && e.url === cleanUrl);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], pinned: !!pinned };
  store[top] = list;
  writeStore(store);
  return { topStewardId: top, links: list };
}

// A link that has NEVER been opened and was created more than a week ago is
// dead weight (Josh 2026-09-09, verbatim: "if a link isn't clicked on in a
// week... it's just cleared from the list... I don't necessarily just want it
// to be a visual clearing... it would be great if it was like actually
// removed"). So this is a REAL delete from the store, not a render-time filter.
const STALE_LINK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Would this link survive the prune? Three ways to stay:
 *   - it has EVER been opened (last_opened set) — Josh: "anything that has ever
 *     been clicked on, that stays";
 *   - it is pinned — Josh: "anything that's pinned, that stays";
 *   - it is younger than a week.
 * A record with no created_at is KEPT: we can't prove it's old, and silently
 * deleting an unmeasurable record is the wrong side to err on.
 */
function isLinkKeepable(link, nowMs) {
  if (!link || typeof link !== 'object') return false; // drop junk entries
  if (link.last_opened) return true;
  if (link.pinned) return true;
  if (typeof link.created_at !== 'number') return true;
  return (nowMs - link.created_at) <= STALE_LINK_MAX_AGE_MS;
}

/**
 * Prune never-clicked, unpinned, week-old links across EVERY steward.
 *
 * `opts.dryRun` computes the exact same verdict but writes nothing — that's how
 * a count gets reported before a destructive run (the first run is confirmed by
 * Joshua; after that it rides the recurring scheduler unattended).
 *
 * Returns { removed, kept, before, dryRun, perSteward: { id: {before,removed,after} } }.
 */
function pruneStaleLinks(opts) {
  const dryRun = !!(opts && opts.dryRun);
  const now = (opts && typeof opts.nowMs === 'number') ? opts.nowMs : Date.now();
  const store = readStore();
  const perSteward = {};
  let before = 0;
  let removed = 0;

  for (const stewardId of Object.keys(store)) {
    const list = Array.isArray(store[stewardId]) ? store[stewardId] : [];
    const keep = list.filter((e) => isLinkKeepable(e, now));
    before += list.length;
    const gone = list.length - keep.length;
    removed += gone;
    if (gone > 0) {
      perSteward[stewardId] = { before: list.length, removed: gone, after: keep.length };
      if (!dryRun) store[stewardId] = keep;
    }
  }

  if (!dryRun && removed > 0) writeStore(store);
  return { removed, kept: before - removed, before, dryRun, perSteward };
}

/**
 * Forget (delete) a single link by url from the top steward's collection, or
 * the entire collection when no url is given. Returns { topStewardId, links }.
 */
function forgetLink(sessionName, url) {
  const top = resolveTopSteward(sessionName);
  const store = readStore();
  if (!store[top]) return { topStewardId: top, links: [] };
  if (url) {
    store[top] = store[top].filter((e) => e && e.url !== url);
  } else {
    delete store[top];
  }
  writeStore(store);
  return { topStewardId: top, links: store[top] || [] };
}

module.exports = {
  CARD_LINKS_FILE,
  resolveTopSteward,
  readStore,
  writeStore,
  getLinks,
  saveLink,
  findTitleCollision,
  touchLink,
  setPinned,
  isLinkKeepable,
  pruneStaleLinks,
  STALE_LINK_MAX_AGE_MS,
  forgetLink,
};
