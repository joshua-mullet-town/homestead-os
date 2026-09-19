/**
 * Card link scanner — the title-gate for auto-saved card links.
 *
 * Every presenter card that flows through addItem() is scanned here for a URL.
 * The contract (locked by Scribe, do not re-litigate):
 *
 *   - NO url anywhere in the card            → { found: false }. Card passes
 *                                              UNTOUCHED. This is the huge
 *                                              majority of cards.
 *   - url WITH a human label immediately
 *     associated                             → { found: true, saved: {title,url} }.
 *                                              Auto-saved + pinned into the
 *                                              card-links interface.
 *   - url that is BARE/NAKED (raw http(s)://
 *     token, no descriptive text preceding
 *     it in its segment, no owning labeled
 *     construct)                             → { reject: true, reason:'naked_url' }.
 *                                              HARD reject — remake WITH a title.
 *   - url whose label is LAZY / host-ish
 *     (localhost, 127.0.0.1, a bare host,
 *     IP, *.ts.net host, host:port, or the
 *     URL's own hostname)                    → { reject: true, reason:'lazy_label' }.
 *                                              HARD reject — the label names the
 *                                              SURFACE not the CONTENT. Remake
 *                                              naming the link by what it IS.
 *
 * A URL is LABELED (passes) if ANY of:
 *   (1) markdown [label](url) in title/message,
 *   (2) "Label: url" or "Label - url" where descriptive non-URL text precedes
 *       the URL on the same line/segment,
 *   (3) a button { label, url|run } whose label is non-empty and not itself a URL.
 *
 * REJECT only when a URL is present but BARE — none of the above own it.
 *
 * The scanner is deterministic and side-effect-free so it can be unit-tested
 * in isolation. Persistence + broadcast live in the callers.
 */

