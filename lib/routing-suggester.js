/**
 * Routing Suggester (SUGGEST-CONFIRM — annotate only, NEVER auto-forward)
 *
 * PURPOSE — before a notification reaches holler-alfred, match its sender against
 * Alfred's routing table and add a `suggested_steward` HINT (plus the matched
 * `topic`/`note`). Alfred STILL makes the final forward call — this module never
 * forwards, never changes target_session, never drops/filters a notification. It
 * only ANNOTATES.
 *
 * OWNERSHIP: Alfred OWNS the table data (routing-table.json); Rooster (this module)
 * owns the matcher code. Alfred edits table rows LIVE and they must take effect
 * WITHOUT a redeploy — so the table is READ FRESH ON EVERY CALL (no module-level
 * cache). If the file is missing or malformed, we FAIL OPEN: return null so the
 * notification still delivers un-annotated, and never throw.
 *
 * THE TABLE: <<REPLACE: your home dir, e.g. /Users/you>>/.homestead/stewards/alfred/knowledge/routing-table.json
 *   rules[] each have: id, match{names[], phones[], emails[], github_repos[]},
 *   suggested_steward, topic, note?
 *   Match precedence (per the table's _doc): exact phone/email > slack workspace/
 *   channel > name substring. FIRST MATCH WINS.
 *
 * NOTIFICATION SHAPES — two live shapes flow through the pipeline, and this matcher
 * handles BOTH by reading a UNION of their sender/body fields:
 *   • phone: { source:'phone', title, text, bigText, subText, packageName, appName }
 *   • gmail: { source:'gmail', from, subject, snippet }  ← CI-failure emails (the QB
 *     extension one) are gmail entries; their repo/email lives in from/subject/snippet,
 *     NOT title/text. Matching only title/text would MISS every CI email.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Alfred owns this file; read-only for us. Override with ROUTING_TABLE_PATH (tests).
const ROUTING_TABLE_PATH =
  process.env.ROUTING_TABLE_PATH ||
  path.join(
    os.homedir(),
    '.homestead',
    'stewards',
    'alfred',
    'knowledge',
    'routing-table.json'
  );

// Read the table FRESH every call — no module-level cache. Alfred edits rows live and
// they must take effect without a redeploy/restart. Missing or malformed → return null
// (fail-open) so the caller delivers the notification un-annotated. Never throws.
function loadTable() {
  try {
    const raw = fs.readFileSync(ROUTING_TABLE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.rules)) return parsed.rules;
  } catch {
    // missing file, unreadable, or malformed JSON → fail open
  }
  return null;
}

// Normalize a phone number to its trailing 10 digits (US) for matching.
// "(574) 532-9504", "+15745329504", "<<REPLACE: a phone number>>" all collapse to "5745329504".
// Mirrors message-history-store.js normalizeNumber (kept local so this module has no
// cross-dependency on that store).
function normalizeNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  if (digits.length > 0) return digits;
  return null;
}

// Collect the SENDER-identity strings from a notification (union of both shapes).
// These are where a NAME lives (the conversation title / email From line).
function senderStrings(n) {
  if (!n) return [];
  return [n.title, n.from, n.subText, n.appName].filter(
    (s) => typeof s === 'string' && s.trim()
  );
}

// Collect the BODY strings from a notification (union of both shapes). Names can also
// appear here as a fallback; emails/repos in CI mail live in subject+snippet+bigText.
function bodyStrings(n) {
  if (!n) return [];
  return [n.text, n.bigText, n.subject, n.snippet].filter(
    (s) => typeof s === 'string' && s.trim()
  );
}

// One lowercased haystack of everything (sender + body) — for substring scans
// (github_repo, email-in-body, name fallback).
function fullHaystack(n) {
  return [...senderStrings(n), ...bodyStrings(n)]
    .join(' \n ')
    .toLowerCase();
}

// Extract candidate phone numbers from the sender identity. Phone-shaped titles
// (Google Messages uses the raw number when a contact isn't saved) and email From
// lines are the realistic carriers of a matchable number.
function candidateNumbers(n) {
  const nums = [];
  for (const s of senderStrings(n)) {
    const num = normalizeNumber(s);
    if (num && num.length === 10) nums.push(num);
  }
  return nums;
}

// Extract candidate email addresses. The From line carries the sender's address; CI /
// forwarded mail can also embed the real address in the body, so scan body too.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
function candidateEmails(n) {
  const emails = new Set();
  for (const s of [...senderStrings(n), ...bodyStrings(n)]) {
    const matches = String(s).match(EMAIL_RE);
    if (matches) for (const m of matches) emails.add(m.toLowerCase());
  }
  return emails;
}

// ── Per-dimension matchers. Each returns true if `rule` matches `n` on that dimension.

function matchesPhone(rule, n) {
  const rulePhones = (rule.match && rule.match.phones) || [];
  if (!rulePhones.length) return false;
  const wanted = new Set(rulePhones.map(normalizeNumber).filter(Boolean));
  if (!wanted.size) return false;
  return candidateNumbers(n).some((num) => wanted.has(num));
}

function matchesEmail(rule, n) {
  const ruleEmails = (rule.match && rule.match.emails) || [];
  if (!ruleEmails.length) return false;
  const wanted = new Set(
    ruleEmails.map((e) => String(e).toLowerCase().trim()).filter(Boolean)
  );
  if (!wanted.size) return false;
  const have = candidateEmails(n);
  for (const e of have) if (wanted.has(e)) return true;
  return false;
}

function matchesGithubRepo(rule, n) {
  const repos = (rule.match && rule.match.github_repos) || [];
  if (!repos.length) return false;
  const hay = fullHaystack(n);
  return repos.some((repo) => {
    const needle = String(repo).toLowerCase().trim();
    return needle && hay.includes(needle);
  });
}

// Slack workspace/channel substring. Table has no slack rows yet, but the dimension is
// wired so Alfred can add rows keyed on workspace/channel (which Slack surfaces in
// subText/title). We reuse names[] as the slack-token source ONLY when the rule has no
// other match dimensions AND explicitly declares slack tokens; to keep it simple and
// avoid overlap with the name dimension, we look for an optional `slack[]` array.
function matchesSlack(rule, n) {
  const tokens = (rule.match && rule.match.slack) || [];
  if (!tokens.length) return false;
  const hay = [n && n.subText, n && n.title, n && n.appName]
    .filter((s) => typeof s === 'string' && s.trim())
    .join(' \n ')
    .toLowerCase();
  return tokens.some((t) => {
    const needle = String(t).toLowerCase().trim();
    return needle && hay.includes(needle);
  });
}

function matchesName(rule, n) {
  const names = (rule.match && rule.match.names) || [];
  if (!names.length) return false;
  // Prefer sender-identity strings; fall back to the full body.
  const senderHay = senderStrings(n).join(' \n ').toLowerCase();
  const bodyHay = bodyStrings(n).join(' \n ').toLowerCase();
  return names.some((name) => {
    const needle = String(name).toLowerCase().trim();
    if (!needle) return false;
    return senderHay.includes(needle) || bodyHay.includes(needle);
  });
}

// ── App-level exclusion (optional `exclude_apps[]` on a rule).
//
// WHY: a name can be BOTH a work contact and a personal one. "Sarah Webber" is Josh's
// sister — Google Messages builds group-thread TITLES from participant names, so her
// name lands in the sender identity of every family text she's in — AND separately a
// GiveGrove bug reporter. Without this guard the givegrove rule fires on family SMS.
// Her real GG reports arrive via email/Slack, never via Messages.
//
// SEMANTICS: if the notification's packageName OR appName matches ANY entry in
// exclude_apps, the rule is suppressed on EVERY dimension (not just name) — hence the
// guard sits at the top of the rules loop rather than inside a single matcher.
// Backward compatible: absent/empty/non-array exclude_apps → never excludes.
// Inert for gmail-shaped notifications (no packageName/appName), which is correct:
// Sarah's GiveGrove EMAILS still route to givegrove.
function excludedByApp(rule, n) {
  const excluded = rule && rule.match && Array.isArray(rule.match.exclude_apps)
    ? rule.match.exclude_apps
    : Array.isArray(rule && rule.exclude_apps)
    ? rule.exclude_apps
    : [];
  if (!excluded.length) return false;
  if (!n) return false;
  // `app` is REQUIRED here, not redundant. The 5-min backstop cron rebuilds each
  // notification as { source, app, title, text, key } (check-notifications.js ~383,
  // `app: n.packageName || n.app`) and DROPS packageName entirely, while the
  // real-time push path forwards the raw phone payload with packageName intact.
  // Reading only packageName/appName meant exclude_apps was silently inert on the
  // backstop path: same rule, same app string, excluded=true on push and FALSE on
  // backstop (verified with both object shapes). That let a family SMS from a
  // contact who is BOTH Josh's sister AND a GiveGrove bug reporter get tagged
  // GiveGrove — the exact misfire the exclusion was added to prevent.
  // (Alfred-flagged 2026-09-17; the same row had already misfired 2026-08-29.)
  const have = [n.packageName, n.appName, n.app]
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim().toLowerCase());
  if (!have.length) return false;
  const wanted = new Set(
    excluded
      .filter((a) => typeof a === 'string')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)
  );
  return have.some((h) => wanted.has(h));
}

// Precedence order — highest first. First rule that matches on the highest-precedence
// AVAILABLE dimension wins. We walk dimensions outer, rules inner: a phone match on ANY
// rule beats an email match on any rule, which beats github, then slack, then name.
// (Per the table _doc: exact phone/email > slack > name; github sits with the other
// exact-identity dims above slack/name.)
const DIMENSIONS = [
  matchesPhone,
  matchesEmail,
  matchesGithubRepo,
  matchesSlack,
  matchesName,
];

/**
 * Match a notification against Alfred's routing table.
 *
 * @param {object} notification  phone- or gmail-shaped notification (see header)
 * @returns {{suggested_steward, topic, note, matched_rule_id}|null}
 *   null when: no table / parse error / no rule matches.
 */
function suggestSteward(notification) {
  if (!notification) return null;
  const rules = loadTable();
  if (!rules) return null; // fail-open: missing/malformed table

  for (const dimensionMatches of DIMENSIONS) {
    for (const rule of rules) {
      if (!rule || !rule.match) continue;
      // Suppress this rule entirely for excluded apps, on every dimension.
      if (excludedByApp(rule, notification)) continue;
      if (dimensionMatches(rule, notification)) {
        return {
          suggested_steward: rule.suggested_steward || null,
          topic: rule.topic || null,
          note: rule.note || null,
          matched_rule_id: rule.id || null,
        };
      }
    }
  }
  return null;
}

module.exports = {
  suggestSteward,
  // exported for tests / potential reuse
  normalizeNumber,
  excludedByApp,
  ROUTING_TABLE_PATH,
};
