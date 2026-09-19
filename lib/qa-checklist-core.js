/**
 * QA checklist store + SEND-TIME validation.
 *
 * The whole point of this module is the validation. A rule saying "link the
 * exact page, don't drop sections" already existed in prose for months and the
 * worker that broke it had never read it. Prose does not enforce. This does:
 * a checklist that violates either rule is REJECTED at POST time with an
 * actionable reason, so the worker fixes it before Josh ever sees it.
 *
 * Storage is server-side (data/qa-checklists.json) because Josh's ticks must
 * survive across devices. chrome.storage.local is profile-bound and .sync is
 * Chrome-account-bound; neither satisfies "keeps his place on any device".
 */

const { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } = require('fs');
const { join, dirname } = require('path');
const crypto = require('crypto');

const STORE_FILE = join(process.cwd(), 'data/qa-checklists.json');

// ---------------------------------------------------------------------------
// Rule 1: every step URL must be the DEEP url of the thing to test.
// ---------------------------------------------------------------------------

/**
 * A URL is "bare origin" when it carries no path, no query and no fragment --
 * i.e. it drops Josh at a site's front door and makes him go hunting. That is
 * the exact failure that triggered this tool ("doesnt take me to the exact
 * event with the exact like downloads").
 *
 * Returns null when fine, or a human-readable reason when it should be refused.
 */
function bareOriginReason(rawUrl) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) return 'has no link at all — every step needs the exact page to test';

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not a usable link`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `"${url}" is not a web link Josh can open from his phone`;
  }

  // A machine-local host is dead the moment Josh is not at that machine. The
  // checklist SURFACE is desktop Chrome, but the links inside a step are not:
  // he routinely taps one and carries on from his phone. Use the deployed site,
  // or the Tailscale hostname (joshuas-macbook-air.tail84bb3b.ts.net) for
  // something only this machine serves.
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
  if (LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    return `"${url}" only works on the machine it is running on. Josh may tap this from his phone — use the deployed site, or the Tailscale hostname (joshuas-macbook-air.tail84bb3b.ts.net) if only this machine serves it.`;
  }

  const path = parsed.pathname || '/';
  const hasPath = path !== '/' && path !== '';
  const hasQuery = !!parsed.search && parsed.search !== '?';
  const hasHash = !!parsed.hash && parsed.hash !== '#';

  if (!hasPath && !hasQuery && !hasHash) {
    return `"${url}" is a site root, not the exact page to test. Link the deep URL of the specific thing — the actual event/order/record page, not the front door.`;
  }

  // A path that is only an index-ish landing page is the same failure wearing
  // a path. These are the front doors people reach for when they don't have
  // the real deep link yet.
  const INDEX_PATHS = new Set([
    '/index.html', '/home', '/dashboard', '/events', '/admin', '/app', '/main',
  ]);
  const normalized = path.replace(/\/+$/, '').toLowerCase() || '/';
  if (!hasQuery && !hasHash && INDEX_PATHS.has(normalized)) {
    return `"${url}" is a landing page, not the exact page to test. Link straight to the specific item Josh should look at.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// A step that promises Josh a file must actually deliver it.
// ---------------------------------------------------------------------------

/**
 * Catches "here's a file, go find it" -- a step that tells Josh to use a
 * SUPPLIED file while attaching none. He is usually on his phone with nothing
 * to open, so that is the front-door failure one layer up.
 *
 * Deliberately narrow. It must NOT fire on a file the APP produces, which is
 * the preferred pattern ("tap Export and a spreadsheet downloads", "use Get
 * Template"). Those steps need no attachment because the file is one tap away
 * on the screen he is already on.
 */
function promisedFileReason(step) {
  if (!step) return null;
  if (Array.isArray(step.files) && step.files.length > 0) return null;

  const text = `${step.label || ''} ${step.detail || ''}`.toLowerCase();

  // Phrases that only make sense when a file is being HANDED to him.
  const SUPPLIED = [
    'attached file', 'the attached', 'attachment',
    'file i attached', 'file provided', 'provided file',
    'use the file', 'this file', 'the supplied', 'supplied file',
    'file below', 'downloaded file i', 'sample file', 'test file',
  ];
  if (!SUPPLIED.some((p) => text.includes(p))) return null;

  // ...unless the step ALSO says where the file comes from inside the app, in
  // which case it is app-produced and needs no attachment.
  const APP_PRODUCED = [
    'export', 'get template', 'download the template', 'template button',
    'downloads from', 'the app gives', 'tap download',
  ];
  if (APP_PRODUCED.some((p) => text.includes(p))) return null;

  return 'tells Josh to use a file but no file is attached. Attach it (POST the file to /api/qa-checklists/files (multipart, field "file") and put the returned entry in the step\'s "files"), or reword the step to get the file from inside the app (an Export or Get Template button). He is usually on his phone — a file he has to go find does not reach him.';
}

