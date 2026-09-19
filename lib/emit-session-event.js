/**
 * Emit session lifecycle events over Socket.IO.
 *
 * Used by every session-create and session-destroy path so the web sidebar
 * and presenter update in real-time.
 *
 * Payload shapes (locked with Presenter substeward):
 *   session:created { sessionId, parent, createdAt }
 *   session:deleted { sessionId, parent }
 *
 * `parent` is the sessionId with the last "--"-delimited segment removed,
 * or null for top-level stewards. Included explicitly so listeners don't
 * need to parse.
 *
 * Safe to call from anywhere: silently no-ops when `global.io` isn't set
 * (e.g. when lib scripts run as standalone CLI before the server boots).
 *
 * ---
 * CANONICAL ENTRY POINTS FOR EXTERNAL CALLERS (bash scripts, CLI tools,
 * anything NOT running inside the server process):
 *
 *   POST http://localhost:3005/api/emit/session-created
 *     body: { sessionId: string, createdAt?: number }
 *     response: 200 { emitted: true, sessionId } | 400 | 500
 *
 *   POST http://localhost:3005/api/emit/session-deleted
 *     body: { sessionId: string, parent?: string (ignored, recomputed) }
 *     response: 200 { emitted: true, sessionId } | 400 | 500
 *
 * This is the pattern for spawning a sub-sub-steward from a bash script
 * (e.g. Foreman's spawn-substeward.sh):
 *   1. Raw `tmux new-session -d -s "holler-{parent}--{id}" -c "{cwd}" "{cmd}"`
 *      (full control over env vars, bootstrap prompt, claude args, etc.)
 *   2. `curl -sS -X POST http://localhost:3005/api/emit/session-created \
 *        -H 'Content-Type: application/json' -d '{"sessionId":"holler-{parent}--{id}"}'`
 *   3. On teardown: `tmux kill-session -t "holler-{parent}--{id}"` +
 *      POST to /api/emit/session-deleted
 *
 * Do NOT require() this file from outside the server process — `global.io`
 * won't be set so emits silently drop. Use the HTTP endpoints instead.
 */

function computeParent(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const parts = sessionId.split('--');
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join('--');
}

function emitSessionCreated(sessionId, extra = {}) {
  try {
    if (!global.io) return;
    const payload = {
      sessionId,
      parent: computeParent(sessionId),
      createdAt: extra.createdAt || Date.now(),
    };
    global.io.emit('session:created', payload);
  } catch (err) {
    // Never throw from an emit — session lifecycle must succeed even if socket is down.
    console.error('[emitSessionEvent] session:created failed:', err.message);
  }
}

function emitSessionDeleted(sessionId) {
  try {
    if (!global.io) return;
    const payload = {
      sessionId,
      parent: computeParent(sessionId),
    };
    global.io.emit('session:deleted', payload);
  } catch (err) {
    console.error('[emitSessionEvent] session:deleted failed:', err.message);
  }
}

module.exports = { emitSessionCreated, emitSessionDeleted, computeParent };
