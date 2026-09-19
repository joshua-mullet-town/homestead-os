/**
 * search_history tool — Search PAST presenter cards by keyword, and pull up
 * BOTH SIDES of each conversation: what Josh was asked (title + message) and
 * how he responded (which button + his typed feedback).
 *
 * SCOPE: by DEFAULT this scopes to the CALLING steward's own top-steward
 * lineage (top + foreman + every worker under that top steward), so a steward
 * re-grounds against its OWN prior decisions rather than the whole fleet's.
 * Pass allStewards:true to widen fleet-wide, or an explicit steward value to
 * target a different steward. Scope is applied by defaulting the downstream
 * `steward` substring filter to the caller's top-steward prefix — substring
 * on the prefix naturally sweeps the whole lineage (e.g. "holler-homestead"
 * matches holler-homestead, holler-homestead--foreman, ...--foreman--xyz).
 *
 * It reads through the Homestead server's GET /api/presenter/history-search
 * endpoint (backed by searchAllHistory in lib/presenter-queue.js) — a pure
 * READ, no queue writes.
 *
 * Newest-first. When no query is given, returns the most RECENT cards (within
 * scope) so a resuming steward can re-ground after a compact.
 */

import { getTmuxSessionId } from '../lib/macos.js';
// Canonical top-steward derivation — the SAME resolveTopSteward used by
// bookmarks + card-links, imported so "top steward from a session name" stays
// one source of truth across the fleet. Do NOT fork this splitter.
import { resolveTopSteward } from '../../../lib/card-links-store.js';

const SERVER_URL = 'http://localhost:3005';

