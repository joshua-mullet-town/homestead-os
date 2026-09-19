const { test } = require('node:test');
const assert = require('node:assert');
const {
  bareOriginReason,
  droppedSectionsReason,
  validateChecklist,
  mergeChecklist,
} = require('../lib/qa-checklist-core.js');

// --- Rule 1: bare-origin refusal --------------------------------------------

test('bare origin URLs are refused', () => {
  assert.ok(bareOriginReason('https://givegrove-dev.web.app'));
  assert.ok(bareOriginReason('https://givegrove-dev.web.app/'));
  assert.ok(bareOriginReason('http://localhost:3005'));
  assert.ok(bareOriginReason(''));
  assert.ok(bareOriginReason(undefined));
});

test('deep URLs are accepted', () => {
  assert.strictEqual(bareOriginReason('https://givegrove-dev.web.app/event/abc123'), null);
  assert.strictEqual(bareOriginReason('https://givegrove-dev.web.app/event/abc123/downloads'), null);
  // query-only and hash-only still point at a specific thing
  assert.strictEqual(bareOriginReason('https://example.com/?event=abc123'), null);
  assert.strictEqual(bareOriginReason('https://example.com/#/event/abc'), null);
});

test('index-ish landing paths are refused as front doors', () => {
  assert.ok(bareOriginReason('https://givegrove-dev.web.app/events'));
  assert.ok(bareOriginReason('https://givegrove-dev.web.app/dashboard'));
  assert.ok(bareOriginReason('https://givegrove-dev.web.app/index.html'));
  // ...but a landing path WITH a specific item is fine
  assert.strictEqual(bareOriginReason('https://givegrove-dev.web.app/events/abc123'), null);
});

test('non-web links are refused', () => {
  assert.ok(bareOriginReason('file://<<REPLACE: your home dir, e.g. /Users/you>>/thing.html'));
  assert.ok(bareOriginReason('not a url at all'));
});

// --- Rule 2: dropped-section refusal ----------------------------------------

test('dropping a prior section is refused and names the section', () => {
  const prior = [{ title: 'Ticketing' }, { title: 'Downloads' }];
  const incoming = [{ title: 'Ticketing' }];
  const reason = droppedSectionsReason(prior, incoming);
  assert.ok(reason);
  assert.match(reason, /Downloads/);
});

test('keeping every prior section passes, and adding is fine', () => {
  const prior = [{ title: 'Ticketing' }];
  assert.strictEqual(droppedSectionsReason(prior, [{ title: 'Ticketing' }, { title: 'New' }]), null);
});

test('section matching is case/whitespace insensitive', () => {
  const prior = [{ title: 'Ticketing' }];
  assert.strictEqual(droppedSectionsReason(prior, [{ title: '  ticketing ' }]), null);
});

test('first version has nothing to drop', () => {
  assert.strictEqual(droppedSectionsReason([], [{ title: 'A' }]), null);
  assert.strictEqual(droppedSectionsReason(undefined, [{ title: 'A' }]), null);
});

// --- validateChecklist end to end -------------------------------------------

const goodChecklist = {
  title: 'Event downloads',
  steward: 'holler-givegrove',
  start_url: 'https://givegrove-dev.web.app/event/abc123',
  sections: [{
    title: 'Downloads',
    steps: [{ label: 'Download the attendee CSV', url: 'https://givegrove-dev.web.app/event/abc123/downloads' }],
  }],
};

test('a good checklist validates', () => {
  const res = validateChecklist(goodChecklist, null);
  assert.strictEqual(res.ok, true);
});

test('a root-URL step is rejected with an actionable reason', () => {
  const bad = JSON.parse(JSON.stringify(goodChecklist));
  bad.sections[0].steps[0].url = 'https://givegrove-dev.web.app';
  const res = validateChecklist(bad, null);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some((e) => /site root/.test(e)), res.errors.join('|'));
});

test('missing steward is rejected', () => {
  const bad = { ...goodChecklist, steward: '' };
  const res = validateChecklist(bad, null);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some((e) => /steward/.test(e)));
});

