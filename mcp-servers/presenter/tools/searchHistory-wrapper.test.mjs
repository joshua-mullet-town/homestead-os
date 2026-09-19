/**
 * REAL unit tests for the search_history TOOL WRAPPER's both-sides shaping.
 *
 * formatCard() distills a raw archived card into a structured, actionable
 * result: what Josh was shown (title/message) and how he replied (josh_reply:
 * button + text, or dismissed). This is what a steward reads on handoff pickup,
 * so the shape must be unambiguous.
 *
 * Run: node --test mcp-servers/presenter/tools/searchHistory-wrapper.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCard, searchHistoryTool } from './searchHistory.js';

test('formatCard surfaces BOTH sides — shown fields and Josh\'s button+text reply', () => {
  // A fixed, realistic epoch-ms (2021-01-01T00:00:00Z) — deterministic, no clock dependency.
  const WHEN_MS = 1609459200000;
  const out = formatCard({
    _session_id: 'holler-homestead',
    resolved_at: WHEN_MS,
    title: 'Deploy the widget',
    message: 'Ready to ship?',
    feedback: { button: 'Approve', text: 'yes ship it' },
  });

  assert.equal(out.steward, 'holler-homestead');
  // Shown side:
  assert.equal(out.title, 'Deploy the widget');
  assert.equal(out.message, 'Ready to ship?');
  // Reply side:
  assert.equal(out.josh_reply.action, 'pressed_button');
  assert.equal(out.josh_reply.button, 'Approve');
  assert.equal(out.josh_reply.text, 'yes ship it');
  // Timestamp normalized to ISO:
  assert.equal(out.when, '2021-01-01T00:00:00.000Z');
});

test('formatCard marks a dismissed card distinctly', () => {
  const out = formatCard({
    _session_id: 's',
    resolved_at: 0,
    title: 't',
    message: 'm',
    feedback: { dismissed: true },
  });
  assert.equal(out.josh_reply.action, 'dismissed');
  assert.equal(out.josh_reply.button, null);
  assert.equal(out.josh_reply.text, '');
});

test('formatCard classifies a typed-only reply (no button) as typed_reply', () => {
  const out = formatCard({
    _session_id: 's',
    resolved_at: 0,
    title: 't',
    message: 'm',
    feedback: { text: 'just some thoughts' },
  });
  assert.equal(out.josh_reply.action, 'typed_reply');
  assert.equal(out.josh_reply.button, null);
  assert.equal(out.josh_reply.text, 'just some thoughts');
});

test('formatCard tolerates a card with no feedback object', () => {
  const out = formatCard({ _session_id: 's', resolved_at: 0, title: 't', message: 'm' });
  assert.equal(out.josh_reply.action, 'resolved');
  assert.equal(out.josh_reply.button, null);
  assert.equal(out.josh_reply.text, '');
});

test('formatCard falls back to session_id and timestamp when _session_id/resolved_at absent', () => {
  const out = formatCard({ session_id: 'fallback-sid', timestamp: 1609459200000, title: 't', message: 'm' });
  assert.equal(out.steward, 'fallback-sid');
  assert.equal(out.when, '2021-01-01T00:00:00.000Z');
});

test('the tool advertises an actionable, both-sides contract to stewards', () => {
  // Guardrails so the tool never silently loses its purpose in a refactor.
  assert.equal(searchHistoryTool.name, 'search_history');
  assert.match(searchHistoryTool.description, /BOTH SIDES/);
  assert.match(searchHistoryTool.description, /newest-first/);
  // query is optional (empty query -> recent cards).
  assert.deepEqual(searchHistoryTool.inputSchema.required, []);
  // The steward-facing filters exist.
  const props = searchHistoryTool.inputSchema.properties;
  for (const key of ['query', 'steward', 'stewardExact', 'limit']) {
    assert.ok(props[key], `schema must expose "${key}"`);
  }
});
