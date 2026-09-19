'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  scanCardForLink,
  buildNakedLinkRejectionMessage,
  buildLazyLabelRejectionMessage,
  isUrl,
  isLazyLabel,
} = require('../lib/card-link-scanner');

// --- NO URL → passes untouched (the critical majority case) ---

test('no url anywhere → found:false, no reject', () => {
  const r = scanCardForLink({ title: 'Build complete', message: 'All 42 tests green.', buttons: ['OK', 'Dismiss'] });
  assert.deepStrictEqual(r, { found: false });
});

test('no url with object buttons (label/run, no url) → found:false', () => {
  const r = scanCardForLink({
    title: 'Run the demo',
    message: 'Click to launch.',
    buttons: [{ label: 'Watch Demo', run: 'node /tmp/demo.js' }, 'Skip'],
  });
  assert.deepStrictEqual(r, { found: false });
});

test('empty / missing fields → found:false', () => {
  assert.deepStrictEqual(scanCardForLink({}), { found: false });
  assert.deepStrictEqual(scanCardForLink({ title: '', message: '', buttons: [] }), { found: false });
  assert.deepStrictEqual(scanCardForLink(), { found: false });
});

test('text that merely mentions "http" but is not a real URL → found:false', () => {
  const r = scanCardForLink({ title: 'httpd config', message: 'the https protocol is fine', buttons: ['OK'] });
  assert.deepStrictEqual(r, { found: false });
});

// --- Branch 1: markdown [label](url) → labeled, saved ---

test('markdown link in message → saved with label as title', () => {
  const r = scanCardForLink({
    title: 'PR ready',
    message: 'See [the pull request](https://github.com/x/y/pull/1) for details.',
    buttons: ['OK'],
  });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.saved, { title: 'the pull request', url: 'https://github.com/x/y/pull/1' });
});

test('markdown link in title → saved', () => {
  const r = scanCardForLink({
    title: 'Review [staging deploy](https://staging.example.com)',
    message: 'Take a look.',
    buttons: ['OK'],
  });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.saved, { title: 'staging deploy', url: 'https://staging.example.com' });
});

// --- Branch 2: "Label: url" / "Label - url" → labeled, saved ---

test('"Label: url" inline → saved with preceding text as title', () => {
  const r = scanCardForLink({
    title: 'Deploy done',
    message: 'Preview URL: https://preview.example.com/abc',
    buttons: ['OK'],
  });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.saved.url, 'https://preview.example.com/abc');
  assert.match(r.saved.title, /Preview URL/i);
});

test('"Label - url" inline (dash separator) → saved', () => {
  const r = scanCardForLink({
    title: 'Logs',
    message: 'Grafana dashboard - https://grafana.example.com/d/123',
    buttons: ['OK'],
  });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.saved.url, 'https://grafana.example.com/d/123');
  assert.match(r.saved.title, /Grafana dashboard/i);
});

// --- Branch 3: button {label,url} with non-empty non-url label → labeled ---

test('button with real label + url → saved with button label as title', () => {
  const r = scanCardForLink({
    title: 'Site is up',
    message: 'Everything looks good.',
    buttons: [{ label: 'Open the live site', url: 'https://live.example.com' }, 'Dismiss'],
  });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.saved, { title: 'Open the live site', url: 'https://live.example.com' });
});

// --- REJECT: bare/naked url in each surface ---

test('bare url alone in message → reject', () => {
  const r = scanCardForLink({ title: 'Look', message: 'https://example.com/naked', buttons: ['OK'] });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'naked_url');
  assert.strictEqual(r.url, 'https://example.com/naked');
});

test('bare url alone in title → reject', () => {
  const r = scanCardForLink({ title: 'https://example.com/x', message: 'body', buttons: ['OK'] });
  assert.strictEqual(r.reject, true);
});

test('button with url but label IS the url → reject (label not descriptive)', () => {
  const r = scanCardForLink({
    title: 'Link',
    message: 'here',
    buttons: [{ label: 'https://example.com/x', url: 'https://example.com/x' }],
  });
  assert.strictEqual(r.reject, true);
});

test('button with url and empty label → reject', () => {
  const r = scanCardForLink({
    title: 'Link',
    message: 'here',
    buttons: [{ label: '', url: 'https://example.com/x' }],
  });
  assert.strictEqual(r.reject, true);
});

test('markdown where label is itself a url → reject', () => {
  const r = scanCardForLink({
    title: 'x',
    message: '[https://example.com](https://example.com)',
    buttons: ['OK'],
  });
  assert.strictEqual(r.reject, true);
});