export const searchHistoryTool = {
  name: 'search_history',
  description:
    'Search PAST presenter cards (conversations with Josh) by keyword and get BOTH SIDES back: what Josh was asked, and how he answered — which button he pressed and any text he typed. Results are newest-first (recency-aware) and each carries BOTH an absolute timestamp ("when") AND a pre-computed relative age ("when_relative", e.g. "3 minutes ago" / "3 months ago") so you never have to do date math. Use this the moment you pick up a handoff or feel unsure what was decided before a compact: search a keyword (a feature name, a person, a decision) to re-ground against what Josh actually said. Leave "query" empty to get the most recent cards. SCOPE: by DEFAULT this scopes to YOUR OWN top-steward lineage (your top steward + its foreman + all workers under it), so you re-ground against your own line\'s history. Pass allStewards:true to search the WHOLE fleet, or pass an explicit "steward" to target a different steward.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Keyword(s) to match against a card\'s title, message, AND Josh\'s typed reply. Case-insensitive substring match. Leave empty to get the most recent cards regardless of content.',
      },
      allStewards: {
        type: 'boolean',
        description:
          'Optional. When true, search the WHOLE fleet instead of your own top-steward lineage. Default is false (results are scoped to the calling steward\'s lineage). Ignored if an explicit "steward" is passed.',
      },
      steward: {
        type: 'string',
        description:
          'Optional. Target a specific steward (overrides the default lineage scope). Substring match on session_id (e.g. "givegrove") unless stewardExact is true.',
      },
      stewardExact: {
        type: 'boolean',
        description:
          'Optional. When true, "steward" must match the session_id exactly instead of as a substring. Use this to avoid pulling in prefix-sharing siblings (e.g. "holler-homestead" vs "holler-homestead--foreman").',
      },
      limit: {
        type: 'number',
        description: 'Optional. Max results to return. Default 25, max 2000.',
      },
    },
    required: [],
  },

  async execute(args) {
    const { query, allStewards, steward, stewardExact, limit } = args || {};

    // Default to a tight, readable window of recent cards. The underlying
    // endpoint defaults to 200; a steward re-grounding wants the freshest few,
    // not a wall of history.
    const effectiveLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 2000);

    // --- SCOPE RESOLUTION ---
    // Precedence: explicit steward > allStewards > default lineage scope.
    //   • explicit steward  → target that steward (substring, or exact if
    //     stewardExact); overrides the lineage default entirely.
    //   • allStewards:true  → fleet-wide, no steward filter.
    //   • neither           → default to the CALLER's top-steward lineage
    //     (substring on the top-steward prefix, exact OFF, so the whole
    //     lineage — top + foreman + workers — is included).
    // If the caller's session can't be resolved AND no explicit scope was
    // given, degrade gracefully to fleet-wide with an explicit note.
    const callerSession = getTmuxSessionId();
    let scopeSteward = null;      // value we send as `steward` param
    let scopeExact = false;       // value we send as `stewardExact`
    let scopeMode;                // for the response: how scope was decided
    let scopeNote = null;         // extra caller-facing note (degrade case)

    if (steward) {
      scopeSteward = String(steward);
      scopeExact = !!stewardExact;
      scopeMode = 'explicit_steward';
    } else if (allStewards) {
      scopeMode = 'all_stewards';
    } else {
      const topSteward = resolveTopSteward(callerSession || '');
      // Real sessions are always "holler-*". Require that prefix before we
      // trust the derived scope — a malformed-but-truthy session shouldn't
      // silently scope to a junk prefix (and return empty); degrade instead.
      if (topSteward && topSteward.startsWith('holler-')) {
        scopeSteward = topSteward;
        scopeExact = false; // substring on the prefix sweeps the whole lineage
        scopeMode = 'lineage_default';
      } else {
        // Couldn't resolve the calling steward (revive/headless/no-tmux).
        // Don't crash, don't silently return empty — widen to fleet-wide and
        // tell the caller the lineage default didn't apply.
        scopeMode = 'lineage_default_degraded';
        scopeNote =
          'Could not resolve the calling steward (no tmux session). Searched fleet-wide instead of your lineage; pass an explicit "steward" if you meant to scope.';
      }
    }

    const params = new URLSearchParams();
    if (query) params.set('q', String(query));
    if (scopeSteward) params.set('steward', scopeSteward);
    if (scopeExact) params.set('stewardExact', '1');
    params.set('limit', String(effectiveLimit));

    let payload;
    try {
      const response = await fetch(
        `${SERVER_URL}/api/presenter/history-search?${params.toString()}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) {
        return {
          success: false,
          error: `history-search endpoint returned ${response.status}. Is the Homestead server running on ${SERVER_URL}?`,
        };
      }
      payload = await response.json();
    } catch (error) {
      return {
        success: false,
        error: `Could not reach the Homestead server at ${SERVER_URL} (${error.message}). The server must be running for history search.`,
      };
    }

    const raw = Array.isArray(payload?.results) ? payload.results : [];
    const results = raw.map(formatCard);

    const baseNote =
      results.length === 0
        ? 'No matching past cards in this scope. Try a broader keyword, pass allStewards:true to search the whole fleet, or leave query empty for the most recent cards.'
        : 'Newest-first. Each result shows BOTH sides (what Josh was asked / how he replied) plus "when" (absolute) and "when_relative" (e.g. "3 months ago").';

    return {
      success: true,
      query: query || null,
      scope: scopeMode, // lineage_default | all_stewards | explicit_steward | lineage_default_degraded
      scoped_to: scopeSteward || null, // the steward-prefix filter actually applied (null = fleet-wide)
      count: results.length,
      note: scopeNote ? `${scopeNote} ${baseNote}` : baseNote,
      current_steward: callerSession || null,
      results,
    };
  },
};

// Distill an archived card into an actionable both-sides shape. The archive
// item carries the original presentation (title/message) plus a `feedback`
// object with how Josh resolved it (which button, any typed text, or dismissed).
export function formatCard(item) {
  const fb = item.feedback || {};
  let josh_reply;
  if (fb.dismissed) {
    josh_reply = { action: 'dismissed', button: null, text: '' };
  } else {
    josh_reply = {
      action: fb.button ? 'pressed_button' : fb.text ? 'typed_reply' : 'resolved',
      button: fb.button || null,
      text: fb.text || '',
    };
  }

  const ms = item.resolved_at || item.timestamp;
  return {
    steward: item._session_id || item.session_id || null,
    when: toIso(ms),
    // Pre-computed relative age so the model never has to do date math. Josh:
    // "LLMs are just okay at time." Load-bearing context — a most-recent match
    // that's "over a year ago" hints the thing may be named differently now.
    when_relative: toRelative(ms),
    // What Josh was shown:
    title: item.title || '',
    message: item.message || '',
    // How Josh responded:
    josh_reply,
  };
}

function toIso(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// Turn an absolute ms timestamp into a plain, unambiguous "X ago" string,
// computed live against the real clock in this MCP process. Buckets escalate
// seconds → minutes → hours → days → weeks → months → years. Future/clock-skew
// timestamps read as "just now" rather than a negative delta.
function toRelative(ms) {
  if (!ms) return null;
  const then = Number(ms);
  if (!Number.isFinite(then)) return null;
  const now = Date.now();
  let diff = Math.floor((now - then) / 1000); // seconds elapsed
  if (diff < 0) diff = 0;

  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

  if (diff < 5) return 'just now';
  if (diff < 60) return plural(diff, 'second');

  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return plural(minutes, 'minute');

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');

  const days = Math.floor(hours / 24);
  if (days < 7) return plural(days, 'day');

  const weeks = Math.floor(days / 7);
  if (days < 30) return plural(weeks, 'week');

  const months = Math.floor(days / 30);
  if (months < 12) return plural(months, 'month');

  const years = Math.floor(days / 365);
  if (years === 1 && months < 18) return 'about a year ago';
  if (years === 1) return 'over a year ago';
  return plural(years, 'year');
}