// Matches an http/https URL token. Intentionally simple — we only need to
// detect presence and carve the token, not fully validate every RFC edge.
const URL_RE = /https?:\/\/[^\s<>()\[\]"']+/i;
const URL_RE_G = /https?:\/\/[^\s<>()\[\]"']+/gi;
// Markdown link: [label](url). label must be non-empty and not solely a URL.
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/i;
const MARKDOWN_LINK_RE_G = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;

// --- FIX 2: scheme-less URLs (www.example.com/report, github.com/foo/bar) ---
//
// A bare host WITHOUT an http(s):// scheme is still a link a steward can attach
// (and a link Joshua can click), so it must go through the same title gate. But
// this gate runs on EVERY card, so scheme-less detection is deliberately
// conservative to avoid flagging ordinary prose that merely names a domain:
//
//   - "www." prefix              → always a link (www.example.com, www.foo.io/x)
//   - host with a real TLD tail
//     AND a "/path"              → a link (github.com/foo/bar, example.com/report)
//   - a bare host with no path   → NOT flagged (a domain mentioned in prose like
//     (example.com, acme.io)        "we use acme.io internally" is left alone)
//
// The real-TLD requirement (hasHostTail) is what keeps "node.js docs",
// "design.doc" etc. from being seen as links — same discriminator the lazy-label
// gate uses. Matches are normalized to https:// downstream so all existing
// labeling / lazy-label / hostname logic works unchanged.
//
// Host grammar: dotted labels of [a-z0-9-], each label 1+ chars. Optional :port.
// A "www." token allows an optional path; a non-www token REQUIRES a "/path".
const SCHEMELESS_HOST = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+';
const SCHEMELESS_PORT = '(?::\\d+)?';
const SCHEMELESS_PATH = '(?:[/?#][^\\s<>()\\[\\]"\']*)';
// www.host[:port][/path]  |  host[:port]/path   (path required when not www.)
const SCHEMELESS_URL_RE_G = new RegExp(
  `(?:^|[\\s>:\\-–—•*#|(\\[])` +                // preceding boundary (not part of a scheme)
    `(www\\.${SCHEMELESS_HOST}${SCHEMELESS_PORT}${SCHEMELESS_PATH}?` +
    `|${SCHEMELESS_HOST}${SCHEMELESS_PORT}${SCHEMELESS_PATH})`,
  'gi'
);

// Pull scheme-less URL tokens out of a text blob, each normalized to https://.
// Skips any token that overlaps an http(s):// URL already present (so we never
// double-count "http://x.com/y" as a scheme-less "x.com/y"). Returns an array of
// { raw, normalized } where `raw` is the exact token as written (for label
// detection against the original text) and `normalized` has the https:// prefix.
function schemelessUrlsIn(text) {
  if (typeof text !== 'string' || !text) return [];
  // Blank out real http(s):// URLs first so the scheme-less scan can't see their
  // hosts (e.g. the "example.com/x" inside "https://example.com/x").
  const masked = text.replace(URL_RE_G, (m) => ' '.repeat(m.length));
  const out = [];
  let m;
  const re = new RegExp(SCHEMELESS_URL_RE_G.source, 'gi');
  while ((m = re.exec(masked)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    // A www.-prefixed host is always a link; otherwise require a real TLD tail.
    const host = bareHostOf(raw);
    const isWww = /^www\./i.test(raw.replace(/^https?:\/\//, ''));
    if (!isWww && !hasHostTail(host)) continue;
    out.push({ raw, normalized: `https://${raw.replace(/^https?:\/\//, '')}` });
  }
  return out;
}

function isUrl(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  // A "pure URL" is a single token that is itself a URL (no descriptive words).
  return /^https?:\/\/\S+$/i.test(t);
}

// A bare host token: hostname / IP / tailscale host, optionally with :port and a
// leading scheme, but NO descriptive words. These are the "surface" of a link,
// never its content.
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// hostname made only of dotted labels (letters/digits/hyphens) — e.g.
// "localhost", "joshuas-macbook-air.tail84bb3b.ts.net", "api.example.com".
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

// A dotted label is only host-ish if its TAIL is a real public TLD or a known
// infra tail (tailscale). This is the discriminator that separates a host
// ("api.example.com" → .com) from dotted CONTENT ("design.doc", "v2.1-notes",
// "gh-1397.review", "node.js-upgrade" → .doc/.1-notes/.review/.js-upgrade, none
// of which are TLDs). Grammar alone ("dotted labels of [a-z0-9-]") CANNOT tell
// these apart — the tail is what makes it a host. Kept deliberately tight: a
// curated common-TLD set, not the full IANA list, so novel dotted content
// (the common case for versioned/ticketed names) always passes.
const COMMON_TLDS = new Set([
  'com', 'net', 'org', 'io', 'dev', 'app', 'co', 'ai', 'gov', 'edu', 'mil',
  'info', 'biz', 'me', 'us', 'uk', 'ca', 'de', 'fr', 'jp', 'au', 'cloud',
  'xyz', 'tech', 'site', 'online', 'local', 'internal', 'lan', 'test',
]);

// Does this bare host end in a recognized public TLD or the tailscale tail?
function hasHostTail(host) {
  if (typeof host !== 'string' || !host.includes('.')) return false;
  if (host.endsWith('.ts.net')) return true; // tailscale magic-DNS host
  const lastDot = host.lastIndexOf('.');
  const tld = host.slice(lastDot + 1);
  return COMMON_TLDS.has(tld);
}

// Strip a leading scheme, a trailing :port, and any path/query so we can test
// whether what remains is a bare host. Returns the bare host token (lowercased)
// or '' if the input isn't host-shaped.
function bareHostOf(token) {
  if (typeof token !== 'string') return '';
  let t = token.trim().toLowerCase();
  if (!t) return '';
  t = t.replace(/^https?:\/\//, '');
  // Drop anything from the first path/query/hash separator onward.
  t = t.replace(/[/?#].*$/, '');
  // Drop a trailing :port.
  t = t.replace(/:\d+$/, '');
  return t;
}

// The "surface" host of a URL — its hostname, lowercased. Used to catch the
// worst lazy case: labeling a link with the exact host it points at.
function urlHostname(url) {
  const bare = bareHostOf(url);
  return bare;
}

/**
 * Is this label LAZY — i.e. it describes the link's SURFACE/HOST rather than its
 * CONTENT/PURPOSE? A lazy label makes every link on the same host indistinguishable
 * (the crowne-vault "localhost" x3 incident). Rejected the same way a naked link is.
 *
 * A label is lazy when, after trimming, it is host-ish:
 *   - localhost / 127.0.0.1 / 0.0.0.0 (with or without a scheme or :port)
 *   - a bare IPv4 address
 *   - a bare hostname (single label like "localhost" OR dotted like a *.ts.net host)
 *   - a bare host:port (e.g. "localhost:8947")
 *   - the URL's own hostname used verbatim as the label
 *
 * It is NOT lazy when it contains real descriptive words. "CV Approach Plan",
 * "Volume Strategy Deep-Dive", "the pull request" all pass — they name content.
 * The discriminator: strip the host shape; if what's left is a real word (not a
 * host token), it's a content label.
 */
function isLazyLabel(label, url) {
  if (typeof label !== 'string') return false;
  const t = label.trim();
  if (!t) return false;
  const lower = t.toLowerCase();

  // Never treat a multi-word label as lazy — a space means the steward wrote
  // descriptive text. (A hostname never contains spaces.)
  if (/\s/.test(t)) return false;

  const host = bareHostOf(t);

  // Explicit loopback / any-interface hosts.
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;

  // Bare IPv4.
  if (IPV4_RE.test(host)) return true;

  // The label is exactly the URL's own hostname (with or without port/scheme).
  if (url) {
    const urlHost = urlHostname(url);
    if (urlHost && host === urlHost) return true;
  }

  // A dotted hostname that is a REAL host: matches the hostname grammar AND ends
  // in a recognized public TLD or the tailscale tail. The tail check is what
  // discriminates a host ("api.example.com" → .com) from dotted CONTENT
  // ("design.doc", "v2.1-release-notes", "gh-1397.review" → not TLDs). Grammar
  // alone would over-reject every dotted content name; the TLD tail is the real
  // signal. Single-word content ("approach-plan", no dot) never reaches here.
  if (host.includes('.') && HOSTNAME_RE.test(host) && hasHostTail(host)) return true;

  // A single-token host:port with no dot (e.g. "localhost:8947" already caught
  // above via bareHostOf; "myhost:3000" caught here) — the original token had a
  // :port and the host part is a bare hostname.
  if (/^[^\s/]+:\d+$/.test(lower)) {
    const hp = lower.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    if (HOSTNAME_RE.test(hp)) return true;
  }

  return false;
}

function normalizeButtons(buttons) {
  if (!Array.isArray(buttons)) return [];
  return buttons.map((b) => {
    if (typeof b === 'string') return { label: b };
    if (b && typeof b === 'object') return { label: b.label, url: b.url, run: b.run };
    return {};
  });
}

// Split a text blob into segments that can each own (or fail to own) a URL.
// We split on newlines and on sentence-ish boundaries so that a labeled URL on
// one line doesn't "lend" its label to a naked URL on another.
function segmentsOf(text) {
  if (typeof text !== 'string' || !text) return [];
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Does this single segment carry descriptive, non-URL text that precedes the
// first URL in it? Handles the "Label: url" / "Label - url" branch, and more
// generally any words-before-the-url case. The text before the URL must
// contain at least one non-URL, non-punctuation word character.
function segmentLabelsUrl(segment) {
  const m = segment.match(URL_RE);
  if (!m) return null;
  const before = segment.slice(0, m.index);
  // Strip common separators/punctuation to see if real descriptive text remains.
  const descriptive = before.replace(/[\s:>\-–—•*#>|]+/g, ' ').trim();
  if (descriptive.length === 0) return null;
  // Guard: "descriptive" text that is itself just another URL doesn't count.
  if (isUrl(descriptive)) return null;
  return { url: m[0], label: descriptive };
}

/**
 * Scan a card for a URL and classify it.
 *
 * Returns one of:
 *   { found: false }                         — no URL; card passes untouched
 *   { found: true, saved: { title, url } }   — labeled URL; save + pin it
 *   { reject: true, reason, url }            — naked URL; hard reject
 *
 * When multiple URLs exist, a single labeled URL is enough to pass the card and
 * is what gets saved (first labeled URL wins). A card passes only if EVERY URL
 * present is labeled — a card mixing one labeled and one naked URL still
 * rejects on the naked one, because a naked link would otherwise be silently
 * dropped (never saved, never surfaced).
 */
function scanCardForLink({ title, message, buttons } = {}) {
  const titleStr = typeof title === 'string' ? title : '';
  const messageStr = typeof message === 'string' ? message : '';
  const btns = normalizeButtons(buttons);

  // Fast path: is there any URL anywhere at all? Covers http(s):// AND scheme-less
  // (www.x / host.tld/path) URLs in text, and both `url` and `run` on buttons.
  const btnUrlText = (b) =>
    `${typeof b.url === 'string' ? b.url : ''}\n${typeof b.run === 'string' ? b.run : ''}`;
  const anyUrlIn = (s) => URL_RE.test(s) || schemelessUrlsIn(s).length > 0;
  const hasUrlInText = anyUrlIn(titleStr) || anyUrlIn(messageStr);
  const hasUrlInButtons = btns.some((b) => anyUrlIn(btnUrlText(b)));
  if (!hasUrlInText && !hasUrlInButtons) {
    return { found: false };
  }

  const labeled = []; // { title, url }
  const naked = [];   // url strings
  const lazy = [];    // { title, url } — labeled, but the label is host-ish

  // Classify a (label, url) pair into labeled / lazy / naked.
  const classify = (label, url) => {
    if (label && !isUrl(label)) {
      if (isLazyLabel(label, url)) {
        lazy.push({ title: label, url });
      } else {
        labeled.push({ title: label, url });
      }
    } else {
      naked.push(url);
    }
  };

  // --- Branch 3: buttons ---
  // A button owns a link via EITHER its `url` field OR a URL embedded in its
  // `run` command (FIX 1: e.g. { label:'Watch Demo', run:'open http://…' } —
  // the single most common way stewards attach a link, previously unscanned).
  // The button's label titles whichever link it carries. Scheme-less URLs in
  // either field are caught too (FIX 2).
  for (const b of btns) {
    const label = typeof b.label === 'string' ? b.label.trim() : '';
    // Collect every URL this button references, http(s):// and scheme-less.
    const btnUrlSet = [];
    for (const field of [b.url, b.run]) {
      if (typeof field !== 'string' || !field) continue;
      const httpUrls = field.match(URL_RE_G) || [];
      for (const u of httpUrls) btnUrlSet.push(u.trim());
      for (const s of schemelessUrlsIn(field)) btnUrlSet.push(s.normalized);
    }
    for (const bUrl of btnUrlSet) classify(label, bUrl);
  }

  // --- Branch 1 + 2: text (title + message) ---
  for (const text of [titleStr, messageStr]) {
    if (!text) continue;

    // Track which URLs we've already accounted for via markdown, so the raw
    // scan below doesn't double-count them as naked.
    const claimed = new Set();

    // Branch 1: markdown [label](url)
    let md;
    const mdRe = new RegExp(MARKDOWN_LINK_RE_G.source, 'gi');
    while ((md = mdRe.exec(text)) !== null) {
      const label = (md[1] || '').trim();
      const url = (md[2] || '').trim();
      claimed.add(url);
      classify(label, url);
    }

    // Branch 2 + naked detection: walk each segment.
    for (const seg of segmentsOf(text)) {
      const segUrls = seg.match(URL_RE_G) || [];
      for (const u of segUrls) {
        if (claimed.has(u)) continue;
        // Is this specific URL labeled within its segment?
        const labelInfo = segmentLabelsUrl(seg);
        if (labelInfo && labelInfo.url === u) {
          classify(labelInfo.label, u);
        } else {
          naked.push(u);
        }
      }

      // FIX 2: scheme-less URLs (www.x / host.tld/path) in this segment. Uses the
      // same "descriptive text precedes the token" rule as http(s):// links: if
      // real words come before the token, the button/inline label owns it;
      // otherwise it's naked. The token is normalized to https:// for storage.
      //
      // FALSE-POSITIVE GUARD (segment-LEADING scheme-less token): a scheme-less
      // host — unlike an explicit http(s):// URL — is ALSO just how prose names a
      // site ("example.com/report shows the numbers", "metrics.app/dash confirms
      // it live"). When such a token LEADS its segment (no descriptive word
      // before it) but is IMMEDIATELY FOLLOWED BY PROSE (a space + real words),
      // it is a mention, not a link a steward is attaching — so it PASSES
      // untouched instead of hard-rejecting the whole card. It is only naked when
      // it is link-shaped through-and-through: the whole segment / token with
      // nothing but trailing punctuation after it. (This leniency is scoped to
      // scheme-less TEXT tokens; explicit http(s):// links and naked run-button /
      // copy links still hard-reject as before.)
      for (const { raw, normalized } of schemelessUrlsIn(seg)) {
        if (claimed.has(normalized)) continue;
        claimed.add(normalized);
        const idx = seg.indexOf(raw);
        const before = idx > 0 ? seg.slice(0, idx) : '';
        const descriptive = before.replace(/[\s:>\-–—•*#>|]+/g, ' ').trim();
        if (descriptive && !isUrl(descriptive)) {
          classify(descriptive, normalized);
          continue;
        }
        // No descriptive text before it. Is it link-shaped (the whole segment,
        // just trailing punctuation after) or a domain leading a prose sentence?
        const after = seg.slice(idx + raw.length);
        const trailingIsProse = /^\s+\S/.test(after) && !/^\s*[.,;:!?)”"']*\s*$/.test(after);
        if (trailingIsProse) {
          // "example.com/report shows the numbers" → a mention, not an attached
          // link. Un-claim so nothing downstream treats it as a URL; pass.
          claimed.delete(normalized);
          continue;
        }
        naked.push(normalized);
      }
    }
  }

  // If ANY URL is naked, reject — a naked link would otherwise never be saved
  // and silently vanish. Force the steward to give it a title.
  if (naked.length > 0) {
    return {
      reject: true,
      reason: 'naked_url',
      url: naked[0],
      nakedUrls: naked,
      // any labeled ones we found, for a more helpful error message
      labeledCount: labeled.length,
    };
  }

  // If ANY URL carries a LAZY host-ish label, reject — saving "localhost" x3
  // fills Joshua's Links list with indistinguishable entries. Force a content
  // name. (Checked after naked so a truly-missing title always wins the message.)
  if (lazy.length > 0) {
    return {
      reject: true,
      reason: 'lazy_label',
      url: lazy[0].url,
      label: lazy[0].title,
      lazyLabels: lazy.map((l) => ({ label: l.title, url: l.url })),
    };
  }

  if (labeled.length > 0) {
    return { found: true, saved: labeled[0], allLabeled: labeled };
  }

  // Reached here with nothing in labeled/naked/lazy. This is the FALSE-POSITIVE
  // GUARD outcome: the fast-path saw a URL-SHAPED token (so we didn't early
  // return found:false), but on closer inspection it was a scheme-less domain
  // merely NAMED in prose ("example.com/report shows the numbers"), not a link
  // the steward attached — the guard un-claimed it. Passing the card untouched
  // is correct here. Genuine links never land here: they go to naked/labeled/
  // lazy above, so nothing is silently dropped.
  return { found: false };
}

/**
 * Human-friendly rejection message for a naked card link. Mirrors the tone of
 * buildSessionIdRejectionMessage — tell the steward exactly what was wrong and
 * how to fix it. This gets thrown back through the present_to_user tool.
 */
function buildNakedLinkRejectionMessage(result) {
  const url = result && result.url ? result.url : 'a link';
  return [
    `Your presenter card was rejected because it contains a bare/naked link with no human-readable title: ${url}`,
    ``,
    `Every card link is auto-saved and pinned into Joshua's card-links interface (right next to Bookmarks). A link with no label would show up there as a raw, unclickable-looking URL that nobody can tell apart from the next one.`,
    ``,
    `How to fix — remake the card giving the link a title, using ANY of:`,
    `  1. Markdown: put [Descriptive Label](${url}) in the title or message.`,
    `  2. Inline label: write "Descriptive Label: ${url}" or "Descriptive Label - ${url}" on the same line.`,
    `  3. Button: pass the link as a button { "label": "Descriptive Label", "url": "${url}" } — the label must be real text, not the URL itself.`,
    ``,
    `Cards with NO link are unaffected — this only fires when a link is present but unlabeled.`,
  ].join('\n');
}

/**
 * Human-friendly rejection message for a LAZY host-ish label. The lesson lands
 * HERE, at the failure point the steward sees — not in a creed. Teaches: name
 * the link by its CONTENT/PURPOSE, not its surface/host. Uses the real
 * crowne-vault incident as the worked example.
 */
function buildLazyLabelRejectionMessage(result) {
  const label = result && result.label ? result.label : 'localhost';
  const url = result && result.url ? result.url : 'the link';
  return [
    `Your presenter card was rejected because a link's label describes the SURFACE it's served from, not what the link IS: "${label}"`,
    ``,
    `Names like "${label}" (a hostname, IP, localhost, host:port, or a *.ts.net tailscale host) are lazy — they tell Joshua nothing. Every link served from the same host would get the same name, and his saved Links list fills up with identical, indistinguishable entries you can't tell apart.`,
    ``,
    `This actually happened: three different crowne-vault docs all got saved as "localhost" (approach-plan, volume-strategy, core-growth-deepdive were indistinguishable). That is the failure this gate prevents.`,
    ``,
    `How to fix — remake the card and name the link by its CONTENT / PURPOSE:`,
    `  ❌ "localhost"  /  "127.0.0.1"  /  "localhost:8947"  /  "joshuas-macbook-air.tail84bb3b.ts.net"`,
    `  ✅ "CV Approach Plan"  /  "Volume Strategy Deep-Dive"  /  "Core Growth Deep-Dive"`,
    ``,
    `Ask yourself: if Joshua saw only the name (not the URL) in his Links list, would he know what it opens? If not, it's a surface name — rename it after the content.`,
    ``,
    `The link that needs a real name: ${url}`,
    ``,
    `Cards with NO link are unaffected — this only fires when a link is present but its label describes the host instead of the content.`,
  ].join('\n');
}

module.exports = {
  scanCardForLink,
  buildNakedLinkRejectionMessage,
  buildLazyLabelRejectionMessage,
  // exported for unit tests
  isUrl,
  isLazyLabel,
  segmentLabelsUrl,
};