// --- Mixed: one labeled + one naked → still reject (naked would vanish) ---

test('labeled link on one line + naked on another → reject', () => {
  const r = scanCardForLink({
    title: 'Two links',
    message: 'Prod site: https://prod.example.com\nhttps://naked.example.com',
    buttons: ['OK'],
  });
  assert.strictEqual(r.reject, true);
  assert.ok(r.nakedUrls.includes('https://naked.example.com'));
});

test('two labeled links, no naked → passes, first wins', () => {
  const r = scanCardForLink({
    title: 'Links',
    message: 'Prod: https://prod.example.com\nStaging: https://staging.example.com',
    buttons: ['OK'],
  });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.saved.url, 'https://prod.example.com');
  assert.strictEqual(r.allLabeled.length, 2);
});

test('allLabeled captures links across text + markdown + button (drives multi-save)', () => {
  const r = scanCardForLink({
    title: 'Docs: https://docs.example.com',
    message: 'See the [PR](https://pr.example.com) for the change.',
    buttons: [{ label: 'Staging site', url: 'https://staging.example.com' }],
  });
  assert.strictEqual(r.found, true);
  const urls = r.allLabeled.map((l) => l.url);
  assert.ok(urls.includes('https://docs.example.com'));
  assert.ok(urls.includes('https://pr.example.com'));
  assert.ok(urls.includes('https://staging.example.com'));
  assert.strictEqual(r.allLabeled.length, 3);
});

// --- isUrl helper ---

test('isUrl: pure url true, labeled text false', () => {
  assert.strictEqual(isUrl('https://x.com'), true);
  assert.strictEqual(isUrl('  https://x.com  '), true);
  assert.strictEqual(isUrl('see https://x.com'), false);
  assert.strictEqual(isUrl('label'), false);
  assert.strictEqual(isUrl(''), false);
});

// --- Rejection message is actionable ---

test('rejection message names the url and all three fix paths', () => {
  const msg = buildNakedLinkRejectionMessage({ url: 'https://example.com/x' });
  assert.match(msg, /https:\/\/example\.com\/x/);
  assert.match(msg, /Markdown/i);
  assert.match(msg, /Button/i);
  assert.match(msg, /no link/i); // reassures no-link cards unaffected
});

// ===========================================================================
// FIX 2 — LAZY HOST-ISH LABELS (localhost / IP / *.ts.net / host:port) REJECT
// ===========================================================================

// --- isLazyLabel unit cases: host-ish → true, content → false ---

test('isLazyLabel: localhost / 127.0.0.1 / 0.0.0.0 are lazy', () => {
  assert.strictEqual(isLazyLabel('localhost'), true);
  assert.strictEqual(isLazyLabel('127.0.0.1'), true);
  assert.strictEqual(isLazyLabel('0.0.0.0'), true);
  assert.strictEqual(isLazyLabel('localhost:8947'), true);        // host:port
  assert.strictEqual(isLazyLabel('http://localhost:8947'), true); // with scheme
});

test('isLazyLabel: bare IPv4 and host:port are lazy', () => {
  assert.strictEqual(isLazyLabel('192.168.1.5'), true);
  assert.strictEqual(isLazyLabel('<<REPLACE: your LAN IP>>'), true);
  assert.strictEqual(isLazyLabel('myhost:3000'), true);
});

test('isLazyLabel: dotted hostnames with a real TLD / .ts.net tail are lazy', () => {
  assert.strictEqual(isLazyLabel('joshuas-macbook-air.tail84bb3b.ts.net'), true);
  assert.strictEqual(isLazyLabel('api.example.com'), true);
  // `.internal` IS a recognized infra tail → host. (`.corp` is not — see the
  // dotted-content test — so a bare "staging.internal.corp" is content unless
  // it matches the url's own host.)
  assert.strictEqual(isLazyLabel('vpn.example.internal'), true);
});

test('isLazyLabel: the URL\'s own hostname used verbatim is lazy', () => {
  assert.strictEqual(
    isLazyLabel('localhost', 'http://localhost:8947/cv-approach-plan.html'),
    true
  );
});

