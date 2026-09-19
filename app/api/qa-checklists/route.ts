import { NextRequest, NextResponse } from 'next/server';

// The validation + merge logic is plain CJS in lib/ so the CLI (used by
// stewards from a shell) and this route share ONE implementation. Two copies
// of a rule is how a rule drifts into being unenforced.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('../../../lib/qa-checklist-core.js');

// The Chrome side panel is an extension origin, so it needs explicit CORS.
// Nothing else on :3005 sets these headers -- verified against /api/bookmarks.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, { status: init?.status ?? 200, headers: CORS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * GET  /api/qa-checklists            -> every checklist, grouped by steward
 * GET  /api/qa-checklists?id=<slug>  -> one checklist
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const store = core.readStore();

  if (id) {
    const cl = store.checklists[id];
    if (!cl) return json({ success: false, error: 'No such checklist' }, { status: 404 });
    return json({ success: true, checklist: cl });
  }

  // Group by steward so the panel can render "organized BY STEWARD" without
  // doing the grouping itself -- the panel is a view, not a brain.
  const bySteward: Record<string, unknown[]> = {};
  for (const cl of Object.values(store.checklists) as Array<Record<string, unknown>>) {
    const steward = String(cl.steward || 'unknown');
    (bySteward[steward] ||= []).push(cl);
  }
  return json({ success: true, by_steward: bySteward, count: Object.keys(store.checklists).length });
}

/**
 * POST /api/qa-checklists  -- a steward SENDS or UPDATES a checklist.
 *
 * This is the gate. It REJECTS at send time (never at review time) when:
 *   - any step's URL is a bare origin / front door rather than the exact page
 *   - the update would DROP sections present in the prior version
 * The rejection names exactly what to fix, so the sender fixes it before
 * Josh ever sees it.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Body must be JSON' }, { status: 400 });
  }

  const id = typeof body.id === 'string' && body.id.trim()
    ? core.slugify(body.id)
    : core.slugify(`${body.steward || ''}-${body.title || ''}`);

  // INVARIANT: no `await` between readStore() and writeStore() -- the
  // read-validate-merge-write must stay synchronous so concurrent POSTs from
  // two stewards cannot interleave and lose one another's sections.
  const store = core.readStore();
  const prior = store.checklists[id] || null;

  const verdict = core.validateChecklist(body, prior);
  if (!verdict.ok) {
    return json({
      success: false,
      rejected: true,
      // Named so a steward reading the response knows this is a hard gate,
      // not a transient failure to retry verbatim.
      error: 'Checklist REJECTED — fix these and resend. Josh has not seen this.',
      problems: verdict.errors,
    }, { status: 422 });
  }

  const sections = core.mergeChecklist(body, prior);
  const now = Date.now();
  const version = prior ? (prior.version || 1) + 1 : 1;

  const checklist = {
    id,
    title: String(body.title).trim(),
    steward: String(body.steward).trim(),
    context: body.context ? String(body.context).trim() : undefined,
    start_url: String(body.start_url).trim(),
    version,
    created_at: prior ? prior.created_at : now,
    updated_at: now,
    dismissed: prior ? !!prior.dismissed : false,
    sections,
  };

  store.checklists[id] = checklist;
  core.writeStore(store);

  return json({ success: true, id, version, checklist });
}

/**
 * PATCH /api/qa-checklists -- Josh's own actions from the panel.
 *   { id, step_id, checked }        tick / untick a step
 *   { id, step_id, dismissed }      dismiss a single step
 *   { id, dismissed }               dismiss the whole checklist
 *
 * Ticking also clears `changed_since_checked` -- he has just re-verified it.
 */
export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Body must be JSON' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json({ success: false, error: 'Missing id' }, { status: 400 });

  const store = core.readStore();
  const cl = store.checklists[id];
  if (!cl) return json({ success: false, error: 'No such checklist' }, { status: 404 });

  const stepId = typeof body.step_id === 'string' ? body.step_id.trim() : '';

  if (!stepId) {
    if (typeof body.dismissed === 'boolean') cl.dismissed = body.dismissed;
  } else {
    let found = false;
    for (const section of cl.sections || []) {
      for (const step of section.steps || []) {
        if (step.id !== stepId) continue;
        found = true;
        if (typeof body.checked === 'boolean') {
          step.checked = body.checked;
          step.checked_at = body.checked ? Date.now() : null;
          // He just looked at it again, so the re-check flag is satisfied.
          if (body.checked) step.changed_since_checked = false;
        }
        if (typeof body.dismissed === 'boolean') step.dismissed = body.dismissed;
      }
    }
    if (!found) return json({ success: false, error: 'No such step' }, { status: 404 });
  }

  cl.updated_at = Date.now();
  core.writeStore(store);
  return json({ success: true, checklist: cl });
}

/** DELETE /api/qa-checklists?id=<slug> -- remove a checklist outright. */
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return json({ success: false, error: 'Missing id' }, { status: 400 });
  const store = core.readStore();
  if (!store.checklists[id]) return json({ success: true, deleted: false }, { status: 200 });
  delete store.checklists[id];
  core.writeStore(store);
  return json({ success: true, deleted: true });
}