// ---------------------------------------------------------------------------
// Rule 2: an update must never DROP sections that the prior version had.
// ---------------------------------------------------------------------------

/**
 * Checklists ACCUMULATE. A steward sending v2 that silently omits sections
 * from v1 is the "dropped all previously accumulated test sections" bug.
 * Returns null when fine, or a reason naming the dropped sections.
 */
function droppedSectionsReason(priorSections, incomingSections) {
  if (!Array.isArray(priorSections) || priorSections.length === 0) return null;
  const incomingTitles = new Set(
    (incomingSections || []).map((s) => normalizeTitle(s && s.title))
  );
  const dropped = priorSections
    .map((s) => s && s.title)
    .filter((t) => t && !incomingTitles.has(normalizeTitle(t)));

  if (dropped.length === 0) return null;

  const list = dropped.map((t) => `"${t}"`).join(', ');
  return `this update DROPS ${dropped.length} section(s) that were already on the checklist: ${list}. Checklists accumulate — resend including every prior section. If a section is genuinely obsolete, mark it retired instead of omitting it.`;
}

function normalizeTitle(t) {
  return String(t == null ? '' : t).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Validation entry point -- called at SEND time, not review time.
// ---------------------------------------------------------------------------

/**
 * Validates an incoming checklist against the prior stored version.
 * Returns { ok: true, sections } or { ok: false, errors: [...] }.
 */
function validateChecklist(incoming, prior) {
  const errors = [];

  const title = typeof incoming.title === 'string' ? incoming.title.trim() : '';
  if (!title) errors.push('Missing a title — name what this checklist is for.');

  const steward = typeof incoming.steward === 'string' ? incoming.steward.trim() : '';
  if (!steward) errors.push('Missing "steward" — the checklist has to say who it is from, because Josh\'s tray groups by sender.');

  // The "yeet me there" link. Opening the checklist should drop Josh straight
  // onto the screen he is meant to QA -- not a front door he has to navigate
  // from. Held to the same deep-link standard as every step.
  const rawStart = typeof incoming.start_url === 'string' ? incoming.start_url.trim() : '';
  if (!rawStart) {
    errors.push('Missing "start_url". This is the link that drops Josh straight onto the screen he is meant to test — give the deep URL of the exact page, already signed in and set up if you can.');
  } else {
    const startReason = bareOriginReason(rawStart);
    if (startReason) {
      errors.push(`The checklist's start_url ${startReason} This is the one link Josh definitely taps, so it has to land him exactly on the screen to test.`);
    }
  }

  const sections = Array.isArray(incoming.sections) ? incoming.sections : [];
  if (sections.length === 0) {
    errors.push('No sections. A checklist needs at least one section with at least one step.');
  }

  sections.forEach((section, si) => {
    const sTitle = section && typeof section.title === 'string' ? section.title.trim() : '';
    if (!sTitle) errors.push(`Section ${si + 1} has no title.`);
    const steps = section && Array.isArray(section.steps) ? section.steps : [];
    if (steps.length === 0) {
      errors.push(`Section "${sTitle || si + 1}" has no steps.`);
    }
    steps.forEach((step, ti) => {
      const label = step && typeof step.label === 'string' ? step.label.trim() : '';
      const where = `Section "${sTitle || si + 1}", step ${ti + 1}`;
      if (!label) errors.push(`${where} has no description of what to check.`);
      // THE rule. Every step must carry the deep URL of the thing to test.
      const reason = bareOriginReason(step && step.url);
      if (reason) {
        errors.push(`${where} ${reason}`);
      }
      // A step that TELLS Josh to use a file must actually deliver one.
      // "here's a file, go find it" is the same failure as a front-door link,
      // one layer up -- he is on his phone with nothing to open.
      const fileReason = promisedFileReason(step);
      if (fileReason) errors.push(`${where} ${fileReason}`);
    });
  });

  // Accumulation rule, only meaningful when there IS a prior version.
  if (prior) {
    const dropReason = droppedSectionsReason(prior.sections, sections);
    if (dropReason) errors.push(`REJECTED: ${dropReason}`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Merge: PRESERVE-AND-FLAG. A steward update never wipes Josh's ticks.
// ---------------------------------------------------------------------------

/**
 * Stable identity for a step so ticks survive re-ordering and re-wording of
 * OTHER steps. Explicit `id` wins; otherwise the identity is the section title
 * plus the step URL, which is the thing being tested.
 */
function stepKey(sectionTitle, step) {
  const rawId = step && typeof step.id === 'string' ? step.id.trim() : '';
  if (rawId) {
    // mergeChecklist() persists the derived key back into `step.id`, so on the
    // NEXT update that stored step would otherwise key as `id:su:...` while the
    // incoming step keys as `su:...` -- they'd never match and Josh's ticks
    // would silently reset on the second update. Treat an id that is already a
    // derived key as that key, so the identity is stable across any number of
    // round-trips.
    if (rawId.startsWith('su:') || rawId.startsWith('id:')) return rawId;
    return `id:${rawId}`;
  }
  const url = step && typeof step.url === 'string' ? step.url.trim() : '';
  return `su:${normalizeTitle(sectionTitle)}::${url}`;
}

/**
 * A step's "substance" -- what a steward could change that should make Josh
 * look again. If this hash changes, we KEEP his tick but raise `changed`, so
 * the tray shows it as "you ticked this, but it changed — re-check".
 */
function substanceHash(step) {
  const basis = JSON.stringify({
    label: String((step && step.label) || '').trim(),
    url: String((step && step.url) || '').trim(),
    detail: String((step && step.detail) || '').trim(),
    files: (Array.isArray(step && step.files) ? step.files : [])
      .map((f) => `${f && f.name}:${f && f.url}`).join('|'),
  });
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

/**
 * Merge an incoming (already validated) checklist over the prior version.
 *
 * PRESERVE-AND-FLAG:
 *   - Josh's `checked` and `dismissed` are carried forward by step identity.
 *   - If the step's substance changed while checked, `changed_since_checked`
 *     is set so the tray can flag it for re-check. His tick is NOT cleared --
 *     wiping his verification work wholesale is the thing we're preventing.
 */
function mergeChecklist(incoming, prior) {
  const priorByKey = new Map();
  if (prior && Array.isArray(prior.sections)) {
    for (const section of prior.sections) {
      for (const step of section.steps || []) {
        priorByKey.set(stepKey(section.title, step), { step, sectionTitle: section.title });
      }
    }
  }

  const sections = (incoming.sections || []).map((section) => {
    const steps = (section.steps || []).map((step) => {
      const key = stepKey(section.title, step);
      const priorEntry = priorByKey.get(key);
      const hash = substanceHash(step);

      const base = {
        id: (step.id && String(step.id).trim()) || key,
        label: String(step.label || '').trim(),
        url: String(step.url || '').trim(),
        detail: step.detail ? String(step.detail).trim() : undefined,
        // Attached test fixtures: [{ name, url, size }]. Served over HTTP so
        // they download on whatever device Josh is holding.
        files: Array.isArray(step.files) ? step.files : undefined,
        substance: hash,
        checked: false,
        checked_at: null,
        dismissed: false,
        changed_since_checked: false,
      };

      if (!priorEntry) return base;

      const p = priorEntry.step;
      const wasChecked = !!p.checked;
      const substanceChanged = p.substance !== hash;

      return {
        ...base,
        // PRESERVE — Josh's verification work is never wiped by a steward update.
        checked: wasChecked,
        checked_at: p.checked_at || null,
        dismissed: !!p.dismissed,
        // FLAG — but tell him it moved under him.
        changed_since_checked: wasChecked && substanceChanged,
      };
    });

    return {
      title: String(section.title || '').trim(),
      note: section.note ? String(section.note).trim() : undefined,
      steps,
    };
  });

  return sections;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function readStore() {
  if (!existsSync(STORE_FILE)) return { checklists: {} };
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return { checklists: {} };
    if (!parsed.checklists || typeof parsed.checklists !== 'object') parsed.checklists = {};
    return parsed;
  } catch {
    return { checklists: {} };
  }
}

/**
 * Atomic write. The presenter queue has been wedged before by torn reads from
 * non-atomic multi-writer JSON, so write to a temp file in the same directory
 * and rename over the target.
 */
function writeStore(store) {
  const dir = dirname(STORE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STORE_FILE}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, STORE_FILE);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'checklist';
}

module.exports = {
  bareOriginReason,
  promisedFileReason,
  droppedSectionsReason,
  validateChecklist,
  mergeChecklist,
  stepKey,
  substanceHash,
  readStore,
  writeStore,
  slugify,
  STORE_FILE,
};