test('isLazyLabel: real content labels are NOT lazy (no over-reject)', () => {
  assert.strictEqual(isLazyLabel('CV Approach Plan'), false);
  assert.strictEqual(isLazyLabel('Volume Strategy Deep-Dive'), false);
  assert.strictEqual(isLazyLabel('Core Growth Deep-Dive'), false);
  assert.strictEqual(isLazyLabel('the pull request'), false);
  assert.strictEqual(isLazyLabel('staging deploy'), false);
  // Single hyphenated content word (no dot, no port) must pass.
  assert.strictEqual(isLazyLabel('approach-plan'), false);
  assert.strictEqual(isLazyLabel('Grafana'), false);
  assert.strictEqual(isLazyLabel(''), false);
});

// --- DOTTED CONTENT must PASS (Auditor bounce 2026-07-14): a dot alone does NOT
//     make a label host-ish. Only a real TLD / .ts.net tail does. These are
//     common auto-generated names (versions, ticket refs, tech names, dotted
//     content) and MUST NOT be rejected. This closes the discriminator hole. ---

test('isLazyLabel: dotted CONTENT (versions/tickets/tech names) is NOT lazy', () => {
  assert.strictEqual(isLazyLabel('v2.1-release-notes'), false);
  assert.strictEqual(isLazyLabel('node.js-upgrade'), false);
  assert.strictEqual(isLazyLabel('Q3.2026-plan'), false);
  assert.strictEqual(isLazyLabel('gh-1397.review'), false);
  assert.strictEqual(isLazyLabel('design.doc'), false);
  assert.strictEqual(isLazyLabel('3.5-sonnet-notes'), false);
});

test('isLazyLabel: a dotted host is lazy ONLY via a real TLD / .ts.net tail', () => {
  // Real public TLD → host, rejects.
  assert.strictEqual(isLazyLabel('api.example.com'), true);
  assert.strictEqual(isLazyLabel('dash.grafana.io'), true);
  // Tailscale tail → host, rejects.
  assert.strictEqual(isLazyLabel('box.tailXXXX.ts.net'), true);
  // Dotted, but tail is NOT a TLD → treated as content (conservative pass).
  assert.strictEqual(isLazyLabel('design.doc'), false);
  // …UNLESS it's the URL's OWN hostname — then it's lazy regardless of tail.
  assert.strictEqual(isLazyLabel('staging.internal.corp', 'http://staging.internal.corp:8080/x'), true);
});

// --- scanCardForLink: lazy label rejects like a naked link ---

test('button labeled "localhost" → reject reason:lazy_label (the crowne-vault bug)', () => {
  const r = scanCardForLink({
    title: 'Doc ready',
    message: 'here it is',
    buttons: [{ label: 'localhost', url: 'http://localhost:8947/cv-approach-plan.html' }],
  });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'lazy_label');
  assert.strictEqual(r.label, 'localhost');
  assert.strictEqual(r.url, 'http://localhost:8947/cv-approach-plan.html');
});

test('markdown link labeled with a *.ts.net host → reject lazy_label', () => {
  const r = scanCardForLink({
    title: 'x',
    message: '[joshuas-macbook-air.tail84bb3b.ts.net](http://joshuas-macbook-air.tail84bb3b.ts.net:8947/x.html)',
    buttons: ['OK'],
  });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'lazy_label');
});

test('inline "127.0.0.1: url" → reject lazy_label', () => {
  const r = scanCardForLink({
    title: 'Server',
    message: '127.0.0.1: http://127.0.0.1:3000/dashboard',
    buttons: ['OK'],
  });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'lazy_label');
});

test('content-labeled link to a localhost URL → PASSES (label is what matters)', () => {
  const r = scanCardForLink({
    title: 'Doc',
    message: 'Read the [CV Approach Plan](http://localhost:8947/cv-approach-plan.html).',
    buttons: ['OK'],
  });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.saved.title, 'CV Approach Plan');
  assert.strictEqual(r.saved.url, 'http://localhost:8947/cv-approach-plan.html');
});

test('naked wins over lazy when both present (missing-title message is priority)', () => {
  const r = scanCardForLink({
    title: 'Two',
    message: 'localhost: http://localhost:8947/a.html\nhttp://naked.example.com/b',
    buttons: ['OK'],
  });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'naked_url');
});

test('lazy-label rejection message teaches content-over-surface with worked example', () => {
  const msg = buildLazyLabelRejectionMessage({ label: 'localhost', url: 'http://localhost:8947/cv-approach-plan.html' });
  assert.match(msg, /localhost/);
  assert.match(msg, /content/i);
  assert.match(msg, /CV Approach Plan/); // worked good-example present
  assert.match(msg, /surface|host/i);
  assert.match(msg, /no link/i); // reassures no-link cards unaffected
});