test('an update that drops a section is rejected', () => {
  const prior = {
    sections: [
      { title: 'Downloads', steps: [] },
      { title: 'Ticketing', steps: [] },
    ],
  };
  const res = validateChecklist(goodChecklist, prior); // only has Downloads
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some((e) => /DROPS/.test(e) && /Ticketing/.test(e)), res.errors.join('|'));
});

// --- PRESERVE-AND-FLAG merge ------------------------------------------------

function priorWithTick(overrides = {}) {
  return {
    sections: [{
      title: 'Downloads',
      steps: [{
        id: 'su:downloads::https://givegrove-dev.web.app/event/abc123/downloads',
        label: 'Download the attendee CSV',
        url: 'https://givegrove-dev.web.app/event/abc123/downloads',
        substance: require('../lib/qa-checklist-core.js').substanceHash({
          label: 'Download the attendee CSV',
          url: 'https://givegrove-dev.web.app/event/abc123/downloads',
        }),
        checked: true,
        checked_at: 1234,
        dismissed: false,
        ...overrides,
      }],
    }],
  };
}

test("a steward update PRESERVES Josh's tick when nothing changed", () => {
  const merged = mergeChecklist(goodChecklist, priorWithTick());
  const step = merged[0].steps[0];
  assert.strictEqual(step.checked, true, 'tick must survive a steward update');
  assert.strictEqual(step.checked_at, 1234);
  assert.strictEqual(step.changed_since_checked, false);
});

test('a changed step KEEPS the tick but is FLAGGED for re-check', () => {
  const changed = JSON.parse(JSON.stringify(goodChecklist));
  changed.sections[0].steps[0].label = 'Download the attendee CSV and open it';
  const merged = mergeChecklist(changed, priorWithTick());
  const step = merged[0].steps[0];
  assert.strictEqual(step.checked, true, 'PRESERVE: tick is never wiped wholesale');
  assert.strictEqual(step.changed_since_checked, true, 'FLAG: he is told it moved');
});

test('a brand-new step arrives unchecked', () => {
  const added = JSON.parse(JSON.stringify(goodChecklist));
  added.sections[0].steps.push({
    label: 'Check the receipt',
    url: 'https://givegrove-dev.web.app/event/abc123/receipt',
  });
  const merged = mergeChecklist(added, priorWithTick());
  assert.strictEqual(merged[0].steps[0].checked, true);
  assert.strictEqual(merged[0].steps[1].checked, false);
});

test('dismissed state survives an update too', () => {
  const merged = mergeChecklist(goodChecklist, priorWithTick({ dismissed: true }));
  assert.strictEqual(merged[0].steps[0].dismissed, true);
});

// --- Round-trip stability: the bug that broke ticks on the SECOND update ----
// mergeChecklist persists the derived key into step.id. If stepKey() re-wraps
// that stored id, the identity changes shape between update 1 and update 2 and
// Josh's ticks silently reset. This test drives THREE updates to prove the
// identity is stable, not just one.

test('ticks survive repeated steward updates (round-trip stable identity)', () => {
  let stored = { sections: mergeChecklist(goodChecklist, null) };
  // Josh ticks it.
  stored.sections[0].steps[0].checked = true;
  stored.sections[0].steps[0].checked_at = 999;

  for (let round = 1; round <= 3; round += 1) {
    stored = { sections: mergeChecklist(goodChecklist, stored) };
    assert.strictEqual(
      stored.sections[0].steps[0].checked, true,
      `tick must survive update #${round}`,
    );
    assert.strictEqual(stored.sections[0].steps[0].checked_at, 999);
    assert.strictEqual(stored.sections[0].steps[0].changed_since_checked, false);
  }
});

// --- start_url: the "yeet me there" link ------------------------------------

test('a checklist with no start_url is rejected', () => {
  const bad = { ...goodChecklist };
  delete bad.start_url;
  const res = validateChecklist(bad, null);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some((e) => /start_url/.test(e)), res.errors.join('|'));
});

test('a front-door start_url is rejected', () => {
  const bad = { ...goodChecklist, start_url: 'https://givegrove-dev.web.app' };
  const res = validateChecklist(bad, null);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some((e) => /start_url/.test(e) && /site root/.test(e)), res.errors.join('|'));
});

test('a deep start_url is accepted', () => {
  const res = validateChecklist(goodChecklist, null);
  assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
});

// --- Attached files: a promised file must actually be delivered -------------

