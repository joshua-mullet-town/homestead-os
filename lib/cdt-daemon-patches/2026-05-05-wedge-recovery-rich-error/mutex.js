// FIFO mutex with per-hold timeout and rich holder introspection.
// acquire({ session, tool }) returns a release function. If the caller holds
// the lock longer than `timeoutMs`, release is forced and `onTimeout` fires.
// currentHolder() exposes who's holding the lock and for how long so waiters
// can render a conversational message instead of a plain timeout error.

export class FifoMutex {
  constructor({ timeoutMs = 60_000, onTimeout = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.onTimeout = onTimeout;
    this._queue = [];
    this._locked = false;
    this._currentHolder = null;
  }

  get queueLength() {
    return this._queue.length;
  }

  get locked() {
    return this._locked;
  }

  currentHolder() {
    if (!this._currentHolder) return null;
    return {
      session: this._currentHolder.session,
      tool: this._currentHolder.tool,
      heldMs: Date.now() - this._currentHolder.acquiredAt,
      // Optional fields populated by callers that pre-resolved a target hint
      // (see daemon.js getActiveWedgeTarget). null when not applicable.
      targetId: this._currentHolder.targetId ?? null,
      targetUrl: this._currentHolder.targetUrl ?? null,
    };
  }

  acquire({ session = 'anonymous', tool = 'unknown', targetId = null, targetUrl = null, onPerCallTimeout = null } = {}) {
    return new Promise((resolve) => {
      this._queue.push({ session, tool, targetId, targetUrl, onPerCallTimeout, resolve });
      this._drain();
    });
  }

  _drain() {
    if (this._locked) return;
    const next = this._queue.shift();
    if (!next) return;

    this._locked = true;
    let released = false;
    const holder = {
      session: next.session,
      tool: next.tool,
      targetId: next.targetId ?? null,
      targetUrl: next.targetUrl ?? null,
      acquiredAt: Date.now(),
    };
    this._currentHolder = holder;

    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this._locked = false;
      if (this._currentHolder === holder) this._currentHolder = null;
      setImmediate(() => this._drain());
    };

    const timer = setTimeout(() => {
      if (!released) {
        const timeoutInfo = {
          session: holder.session,
          tool: holder.tool,
          heldMs: Date.now() - holder.acquiredAt,
          targetId: holder.targetId ?? null,
          targetUrl: holder.targetUrl ?? null,
        };
        try { this.onTimeout(timeoutInfo); } catch (_e) {}
        if (next.onPerCallTimeout) {
          try { next.onPerCallTimeout(timeoutInfo); } catch (_e) {}
        }
        release();
      }
    }, this.timeoutMs);

    next.resolve(release);
  }
}