// ===========================================================================
// FIX #1 — LINKS INSIDE A BUTTON'S `run` COMMAND ARE SCANNED
// The scanner used to read only a button's `url` field, never `run`. The tool's
// own docs push stewards toward run ({label:'Watch Demo', run:'open http://…'}),
// so the single most common way to attach a link went completely unscanned.
// ===========================================================================

test('FIX1: button run with http url + descriptive label → saved (label titles it)', () => {
  const r = scanCardForLink({
    title: 'Demo ready',
    message: 'Click to launch.',
    buttons: [{ label: 'Watch Demo', run: 'open http://localhost:3000/demo' }, 'Skip'],
  });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.saved, { title: 'Watch Demo', url: 'http://localhost:3000/demo' });
});

test('FIX1: button run with http url but NO label → reject naked (would vanish)', () => {
  const r = scanCardForLink({
    title: 'Open it',
    message: 'here',
    buttons: [{ run: 'open https://example.com/report' }],
  });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'naked_url');
  assert.strictEqual(r.url, 'https://example.com/report');
});

test('FIX1: button run with url but label IS a url → reject naked', () => {
  const r = scanCardForLink({
    title: 'x',
    message: 'y',
    buttons: [{ label: 'https://example.com/x', run: 'open https://example.com/x' }],
  });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'naked_url');
});

test('FIX1: button run with a lazy host-ish label → reject lazy_label', () => {
  const r = scanCardForLink({
    title: 'Doc',
    message: 'here',
    buttons: [{ label: 'localhost', run: 'open http://localhost:8947/cv-approach-plan.html' }],
  });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'lazy_label');
});

test('FIX1: run command with NO url (real shell command) → found:false, passes', () => {
  const r = scanCardForLink({
    title: 'Run tests',
    message: 'Kick off the suite.',
    buttons: [{ label: 'Run', run: 'npm test -- --watch' }, 'Cancel'],
  });
  assert.deepStrictEqual(r, { found: false });
});

test('FIX1: button carries link via BOTH url and run → both accounted, one save is enough', () => {
  const r = scanCardForLink({
    title: 'Ship',
    message: 'go',
    buttons: [{ label: 'Live Dashboard', url: 'https://dash.example.com', run: 'open https://dash.example.com' }],
  });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.saved.title, 'Live Dashboard');
  assert.strictEqual(r.saved.url, 'https://dash.example.com');
});

// ===========================================================================
// FIX #2 — SCHEME-LESS URLs (www.example.com/report, github.com/foo/bar)
// PATH-REQUIRED boundary: www.* prefix (path optional) OR real-TLD host WITH a
// /path. A bare host with no path (example.com, acme.io) is NOT a link — so
// ordinary prose that merely names a domain passes untouched.
// ===========================================================================

test('FIX2: naked scheme-less url with path in message → reject naked', () => {
  const r = scanCardForLink({ title: 'See', message: 'github.com/foo/bar', buttons: ['OK'] });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'naked_url');
  assert.strictEqual(r.url, 'https://github.com/foo/bar');
});

test('FIX2: naked www. host (no path) in message → reject naked', () => {
  const r = scanCardForLink({ title: 'Visit', message: 'www.example.com', buttons: ['OK'] });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'naked_url');
  assert.strictEqual(r.url, 'https://www.example.com');
});

test('FIX2: labeled scheme-less url ("Label: host.tld/path") → saved', () => {
  const r = scanCardForLink({
    title: 'Report',
    message: 'Weekly report: example.com/reports/weekly',
    buttons: ['OK'],
  });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.saved.url, 'https://example.com/reports/weekly');
  assert.match(r.saved.title, /Weekly report/i);
});

test('FIX2: scheme-less url in a button run → titled by button label, saved', () => {
  const r = scanCardForLink({
    title: 'Open',
    message: 'go',
    buttons: [{ label: 'GitHub Repo', run: 'open github.com/homestead/app' }],
  });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.saved, { title: 'GitHub Repo', url: 'https://github.com/homestead/app' });
});

// --- PATH-REQUIRED: bare host with no path must NOT be flagged (no false-positive) ---

test('FIX2: bare host with no path (domain mentioned in prose) → found:false', () => {
  assert.deepStrictEqual(
    scanCardForLink({ title: 'Vendor', message: 'we use acme.io internally', buttons: ['OK'] }),
    { found: false }
  );
  assert.deepStrictEqual(
    scanCardForLink({ title: 'Note', message: 'switch the DNS to example.com soon', buttons: ['OK'] }),
    { found: false }
  );
});