const { promisedFileReason } = require('../lib/qa-checklist-core.js');

test('a step promising a supplied file with none attached is refused', () => {
  assert.ok(promisedFileReason({ label: 'Upload the attached file' }));
  assert.ok(promisedFileReason({ label: 'Import it', detail: 'Use the sample file.' }));
  assert.ok(promisedFileReason({ label: 'Try the test file I made' }));
});

test('attaching the file clears it', () => {
  const step = {
    label: 'Upload the attached file',
    files: [{ name: 'broken.csv', url: '/qa-files/abc-broken.csv', size: 12 }],
  };
  assert.strictEqual(promisedFileReason(step), null);
});

test('an APP-PRODUCED file needs no attachment — the preferred pattern', () => {
  // This is exactly how GiveGrove's real checklist words it, and it must pass.
  assert.strictEqual(promisedFileReason({
    label: 'Tap Export on Fund a Need — a spreadsheet of its items downloads',
    detail: 'Same columns as the upload file uses.',
  }), null);
  assert.strictEqual(promisedFileReason({
    label: 'Use Get Template inside that window to get a file already filled in',
  }), null);
});

test('an ordinary step with no file talk is untouched', () => {
  assert.strictEqual(promisedFileReason({ label: 'The receipt email arrives' }), null);
  assert.strictEqual(promisedFileReason({ label: 'Voting shows all four buttons' }), null);
});

test('the file rule is enforced through validateChecklist', () => {
  const bad = {
    title: 'x', steward: 's',
    start_url: 'https://givegrove-mullet.web.app/event/abc',
    sections: [{
      title: 'S',
      steps: [{ label: 'Upload the attached file', url: 'https://givegrove-mullet.web.app/event/abc/import' }],
    }],
  };
  const res = validateChecklist(bad, null);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some((e) => /no file is attached/.test(e)), res.errors.join('|'));
});

test('swapping an attachment flags the step for a re-look', () => {
  const withFile = (url) => ({
    title: 'x', steward: 's',
    start_url: 'https://givegrove-mullet.web.app/event/abc',
    sections: [{
      title: 'S',
      steps: [{
        label: 'Upload the attached file',
        url: 'https://givegrove-mullet.web.app/event/abc/import',
        files: [{ name: 'f.csv', url }],
      }],
    }],
  });
  let stored = { sections: mergeChecklist(withFile('/qa-files/one.csv'), null) };
  stored.sections[0].steps[0].checked = true;
  stored = { sections: mergeChecklist(withFile('/qa-files/two.csv'), stored) };
  const step = stored.sections[0].steps[0];
  assert.strictEqual(step.checked, true, 'tick preserved');
  assert.strictEqual(step.changed_since_checked, true, 'a different file must flag a re-check');
});

// --- Step links must survive Josh tapping them from his PHONE ---------------
// The checklist SURFACE is desktop Chrome, but the links inside a step are not:
// he taps one and carries on from wherever he is. A machine-local URL passes
// every other gate and then dies in his hand.

test('localhost / loopback step URLs are refused', () => {
  assert.ok(bareOriginReason('http://localhost:3005/event/abc'));
  assert.ok(bareOriginReason('http://127.0.0.1:8080/event/abc'));
  assert.ok(bareOriginReason('http://0.0.0.0:3000/x'));
  // and the reason has to tell them what to use instead
  assert.match(bareOriginReason('http://localhost:3005/event/abc'), /Tailscale|deployed site/);
});

test('the Tailscale hostname and real sites are fine', () => {
  assert.strictEqual(bareOriginReason('http://joshuas-macbook-air.tail84bb3b.ts.net:3005/qa-x/1'), null);
  assert.strictEqual(bareOriginReason('https://givegrove-mullet.web.app/event/abc'), null);
});

test('a localhost start_url is refused too', () => {
  const bad = {
    title: 'x', steward: 's',
    start_url: 'http://localhost:3000/event/abc',
    sections: [{ title: 'S', steps: [{ label: 'check it', url: 'https://givegrove-mullet.web.app/event/abc' }] }],
  };
  const res = validateChecklist(bad, null);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some((e) => /start_url/.test(e) && /Tailscale|deployed site/.test(e)), res.errors.join('|'));
});