test('FIX2: dotted CONTENT / tech names (not real TLDs) → NOT links, found:false', () => {
  // node.js, socket.io — .js is not a TLD; .io IS but there is no /path.
  assert.deepStrictEqual(
    scanCardForLink({ title: 'Upgrade', message: 'bump node.js and socket.io versions', buttons: ['OK'] }),
    { found: false }
  );
  assert.deepStrictEqual(
    scanCardForLink({ title: 'File', message: 'open the design.doc file', buttons: ['OK'] }),
    { found: false }
  );
  // Version/ticket dotted content must never look like a scheme-less URL.
  assert.deepStrictEqual(
    scanCardForLink({ title: 'Plan', message: 'ship v2.1-release-notes and gh-1397.review', buttons: ['OK'] }),
    { found: false }
  );
});

test('FIX2: http(s):// url is not double-counted as a scheme-less one', () => {
  // The embedded "example.com/x" inside the full URL must not resurface as a
  // second (scheme-less) naked token.
  const r = scanCardForLink({
    title: 'x',
    message: 'Prod site: https://example.com/x',
    buttons: ['OK'],
  });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.saved.url, 'https://example.com/x');
  assert.strictEqual(r.allLabeled.length, 1);
});

test('FIX2: markdown label that is a scheme-less host is lazy → reject lazy_label', () => {
  const r = scanCardForLink({
    title: 'Doc',
    message: 'See api.example.com/docs',
    buttons: [{ label: 'api.example.com', url: 'https://api.example.com/docs' }],
  });
  assert.strictEqual(r.reject, true);
  // Either gate is acceptable; the point is it does NOT silently pass.
  assert.ok(r.reason === 'lazy_label' || r.reason === 'naked_url');
});

// ===========================================================================
// FIX #2b — FALSE-POSITIVE GUARD (Auditor bounce): a scheme-less host.tld/path
// that LEADS a prose segment but is FOLLOWED BY PROSE is a mention, not an
// attached link. It must PASS untouched, not hard-reject the whole card. Only a
// link-shaped token (whole segment / trailing punctuation only) is naked.
// ===========================================================================

test('FIX2b: domain-path LEADING a prose sentence → passes (no false reject)', () => {
  // The exact 4 cases the Auditor surfaced.
  for (const msg of [
    'example.com/report shows the numbers',
    'metrics.app/dash confirms it live',
    'cost.co/deals is cheaper than retail',
    'co.uk/vat form is required',
  ]) {
    assert.deepStrictEqual(
      scanCardForLink({ title: 'Note', message: msg, buttons: ['OK'] }),
      { found: false },
      `"${msg}" should pass as prose, not reject`
    );
  }
});

test('FIX2b: a word BEFORE the token still labels + saves (unchanged)', () => {
  const r = scanCardForLink({ title: 'Docs', message: 'read metrics.app/dash for the live view', buttons: ['OK'] });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.saved.url, 'https://metrics.app/dash');
  assert.match(r.saved.title, /read/i);
});

test('FIX2b: a GENUINELY naked scheme-less link (whole segment) still rejects', () => {
  // No prose after → link-shaped → must still hard-reject (the security case).
  for (const msg of ['example.com/report', 'metrics.app/dash', 'github.com/foo/bar']) {
    const r = scanCardForLink({ title: 'x', message: msg, buttons: ['OK'] });
    assert.strictEqual(r.reject, true, `"${msg}" (whole segment) should reject`);
    assert.strictEqual(r.reason, 'naked_url');
  }
});

test('FIX2b: naked scheme-less link with only trailing punctuation still rejects', () => {
  // "example.com/report." — a period is not prose; still a bare pasted link.
  const r = scanCardForLink({ title: 'x', message: 'example.com/report.', buttons: ['OK'] });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'naked_url');
});

test('FIX2b: naked scheme-less link in a run button still rejects (leniency is text-only)', () => {
  // The false-positive guard is scoped to prose text tokens — a run-button link
  // with no label is still a link the steward attached, so it must reject.
  const r = scanCardForLink({
    title: 'Open',
    message: 'go',
    buttons: [{ run: 'gh repo view github.com/foo/bar' }],
  });
  assert.strictEqual(r.reject, true);
  assert.strictEqual(r.reason, 'naked_url');
});
