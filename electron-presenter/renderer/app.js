// --- Config ---
const TAILSCALE_HOSTNAME = 'joshuas-macbook-air.tail84bb3b.ts.net';

// Rewrite localhost URLs for mobile/embedded access via Tailscale
function rewriteLocalhostUrl(url) {
  return url.replace(/\blocalhost\b/g, TAILSCALE_HOSTNAME)
            .replace(/\b127\.0\.0\.1\b/g, TAILSCALE_HOSTNAME);
}

// Extract a URL from an "open <url>" command, rewrite localhost for embedded
function extractAndRewriteOpenUrl(command) {
  const match = command.match(/^open\s+(https?:\/\/\S+)/i);
  if (!match) return null;
  return rewriteLocalhostUrl(match[1]);
}

// --- Environment adapter ---
if (!window.presenter) {
  const SERVER_URL = window.location.origin || 'http://localhost:3005';
  const queueUpdateCallbacks = [];
  // Explicit delivery-signal subscribers. The send path subscribes BEFORE
  // issuing the send so we never miss a fast resolve, then unsubscribes via
  // the returned disposer. See waitForDeliveryConfirmation / pollForWalkieDelivery.
  const itemResolvedCallbacks = new Set();
  const walkieEnqueuedCallbacks = new Set();
  const walkieConfirmedCallbacks = new Set();
  const bookmarksUpdatedCallbacks = new Set();
  const cardLinksUpdatedCallbacks = new Set();
  const readStateUpdatedCallbacks = new Set();
  const draftsUpdatedCallbacks = new Set();
  let socketIo = null;

  window.presenter = {
    onQueueUpdate(callback) { queueUpdateCallbacks.push(callback); },
    // payload: { id, feedback } — fires when a presenter card is resolved/dismissed
    onItemResolved(callback) { itemResolvedCallbacks.add(callback); return () => itemResolvedCallbacks.delete(callback); },
    // payload: { id, target_session, created_at, message } — fires when a walkie
    // item is enqueued (proves the message landed on the laptop side). This is
    // the primary "send succeeded" signal for the bottom-bar walkie path.
    onWalkieEnqueued(callback) { walkieEnqueuedCallbacks.add(callback); return () => walkieEnqueuedCallbacks.delete(callback); },
    // payload: { id, target_session, confirmed_by } — fires when a walkie-talkie
    // queue item is confirmed received by the steward (proves delivery, not just dispatch)
    onWalkieConfirmed(callback) { walkieConfirmedCallbacks.add(callback); return () => walkieConfirmedCallbacks.delete(callback); },
    // payload: { session_name } — fires when /api/bookmarks POST or DELETE
    // mutates the server store. Lets the bookmark UI re-hydrate without reload.
    onBookmarksUpdated(callback) { bookmarksUpdatedCallbacks.add(callback); return () => bookmarksUpdatedCallbacks.delete(callback); },
    // payload: { session_name } — fires when a card link is auto-saved
    // (addItem), opened, or forgotten via /api/card-links. Lets the card-links
    // UI re-hydrate without reload.
    onCardLinksUpdated(callback) { cardLinksUpdatedCallbacks.add(callback); return () => cardLinksUpdatedCallbacks.delete(callback); },
    // payload: { [itemId]: true, ... } — partial map of newly-read items
    // emitted by /api/presenter/read-state POST. Lets every device merge and
    // re-render sidebar/topbar so read-state syncs across phone + laptop.
    onReadStateUpdated(callback) { readStateUpdatedCallbacks.add(callback); return () => readStateUpdatedCallbacks.delete(callback); },
    // payload: { key, value } — single draft change emitted by
    // /api/presenter/drafts POST. Empty string value means delete.
    onDraftsUpdated(callback) { draftsUpdatedCallbacks.add(callback); return () => draftsUpdatedCallbacks.delete(callback); },
    // respond(id, button, text, keepCard?, sendId?)
    // keepCard=true (Josh 2026-07-10): deliver the reply + card context to the
    // steward WITHOUT dismissing the card — it stays in the queue/deck so Josh
    // can reply again. In that mode we also skip dismissing the phone
    // notification, since the card is still live.
    // sendId (2026-07-13): a stable per-send idempotency key. On a flaky phone
    // link the first POST can succeed server-side while its response is lost, so
    // the UI shows "failed" and retries. Reusing the SAME sendId across the
    // initial attempt and every retry lets the server recognise the duplicate
    // and return the original success instead of 404-ing (retry-never-works) or
    // re-delivering (double-send).
    async respond(id, button, text, keepCard, sendId) {
      console.log('[Presenter] respond() called:', { id, button, text: text ? text.substring(0, 50) : undefined, keepCard: !!keepCard, sendId, SERVER_URL });
      try {
        const res = await fetch(`${SERVER_URL}/api/presenter/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, button, text, keepCard: !!keepCard, sendId }),
        });
        console.log('[Presenter] respond() result:', res.status, res.statusText);
        if (!res.ok) throw new Error('respond failed: ' + res.status);
      } catch (err) {
        console.error('[Presenter] respond() FAILED:', err.message || err);
        throw err;
      }
      // Dismiss the Android notification for this card — but only when the card
      // itself is being dismissed. In keepCard mode the card is still live.
      if (!keepCard && window.Android && window.Android.dismissNotification) {
        try { window.Android.dismissNotification(id); } catch(e) {}
      }
    },
    async dismiss(id) {
      const res = await fetch(`${SERVER_URL}/api/presenter/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error('dismiss failed: ' + res.status);
      // Dismiss the Android notification for this card
      if (window.Android && window.Android.dismissNotification) {
        try { window.Android.dismissNotification(id); } catch(e) {}
      }
    },
    async getQueue() {
      try {
        const res = await fetch(`${SERVER_URL}/api/presenter/queue`);
        const data = await res.json();
        return data.queue || [];
      } catch { return []; }
    },
    openUrl(url) { window.open(url, '_blank'); },
    runCommand(command) { console.warn('[Presenter] runCommand not available in browser:', command); },
    minimize() {},
  };

  function connectPresenterSocket() {
    if (typeof io === 'undefined') {
      setInterval(async () => {
        const q = await window.presenter.getQueue();
        queueUpdateCallbacks.forEach(cb => cb(q));
      }, 3000);
      return;
    }
    socketIo = io(SERVER_URL);
    socketIo.on('connect', async () => {
      socketIo.emit('presenter:register', 'mobile-web');
      const q = await window.presenter.getQueue();
      queueUpdateCallbacks.forEach(cb => cb(q));
    });
    socketIo.on('presenter:new-item', async (item) => {
      if (item && item.id) socketIo.emit('presenter:ack', item.id);
      const q = await window.presenter.getQueue();
      queueUpdateCallbacks.forEach(cb => cb(q));
    });
    socketIo.on('presenter:item-resolved', async (payload) => {
      // Explicit delivery signal — fires the instant a card is resolved server-side.
      // Replaces the old queue-polling proxy that produced fake "send failed" toasts
      // when the server took longer than the timeout to resolve the card.
      try { itemResolvedCallbacks.forEach(cb => { try { cb(payload || {}); } catch (e) { console.error('[onItemResolved]', e); } }); } catch (e) {}
      const q = await window.presenter.getQueue();
      queueUpdateCallbacks.forEach(cb => cb(q));
    });
    // Walkie-talkie enqueue signal — emitted by queueDispatcher.enqueue() the
    // moment a message lands on the laptop side. Payload:
    // { id, target_session, created_at, message }.
    socketIo.on('walkie:enqueued', (payload) => {
      try { walkieEnqueuedCallbacks.forEach(cb => { try { cb(payload || {}); } catch (e) { console.error('[onWalkieEnqueued]', e); } }); } catch (e) {}
    });
    // Walkie-talkie delivery confirmation — emitted by queueDispatcher.confirm()
    // when the receiving steward roger-thats the message. Payload:
    // { id, target_session, confirmed_by }.
    socketIo.on('walkie:confirmed', (payload) => {
      try { walkieConfirmedCallbacks.forEach(cb => { try { cb(payload || {}); } catch (e) { console.error('[onWalkieConfirmed]', e); } }); } catch (e) {}
    });
    // Bookmark store mutated (POST or DELETE on /api/bookmarks). Fan out so the
    // bookmark UI can re-hydrate without a reload. Payload: { session_name }.
    socketIo.on('presenter:bookmarks-updated', (payload) => {
      try { bookmarksUpdatedCallbacks.forEach(cb => { try { cb(payload || {}); } catch (e) { console.error('[onBookmarksUpdated]', e); } }); } catch (e) {}
    });
    // Card-links store mutated (auto-save in addItem, or POST/DELETE on
    // /api/card-links). Fan out so the card-links UI re-hydrates without a
    // reload. Payload: { session_name }.
    socketIo.on('presenter:card-links-updated', (payload) => {
      try { cardLinksUpdatedCallbacks.forEach(cb => { try { cb(payload || {}); } catch (e) { console.error('[onCardLinksUpdated]', e); } }); } catch (e) {}
    });
    // Read-state store mutated (/api/presenter/read-state POST). Fan out so
    // every device merges + re-renders. Payload: { [itemId]: true, ... }.
    socketIo.on('presenter:read-state-updated', (payload) => {
      try { readStateUpdatedCallbacks.forEach(cb => { try { cb(payload || {}); } catch (e) { console.error('[onReadStateUpdated]', e); } }); } catch (e) {}
    });
    // Per-card draft text mutated (/api/presenter/drafts POST). Fan out so any
    // device with the same card visible can merge the new value into its
    // textarea. Payload: { key, value } where empty value = delete.
    socketIo.on('presenter:drafts-updated', (payload) => {
      try { draftsUpdatedCallbacks.forEach(cb => { try { cb(payload || {}); } catch (e) { console.error('[onDraftsUpdated]', e); } }); } catch (e) {}
    });
    // Consolidated bulk-dismiss event — one refresh for N cards
    socketIo.on('presenter:bulk-resolved', async () => {
      const q = await window.presenter.getQueue();
      queueUpdateCallbacks.forEach(cb => cb(q));
    });
    // In-place item update (e.g. pin toggle). Refetch so card fields re-render.
    socketIo.on('presenter:item-updated', async () => {
      const q = await window.presenter.getQueue();
      queueUpdateCallbacks.forEach(cb => cb(q));
    });
    // Session lifecycle — re-fetch /api/stewards so the sidebar picks up
    // new or dead sessions (e.g. ephemeral Foreman workers). Payload:
    // { sessionId, parent?, createdAt? }. 30s poll stays as a fallback.
    const _onSessionLifecycle = () => { if (typeof fetchStewards === 'function') fetchStewards(); };
    socketIo.on('session:created', _onSessionLifecycle);
    socketIo.on('session:deleted', _onSessionLifecycle);

    // Real-time session status updates from server
    socketIo.on('presenter:status-update', (statuses) => {
      if (statuses && typeof statuses === 'object') {
        sessionStatuses = statuses;
        renderSidebar();
        // Don't call renderView() here — it causes flickering from full DOM rebuild
      }
    });

    // Real-time activity updates from server
    socketIo.on('presenter:activity-update', (updates) => {
      if (!updates || typeof updates !== 'object') return;
      for (const [sid, data] of Object.entries(updates)) {
        activityCache[sid] = data;
      }
      // Update the toolbar (contains activity panel)
      if (selectedSteward) renderBottomToolbar();
    });

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connectPresenterSocket);
  } else {
    connectPresenterSocket();
  }
}

// --- Delivery confirmation system ---
// Primary: explicit socket signal `presenter:item-resolved` (emitted server-side
// the instant the card is resolved). Fallback: queue polling — kept as a safety
// net in case the socket connection is down. The fallback timeout is intentionally
// LONG (much longer than the old 30-35s) because its only job now is to cover the
// rare case where the socket event was missed; transient steward slowness should
// never trip it. Caller's `timeoutMs` is treated as the safety-net duration, with
// a floor of 120s so we don't false-positive while a steward is mid-thought.
const pendingDeliveryConfirmations = {}; // kept for Socket.IO fallback

function waitForDeliveryConfirmation(cardId, timeoutMs = 30000) {
  const SERVER_URL = window.location.origin || 'http://localhost:3005';
  // Floor the safety-net timeout. Old call sites passed 15-35s, which is what
  // caused the fake "Message failed to send" toast when steward processing
  // outran the poll window. With the explicit signal, the only role of the
  // poll is socket-down fallback, so a long ceiling is correct.
  const SAFETY_NET_MS = Math.max(timeoutMs, 120000);
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = null;
    let interval = null;
    function finish(fn, arg) {
      if (done) return;
      done = true;
      if (interval) { clearInterval(interval); interval = null; }
      if (unsubscribe) { try { unsubscribe(); } catch (e) {} unsubscribe = null; }
      fn(arg);
    }
    // Primary: explicit signal — fires the moment the card is resolved.
    if (window.presenter && typeof window.presenter.onItemResolved === 'function') {
      unsubscribe = window.presenter.onItemResolved((payload) => {
        if (payload && payload.id === cardId) {
          finish(resolve, { id: cardId, confirmed: true, via: 'socket' });
        }
      });
    }
    // Fallback safety net: poll for queue removal. Only relevant if the socket
    // signal never arrives (socket down, server restart mid-send, etc).
    let elapsed = 0;
    interval = setInterval(() => {
      elapsed += 2000;
      if (elapsed > SAFETY_NET_MS) {
        finish(reject, new Error('Delivery timed out — no confirmation received'));
        return;
      }
      fetch(`${SERVER_URL}/api/presenter/queue`).then(r => r.json()).then(data => {
        const q = data.queue || data || [];
        const stillThere = q.find(item => item.id === cardId);
        if (!stillThere) {
          finish(resolve, { id: cardId, confirmed: true, via: 'poll' });
        }
      }).catch(() => {});
    }, 2000);
  });
}

// --- Error toast system ---
// Shows a red error banner with message and optional retry button
function showErrorToast(message, retryFn) {
  let errorToast = document.getElementById('error-toast');
  if (!errorToast) {
    errorToast = document.createElement('div');
    errorToast.id = 'error-toast';
    document.body.appendChild(errorToast);
  }
  errorToast.innerHTML = '';
  const msgSpan = document.createElement('span');
  msgSpan.className = 'error-toast-msg';
  msgSpan.textContent = message;
  errorToast.appendChild(msgSpan);
  if (retryFn) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'error-toast-retry';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => {
      errorToast.classList.remove('visible');
      retryFn();
    });
    errorToast.appendChild(retryBtn);
  }
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'error-toast-dismiss';
  dismissBtn.textContent = '✕';
  dismissBtn.addEventListener('click', () => errorToast.classList.remove('visible'));
  errorToast.appendChild(dismissBtn);
  errorToast.classList.add('visible');
  // Auto-hide after 15 seconds if no interaction
  setTimeout(() => errorToast.classList.remove('visible'), 15000);
}

// --- Name toast (iter4) ---
// Lightweight, neutral, self-dismissing toast used by the worker-subbar "⋯"
// button to briefly reveal a truncated worker's FULL name. Separate from the
// error toast so it never looks like an error. Single reused element.
let _nameToastTimer = null;
function showNameToast(text) {
  let t = document.getElementById('name-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'name-toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('visible');
  if (_nameToastTimer) clearTimeout(_nameToastTimer);
  // Brief — Josh: "toasts the full name ... very briefly."
  _nameToastTimer = setTimeout(() => t.classList.remove('visible'), 2200);
}

// --- Native-style context menu (long-press on mobile, right-click on desktop) ---
// Single-instance floating menu. Caller passes {x, y, items: [{label, onClick}]}.
// Closes on: outside click, scroll, resize, Escape, or any item invocation.
// Used by per-card actions (Copy attach command, Open tmux view) — see the
// hookup inside buildChatMessages where we bind contextmenu + long-press.
window._presenterCtxMenu = (function () {
  let openMenu = null;
  function close() {
    if (!openMenu) return;
    const el = openMenu.el;
    openMenu = null;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('touchstart', onOutside, true);
    document.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
    document.removeEventListener('keydown', onKey, true);
  }
  function onOutside(ev) {
    if (!openMenu) return;
    if (openMenu.el.contains(ev.target)) return;
    close();
  }
  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  }
  function open(opts) {
    close();
    const items = (opts && opts.items) || [];
    if (items.length === 0) return;
    const menu = document.createElement('div');
    menu.className = 'presenter-ctx-menu';
    menu.setAttribute('role', 'menu');
    items.forEach(function (it) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'presenter-ctx-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = it.label;
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        close();
        try { it.onClick && it.onClick(); } catch (e) { console.error('[ctxMenu]', e); }
      });
      menu.appendChild(btn);
    });
    // Off-screen first so we can measure
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const pad = 6;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = (opts && typeof opts.x === 'number') ? opts.x : 0;
    let y = (opts && typeof opts.y === 'number') ? opts.y : 0;
    if (x + rect.width + pad > vw) x = Math.max(pad, vw - rect.width - pad);
    if (y + rect.height + pad > vh) y = Math.max(pad, vh - rect.height - pad);
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    openMenu = { el: menu };
    // Defer outside-listeners so the same event that opened us doesn't close us
    setTimeout(function () {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('touchstart', onOutside, true);
      document.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }
  return { open: open, close: close };
})();

// Copy text to the clipboard with a fallback for embedded WebViews where
// navigator.clipboard may be unavailable or permission-blocked.
window._presenterCopyText = function (text) {
  return new Promise(function (resolve) {
    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        resolve(!!ok);
      } catch (e) { resolve(false); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { resolve(true); }).catch(fallback);
    } else {
      fallback();
    }
  });
};

// True when sessionId corresponds to a session currently rendered in the
// presenter sidebar/topbar (i.e. a live worker/steward not torn down).
// Source of truth: the same tree collectAllSessionNames() walks for the
// per-session context dashboard. If a worker is torn down it falls out of
// `stewards`, so this returns false naturally.
window._isSessionVisibleInPresenter = function (sessionId) {
  if (!sessionId) return false;
  try {
    const all = (typeof collectAllSessionNames === 'function') ? collectAllSessionNames() : [];
    return all.indexOf(sessionId) >= 0;
  } catch (e) {
    return false;
  }
};

// --- Form state preservation ---
// When cards re-render (queue update, selection change, etc), the whole
// thread gets innerHTML-wiped and rebuilt. That destroys any in-progress
// text Joshua was typing into a .msg-input textarea inside a card.
// captureFormState() snapshots every input's value + focus + selection +
// scroll position. restoreFormState() reapplies them after the rebuild.
//
// Keying strategy: we use the owning .msg-bubble's data-item-id + a
// stable selector chain. Cards with the same item-id get their input
// restored after they rebuild. The bottom #conv-bottom-textarea survives
// naturally (outside convThread) but we still restore its focus/selection
// if it was active during render.
function captureFormState(root) {
  root = root || document;
  const snapshot = {
    inputsByItem: {},       // itemId -> { value, selStart, selEnd }
    scrollByItem: {},       // itemId -> scrollTop of that bubble (mobile deck)
    bottomTextareaSelection: null,
    focusedItemId: null,
    focusedInputKey: null,  // 'bottom' | 'msg-input'
    convScrollTop: null,
  };
  // Capture each .msg-input inside a card, keyed by its owning bubble's item id
  root.querySelectorAll('.msg-bubble[data-item-id]').forEach(function (bubble) {
    const id = bubble.dataset.itemId;
    if (!id) return;
    // Per-card scroll position. On mobile-deck mode each bubble is its own
    // scroll container; preserve across re-renders so a new card arriving
    // doesn't bounce the user back to the top of the card they're reading.
    if (typeof bubble.scrollTop === 'number' && bubble.scrollTop > 0) {
      snapshot.scrollByItem[id] = bubble.scrollTop;
    }
    const ta = bubble.querySelector('.msg-input');
    if (!ta) return;
    const entry = { value: ta.value };
    if (document.activeElement === ta) {
      entry.selStart = ta.selectionStart;
      entry.selEnd = ta.selectionEnd;
      snapshot.focusedItemId = id;
      snapshot.focusedInputKey = 'msg-input';
    }
    snapshot.inputsByItem[id] = entry;
  });
  // Bottom textarea — it survives innerHTML wipes (lives outside convThread)
  // but we still need to remember its focus + selection if it was active.
  const bot = document.getElementById('conv-bottom-textarea');
  if (bot && document.activeElement === bot) {
    snapshot.bottomTextareaSelection = { start: bot.selectionStart, end: bot.selectionEnd };
    snapshot.focusedInputKey = 'bottom';
  }
  const thread = document.getElementById('conv-thread');
  if (thread) snapshot.convScrollTop = thread.scrollTop;
  return snapshot;
}

function restoreFormState(snapshot) {
  if (!snapshot) return;
  // Restore per-card scroll position (bubble-level). Deferred via rAF so
  // applyMobileDeck's re-positioning finishes before we nudge scrollTop.
  if (snapshot.scrollByItem && Object.keys(snapshot.scrollByItem).length) {
    requestAnimationFrame(() => {
      Object.entries(snapshot.scrollByItem).forEach(function ([id, top]) {
        const bubble = document.querySelector('.msg-bubble[data-item-id="' + id + '"]');
        if (bubble && typeof top === 'number') {
          try { bubble.scrollTop = top; } catch {}
        }
      });
    });
  }
  // Restore per-card textarea values
  Object.entries(snapshot.inputsByItem).forEach(function ([id, entry]) {
    const bubble = document.querySelector('.msg-bubble[data-item-id="' + id + '"]');
    if (!bubble) return;
    const ta = bubble.querySelector('.msg-input');
    if (!ta) return;
    if (entry.value != null && ta.value !== entry.value) ta.value = entry.value;
    if (snapshot.focusedItemId === id && snapshot.focusedInputKey === 'msg-input') {
      try {
        ta.focus();
        if (entry.selStart != null) ta.setSelectionRange(entry.selStart, entry.selEnd);
      } catch {}
    }
  });
  // Restore bottom textarea focus + selection
  if (snapshot.focusedInputKey === 'bottom') {
    const bot = document.getElementById('conv-bottom-textarea');
    if (bot && document.activeElement !== bot) {
      try {
        bot.focus();
        if (snapshot.bottomTextareaSelection) {
          bot.setSelectionRange(snapshot.bottomTextareaSelection.start, snapshot.bottomTextareaSelection.end);
        }
      } catch {}
    }
  }
}

// --- Per-card draft persistence (server-backed, was localStorage pre-2026-06-06) ---
// Each .msg-input textarea has its own draft, keyed by sessionId + itemId.
// Server is the single source of truth so the same draft text shows up on
// phone + laptop. In-memory `draftCache` mirrors the server map; reads are
// synchronous off the cache; writes update cache + debounced POST.
// Survives steward switches AND presenter refreshes. Cleared on real send.
const draftCache = new Map();
const draftSaveTimers = new Map();    // key -> setTimeout handle (per-key debounce)
const draftLastLocalEdit = new Map(); // key -> ms timestamp; race-gate so an
                                      // incoming socket push doesn't clobber
                                      // what the user is actively typing on
                                      // THIS surface.
const DRAFT_SAVE_DEBOUNCE_MS = 400;
const DRAFT_RACE_GATE_MS = 2000;

function draftKey(sessionId, itemId) {
  return 'presenter-draft:' + (sessionId || 'unknown') + ':' + itemId;
}
function getDraft(sessionId, itemId) {
  return draftCache.get(draftKey(sessionId, itemId)) || '';
}
function postDraftToServer(key, value) {
  fetch('/api/presenter/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }).catch((err) => { console.warn('[drafts] save failed:', err); });
}
function setDraft(sessionId, itemId, value) {
  const key = draftKey(sessionId, itemId);
  draftLastLocalEdit.set(key, Date.now());
  if (value) draftCache.set(key, value);
  else draftCache.delete(key);
  // Debounce per-key so a keystroke burst collapses to one POST.
  const prev = draftSaveTimers.get(key);
  if (prev) clearTimeout(prev);
  draftSaveTimers.set(key, setTimeout(() => {
    draftSaveTimers.delete(key);
    postDraftToServer(key, value || '');
  }, DRAFT_SAVE_DEBOUNCE_MS));
}
function clearDraft(sessionId, itemId) {
  const key = draftKey(sessionId, itemId);
  draftCache.delete(key);
  draftLastLocalEdit.set(key, Date.now());
  // Clear is a terminal action (real send committed) — flush immediately,
  // skip the debounce window so the next render across devices doesn't
  // restore the stale draft.
  const prev = draftSaveTimers.get(key);
  if (prev) { clearTimeout(prev); draftSaveTimers.delete(key); }
  postDraftToServer(key, '');
}

// --- Per-steward card layout ('stacked' | 'side-by-side') ---
// Where the card's input textarea sits relative to card content.
// Default = 'stacked' (input below content). Per-steward, persisted to localStorage.
function layoutKey(sessionId) { return 'presenter-card-layout:' + (sessionId || 'default'); }
function getLayoutPref(sessionId) {
  try {
    const v = localStorage.getItem(layoutKey(sessionId));
    return (v === 'side-by-side' || v === 'stacked') ? v : 'stacked';
  } catch { return 'stacked'; }
}
function setLayoutPref(sessionId, mode) {
  try { localStorage.setItem(layoutKey(sessionId), mode); } catch {}
}

// --- App state ---
let queue = [];
let stewards = [];
let selectedSteward = null; // session_id like "holler-givegrove"
let selectedViewMode = 'presenter'; // 'presenter', 'chat', or 'timeline'
// Steward card-view LEVEL (Josh 2026-08-25 two-level selection). Only meaningful
// when a TOP-LEVEL steward (not a worker) is selected:
//   'all' → that steward's own cards + all its workers' cards, chronological.
//   'own' → JUST the steward's own session_id cards (children excluded).
// Repeat-tapping an already-selected steward toggles between the two; the
// topbar icon shows a visual indicator of which level is active. Reset to 'all'
// whenever a different steward/worker is selected.
let stewardCardLevel = 'all'; // 'all' | 'own'
let readState = {};          // itemId -> true
// TRUE once the server read-map has landed (or definitively failed). The
// newest-unread jump MUST NOT run before this: readState is {} until the
// hydrate fetch resolves, so an ungated check would read every card as unread
// on a cold load and throw Josh off his remembered place everywhere.
let readStateHydrated = false;
let historyCache = {};       // sessionId -> [...archived items]
let chatCache = {};           // sessionId -> [...chat messages]
let expandedStewardIds = new Set(); // which stewards have their builds expanded
let buttonCooldown = false;
let preserveScrollPosition = null;
let sessionStatuses = {};
// Sticky last-known status-change time per session (iter6). Belt-and-suspenders
// for the worker-row time badge: even after the server-side fallback, a single
// poll could momentarily hand back a null `updatedAt` (e.g. tmux listed the
// session but its activity file was mid-write). Rather than blank the badge to
// "—" for that frame, we remember the last real timestamp we saw and reuse it.
// Keyed by tmux session id → ISO string. Only ever moves forward.
let lastKnownStatusTime = {};
// Per-worker AHEAD-only git diff (Josh 2026-08-07 redesign): the bottom-right
// chip shows how much work is in the worker's branch that ISN'T in main yet.
// Keyed by tmux session id → { files, add, del, ahead } | null. Fed by
// /api/worker-git-diff on a relaxed cadence (git-diff is heavier than a status
// poll, and the numbers only change when the worker commits). null = no chip.
let workerGitDiffs = {};
let sessionContext = {}; // sessionName -> { pct, tokens, sessionId, ... }
let chatRefreshInterval = null;

// --- Recency/frequency ring state ---
// Josh's last 30 outbound walkie sends, attributed to the top-level steward
// each went to. `ordered` = newest-first steward-id list (drives the
// recency-clockwise fill: index 0 = most recent = top segment, wrapping
// clockwise). `counts` = per-steward totals. Sourced from the walkie-talkie's
// OWN queue log via /api/recency-ring (no duplicate tracker). Recomputed on
// every Josh-send (walkie:enqueued) so the ring repaints as he talks.
const RECENCY_RING_SIZE = 12;
let recencyRing = { ordered: [], counts: {}, total: 0 };

async function fetchRecencyRing() {
  try {
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    const res = await fetch(`${SERVER_URL}/api/recency-ring?limit=${RECENCY_RING_SIZE}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.ok) {
      recencyRing = {
        ordered: Array.isArray(data.ordered) ? data.ordered : [],
        counts: data.counts || {},
        total: data.total || 0,
      };
      // Repaint both icon surfaces (phone topbar + expandable sidebar).
      if (document.body.classList.contains('embedded')) renderEmbeddedTopbar();
      if (typeof renderSidebar === 'function') renderSidebar();
    }
  } catch (e) {
    // Non-fatal — the ring is ambient; if the read fails we just skip the paint.
  }
}

// Build the recency ring around a steward icon: a WATCH-FACE BEZEL of tick
// marks (RECENCY_RING_SIZE of them — Josh iter4: last 12 sends) showing how
// much of Josh's recent walkie sends went to THIS steward, and where in time
// they fell. Returns an SVG positioned to wrap the icon.
//
// Josh iter3/iter4 (2026-08-05): every slot is ALWAYS drawn as an evenly-spaced
// radial tick (like the notches on a watch bezel), so there's a complete, clean,
// designed ring at all times. Slots that belong to THIS steward light up bright
// white; the rest are dim. ALL ticks are the SAME length and width — the only
// difference is brightness (iter4: lit ticks no longer stand taller). This keeps
// both questions Josh cares about — HOW MANY of the last 12 (count of lit ticks)
// and HOW RECENT/DISPERSED (which positions light up, newest at 3 o'clock going
// clockwise) — while looking like an intentional dial.
//
// Still a 270° arc (3 o'clock -> 6 -> 9 -> 12), leaving the upper-right quadrant
// EMPTY so the notification count badge stays clear.
function buildRecencyRingSvg(stewardId /* white ticks: stewardColor unused */) {
  const N = RECENCY_RING_SIZE;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The visible geometry (icon + ticks) wraps a 46px box, but the SVG CANVAS is
  // larger (Josh iter5, 2026-08-11) so the glowing HALO behind the ticks can
  // bloom outward without being clipped. The .recency-ring CSS centers this on
  // the icon via translate(-50%,-50%), so growing it symmetrically stays centered.
  const ICON = 46;            // logical icon box the ticks wrap
  const PAD = 34;             // extra room on every side for the halo bloom
  const size = ICON + PAD * 2;
  const cx = size / 2;
  const cy = size / 2;

  // Tick geometry. Every tick is the SAME length (Josh iter4: lit ticks no
  // longer stand taller — the only difference between on and off is brightness).
  // A tick is a short radial notch; lit ticks are bright white, unlit ones dim.
  const rInner = 18.5;        // inner end of every tick
  const rOuter = 21.5;        // outer end of every tick (same for lit + unlit)

  // Angles: 0deg = 12 o'clock, clockwise positive. Badge sits in 0..90deg
  // (12->3 o'clock) — skip it. Ticks occupy 90deg (3 o'clock) .. 360deg.
  const ARC_START = 90;       // 3 o'clock
  const ARC_SPAN = 270;       // clockwise round to 12 o'clock
  const step = ARC_SPAN / (N - 1);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'recency-ring');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

  // ordered[0] = newest send -> first slot (3 o'clock).
  const ordered = recencyRing.ordered || [];

  // Josh recency-intensity ramp (2026-08-11, iter5 — HALO BEHIND THE TICKS):
  // per-tick drop-shadows were too subtle (thin lines can't throw enough light),
  // so the count now drives a dedicated SOFT HALO DISC sitting BEHIND the ticks.
  // It has NO defined edge — a radial-gradient fill + gaussian blur, pure outward
  // bloom — and it grows BOTH brighter AND wider as more of the last N sends went
  // to THIS steward. The white ticks stay crisp + countable on top; the halo does
  // the shouting. 1 lit = a faint whisper; 12 = a blazing, almost-obnoxious ring.
  //   litCount   -> number of the last N sends that went to THIS steward.
  //   t          -> 0..1 linear position; e -> eased so excitement accelerates.
  const litCount = ordered.reduce((n, id) => (id === stewardId ? n + 1 : n), 0);
  const t = litCount <= 0 ? 0 : Math.min(1, Math.max(0, (litCount - 1) / (N - 1)));
  const e = Math.pow(t, 1.5);           // softer ease: mid counts already glow, top still peaks hard

  function polar(deg, r) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  // --- HALO (rendered FIRST so it sits behind the ticks) ---
  // A filled circle with a soft radial-gradient fill AND a gaussian blur, so it
  // has no hard edge — just outward glow. Radius + brightness both ramp with the
  // count. A unique id keeps each icon's <defs> from colliding.
  if (litCount > 0) {
    const uid = 'rr' + stewardId.replace(/[^a-zA-Z0-9]/g, '') + '_' + litCount;
    const defs = document.createElementNS(SVG_NS, 'defs');

    const grad = document.createElementNS(SVG_NS, 'radialGradient');
    grad.setAttribute('id', uid + 'g');
    const coreAlpha = (0.45 + 0.55 * e).toFixed(3);   // 0.45 .. 1.00 at center (bright floor)
    const midAlpha = (0.22 + 0.55 * e).toFixed(3);
    [[0, `rgba(255,255,255,${coreAlpha})`],
     [40, `rgba(255,255,255,${midAlpha})`],
     [100, 'rgba(255,255,255,0)']].forEach(([off, col]) => {
      const s = document.createElementNS(SVG_NS, 'stop');
      s.setAttribute('offset', off + '%');
      s.setAttribute('stop-color', col);
      grad.appendChild(s);
    });
    defs.appendChild(grad);

    const blur = document.createElementNS(SVG_NS, 'filter');
    blur.setAttribute('id', uid + 'b');
    blur.setAttribute('x', '-100%'); blur.setAttribute('y', '-100%');
    blur.setAttribute('width', '300%'); blur.setAttribute('height', '300%');
    const gb = document.createElementNS(SVG_NS, 'feGaussianBlur');
    gb.setAttribute('in', 'SourceGraphic');
    gb.setAttribute('stdDeviation', (3.5 + 3.5 * e).toFixed(2));
    blur.appendChild(gb);
    defs.appendChild(blur);

    svg.appendChild(defs);

    const haloR = rOuter + 3 + 15 * e;   // ~24.5 .. ~39.5 px — spreads wide with count
    const halo = document.createElementNS(SVG_NS, 'circle');
    halo.setAttribute('cx', cx.toFixed(2));
    halo.setAttribute('cy', cy.toFixed(2));
    halo.setAttribute('r', haloR.toFixed(2));
    halo.setAttribute('fill', `url(#${uid}g)`);
    halo.setAttribute('filter', `url(#${uid}b)`);
    halo.setAttribute('opacity', (0.5 + 0.5 * e).toFixed(3));
    svg.appendChild(halo);
  }

  // --- TICKS (on top of the halo) ---
  for (let i = 0; i < N; i++) {
    const deg = ARC_START + i * step;
    const lit = i < ordered.length && ordered[i] === stewardId;
    const [x1, y1] = polar(deg, rInner);
    const [x2, y2] = polar(deg, rOuter);
    const tick = document.createElementNS(SVG_NS, 'line');
    tick.setAttribute('x1', x1.toFixed(2));
    tick.setAttribute('y1', y1.toFixed(2));
    tick.setAttribute('x2', x2.toFixed(2));
    tick.setAttribute('y2', y2.toFixed(2));
    tick.setAttribute('stroke-linecap', 'round');
    tick.setAttribute('class', lit ? 'recency-tick lit' : 'recency-tick unlit');
    svg.appendChild(tick);
  }
  return svg;
}

// R18 (Josh 2026-04-21): compute unread counts on either side of the
// current deck position and paint them into the ◀ / ▶ arrow button badges.
// Called from setCurrent on every focus change.
function updateDeckArrowUnreadBadges(bubbles, currentIdx) {
  const prevBtn = document.querySelector('.card-nav-prev');
  const nextBtn = document.querySelector('.card-nav-next');
  if (!prevBtn && !nextBtn) return;
  if (!Array.isArray(bubbles) || bubbles.length === 0) {
    if (prevBtn) {
      const b = prevBtn.querySelector('.card-nav-unread-badge');
      if (b) { b.hidden = true; b.textContent = ''; }
    }
    if (nextBtn) {
      const b = nextBtn.querySelector('.card-nav-unread-badge');
      if (b) { b.hidden = true; b.textContent = ''; }
    }
    return;
  }
  let unreadBefore = 0, unreadAfter = 0;
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    const bubbleEl = b.querySelector ? (b.querySelector('.msg-bubble[data-item-id]') || b) : b;
    const id = bubbleEl && bubbleEl.dataset ? bubbleEl.dataset.itemId : null;
    if (!id) continue;
    if (readState[id]) continue;
    if (i < currentIdx) unreadBefore++;
    else if (i > currentIdx) unreadAfter++;
  }
  const paint = (btn, count) => {
    if (!btn) return;
    const badge = btn.querySelector('.card-nav-unread-badge');
    if (!badge) return;
    if (count > 0) {
      badge.hidden = false;
      badge.textContent = String(count);
    } else {
      badge.hidden = true;
      badge.textContent = '';
    }
  };
  paint(prevBtn, unreadBefore);
  paint(nextBtn, unreadAfter);
}
window.updateDeckArrowUnreadBadges = updateDeckArrowUnreadBadges;

// R15 thresholds (Josh 2026-04-21, "adjustable as we go"):
// Centralized so we can tweak in one place. Used for corner indicators,
// Settings dashboard sorting, and ⚙️ badge color.
// Electron IPC: session lifecycle events (created/deleted) forwarded from
// the main-process Socket.IO client. Trigger an immediate stewards re-fetch
// so the sidebar reflects new/removed sessions without waiting for the 30s
// poll. The browser/mobile path subscribes to the raw Socket.IO events
// directly inside the `if (!window.presenter)` block (see top of file).
if (window.presenter && window.presenter.onSessionEvent) {
  window.presenter.onSessionEvent((evt) => {
    // evt: { type: 'created'|'deleted', payload: { sessionId, parent?, createdAt? } }
    fetchStewards();
  });
}

const queueCount = document.getElementById('queue-count');
const btnMinimize = document.getElementById('btn-minimize');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const stewardListEl = document.getElementById('steward-list');
const convThread = document.getElementById('conv-thread');
const convEmpty = document.getElementById('conv-empty');
const convHeader = document.getElementById('conv-header');
const convStewardIcon = document.getElementById('conv-steward-icon');
const convStewardName = document.getElementById('conv-steward-name');
const convStewardStatus = document.getElementById('conv-steward-status');
const sidebarToggle = document.getElementById('sidebar-toggle');
const undoToast = document.getElementById('undo-toast');

// --- Load read state from server (was per-device localStorage pre-2026-06-06) ---
// Server is the single source of truth so reads sync across phone + laptop.
// Fire-and-forget hydrate; in-memory readState stays {} until response lands,
// then we merge + re-render. Migration policy: server wins, no localStorage merge.
async function hydrateReadStateFromServer() {
  try {
    const res = await fetch('/api/presenter/read-state');
    if (!res.ok) return;
    const serverMap = await res.json();
    if (!serverMap || typeof serverMap !== 'object') return;
    for (const k of Object.keys(serverMap)) {
      if (serverMap[k]) readState[k] = true;
    }
    if (typeof renderSidebar === 'function') renderSidebar();
    if (document.body.classList.contains('embedded') && typeof renderEmbeddedTopbar === 'function') {
      renderEmbeddedTopbar();
    }
  } catch (err) {
    console.warn('[read-state] hydrate failed:', err);
  } finally {
    // Settled either way. On failure we deliberately still flip it: an
    // unreachable read-map means we fall back to plain remembered-position
    // behavior (the pre-2026-09-01 behavior), which is the safe direction.
    // Leaving it false forever would permanently disable the newest-unread
    // jump; leaving it unset-but-checked would strand Josh mid-deck.
    readStateHydrated = true;
  }
}
hydrateReadStateFromServer();

// Real-time push: server emits `presenter:read-state-updated` after every
// POST to /api/presenter/read-state. Merge payload + re-render sidebar/topbar.
if (window.presenter && typeof window.presenter.onReadStateUpdated === 'function') {
  window.presenter.onReadStateUpdated((payload) => {
    if (!payload || typeof payload !== 'object') return;
    let changed = false;
    for (const k of Object.keys(payload)) {
      if (payload[k] && !readState[k]) { readState[k] = true; changed = true; }
    }
    if (!changed) return;
    if (typeof renderSidebar === 'function') renderSidebar();
    if (document.body.classList.contains('embedded') && typeof renderEmbeddedTopbar === 'function') {
      renderEmbeddedTopbar();
    }
  });
}

// --- Hydrate per-card draft text from server (was per-device localStorage pre-2026-06-06) ---
// Server is single source of truth — fetch full map at boot, populate draftCache.
// Already-rendered textareas (if any) get backfilled. Future renders read off the cache.
async function hydrateDraftsFromServer() {
  try {
    const res = await fetch('/api/presenter/drafts');
    if (!res.ok) return;
    const serverMap = await res.json();
    if (!serverMap || typeof serverMap !== 'object') return;
    for (const k of Object.keys(serverMap)) {
      const v = serverMap[k];
      if (typeof v === 'string' && v.length > 0) draftCache.set(k, v);
    }
    // Backfill any already-rendered textareas that match a draftKey.
    // Cards rendered before hydrate landed show empty; populate now.
    backfillRenderedDraftTextareas();
  } catch (err) {
    console.warn('[drafts] hydrate failed:', err);
  }
}
// Parse a draftKey back into its itemId so we can find the matching bubble in
// the DOM. Keys look like `presenter-draft:<sessionId>:<itemId>`. We only need
// the itemId because every bubble is uniquely keyed on data-item-id.
function itemIdFromDraftKey(key) {
  if (typeof key !== 'string' || !key.startsWith('presenter-draft:')) return null;
  const rest = key.slice('presenter-draft:'.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? null : rest.slice(colon + 1);
}
function backfillRenderedDraftTextareas() {
  draftCache.forEach((cached, key) => {
    const itemId = itemIdFromDraftKey(key);
    if (!itemId || !cached) return;
    document.querySelectorAll(`.msg-bubble[data-item-id="${CSS.escape(itemId)}"] .msg-input`).forEach((ta) => {
      // Only fill empty + non-focused textareas — never clobber local typing.
      if (!ta.value && document.activeElement !== ta) ta.value = cached;
    });
  });
}
hydrateDraftsFromServer();

// Real-time push: server emits `presenter:drafts-updated` after every
// POST to /api/presenter/drafts. Update cache + any matching textarea.
// Race-gate: if the user typed on THIS surface within DRAFT_RACE_GATE_MS,
// skip updating the textarea (server still has the value; next refresh pulls it).
if (window.presenter && typeof window.presenter.onDraftsUpdated === 'function') {
  window.presenter.onDraftsUpdated((payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { key, value } = payload;
    if (typeof key !== 'string' || !key) return;
    const incoming = typeof value === 'string' ? value : '';
    // Cache reflects server truth.
    if (incoming) draftCache.set(key, incoming);
    else draftCache.delete(key);
    // Find any visible textarea bound to this key (matched on itemId — every
    // bubble is uniquely keyed there). Race-gate: if local user typed on THIS
    // surface within the gate window, the server value will be
    // eventually-consistent; don't clobber the in-progress local edit.
    const itemId = itemIdFromDraftKey(key);
    if (!itemId) return;
    const lastLocal = draftLastLocalEdit.get(key) || 0;
    if (Date.now() - lastLocal < DRAFT_RACE_GATE_MS) return;
    document.querySelectorAll(`.msg-bubble[data-item-id="${CSS.escape(itemId)}"] .msg-input`).forEach((ta) => {
      // Don't clobber a currently-focused-with-content textarea either.
      if (document.activeElement === ta && ta.value && ta.value !== incoming) return;
      ta.value = incoming;
    });
  });
}

function saveReadState(itemIds) {
  // Push newly-read itemIds to the server in a single POST. Accepts a single
  // string or an iterable (Set / Array). Batched because the read-flip caller
  // debounces rapid arrow-mashing — we must persist the whole burst, not just
  // the last id, or middle cards silently fail to sync across devices.
  let ids = [];
  if (typeof itemIds === 'string') {
    if (itemIds) ids.push(itemIds);
  } else if (itemIds && typeof itemIds[Symbol.iterator] === 'function') {
    for (const v of itemIds) {
      if (typeof v === 'string' && v) ids.push(v);
    }
  }
  if (ids.length === 0) return;
  fetch('/api/presenter/read-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemIds: ids }),
  }).catch((err) => { console.warn('[read-state] save failed:', err); });
}

// --- TTS state ---
let ttsAudio = null;
let ttsPlaying = false;
let ttsItemId = null;
let ttsActiveBtn = null;
let ttsLoading = false;   // true while /api/tts fetch is in flight

// --- TTS state broadcast (Josh 2026-08-12 card-dictation player) ---
// The card-nav transport cluster (Dictate/Play → Pause·Back10·Fwd10 + scrubber)
// is a UI layer over this same single <audio> element. It subscribes here so it
// reflects load/play/pause/seek/time/ended live. One audio path, many views.
const ttsListeners = new Set();
function onTtsChange(fn) { ttsListeners.add(fn); return () => ttsListeners.delete(fn); }
function emitTtsChange() {
  const st = ttsGetState();
  ttsListeners.forEach(fn => { try { fn(st); } catch (e) { console.warn('[tts] listener err', e); } });
}
// Snapshot of the player for any subscriber. Safe to call anytime.
function ttsGetState() {
  const a = ttsAudio;
  return {
    itemId: ttsItemId,
    loading: ttsLoading,
    playing: ttsPlaying,
    hasAudio: !!a,
    duration: (a && isFinite(a.duration)) ? a.duration : 0,
    currentTime: a ? (a.currentTime || 0) : 0,
  };
}
// Transport primitives over the live element. No-op safely if nothing loaded.
function ttsSeekTo(t) {
  if (!ttsAudio || !isFinite(ttsAudio.duration)) return;
  ttsAudio.currentTime = Math.max(0, Math.min(ttsAudio.duration, t));
  emitTtsChange();
}
function ttsSkip(delta) {
  if (!ttsAudio) return;
  ttsSeekTo((ttsAudio.currentTime || 0) + delta);
}
function ttsPause() {
  if (!ttsAudio || !ttsPlaying) return;
  ttsAudio.pause();
  ttsPlaying = false;
  syncLegacyTtsBtn();
  emitTtsChange();
}
function ttsResume() {
  if (!ttsAudio || ttsPlaying) return;
  ttsAudio.play().then(() => { ttsPlaying = true; syncLegacyTtsBtn(); emitTtsChange(); })
    .catch(() => stopTts());
}
// Keep the legacy avatar-bar 🔊 button (ttsActiveBtn) visually in sync when the
// transport cluster drives play/pause from elsewhere.
function syncLegacyTtsBtn() {
  if (!ttsActiveBtn) return;
  if (ttsPlaying) { ttsActiveBtn.classList.add('playing'); ttsActiveBtn.innerHTML = '&#x23F8;'; }
  else { ttsActiveBtn.classList.remove('playing'); ttsActiveBtn.innerHTML = '&#x25B6;'; }
}

function stopTts() {
  if (ttsAudio) {
    ttsAudio.pause();
    ttsAudio.src = '';
    ttsAudio = null;
  }
  ttsPlaying = false;
  ttsLoading = false;
  ttsItemId = null;
  if (ttsActiveBtn) {
    ttsActiveBtn.classList.remove('playing', 'loading');
    ttsActiveBtn.innerHTML = '&#x1F50A;';
    ttsActiveBtn = null;
  }
  emitTtsChange();
}

function playTts(item, btnEl) {
  if (!item) return;

  // Toggle pause/resume if same card
  if (ttsItemId === item.id && ttsAudio) {
    if (ttsPlaying) {
      ttsAudio.pause();
      ttsPlaying = false;
      if (btnEl) { btnEl.classList.remove('playing'); btnEl.innerHTML = '&#x25B6;'; }
      emitTtsChange();
      return;
    } else {
      ttsAudio.play().catch(() => stopTts());
      ttsPlaying = true;
      if (btnEl) { btnEl.classList.add('playing'); btnEl.innerHTML = '&#x23F8;'; }
      emitTtsChange();
      return;
    }
  }

  stopTts();
  ttsItemId = item.id;
  ttsActiveBtn = btnEl || null;
  ttsLoading = true;
  if (btnEl) { btnEl.classList.add('loading'); btnEl.innerHTML = '&#x23F3;'; }
  emitTtsChange();

  const SERVER_URL = window.location.origin || 'http://localhost:3005';
  const text = item.message || item.title || '';

  fetch(`${SERVER_URL}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.substring(0, 5000), voice: 'en-US-AndrewNeural' }),
  })
    .then(res => {
      if (!res.ok) throw new Error('TTS API error: ' + res.status);
      return res.arrayBuffer();
    })
    .then(buffer => {
      if (ttsItemId !== item.id) return;

      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      const dataUri = 'data:audio/mpeg;base64,' + b64;

      ttsAudio = new Audio();
      ttsAudio.volume = 1.0;

      ttsAudio.addEventListener('ended', () => stopTts());
      ttsAudio.addEventListener('error', (e) => {
        console.error('[Presenter] Audio error:', e.target.error);
        stopTts();
      });
      // Drive the transport cluster + scrubber: duration on load, position on tick.
      ttsAudio.addEventListener('loadedmetadata', () => emitTtsChange());
      ttsAudio.addEventListener('timeupdate', () => emitTtsChange());

      ttsAudio.src = dataUri;
      ttsAudio.play().then(() => {
        ttsPlaying = true;
        ttsLoading = false;
        if (btnEl) { btnEl.classList.remove('loading'); btnEl.classList.add('playing'); btnEl.innerHTML = '&#x23F8;'; }
        emitTtsChange();
      }).catch(err => {
        console.error('[Presenter] Audio play() rejected:', err);
        stopTts();
      });
    })
    .catch(err => {
      console.error('[Presenter] TTS fetch failed:', err);
      stopTts();
    });
}

// --- Undo-send toast stack ---
const UNDO_DELAY = 5000;
// --- Shared upper-left undo pill (Josh 2026-06-02) ---
// Single visual surface for every undoable action: voice-send, optimistic
// dismiss, reply commit. Mocked + signed off in card de4f9f0655b0.
//
// Logic — countdown, commit, rollback, retry — stays in the calling site
// (startUndoSend / startUndoSendWithRollback / showInlineUndo). This helper
// owns only the DOM: render a big yellow pill in the upper-left of the
// viewport, expose hooks to drive its visible state.
//
// Returns a control object the caller drives:
//   pill.setCountdown(seconds)   // update the countdown number
//   pill.setCommitting(label)    // switch to "Sending..." state, no click
//   pill.setSuccess(label)       // switch to green success state, no click
//   pill.setFailed(label)        // switch to red failed state
//   pill.remove()                // detach immediately
//
// onUndo fires when the user clicks the pill BEFORE the caller flips it
// into a non-undoable state via setCommitting/setSuccess/setFailed.
const upperLeftPillSlot = document.getElementById('undo-pill-slot');
const upperLeftPillStack = [];

// === V6 undo stack: anchor to the CARD, cap the depth, glide survivors up ===
// Josh 2026-09-05: the undos "pop over" the card's background steading icon and
// "march down the right side of the card". They must NOT sit over the steward /
// worker rows — that obstruction is the whole reason this moved.
//
// Anchoring is done in JS, not CSS, because .mobile-deck-card is overflow:hidden
// (the deck's clip box), so a pill parented to the card would be shaved at its
// edge. The slot stays position:fixed at the root and we write the card's live
// edges into CSS custom properties instead.
const MAX_VISIBLE_UNDO_PILLS = 4;

function positionUndoSlotToCard() {
  if (!upperLeftPillSlot) return;
  // Only the mobile/embedded deck has a card frame to hug. Desktop keeps a
  // sane viewport-anchored position.
  // The deck keeps EVERY card mounted and slides them horizontally, so a plain
  // querySelector returns whichever card is first in DOM order — usually an
  // off-screen neighbour sitting at a negative x. The ACTIVE card is the one
  // applyDeckPositions marked aria-hidden="false" (z-index 2). Fall back to a
  // geometric pick (the card whose box actually straddles the viewport centre)
  // so this still works if the attribute contract ever changes.
  const cards = Array.from(document.querySelectorAll('#conv-thread.mobile-deck-active .mobile-deck-card'));
  let card = cards.find(c => c.getAttribute('aria-hidden') === 'false');
  if (!card) {
    const mid = window.innerWidth / 2;
    card = cards.find(c => { const r = c.getBoundingClientRect(); return r.left <= mid && r.right >= mid; });
  }
  if (!card) {
    upperLeftPillSlot.style.removeProperty('--undo-anchor-top');
    upperLeftPillSlot.style.removeProperty('--undo-anchor-right');
    return;
  }
  const r = card.getBoundingClientRect();
  if (!r.width || !r.height) return;
  // V7 (Josh 2026-09-06): "do it below the title" — the stack starts BELOW the
  // card's header so the title is never covered. This was the `undo-v-inset`
  // mockup variant; Josh picked it, so it is now the only behavior and the
  // variant flag is gone. Measure the header live rather than assuming a
  // height — the title wraps to two lines on long card names.
  const hdr = card.querySelector('.card-position-label');
  const inset = (hdr ? hdr.offsetHeight : 0) + 6;
  const top = Math.max(0, Math.round(r.top + inset));
  // Welded to the card's right edge. The tag is a rounded-LEFT tab with a
  // squared-off right side, so it reads as emerging FROM the edge rather than
  // floating near it — no 6px gap like V6 had.
  //
  // Clamped at >= 0 for a MEASURED reason: the embedded deck card is full-bleed
  // and sits ~1px WIDER than the visual viewport (card.right 375 vs innerWidth
  // 374 on a 412px phone), so the raw difference goes negative and the seconds
  // tail is clipped by the screen edge — verified live via getBoundingClientRect
  // on the real deck, not assumed. Clamping to 0 pins the tail flush INSIDE the
  // viewport while still reading as welded to the card's edge.
  // Floor at 0 here; the stylesheet's max(1px, ...) is what keeps the tail from
  // riding a subpixel off the screen edge when the card is full-bleed.
  const right = Math.max(0, Math.round(window.innerWidth - r.right));
  // MID-SLIDE GUARD (Josh 2026-09-06: "I'll dismiss a card and I'll expect an
  // undo button and I'll see nothing").
  //
  // MEASURED failure, not a theory: optimisticDismiss advances the deck
  // SYNCHRONOUSLY (advanceDeckAwayFrom -> jumpTo) and only THEN creates the
  // pill, which calls this function. At that instant the newly-active card is
  // still sliding in — its rect.right measured -17 on a 1163px viewport — so
  // `innerWidth - r.right` resolved to 1180px and the slot was parked a full
  // viewport-width off the LEFT edge (pill at left:-88, right:-16). Nothing
  // recomputed it afterwards (the only listeners are resize /
  // visualViewport.resize, and a deck slide fires neither), so the pill sat
  // off-screen for its whole 5s life. That is exactly Josh's "nothing".
  //
  // A card that is off-screen or only partly on-screen is mid-flight, so its
  // edges are not a legitimate anchor. Keep the last GOOD anchor instead of
  // committing a garbage one — a slightly stale anchor still paints the pill
  // where Josh can see it, whereas a mid-flight one hides it completely.
  // scheduleUndoAnchorSettle() below then re-measures once the slide lands.
  const offScreen = r.right <= 0 || r.left >= window.innerWidth;
  const partlyOff = r.right < window.innerWidth * 0.5;
  if (offScreen || partlyOff) {
    scheduleUndoAnchorSettle();
    return;
  }

  upperLeftPillSlot.style.setProperty('--undo-anchor-top', top + 'px');
  upperLeftPillSlot.style.setProperty('--undo-anchor-right', right + 'px');
}

// Re-measure once the deck's slide has actually landed. applyDeckPositions
// anchors at the START of the 260ms slide (it writes the transform, then
// measures immediately), so on its own it always reads the card mid-flight.
// This re-runs the measurement after the slide settles, which is what makes a
// pill created during a deck advance end up welded to the card Josh is
// actually looking at.
let undoAnchorSettleTimer = null;
function scheduleUndoAnchorSettle() {
  if (undoAnchorSettleTimer) clearTimeout(undoAnchorSettleTimer);
  // 300ms > the deck's SLIDE_MS (260) plus a frame of slack.
  undoAnchorSettleTimer = setTimeout(() => {
    undoAnchorSettleTimer = null;
    positionUndoSlotToCard();
  }, 300);
}

// Keep the anchor honest as the deck slides, the viewport rotates, or the
// keyboard resizes the visual viewport.
window.addEventListener('resize', positionUndoSlotToCard);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', positionUndoSlotToCard);
}

// Cap how many pills are visible so the stack can never march down over the
// bottom toolbar. Extras are summarized by a "+N more" chip at the tail.
function enforceUndoStackCap() {
  if (!upperLeftPillSlot) return;
  const pills = Array.from(upperLeftPillSlot.querySelectorAll('.undo-pill'));
  let hidden = 0;
  // Count only LIVE pills toward the cap. A pill stays in the DOM through its
  // ~220ms exit transition, so counting leavers inflated every later pill's
  // index and could hide a still-live pill that was well inside the cap —
  // measured with 6 pills + 2 leaving: a live pill at index 4 went hidden even
  // though only 4 live pills were on screen. The leaver is already on its way
  // out; it must not push a survivor out of view.
  let liveIndex = 0;
  pills.forEach((el) => {
    if (el.classList.contains('leaving')) {
      // Never hide a pill that is mid-exit; let its transition finish.
      el.hidden = false;
      return;
    }
    const over = liveIndex >= MAX_VISIBLE_UNDO_PILLS;
    el.hidden = over;
    if (over) hidden++;
    liveIndex++;
  });
  let chip = upperLeftPillSlot.querySelector('.undo-pill-overflow');
  if (hidden > 0) {
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'undo-pill-overflow';
      upperLeftPillSlot.appendChild(chip);
    } else {
      upperLeftPillSlot.appendChild(chip); // keep it last
    }
    chip.textContent = '+' + hidden + ' more';
  } else if (chip) {
    chip.remove();
  }
}

// FLIP: after a pill leaves, the ones below it must slide UP into the gap
// rather than snapping. Measure before, mutate, measure after, invert, play.
function reflowUndoStack(mutate) {
  if (!upperLeftPillSlot) { if (mutate) mutate(); return; }
  const items = Array.from(upperLeftPillSlot.children);
  const first = new Map();
  items.forEach(el => first.set(el, el.getBoundingClientRect().top));
  if (mutate) mutate();
  enforceUndoStackCap();
  const moved = Array.from(upperLeftPillSlot.children);
  moved.forEach(el => {
    if (el.classList.contains('leaving')) return;
    const before = first.get(el);
    if (before === undefined) return;      // newly inserted — it has its own enter anim
    const after = el.getBoundingClientRect().top;
    const dy = before - after;
    if (!dy) return;
    el.style.transition = 'none';
    el.style.transform = 'translateY(' + dy + 'px)';
    requestAnimationFrame(() => {
      el.style.transition = 'transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1)';
      el.style.transform = '';
      const clear = () => { el.style.transition = ''; el.style.transform = ''; };
      el.addEventListener('transitionend', clear, { once: true });
      setTimeout(clear, 260);
    });
  });
}

// Resolve what the V7 tag paints: a steward glyph + a bare card number.
// Callers may pass them structured (stewardIcon / cardNumber) OR keep passing
// the legacy pre-joined `sublabel` ("Foreman — 3 of 6"), from which we recover
// the number. Every field is optional: with none of them the tag is just
// "↺ 5s", which is still a valid undo.
function resolveUndoIdentity({ sublabel, stewardIcon, cardNumber }) {
  let icon = stewardIcon || '';
  let number = (cardNumber === 0 || cardNumber) ? String(cardNumber) : '';
  const title = sublabel || '';

  // Legacy callers pass only the joined string. Recover the position from it;
  // the em-dash + " N of M" shape is our own format (built a few lines above
  // the call site), not arbitrary text.
  if (!number && sublabel) {
    const m = /—\s*(\d+)\s+of\s+\d+\s*$/.exec(sublabel);
    if (m) number = m[1];
  }
  return { icon, number, title };
}

function showUpperLeftUndo({ label, sublabel, durationMs, onUndo, stewardIcon, cardNumber }) {
  // Joshua 2026-06-26: multi-undo queue. When N>1 actions are in-flight,
  // EACH gets its own visible pill instead of the most-recent silently
  // detaching prior ones. Sibling pills stay independently tappable;
  // commit/countdown on one only removes that one. Pre-2026-06-26
  // behavior — `upperLeftPillStack.forEach(p => p.remove(true))` — was
  // pulled. CSS slot is flex-column with gap so stacking is free; we
  // insertBefore the first child to put most-recent at top.

  const pill = document.createElement('button');
  pill.className = 'undo-pill';
  pill.type = 'button';

  // V7 (Josh 2026-09-06): the pill is a small tag PEEKING IN from the card's
  // right edge — "literally just emerging from the side of the card like it's
  // peeking at us". Everything that can be said with a glyph is:
  //   ↺ symbol   (was the word "UNDO")
  //   steward icon (was the steward's full name)
  //   card number  (was "3 of 6" — the total carried no decision value)
  //   seconds      (now a darker tail hanging off the end)
  // NOTHING is dropped that Josh reads: identity and position both survive,
  // just as glyph + number. `.core` and `.tail` are the two shaded halves.
  const coreSpan = document.createElement('span');
  coreSpan.className = 'undo-pill-core';
  pill.appendChild(coreSpan);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'undo-pill-icon';
  iconSpan.textContent = '↺';
  coreSpan.appendChild(iconSpan);

  // Label is EMPTY in the resting state (the ↺ says "undo"), but it must stay
  // in the DOM: setCommitting/setSuccess/setFailed write "Sending…"/"Sent"/
  // "Failed" into it. CSS hides it while blank and reveals it when a status
  // word lands, so the tag stays tiny at rest and still reads during commit.
  const labelSpan = document.createElement('span');
  labelSpan.className = 'undo-pill-label';
  labelSpan.textContent = '';
  coreSpan.appendChild(labelSpan);

  // Steward identity as its own icon — the same glyph already on Josh's
  // steward row, so it reads without a legend. `sublabel` is the legacy
  // pre-joined string ("Foreman — 3 of 6"); prefer the structured fields and
  // fall back to parsing it so no caller has to change at once.
  const ident = resolveUndoIdentity({ sublabel, stewardIcon, cardNumber });

  if (ident.icon) {
    const stewardSpan = document.createElement('span');
    stewardSpan.className = 'undo-pill-steward';
    stewardSpan.textContent = ident.icon;
    coreSpan.appendChild(stewardSpan);
  }
  if (ident.number) {
    const numSpan = document.createElement('span');
    numSpan.className = 'undo-pill-num';
    numSpan.textContent = ident.number;
    coreSpan.appendChild(numSpan);
  }
  // Full identity stays reachable on hover/long-press even though the tag
  // itself is glyphs — nothing is actually lost, just not always painted.
  if (ident.title) pill.title = ident.title;

  const countdownSpan = document.createElement('span');
  countdownSpan.className = 'undo-pill-countdown';
  pill.appendChild(countdownSpan);

  let undoable = true;
  let removed = false;

  pill.addEventListener('click', () => {
    if (!undoable || removed) return;
    undoable = false;
    try { if (typeof onUndo === 'function') onUndo(); } catch (err) { console.error('[undo-pill] onUndo threw:', err); }
    api.remove();
  });

  // Most-recent at top — insert before the existing first child rather
  // than appending to the end.
  // Newest at TOP of the vertical stack; older ones march down the card's
  // right side. Anchor to the card first so the pill's enter animation starts
  // from the correct corner, then let the existing pills glide down (FLIP).
  positionUndoSlotToCard();
  reflowUndoStack(() => {
    if (upperLeftPillSlot.firstChild) {
      upperLeftPillSlot.insertBefore(pill, upperLeftPillSlot.firstChild);
    } else {
      upperLeftPillSlot.appendChild(pill);
    }
  });

  const api = {
    setCountdown(seconds) {
      if (removed) return;
      countdownSpan.textContent = Math.max(0, Math.ceil(seconds)) + 's';
    },
    setCommitting(text) {
      if (removed) return;
      undoable = false;
      pill.classList.add('committing');
      countdownSpan.textContent = '';
      labelSpan.textContent = text || 'Sending…';
      iconSpan.textContent = '⏳';
    },
    setSuccess(text) {
      if (removed) return;
      undoable = false;
      pill.classList.remove('committing', 'failed');
      pill.classList.add('success');
      countdownSpan.textContent = '';
      labelSpan.textContent = text || 'Sent';
      iconSpan.textContent = '✓';
    },
    setFailed(text) {
      if (removed) return;
      undoable = false;
      pill.classList.remove('committing', 'success');
      pill.classList.add('failed');
      countdownSpan.textContent = '';
      labelSpan.textContent = text || 'Failed';
      iconSpan.textContent = '⚠';
    },
    remove(silent) {
      if (removed) return;
      removed = true;
      const idx = upperLeftPillStack.indexOf(api);
      if (idx >= 0) upperLeftPillStack.splice(idx, 1);
      // V5 smooth exit: tag the pill with .leaving so CSS plays the
      // fade+shrink transition, then detach after the transition ends.
      // 220ms matches the .leaving rule's opacity/transform transition;
      // a hard fallback timer ensures we never leak a node if the
      // transition is skipped (display:none, prefers-reduced-motion, etc).
      if (pill.parentNode) {
        // Clear the enter animation first. A still-"running" animation wins over
        // a transition on the same properties, which makes the exit SNAP to its
        // end state instead of playing. (The enter anim has no fill mode, so it
        // reports `running` well past its 240ms.) Belt-and-braces: the exit is
        // also verified visually before shipping.
        pill.style.animation = 'none';
        void pill.offsetWidth;              // force style flush so the transition takes
        pill.classList.add('leaving');
        // Detach, THEN glide the survivors up into the freed space (FLIP), so
        // the stack closes smoothly instead of snapping — Josh: "as they
        // disappear they move up... transition smoothly up and out".
        const detach = () => {
          if (!pill.parentNode) return;
          reflowUndoStack(() => pill.parentNode.removeChild(pill));
        };
        let detached = false;
        const onEnd = () => { if (detached) return; detached = true; detach(); };
        pill.addEventListener('transitionend', onEnd, { once: true });
        setTimeout(() => { if (detached) return; detached = true; detach(); }, 260);
      }
    },
    // Only the action-state matters. A pill whose DOM was silently
    // detached (mass-remove when a new pill arrives) is still pending
    // its sendFn — its caller's setTimeout must commit when it fires.
    isUndoable() { return undoable; }
  };

  upperLeftPillStack.push(api);

  if (durationMs && durationMs > 0) api.setCountdown(durationMs / 1000);

  return api;
}

function startUndoSend(label, sessionId, itemId, sendFn) {
  const startTime = Date.now();

  const pill = showUpperLeftUndo({
    label: 'UNDO',
    durationMs: UNDO_DELAY,
    onUndo: () => {
      // User cancelled: kill the pending timer so sendFn never fires.
      clearTimeout(entry.timer); entry.timer = null;
      clearInterval(entry.interval); entry.interval = null;
    }
  });

  const entry = { id: Date.now(), timer: null, interval: null, pill, itemId, sendFn };

  function updateCountdown() {
    const remaining = Math.max(0, (UNDO_DELAY - (Date.now() - startTime)) / 1000);
    pill.setCountdown(remaining);
  }
  updateCountdown();
  entry.interval = setInterval(updateCountdown, 200);

  entry.timer = setTimeout(() => {
    if (entry.interval) { clearInterval(entry.interval); entry.interval = null; }
    entry.timer = null;
    if (!pill.isUndoable()) return; // user cancelled between tick and timeout
    pill.setCommitting('Sending…');
    Promise.resolve(sendFn())
      .then(() => {
        pill.setSuccess('Sent');
        setTimeout(() => pill.remove(), 900);
      })
      .catch(err => {
        console.error('[Presenter] Send failed:', err);
        pill.setFailed('Failed');
        setTimeout(() => pill.remove(), 1800);
      });
  }, UNDO_DELAY);
}

// --- Optimistic dismiss (Josh 2026-04-21) ---
// Tap Dismiss → card is instantly hidden + deck advances + bar undo toast
// appears. Tap UNDO during the countdown = un-hide + cancel. Countdown
// expiry fires the real POST /api/presenter/dismiss.
//
// Persistent pending-dismiss registry (Josh 2026-07-31 — multi-dismiss nav
// regression). The `.optimistic-dismissed` class is DOM-only state, and
// renderThread() wipes innerHTML + rebuilds every bubble from `queue` — which
// still contains cards whose 5s undo countdown hasn't committed to the server.
// A poll re-render mid-countdown therefore resurrects already-dismissing cards
// as "live", so rapid 6→5→4 dismissals would land nav back on 5 instead of
// skipping to the next genuinely-live card (3). This Set is the source of
// truth for "mid-dismiss" that SURVIVES re-render. Nav liveness consults it,
// buildChatMessages re-applies the hidden visual state from it, and it's
// cleared on undo/rollback and on commit.
const pendingDismissIds = new Set();
window.pendingDismissIds = pendingDismissIds; // expose for the deck IIFE

// Cards whose REPLY has been committed (or is mid-undo-countdown) and which
// the server will therefore remove on the next poll. Same role as
// pendingDismissIds but for the reply route, which used to have no advance
// logic at all — see advanceDeckAwayFrom below (Josh 2026-08-30).
const pendingReplyIds = new Set();
window.pendingReplyIds = pendingReplyIds;

// --- Shared deck-advance (Josh 2026-08-30) ---------------------------------
// ONE implementation used by BOTH the dismiss route (optimisticDismiss) and
// the reply route (showInlineUndo). Previously only dismiss advanced; a reply
// left the deck pointing at a dead id, findCurrentIndex fell through to
// `length - 1`, and Josh got thrown to the NEWEST card — out of a 91-card
// backlog, every single time he answered something.
//
// Direction — Josh chose this explicitly on 2026-08-30 ("head toward the
// newest"): move FORWARD, toward the NEWER card. renderThread sorts
// chronologically ascending (see its comparator: `ta - tb`), so a higher index
// is a newer card, and his own example — answer card 3, get card 4 — is that
// same direction. Fall BACK to the older side only when he just answered the
// newest card and there's nothing newer left. Stay put if neither direction
// has a live sibling.
//
// Returns the id we moved to, or null if we stayed put.
function advanceDeckAwayFrom(deadItemId, tag) {
  const label = tag || 'deck-advance';
  try {
    if (!document.body.classList.contains('embedded')) return null;
    const state = typeof window.mobileDeckGetState === 'function' ? window.mobileDeckGetState() : null;
    if (!state) return null;
    const ids = Array.isArray(state.ids) ? state.ids : [];
    const idx = typeof state.currentIndex === 'number' ? state.currentIndex : -1;
    if (idx < 0 || ids.length === 0) return null;

    function isAlive(itemId) {
      if (!itemId || itemId === deadItemId) return false;
      // A card mid-dismiss or mid-reply is NOT alive even if a re-render
      // dropped its visual class — the persistent sets are authoritative.
      if (pendingDismissIds.has(itemId)) return false;
      if (pendingReplyIds.has(itemId)) return false;
      const b = document.querySelector('.msg-bubble[data-item-id="' + CSS.escape(itemId) + '"]');
      return !!b && !b.classList.contains('optimistic-dismissed');
    }

    let targetId = null;
    for (let i = idx + 1; i < ids.length; i++) {
      if (isAlive(ids[i])) { targetId = ids[i]; break; }
    }
    if (!targetId) {
      for (let i = idx - 1; i >= 0; i--) {
        if (isAlive(ids[i])) { targetId = ids[i]; break; }
      }
    }
    if (targetId) {
      console.log('[' + label + '] jumpTo live sibling ' + targetId);
      if (typeof window.mobileDeckJumpTo === 'function') window.mobileDeckJumpTo(targetId);
      return targetId;
    }
    console.log('[' + label + '] no live sibling either direction — staying put');
    return null;
  } catch (err) {
    console.error('[' + label + '] advance:', err);
    return null;
  }
}
window.advanceDeckAwayFrom = advanceDeckAwayFrom;

// --- Native (Android) input result dispatch ---------------------------------
// The APK calls window.onNativeInputResult(id, action, value) when its native
// text box submits or cancels. There are now TWO surfaces that can be driven by
// that native box — the per-card input bar and the Type composer — so this is a
// registry rather than a single assignment. Each consumer inspects the id and
// returns true if it owned it; the first owner wins.
//
// Before this (Josh 2026-08-30) the deck installed itself directly onto
// window.onNativeInputResult and dropped every id it didn't recognise on the
// floor, which is fine while there's one consumer and silently wrong the moment
// there are two.
const nativeInputConsumers = [];
function registerNativeInputConsumer(name, fn) {
  if (nativeInputConsumers.some(c => c.name === name)) return;
  nativeInputConsumers.push({ name, fn });
  if (!window.onNativeInputResult || !window.onNativeInputResult.__dispatcher) {
    const dispatcher = function (id, action, value) {
      for (const c of nativeInputConsumers) {
        try {
          if (c.fn(id, action, value) === true) return;
        } catch (err) {
          console.error('[native-input] consumer "' + c.name + '" threw:', err);
        }
      }
      console.log('[native-input] no consumer claimed id', id, action);
    };
    dispatcher.__dispatcher = true;
    window.onNativeInputResult = dispatcher;
  }
}
window.registerNativeInputConsumer = registerNativeInputConsumer;

// Same shape for live keystroke mirroring — the APK pushes every character so
// the web side stays the single source of truth for drafts and for send.
const nativeInputChangeConsumers = [];
function registerNativeInputChangeConsumer(name, fn) {
  if (nativeInputChangeConsumers.some(c => c.name === name)) return;
  nativeInputChangeConsumers.push({ name, fn });
  if (!window.onNativeInputChanged || !window.onNativeInputChanged.__dispatcher) {
    const dispatcher = function (id, value) {
      for (const c of nativeInputChangeConsumers) {
        try {
          if (c.fn(id, value) === true) return;
        } catch (err) {
          console.error('[native-input] change consumer "' + c.name + '" threw:', err);
        }
      }
    };
    dispatcher.__dispatcher = true;
    window.onNativeInputChanged = dispatcher;
  }
}
window.registerNativeInputChangeConsumer = registerNativeInputChangeConsumer;

function optimisticDismiss(item, bubble) {
  if (!item || !bubble) return;
  if (bubble.classList.contains('optimistic-dismissed')) return;

  // Hide the bubble locally + advance deck before server round-trip.
  const bubbleStateKey = `_optimistic_${item.id}`;
  window[bubbleStateKey] = {
    bubble,
    prevDisplay: bubble.style.display,
    prevAriaHidden: bubble.getAttribute('aria-hidden'),
  };
  bubble.classList.add('optimistic-dismissed');
  bubble.style.display = 'none';
  bubble.setAttribute('aria-hidden', 'true');
  // Register in the persistent set so a poll re-render mid-countdown can't
  // resurrect this card as "live" (multi-dismiss nav regression, 2026-07-31).
  pendingDismissIds.add(item.id);

  // Advance deck: prefer next card, fall back to previous if we just
  // dismissed the most recent. Josh R14 + R19 patch 2026-04-21: must
  // happen SYNCHRONOUSLY — not gated on the undo commit timer. Blank
  // screen during the 3s countdown is not acceptable.
  //
  // PRIOR BUG: I was reading `state.currentIdx` + `state.bubbles.length`
  // but mobileDeckGetState returns `{currentIndex, count, ...}`. Both
  // branches fell through to the no-op "only card" case, leaving the
  // user staring at a hidden bubble for the full undo countdown.
  console.log('[optimistic-dismiss] tap — bubble=' + item.id + ' embedded=' + document.body.classList.contains('embedded'));
  // Pill sublabel: steward identity + queue-position-at-dismiss-time
  // (e.g. "Foreman — 3 of 6"). Joshua 2026-06-26 verbatim:
  // "the number of cards in the cue when it was dismissed."
  // Computed BEFORE jumpTo so the snapshot reflects the moment of dismiss
  // (other in-flight dismissals don't change `count` because hidden
  // bubbles still match getActiveBubbles' selector — input-wrap stays).
  let pillSublabel = '';
  // V7 (Josh 2026-09-06): the tag paints the steward's ICON and the bare card
  // NUMBER instead of "Foreman — 3 of 6". Both are captured structurally here;
  // pillSublabel stays as the hover title so the full identity is never lost.
  let pillStewardIcon = '';
  let pillCardNumber = '';
  if (document.body.classList.contains('embedded')) {
    try {
      const state = typeof window.mobileDeckGetState === 'function' ? window.mobileDeckGetState() : null;
      const total = state && typeof state.count === 'number' ? state.count : 0;
      const idx = state && typeof state.currentIndex === 'number' ? state.currentIndex : -1;
      console.log('[optimistic-dismiss] deck state idx=' + idx + ' total=' + total);

      const steward = (typeof findStewardForSession === 'function')
        ? findStewardForSession(item.session_id) : null;
      const stewardName = steward ? dnHumanize(steward.name || steward.shorthand || '')
        : stewardDisplayName(item.session_id);
      // Same glyph the steward row and message avatars already use
      // (see the avatar bar's `steward.icon || steward.shorthand`), so the
      // tag needs no legend — Josh already reads these icons as identity.
      if (steward) pillStewardIcon = steward.icon || steward.shorthand || '';
      if (idx >= 0 && total > 0) pillCardNumber = String(idx + 1);
      if (stewardName && idx >= 0 && total > 0) {
        pillSublabel = stewardName + ' — ' + (idx + 1) + ' of ' + total;
      }


      // Joshua 2026-06-26: skip siblings that are also mid-dismiss (their
      // bubble carries .optimistic-dismissed and renders blank). Forward
      // first, then backward; stay put if neither yields a live sibling.
      // Shared with the reply route since 2026-08-30 — see
      // advanceDeckAwayFrom above. Do NOT re-inline this walk here; one copy.
      advanceDeckAwayFrom(item.id, 'optimistic-dismiss');
    } catch (err) { console.error('[optimistic-dismiss] advance:', err); }
  }

  // Run existing __beforeDismiss hooks IN ADVANCE so components save state.
  const componentRoots = bubble.querySelectorAll('.msg-component > *');
  const beforeHooks = [];
  componentRoots.forEach((el) => {
    if (typeof el.__beforeDismiss === 'function') {
      try { beforeHooks.push(Promise.resolve(el.__beforeDismiss())); }
      catch (err) { console.error('[optimistic-dismiss] __beforeDismiss threw:', err); }
    }
  });

  // Hand off to the bar-toast undo mechanism. startUndoSend fires sendFn
  // after UNDO_DELAY unless UNDO is tapped. Pair with an undo-cancel hook
  // that restores the bubble if Josh taps UNDO.
  startUndoSendWithRollback('Dismiss', item.session_id, item.id,
    () => Promise.all(beforeHooks)
      .then(() => window.presenter.dismiss(item.id))
      // Committed server-side: the card leaves the queue on the next poll and
      // its bubble stops rendering entirely, so drop it from the pending set
      // to keep the set bounded (2026-07-31).
      .then((r) => { pendingDismissIds.delete(item.id); return r; }),
    () => {
      // Rollback: un-hide the bubble in place. Advance already happened; if
      // user wants to return to the card, they arrow-back. Drop from the
      // pending set so nav sees it as live again (2026-07-31).
      pendingDismissIds.delete(item.id);
      const state = window[bubbleStateKey];
      if (state && state.bubble) {
        state.bubble.classList.remove('optimistic-dismissed');
        if (state.prevDisplay) state.bubble.style.display = state.prevDisplay;
        else state.bubble.style.removeProperty('display');
        if (state.prevAriaHidden != null) state.bubble.setAttribute('aria-hidden', state.prevAriaHidden);
        else state.bubble.removeAttribute('aria-hidden');
      }
      delete window[bubbleStateKey];
    },
    pillSublabel,
    { stewardIcon: pillStewardIcon, cardNumber: pillCardNumber });
}

// Variant of startUndoSend that also calls onUndo when the user cancels,
// letting us roll back the optimistic UI hide. Visual surface = shared
// upper-left pill (Josh 2026-06-02). Rollback path is also fired on commit
// failure so the dismissed bubble comes back. `sublabel` (optional) shows
// steward+queue-position context when multiple dismissals stack — since V7 it
// is the hover title, while `ident` ({stewardIcon, cardNumber}) is what the
// tag actually paints. `ident` is optional: without it the tag falls back to
// recovering the number out of `sublabel`.
function startUndoSendWithRollback(label, sessionId, itemId, sendFn, onUndo, sublabel, ident) {
  const startTime = Date.now();

  const pill = showUpperLeftUndo({
    label: 'UNDO',
    sublabel: sublabel,
    stewardIcon: ident && ident.stewardIcon,
    cardNumber: ident && ident.cardNumber,
    durationMs: UNDO_DELAY,
    onUndo: () => {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      if (entry.interval) { clearInterval(entry.interval); entry.interval = null; }
      try { if (typeof onUndo === 'function') onUndo(); } catch (err) { console.error('[undo] rollback:', err); }
    }
  });

  const entry = { id: Date.now(), timer: null, interval: null, pill, itemId, sendFn };

  function updateCountdown() {
    const remaining = Math.max(0, (UNDO_DELAY - (Date.now() - startTime)) / 1000);
    pill.setCountdown(remaining);
  }
  updateCountdown();
  entry.interval = setInterval(updateCountdown, 200);

  entry.timer = setTimeout(() => {
    if (entry.interval) { clearInterval(entry.interval); entry.interval = null; }
    entry.timer = null;
    if (!pill.isUndoable()) return;
    pill.setCommitting('Dismissing…');
    Promise.resolve(sendFn())
      .then(() => {
        pill.setSuccess('Dismissed');
        setTimeout(() => pill.remove(), 600);
      })
      .catch((err) => {
        console.error('[Presenter] Optimistic dismiss commit failed:', err);
        try { if (typeof onUndo === 'function') onUndo(); } catch {}
        pill.setFailed('Failed — card restored');
        setTimeout(() => pill.remove(), 1800);
      });
  }, UNDO_DELAY);
}

// --- Utility functions ---

function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    // Convert unicode bullets (•) to markdown list items
    let processed = text.replace(/^[•●◦‣]/gm, '-');
    // Escape HTML tags so <a>, <button> etc render as text, not real HTML
    processed = processed.replace(/<([a-zA-Z\/][^>]*?)>/g, '&lt;$1&gt;');
    const html = marked.parse(processed);
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
  }
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/\n/g, '<br>');
}

// Post-process links in a rendered message container
function processLinks(container) {
  const isEmbedded = document.body.classList.contains('embedded');
  container.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

    // Prevent default navigation
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openExternalLink(href);
    });

    // Add Copy + Open buttons after the link
    const btnWrap = document.createElement('span');
    btnWrap.className = 'link-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'link-action-btn';
    copyBtn.textContent = 'copy';
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(href).then(() => {
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = 'copy'; }, 1500);
      });
    });
    const openBtn = document.createElement('button');
    openBtn.className = 'link-action-btn';
    openBtn.textContent = 'open';
    openBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openExternalLink(href);
    });
    btnWrap.appendChild(copyBtn);
    btnWrap.appendChild(openBtn);
    a.parentNode.insertBefore(btnWrap, a.nextSibling);
  });
}

function openExternalLink(href) {
  const isEmbedded = document.body.classList.contains('embedded');
  if (isEmbedded && window.Android && window.Android.openUri) {
    window.Android.openUri(href);
  } else {
    window.open(href, '_blank');
  }
}

function relativeTime(timestamp) {
  if (!timestamp) return 'new';
  const diff = Math.max(0, Date.now() - new Date(timestamp).getTime());
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  return Math.floor(hrs / 24) + 'd';
}

// Coarse single-unit "time since" for the worker row's status badge — e.g.
// "2m", "3h", "1w". Picks the largest applicable unit and drops the rest.
//
// NEVER RETURNS A DASH (Josh 2026-09-19: "I don't know why we'd have a dash,
// like it just always represent something"). It used to return '—' on a
// missing/unparseable/future timestamp. The real cure for the dash is upstream
// — /api/session-status now always surfaces a real time (see its fallback
// chain) and the transition tracker no longer bulk-stamps every session with
// one identical instant — so a falsy value here is now genuinely exceptional
// rather than the common case it once was.
//
// The remaining honest answer for "no readable timestamp" is '0s': the badge
// stays a number, and because the rest of the chain guarantees a real time,
// this is a floor rather than a fabrication. A future timestamp (clock skew
// between the stamping process and this render) clamps to '0s' for the same
// reason — the status cannot have changed in the future.
function statusTimeShort(timestamp) {
  if (!timestamp) return '0s';
  const t = new Date(timestamp).getTime();
  if (isNaN(t)) return '0s';
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 0) return '0s';
  const weeks = Math.floor(secs / 604800);
  if (weeks > 0) return weeks + 'w';
  const days = Math.floor(secs / 86400);
  if (days > 0) return days + 'd';
  const hrs = Math.floor(secs / 3600);
  if (hrs > 0) return hrs + 'h';
  const mins = Math.floor(secs / 60);
  if (mins > 0) return mins + 'm';
  return secs + 's';
}

// Compact absolute DATE for the unified-log time column, shown UNDER the big
// "how long ago" number: e.g. "Jul 21". The clock ("3:42 PM") is rendered on a
// SECOND line via formatActualTime (Josh's tweak: date and time on two lines).
// ============================================================================
// CANONICAL DISPLAY-NAME FORMATTER  (Josh 2026-09-03)
// ----------------------------------------------------------------------------
// Rendering a session id as a human label is the TOOL's job, not the namer's.
// Before this, ~6 competing ad-hoc formatters each did their own
// replace(/^holler-/,'') + maybe strip past '--' + maybe de-hyphenate, and
// none capitalized — so the same worker rendered as a clean word on one
// surface and raw hyphenated junk on another. Every display surface now calls
// stewardDisplayName() / workerDisplayName() and nothing else.
//
// Canonical id shape: holler-<steward>[--<worker>][--<worker>]
// Must stay correct with NO steward record at all — ~40% of live sessions
// aren't in the tree, and some tree records carry no `name` field.
// ============================================================================

// Tokens that must not be Title Cased into nonsense.
const DN_UPPER = new Set(['ui','ux','api','id','ok','db','cpu','gpu','io','os','sms','mms','url','urls','css','html','js','ts','json','yaml','http','https','ssh','cli','tui','apk','ota','pr','prs','qa','ai','ml','llm','mcp','cdp','adb','sdk','ide','csv','pdf','png','svg','e2e','eod','cws','qb','seo','tv','vpn','dns','ip','usb','nfc','gps','otp','2fa','mvp','poc','wip','tz','utc','sla','kpi','crm','erp','sql','xml','rss','smtp','imap','ftp','tcp','udp','ssl','tls','jwt','oauth','uuid','ascii','utf8','regex','npm','vm','ci','cd','eta','faq','pto','hr','it','md']);
// Tokens with a specific casing that isn't just Title or UPPER.
// Proper names whose casing/punctuation we can't derive from a slug.
const DN_NAMES = { givegrove:'GiveGrove', mcgucket:'McGucket', 'big-jims-plates':"Big Jim's Plates", 'crowne-vault':'Crowne Vault', homestead:'Homestead', rooster:'The Rooster', venture:'The Venture', alfred:'Alfred', 'steward-manager':'Steward Manager', 'session-scribe':'Session Scribe', 'build-manager':'Build Manager' };
const DN_EXACT = { ios:'iOS', macos:'macOS', ipados:'iPadOS', tvos:'tvOS', watchos:'watchOS', github:'GitHub', gitlab:'GitLab', javascript:'JavaScript', typescript:'TypeScript', nodejs:'Node.js', node:'Node', graphql:'GraphQL', postgres:'Postgres', postgresql:'PostgreSQL', mysql:'MySQL', sqlite:'SQLite', mongodb:'MongoDB', openai:'OpenAI', chatgpt:'ChatGPT', youtube:'YouTube', paypal:'PayPal', wifi:'Wi-Fi', app:'App', v1:'v1', v2:'v2', v3:'v3', v4:'v4', v5:'v5' };

// One dash-delimited segment -> display token. Returns '' to drop it.
function dnToken(raw, prevRaw) {
  if (!raw) return '';
  const lower = raw.toLowerCase();

  // Issue refs: "gh-28" / "gh1609" -> "#28". Josh: "Gh 28" looks dumb.
  // The bare "gh" is consumed here; the number arrives as the next segment.
  if (lower === 'gh' || lower === 'issue' || lower === 'pr') return '#';
  if (/^(gh|issue|pr)\d+$/.test(lower)) return '#' + lower.replace(/^\D+/, '');

  // A pure number directly after a "#" marker glues on (handled by caller).
  if (DN_EXACT[lower]) return DN_EXACT[lower];
  if (DN_UPPER.has(lower)) return lower.toUpperCase();

  // Trailing-version words like "interface1" -> "Interface 1", "v2" kept above.
  const verSplit = lower.match(/^([a-z]+?)(\d+)$/);
  if (verSplit) {
    const head = verSplit[1], num = verSplit[2];
    if (DN_EXACT[head]) return DN_EXACT[head] + ' ' + num;
    if (DN_UPPER.has(head)) return head.toUpperCase() + ' ' + num;
    // "3lane" style (digit-led) is left alone below.
    return head.charAt(0).toUpperCase() + head.slice(1) + ' ' + num;
  }

  // Already-mixed-case input (a stored name like "GiveGrove") is respected.
  if (/[a-z]/.test(raw) && /[A-Z]/.test(raw)) return raw;

  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

// Turn one hyphenated chunk ("authless-giving-feasibility-gh-1609") into a
// clean label ("Authless Giving Feasibility #1609").
function dnHumanize(chunk) {
  if (!chunk || typeof chunk !== 'string') return '';
  // Respect a stored name that's already human (has a space or apostrophe and
  // no lone hyphens doing word-separator duty).
  const trimmed = chunk.trim();
  if (!trimmed) return '';
  if (/\s/.test(trimmed) && !/-/.test(trimmed)) {
    // Already spaced — still fix ugly "Gh 1616" / "Seo" style stored names.
    return dnPolishSpaced(trimmed);
  }

  // Multi-hop worker id ("foreman--gh-20"): humanize each hop, join with ' · '.
  if (trimmed.includes('--')) {
    return trimmed.split('--').filter(Boolean).map(dnHumanize).filter(Boolean).join(' · ');
  }
  const known = DN_NAMES[trimmed.toLowerCase()];
  if (known) return known;

  const parts = trimmed.split(/[-_\s]+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const tok = dnToken(parts[i], parts[i - 1]);
    if (!tok) continue;
    if (tok === '#') {
      // Glue the following number on: gh + 28 -> #28
      const next = parts[i + 1];
      if (next && /^\d+$/.test(next)) { out.push('#' + next); i++; }
      // A dangling "gh" with no number is dropped as noise.
      continue;
    }
    if (/^#\d+$/.test(tok)) { out.push(tok); continue; }
    out.push(tok);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// Clean an already-spaced stored name: "Agree Continue Dead Gh 1616" ->
// "Agree Continue Dead #1616"; "Seo 404 Cleanup" -> "SEO 404 Cleanup".
function dnPolishSpaced(s) {
  const parts = s.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lower = p.toLowerCase();
    if ((lower === 'gh' || lower === 'issue') && /^\d+$/.test(parts[i + 1] || '')) {
      out.push('#' + parts[i + 1]); i++; continue;
    }
    if (DN_EXACT[lower]) { out.push(DN_EXACT[lower]); continue; }
    if (DN_UPPER.has(lower)) { out.push(lower.toUpperCase()); continue; }
    out.push(p);
  }
  return out.join(' ').trim();
}

// Split "holler-crowne-vault--foreman--gh-20" into its id parts.
// Returns { stewardId, workerId } where workerId is the LAST meaningful
// segment (intermediate role hops like "foreman" are kept as context).
function dnSplitSession(sid) {
  const raw = (typeof sid === 'string' ? sid : '').trim();
  if (!raw) return { stewardId: '', workerId: '', hops: [] };
  let stripped = raw.replace(/^holler-/, '');
  // Only strip a "steward-" role prefix when what remains is still a real id
  // AND the full form isn't itself a known name (holler-steward-manager).
  if (/^steward-/.test(stripped) && !DN_NAMES[stripped]) {
    const rest = stripped.replace(/^steward-/, '');
    if (rest) stripped = rest;
  }
  const segs = stripped.split('--').filter(Boolean);
  return {
    stewardId: segs[0] || '',
    workerId: segs.length > 1 ? segs.slice(1).join('--') : '',
    hops: segs.slice(1, -1)
  };
}

// Look up a clean stored name for a session id, if the steward tree has one.
// Tolerates records that carry an id but no name (real, live case).
function dnLookup(sid) {
  try {
    if (typeof findStewardForSession !== 'function') return null;
    return findStewardForSession(sid) || null;
  } catch (e) { return null; }
}

// Exact worker/substeward record for a session id, or null. MUST be used
// instead of dnLookup() for worker labels: findStewardForSession()
// deliberately resolves a worker session UP to its top-level steward (prefix
// fallback), so using it for the worker name renders every worker as its
// parent ("Catalog Field Overrides" -> "Crowne Vault").
function dnLookupWorker(sid) {
  try {
    if (typeof findSubstewardForSession === 'function') {
      const sub = findSubstewardForSession(sid);
      if (sub) return sub;
    }
    // Workers live under steward.workers[] as well as substewards[].
    if (typeof stewards !== 'undefined' && Array.isArray(stewards)) {
      for (const st of stewards) {
        for (const w of (st.workers || [])) {
          if (w && (w.sessionName === sid || `holler-${st.id}--${w.id}` === sid)) return w;
        }
      }
    }
  } catch (e) {}
  return null;
}

/**
 * THE canonical steward (top-level) label. "holler-big-jims-plates" ->
 * "Big Jim's Plates".
 */
function stewardDisplayName(sid) {
  const { stewardId } = dnSplitSession(sid);
  if (!stewardId) return '';
  const topId = 'holler-' + stewardId;
  const rec = dnLookup(topId) || dnLookup(sid);
  // Only trust a record's name when it's actually the top steward's.
  if (rec && rec.name && (rec.id === stewardId || rec.sessionName === topId)) {
    return dnHumanize(rec.name);
  }
  return dnHumanize(stewardId);
}

/**
 * THE canonical worker label — the part after "--". '' for a bare steward.
 * "holler-givegrove--authless-giving-feasibility-gh-1609"
 *   -> "Authless Giving Feasibility #1609"
 */
function workerDisplayName(sid) {
  const { workerId } = dnSplitSession(sid);
  if (!workerId) return '';
  const rec = dnLookupWorker(sid);
  if (rec && rec.name) return dnHumanize(rec.name);
  return dnHumanize(workerId);
}

/**
 * THE canonical full label for any session id, worker-first.
 * Bare steward  -> "Crowne Vault"
 * Worker        -> "Mobile Checkout Overflow"      (opts.withSteward -> adds steward)
 */
function sessionDisplayName(sid, opts) {
  const o = opts || {};
  const worker = workerDisplayName(sid);
  const steward = stewardDisplayName(sid);
  if (!worker) return steward || '?';
  if (o.withSteward && steward) return steward + ' · ' + worker;
  return worker;
}

function abbrevDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function formatActualTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// Full date+time+relative for the card-top timestamp row.
// Example: "Apr 23, 2026 · 8:12 AM · 5m ago"
function formatFullCardTimestamp(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const datePart = `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  const timePart = formatActualTime(timestamp);
  const rel = relativeTime(timestamp);
  const relPart = (rel === 'now') ? 'just now' : `${rel} ago`;
  return `${datePart} · ${timePart} · ${relPart}`;
}

function parseSourceFromSession(sessionId) {
  if (!sessionId) return null;
  // holler-homestead--joshua-mullet-town-feature-presenter-ui → presenter-ui
  const dashDash = sessionId.indexOf('--');
  if (dashDash < 0) return null;
  let branch = sessionId.substring(dashDash + 2);
  // Strip common prefixes: joshua-mullet-town-feature-, jmullet-feature-, etc.
  branch = branch
    .replace(/^joshua-mullet-town-/, '')
    .replace(/^jmullet-/, '')
    .replace(/^feature-/, '')
    .replace(/^bugfix-/, '')
    .replace(/^hotfix-/, '')
    .replace(/^fix-/, '');
  return branch || null;
}

function sessionAcronym(sessionId) {
  if (!sessionId) return '??';
  let name = sessionId.replace(/^holler-/, '');
  const dashDash = name.indexOf('--');
  if (dashDash > 0) name = name.substring(0, dashDash);
  const parts = name.split('-').filter(Boolean);
  if (parts.length === 0) return '??';
  return parts.map(p => p[0].toUpperCase()).join('');
}

// --- Worker badge (Josh 2026-09-10) ---
//
// When Josh is looking at a WORKER (not the top-level steward), the target pill
// must read as the WORKER, not the steading: the worker's first two letters go
// BIG, and the steading's icon shrinks to a small corner badge on top of them.
// His reasoning IS the spec: "the badge tells him which steading he's in, the
// two letters tell him which worker."
//
// This ports behavior the APK already had and he already liked — do not
// redesign it. The two surfaces derive the letters the SAME way (see
// MainActivity's shorthand fallback) so they can never drift apart.
//
// Returns '' for a bare steward / unknown session — callers treat '' as
// "not on a worker, render exactly as before".
function workerBadgeLetters(sessionId) {
  try {
    const { workerId } = dnSplitSession(sessionId);
    if (!workerId) return '';
    // Prefer the worker's stored NAME (what Josh actually reads in the row)
    // over the raw session suffix, so "Worker Badge And Direct Send" yields
    // "WO" and not a slug fragment. Falls back to the suffix when the tree
    // has no record (torn-down workers, single-dash legacy sessions).
    const rec = (typeof dnLookupWorker === 'function') ? dnLookupWorker(sessionId) : null;
    const base = (rec && rec.name) ? rec.name : workerId;
    const letters = String(base).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
    return letters || '';
  } catch (e) { return ''; }
}

function parseMessageContent(raw) {
  if (!raw) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.instruction) {
      return parsed.instruction;
    }
    return raw;
  } catch {
    return raw;
  }
}

// Preview-grade markdown stripper. Not a parser — just enough to keep **bold**,
// `code`, [text](url), headings, bullets, and blockquotes from leaking into the
// sidebar preview's textContent. Collapses newlines to spaces.
function stripMarkdownForPreview(s) {
  if (!s) return '';
  let out = String(s);
  // Images ![alt](url) → alt (do before links)
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links [text](url) → text
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Bold/italic/strikethrough — unwrap delimiters
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1$2');
  out = out.replace(/~~([^~]+)~~/g, '$1');
  // Inline code `x` → x ; fenced code ``` … ``` → drop fences
  out = out.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '').replace(/\n/g, ' '));
  out = out.replace(/`([^`]+)`/g, '$1');
  // Leading heading/blockquote/bullet markers per line
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, '');
  out = out.replace(/^\s{0,3}\d+\.\s+/gm, '');
  // Newlines → single space; collapse runs
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

// Update the bottom-input target pill to show which steward walkie-sends go to.
// The pill ONLY reflects the walkie target now — the separate [↳ Card] button
// handles card-reply destination. No more mode-swap.
function updateBottomTargetPill() {
  const pill = document.getElementById('conv-bottom-target-pill');
  if (!pill) return;
  const label = pill.querySelector('.pill-label');
  const iconEl = pill.querySelector('.pill-icon');
  pill.classList.remove('replying-to-card');
  // Also refresh the separate Card-send button's enabled state any time we
  // re-render the target pill (renderSidebar / selectSteward callers).
  if (typeof refreshCardSendBtn === 'function') refreshCardSendBtn();
  if (!selectedSteward) {
    pill.classList.add('is-empty');
    pill.style.removeProperty('--pill-color');
    if (label) label.textContent = 'no target';
    if (iconEl) iconEl.textContent = '·';
    pill.title = 'Select a steward to send messages';
    return;
  }
  pill.classList.remove('is-empty');

  // Try substeward first (more specific), then parent steward, then orphan fallback.
  const sub = (typeof findSubstewardForSession === 'function') ? findSubstewardForSession(selectedSteward) : null;
  const stw = (typeof findStewardForSession === 'function') ? findStewardForSession(selectedSteward) : null;

  let name, color, icon;
  if (sub) {
    name = sub.name || sub.id || selectedSteward;
    // Substewards often lack their own color — fall back to parent's color.
    color = sub.color || (stw && stw.color) || '#FF6600';
    // Substeward icon preferred; fall back to parent's icon so the pill
    // always carries visual identity even when the sub doesn't set one.
    icon = sub.icon || (stw && stw.icon) || '·';
  } else if (stw) {
    name = stw.name || stw.id || selectedSteward;
    color = stw.color || '#FF6600';
    icon = stw.icon || '·';
  } else {
    // Orphan session — no steward record. Canonical formatter derives a clean
    // label from the id alone (~40% of live sessions have no tree record).
    name = sessionDisplayName(selectedSteward);
    color = '';
    icon = '·';
  }

  if (label) label.textContent = name;

  // WORKER badge (Josh 2026-09-10). On a worker the icon-half stops being just
  // the steading glyph: the worker's two letters take the room, and the
  // steading icon rides along as a small corner badge so he still knows which
  // steading he's in. On a bare steward this branch never runs and the pill
  // renders exactly as it always has.
  const badgeLetters = (typeof workerBadgeLetters === 'function')
    ? workerBadgeLetters(selectedSteward) : '';
  if (iconEl) {
    if (badgeLetters) {
      // Rebuild rather than setting textContent, so the corner badge is a real
      // child element the stylesheet can position.
      iconEl.textContent = '';
      iconEl.classList.add('pill-icon-worker');
      const lettersEl = document.createElement('span');
      lettersEl.className = 'pill-worker-letters';
      lettersEl.textContent = badgeLetters;
      iconEl.appendChild(lettersEl);
      // The corner badge is the STEADING's icon — resolve it off the top-level
      // steward, never the substeward/worker (which usually has none anyway).
      const steadingIcon = (stw && (stw.icon || stw.shorthand)) || '';
      if (steadingIcon) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'pill-worker-badge';
        badgeEl.textContent = steadingIcon;
        iconEl.appendChild(badgeEl);
      }
    } else {
      iconEl.classList.remove('pill-icon-worker');
      iconEl.textContent = icon;
    }
  }
  if (color) pill.style.setProperty('--pill-color', color);
  else pill.style.removeProperty('--pill-color');
  // Title says WHO the next message reaches. On a worker that is the worker
  // itself — the send already targets `selectedSteward`, which IS the worker's
  // session (see sendTextAsWalkie), so the left half has always delivered
  // straight to the worker; this just says so out loud.
  pill.title = badgeLetters
    ? ('Next message → ' + (name || selectedSteward) + ' (this worker)')
    : ('Next message → ' + selectedSteward);

  // Re-evaluate the split-pill's card-number half on EVERY steading switch.
  // This runs here (not just inside setCurrent) because setCurrent early-returns
  // when the new steading has zero cards — so without this call the card-half
  // would keep the PREVIOUS steading's stale number. (Josh 2026-08-11.)
  if (typeof window.__updateSplitPillCardHalf === 'function') {
    window.__updateSplitPillCardHalf();
  }
}

// Normalize an item's sort timestamp. Handles numeric ms, ISO strings, and
// id-prefixed ms (e.g. "1776698570429-abc123"). Returns 0 if nothing usable.
function getItemSortTs(item) {
  if (!item) return 0;
  if (typeof item.timestamp === 'number' && item.timestamp > 0) return item.timestamp;
  if (item.created_at) {
    const t = new Date(item.created_at).getTime();
    if (!isNaN(t)) return t;
  }
  if (item.dismissed_at) {
    const t = new Date(item.dismissed_at).getTime();
    if (!isNaN(t)) return t;
  }
  if (typeof item.id === 'string') {
    const m = item.id.match(/^(\d{13})/);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

// --- Custom card components ---
//
// Cards can specify `component` (string name) + `componentProps` (arbitrary JSON)
// to render a custom interactive block below the message text.
// Components are additive: the card's title/message/buttons/input still render normally.
//
// To register a new component, add a function to CARD_COMPONENTS that takes
// (props, item) and returns an HTMLElement (or null to render nothing).

const CARD_COMPONENTS = {};

function renderCardComponent(item) {
  if (!item || !item.component) return null;
  const fn = CARD_COMPONENTS[item.component];
  if (typeof fn !== 'function') {
    console.warn('[Presenter] Unknown card component:', item.component);
    return null;
  }
  try {
    return fn(item.componentProps || {}, item);
  } catch (err) {
    console.error('[Presenter] Card component render error:', item.component, err);
    const errEl = document.createElement('div');
    errEl.className = 'card-component-error';
    errEl.textContent = 'Component "' + item.component + '" failed to render: ' + (err.message || err);
    return errEl;
  }
}

const SERVER_URL_FOR_COMPONENTS = window.location.origin || 'http://localhost:3005';

// 404 means the underlying card was already resolved/dismissed elsewhere
// (via another client, or by Joshua responding to it directly). That's not an
// error — it's "already handled." Callers should treat `alreadyGone: true`
// like success and mark the row as resolved with a muted badge.
async function cardComponentRespond(cardId, button, text) {
  const res = await fetch(SERVER_URL_FOR_COMPONENTS + '/api/presenter/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: cardId, button: button, text: text || '' }),
  });
  if (res.status === 404) return { alreadyGone: true };
  if (!res.ok) throw new Error('respond HTTP ' + res.status);
  return res.json();
}

async function cardComponentDismiss(cardId) {
  const res = await fetch(SERVER_URL_FOR_COMPONENTS + '/api/presenter/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: cardId }),
  });
  if (res.status === 404) return { alreadyGone: true };
  if (!res.ok) throw new Error('dismiss HTTP ' + res.status);
  return res.json();
}

// --- shakedownReport component ---
// Props:
//   {
//     verdict: "PASS" | "PARTIAL" | "FAIL",
//     summary: string,
//     runDate: "YYYY-MM-DD",
//     runDurationMs?: number,
//     screenshotBaseUrl: string,        // prepended to each step.screenshotUrl
//     firstFailStepId?: string,         // optional — "Jump to first failure" target
//     totals: { pass, fail, partial, skipped, total },
//     bugs?: [{ id, title, url, severity: "high"|"med"|"low", stepIds: [] }],
//     journeys: [
//       {
//         id, num, name, persona, color,
//         verdict: "PASS" | "PARTIAL" | "FAIL",
//         stepCounts: { pass, fail, partial, skipped },
//         nextAction?: string,           // only for PARTIAL/FAIL journeys
//         steps: [
//           {
//             id, num, label, detail, status: "PASS"|"FAIL"|"PARTIAL"|"SKIPPED",
//             screenshotUrl?: string,    // relative; full URL = screenshotBaseUrl + screenshotUrl
//             notes?: string,
//             expectedResult?: string,   // FAIL/PARTIAL only
//             actualResult?: string,     // FAIL/PARTIAL only
//             timestamp?: number,        // ms epoch
//             bugIds?: string[]          // references to bugs[] by id
//           }
//         ]
//       }
//     ]
//   }
//
// Owned by Rundown (Internal Ops). Built + rendered here because presenter owns rendering.
//
// DATA SOURCE (v1.1 addition): props may include EITHER inline data (verdict, journeys, etc.)
// OR a `dataUrl` that points to a JSON file served from Homestead's static dir. When dataUrl
// is present, the component renders a loading state and fetches the JSON client-side, then
// populates itself. Rationale: large shakedowns (46 steps × notes × screenshots) bloat past
// Rundown's context window, so loading from disk is cheaper than passing inline.
//
// dataUrl precedence: if BOTH dataUrl and inline fields are present, dataUrl WINS (fetched
// data replaces inline). This matches the "dataUrl takes precedence" semantics Rundown asked for.
CARD_COMPONENTS.shakedownReport = function shakedownReportComponent(props) {
  const root = document.createElement('div');
  root.className = 'shakedown-report';

  if (props && props.dataUrl) {
    renderShakedownLoading(root, props.dataUrl);
    fetch(props.dataUrl, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        root.innerHTML = '';
        renderShakedownInto(root, data);
      })
      .catch(function (err) {
        console.error('[shakedownReport] fetch failed:', err);
        root.innerHTML = '';
        const errEl = document.createElement('div');
        errEl.className = 'sr-fetch-error';
        errEl.textContent = 'Failed to load shakedown report from ' + props.dataUrl + ': ' + (err.message || err);
        root.appendChild(errEl);
      });
  } else {
    renderShakedownInto(root, props || {});
  }

  return root;
};

function renderShakedownLoading(root, dataUrl) {
  const wrap = document.createElement('div');
  wrap.className = 'sr-loading';
  const spinner = document.createElement('span');
  spinner.className = 'sr-loading-spinner';
  spinner.textContent = '⏳';
  wrap.appendChild(spinner);
  const label = document.createElement('span');
  label.className = 'sr-loading-label';
  label.textContent = 'Loading shakedown report…';
  wrap.appendChild(label);
  const url = document.createElement('div');
  url.className = 'sr-loading-url';
  url.textContent = dataUrl;
  wrap.appendChild(url);
  root.appendChild(wrap);
}

function renderShakedownInto(root, props) {
  const STATUS_CLASS = { PASS: 'sr-pass', FAIL: 'sr-fail', PARTIAL: 'sr-partial', SKIPPED: 'sr-skipped' };
  const statusClass = function (s) { return STATUS_CLASS[s] || 'sr-skipped'; };
  const baseUrl = props.screenshotBaseUrl || '';
  const resolveShot = function (url) {
    if (!url) return null;
    if (/^https?:\/\//.test(url)) return url;
    return baseUrl + url;
  };

  // --- Header: verdict + totals + run meta + summary ---
  const header = document.createElement('div');
  header.className = 'sr-header';

  const verdictPill = document.createElement('span');
  verdictPill.className = 'sr-verdict-pill ' + statusClass(props.verdict);
  verdictPill.textContent = props.verdict || '—';
  header.appendChild(verdictPill);

  const totals = props.totals || { pass: 0, fail: 0, partial: 0, skipped: 0, total: 0 };
  const totalsEl = document.createElement('span');
  totalsEl.className = 'sr-totals';
  totalsEl.innerHTML =
    '<span class="sr-totals-main">' + totals.pass + ' / ' + totals.total + ' PASS</span> · ' +
    '<span class="sr-totals-fail">' + totals.fail + ' FAIL</span> · ' +
    '<span class="sr-totals-partial">' + totals.partial + ' PARTIAL</span> · ' +
    '<span class="sr-totals-skipped">' + totals.skipped + ' SKIPPED</span>';
  header.appendChild(totalsEl);
  root.appendChild(header);

  // Run meta line (date + duration)
  const meta = document.createElement('div');
  meta.className = 'sr-meta';
  let metaText = 'Run: ' + (props.runDate || '—');
  if (props.runDurationMs) {
    const mins = Math.round(props.runDurationMs / 60000);
    metaText += '  ·  Duration: ~' + mins + ' min';
  }
  meta.textContent = metaText;
  root.appendChild(meta);

  // Summary paragraph
  if (props.summary) {
    const summary = document.createElement('div');
    summary.className = 'sr-summary';
    summary.textContent = props.summary;
    root.appendChild(summary);
  }

  // --- Bugs filed section ---
  const bugs = Array.isArray(props.bugs) ? props.bugs : [];
  if (bugs.length > 0) {
    const bugsBox = document.createElement('div');
    bugsBox.className = 'sr-bugs';
    const bugsTitle = document.createElement('div');
    bugsTitle.className = 'sr-bugs-title';
    bugsTitle.textContent = 'Bugs filed: ' + bugs.length;
    bugsBox.appendChild(bugsTitle);
    bugs.forEach(function (bug) {
      const row = document.createElement('div');
      row.className = 'sr-bug-row';
      const sev = document.createElement('span');
      sev.className = 'sr-bug-sev sr-bug-sev-' + (bug.severity || 'low');
      sev.textContent = (bug.severity || 'low').toUpperCase();
      row.appendChild(sev);
      if (bug.url) {
        const link = document.createElement('a');
        link.href = bug.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'sr-bug-link';
        link.textContent = bug.title || bug.id || 'bug';
        row.appendChild(link);
      } else {
        const span = document.createElement('span');
        span.className = 'sr-bug-link';
        span.textContent = bug.title || bug.id || 'bug';
        row.appendChild(span);
      }
      bugsBox.appendChild(row);
    });
    root.appendChild(bugsBox);
  }

  // --- Jump to first failure ---
  if (props.firstFailStepId) {
    const jumpBtn = document.createElement('button');
    jumpBtn.className = 'sr-jump-btn';
    jumpBtn.textContent = '↓ Jump to first failure';
    jumpBtn.addEventListener('click', function () {
      const target = root.querySelector('[data-step-id="' + props.firstFailStepId + '"]');
      if (!target) return;
      // Walk up to the journey section and expand it
      const journeySection = target.closest('.sr-journey');
      if (journeySection) journeySection.classList.add('expanded');
      setTimeout(function () {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('sr-step-highlight');
        setTimeout(function () { target.classList.remove('sr-step-highlight'); }, 2000);
      }, 50);
    });
    root.appendChild(jumpBtn);
  }

  // --- Journeys ---
  const journeys = Array.isArray(props.journeys) ? props.journeys : [];
  const journeysWrap = document.createElement('div');
  journeysWrap.className = 'sr-journeys';
  journeys.forEach(function (j) {
    journeysWrap.appendChild(buildJourney(j));
  });
  root.appendChild(journeysWrap);

  function buildJourney(j) {
    const section = document.createElement('div');
    section.className = 'sr-journey';
    // PASS journeys stay collapsed by default; non-PASS auto-expand so Joshua sees issues immediately
    if (j.verdict !== 'PASS') section.classList.add('expanded');
    if (j.color) section.style.borderLeftColor = j.color;

    // Header: chevron + num + name + persona + verdict pill + step counts
    const head = document.createElement('div');
    head.className = 'sr-journey-head';
    head.innerHTML =
      '<span class="sr-chevron">▸</span>' +
      '<span class="sr-j-num">' + (j.num || '?') + '.</span>' +
      '<span class="sr-j-name"></span>' +
      '<span class="sr-j-verdict ' + statusClass(j.verdict) + '">' + (j.verdict || '—') + '</span>';
    head.querySelector('.sr-j-name').textContent = j.name || j.persona || '(untitled journey)';
    head.addEventListener('click', function () { section.classList.toggle('expanded'); });
    section.appendChild(head);

    // Step count line
    const sc = j.stepCounts || {};
    const countsLine = document.createElement('div');
    countsLine.className = 'sr-journey-counts';
    const parts = [];
    if (sc.pass) parts.push(sc.pass + ' pass');
    if (sc.fail) parts.push(sc.fail + ' fail');
    if (sc.partial) parts.push(sc.partial + ' partial');
    if (sc.skipped) parts.push(sc.skipped + ' skipped');
    countsLine.textContent = parts.join(' · ') || '—';
    if (j.persona) countsLine.textContent = j.persona + '  ·  ' + countsLine.textContent;
    section.appendChild(countsLine);

    // Expanded body: nextAction + steps
    const body = document.createElement('div');
    body.className = 'sr-journey-body';

    if (j.nextAction && j.verdict !== 'PASS') {
      const na = document.createElement('div');
      na.className = 'sr-next-action';
      na.innerHTML = '<span class="sr-next-action-label">Next:</span> <span class="sr-next-action-text"></span>';
      na.querySelector('.sr-next-action-text').textContent = j.nextAction;
      body.appendChild(na);
    }

    const steps = Array.isArray(j.steps) ? j.steps : [];
    steps.forEach(function (s) { body.appendChild(buildStep(s)); });

    section.appendChild(body);
    return section;
  }

  function buildStep(s) {
    const row = document.createElement('div');
    row.className = 'sr-step ' + statusClass(s.status);
    row.dataset.stepId = s.id || '';

    const top = document.createElement('div');
    top.className = 'sr-step-top';

    const pill = document.createElement('span');
    pill.className = 'sr-status-pill ' + statusClass(s.status);
    pill.textContent = s.status || 'SKIPPED';
    top.appendChild(pill);

    const num = document.createElement('span');
    num.className = 'sr-step-num';
    num.textContent = (s.num || '?') + '.';
    top.appendChild(num);

    const label = document.createElement('span');
    label.className = 'sr-step-label';
    label.textContent = s.label || '(unlabeled)';
    top.appendChild(label);

    row.appendChild(top);

    if (s.detail) {
      const detail = document.createElement('div');
      detail.className = 'sr-step-detail';
      detail.textContent = s.detail;
      row.appendChild(detail);
    }

    // Expected vs actual side-by-side for FAIL/PARTIAL
    if ((s.status === 'FAIL' || s.status === 'PARTIAL') && (s.expectedResult || s.actualResult)) {
      const diag = document.createElement('div');
      diag.className = 'sr-step-diag';
      if (s.expectedResult) {
        const exp = document.createElement('div');
        exp.className = 'sr-diag-row sr-diag-expected';
        exp.innerHTML = '<span class="sr-diag-label">Expected:</span> <span class="sr-diag-text"></span>';
        exp.querySelector('.sr-diag-text').textContent = s.expectedResult;
        diag.appendChild(exp);
      }
      if (s.actualResult) {
        const act = document.createElement('div');
        act.className = 'sr-diag-row sr-diag-actual';
        act.innerHTML = '<span class="sr-diag-label">Got:</span> <span class="sr-diag-text"></span>';
        act.querySelector('.sr-diag-text').textContent = s.actualResult;
        diag.appendChild(act);
      }
      row.appendChild(diag);
    }

    if (s.notes) {
      const notes = document.createElement('div');
      notes.className = 'sr-step-notes';
      notes.textContent = s.notes;
      row.appendChild(notes);
    }

    // Screenshot (lazy-loaded, click to toggle full-size)
    const shotUrl = resolveShot(s.screenshotUrl);
    if (shotUrl) {
      const shotWrap = document.createElement('div');
      shotWrap.className = 'sr-shot-wrap';
      const img = document.createElement('img');
      img.className = 'sr-shot';
      img.loading = 'lazy';
      img.src = shotUrl;
      img.alt = s.label || 'step screenshot';
      img.addEventListener('click', function () {
        shotWrap.classList.toggle('sr-shot-full');
      });
      shotWrap.appendChild(img);
      row.appendChild(shotWrap);
    }

    // Bug references
    if (Array.isArray(s.bugIds) && s.bugIds.length > 0) {
      const bugLine = document.createElement('div');
      bugLine.className = 'sr-step-bugs';
      bugLine.textContent = '🐛 ' + s.bugIds.join(', ');
      row.appendChild(bugLine);
    }

    return row;
  }
}

// --- triageReport component ---
//
// Spec: Triage Dispatch Contract v1 §4
// (~/.homestead/stewards/homestead/library/platform/presenter/triage-dispatch-contract.md)
//
// Renders a Top-Steward-consolidated card. componentProps shape:
//   {
//     groups: [
//       {
//         topic: "<plain-English topic>",
//         joshua_question_for_group: "<single decision/question>",
//         decision_mode?: "text" | "buttons",          // optional, default "text"
//         button_options?: ["Approve", "Deny", "Defer"], // when decision_mode="buttons"
//         cards: [
//           { id, source, age_hours, title, message_preview, pinned }
//         ]
//       }
//     ],
//     culled: [
//       { card_id, source, age_hours, title, reason }
//     ],
//     total_landed_window: { earliest: <ISO>, latest: <ISO> },
//     pinned_callouts: [
//       { card_id, source, title, topic, note }
//     ],
//   }
//
// Plain-English rule: every label, topic, reason rendered FOR Joshua. No
// jargon. (lesson-no-dev-jargon-in-cards)
//
// Cull justification renders as VISIBLE rows. Never collapsed, never buried
// in tooltip text. Joshua must be able to scan and challenge.
//
// Pinned cards get their own visual section ("Won't be dismissed regardless
// of your response."). They may also appear inline inside a group as context.
//
// Per-group input: each group gets its own answer affordance. When the user
// hits "Apply to reply", the component formats a structured answer and
// places it into the parent card's .msg-input textarea so the existing
// Send button delivers it. The skill receives the structured text, splits
// it back into per-group answers, then calls /api/presenter/triage-resolve.
CARD_COMPONENTS.triageReport = function triageReportComponent(props, item) {
  const root = document.createElement('div');
  root.className = 'triage-report';

  const data = props || {};
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const culled = Array.isArray(data.culled) ? data.culled : [];
  const pinnedCallouts = Array.isArray(data.pinned_callouts) ? data.pinned_callouts : [];
  const window_ = data.total_landed_window || null;

  // ---- Header: scope + landed window ----
  const header = document.createElement('div');
  header.className = 'tr-header';

  const scope = document.createElement('div');
  scope.className = 'tr-scope';
  const totalCards = groups.reduce((acc, g) => acc + (Array.isArray(g.cards) ? g.cards.length : 0), 0);
  scope.textContent = `Triage summary — ${totalCards} card${totalCards === 1 ? '' : 's'} kept across ${groups.length} group${groups.length === 1 ? '' : 's'}, ${culled.length} dropped`;
  header.appendChild(scope);

  if (window_ && (window_.earliest || window_.latest)) {
    const win = document.createElement('div');
    win.className = 'tr-window';
    const fmt = function (iso) {
      if (!iso) return '—';
      try {
        return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      } catch { return iso; }
    };
    win.textContent = `Cards landed between ${fmt(window_.earliest)} and ${fmt(window_.latest)}`;
    header.appendChild(win);
  }
  root.appendChild(header);

  // ---- Pinned callouts (own visual treatment) ----
  if (pinnedCallouts.length > 0) {
    const pinnedBox = document.createElement('div');
    pinnedBox.className = 'tr-pinned-box';
    const pinnedTitle = document.createElement('div');
    pinnedTitle.className = 'tr-section-title tr-pinned-title';
    pinnedTitle.textContent = `📌 Pinned (${pinnedCallouts.length}) — won't be dismissed regardless of your response`;
    pinnedBox.appendChild(pinnedTitle);
    pinnedCallouts.forEach(function (p) {
      const row = document.createElement('div');
      row.className = 'tr-pinned-row';
      const titleEl = document.createElement('div');
      titleEl.className = 'tr-pinned-cardtitle';
      titleEl.textContent = p.title || '(untitled card)';
      row.appendChild(titleEl);
      const meta = document.createElement('div');
      meta.className = 'tr-pinned-meta';
      const parts = [];
      if (p.source) parts.push('From: ' + p.source);
      if (p.topic) parts.push('Topic: ' + p.topic);
      if (p.note) parts.push(p.note);
      meta.textContent = parts.join(' · ');
      row.appendChild(meta);
      pinnedBox.appendChild(row);
    });
    root.appendChild(pinnedBox);
  }

  // ---- Groups ----
  // Per-group answer state lives in the DOM (textareas / button-press flags).
  // When Joshua hits "Apply to reply", we walk the groups, collect per-group
  // answers, format a structured payload, and write it into the parent
  // card's .msg-input textarea.
  const groupAnswers = {}; // topic -> { mode, text or chosenButton, perCardChoices? }

  groups.forEach(function (g, gi) {
    const section = document.createElement('div');
    section.className = 'tr-group';
    section.dataset.groupIndex = String(gi);

    const gh = document.createElement('div');
    gh.className = 'tr-group-header';
    const topicEl = document.createElement('div');
    topicEl.className = 'tr-group-topic';
    topicEl.textContent = g.topic || '(no topic)';
    gh.appendChild(topicEl);
    const question = document.createElement('div');
    question.className = 'tr-group-question';
    question.textContent = g.joshua_question_for_group || 'No specific question — review and answer.';
    gh.appendChild(question);
    section.appendChild(gh);

    // List the cards in the group (visible)
    const cards = Array.isArray(g.cards) ? g.cards : [];
    if (cards.length > 0) {
      const list = document.createElement('div');
      list.className = 'tr-card-list';
      cards.forEach(function (c) {
        const cardRow = document.createElement('div');
        cardRow.className = 'tr-card-row' + (c.pinned ? ' tr-card-pinned' : '');
        cardRow.dataset.cardId = c.id || '';

        const left = document.createElement('div');
        left.className = 'tr-card-left';
        const ttl = document.createElement('div');
        ttl.className = 'tr-card-title';
        ttl.textContent = (c.pinned ? '📌 ' : '') + (c.title || '(untitled)');
        left.appendChild(ttl);
        const meta = document.createElement('div');
        meta.className = 'tr-card-meta';
        const ageStr = (typeof c.age_hours === 'number')
          ? (c.age_hours < 1
            ? Math.round(c.age_hours * 60) + ' min ago'
            : (c.age_hours < 24
              ? c.age_hours.toFixed(1) + ' h ago'
              : (c.age_hours / 24).toFixed(1) + ' d ago'))
          : '';
        const metaParts = [];
        if (c.source) metaParts.push('From: ' + c.source);
        if (ageStr) metaParts.push(ageStr);
        meta.textContent = metaParts.join(' · ');
        left.appendChild(meta);
        if (c.message_preview) {
          const prev = document.createElement('div');
          prev.className = 'tr-card-preview';
          prev.textContent = c.message_preview;
          left.appendChild(prev);
        }
        cardRow.appendChild(left);

        section.appendChild(cardRow);
      });
      section.appendChild(list);
    }

    // Per-group answer affordance
    const answerWrap = document.createElement('div');
    answerWrap.className = 'tr-group-answer';
    const decisionMode = (g.decision_mode === 'buttons' && Array.isArray(g.button_options) && g.button_options.length > 0) ? 'buttons' : 'text';

    if (decisionMode === 'buttons') {
      // Per-card button row (Approve/Deny/Defer style). Each card in the
      // group gets its own button bar so Joshua can tap-resolve per item.
      // (lesson-graduation-requires-button-tap-not-text)
      const btnNote = document.createElement('div');
      btnNote.className = 'tr-group-answer-label';
      btnNote.textContent = 'Tap one per card:';
      answerWrap.appendChild(btnNote);

      const perCardChoices = {};
      groupAnswers[g.topic] = { mode: 'buttons', perCardChoices };

      cards.forEach(function (c) {
        const cardId = c.id || '';
        const cardBar = document.createElement('div');
        cardBar.className = 'tr-card-buttonbar';

        const lbl = document.createElement('span');
        lbl.className = 'tr-card-buttonbar-label';
        lbl.textContent = (c.title || cardId).slice(0, 60);
        cardBar.appendChild(lbl);

        g.button_options.forEach(function (opt) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'tr-pickbtn';
          b.textContent = opt;
          b.addEventListener('click', function () {
            cardBar.querySelectorAll('.tr-pickbtn').forEach(function (sib) { sib.classList.remove('chosen'); });
            b.classList.add('chosen');
            perCardChoices[cardId] = opt;
          });
          cardBar.appendChild(b);
        });

        answerWrap.appendChild(cardBar);
      });
    } else {
      // Free-text per-group answer.
      const lbl = document.createElement('div');
      lbl.className = 'tr-group-answer-label';
      lbl.textContent = 'Your answer for this group:';
      answerWrap.appendChild(lbl);
      const ta = document.createElement('textarea');
      ta.className = 'tr-group-textarea';
      ta.rows = 2;
      ta.placeholder = 'Type your answer to: ' + (g.joshua_question_for_group || 'this group');
      answerWrap.appendChild(ta);
      groupAnswers[g.topic] = { mode: 'text', textareaEl: ta };
    }

    section.appendChild(answerWrap);
    root.appendChild(section);
  });

  // ---- Culled (visible rows, never buried) ----
  if (culled.length > 0) {
    const culledBox = document.createElement('div');
    culledBox.className = 'tr-culled-box';
    const culledTitle = document.createElement('div');
    culledTitle.className = 'tr-section-title tr-culled-title';
    culledTitle.textContent = `Dropped from this summary (${culled.length}) — challenge any if you wanted to answer it`;
    culledBox.appendChild(culledTitle);
    culled.forEach(function (c) {
      const row = document.createElement('div');
      row.className = 'tr-culled-row';
      const ttl = document.createElement('div');
      ttl.className = 'tr-culled-title-row';
      ttl.textContent = c.title || '(untitled)';
      row.appendChild(ttl);
      const meta = document.createElement('div');
      meta.className = 'tr-culled-meta';
      const ageStr = (typeof c.age_hours === 'number')
        ? (c.age_hours < 24 ? c.age_hours.toFixed(1) + ' h old' : (c.age_hours / 24).toFixed(1) + ' d old')
        : '';
      const metaParts = [];
      if (c.source) metaParts.push('From: ' + c.source);
      if (ageStr) metaParts.push(ageStr);
      meta.textContent = metaParts.join(' · ');
      row.appendChild(meta);
      const reason = document.createElement('div');
      reason.className = 'tr-culled-reason';
      reason.textContent = 'Dropped because: ' + (c.reason || '(no reason given)');
      row.appendChild(reason);
      culledBox.appendChild(row);
    });
    root.appendChild(culledBox);
  }

  // ---- Apply-to-reply button ----
  // Walks groupAnswers, builds a structured plain-text payload, writes it
  // into the parent card's .msg-input. The skill receives the text via the
  // existing /api/presenter/respond pipeline and splits it back per group.
  const actions = document.createElement('div');
  actions.className = 'tr-actions';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'tr-apply-btn';
  applyBtn.textContent = 'Apply answers → reply';
  applyBtn.title = 'Format your per-group answers and put them into the reply box. Then hit Send.';
  applyBtn.addEventListener('click', function () {
    const lines = [];
    lines.push('--- TRIAGE ANSWERS ---');
    for (const topic of Object.keys(groupAnswers)) {
      const ans = groupAnswers[topic];
      if (ans.mode === 'text') {
        const v = (ans.textareaEl && ans.textareaEl.value || '').trim();
        lines.push('');
        lines.push('## ' + topic);
        lines.push(v ? v : '(no answer)');
      } else if (ans.mode === 'buttons') {
        lines.push('');
        lines.push('## ' + topic);
        const picks = ans.perCardChoices || {};
        const ids = Object.keys(picks);
        if (ids.length === 0) {
          lines.push('(no choices made)');
        } else {
          ids.forEach(function (cid) {
            lines.push('- ' + cid + ': ' + picks[cid]);
          });
        }
      }
    }
    const payload = lines.join('\n');
    // Find the parent card's .msg-input textarea.
    let bubble = root.closest('.msg-bubble');
    if (!bubble) {
      // Fallback — search up for any element with .msg-input child.
      let el = root.parentNode;
      while (el && !el.querySelector) el = el.parentNode;
      bubble = el;
    }
    const ta = bubble && bubble.querySelector ? bubble.querySelector('.msg-input') : null;
    if (ta) {
      ta.value = payload;
      ta.focus();
      // Subtle confirmation flash on the button
      applyBtn.classList.add('flashed');
      setTimeout(function () { applyBtn.classList.remove('flashed'); }, 1200);
    } else {
      console.warn('[triageReport] Could not find parent .msg-input textarea to apply answers.');
      alert('Could not find reply box. Copy answers manually:\n\n' + payload);
    }
  });
  actions.appendChild(applyBtn);
  root.appendChild(actions);

  return root;
};

// --- Steward <-> Session mapping ---

function getSessionIdsForSteward(steward) {
  const ids = [`holler-${steward.id}`, `holler-steward-${steward.id}`];
  if (steward.buildData && steward.buildData.project) {
    ids.push(`holler-${steward.buildData.project}`);
    for (const b of steward.buildData.builds || []) {
      if (b.status === 'active' && b.worktree) {
        const folder = b.worktree.split('/').pop() || '';
        ids.push(`holler-${steward.buildData.project}--${folder}`);
      }
    }
  }
  // Include substeward sessions (and sub-sub-stewards)
  if (steward.substewards && steward.substewards.length > 0) {
    for (const sub of steward.substewards) {
      ids.push(`holler-${steward.id}--${sub.id}`);
      if (sub.substewards && sub.substewards.length > 0) {
        for (const subsub of sub.substewards) {
          ids.push(`holler-${steward.id}--${sub.id}--${subsub.id}`);
        }
      }
    }
  }
  return ids;
}

function findStewardForSession(sessionId) {
  const exact = stewards.find(s => getSessionIdsForSteward(s).includes(sessionId));
  if (exact) return exact;
  // Prefix fallback (Josh 2026-08-27): a card can be owned by a worker/sub
  // session whose worker has torn down (so it's not in the active-builds list),
  // OR whose name uses a single-dash suffix (`holler-crowne-vault-qb-extension`)
  // instead of the canonical double-dash (`holler-crowne-vault--worker`). Both
  // must still resolve to the TOP-LEVEL steward so the timeline header reads
  // e.g. "Crowne Vault", not "Timeline — all cards".
  //
  // Match the steward whose `holler-<id>` prefix the session STARTS WITH, and
  // pick the LONGEST such match so `crowne-vault` wins over a hypothetical
  // `crowne`, and a `-qb-extension`/`--worker` suffix is tolerated uniformly.
  if (typeof sessionId === 'string' && sessionId.startsWith('holler-')) {
    // Normalize `holler-steward-<id>` → `holler-<id>` for prefix comparison.
    const norm = sessionId.replace(/^holler-steward-/, 'holler-');
    let best = undefined, bestLen = -1;
    for (const s of stewards) {
      const p = `holler-${s.id}`;
      // Exact, or a boundary-delimited prefix (`holler-<id>` then end / `-` / `--`).
      if (norm === p || norm.startsWith(p + '-')) {
        if (p.length > bestLen) { best = s; bestLen = p.length; }
      }
    }
    return best;
  }
  return undefined;
}

function findSubstewardForSession(sessionId) {
  for (const steward of stewards) {
    if (!steward.substewards) continue;
    for (const sub of steward.substewards) {
      if (sessionId === `holler-${steward.id}--${sub.id}`) return sub;
      // Check sub-sub-stewards
      if (sub.substewards) {
        for (const subsub of sub.substewards) {
          if (sessionId === `holler-${steward.id}--${sub.id}--${subsub.id}`) return subsub;
        }
      }
    }
  }
  return null;
}

function getItemsForSteward(steward) {
  if (!steward) return [];
  const ids = getSessionIdsForSteward(steward);
  return queue.filter(item => ids.includes(item.session_id));
}

// Cluster cards by time-gap to produce "dismiss older than…" buckets that
// actually match the shape of the queue. Fixed ladders (1h/6h/24h/...) don't
// line up with when Joshua's cards actually arrive.
//
// Algorithm:
//   1. Sort items by timestamp ascending (oldest first).
//   2. Compute consecutive-card gaps; find the median gap.
//   3. Threshold = max(30min, medianGap * 3). Any gap above threshold starts
//      a new cluster.
//   4. If >5 clusters, merge adjacent ones with the smallest boundary-gap
//      until we're at 5.
//   5. Return clusters ordered oldest → newest. Each cluster is an array of
//      items plus a `startTs` (first item's timestamp in the cluster).
//
// Returns [] for <2 items (no buckets needed — just "Dismiss all").
function clusterByTimeGaps(items) {
  if (!Array.isArray(items) || items.length < 2) return items.length === 0 ? [] : [{ items: items.slice(), startTs: items[0].timestamp || 0 }];
  const sorted = items.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].timestamp || 0) - (sorted[i - 1].timestamp || 0));
  }
  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const median = sortedGaps[Math.floor(sortedGaps.length / 2)] || 0;
  const THIRTY_MIN = 30 * 60 * 1000;
  const threshold = Math.max(THIRTY_MIN, median * 3);

  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (gaps[i - 1] > threshold) clusters.push([sorted[i]]);
    else clusters[clusters.length - 1].push(sorted[i]);
  }

  // Merge down to max 5 clusters by picking the smallest boundary-gaps
  const MAX_BUCKETS = 5;
  while (clusters.length > MAX_BUCKETS) {
    let smallestIdx = 0;
    let smallestGap = Infinity;
    for (let i = 1; i < clusters.length; i++) {
      const prevLast = clusters[i - 1][clusters[i - 1].length - 1];
      const currFirst = clusters[i][0];
      const gap = (currFirst.timestamp || 0) - (prevLast.timestamp || 0);
      if (gap < smallestGap) { smallestGap = gap; smallestIdx = i; }
    }
    clusters[smallestIdx - 1] = clusters[smallestIdx - 1].concat(clusters[smallestIdx]);
    clusters.splice(smallestIdx, 1);
  }

  return clusters.map(c => ({ items: c, startTs: c[0].timestamp || 0 }));
}

// Format a millisecond age as a short human-friendly threshold label.
// "2m ago", "47m ago", "3h ago", "2d ago".
function formatRelativeThreshold(ms) {
  if (ms < 60 * 1000) return 'now';
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60000)}m ago`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}

// --- Bulk actions popover (sidebar kebab) ---
let _bulkPopoverEl = null;
function closeBulkActionsPopover() {
  if (_bulkPopoverEl && _bulkPopoverEl.parentNode) _bulkPopoverEl.parentNode.removeChild(_bulkPopoverEl);
  _bulkPopoverEl = null;
  document.removeEventListener('click', _bulkPopoverOutsideClick, true);
}
function _bulkPopoverOutsideClick(e) {
  if (_bulkPopoverEl && !_bulkPopoverEl.contains(e.target)) closeBulkActionsPopover();
}
function openBulkActionsPopover(anchorEl, steward) {
  closeBulkActionsPopover();
  const items = getItemsForSteward(steward);
  const unpinned = items.filter(i => !i.pinned);
  const pinned = items.filter(i => i.pinned);
  const total = items.length;
  const canDismissCount = unpinned.length;

  const pop = document.createElement('div');
  pop.className = 'bulk-actions-popover';
  const rect = anchorEl.getBoundingClientRect();
  // Will be re-positioned after populate; see bulkPopReposition defined below.
  pop.style.top = '-9999px';
  pop.style.left = `${Math.max(8, Math.min(rect.right - 260, window.innerWidth - 268))}px`;

  const header = document.createElement('div');
  header.className = 'bulk-actions-header';
  const pinnedNote = pinned.length > 0 ? ` (📌 ${pinned.length} pinned)` : '';
  header.textContent = `${steward.name || steward.id} — ${total} card${total === 1 ? '' : 's'}${pinnedNote}`;
  pop.appendChild(header);

  const dismissAllBtn = document.createElement('button');
  dismissAllBtn.className = 'bulk-actions-btn';
  dismissAllBtn.disabled = canDismissCount === 0;
  dismissAllBtn.textContent = `Dismiss all (${canDismissCount})`;
  dismissAllBtn.addEventListener('click', async () => {
    closeBulkActionsPopover();
    if (canDismissCount === 0) return;
    const skipNote = pinned.length > 0 ? ` ${pinned.length} pinned card${pinned.length === 1 ? '' : 's'} will be skipped.` : '';
    const ok = confirm(`Dismiss ${canDismissCount} card${canDismissCount === 1 ? '' : 's'} from ${steward.name || steward.id}?${skipNote}`);
    if (!ok) return;
    // Pass ALL IDs — server filters pinned. Keeps server as source of truth.
    await bulkDismissCards(items.map(i => i.id));
  });
  pop.appendChild(dismissAllBtn);

  // Triage this bucket — fires the per-Top-Steward triage skill via walkie.
  // The Top Steward consolidates their bucket into one card; Joshua answers it.
  // Per Triage Dispatch Contract v1 §1.
  const triageBtn = document.createElement('button');
  triageBtn.className = 'bulk-actions-btn triage';
  triageBtn.disabled = total === 0;
  triageBtn.textContent = `🧮 Triage this bucket (${total})`;
  triageBtn.title = total === 0
    ? 'No cards to triage'
    : `Ask ${steward.name || steward.id} to consolidate ${total} card${total === 1 ? '' : 's'} into one card you can answer at once.`;
  triageBtn.addEventListener('click', async () => {
    closeBulkActionsPopover();
    if (total === 0) return;
    await fireTriageRequest(steward, items);
  });
  pop.appendChild(triageBtn);

  // Adaptive dismissal buckets — clusters of cards grouped by time-gap.
  // For each cluster boundary (except the newest), offer a button that
  // dismisses EVERYTHING in that cluster and all older clusters. This
  // replaces the fixed 1h/6h/24h/3d/7d ladder — "arbitrary dismissal
  // timings" Joshua complained about — with buckets tied to when cards
  // actually arrived.
  const clusters = clusterByTimeGaps(items);
  if (clusters.length > 1) {
    const olderLabel = document.createElement('div');
    olderLabel.className = 'bulk-actions-sublabel';
    olderLabel.textContent = 'Dismiss older than…';
    pop.appendChild(olderLabel);

    const stack = document.createElement('div');
    stack.className = 'bulk-actions-buckets';

    // For each cluster boundary except the newest (index 0..length-2),
    // a button dismisses clusters [0..i] inclusive. The newest cluster
    // (index length-1) doesn't get a button — those cards are fresh.
    //
    // We render oldest-first-to-newest (matching the sort order). The
    // cluster at the TOP of the list is the oldest; its button will
    // dismiss the fewest cards. The cluster just before the newest
    // dismisses the most. This ordering gives Joshua a natural "cut
    // line" — pick the point where you stop caring about stale context.
    const now = Date.now();
    for (let i = 0; i < clusters.length - 1; i++) {
      // This button dismisses clusters[0..i] inclusive. Boundary =
      // startTs of clusters[i + 1] (i.e. the next-newer cluster).
      const boundary = clusters[i + 1].startTs;
      const matching = [];
      for (let j = 0; j <= i; j++) matching.push(...clusters[j].items);
      const matchingUnpinned = matching.filter(c => !c.pinned);
      const ageMs = now - boundary;

      const btn = document.createElement('button');
      btn.className = 'bulk-actions-btn threshold';
      btn.disabled = matchingUnpinned.length === 0;
      btn.textContent = `${formatRelativeThreshold(ageMs)} (${matchingUnpinned.length})`;
      btn.title = `Dismiss ${matchingUnpinned.length} card${matchingUnpinned.length === 1 ? '' : 's'} older than ${new Date(boundary).toLocaleString()}`;
      btn.addEventListener('click', async () => {
        closeBulkActionsPopover();
        if (matchingUnpinned.length === 0) return;
        const pinnedMatches = matching.length - matchingUnpinned.length;
        const skipNote = pinnedMatches > 0 ? ` ${pinnedMatches} pinned card${pinnedMatches === 1 ? '' : 's'} in this range will be skipped.` : '';
        const ok = confirm(`Dismiss ${matchingUnpinned.length} card${matchingUnpinned.length === 1 ? '' : 's'} from ${steward.name || steward.id} older than ${formatRelativeThreshold(ageMs)}?${skipNote}`);
        if (!ok) return;
        await bulkDismissCards(matching.map(c => c.id));
      });
      stack.appendChild(btn);
    }
    pop.appendChild(stack);
  }

  document.body.appendChild(pop);
  _bulkPopoverEl = pop;
  // Position above/below anchor based on available viewport room. Needed
  // for bottom-bar 🧹 trigger where the anchor sits at the bottom edge
  // — placing BELOW would run off-screen.
  const reposition = () => {
    const popH = pop.offsetHeight || 0;
    const vh = window.innerHeight;
    const wouldOverflow = rect.bottom + 4 + popH > vh - 8;
    if (wouldOverflow) {
      pop.style.top = `${Math.max(8, rect.top - popH - 4)}px`;
    } else {
      pop.style.top = `${rect.bottom + 4}px`;
    }
  };
  setTimeout(reposition, 0);
  requestAnimationFrame(reposition);
  // Defer so the triggering click doesn't immediately close the popover
  setTimeout(() => document.addEventListener('click', _bulkPopoverOutsideClick, true), 0);
}

// Lightweight info toast (success / informational). Reuses error-toast styling
// but with `info` modifier class so CSS can tone it down. No retry button.
function showInfoToast(message) {
  let toast = document.getElementById('error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'error-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = '';
  toast.classList.add('info');
  const msgSpan = document.createElement('span');
  msgSpan.className = 'error-toast-msg';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'error-toast-dismiss';
  dismissBtn.textContent = '✕';
  dismissBtn.addEventListener('click', () => {
    toast.classList.remove('visible');
    toast.classList.remove('info');
  });
  toast.appendChild(dismissBtn);
  toast.classList.add('visible');
  setTimeout(() => {
    toast.classList.remove('visible');
    toast.classList.remove('info');
  }, 6000);
}

// Fire a triage request at the Top Steward owning this bucket.
// Builds the locked envelope from Triage Dispatch Contract v1 §1 and
// enqueues it on the walkie-talkie queue targeted at `holler-${steward.id}`.
//
// queue_snapshot carries the FULL message body per card (NOT excerpted) and
// ALWAYS includes a `pinned` field per card (pinned-card guard, contract §3.1).
async function fireTriageRequest(steward, items) {
  if (!steward || !items || items.length === 0) return;

  const target = `holler-${steward.id}`;
  const triageSession = `triage-${steward.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Source filter glob: own-domain. e.g. "homestead*" matches homestead,
  // homestead--scribe, homestead--foreman--worker, etc.
  const sourceFilter = `${steward.id}*`;

  const now = Date.now();
  const queueSnapshot = items.map(item => {
    const ageHours = item.timestamp ? (now - item.timestamp) / 3600000 : 0;
    return {
      id: item.id,
      title: item.title || '',
      source: item.session_id || '',
      callback_session: item.callback_session || item.session_id || '',
      timestamp: item.timestamp || null,
      age_hours: Math.round(ageHours * 10) / 10,
      pinned: !!item.pinned,                          // contract §1: ALWAYS present
      message: item.message || '',                     // contract §1: FULL body
      buttons: item.buttons || null,
      input: item.input || false,
      category: item.category || null,
      component: item.component || null,
      componentProps: item.componentProps || null,
    };
  });

  const envelope = {
    type: 'action',
    trigger: 'triage_request',
    source_filter: sourceFilter,
    queue_snapshot: queueSnapshot,
    triage_session: triageSession,
  };

  // Confirm with Joshua before firing — this wakes the Top Steward and
  // consumes their tokens. Cheap to pause for a confirm; expensive to fire
  // by accident.
  const ok = confirm(`Trigger triage on ${steward.name || steward.id}?\n\n${items.length} card${items.length === 1 ? '' : 's'} will be sent to ${target} for consolidation.`);
  if (!ok) return;

  try {
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    const res = await fetch(`${SERVER_URL}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_session: target,
        message_override: JSON.stringify(envelope),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[Presenter] triage enqueue failed:', err);
      showErrorToast(`Triage failed: ${res.status}`);
      return;
    }
    showInfoToast(`Triage requested — ${target} (${items.length} card${items.length === 1 ? '' : 's'})`);
    console.log(`[Presenter] triage_session=${triageSession} target=${target} cards=${items.length}`);
  } catch (err) {
    console.error('[Presenter] triage enqueue error:', err);
    showErrorToast(`Triage error: ${err.message}`);
  }
}

async function bulkDismissCards(ids) {
  if (!ids || ids.length === 0) return;
  try {
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    const res = await fetch(`${SERVER_URL}/api/presenter/bulk-dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[Presenter] bulk-dismiss failed:', err);
      showErrorToast(`Bulk dismiss failed: ${res.status}`);
      return;
    }
    // If any cards were skipped due to pin, log it (queue refresh via socket
    // takes care of the UI; no extra toast needed — the confirm modal already
    // told Joshua pinned cards would be skipped).
    try {
      const result = await res.json();
      if (result && Array.isArray(result.skippedPinned) && result.skippedPinned.length > 0) {
        console.log(`[Presenter] bulk-dismiss: ${result.dismissed.length} dismissed, ${result.skippedPinned.length} pinned skipped`);
      }
    } catch {}
    // Queue refresh happens via `presenter:bulk-resolved` socket event
  } catch (err) {
    console.error('[Presenter] bulk-dismiss error:', err);
    showErrorToast(`Bulk dismiss error: ${err.message}`);
  }
}

function getUnreadCountForSteward(steward) {
  const items = getItemsForSteward(steward);
  return items.filter(item => !readState[item.id]).length;
}

// --- Fetch stewards ---

async function fetchStewards() {
  try {
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    const res = await fetch(`${SERVER_URL}/api/stewards`);
    const data = await res.json();
    stewards = data.stewards || [];
    renderSidebar();
  } catch (err) {
    console.error('[Presenter] fetchStewards failed:', err);
  }
}

async function fetchSessionStatuses() {
  try {
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    const res = await fetch(`${SERVER_URL}/api/session-status`);
    const data = await res.json();
    if (data && data.statuses) {
      sessionStatuses = data.statuses;
      renderSidebar();
      // Keep the embedded phone bars in sync — the worker subbar shows each
      // worker's live status dot AND its last-status-update time, both of
      // which come from sessionStatuses. Without this the subbar would freeze
      // at whatever it rendered on steward-select.
      if (document.body.classList.contains('embedded') && typeof renderEmbeddedTopbar === 'function') {
        renderEmbeddedTopbar();
      }
      if (window._stewint && window._stewint.refresh) window._stewint.refresh();
    }
  } catch {}
}

// Per-worker AHEAD-only git diff (Josh 2026-08-07): fetch the "work not yet in
// main" numbers for the workers currently visible under the selected steward.
// BATCHED into one POST so many workers cost one request. Runs on a relaxed
// cadence (the diff only changes when a worker commits) and the server caches
// per-session, so this is cheap. Only fetches the CURRENT steward's workers to
// keep the batch small.
async function fetchWorkerGitDiffs() {
  try {
    if (!document.body.classList.contains('embedded')) return;
    if (!selectedSteward) return;
    const parentSteward = stewards.find(s => getSessionIdsForSteward(s).includes(selectedSteward));
    const workers = (parentSteward && (parentSteward.workers || parentSteward.substewards)) || [];
    if (!parentSteward || workers.length === 0) return;
    const sessions = workers.map(sub => sub.sessionName || `holler-${parentSteward.id}--${sub.id}`);
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    const res = await fetch(`${SERVER_URL}/api/worker-git-diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessions }),
    });
    const data = await res.json();
    if (data && data.diffs) {
      // Merge (not replace) so a worker not in this batch keeps its last value.
      Object.assign(workerGitDiffs, data.diffs);
      if (typeof renderEmbeddedSubbar === 'function') renderEmbeddedSubbar();
    }
  } catch {}
}

// --- Per-session context dashboard (% of 1M used, time since last /clear) ---
function collectAllSessionNames() {
  const names = new Set();
  for (const s of stewards) {
    names.add(`holler-${s.id}`);
    if (s.substewards) {
      for (const sub of s.substewards) {
        names.add(`holler-${s.id}--${sub.id}`);
        if (sub.substewards) {
          for (const ss of sub.substewards) names.add(`holler-${s.id}--${sub.id}--${ss.id}`);
        }
      }
    }
  }
  return [...names];
}

async function fetchSessionContext() {
  const names = collectAllSessionNames();
  if (names.length === 0) return;
  try {
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    const res = await fetch(`${SERVER_URL}/api/session-context?sessions=${encodeURIComponent(names.join(','))}`);
    const data = await res.json();
    const map = {};
    for (const row of (data.sessions || [])) map[row.session] = row;
    sessionContext = map;
    renderSidebar();
    if (document.body.classList.contains('embedded') && typeof renderEmbeddedTopbar === 'function') {
      renderEmbeddedTopbar();
    }
  } catch (err) {
    console.error('[Presenter] fetchSessionContext failed:', err);
  }
}

function buildContextBar(sessionName) {
  const ctx = sessionContext[sessionName];
  if (!ctx) return null;
  // Don't render anything if we truly have no data — keeps old/unlaunched
  // sessions from getting a "0%" bar that implies we measured them.
  if (ctx.tokens === 0) return null;

  const wrap = document.createElement('div');
  wrap.className = 'steward-context-bar';

  const fill = document.createElement('div');
  fill.className = 'steward-context-fill';
  const pct = Math.min(100, Math.max(0, ctx.pct || 0));
  fill.style.width = `${pct.toFixed(1)}%`;
  // Color ramp: green → amber → red
  if (pct >= 80) fill.classList.add('danger');
  else if (pct >= 50) fill.classList.add('warn');
  wrap.appendChild(fill);

  const meta = document.createElement('div');
  meta.className = 'steward-context-meta';
  meta.textContent = `${pct.toFixed(0)}%`;
  wrap.appendChild(meta);

  wrap.title = `${ctx.tokens.toLocaleString()} tokens / 1M`;
  return wrap;
}

function buildSessionKebab(sessionName, displayName, stewardForBulk) {
  const kebab = document.createElement('span');
  kebab.className = 'steward-kebab session-kebab';
  kebab.textContent = '⋯';
  kebab.title = 'Session menu';
  kebab.addEventListener('click', (e) => {
    e.stopPropagation();
    openSessionMenu(kebab, sessionName, displayName, stewardForBulk);
  });
  return kebab;
}

let _sessionMenuEl = null;
function closeSessionMenu() {
  if (_sessionMenuEl && _sessionMenuEl.parentNode) _sessionMenuEl.parentNode.removeChild(_sessionMenuEl);
  _sessionMenuEl = null;
  document.removeEventListener('click', _sessionMenuOutsideClick, true);
}
function _sessionMenuOutsideClick(e) {
  if (_sessionMenuEl && !_sessionMenuEl.contains(e.target)) closeSessionMenu();
}
function openSessionMenu(anchorEl, sessionName, displayName, stewardForBulk) {
  closeSessionMenu();
  const pop = document.createElement('div');
  pop.className = 'bulk-actions-popover';
  const rect = anchorEl.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 4}px`;
  pop.style.left = `${Math.max(8, rect.right - 260)}px`;

  const header = document.createElement('div');
  header.className = 'bulk-actions-header';
  header.textContent = displayName;
  pop.appendChild(header);

  // Context summary
  const ctx = sessionContext[sessionName];
  if (ctx && ctx.tokens > 0) {
    const ctxLine = document.createElement('div');
    ctxLine.className = 'bulk-actions-sublabel';
    const pct = Math.min(100, Math.max(0, ctx.pct || 0));
    ctxLine.textContent = `Context: ${pct.toFixed(0)}%`;
    pop.appendChild(ctxLine);
  }

  // Bulk-dismiss section (reuse existing popover logic if this session has cards)
  if (stewardForBulk) {
    const items = getItemsForSteward(stewardForBulk);
    if (items.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'bulk-actions-sublabel';
      sep.textContent = 'Cards';
      pop.appendChild(sep);
      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'bulk-actions-btn';
      const unpinned = items.filter(i => !i.pinned);
      dismissBtn.disabled = unpinned.length === 0;
      dismissBtn.textContent = `Bulk actions (${items.length})…`;
      dismissBtn.addEventListener('click', () => {
        closeSessionMenu();
        openBulkActionsPopover(anchorEl, stewardForBulk);
      });
      pop.appendChild(dismissBtn);
    }
  }

  document.body.appendChild(pop);
  _sessionMenuEl = pop;
  setTimeout(() => document.addEventListener('click', _sessionMenuOutsideClick, true), 0);
}

// --- Fetch history ---

async function fetchHistory(sessionId, forceRefresh) {
  if (!forceRefresh && historyCache[sessionId] && historyCache[sessionId].length > 0) return historyCache[sessionId];
  try {
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    const res = await fetch(`${SERVER_URL}/api/presenter/history/${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    historyCache[sessionId] = Array.isArray(data) ? data : [];
    return historyCache[sessionId];
  } catch {
    historyCache[sessionId] = [];
    return [];
  }
}

// --- Fetch chat messages for builds/substewards ---

async function fetchChatMessages(sessionId) {
  try {
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    // Use fast direct file reader (bypasses Next.js, responds in ms)
    const res = await fetch(`${SERVER_URL}/api/fast-chat/${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    const msgs = Array.isArray(data) ? data : data.messages || [];
    chatCache[sessionId] = msgs;
    return msgs;
  } catch {
    chatCache[sessionId] = [];
    return [];
  }
}

// --- Embedded topbar rendering ---
const embeddedTopbar = document.getElementById('embedded-topbar');

// ============================================================
// ENGINE DASHBOARD — the instrument panel in the steward row
// ============================================================
// Josh 2026-09-12: "it might be kind of nice just to switch it so it's
// actually like a literal dashboard almost in the sense that like lights
// turn on ... instead of a number, it should almost like show up as like
// a temperature gauge. That way it looks like a literal engine ... and we
// just kind of create this little dashboard of like icons that we're
// watching for and they can be like clickable and you can go diagnose ...
// each one has its own flow instead of this two-dot system, it's kinda
// dorky."
//
// WHAT THIS REPLACES: one dot (#ctrl-cpu-pill) that carried two unrelated
// meanings — red "machine is hot" and amber "something is down" — and
// opened whichever of two modals it felt like. Josh could not tell which
// meaning was on screen without tapping. Now each signal owns its own
// instrument and its own tap.
//
// WHAT IT READS: nothing new. Both feeds already exist and are unchanged —
// /api/machine-stats (CPU) and /api/health-checks (per-check state). This
// module is presentation plus routing; the modals it opens are the ones
// that were already there, addressed per-check instead of shared.
//
// CADENCE: Josh — "it wouldn't have to be like very often, maybe like once
// a minute it would update or something." The panel is decorative-adjacent
// and lives on his phone, so it polls at 60s, not the old 10s/30s. A
// header that repaints constantly costs battery for no benefit. Opening
// the stat sheet still pulls fresh detail on demand.
function initEnginePanel() {
  if (!document.body.classList.contains('embedded')) return null;
  if (window.__enginePanel) return window.__enginePanel;

  var state = {
    ms: null,        // latest /api/machine-stats
    health: null,    // latest /api/health-checks
  };

  // ---- the gauge ----------------------------------------------------
  // Josh 2026-09-15: "i need to see an actual red like i need to see where
  // the red actually is at ... lean into the aesthetic brother i'm not
  // looking for you to pussyfoot around here anymore."
  //
  // So this is drawn as a real vintage instrument rather than a suggestion of
  // one: a printed dial face with a PAINTED RED BAND that is always visible
  // whatever the needle is doing, a chapter ring of graduated ticks, a
  // counterweighted needle, and a domed-glass highlight over the top.
  //
  // THE RED BAND IS THE POINT. The previous version marked the hot zone by
  // tinting two tick marks #6b3b2e — a brown so dark it read as "slightly
  // dirtier tick" and told Josh nothing about where danger starts. A gauge
  // whose danger zone you cannot locate at a glance is not a gauge, it is a
  // decoration. The band is now a filled arc segment, drawn UNDER the ticks so
  // the graduations stay crisp on top of it, spanning exactly the fraction of
  // the sweep that engineHeat() grades as 'high'.
  //
  // The sweep deliberately stops SHORT of horizontal at both ends. A needle
  // lying flat at 90° visually merges with the bezel edge and stops reading as
  // a needle at all — which is exactly the moment (pegged, engine hot) it most
  // needs to be unmistakable.
  var GAUGE_MIN_DEG = -76;   // cold
  var GAUGE_MAX_DEG = 76;    // pegged
  // Where the red band starts, as a fraction of the sweep. This is NOT a free
  // aesthetic choice — it must equal the point engineHeat() starts returning
  // key 'high', or the paint and the verdict disagree and the dial lies. See
  // engineHeat(): 'high' begins at cpu 85% (frac .85) or load 2x cores
  // (frac 1.0); .85 is the earlier of the two, so that is where red begins.
  var GAUGE_RED_FROM = 0.85;

  // Geometry, named once so the face, the band, the ticks and the needle can
  // never drift apart.
  var G = { cx: 30, cy: 31, r: 26 };

  function gaugePt(frac, radius) {
    var a = (GAUGE_MIN_DEG + frac * (GAUGE_MAX_DEG - GAUGE_MIN_DEG)) * Math.PI / 180;
    return {
      x: G.cx + Math.sin(a) * radius,
      y: G.cy - Math.cos(a) * radius,
    };
  }

  // An ARC between two sweep fractions — the red band, and the cool stretch
  // before it. Drawn as a single stroked path rather than a filled wedge: a
  // wedge is a SURFACE, and a surface hides whatever is behind the panel,
  // which is the thing Josh asked to get back.
  function gaugeBand(fromFrac, toFrac, radius, cls) {
    var p1 = gaugePt(fromFrac, radius), p2 = gaugePt(toFrac, radius);
    return '<path class="' + cls + '" d="'
      + 'M' + p1.x.toFixed(2) + ' ' + p1.y.toFixed(2)
      + ' A' + radius + ' ' + radius + ' 0 0 1 ' + p2.x.toFixed(2) + ' ' + p2.y.toFixed(2)
      + '"/>';
  }

  function gaugeSvg() {
    // 19 graduations: majors every 6th, so the dial reads as a printed
    // chapter ring rather than a handful of scratches.
    var STEPS = 18;
    var ticks = '';
    for (var i = 0; i <= STEPS; i++) {
      var f = i / STEPS;
      var major = (i % 6 === 0);
      var outer = G.r - 2.5;
      var inner = outer - (major ? 6 : 3.2);
      var a = gaugePt(f, outer), b = gaugePt(f, inner);
      var hot = f >= GAUGE_RED_FROM - 0.001;
      ticks += '<line class="eg-tick' + (major ? ' eg-tick-major' : '')
        + (hot ? ' eg-tick-hot' : '') + '" x1="' + a.x.toFixed(2) + '" y1="' + a.y.toFixed(2)
        + '" x2="' + b.x.toFixed(2) + '" y2="' + b.y.toFixed(2) + '"/>';
    }

    // The cool stretch gets a faint band too, so the red reads as one zone on a
    // SCALE rather than a lone blob floating on black.
    var coolBand = gaugeBand(0, GAUGE_RED_FROM, G.r - 4.6, 'eg-band-cool');
    var redBand  = gaugeBand(GAUGE_RED_FROM, 1, G.r - 4.6, 'eg-band-hot');

    return '<svg viewBox="0 0 60 44" aria-hidden="true">'
      // WIREFRAME — Josh 2026-09-15: "I need to be able to see the icon behind
      // it still ... it could almost be more like a wireframe of what it is
      // right now ... more wireframe-y instead of as opaque."
      //
      // So there are NO FILLED SURFACES here. The previous version drew a solid
      // dial face, a filled bezel and a glass sheen, which is what made the
      // steading emoji disappear behind the instrument. Everything is now a
      // STROKE: the dial reads as drawn lines over whatever is behind it, and
      // the only fills left are the tiny needle and pivot, which have to be
      // solid to read as a pointer at all.
      //
      // The red band survives this change because it was never carrying the
      // hot zone by OPACITY — it carries it by being red and by WHERE it sits.
      // As a thick stroked arc it is just as locatable and no longer hides
      // anything.
      + '<path class="eg-bezel" d="M' + (G.cx - G.r - 2) + ' ' + G.cy
      +   ' a' + (G.r + 2) + ' ' + (G.r + 2) + ' 0 0 1 ' + ((G.r + 2) * 2) + ' 0"/>'
      + coolBand
      + redBand
      + ticks
      + '<text class="eg-hot-label" x="' + gaugePt(0.90, G.r - 14.5).x.toFixed(1)
      +   '" y="' + gaugePt(0.90, G.r - 14.5).y.toFixed(1)
      +   '" text-anchor="middle">HOT</text>'
      // Needle: a tapered blade plus a counterweight stub behind the pivot,
      // which is the detail that makes a drawn needle read as a real one.
      // These stay FILLED — a hollow needle is not a needle.
      + '<g class="engine-needle">'
      +   '<path class="eg-needle-blade" d="M' + G.cx + ' ' + (G.cy - G.r + 8.5)
      +     ' L' + (G.cx + 1.7) + ' ' + (G.cy - 2) + ' L' + (G.cx - 1.7) + ' ' + (G.cy - 2) + ' Z"/>'
      +   '<rect class="eg-needle-tail" x="' + (G.cx - 1.25) + '" y="' + (G.cy - 0.5)
      +     '" width="2.5" height="5.5" rx="1.25"/>'
      + '</g>'
      + '<circle class="eg-pivot" cx="' + G.cx + '" cy="' + G.cy + '" r="2.9"/>'
      + '<circle class="eg-pivot-cap" cx="' + G.cx + '" cy="' + G.cy + '" r="1.15"/>'
      + '<text class="eg-legend" x="' + G.cx + '" y="' + (G.cy + 10) + '" text-anchor="middle">TEMP</text>'
      + '</svg>';
  }

  // How hot is the engine, 0..1, and WHY.
  //
  // Grading follows msSeverity's hard-won rule (see its comment block):
  // CPU% and load live on DIFFERENT SCALES and must never be max()'d
  // together raw. CPU is a share of capacity (0-100); load is queue depth
  // against cores and routinely exceeds 1.0x. Each is normalised on its
  // OWN scale first, the hotter one drives the needle, and we return which
  // one it was — because a needle position Josh can't trace back to a
  // number he can see is exactly the bug that block documents.
  function engineHeat(s) {
    if (!s || !s.cpu || s.cpu.total == null) {
      return { frac: 0, key: 'unknown', driver: null, label: 'Checking…' };
    }
    var cpuPct = s.cpu.total;
    var cpuFrac = Math.max(0, Math.min(1, cpuPct / 100));

    var cores = s.cores || 1;
    var loadX = s.load ? (s.load.one / cores) : 0;
    // 2.0x cores = pegged. Same threshold msSeverity calls rank 2.
    var loadFrac = Math.max(0, Math.min(1, loadX / 2));

    var frac, driver, label;
    if (loadFrac > cpuFrac) {
      frac = loadFrac;
      driver = 'load';
      label = 'work queued ' + loadX.toFixed(1) + '× deeper than the ' + cores + ' cores';
    } else {
      frac = cpuFrac;
      driver = 'cpu';
      label = 'processor at ' + Math.round(cpuPct) + '%';
    }
    // Bands match msSeverity so the gauge and the sheet never disagree.
    var key = (cpuPct >= 85 || loadX >= 2) ? 'high'
            : (cpuPct >= 55 || loadX >= 1) ? 'mid'
            : 'low';
    return { frac: frac, key: key, driver: driver, label: label, cpuPct: cpuPct, loadX: loadX, cores: cores };
  }

  // ---- lamp glyphs ---------------------------------------------------
  // Inline SVG, currentColor-driven, so illumination is one CSS property.
  // Each watched check gets a glyph that says WHAT it watches at a glance —
  // that is the whole point of an icon panel over an anonymous dot.
  var LAMP_GLYPHS = {
    // phone with signal arcs — wireless debugging
    'adb-wireless': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="10" height="18" rx="2"/><path d="M7.5 18h3"/><path d="M17.5 8.5a5 5 0 0 1 0 7"/><path d="M20.5 6a9 9 0 0 1 0 12"/></svg>',
    // a bell — phone notifications. Drawn as an outline like the others so it
    // reads as one instrument family rather than a pasted-in icon.
    'phone-notifications': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    _default: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
  };
  function lampGlyph(id) { return LAMP_GLYPHS[id] || LAMP_GLYPHS._default; }

  // ---- how a lamp reads its own state ---------------------------------
  // Josh 2026-09-15: "when i click it again it's still on it still looks on
  // ... so it doesn't — i don't know, the on off state is hard for me to
  // read."
  //
  // THE OLD READ WAS GENUINELY AMBIGUOUS, and not by a little. There were two
  // rendered states: dark, and amber. Dark carried BOTH "this is healthy" and
  // "we can't tell" — and on a physical panel a dark bulb overwhelmingly reads
  // as OFF/DEAD, which is the exact opposite of what dark meant here. So the
  // healthy case looked like the broken case, and the only way to resolve it
  // was to tap through and read a sentence. That is the bug.
  //
  // THE FIX IS TO STOP OVERLOADING DARKNESS. Three states, three unmistakably
  // different appearances, each carrying its own colour AND its own word:
  //
  //   ok      -> GREEN lit + plate reads ON     (working — this is good)
  //   down    -> RED lit, flashing + plate OFF  (broken — this needs you)
  //   unknown -> grey, unlit  + plate reads ??  (we genuinely cannot tell)
  //
  // Green-for-good is a deliberate departure from the old "no new accent hue"
  // rule in the panel's design comment. That rule existed to stop decorative
  // colour creeping in; here colour is doing the primary semantic work Josh
  // asked for, and a panel that can only express alarm cannot express
  // all-clear. The gauge already sweeps green->amber->red, so the hue is
  // already in this instrument's vocabulary rather than invented for the lamp.
  //
  // `unknown` still does NOT raise an alarm — it is grey, not red. That
  // anti-cry-wolf guard predates this panel and is why the light is worth
  // trusting: the phone being off the home network is not a fault.
  function lampState(c) {
    if (!c) return { key: 'unknown', plate: '··' };
    if (c.state === 'down') return { key: 'off', plate: 'OFF' };
    if (c.state === 'unknown') return { key: 'unknown', plate: '··' };
    return { key: 'on', plate: 'ON' };
  }

  // ---- build a panel --------------------------------------------------
  // A FRESH node per card. The panel hangs on the card frame now, and the deck
  // rebuilds cards as Josh swipes — one shared element would be re-parented to
  // the newest card by appendChild and vanish from the others. State and
  // polling stay single-source below; only the DOM is per-card.
  var mounted = [];   // live panel nodes, pruned as cards are discarded

  function buildPanel() {
    var panel = document.createElement('div');
    panel.className = 'engine-panel';

    var gaugeBtn = document.createElement('button');
    gaugeBtn.className = 'engine-gauge';
    gaugeBtn.innerHTML = gaugeSvg();
    gaugeBtn.title = 'Engine temperature';
    gaugeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openGaugeSheet();
    });
    panel.appendChild(gaugeBtn);

    var lampWrap = document.createElement('div');
    lampWrap.className = 'engine-lamps';
    panel.appendChild(lampWrap);

    mounted.push(panel);
    // Drop nodes whose card is gone, so this can't grow without bound.
    if (mounted.length > 12) {
      mounted = mounted.filter(function (n) { return n.isConnected; });
    }
    renderPanel(panel);
    return panel;
  }

  // ---- rendering ------------------------------------------------------
  function renderGauge(panel) {
    var gaugeBtn = panel.querySelector('.engine-gauge');
    if (!gaugeBtn) return;
    var heat = engineHeat(state.ms);
    var needle = gaugeBtn.querySelector('.engine-needle');
    if (needle) {
      var deg = GAUGE_MIN_DEG + heat.frac * (GAUGE_MAX_DEG - GAUGE_MIN_DEG);
      needle.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)';
    }
    gaugeBtn.classList.remove('heat-low', 'heat-mid', 'heat-high', 'heat-unknown');
    gaugeBtn.classList.add('heat-' + heat.key);
    gaugeBtn.title = heat.key === 'unknown'
      ? 'Engine temperature — checking…'
      : 'Engine temperature — ' + heat.label + ' (tap for detail)';
  }

  // A lamp exists for every check the server reports, whatever its state —
  // the panel must read as a PANEL when nothing is wrong, so a healthy lamp is
  // a lit green bulb, never an absent one.
  //
  // Each lamp is a bulb plus an engraved STATUS PLATE beneath it reading
  // ON / OFF / ·· — belt and braces on purpose. Colour alone fails anyone who
  // reads red-green poorly, and at this size on a phone the word is often the
  // faster read anyway. See lampState() for why darkness stopped meaning
  // "healthy".
  function renderLamps(panel) {
    var lampWrap = panel.querySelector('.engine-lamps');
    if (!lampWrap) return;
    var checks = (state.health && state.health.checks) || [];
    // Rebuild only when the set of check ids changes; otherwise just
    // re-apply state, so a lit lamp's flicker doesn't restart every poll.
    var ids = checks.map(function (c) { return c.id; }).join('|');
    if (lampWrap.getAttribute('data-ids') !== ids) {
      lampWrap.setAttribute('data-ids', ids);
      lampWrap.innerHTML = '';
      checks.forEach(function (c) {
        var lamp = document.createElement('button');
        lamp.className = 'engine-lamp';
        lamp.setAttribute('data-check', c.id);
        lamp.innerHTML = '<span class="el-bulb">' + lampGlyph(c.id) + '</span>'
          + '<span class="el-plate"></span>';
        lamp.addEventListener('click', function (e) {
          e.stopPropagation();
          openCheckSheet(c.id);
        });
        lampWrap.appendChild(lamp);
      });
    }
    checks.forEach(function (c) {
      var lamp = lampWrap.querySelector('[data-check="' + c.id + '"]');
      if (!lamp) return;
      var st = lampState(c);
      lamp.classList.remove('is-on', 'is-off', 'is-unknown');
      lamp.classList.add('is-' + st.key);
      var plate = lamp.querySelector('.el-plate');
      if (plate) plate.textContent = st.plate;
      lamp.title = c.title + ' — ' + (
        c.state === 'down' ? (c.summary || 'is down') :
        c.state === 'unknown' ? "can't tell right now" :
        'all good'
      );
    });
  }

  function renderPanel(panel) {
    // Until the first poll lands there is nothing truthful to show: no checks
    // means no lamps, and a needle at rest reads as "all cool". On a machine
    // where something IS down that is a false all-clear, and cards are rebuilt
    // constantly as Josh swipes, so this path is common rather than rare.
    // Stay hidden rather than assert a state we do not have yet.
    var ready = !!(state.ms || state.health);
    panel.style.visibility = ready ? 'visible' : 'hidden';
    if (!ready) return;
    renderGauge(panel);
    renderLamps(panel);
  }

  // Paint every panel currently on screen.
  function render() {
    mounted = mounted.filter(function (n) { return n.isConnected; });
    mounted.forEach(renderPanel);
  }

  // ---- each instrument's own flow -------------------------------------
  // Josh: "each one has its own flow instead of this two-dot system."
  //
  // The gauge opens the machine stat sheet. A lamp opens the health sheet
  // FOCUSED ON THAT ONE CHECK — not the shared list. Both sheets already
  // existed; what changes is that the tap target now determines which one
  // you get, deterministically, instead of a single dot guessing.
  function openGaugeSheet() {
    if (window.__openMachineSheet) window.__openMachineSheet();
  }
  function openCheckSheet(id) {
    if (window.__openHealthModal) window.__openHealthModal(id);
  }
  // ---- polling --------------------------------------------------------
  // 60s, per Josh's "maybe like once a minute". Never pulls history in the
  // background — the stat sheet asks for that itself when it opens.
  async function pollStats() {
    try {
      var res = await fetch('/api/machine-stats?history=0');
      if (res.ok) state.ms = await res.json();
    } catch (e) { /* keep the last reading up; never invent a temperature */ }
    render();
  }
  async function pollHealth() {
    try {
      var res = await fetch('/api/health-checks');
      if (res.ok) state.health = await res.json();
    } catch (e) { /* keep last-known lamp states; never invent an alarm */ }
    render();
  }
  // Returns a promise so a caller that awaits it actually gets fresh state
  // rather than reading a half-finished fetch.
  function pollAll() { return Promise.all([pollStats(), pollHealth()]); }

  pollAll();
  setInterval(pollAll, 60000);

  var api = {
    // A NEW node each call — one per card (see buildPanel).
    get el() { return buildPanel(); },
    build: buildPanel,
    render: render,
    refresh: pollAll,
    // Exposed so the legacy sheets can push fresh payloads in without a
    // second network round-trip when they poll on their own.
    setStats: function (ms) { state.ms = ms; render(); },
    setHealth: function (h) { state.health = h; render(); },
  };
  window.__enginePanel = api;
  return api;
}

function renderEmbeddedTopbar() {
  if (!document.body.classList.contains('embedded') || !embeddedTopbar) return;

  embeddedTopbar.innerHTML = '';

  stewards.forEach(steward => {
    const items = getItemsForSteward(steward);
    const unread = getUnreadCountForSteward(steward);
    const primarySessionId = `holler-${steward.id}`;
    // Josh 2026-08-27: in TIMELINE mode NOTHING in the steward row lights up —
    // only the play button is the in-mode indicator. Force every steward cell
    // dark (no `.active`, no `.level-own`) while `selectedViewMode==='timeline'`.
    const inTimeline = selectedViewMode === 'timeline';
    const isActive = !inTimeline && selectedSteward && getSessionIdsForSteward(steward).includes(selectedSteward);
    // Is THIS steward's OWN primary session the current selection (vs one of its
    // workers)? Only then does the two-level 'all'/'own' indicator apply.
    const isOwnPrimarySelected = selectedSteward === primarySessionId && selectedViewMode === 'presenter';
    const isOwnLevel = isOwnPrimarySelected && stewardCardLevel === 'own';

    const cell = document.createElement('div');
    // `.level-own` (drives a distinct visual so Josh can see he's drilled into
    // JUST this steward's own cards); default active state = 'all' (own+workers).
    cell.className = 'topbar-icon' + (isActive ? ' active' : '') + (isOwnLevel ? ' level-own' : '');
    if (isActive && steward.color) {
      cell.style.borderBottomColor = steward.color;
    }
    cell.addEventListener('click', () => {
      selectedViewMode = 'presenter';
      // Two-level toggle (Josh 2026-08-25): tapping a steward that is ALREADY
      // the active selection toggles between 'all' (own + workers, mixed
      // chronological) and 'own' (just this steward's own cards). Tapping a
      // DIFFERENT steward (or coming from a worker/timeline) selects fresh at
      // the 'all' level. `isActive` is computed above against this steward's
      // session ids — but a worker of this steward being selected also makes
      // it active, so gate the toggle on the OWN primary session specifically.
      const isSameStewardPrimary = selectedSteward === primarySessionId;
      if (isSameStewardPrimary) {
        stewardCardLevel = (stewardCardLevel === 'all') ? 'own' : 'all';
        // Selection is unchanged — just re-render the deck + topbar indicator.
        renderView();
        renderEmbeddedTopbar();
      } else {
        stewardCardLevel = 'all';
        selectSteward(primarySessionId);
      }
    });
    attachIconContextMenu(cell, primarySessionId);

    // Recency/frequency ring — faint 30-segment ring showing how much of Josh's
    // last-30 walkie sends went to this steward. Rendered UNDER the emoji so the
    // icon reads first. Only paints segments if this steward has any recent sends.
    if (recencyRing.counts && recencyRing.counts[steward.id]) {
      cell.appendChild(buildRecencyRingSvg(steward.id, steward.color));
    }

    // Emoji
    const emoji = document.createElement('span');
    emoji.className = 'topbar-emoji';
    emoji.textContent = steward.icon || steward.shorthand || steward.name.charAt(0);
    cell.appendChild(emoji);

    // Status dot — steward's OWN session only
    const ownSessionId = `holler-${steward.id}`;
    const ownStatus = sessionStatuses[ownSessionId];
    const dot = document.createElement('span');
    dot.className = 'topbar-status';
    if (ownStatus && ownStatus.status === 'working') {
      dot.style.background = '#FFCC00';
      dot.style.animation = 'pulse 1s ease-in-out infinite';
    } else if (ownStatus && (ownStatus.status === 'waiting' || ownStatus.status === 'idle')) {
      dot.style.background = '#00FF66';
    } else {
      dot.style.background = '#444';
    }
    cell.appendChild(dot);

    // Asleep overlay — top-middle 💤 when steward is intentionally sleeping
    // (in watchdog disallowed_sessions list AND no live tmux session).
    // Live session wins (just-woken renders normal). Source-of-truth for sleep
    // intent is watchdog watchlist.json `disallowed_sessions`, threaded through
    // /api/stewards as steward.watchlistDisallowed (server-side wiring TODO —
    // currently unwired so this overlay never renders). Schema locked
    // 2026-05-18 (plan-node /36).
    const isAsleep = !ownStatus && steward.watchlistDisallowed === true;
    if (isAsleep) {
      const zzz = document.createElement('span');
      zzz.className = 'topbar-asleep';
      zzz.textContent = '💤';
      zzz.title = 'Sleeping';
      cell.appendChild(zzz);
    }

    // Substeward activity ring — shows if ANY substeward OR sub-sub-steward
    // is working. Josh R14+ 2026-04-21: ring propagation extends one level
    // deeper so sub-sub activity bubbles up to the top-level steward icon.
    if (steward.substewards && steward.substewards.length > 0) {
      let anyDescendantWorking = false;
      for (const sub of steward.substewards) {
        const subSid = sub.sessionName || `holler-${steward.id}--${sub.id}`;
        const subStatusCheck = sessionStatuses[subSid];
        if (subStatusCheck && subStatusCheck.status === 'working') {
          anyDescendantWorking = true;
          break;
        }
        if (sub.substewards && sub.substewards.length > 0) {
          for (const ss of sub.substewards) {
            const ssSid = ss.sessionName || `holler-${steward.id}--${sub.id}--${ss.id}`;
            const ssStatus = sessionStatuses[ssSid];
            if (ssStatus && ssStatus.status === 'working') {
              anyDescendantWorking = true;
              break;
            }
          }
          if (anyDescendantWorking) break;
        }
      }
      if (anyDescendantWorking) {
        const ring = document.createElement('span');
        ring.className = 'topbar-activity-ring';
        cell.appendChild(ring);
      }
    }

    // R15 upper-right: unresponded count badge + unread-attached indicator.
    // Old middle-bottom unread dot is KILLED (no longer rendered).
    const unresponded = items.length;
    if (unresponded > 0) {
      const badge = document.createElement('span');
      badge.className = 'topbar-badge' + (unread > 0 ? ' has-unread' : '');
      badge.textContent = unresponded;
      cell.appendChild(badge);
    } else if (unread > 0) {
      // Badge only for unread-but-no-unresponded — still upper-right.
      const badge = document.createElement('span');
      badge.className = 'topbar-badge has-unread unread-only';
      badge.textContent = '!';
      cell.appendChild(badge);
    }

    embeddedTopbar.appendChild(cell);
  });

  // FEATURE 2 — "play/timeline" macro-view toggle (Josh 2026-08-25). Lives at
  // the right end of the steward row, as Josh suggested. ▶ = enter the unified
  // all-sessions play stream (newest-unseen front, rest stacking behind). When
  // the timeline is active the button is filled + shows ⏸, and tapping it exits
  // back to the per-steward presenter view (restoring the last selected
  // steward, or auto-selecting the first steward if none was chosen).
  const timelineActive = selectedViewMode === 'timeline';
  const playBtn = document.createElement('button');
  playBtn.className = 'topbar-play' + (timelineActive ? ' active' : '');
  playBtn.innerHTML = timelineActive ? '⏸' : '▶';
  playBtn.title = timelineActive ? 'Exit timeline' : 'Play timeline (all cards, newest unseen first)';
  playBtn.addEventListener('click', () => {
    if (selectedViewMode === 'timeline') {
      // Exit → back to the per-steward presenter deck.
      selectedViewMode = 'presenter';
      // Reset the seen-dedup set so re-entering the timeline re-stamps freshly.
      window.__timelineSeenSent = new Set();
      if (selectedSteward) {
        selectSteward(selectedSteward);
      } else {
        renderView();
      }
      renderEmbeddedTopbar();
    } else {
      selectedViewMode = 'timeline';
      window.__timelineSeenSent = new Set();
      renderView();
      renderEmbeddedTopbar();
      updateConvHeader();
    }
  });
  embeddedTopbar.appendChild(playBtn);

  // Expand button at right end
  const expandBtn = document.createElement('button');
  expandBtn.className = 'topbar-expand';
  expandBtn.innerHTML = '☰';
  expandBtn.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar) return;
    const isOpen = sidebar.classList.contains('expanded-overlay');
    if (isOpen) {
      sidebar.classList.remove('expanded-overlay');
      if (overlay) overlay.classList.remove('visible');
    } else {
      sidebar.classList.add('expanded-overlay');
      if (overlay) overlay.classList.add('visible');
    }
  });
  embeddedTopbar.appendChild(expandBtn);

  // Also render the subbar for the currently selected steward
  renderEmbeddedSubbar();

  // Urgency view (Josh 2026-08-15): refresh the count-button + overlay from the
  // live queue on every topbar render (queue/status changes flow through here).
  if (typeof renderUrgencyView === 'function') renderUrgencyView();
}

// ============================================================================
// URGENCY VIEW — count-only corner button → tap-toggle overlay (Josh 2026-08-15
// "remove the needs you language and send it"). needs-me cards LOW (thumb),
// one-per-worker summaries HIGH. Reads the live `queue`; grouped by
// callback_session → top steward. Embedded (phone) mode only.
// ============================================================================

// THREE lanes on Josh's "does this invite you?" axis (2026-08-21):
//   blocked  = REQUIRES you (can't proceed without your call) — pops loudest.
//   weigh_in = INVITES you (moving, but you'd want to steer/react/nudge).
//   fyi      = FREES you (nothing to do). Also the fallback for any legacy /
//              system card missing a status, so it stays swipe-safe and never
//              falsely pops. (needs_you = the OLD pre-3-lane value; map it to
//              blocked so any in-flight card sent right before the flip still
//              lands in the loud lane instead of silently becoming fyi.)
function urgencyStatus(card) {
  const s = card && card.status;
  if (s === 'blocked' || s === 'needs_you') return 'blocked';
  if (s === 'weigh_in') return 'weigh_in';
  return 'fyi';
}
// A card is "answered" (no longer needs Josh) once it carries a reply/response
// or was dismissed. Absent = still open.
function urgencyAnswered(card) {
  if (!card) return true;
  return !!(card.replied || card.responded || card.response_button || card.button || card.dismissed);
}
// Top steward id for a card's session (prefix before first "--").
function urgencyTopOf(sid) {
  if (typeof sid !== 'string' || !sid) return '';
  const i = sid.indexOf('--');
  return i === -1 ? sid : sid.slice(0, i);
}
// Worker label from a session's "--" suffix; '' for the bare top steward.
function urgencyWorkerName(sid, sourceLabel) {
  const s = typeof sid === 'string' ? sid : '';
  const i = s.indexOf('--');
  const suffix = i === -1 ? '' : s.slice(i + 2);
  if (!suffix) {
    // top steward itself — use the source label (minus role word) or the id
    const base = (typeof sourceLabel === 'string' && sourceLabel.trim()) ? sourceLabel.trim() : urgencyTopOf(s);
    return dnHumanize(String(base).replace(/[\s-]*(worker|build|builder|steward)$/i, '').trim());
  }
  const base = (typeof sourceLabel === 'string' && sourceLabel.trim())
    ? sourceLabel.trim().replace(/[\s-]*(worker|build|builder)$/i, '').trim()
    : suffix;
  return dnHumanize(base);
}
// Steading icon for a top steward id.
function urgencySteadingIcon(topSteward) {
  const id = (topSteward || '').replace(/^holler-/, '');
  const s = (typeof stewards !== 'undefined') ? stewards.find(x => x.id === id) : null;
  return (s && (s.icon || s.shorthand)) || (id ? id.charAt(0).toUpperCase() : '•');
}
function urgencyRelTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// The short line the docket shows for a card. Renders off the sender-submitted
// RECAP first — that's the whole point of the recap-timeline: the docket shows
// the structured short text the sender was FORCED to provide (blocked = what
// they need, weigh_in = what to weigh in on, fyi = a recap), NOT the card
// title. Title/message are only a last-ditch fallback for legacy / in-process
// system cards that predate the hard-required recap (job-scheduler alarms, old
// queued cards). New steward cards always carry a recap, so those render off it.
function urgencyLine(c, fallbackVerb) {
  if (c && typeof c.recap === 'string' && c.recap.trim()) return c.recap.trim();
  return (c && (c.title || c.message)) || fallbackVerb || '';
}
function urgencyRow(c) {
  const sid = c.callback_session || c.session_id || '';
  return {
    id: c.id,
    sessionId: sid,
    who: urgencyWorkerName(sid, c.source),
    icon: urgencySteadingIcon(urgencyTopOf(sid)),
    ts: urgencyRelTime(c.timestamp),
    tsRaw: c.timestamp || 0,
  };
}

// Compute the THREE lane lists from the live queue (2026-08-21):
//   needsMe   = every OPEN "blocked" card (several per worker OK), newest first.
//   weighIn   = every OPEN "weigh_in" card, newest first.
//   summaries = ONE per worker (their latest card), for workers NOT already
//               surfaced in needsMe or weighIn (so summaries = "everyone else").
// Every row's short text renders off the submitted recap (urgencyLine), not the
// card title.
function computeUrgencyLists(cards) {
  const list = Array.isArray(cards) ? cards : [];
  // blocked: open + blocked (loudest lane)
  const needsMe = list
    .filter(c => urgencyStatus(c) === 'blocked' && !urgencyAnswered(c))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .map(c => ({ ...urgencyRow(c), ask: urgencyLine(c, 'Needs your call') }));
  // weigh_in: open + weigh_in (invites-you lane)
  const weighIn = list
    .filter(c => urgencyStatus(c) === 'weigh_in' && !urgencyAnswered(c))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .map(c => ({ ...urgencyRow(c), ask: urgencyLine(c, 'Wants your read') }));
  // Which worker-sessions already appear above — those don't also need a summary.
  const claimed = new Set([...needsMe, ...weighIn].map(n => n.sessionId));
  // summaries: latest card per WORKER session, excluding sessions already shown.
  const byWorker = new Map();
  for (const c of list) {
    const sid = c.callback_session || c.session_id || '';
    if (!sid || claimed.has(sid)) continue;
    const prev = byWorker.get(sid);
    if (!prev || (c.timestamp || 0) > (prev.timestamp || 0)) byWorker.set(sid, c);
  }
  const summaries = Array.from(byWorker.values())
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .map(c => ({ ...urgencyRow(c), recap: urgencyLine(c, '') }));
  return { needsMe, weighIn, summaries };
}

// Jump to a specific card: select its steward first (mobileDeckJumpTo only
// searches the CURRENTLY selected steward's deck), then jump within it.
function urgencyJumpToCard(sessionId, itemId) {
  try {
    if (typeof selectSteward === 'function' && sessionId) selectSteward(sessionId);
    // Let the deck re-render, then jump to the card.
    setTimeout(() => { if (typeof window.mobileDeckJumpTo === 'function' && itemId) window.mobileDeckJumpTo(itemId); }, 60);
  } catch (e) { console.warn('[urgency] jump failed', e); }
}

// Build the left-side TIME COLUMN for a docket row — mirrors the unified-log
// treatment (Josh's ask: time is too faint tucked upper-right; make it a
// first-class element on the LEFT like the log view). Big "how long ago" on
// top, real abbreviated date + clock underneath (quieter).
function urgencyTimeCol(tsRaw, relFallback) {
  const col = document.createElement('div'); col.className = 'u-time';
  const ago = document.createElement('div'); ago.className = 'u-time-ago';
  ago.textContent = tsRaw ? relativeTime(tsRaw) : (relFallback || '');
  col.appendChild(ago);
  if (tsRaw) {
    const abs = document.createElement('div'); abs.className = 'u-time-abs';
    const dateLine = document.createElement('div'); dateLine.className = 'u-time-date';
    dateLine.textContent = abbrevDate(tsRaw);
    const clockLine = document.createElement('div'); clockLine.className = 'u-time-clock';
    clockLine.textContent = formatActualTime(tsRaw);
    abs.appendChild(dateLine); abs.appendChild(clockLine);
    col.appendChild(abs);
  }
  return col;
}

let __urgencyWired = false;
function renderUrgencyView() {
  if (!document.body.classList.contains('embedded')) return;
  const fab = document.getElementById('urgency-fab');
  const overlay = document.getElementById('urgency-overlay');
  if (!fab || !overlay) return;

  const { needsMe, weighIn, summaries } = computeUrgencyLists(queue);

  // FAB: count-only (no "NEEDS YOU" text — Josh cut it). ALWAYS visible now
  // (Josh 2026-08-16). The count reads the real number, 0 included. `.has-needs`
  // is a STYLE hook only (loud orange >0, muted calm at 0) — it no longer gates
  // visibility, and we no longer auto-close the overlay at 0 so tapping the
  // button always opens the view (empty-state text handles the 0 case).
  fab.textContent = String(needsMe.length);
  fab.classList.toggle('has-needs', needsMe.length > 0);

  // The FAB is retired (Josh 2026-08-18); the live count now rides the Docket
  // button in the toolbar row. Keep it in sync on every queue change here so the
  // count doesn't wait for the next full toolbar rebuild.
  const docketBtn = document.querySelector('.docket-toolbar-btn');
  if (docketBtn) {
    const countEl = docketBtn.querySelector('.docket-count');
    if (countEl) countEl.textContent = String(needsMe.length);
    docketBtn.classList.toggle('has-needs', needsMe.length > 0);
  }

  // Summaries HIGH
  const sumList = document.getElementById('urgency-summaries-list');
  if (sumList) {
    sumList.innerHTML = '';
    if (summaries.length === 0) {
      const e = document.createElement('div'); e.className = 'u-empty'; e.textContent = 'Nothing else to report.';
      sumList.appendChild(e);
    }
    summaries.forEach(s => {
      const row = document.createElement('div'); row.className = 'u-sum';
      row.appendChild(urgencyTimeCol(s.tsRaw, s.ts));
      const body = document.createElement('div'); body.className = 'u-body';
      body.innerHTML = '<div class="u-who"></div><div class="u-recap"></div>';
      body.querySelector('.u-who').textContent = s.who;
      body.querySelector('.u-recap').textContent = s.recap;
      const ico = document.createElement('span'); ico.className = 'u-ico'; ico.textContent = s.icon;
      row.appendChild(ico);
      row.appendChild(body);
      row.addEventListener('click', () => { overlay.classList.remove('open'); urgencyJumpToCard(s.sessionId, s.id); });
      sumList.appendChild(row);
    });
  }

  // Weigh-in MIDDLE (invites you — you're not blocking anything)
  const weighList = document.getElementById('urgency-weighin-list');
  if (weighList) {
    weighList.innerHTML = '';
    if (weighIn.length === 0) {
      const e = document.createElement('div'); e.className = 'u-empty'; e.textContent = 'Nothing waiting on your read.';
      weighList.appendChild(e);
    }
    weighIn.forEach(w => {
      const row = document.createElement('div'); row.className = 'u-weigh';
      row.appendChild(urgencyTimeCol(w.tsRaw, w.ts));
      const body = document.createElement('div'); body.className = 'u-body';
      body.innerHTML = '<div class="u-who"></div><div class="u-ask"></div>';
      body.querySelector('.u-who').textContent = w.who;
      body.querySelector('.u-ask').textContent = w.ask;
      const ico = document.createElement('span'); ico.className = 'u-ico'; ico.textContent = w.icon;
      row.appendChild(ico);
      row.appendChild(body);
      row.addEventListener('click', () => { overlay.classList.remove('open'); urgencyJumpToCard(w.sessionId, w.id); });
      weighList.appendChild(row);
    });
  }

  // Needs-me LOW (blocked — requires your call)
  const needList = document.getElementById('urgency-needs-list');
  if (needList) {
    needList.innerHTML = '';
    if (needsMe.length === 0) {
      const e = document.createElement('div'); e.className = 'u-empty'; e.textContent = 'Nothing needs you right now.';
      needList.appendChild(e);
    }
    needsMe.forEach(n => {
      const row = document.createElement('div'); row.className = 'u-need';
      row.appendChild(urgencyTimeCol(n.tsRaw, n.ts));
      const body = document.createElement('div'); body.className = 'u-body';
      body.innerHTML = '<div class="u-who"></div><div class="u-ask"></div>';
      body.querySelector('.u-who').textContent = n.who;
      body.querySelector('.u-ask').textContent = n.ask;
      const ico = document.createElement('span'); ico.className = 'u-ico'; ico.textContent = n.icon;
      row.appendChild(ico);
      row.appendChild(body);
      row.addEventListener('click', () => { overlay.classList.remove('open'); urgencyJumpToCard(n.sessionId, n.id); });
      needList.appendChild(row);
    });
  }

  // Wire tap-toggle ONCE (idempotent across re-renders).
  if (!__urgencyWired) {
    __urgencyWired = true;
    fab.addEventListener('click', () => overlay.classList.toggle('open'));
    const closeBtn = document.getElementById('urgency-close');
    if (closeBtn) closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  }
}

// --- Embedded subbar: substeward row ---
const embeddedSubbar = document.getElementById('embedded-subbar');

function renderEmbeddedSubbar() {
  if (!document.body.classList.contains('embedded') || !embeddedSubbar) return;

  embeddedSubbar.innerHTML = '';
  embeddedSubbar.classList.remove('visible');

  if (!selectedSteward) { window.__frozenWorkerOrderKey = null; return; }

  // Find the top-level steward for the current selection
  const parentSteward = stewards.find(s => getSessionIdsForSteward(s).includes(selectedSteward));
  // Worker-rehome: endpoint emits children under `workers` (canonical) with
  // `substewards` kept as a back-compat alias. Prefer `workers`.
  const topWorkers = (parentSteward && (parentSteward.workers || parentSteward.substewards)) || [];
  // Landing on a steading with NO worker row counts as navigating away — clear
  // the frozen-order tracking key so returning to a worker-bearing steading
  // re-sorts (freeze holds only WHILE continuously on that steading). See the
  // FREEZE-ON-NAVIGATION block below.
  if (!parentSteward || topWorkers.length === 0) { window.__frozenWorkerOrderKey = null; return; }

  embeddedSubbar.classList.add('visible');

  // Sort newest-status-change LEFTMOST (Josh iter3): most-recent `updatedAt`
  // first. Workers with unknown/missing `updatedAt` sort to the END (rightmost).
  // Stable sort (Array.prototype.sort is stable) keeps equal timestamps steady.
  const workerUpdatedAt = (sub) => {
    const sid = sub.sessionName || `holler-${parentSteward.id}--${sub.id}`;
    const st = sessionStatuses[sid];
    const ts = st && st.updatedAt ? Date.parse(st.updatedAt) : NaN;
    return Number.isNaN(ts) ? -Infinity : ts;
  };
  const workerKey = (sub) => sub.sessionName || `holler-${parentSteward.id}--${sub.id}`;

  // FREEZE-ON-NAVIGATION (Josh 2026-08-07): Josh does NOT want the worker row
  // to live-reshuffle under him. The order must be computed ONCE when he
  // navigates INTO a steading, then held FROZEN while he stays on it. It only
  // re-sorts when he re-navigates (leaves + re-enters, or switches steward and
  // comes back). renderEmbeddedSubbar runs on EVERY render (socket pushes,
  // status polls) — so we cannot sort here unconditionally. Instead we cache a
  // frozen order keyed by the PARENT steward id, and only (re)compute it when
  // the parent steward changes (i.e. a real navigation). Clicking a worker
  // WITHIN the same steading keeps the same parent → order stays frozen, which
  // is exactly the behavior Josh wants.
  if (!window.__frozenWorkerOrder) window.__frozenWorkerOrder = {};
  const freezeKey = parentSteward.id;
  const liveSorted = topWorkers.slice().sort((a, b) => workerUpdatedAt(b) - workerUpdatedAt(a));

  let sortedWorkers;
  if (window.__frozenWorkerOrderKey === freezeKey && window.__frozenWorkerOrder[freezeKey]) {
    // Same steading as last render — REUSE the frozen order. Reorder the current
    // worker list to match the frozen sequence. Any worker that first appeared
    // mid-view (not in the frozen order) is a brand-new event, so Josh wants it
    // at the FAR LEFT (leftmost = newest-status-first, its natural home) and
    // ANIMATED IN (2026-08-07). It slides in at the front rather than silently
    // reshuffling the existing frozen tail. Workers that vanished are naturally
    // dropped (they're just absent from topWorkers). Once a new worker has been
    // placed, we ADD it to the frozen order (at the front) so it stops being
    // "new" on the next render and holds its leftmost spot until re-navigation.
    const frozen = window.__frozenWorkerOrder[freezeKey];
    const rank = new Map(frozen.map((k, i) => [k, i]));
    const newcomers = topWorkers.filter(sub => !rank.has(workerKey(sub)));
    sortedWorkers = topWorkers.slice().sort((a, b) => {
      const ra = rank.has(workerKey(a)) ? rank.get(workerKey(a)) : -1; // newcomers to the FRONT
      const rb = rank.has(workerKey(b)) ? rank.get(workerKey(b)) : -1;
      if (ra !== rb) return ra - rb;
      // Two brand-new workers both unranked: newest-status-first among themselves.
      return workerUpdatedAt(b) - workerUpdatedAt(a);
    });
    if (newcomers.length > 0) {
      // Mark these keys so their cell gets the slide-in animation this render,
      // then absorb them into the frozen order (front) so future renders treat
      // them as settled and they don't re-animate or drift.
      if (!window.__frozenWorkerNewcomers) window.__frozenWorkerNewcomers = new Set();
      const newKeys = newcomers.map(workerKey);
      newKeys.forEach(k => window.__frozenWorkerNewcomers.add(k));
      window.__frozenWorkerOrder[freezeKey] = sortedWorkers.map(workerKey);
    }
  } else {
    // Navigated INTO this steading (parent changed) — compute the sort fresh and
    // FREEZE it. This is the only place the order is (re)computed. Wipe any
    // pending newcomer-animation marks: a fresh navigation shows the settled
    // sorted order with no slide-ins (the workers were already here on landing).
    sortedWorkers = liveSorted;
    window.__frozenWorkerOrderKey = freezeKey;
    window.__frozenWorkerOrder[freezeKey] = liveSorted.map(workerKey);
    window.__frozenWorkerNewcomers = new Set();
  }

  sortedWorkers.forEach(sub => {
    const subSessionId = sub.sessionName || `holler-${parentSteward.id}--${sub.id}`;
    const isSubActive = selectedSteward === subSessionId;

    const subStatus = sessionStatuses[subSessionId];

    const cell = document.createElement('div');
    // Worker cell is a nested BUTTON (Josh 2026-08-03), mirroring the top-level
    // steward's cell: a left column with the emoji stacked OVER the last-status
    // time, the name on its own to the right, and the status dot hanging off the
    // LOWER-RIGHT corner (absolute). The `has-label` modifier switches it from
    // the icon-only square to this labeled button.
    cell.className = 'subbar-icon has-label' + (isSubActive ? ' active' : '');
    // Freeze-on-nav newcomer (Josh 2026-08-07): a worker that first appeared
    // mid-view slides in at the far left. Tag its cell so the CSS keyframe plays
    // once, then clear the mark so it never re-animates on subsequent renders.
    if (window.__frozenWorkerNewcomers && window.__frozenWorkerNewcomers.has(subSessionId)) {
      cell.classList.add('subbar-icon--arriving');
      window.__frozenWorkerNewcomers.delete(subSessionId);
    }
    // Plain click on a worker button drills straight into THAT WORKER'S CARD
    // STACK — only that worker's cards, nothing else (Josh 2026-08-25, born
    // from the urgency-jump "glitch" he liked). This is the DEFAULT worker-tap
    // now. renderThread already filters a selected substeward to its own
    // session_id (see the `substeward` branch), so selecting it in presenter
    // mode shows exactly that worker's stack. The old tmux-view behavior moved
    // to LONG-PRESS ("Open tmux view" in the icon context menu) — a happy
    // accident Josh chose to keep.
    cell.addEventListener('click', () => {
      selectedViewMode = 'presenter';
      // Clear any steward two-level toggle state — a worker selection is its
      // own level and shouldn't inherit the parent steward's all/own choice.
      stewardCardLevel = 'all';
      selectSteward(subSessionId);
    });
    attachIconContextMenu(cell, subSessionId);

    // Left column: the emoji inside a "cool" rounded chip (iter4 — Josh wants
    // the emoji in a treated container so the whole button reads swaggier).
    const iconCol = document.createElement('div');
    iconCol.className = 'subbar-iconcol';

    const emojiChip = document.createElement('span');
    emojiChip.className = 'subbar-emoji-chip';
    const emoji = document.createElement('span');
    emoji.className = 'subbar-emoji';
    // Worker-self-assigned emoji is canonical; icon is the legacy fallback.
    emoji.textContent = sub.emoji || sub.icon || '🔹';
    emojiChip.appendChild(emoji);
    iconCol.appendChild(emojiChip);

    cell.appendChild(iconCol);

    // Worker name — on its own, to the right of the icon column. Iter7 (Josh):
    // no artificial "…" ellipsis; the name runs as long as it can and FADES to
    // transparent at the right edge (mask, applied via `.name-clipped`). When it
    // overflows, a small "⋯" affordance appears that TOASTS the full name on tap.
    const fullName = sub.name || sub.id || subSessionId;
    const nameEl = document.createElement('span');
    nameEl.className = 'subbar-name';
    nameEl.textContent = fullName;
    cell.appendChild(nameEl);

    // The "⋯" more-button is appended only when the name actually overflows.
    // We measure after layout (rAF) since scrollWidth needs the element in-flow.
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'subbar-name-more';
    moreBtn.textContent = '⋯';
    moreBtn.title = 'Show full name';
    moreBtn.style.display = 'none';
    moreBtn.addEventListener('click', (ev) => {
      ev.stopPropagation(); // don't open the worker's tmux view
      showNameToast(fullName);
    });
    cell.appendChild(moreBtn);
    // Reveal the "⋯" only if the name is truncated. rAF lets the browser lay
    // the cell out first so scrollWidth/clientWidth are meaningful.
    requestAnimationFrame(() => {
      if (nameEl.scrollWidth > nameEl.clientWidth + 1) {
        moreBtn.style.display = '';
        cell.classList.add('name-clipped');
      }
    });

    // COMBINED STATUS+TIME BADGE (Josh 2026-08-07 redesign; time-always 2026-09-19).
    // The status dot and the time are ONE element in the top-right corner.
    //
    // Josh 2026-09-19: the time is ALWAYS shown, in BOTH states, and is NEVER a
    // dash. The two states answer two different questions with the same pill:
    //   • WORKING (yellow, pulsing): how long it HAS BEEN working  -> time since
    //     the status flipped TO working, i.e. `updatedAt` (the transition time).
    //     `activityAt` is wrong here — it would tick back to ~0s on every tool
    //     call and read "1s" forever no matter how long the run had been going.
    //   • NOT working (green/idle): how long SINCE it was working -> time since
    //     it last did anything, i.e. `activityAt`, falling back to `updatedAt`.
    // Previously the working state hid the time entirely ("live ≈ 0s"), which is
    // exactly the number Josh wanted to see.
    //
    // Sticky last-known time so a single null poll never blanks the badge.
    const isWorking = !!(subStatus && subStatus.status === 'working');
    let effectiveUpdatedAt = subStatus && (isWorking
      ? (subStatus.updatedAt || subStatus.activityAt)
      : (subStatus.activityAt || subStatus.updatedAt));
    // A worker whose tmux session is GONE has no entry in sessionStatuses at
    // all, so nothing above resolves and the badge used to dash. Its own
    // directory still carries a real last-touched time (`lastSeenAt`, from
    // /api/stewards) — that is the honest "when did this one go quiet".
    if (!effectiveUpdatedAt && sub && sub.lastSeenAt) {
      effectiveUpdatedAt = sub.lastSeenAt;
    }
    if (effectiveUpdatedAt) {
      lastKnownStatusTime[subSessionId] = effectiveUpdatedAt;
    } else if (lastKnownStatusTime[subSessionId]) {
      effectiveUpdatedAt = lastKnownStatusTime[subSessionId];
    }

    const statusBadge = document.createElement('span');
    statusBadge.className = 'subbar-timebadge';
    let statusWord = 'idle';
    if (isWorking) {
      statusBadge.classList.add('working');
      statusWord = 'working';
    } else if (subStatus && (subStatus.status === 'waiting' || subStatus.status === 'idle')) {
      statusBadge.classList.add('ready');
      statusWord = subStatus.status;
    } else {
      statusBadge.classList.add('unknown');
      statusWord = 'idle';
    }
    // Dot lives INSIDE the badge now.
    const statusDot = document.createElement('span');
    statusDot.className = 'subbar-timebadge-dot';
    statusBadge.appendChild(statusDot);
    // Time text — ALWAYS rendered, in both states (Josh 2026-09-19). Never a dash.
    const timeEl = document.createElement('span');
    timeEl.className = 'subbar-timebadge-time';
    timeEl.textContent = statusTimeShort(effectiveUpdatedAt);
    statusBadge.appendChild(timeEl);
    statusBadge.classList.add('has-time');
    statusBadge.title = isWorking
      ? `Status: working · running for ${statusTimeShort(effectiveUpdatedAt)}`
      : `Status: ${statusWord} · ${statusTimeShort(effectiveUpdatedAt)} since last active`;
    cell.appendChild(statusBadge);

    // AHEAD-only git diff chip (Josh 2026-08-07): bottom-right slot shows how
    // much committed work is in this worker's branch that ISN'T in main yet —
    // "Nf +X −Y". Rendered only when there's something ahead (files > 0); a
    // clean/merged worker carries no chip. Data comes from workerGitDiffs, fed
    // by /api/worker-git-diff (see fetchWorkerGitDiffs).
    const diff = workerGitDiffs[subSessionId];
    if (diff && diff.files > 0) {
      const diffChip = document.createElement('span');
      diffChip.className = 'subbar-diff';
      diffChip.title = `${diff.files} file${diff.files === 1 ? '' : 's'} changed vs main · +${diff.add}/−${diff.del} (${diff.ahead} commit${diff.ahead === 1 ? '' : 's'} ahead)`;
      const f = document.createElement('span');
      f.className = 'subbar-diff-files';
      f.textContent = `${diff.files}f`;
      diffChip.appendChild(f);
      if (diff.add > 0) {
        const a = document.createElement('span');
        a.className = 'subbar-diff-add';
        a.textContent = `+${diff.add}`;
        diffChip.appendChild(a);
      }
      if (diff.del > 0) {
        const d = document.createElement('span');
        d.className = 'subbar-diff-del';
        d.textContent = `−${diff.del}`;
        diffChip.appendChild(d);
      }
      cell.appendChild(diffChip);
    } else if (diff && diff.files === 0) {
      // CAUGHT-UP indicator (Josh 2026-08-08): a worker whose branch has nothing
      // ahead of main shows a subtle ✓ instead of an empty corner, so "no chip"
      // reads as "all merged in" rather than "feature not working". Only when we
      // actually HAVE a diff result (files===0) — a null diff (not computed yet)
      // still shows nothing, so the ✓ never flashes before data loads.
      const caughtUp = document.createElement('span');
      caughtUp.className = 'subbar-diff subbar-diff-caughtup';
      caughtUp.title = 'Caught up — nothing in this worker’s branch that isn’t already in main';
      caughtUp.textContent = '✓';
      cell.appendChild(caughtUp);
    }

    // R22 (Josh 2026-04-21): sub-sub chips default COLLAPSED. Show a
    // tappable count badge on the substeward cell instead: "{total}"
    // with a working-dot for each currently-working child. Tapping the
    // badge toggles expansion. Expanded state is in-session only (Set
    // keyed by substeward session id). Activity ring on the substeward
    // is still rendered when children are working, regardless of
    // expansion state.
    // Nested sub-workers: prefer `workers`, fall back to `substewards` alias.
    const subSubsSrc = sub.workers || sub.substewards;
    const subSubs = (subSubsSrc && subSubsSrc.length > 0) ? subSubsSrc : [];
    const workingChildren = [];
    for (const ss of subSubs) {
      const ssSid = ss.sessionName || `holler-${parentSteward.id}--${sub.id}--${ss.id}`;
      const ssStatus = sessionStatuses[ssSid];
      if (ssStatus && ssStatus.status === 'working') workingChildren.push(ssSid);
    }

    // Activity ring on substeward when any descendant is working.
    if (subSubs.length > 0 && workingChildren.length > 0) {
      const ring = document.createElement('span');
      ring.className = 'topbar-activity-ring';
      cell.appendChild(ring);
    }

    embeddedSubbar.appendChild(cell);

    if (subSubs.length > 0) {
      const countBadge = document.createElement('button');
      countBadge.type = 'button';
      countBadge.className = 'subsub-count-badge';
      countBadge.title = `${subSubs.length} sub-worker${subSubs.length === 1 ? '' : 's'}${workingChildren.length ? ` · ${workingChildren.length} working` : ''}`;
      // Count number
      const numSpan = document.createElement('span');
      numSpan.className = 'subsub-count-num';
      numSpan.textContent = String(subSubs.length);
      countBadge.appendChild(numSpan);
      // Working dots — one flashing dot per working child (up to 3, then "+N")
      if (workingChildren.length > 0) {
        const dotsWrap = document.createElement('span');
        dotsWrap.className = 'subsub-count-dots';
        const shown = Math.min(workingChildren.length, 3);
        for (let i = 0; i < shown; i++) {
          const d = document.createElement('span');
          d.className = 'subsub-count-dot working';
          dotsWrap.appendChild(d);
        }
        if (workingChildren.length > 3) {
          const extra = document.createElement('span');
          extra.className = 'subsub-count-extra';
          extra.textContent = `+${workingChildren.length - 3}`;
          dotsWrap.appendChild(extra);
        }
        countBadge.appendChild(dotsWrap);
      }
      if (!window.__expandedSubSubs) window.__expandedSubSubs = new Set();
      const expandKey = sub.sessionName || `holler-${parentSteward.id}--${sub.id}`;
      const isExpanded = window.__expandedSubSubs.has(expandKey);
      if (isExpanded) countBadge.classList.add('expanded');
      countBadge.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!window.__expandedSubSubs) window.__expandedSubSubs = new Set();
        if (window.__expandedSubSubs.has(expandKey)) {
          window.__expandedSubSubs.delete(expandKey);
        } else {
          window.__expandedSubSubs.add(expandKey);
        }
        renderEmbeddedSubbar();
      });
      embeddedSubbar.appendChild(countBadge);

      // Expanded: render the R13 chips inline, same as before.
      if (isExpanded) {
        subSubs.forEach((ss) => {
          const ssSessionId = ss.sessionName || `holler-${parentSteward.id}--${sub.id}--${ss.id}`;
          const chip = document.createElement('div');
          chip.className = 'subsub-chip';
          chip.title = `Sub-worker of ${sub.name || sub.id} — informational only`;
          attachIconContextMenu(chip, ssSessionId);

          const emoji = document.createElement('span');
          emoji.className = 'subsub-chip-emoji';
          emoji.textContent = ss.emoji || ss.icon || '🔹';
          chip.appendChild(emoji);

          const name = document.createElement('span');
          name.className = 'subsub-chip-name';
          name.textContent = ss.name || ss.id || ssSessionId;
          chip.appendChild(name);

          const ssStatus = sessionStatuses[ssSessionId];
          const dot = document.createElement('span');
          dot.className = 'topbar-status';
          if (ssStatus && ssStatus.status === 'working') {
            dot.style.background = '#FFCC00';
            dot.style.animation = 'pulse 1s ease-in-out infinite';
          } else if (ssStatus && (ssStatus.status === 'waiting' || ssStatus.status === 'idle')) {
            dot.style.background = '#00FF66';
          } else {
            dot.style.background = '#444';
          }
          chip.appendChild(dot);

          embeddedSubbar.appendChild(chip);
        });
      }
    }
  });
}

// --- Font size control ---
const FONT_SIZE_KEY = 'presenter-font-size';
const FONT_SIZE_MIN = 14;
const FONT_SIZE_MAX = 24;
const FONT_SIZE_DEFAULT = 18;

function getStoredFontSize() {
  const stored = parseInt(localStorage.getItem(FONT_SIZE_KEY));
  return (stored >= FONT_SIZE_MIN && stored <= FONT_SIZE_MAX) ? stored : FONT_SIZE_DEFAULT;
}

function applyFontSize(size) {
  document.documentElement.style.setProperty('--presenter-font-size', size + 'px');
  localStorage.setItem(FONT_SIZE_KEY, size);
}

// Apply saved font size on load
applyFontSize(getStoredFontSize());


// ---------------------------------------------------------------------------
// Settings panel — opened via ⚙️ in the bottom bar. Content is font size
// controls + theme tiles ONLY (Josh 2026-04-21: "font size selector + theme
// chooser ONLY. Nothing else from the old side-nav."). Reuses the same
// controls the side-nav built, just rendered inside #settings-body.
// ---------------------------------------------------------------------------
function populateSettingsPanelBody() {
  const body = document.getElementById('settings-body');
  if (!body) return;
  body.innerHTML = '';

  // Font size section
  const fontLabel = document.createElement('div');
  fontLabel.className = 'settings-section-label';
  fontLabel.textContent = 'Font size';
  body.appendChild(fontLabel);

  const fontRow = document.createElement('div');
  fontRow.className = 'font-size-controls';
  fontRow.innerHTML = `<button class="font-btn font-decrease">A−</button><span class="font-size-label">${getStoredFontSize()}px</span><button class="font-btn font-increase">A+</button>`;
  fontRow.querySelector('.font-decrease').addEventListener('click', (e) => {
    e.stopPropagation();
    const current = getStoredFontSize();
    if (current > FONT_SIZE_MIN) {
      applyFontSize(current - 1);
      fontRow.querySelector('.font-size-label').textContent = (current - 1) + 'px';
    }
  });
  fontRow.querySelector('.font-increase').addEventListener('click', (e) => {
    e.stopPropagation();
    const current = getStoredFontSize();
    if (current < FONT_SIZE_MAX) {
      applyFontSize(current + 1);
      fontRow.querySelector('.font-size-label').textContent = (current + 1) + 'px';
    }
  });
  body.appendChild(fontRow);

  // Theme tiles section
  const themeLabel = document.createElement('div');
  themeLabel.className = 'settings-section-label';
  themeLabel.textContent = 'Theme';
  body.appendChild(themeLabel);

  const tiles = [
    { id: null, name: 'Off', swatches: ['#111111', '#FF6600', '#00FF66'] },
    { id: 'iowa', name: 'Iowa', swatches: ['#F4EFE6', '#1A1815', '#7A5C3E'] },
    { id: 'gruvbox', name: 'Gruvbox', swatches: ['#282828', '#EBDBB2', '#FE8019'] },
    { id: 'gruvbox-hard', name: 'Hard', swatches: ['#1D2021', '#FBF1C7', '#FE8019'] },
  ];
  const row = document.createElement('div');
  row.className = 'theme-tiles-inline';
  const getCurrent = () => document.body.classList.contains('reading-mode')
    ? document.body.getAttribute('data-reading-preset')
    : null;
  tiles.forEach((tile) => {
    const btn = document.createElement('button');
    btn.className = 'theme-tile-inline';
    btn.dataset.themeId = tile.id || 'off';
    if (getCurrent() === tile.id) btn.classList.add('active');
    const swStrip = document.createElement('div');
    swStrip.className = 'theme-tile-inline-swatches';
    tile.swatches.forEach((hex) => {
      const sw = document.createElement('span');
      sw.className = 'theme-tile-inline-swatch';
      sw.style.background = hex;
      swStrip.appendChild(sw);
    });
    btn.appendChild(swStrip);
    const label = document.createElement('span');
    label.className = 'theme-tile-inline-name';
    label.textContent = tile.name;
    btn.appendChild(label);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof window.applyReadingMode === 'function') {
        window.applyReadingMode(tile.id);
      }
      try { localStorage.setItem('presenter-reading-mode', tile.id || 'off'); } catch {}
      row.querySelectorAll('.theme-tile-inline').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
    });
    row.appendChild(btn);
  });
  body.appendChild(row);

  // --- Switch to web view tile — renders in ALL environments ---
  // Electron, APK WebView, and plain browser all get this tile (Joshua rule
  // 2026-04-23: no split behavior between shells). Every shell now takes the
  // same path: reopen THIS presenter un-embedded in a browser tab.
  //
  // The APK used to branch here to Android.switchToWebView(), which swapped to
  // the site root — Interface 1, the repos/branches dashboard. That dashboard
  // was retired 2026-09-03, so the bridge would have landed on a dead screen.
  // Dropping the branch lets the APK fall through to the same presenter tab
  // the desktop already opened. Renderer-only, so no APK rebuild is needed.
  const webLabel = document.createElement('div');
  webLabel.className = 'settings-section-label';
  webLabel.textContent = 'View mode';
  body.appendChild(webLabel);

  const webRow = document.createElement('div');
  webRow.className = 'settings-switch-web-row';
  const webBtn = document.createElement('button');
  webBtn.type = 'button';
  webBtn.className = 'settings-switch-web-tile';
  webBtn.innerHTML = '<span class="settings-switch-web-icon" aria-hidden="true">🌐</span><span class="settings-switch-web-label">Switch to web view</span><span class="settings-switch-web-sub">Open the presenter in your browser</span>';
  webBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      // Do NOT strip ?embedded — as of 2026-09-03 the presenter renders one
      // single surface and the param is inert, but stripping it here used to
      // be how you landed on the old degraded no-swipe/no-steward-picker view.
      // Open the presenter exactly as-is.
      const url = new URL(window.location.href);
      window.open(url.toString(), '_blank', 'noopener');
    } catch (err) { console.error('web-view fallback failed', err); }
  });
  webRow.appendChild(webBtn);
  body.appendChild(webRow);

}

function openSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  const scrim = document.getElementById('settings-scrim');
  if (!panel || !scrim) return;
  populateSettingsPanelBody();
  panel.classList.add('open');
  scrim.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
}

function closeSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  const scrim = document.getElementById('settings-scrim');
  if (!panel || !scrim) return;
  panel.classList.remove('open');
  scrim.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
}
window.openSettingsPanel = openSettingsPanel;
window.closeSettingsPanel = closeSettingsPanel;

// Wire close button + scrim click on DOM-ready.
document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('settings-close');
  const scrim = document.getElementById('settings-scrim');
  if (closeBtn) closeBtn.addEventListener('click', closeSettingsPanel);
  if (scrim) scrim.addEventListener('click', closeSettingsPanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const panel = document.getElementById('settings-panel');
      if (panel && panel.classList.contains('open')) closeSettingsPanel();
    }
  });
});

// --- Live chrome rendering (bottom-bar presenter) ---
// The old desktop-native LEFT SIDEBAR (#sidebar / steward-list) was retired
// (Josh 2026-04-21: "desktop-native view is dead") and hidden on every live
// surface via `body.embedded #sidebar { display:none }`. Its ~430-line render
// body was removed 2026-08-29 (dead-code cleanup). What remains is ONLY the
// live work that used to ride on the tail of renderSidebar: the embedded
// bottom topbar + the bottom-input target pill.
function renderLiveChrome() {
  renderEmbeddedTopbar();
  try { updateBottomTargetPill(); } catch (err) { console.error('[Presenter] pill update failed:', err); }
}
// Back-compat alias — many call sites still call renderSidebar(). Kept as a
// hoisted function declaration so the call sites earlier in this file resolve.
function renderSidebar() { renderLiveChrome(); }

// --- Select steward ---

function selectSteward(sessionId) {
  // Two-level steward toggle (Josh 2026-08-25): selecting a DIFFERENT session
  // always resets the level to 'all'. The repeat-tap toggle is handled by the
  // topbar click handler (which flips stewardCardLevel WITHOUT calling
  // selectSteward, since the selection doesn't change). Any other entry point
  // into selectSteward (worker tap, urgency jump, restore) is a real selection
  // change and should land at the default 'all' level.
  if (selectedSteward !== sessionId) stewardCardLevel = 'all';
  selectedSteward = sessionId;

  // Persist selection
  try {
    localStorage.setItem('presenter-selected-steward', sessionId);
    localStorage.setItem('presenter-selected-mode', selectedViewMode);
  } catch {}

  // Refresh the worker-row ahead-only git-diff chips for the newly-selected
  // steward's workers (fire-and-forget; server-cached so it's cheap).
  if (typeof fetchWorkerGitDiffs === 'function') fetchWorkerGitDiffs();

  // Server-backed composer drafts are per-steward — re-hydrate so the
  // bottom-left typing box reflects this steward's drafts (typed on any
  // device). Fire-and-forget; if hydrate lands after first composer open,
  // backfillRenderedDraftTextareas-style logic inside the hydrate function
  // populates the live textarea.
  try {
    if (typeof window.__hydrateComposerDraftsFromServer === 'function') {
      window.__hydrateComposerDraftsFromServer();
    }
  } catch {}

  // Phone-trackpad bridge — see comment block where reportDesktopCurrent
  // is defined (Joshua 2026-04-28).
  if (typeof reportDesktopCurrent === 'function') reportDesktopCurrent();

  // Stop any previous chat refresh
  if (chatRefreshInterval) { clearInterval(chatRefreshInterval); chatRefreshInterval = null; }

  const substeward = findSubstewardForSession(sessionId);
  const steward = findStewardForSession(sessionId);

  // R18 (Josh 2026-04-21): bulk-mark-read on steward open is GONE. Cards
  // now become read one-at-a-time when they're the focused card in the
  // mobile deck (see markCurrentCardRead helper, called from setCurrent).
  if (selectedViewMode === 'presenter') {
    // Fetch history — substewards get only their own session, parent stewards get all
    const sessionIds = substeward ? [sessionId] : (steward ? getSessionIdsForSteward(steward) : [sessionId]);
    window._stewardJustSwitched = true;
    window._showAllAnswered = false;
    Promise.all([
      ...sessionIds.map(sid => fetchHistory(sid, true)),
      fetchActivity(sessionId)
    ]).then(() => renderView());
  }

  if (selectedViewMode === 'chat') {
    // Fetch chat messages for this session
    fetchChatMessages(sessionId).then(() => renderView());
    // Auto-refresh chat every 8 seconds
    chatRefreshInterval = setInterval(() => {
      fetchChatMessages(sessionId).then(() => {
        const activeInput = document.activeElement;
        const isTyping = activeInput && activeInput.tagName === 'TEXTAREA';
        if (!isTyping) renderView();
      });
    }, 8000);
  }

  // Close sidebar on mobile / embedded overlay
  if (sidebar) { sidebar.classList.remove('open'); sidebar.classList.remove('expanded-overlay'); }
  if (sidebarOverlay) sidebarOverlay.classList.remove('visible');

  renderSidebar();
  renderView();
  updateConvHeader();

  // Show bottom input
  const bottomInput = document.getElementById('conv-bottom-input');
  if (bottomInput) bottomInput.style.display = 'flex';

  // Update StewInt panel
  if (window._stewint) window._stewint.update(sessionId);
  if (window._bookmarks) window._bookmarks.update(sessionId);
  if (window._cardLinks) window._cardLinks.update(sessionId);
}

// --- Render the correct view based on mode ---

function renderView() {
  if (selectedViewMode === 'timeline') {
    renderTimelineView();
  } else if (selectedViewMode === 'chat') {
    renderChatView();
  } else {
    renderThread();
  }
}

// --- Update conversation header ---

// Josh 2026-08-27: in timeline mode the header must show the ACTUAL sender of
// the card currently on screen (its real steward icon + name), updating per
// card as the timeline plays — NOT the static "Timeline — all cards". Josh's
// core complaint was he couldn't tell who really sent each card. Given a card
// id, resolve its sending session → steward/substeward and paint the header.
// Called from setCurrent on every timeline card advance, and as the fresh-entry
// fallback below. Falls back to the ▶ macro header only when no card resolves.
function updateTimelineHeaderForItem(itemId) {
  if (selectedViewMode !== 'timeline') return;
  const item = itemId ? queue.find(i => i.id === itemId) : null;
  const sessionId = item && item.session_id;
  // Josh 2026-08-27: in timeline the header must show the TOP-LEVEL steward of
  // whatever card is on screen — NOT the worker/substeward. Example: a card
  // owned by a Crowne Vault worker (holler-crowne-vault--cws-...) must read
  // "Crowne Vault" up top, exactly like the normal per-steward cards do.
  // getSessionIdsForSteward already climbs worker/substeward/build-worktree
  // sessions up to their owning steward, so resolve the steward directly and
  // ignore the substeward entirely.
  const steward = sessionId ? findStewardForSession(sessionId) : null;

  // No resolvable sender → fall back to the macro ▶ header so we never blank.
  if (!steward) {
    if (convStewardIcon) {
      convStewardIcon.textContent = '▶';
      convStewardIcon.style.background = 'none';
      convStewardIcon.style.fontSize = '22px';
    }
    if (convStewardName) convStewardName.textContent = 'Timeline — all cards';
    if (convStewardStatus) convStewardStatus.textContent = '';
    return;
  }

  if (convStewardIcon) {
    convStewardIcon.textContent = steward.icon || steward.shorthand || steward.name.charAt(0);
    convStewardIcon.style.background = 'none';
    convStewardIcon.style.fontSize = '28px';
  }
  if (convStewardName) convStewardName.textContent = steward.name || steward.id;
  if (convStewardStatus) convStewardStatus.textContent = '';
}

function updateConvHeader() {
  // Timeline/play macro view — one unified stream. Josh 2026-08-27: the header
  // follows the CURRENT card's real sender (see updateTimelineHeaderForItem),
  // which setCurrent drives per card. On this initial call (mode just entered)
  // the deck hasn't settled on its focus card yet, so seed the macro ▶ header;
  // setCurrent repaints it with the real sender the moment the deck lands.
  if (selectedViewMode === 'timeline') {
    if (convStewardIcon) {
      convStewardIcon.textContent = '▶';
      convStewardIcon.style.background = 'none';
      convStewardIcon.style.fontSize = '22px';
    }
    if (convStewardName) convStewardName.textContent = 'Timeline — all cards';
    if (convStewardStatus) convStewardStatus.textContent = '';
    return;
  }

  if (!selectedSteward) {
    if (convStewardIcon) convStewardIcon.textContent = '';
    if (convStewardName) convStewardName.textContent = 'Select a steward';
    if (convStewardStatus) convStewardStatus.textContent = '';
    return;
  }

  // Check if this is a substeward
  const substeward = findSubstewardForSession(selectedSteward);
  const steward = findStewardForSession(selectedSteward);

  if (substeward && steward) {
    if (convStewardIcon) {
      convStewardIcon.textContent = substeward.icon || '🔹';
      convStewardIcon.style.background = 'none';
      convStewardIcon.style.fontSize = '24px';
    }
    if (convStewardName) convStewardName.textContent = substeward.name || substeward.id;
    if (convStewardStatus) convStewardStatus.textContent = '';
  } else if (steward) {
    if (convStewardIcon) {
      convStewardIcon.textContent = steward.icon || steward.shorthand || steward.name.charAt(0);
      convStewardIcon.style.background = 'none';
      convStewardIcon.style.fontSize = '28px';
    }
    if (convStewardName) {
      let name = steward.name || steward.id;
      if (selectedViewMode === 'chat') {
        // Show the branch/session name for builds
        const suffix = workerDisplayName(selectedSteward);
        if (suffix) name = suffix;
      }
      convStewardName.textContent = name;
    }
    if (convStewardStatus) convStewardStatus.textContent = '';
  } else {
    if (convStewardIcon) {
      convStewardIcon.textContent = selectedViewMode === 'chat' ? '🔨' : sessionAcronym(selectedSteward);
      convStewardIcon.style.backgroundColor = selectedViewMode === 'chat' ? 'none' : '#555';
    }
    if (convStewardName) convStewardName.textContent = sessionDisplayName(selectedSteward);
    if (convStewardStatus) convStewardStatus.textContent = '';
  }
}

// --- Render thread ---

function renderThread() {
  if (!convThread) return;

  // Leaving the timeline macro view — stop firing mark-seen on card focus.
  window.__timelineMode = false;

  if (!selectedSteward) {
    convThread.style.display = 'none';
    if (convEmpty) convEmpty.style.display = '';
    return;
  }

  convThread.style.display = '';
  if (convEmpty) convEmpty.style.display = 'none';

  // Get active items — if a substeward is selected, show only its items (not the parent tree)
  const substeward = findSubstewardForSession(selectedSteward);
  const steward = findStewardForSession(selectedSteward);
  // Two-level steward selection (Josh 2026-08-25): when a TOP-LEVEL steward's
  // OWN primary session is selected and the level toggle is 'own', restrict to
  // just that steward's own session_id (exclude workers/children). Only applies
  // to the steward's own primary — a worker selection is `substeward` above.
  const stewardOwnOnly = !!steward && !substeward
    && selectedSteward === `holler-${steward.id}`
    && stewardCardLevel === 'own';
  let activeItems = [];
  if (substeward) {
    // Substeward selected — only show items for this specific session
    activeItems = queue.filter(i => i.session_id === selectedSteward);
  } else if (steward && stewardOwnOnly) {
    // 'own' level — steward's own primary session cards only, no children.
    activeItems = queue.filter(i => i.session_id === selectedSteward);
  } else if (steward) {
    activeItems = getItemsForSteward(steward);
  } else {
    activeItems = queue.filter(i => i.session_id === selectedSteward);
  }

  // Get history items — same logic: substeward gets only its own history
  let historyItems = [];
  if (substeward) {
    historyItems = historyCache[selectedSteward] || [];
  } else if (steward && stewardOwnOnly) {
    historyItems = historyCache[selectedSteward] || [];
  } else if (steward) {
    const sessionIds = getSessionIdsForSteward(steward);
    sessionIds.forEach(sid => {
      const cached = historyCache[sid];
      if (cached) historyItems = historyItems.concat(cached);
    });
  } else {
    historyItems = historyCache[selectedSteward] || [];
  }

  // Combine and deduplicate by id
  const seenIds = new Set();
  const allItems = [];

  activeItems.forEach(item => {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      allItems.push({ ...item, _isActive: true });
    }
  });

  historyItems.forEach(item => {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      allItems.push({ ...item, _isActive: false });
    }
  });

  // Sort: responded/archived items first (oldest first), then unaddressed/active at bottom (oldest first)
  allItems.sort((a, b) => {
    // Active (unaddressed) items sort after archived (responded) items
    if (a._isActive !== b._isActive) return a._isActive ? 1 : -1;
    // Within same group, sort chronologically
    const ta = new Date(a.timestamp || a.created_at || 0).getTime();
    const tb = new Date(b.timestamp || b.created_at || 0).getTime();
    return ta - tb;
  });

  const prevCount = convThread.children.length;
  const isFirstLoad = prevCount === 0;
  const wasNearBottom = convThread.scrollTop + convThread.clientHeight >= convThread.scrollHeight - 100;

  // Preserve custom component DOM nodes across re-renders so in-progress
  // typing, expand state, and scroll position inside the component survive
  // new-item / resolved events. Keyed by item id.
  // Populated here, consumed inside buildChatMessages via _componentCache.
  window._componentCache = {};
  convThread.querySelectorAll('.msg-bubble[data-item-id]').forEach(function (b) {
    const id = b.dataset.itemId;
    const comp = b.querySelector('.msg-component');
    if (id && comp) window._componentCache[id] = comp;
  });

  // Snapshot form state before the wipe — re-applied at the end of this
  // function so typed text, focus, cursor position, and scroll survive.
  window._pendingFormSnapshot = captureFormState(convThread);

  convThread.innerHTML = '';

  if (allItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'thread-empty';
    empty.textContent = 'No messages yet';
    convThread.appendChild(empty);
    return;
  }

  // Paginate: all active (unanswered) + last N answered
  const ANSWERED_LIMIT = window._showAllAnswered ? Infinity : 5;
  const activeList = allItems.filter(i => i._isActive);
  const archivedList = allItems.filter(i => !i._isActive);
  const hiddenCount = Math.max(0, archivedList.length - ANSWERED_LIMIT);
  const visibleArchived = archivedList.slice(-ANSWERED_LIMIT);

  // "Show more" button if there are hidden archived items
  if (hiddenCount > 0) {
    const showMore = document.createElement('div');
    showMore.className = 'show-more-btn';
    showMore.textContent = `Show ${hiddenCount} older card${hiddenCount > 1 ? 's' : ''}`;
    showMore.addEventListener('click', () => {
      window._showAllAnswered = true;
      renderView();
    });
    convThread.appendChild(showMore);
  }

  // Render visible archived, then active
  visibleArchived.forEach(item => {
    const elements = buildChatMessages(item, true);
    elements.forEach(el => convThread.appendChild(el));
  });

  activeList.forEach(item => {
    const elements = buildChatMessages(item, false);
    elements.forEach(el => convThread.appendChild(el));
  });

  // --- Bottom toolbar (queue + pause + activity) ---
  renderBottomToolbar();

  if (window._skipAutoScroll) {
    // New card arrived — don't scroll, let user stay where they are
    window._skipAutoScroll = false;
  } else if (preserveScrollPosition !== null) {
    convThread.scrollTop = preserveScrollPosition;
    preserveScrollPosition = null;
  } else if (isFirstLoad || wasNearBottom || window._stewardJustSwitched) {
    convThread.scrollTop = convThread.scrollHeight;
  }
  window._stewardJustSwitched = false;

  // Restore in-progress text / focus / selection / scroll from before the
  // innerHTML wipe. Cards re-rendered at the same item-id get their typed
  // text + cursor position back. No more lost drafts on incoming cards.
  if (window._pendingFormSnapshot) {
    restoreFormState(window._pendingFormSnapshot);
    window._pendingFormSnapshot = null;
  }

  // Mobile-only post-process: transform the vertical thread into a horizontal
  // swipe deck (one active card at a time). No-op on desktop.
  if (typeof applyMobileDeck === 'function') applyMobileDeck();
}


// ============================================================================
// FEATURE 2 — "PLAY / TIMELINE" MACRO VIEW (Josh 2026-08-25)
// ----------------------------------------------------------------------------
// The opposite of the per-steward micro views: ONE unified stream across ALL
// sessions. It surfaces the NEWEST card Josh hasn't SEEN yet, front-and-center,
// with every other live card stacked behind it in ARRIVAL order. While he's
// looking at one card, newer cards that arrive stack up BEHIND — nothing cuts
// in line. Reuses the exact same card bubbles + mobile deck as renderThread, so
// swipe, arrows, reply composer, dismiss all work identically.
//
// DATA MODEL (Rooster-grounded):
//   • Source = the live PRESENTER queue (`queue`), every session mixed.
//   • Arrival order = `timestamp` (Date.now() ms, set at addItem). Sort ASC.
//     NOT array position (urgent splices jump the array), NOT id (random hex).
//   • seen/unseen = the new `seen_at` field. newest-unseen = the max-timestamp
//     card whose seen_at is null. Seen cards + newer-arrived cards stack behind.
//   • Marking seen: setCurrent (below) POSTs /api/presenter/mark-seen/:id the
//     first time a card becomes the front card IN TIMELINE MODE.
// ----------------------------------------------------------------------------
function renderTimelineView(preferredFocusId) {
  if (!convThread) return;
  convThread.style.display = '';
  if (convEmpty) convEmpty.style.display = 'none';

  // ALL live cards, every session. Timeline is a MACRO view — it ignores the
  // per-steward selection entirely.
  const allItems = queue.slice();

  // Deduplicate by id (defensive — queue should already be unique).
  const seenIds = new Set();
  const items = [];
  allItems.forEach(item => {
    if (!seenIds.has(item.id)) { seenIds.add(item.id); items.push(item); }
  });

  // ARRIVAL ORDER: sort by timestamp ascending (oldest first, newest last).
  // The deck stacks in DOM order; rendering oldest→newest means the newest
  // physically sits at the "front" end, matching how the deck defaults.
  const tsOf = (i) => {
    const t = typeof i.timestamp === 'number' ? i.timestamp
      : new Date(i.timestamp || i.created_at || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  items.sort((a, b) => tsOf(a) - tsOf(b));

  // NEWEST-UNSEEN = the highest-timestamp card with no seen_at. That's the card
  // the play view should surface front-and-center. If every card is already
  // seen, fall back to the newest card overall (so the view is never blank when
  // cards exist). Compute the id now; we jump the deck to it after render.
  let newestUnseenId = null;
  for (let i = items.length - 1; i >= 0; i--) {
    if (!items[i].seen_at) { newestUnseenId = items[i].id; break; }
  }
  // On a re-render triggered by a queue change (preferredFocusId given and still
  // live) we KEEP Josh on the card he's viewing — new cards stack behind, they
  // don't steal focus. On fresh entry we land on newest-unseen.
  const preferLive = preferredFocusId && items.some(i => i.id === preferredFocusId);
  const focusId = preferLive
    ? preferredFocusId
    : (newestUnseenId || (items.length ? items[items.length - 1].id : null));

  // Snapshot form state before the wipe (mirror renderThread) so a reply typed
  // on a timeline card survives an incoming-card re-render.
  window._componentCache = {};
  convThread.querySelectorAll('.msg-bubble[data-item-id]').forEach(function (b) {
    const id = b.dataset.itemId;
    const comp = b.querySelector('.msg-component');
    if (id && comp) window._componentCache[id] = comp;
  });
  window._pendingFormSnapshot = captureFormState(convThread);

  convThread.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'thread-empty';
    empty.textContent = 'No cards yet — the timeline fills as cards arrive.';
    convThread.appendChild(empty);
    if (typeof renderBottomToolbar === 'function') renderBottomToolbar();
    return;
  }

  // Render every card as a live (non-archived) bubble, oldest→newest.
  items.forEach(item => {
    const elements = buildChatMessages(item, false);
    elements.forEach(el => convThread.appendChild(el));
  });

  if (typeof renderBottomToolbar === 'function') renderBottomToolbar();

  // Restore typed drafts/focus from before the wipe.
  if (window._pendingFormSnapshot) {
    restoreFormState(window._pendingFormSnapshot);
    window._pendingFormSnapshot = null;
  }

  // Flag timeline mode so setCurrent fires mark-seen (see setCurrent).
  window.__timelineMode = true;
  // SUPPRESS mark-seen during the transient initial setCurrent: applyMobileDeck
  // defaults the front card to the LAST (newest) card, which may be a brand-new
  // unseen arrival that Josh hasn't actually looked at yet — we're about to jump
  // him to `focusId` instead. Marking that transient card seen would wrongly
  // consume its unseen state. Only re-enable mark-seen once we've landed on the
  // real focus card below.
  window.__timelineFocusSettled = false;

  // Transform into the horizontal deck.
  if (typeof applyMobileDeck === 'function') applyMobileDeck();

  // Jump to the intended front card (newest-unseen on entry, or the kept card on
  // a stack-behind re-render). applyMobileDeck defaults to the last card;
  // jumping here lands Josh on the right one. Deferred a tick so the deck
  // DOM/positions are settled (same pattern as urgencyJumpToCard). Re-enable
  // mark-seen AFTER the jump so only the truly-surfaced card gets stamped.
  if (focusId) {
    setTimeout(() => {
      window.__timelineFocusSettled = true;
      if (typeof window.mobileDeckJumpTo === 'function') window.mobileDeckJumpTo(focusId);
    }, 40);
  } else {
    window.__timelineFocusSettled = true;
  }
}


// Holds the queue panel's current tap-outside-to-close listener so it can be
// unregistered on the next toolbar rebuild (the toolbar re-creates its DOM
// every ~5s poll; leaving the old closure registered would leak stale
// listeners pointing at detached nodes). Joshua 2026-07-14.
let _queueOutsideClick = null;

function renderBottomToolbar() {
  const toolbar = document.getElementById('bottom-toolbar');
  if (!toolbar) return;
  toolbar.innerHTML = '';
  // Drop any outside-click listener from the previous toolbar generation.
  if (_queueOutsideClick) {
    document.removeEventListener('click', _queueOutsideClick, true);
    _queueOutsideClick = null;
  }

  if (!selectedSteward) return;

  // --- Button row: [queue toggle] [pause] [activity toggle] ---
  const btnRow = document.createElement('div');
  btnRow.className = 'toolbar-btn-row';

  // Log button — opens the UNIFIED message log for this steward: a single
  // chronological view merging cards, Josh's replies, and (toggle-off) walkie
  // traffic. Replaces the old split of Recent (queue) + History (search).
  const pending = getPendingForSteward(selectedSteward);
  // Josh's #3 — TWO independent filters, BOTH persisted, BOTH default OFF so
  // the log shows ALL messages by default (steward↔steward chatter included).
  //   • onlyMine        → only messages Josh is party to
  //   • onlyThisSteward → only traffic touching the selected steward/crew
  let onlyMine = false;
  let onlyThisSteward = false;
  try {
    const m = localStorage.getItem('queue-only-mine');
    if (m !== null) onlyMine = m === 'true';
    const s = localStorage.getItem('queue-only-this-steward');
    if (s !== null) onlyThisSteward = s === 'true';
  } catch {}
  const queueCount = pending.length;
  const queueBtn = document.createElement('button');
  // queue-toggle-btn: stable hook so tap-outside-to-close (Joshua 2026-07-14)
  // can tell a click ON the toggle from a click OUTSIDE it. The toolbar
  // rebuilds every poll, so the class must ride on every fresh node.
  queueBtn.className = 'toolbar-btn queue-toggle-btn' + (queueCount > 0 ? ' has-pending' : '');
  // One button, one surface — "Log". Count reflects pending depth (queued-but-
  // not-sent) when >0, else a neutral inbox glyph.
  if (queueCount > 0) {
    queueBtn.innerHTML =
      `<span class="toolbar-icon">⏳ ${queueCount}</span>` +
      `<span class="toolbar-label">Log</span>`;
  } else {
    queueBtn.innerHTML =
      `<span class="toolbar-icon">📨</span>` +
      `<span class="toolbar-label">Log</span>`;
  }
  btnRow.appendChild(queueBtn);

  const isEmbedded = document.body.classList.contains('embedded');

  // --- Dictation player (Josh 2026-08-12) ---
  // Replaces the old ⏸ Pause button on this row. Pause pre-dated the walkie
  // inject-anytime flow and Josh never used it — gone. In its place, when a
  // card is present on the mobile deck, a Dictate/Play button reads the CURRENT
  // card aloud via the existing TTS machinery (playTts → /api/tts). On play it
  // expands into a transport cluster (Pause · Back10 · Fwd10) and a draggable
  // scrubber bar mounts ABOVE this row. All UI over the one shared <audio>.
  // Embedded-only: this is the phone surface Josh looks at.
  if (isEmbedded) buildDictationPlayer(btnRow, toolbar);

  // --- Docket button (Josh 2026-08-18) ---
  // The count/summary button lives IN this toolbar row now, between Dictate and
  // Prev — NOT floating in the lower-right corner (that stays the send buttons).
  // Always present on the phone; shows the live urgent count (0 included), muted
  // when calm and orange when there are needs-you cards. Tap toggles The Docket.
  if (isEmbedded) {
    let needsCount = 0;
    try { needsCount = computeUrgencyLists(queue).needsMe.length; } catch {}
    const docketBtn = document.createElement('button');
    docketBtn.className = 'toolbar-btn docket-toolbar-btn' + (needsCount > 0 ? ' has-needs' : '');
    docketBtn.innerHTML =
      `<span class="toolbar-icon docket-count">${needsCount}</span>` +
      '<span class="toolbar-label">Docket</span>';
    docketBtn.title = 'The Docket — what needs you';
    docketBtn.addEventListener('click', () => {
      const overlay = document.getElementById('urgency-overlay');
      if (overlay) overlay.classList.toggle('open');
    });
    btnRow.appendChild(docketBtn);

    // --- Links button (Josh 2026-08-23) ---
    // ALWAYS present on the phone toolbar, independent of whether the selected
    // steward has any cards on the deck. Before this, the only way into the
    // links dropdown was a per-card footer 🔗 — so an empty setting (zero cards)
    // had NO entry point. This mirrors the Docket button: live count (0
    // muted when empty, tap toggles the shared #card-links-dropdown.
    //
    // Josh 2026-09-09: the NUMBER is gone — "we can remove how many total links
    // there are, that's not really all that helpful or interesting". The count
    // still drives the has-links (muted vs lit) state, it just isn't printed.
    let linkCount = 0;
    try {
      linkCount = (window._cardLinks && typeof window._cardLinks.count === 'function')
        ? window._cardLinks.count() : 0;
    } catch {}
    const linksBtn = document.createElement('button');
    linksBtn.className = 'toolbar-btn links-toolbar-btn' + (linkCount > 0 ? ' has-links' : '');
    linksBtn.innerHTML =
      '<span class="toolbar-icon links-icon">🔗</span>' +
      '<span class="toolbar-label">Links</span>';
    linksBtn.title = 'Links for this steward';
    linksBtn.addEventListener('click', () => {
      if (window._cardLinks && typeof window._cardLinks.toggle === 'function') {
        window._cardLinks.toggle();
      }
    });
    btnRow.appendChild(linksBtn);
  }

  // Desktop: activity button (unchanged behavior).
  // Mobile: two-button card-nav cluster (◀ / ▶). Labels stay "Prev"/"Next"
  // so the actions are clear; a small count number sits next to each arrow
  // — current index by Prev, total by Next. Reads "◀ 5  PREV" / "▶ 17  NEXT".
  let activityBtn = null;
  let cardNavPrevBtn = null;
  let cardNavNextBtn = null;
  if (isEmbedded) {
    let deckCur = 0, deckTotal = 0;
    try {
      if (typeof window.mobileDeckGetState === 'function') {
        const st = window.mobileDeckGetState();
        deckTotal = st.count || 0;
        deckCur = (st.currentIndex >= 0 && deckTotal > 0) ? (st.currentIndex + 1) : 0;
        if (deckCur === 0 && deckTotal > 0) deckCur = 1;
      }
    } catch {}
    const prevCount = deckTotal > 0 ? `<span class="card-nav-count">${deckCur}</span>` : '';
    const nextCount = deckTotal > 0 ? `<span class="card-nav-count">${deckTotal}</span>` : '';

    cardNavPrevBtn = document.createElement('button');
    cardNavPrevBtn.className = 'toolbar-btn card-nav-btn card-nav-prev';
    cardNavPrevBtn.innerHTML =
      `<span class="toolbar-icon"><span class="card-nav-arrow">◀</span>${prevCount}<span class="card-nav-unread-badge" hidden></span></span>` +
      '<span class="toolbar-label">Prev</span>';
    cardNavPrevBtn.title = 'Previous card';
    btnRow.appendChild(cardNavPrevBtn);

    cardNavNextBtn = document.createElement('button');
    cardNavNextBtn.className = 'toolbar-btn card-nav-btn card-nav-next';
    cardNavNextBtn.innerHTML =
      `<span class="toolbar-icon"><span class="card-nav-arrow">▶</span>${nextCount}<span class="card-nav-unread-badge" hidden></span></span>` +
      '<span class="toolbar-label">Next</span>';
    cardNavNextBtn.title = 'Next card';
    btnRow.appendChild(cardNavNextBtn);
  } else {
    activityBtn = document.createElement('button');
    activityBtn.className = 'toolbar-btn';
    activityBtn.innerHTML =
      `<span class="toolbar-icon">⚡</span>` +
      `<span class="toolbar-label">Activity</span>`;
    btnRow.appendChild(activityBtn);
  }

  toolbar.appendChild(btnRow);

  // --- Expandable sections ---
  // Queue section (hidden by default — but persistent across re-renders).
  // The toolbar rebuilds on every queue poll (~5s); without this flag, an
  // open panel would slam shut every poll. window.__queueOpen survives the
  // rebuild and the open-state is restored below.
  const queuePanel = document.createElement('div');
  queuePanel.className = 'toolbar-panel queue-panel';
  queuePanel.style.display = window.__queueOpen ? '' : 'none';
  // In embedded mode the panel pops ABOVE the toolbar button row instead of
  // pushing content; History uses the same `docked-above-toolbar` treatment
  // so both dropdowns behave identically.
  if (isEmbedded) queuePanel.classList.add('docked-above-toolbar');

  // Filter footer — Josh's #3 TWO toggles, moved to the BOTTOM of the panel
  // ("move them as a configuration down to the bottom of this view").
  // DEFAULT both OFF = ALL messages. Flipping a chip persists it and rebuilds
  // the toolbar, re-opening the panel so the change feels instant.
  const filterHeader = document.createElement('div');
  filterHeader.className = 'queue-filter-header queue-filter-footer';

  function makeFilterChip(storageKey, active, labelOn, labelOff) {
    const chip = document.createElement('button');
    chip.className = 'queue-filter-chip' + (active ? ' active' : '');
    chip.textContent = (active ? '☑ ' : '☐ ') + (active ? labelOn : labelOff);
    chip.addEventListener('click', () => {
      const next = !active;
      try { localStorage.setItem(storageKey, next ? 'true' : 'false'); } catch {}
      renderBottomToolbar();
      setTimeout(() => {
        const t = document.getElementById('bottom-toolbar');
        const p = t && t.querySelector('.queue-panel');
        if (p) p.style.display = '';
      }, 0);
    });
    return chip;
  }

  filterHeader.appendChild(makeFilterChip('queue-only-mine', onlyMine, 'only my messages', 'only my messages'));
  filterHeader.appendChild(makeFilterChip('queue-only-this-steward', onlyThisSteward, 'only this steward', 'only this steward'));
  const filterCount = document.createElement('span');
  filterCount.className = 'queue-filter-count';
  filterHeader.appendChild(filterCount);

  const queueListEl = document.createElement('div');
  queueListEl.className = 'queue-list';
  queuePanel.appendChild(queueListEl);

  // Toggles live BELOW the list (Josh's #3 — bottom of the view).
  queuePanel.appendChild(filterHeader);

  // Render the unified log from cache. Called on build and again after a
  // fresh fetch resolves, so the list reflects live data without a full
  // toolbar rebuild.
  function fillUnifiedList() {
    const rows = getUnifiedRowsForSteward(selectedSteward, { onlyMine, onlyThisSteward });
    filterCount.textContent = `${rows.length} message${rows.length === 1 ? '' : 's'}`;
    queueListEl.innerHTML = '';
    if (rows.length > 0) {
      rows.forEach(entry => {
        try { queueListEl.appendChild(buildUnifiedRow(entry)); }
        catch (err) { console.error('[Presenter] buildUnifiedRow failed for', entry && entry.id, err); }
      });
    } else {
      const hint = (onlyMine || onlyThisSteward)
        ? 'No messages match these filters — toggle them off to see all traffic'
        : 'No messages yet';
      queueListEl.innerHTML = `<div style="padding:8px;color:#555;font-size:12px;text-align:center;">${hint}</div>`;
    }
  }
  // PERF (2026-08-29): the log panel is hidden until Josh taps "Log", but this
  // used to build EVERY row (up to ~400, ~800 markdown renders = ~500ms) on
  // every toolbar rebuild — i.e. on every card update, for a panel nobody's
  // looking at. Now we only fill when the panel is actually open; openQueuePanel
  // fills on demand. This is the single biggest per-render win.
  if (window.__queueOpen) {
    fillUnifiedList();
    // Refresh from the server (read-time merge) and re-render in place.
    fetchUnifiedLog(selectedSteward).then(() => {
      // Only re-fill if this panel is still open + current for this steward.
      if (window.__queueOpen && selectedSteward && queueListEl.isConnected) fillUnifiedList();
    });
  }

  toolbar.appendChild(queuePanel);

  // Activity section — desktop only.
  let activityPanel = null;
  if (!isEmbedded) {
    activityPanel = document.createElement('div');
    activityPanel.className = 'toolbar-panel';
    activityPanel.id = 'fixed-activity-log';
    activityPanel.style.display = 'none';
    const actSection = buildActivitySection(selectedSteward);
    if (actSection) {
      while (actSection.firstChild) activityPanel.appendChild(actSection.firstChild);
    } else {
      activityPanel.innerHTML = '<div style="padding:8px;color:#555;font-size:12px;text-align:center;">No activity</div>';
    }
    toolbar.appendChild(activityPanel);
  }

  // Toggle handlers
  let activePanel = window.__queueOpen ? queuePanel : null;
  function anchorQueuePanelToToolbar() {
    if (!isEmbedded) return;
    // Anchor the popover's bottom edge to the toolbar button row's TOP edge.
    // Composer is fixed at viewport-bottom and sits below the toolbar in
    // screen coords, so we measure from viewport-bottom to toolbar.top —
    // that covers the composer height + any gap automatically.
    const tbTop = toolbar.getBoundingClientRect().top;
    const distance = Math.max(0, window.innerHeight - tbTop);
    queuePanel.style.bottom = distance + 'px';
  }
  // If the panel is already open (sticky across rebuilds), re-anchor on render.
  // Also restore the engaged-state class on the Q button (toolbar
  // rebuilds every poll → button is a fresh DOM node, but
  // __queueOpen survives so we know to repaint engaged).
  // Close through this one path (toggle + tap-outside both call it) so the
  // panel display, activePanel, __queueOpen flag, and engaged-button paint
  // never desync. Joshua 2026-07-14.
  function closeQueuePanel() {
    queuePanel.style.display = 'none';
    activePanel = null;
    window.__queueOpen = false;
    queueBtn.classList.remove('is-engaged');
    if (_queueOutsideClick) {
      document.removeEventListener('click', _queueOutsideClick, true);
      _queueOutsideClick = null;
    }
  }
  function openQueuePanel() {
    queuePanel.style.display = '';
    // PERF (2026-08-29): the list is now built lazily (not eagerly on every
    // render), so populate it the moment the panel opens + fetch fresh data.
    fillUnifiedList();
    fetchUnifiedLog(selectedSteward).then(() => {
      if (window.__queueOpen && selectedSteward && queueListEl.isConnected) fillUnifiedList();
    });
    anchorQueuePanelToToolbar();
    if (activityPanel) activityPanel.style.display = 'none';
    activePanel = queuePanel;
    window.__queueOpen = true;
    queueBtn.classList.add('is-engaged');
    // Tap-outside-to-close: deferred capture-phase listener; closes iff the
    // click is outside both the panel and the queue toggle button.
    if (_queueOutsideClick) document.removeEventListener('click', _queueOutsideClick, true);
    _queueOutsideClick = function(e) {
      if (queuePanel.contains(e.target)) return;
      const qb = document.querySelector('#bottom-toolbar .queue-toggle-btn');
      if (qb && qb.contains(e.target)) return;
      closeQueuePanel();
    };
    setTimeout(() => document.addEventListener('click', _queueOutsideClick, true), 0);
  }
  if (window.__queueOpen) {
    anchorQueuePanelToToolbar();
    queueBtn.classList.add('is-engaged');
    // Panel is sticky-open across this rebuild — re-arm the outside-click
    // listener bound to THIS generation's DOM nodes.
    if (_queueOutsideClick) document.removeEventListener('click', _queueOutsideClick, true);
    _queueOutsideClick = function(e) {
      if (queuePanel.contains(e.target)) return;
      const qb = document.querySelector('#bottom-toolbar .queue-toggle-btn');
      if (qb && qb.contains(e.target)) return;
      closeQueuePanel();
    };
    setTimeout(() => document.addEventListener('click', _queueOutsideClick, true), 0);
  }
  queueBtn.addEventListener('click', () => {
    if (activePanel === queuePanel) {
      closeQueuePanel();
    } else {
      openQueuePanel();
    }
  });
  if (activityBtn) {
    activityBtn.addEventListener('click', () => {
      if (activePanel === activityPanel) {
        activityPanel.style.display = 'none';
        activePanel = null;
      } else {
        // Opening Activity closes the queue — route through closeQueuePanel()
        // so its outside-click listener is torn down too (desktop-only path).
        if (window.__queueOpen) closeQueuePanel();
        activityPanel.style.display = '';
        activePanel = activityPanel;
      }
    });
  }
  if (cardNavPrevBtn) cardNavPrevBtn.addEventListener('click', () => {
    if (typeof window.mobileDeckGoPrev === 'function') window.mobileDeckGoPrev();
  });
  if (cardNavNextBtn) cardNavNextBtn.addEventListener('click', () => {
    if (typeof window.mobileDeckGoNext === 'function') window.mobileDeckGoNext();
  });
  // Josh 2026-08-11: long-press (phone) / right-click (desktop) the Prev or
  // Next button opens a jump menu — Prev → first card, Next → last card.
  // Single-tap keeps its one-at-a-time behavior (click handlers above).
  // ignoreInteractiveChildren:false because the wired element IS a <button>;
  // the default ignore-selector would swallow the long-press on it.
  if (cardNavPrevBtn && typeof _wireCtxMenu === 'function') {
    _wireCtxMenu(cardNavPrevBtn, function () {
      return [{ label: '⇤ Jump to first card', onClick: function () {
        if (typeof window.mobileDeckGoFirst === 'function') window.mobileDeckGoFirst();
      } }];
    }, { ignoreInteractiveChildren: false });
  }
  if (cardNavNextBtn && typeof _wireCtxMenu === 'function') {
    _wireCtxMenu(cardNavNextBtn, function () {
      return [{ label: 'Jump to last card ⇥', onClick: function () {
        if (typeof window.mobileDeckGoLast === 'function') window.mobileDeckGoLast();
      } }];
    }, { ignoreInteractiveChildren: false });
  }

}

// --- Card dictation player (Josh 2026-08-12) ---
// Mounts into the bottom-toolbar btn-row (replacing the old Pause slot) plus a
// scrubber bar above it. Everything here is a thin view over the shared TTS
// <audio> (playTts / ttsAudio / ttsGetState / ttsSeekTo / ttsSkip). The toolbar
// rebuilds every queue poll (~5s), so state is reconstructed from ttsGetState()
// on each build and a per-build onTtsChange subscription keeps it live; the
// subscription self-detaches once its DOM leaves the document.
function ttsFmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

// Resolve the item currently displayed on the mobile deck (the same card the
// split-pill / card-nav operate on). Returns the queue item or null.
function getCurrentDeckItem() {
  try {
    const st = (typeof window.mobileDeckGetState === 'function') ? window.mobileDeckGetState() : null;
    if (!st || !st.currentItemId) return null;
    const q = (typeof queue !== 'undefined') ? queue : [];
    return q.find(i => i.id === st.currentItemId) || null;
  } catch { return null; }
}

function buildDictationPlayer(btnRow, toolbar) {
  const item = getCurrentDeckItem();
  if (!item) return;  // no card present → no dictate button (Josh: "if there is a card present")

  // Scrubber bar lives ABOVE the btn-row. We prepend it to the toolbar so it
  // stacks visually above the button row. Hidden until this card has audio.
  const scrub = document.createElement('div');
  scrub.className = 'tts-scrubber-bar';
  scrub.style.display = 'none';
  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'tts-scrubber-range';
  range.min = '0'; range.max = '1000'; range.value = '0'; range.step = '1';
  const timeCur = document.createElement('span');
  timeCur.className = 'tts-scrubber-time tts-scrubber-cur';
  timeCur.textContent = '0:00';
  const timeDur = document.createElement('span');
  timeDur.className = 'tts-scrubber-time tts-scrubber-dur';
  timeDur.textContent = '0:00';
  scrub.appendChild(timeCur);
  scrub.appendChild(range);
  scrub.appendChild(timeDur);
  toolbar.insertBefore(scrub, toolbar.firstChild);

  // While the user is dragging, don't let timeupdate ticks fight the thumb.
  let dragging = false;
  range.addEventListener('input', () => {
    dragging = true;
    const st = ttsGetState();
    if (st.duration > 0) {
      const t = (Number(range.value) / 1000) * st.duration;
      timeCur.textContent = ttsFmtTime(t);
    }
  });
  const commitSeek = () => {
    const st = ttsGetState();
    if (st.duration > 0) ttsSeekTo((Number(range.value) / 1000) * st.duration);
    dragging = false;
  };
  range.addEventListener('change', commitSeek);
  range.addEventListener('pointerup', commitSeek);

  // The transport slot: a single container we swap between the collapsed
  // Dictate button and the expanded Pause·Back10·Fwd10 cluster. Lives on the
  // btn-row where Pause used to be (before the card-nav arrows).
  const slot = document.createElement('div');
  slot.className = 'tts-transport-slot';
  btnRow.appendChild(slot);

  function makeBtn(cls, icon, label) {
    const b = document.createElement('button');
    b.className = 'toolbar-btn ' + cls;
    b.innerHTML = `<span class="toolbar-icon">${icon}</span>` +
      (label ? `<span class="toolbar-label">${label}</span>` : '');
    return b;
  }

  // Render the collapsed state: one Dictate/Play button.
  function renderCollapsed() {
    slot.innerHTML = '';
    slot.classList.remove('expanded');
    scrub.style.display = 'none';
    const st = ttsGetState();
    const loadingThis = st.loading && st.itemId === item.id;
    const dictate = makeBtn('tts-dictate-btn', loadingThis ? '&#x23F3;' : '&#x25B6;', loadingThis ? 'Loading' : 'Dictate');
    if (loadingThis) dictate.classList.add('loading');
    dictate.title = 'Read this card aloud';
    dictate.addEventListener('click', () => {
      // Fresh play of THIS card. playTts drives the shared audio; our
      // subscription flips us into the transport cluster on play.
      playTts(item, null);
    });
    slot.appendChild(dictate);
  }

  // Render the expanded transport: Pause/Play · Back10 · Fwd10, scrubber shown.
  function renderExpanded(st) {
    slot.innerHTML = '';
    slot.classList.add('expanded');

    const back = makeBtn('tts-back10-btn', '&#x21BA;10', 'Back');
    back.title = 'Back 10s (long-press: jump to start)';
    back.addEventListener('click', () => ttsSkip(-10));
    // Long-press → jump-to-start popup (reuses the shared ctx-menu helper).
    if (typeof _wireCtxMenu === 'function') {
      _wireCtxMenu(back, () => ([{ label: '⏮ Jump to beginning', onClick: () => ttsSeekTo(0) }]),
        { ignoreInteractiveChildren: false });
    }

    const playPause = makeBtn('tts-playpause-btn', st.playing ? '&#x23F8;' : '&#x25B6;', st.playing ? 'Pause' : 'Play');
    playPause.addEventListener('click', () => { if (ttsGetState().playing) ttsPause(); else ttsResume(); });

    const fwd = makeBtn('tts-fwd10-btn', '10&#x21BB;', 'Fwd');
    fwd.title = 'Forward 10s';
    fwd.addEventListener('click', () => ttsSkip(10));

    slot.appendChild(back);
    slot.appendChild(playPause);
    slot.appendChild(fwd);

    // Scrubber visible + synced.
    scrub.style.display = '';
    syncTransport(st);
    syncScrubber(st);
  }

  // In-place update of the play/pause button label/icon (no rebuild → keeps the
  // Back10 long-press wiring intact). Called live on every state change.
  function syncTransport(st) {
    const pp = slot.querySelector('.tts-playpause-btn');
    if (!pp) return;
    const icon = pp.querySelector('.toolbar-icon');
    const label = pp.querySelector('.toolbar-label');
    if (icon) icon.innerHTML = st.playing ? '&#x23F8;' : '&#x25B6;';
    if (label) label.textContent = st.playing ? 'Pause' : 'Play';
    pp.title = st.playing ? 'Pause' : 'Play';
  }

  function syncScrubber(st) {
    timeDur.textContent = ttsFmtTime(st.duration);
    if (!dragging) {
      timeCur.textContent = ttsFmtTime(st.currentTime);
      range.value = st.duration > 0 ? String(Math.round((st.currentTime / st.duration) * 1000)) : '0';
    }
  }

  // Decide collapsed vs expanded from live state, and paint.
  function paint() {
    const st = ttsGetState();
    // Expanded whenever this card owns the player AND audio is loaded (playing
    // or paused mid-listen). Loading-but-no-audio-yet stays collapsed (spinner).
    if (st.itemId === item.id && st.hasAudio) renderExpanded(st);
    else renderCollapsed();
  }

  paint();

  // Live subscription — self-detaches when this row leaves the DOM (next
  // toolbar rebuild replaces it, so the stale listener must not keep firing).
  const unsub = onTtsChange((st) => {
    if (!slot.isConnected) { unsub(); return; }
    if (st.itemId === item.id && st.hasAudio) {
      if (!slot.classList.contains('expanded')) renderExpanded(st);
      else { syncTransport(st); syncScrubber(st); }  // cheap in-place update, no rebuild
    } else {
      if (slot.classList.contains('expanded') || scrub.style.display !== 'none') renderCollapsed();
    }
  });
}

function formatRelativeTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  if (typeof s !== 'string') s = String(s == null ? '' : s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Build chat-style messages ---

function buildChatMessages(item, isArchived) {
  const elements = [];
  const steward = findStewardForSession(item.session_id || selectedSteward);
  const stewardIcon = steward ? (steward.icon || steward.shorthand) : '?';
  const stewardName = steward ? dnHumanize(steward.name) : sessionDisplayName(item.session_id);
  const stewardColor = steward ? steward.color : '#00FF66';
  const isUnread = !readState[item.id] && !isArchived;

  // --- Steward message (left-aligned) ---
  const row = document.createElement('div');
  row.className = 'chat-row from-steward' + (isArchived ? ' archived-row' : '');

  const wrapper = document.createElement('div');
  const isEmbedded = document.body.classList.contains('embedded');
  wrapper.style.maxWidth = isEmbedded ? '100%' : '95%';

  // Avatar bar
  const avatarBar = document.createElement('div');
  avatarBar.className = 'msg-avatar-bar steward';
  avatarBar.style.borderColor = stewardColor;
  avatarBar.style.background = stewardColor + '15';

  const avIcon = document.createElement('span');
  avIcon.className = 'avatar-icon';
  avIcon.textContent = stewardIcon;
  avatarBar.appendChild(avIcon);

  const avName = document.createElement('span');
  avName.className = 'avatar-name';
  avName.textContent = stewardName;
  avatarBar.appendChild(avName);

  // Source line — which build/substeward sent this (prominent for substewards)
  const sourceSessionId = item.session_id || item.callback_session;
  const sourceSub = findSubstewardForSession(sourceSessionId);
  if (sourceSub) {
    const avSource = document.createElement('span');
    avSource.className = 'avatar-source avatar-source-sub';
    avSource.textContent = (sourceSub.icon ? sourceSub.icon + ' ' : '') + (sourceSub.name || sourceSub.id);
    avatarBar.appendChild(avSource);
  } else {
    const sourceLabel = item.source || parseSourceFromSession(sourceSessionId);
    if (sourceLabel) {
      const avSource = document.createElement('span');
      avSource.className = 'avatar-source';
      avSource.textContent = 'via ' + sourceLabel;
      avatarBar.appendChild(avSource);
    }
  }

  // Time block — actual time + relative
  const ts = item.timestamp || item.created_at;
  const timeBlock = document.createElement('span');
  timeBlock.className = 'avatar-time-block';
  const actualTime = formatActualTime(ts);
  if (actualTime) {
    const timeActual = document.createElement('span');
    timeActual.className = 'avatar-time-actual';
    timeActual.textContent = actualTime;
    timeBlock.appendChild(timeActual);
  }
  const timeRel = document.createElement('span');
  timeRel.className = 'avatar-time-relative';
  timeRel.textContent = relativeTime(ts) + ' ago';
  timeBlock.appendChild(timeRel);
  avatarBar.appendChild(timeBlock);

  if (!isArchived) {
    const ttsBtn = document.createElement('button');
    ttsBtn.className = 'btn-tts';
    ttsBtn.innerHTML = '&#x1F50A;';
    if (ttsItemId === item.id) {
      if (ttsPlaying) { ttsBtn.classList.add('playing'); ttsBtn.innerHTML = '&#x23F8;'; }
      else if (ttsAudio) { ttsBtn.innerHTML = '&#x25B6;'; }
      ttsActiveBtn = ttsBtn;
    }
    ttsBtn.addEventListener('click', () => playTts(item, ttsBtn));
    avatarBar.appendChild(ttsBtn);

    // Dismiss button moved to bottom actions area
  }

  wrapper.appendChild(avatarBar);

  // Message bubble
  const bubble = document.createElement('div');
  const _layoutPref = getLayoutPref(item.session_id || selectedSteward);
  bubble.className = 'msg-bubble from-steward'
    + (isArchived ? ' archived' : ' active')
    + (isUnread ? ' unread' : '')
    + (item.pinned ? ' pinned' : '')
    + (!isArchived && _layoutPref === 'side-by-side' ? ' layout-side-by-side' : '');
  bubble.style.borderColor = stewardColor;
  bubble.dataset.itemId = item.id;

  // Re-apply mid-dismiss hidden state after a re-render (2026-07-31 nav
  // regression). renderThread() rebuilds this bubble fresh from `queue`, which
  // still holds cards whose 5s undo countdown hasn't committed. Without this,
  // the bubble comes back visible + "live" and rapid multi-dismiss nav lands
  // on an already-dismissing card. pendingDismissIds is the source of truth.
  if (!isArchived && typeof pendingDismissIds !== 'undefined' && pendingDismissIds.has(item.id)) {
    bubble.classList.add('optimistic-dismissed');
    bubble.style.display = 'none';
    bubble.setAttribute('aria-hidden', 'true');
  }

  // Pin corner badge — persistent marker on pinned cards. Re-added on every
  // render so it survives re-renders after other items change.
  if (item.pinned && !isArchived) {
    const badge = document.createElement('span');
    badge.className = 'msg-pin-badge';
    badge.textContent = '📌';
    badge.title = 'Pinned — excluded from bulk-dismiss';
    bubble.appendChild(badge);
  }

  // Card title — large and prominent
  if (item.title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'msg-card-title';
    titleEl.textContent = item.title;
    bubble.appendChild(titleEl);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';
  const messageText = parseMessageContent(item.message || '');
  if (messageText) {
    body.innerHTML = renderMarkdown(messageText);
    processLinks(body);
  }
  bubble.appendChild(body);

  // Custom component (additive — renders below message, above input/buttons)
  if (item.component && !isArchived) {
    // Reuse cached component DOM if available — preserves in-progress
    // typing, expand/collapse state, and any other internal state across
    // re-renders triggered by new-item / resolved socket events.
    const cached = window._componentCache && window._componentCache[item.id];
    if (cached) {
      bubble.appendChild(cached);
      delete window._componentCache[item.id];
    } else {
      const compEl = renderCardComponent(item);
      if (compEl) {
        const wrap = document.createElement('div');
        wrap.className = 'msg-component';
        wrap.appendChild(compEl);
        bubble.appendChild(wrap);
      }
    }
  }

  // Active: response area (input + buttons)
  // ALWAYS show text input — every card must allow free-form response, no exceptions
  if (!isArchived) {
    {
      const inputWrap = document.createElement('div');
      inputWrap.className = 'msg-input-wrap';

      // Per-card layout toggle — lives at top of input-wrap so Joshua sees it
      // right where he's typing. Click flips stacked ↔ side-by-side and saves
      // the pref per-steward.
      const layoutToggle = document.createElement('button');
      layoutToggle.type = 'button';
      layoutToggle.className = 'msg-layout-toggle';
      const sessionForLayout = item.session_id || selectedSteward;
      function paintLayoutToggle() {
        const mode = getLayoutPref(sessionForLayout);
        layoutToggle.textContent = (mode === 'side-by-side') ? '⊟ Stack' : '⊞ Side-by-side';
        layoutToggle.title = (mode === 'side-by-side')
          ? 'Switch to stacked layout (input below content)'
          : 'Switch to side-by-side layout (input next to content)';
      }
      paintLayoutToggle();
      layoutToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cur = getLayoutPref(sessionForLayout);
        const next = (cur === 'side-by-side') ? 'stacked' : 'side-by-side';
        setLayoutPref(sessionForLayout, next);
        // Apply to every visible bubble for this session — no full re-render needed.
        document.querySelectorAll('.msg-bubble[data-item-id]').forEach(b => {
          b.classList.toggle('layout-side-by-side', next === 'side-by-side');
        });
        paintLayoutToggle();
      });
      inputWrap.appendChild(layoutToggle);

      const textarea = document.createElement('textarea');
      textarea.className = 'msg-input';
      textarea.placeholder = 'Type your response...';
      textarea.rows = 2;
      // Restore any persisted draft for this card.
      const restoredDraft = getDraft(sessionForLayout, item.id);
      if (restoredDraft) textarea.value = restoredDraft;
      // Persist drafts on every keystroke.
      textarea.addEventListener('input', () => {
        setDraft(sessionForLayout, item.id, textarea.value);
      });
      // Reply survival is driven by the card's own 📌 pin (Josh 2026-07-14
      // unification): a PINNED card stays in the deck when you reply (steward
      // still gets the reply + card context); an UNPINNED card dismisses as
      // normal. `item.pinned` is mutated live by the pin toggle, so reading it
      // here always reflects the current state of the card this input belongs
      // to. One sticky control — no separate keep-card toggle or per-send menu.
      function sendTextResponse() {
        // Josh 2026-08-30: this bare `if (!text) return` was the far end of the
        // native-box send bug — the split-pill fired this button with nothing
        // staged and the reply evaporated with no error. Text now arrives here
        // reliably (readComposerText + native mirroring), but an empty send must
        // still SAY so rather than vanish.
        const text = textarea.value.trim();
        if (!text) {
          console.warn('[card-send] nothing to send for card ' + item.id);
          showErrorToast('Nothing to send — type something first.');
          return;
        }
        bubble.querySelectorAll('.msg-btn').forEach(b => { b.disabled = true; });
        stopTts();
        showInlineUndo(item, 'Reply', text, bubble, wrapper, row, !!item.pinned);
      }
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.metaKey) {
          e.preventDefault();
          sendTextResponse();
        }
      });
      const sendBtn = document.createElement('button');
      sendBtn.className = 'msg-send-btn';
      sendBtn.innerHTML = '➤';
      sendBtn.title = 'Send (⌘+Enter)';
      sendBtn.dataset.cardId = item.id;

      // Unified send: if pulsing green (has-recording), do Send Here logic; else normal text send
      sendBtn.addEventListener('click', () => {
        if (sendBtn.classList.contains('has-recording')) {
          // Send Here logic — claim recording/text from phone or Whisper Village
          const isAndroid = !!(window.Android && window.Android.getRecordingStatus);
          const resetBtn = () => { sendBtn.innerHTML = '➤'; sendBtn.disabled = false; bubble.querySelectorAll('.msg-btn').forEach(b => { b.disabled = false; }); };
          const disableAll = () => { sendBtn.disabled = true; bubble.querySelectorAll('.msg-btn').forEach(b => { b.disabled = true; }); };

          function tryTextFallback() {
            const bottomTextarea = document.getElementById('conv-bottom-textarea');
            const text = bottomTextarea ? bottomTextarea.value.trim() : '';
            if (text) {
              stopTts();
              __bottomBarSendOriginText = text;
              bottomTextarea.value = '';
              if (typeof window.__composerClearActiveDraft === 'function') window.__composerClearActiveDraft();
              showInlineUndo(item, 'Reply', text, bubble, wrapper, row, !!item.pinned); return;
            }
            const cardText = textarea.value.trim();
            if (cardText) { stopTts(); showInlineUndo(item, 'Reply', cardText, bubble, wrapper, row, !!item.pinned); return; }
            sendBtn.innerHTML = '!';
            setTimeout(resetBtn, 1500);
          }

          // Source-aware delivery confirmation and retry.
          // Android: phone handles transcribe+respond pipeline. We just poll for card removal.
          //   Auto-retry = extended poll (phone may still be working). Manual retry = text fallback.
          // Whisper Village: claim is fire-and-forget. We poll for card removal.
          //   Auto-retry = fetch transcript via /peek, send directly. Manual retry = /peek or text.
          let autoRetried = false;
          let sendSource = null; // 'android' or 'whisper-village'

          function awaitCardDelivery() {
            sendBtn.innerHTML = '🎤';
            sendBtn.title = 'Transcribing...';
            // Android gets more time (transcription goes phone→server→back→respond)
            const timeout = sendSource === 'android' ? 35000 : 25000;
            waitForDeliveryConfirmation(item.id, timeout).then(() => {
              sendBtn.innerHTML = '✓';
              sendBtn.title = 'Delivered';
              setTimeout(resetBtn, 2000);
            }).catch(err => {
              console.error(`[CardSend][${sendSource}] Delivery check failed:`, err);
              if (!autoRetried) {
                autoRetried = true;
                autoRetry();
                return;
              }
              showFinalFailure();
            });
          }

          function autoRetry() {
            sendBtn.innerHTML = '⏳';
            sendBtn.title = 'Auto-retrying...';

            if (sendSource === 'android') {
              // Android: the phone pipeline may still be running. Give it more poll time.
              // Don't try Whisper Village — the audio is on the phone, not the Mac.
              console.log('[CardSend][android] Auto-retry: extending poll time...');
              waitForDeliveryConfirmation(item.id, 15000).then(() => {
                sendBtn.innerHTML = '✓';
                sendBtn.title = 'Delivered';
                setTimeout(resetBtn, 2000);
              }).catch(() => {
                console.error('[CardSend][android] Auto-retry poll also timed out');
                showFinalFailure();
              });
            } else {
              // Whisper Village: try /peek to get any transcript that was produced
              console.log('[CardSend][whisper-village] Auto-retry: fetching transcript via peek...');
              fetch('http://localhost:8179/peek', { method: 'POST' })
                .then(r => r.ok ? r.json() : null)
                .then(data => {
                  if (data && data.transcript && data.transcript.trim()) {
                    console.log('[CardSend] Auto-retry with transcript:', data.transcript.substring(0, 50));
                    return window.presenter.respond(item.id, 'Reply', data.transcript.trim(), !!item.pinned);
                  }
                  throw new Error('No transcript from peek');
                })
                .then(() => {
                  sendBtn.innerHTML = '✓';
                  sendBtn.title = 'Delivered (retried)';
                  setTimeout(resetBtn, 2000);
                })
                .catch(retryErr => {
                  console.error('[CardSend][whisper-village] Auto-retry failed:', retryErr);
                  showFinalFailure();
                });
            }
          }

          function showFinalFailure() {
            sendBtn.innerHTML = '❌';
            sendBtn.title = 'Failed';
            const source = sendSource === 'android' ? 'Phone' : 'Whisper Village';
            showErrorToast(`${source} send failed — tap Retry to resend as text`, () => {
              sendBtn.innerHTML = '⏳'; sendBtn.title = 'Retrying...'; disableAll();
              // For manual retry: try to get transcript (source-appropriate), fall back to text input
              const peekPromise = sendSource === 'android'
                ? Promise.resolve(null) // Don't try Whisper Village for Android recordings
                : fetch('http://localhost:8179/peek', { method: 'POST' }).then(r => r.ok ? r.json() : null).catch(() => null);
              peekPromise.then(data => {
                const transcript = (data && data.transcript) ? data.transcript.trim() : '';
                const fallbackText = textarea.value.trim() || document.getElementById('conv-bottom-textarea')?.value?.trim() || '';
                const textToSend = transcript || fallbackText;
                if (textToSend) {
                  return window.presenter.respond(item.id, 'Reply', textToSend, !!item.pinned).then(() => {
                    sendBtn.innerHTML = '✓'; sendBtn.title = 'Delivered';
                    setTimeout(resetBtn, 2000);
                  });
                }
                throw new Error('No text available');
              }).catch(() => {
                resetBtn();
                showErrorToast('Retry failed — type your message in the text field and send');
              });
            });
            setTimeout(resetBtn, 8000);
          }

          if (isAndroid) {
            try {
              const status = JSON.parse(window.Android.getRecordingStatus());
              if (status.isRecording || status.hasRecording) {
                sendSource = 'android';
                stopTts(); sendBtn.innerHTML = '⏳'; sendBtn.title = 'Claiming...'; disableAll();
                window.Android.claimRecordingForCard(item.id);
                awaitCardDelivery();
                return;
              }
              if (status.hasText) {
                sendSource = 'android';
                stopTts(); sendBtn.innerHTML = '⏳'; sendBtn.title = 'Claiming...'; disableAll();
                window.Android.claimTextForCard(item.id);
                awaitCardDelivery();
                return;
              }
            } catch (e) { console.log('[CardSend] Android bridge error:', e); }
            tryTextFallback();
            return;
          }

          // Desktop: Whisper Village claim
          sendSource = 'whisper-village';
          stopTts(); sendBtn.innerHTML = '⏳'; sendBtn.title = 'Claiming...'; disableAll();
          fetch('http://localhost:8179/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cardId: item.id })
          }).then(res => {
            if (!res.ok) throw new Error('Claim failed');
            awaitCardDelivery();
          }).catch(err => {
            console.log('[CardSend] Whisper Village unavailable, trying text:', err);
            resetBtn();
            tryTextFallback();
          });
        } else {
          // Normal text send. Survival is governed by the card's own 📌 pin
          // (Josh 2026-07-14 unification): sendTextResponse reads item.pinned.
          // This is the funnel every send path hits (pill-card tap, bottom ➤,
          // Enter all route through cardSend.click()), so the pin governs them
          // all from one place.
          sendTextResponse();
        }
      });

      // Expose this card's send so the BOTTOM-BAR composer path can route a
      // typed reply to the active card. Survival is decided by item.pinned
      // inside sendTextResponse — there's no per-send keep flag anymore.
      bubble.__sendCardReply = function (text) {
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        sendTextResponse();
      };

      const inputRow = document.createElement('div');
      inputRow.className = 'msg-input-row';
      inputRow.appendChild(textarea);
      inputRow.appendChild(sendBtn);
      inputWrap.appendChild(inputRow);
      bubble.appendChild(inputWrap);
    }

    if (item.buttons && item.buttons.length > 0) {
      const buttonsWrap = document.createElement('div');
      buttonsWrap.className = 'msg-buttons';
      item.buttons.forEach(btnDef => {
        const label = typeof btnDef === 'string' ? btnDef : btnDef.label;
        const run = typeof btnDef === 'object' ? btnDef.run : null;
        const btn = document.createElement('button');
        btn.className = 'msg-btn' + (run ? ' run-btn has-action' : '');
        btn.textContent = label;
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          if (run) {
            const isEmbedded = document.body.classList.contains('embedded');
            const isDirectDeepLink = /^(sms:|tel:|mailto:|geo:|market:)/.test(run);
            // Extract deep link URI from curl commands targeting the phone API
            const phoneUriMatch = run.match(/(sms|tel|mailto|geo|market):[^\s'"\\}]+/);

            if (isDirectDeepLink) {
              // Direct URI (sms:..., tel:...)
              console.log('[Presenter] Direct deep link:', run, 'embedded:', isEmbedded);
              if (isEmbedded && window.Android && window.Android.openUri) {
                window.Android.openUri(run);
              } else if (isEmbedded) {
                window.location.href = run; // fallback
              } else if (window.presenter.phoneOpenUri) {
                window.presenter.phoneOpenUri(run);
              } else {
                // Browser fallback — may fail due to CORS
                fetch('http://<<REPLACE: your Tailscale IP>>:8888/open-uri', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ uri: run })
                }).catch(err => console.error('[Presenter] Phone open-uri fetch failed:', err));
              }
            } else if (phoneUriMatch) {
              // Curl command containing a deep link — extract and open directly
              const uri = phoneUriMatch[0];
              console.log('[Presenter] Extracted URI from run command:', uri, 'embedded:', isEmbedded);
              if (isEmbedded && window.Android && window.Android.openUri) {
                window.Android.openUri(uri);
              } else if (isEmbedded) {
                window.location.href = uri; // fallback
              } else if (window.presenter.phoneOpenUri) {
                window.presenter.phoneOpenUri(uri);
              } else {
                fetch('http://<<REPLACE: your Tailscale IP>>:8888/open-uri', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ uri })
                }).catch(err => console.error('[Presenter] Phone open-uri fetch failed:', err));
              }
            } else if (isEmbedded && extractAndRewriteOpenUrl(run)) {
              // Embedded: rewrite localhost URLs and open directly
              const url = extractAndRewriteOpenUrl(run);
              console.log('[Presenter] Embedded open URL (rewritten):', url);
              if (window.Android && window.Android.openUri) {
                window.Android.openUri(url);
              } else {
                window.open(url, '_blank');
              }
            } else {
              // Regular shell command
              console.log('[Presenter] Running command:', run);
              window.presenter.runCommand(run);
            }
            btn.disabled = true;
            btn.textContent = `${label} ✓`;
            setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 3000);
            return;
          }
          // Disable all buttons to prevent double-send
          bubble.querySelectorAll('.msg-btn').forEach(b => { b.disabled = true; });
          const textarea = bubble.querySelector('.msg-input');
          const text = textarea ? textarea.value.trim() : undefined;
          stopTts();
          // Show inline undo bubble — delay actual send by 5 seconds. A PINNED
          // card survives every action route including button clicks (Josh
          // 2026-07-14 unification: pin = sticks no matter what you do to it,
          // except an explicit ✕ dismiss).
          showInlineUndo(item, label, text, bubble, wrapper, row, !!item.pinned);
        });
        buttonsWrap.appendChild(btn);
      });
      bubble.appendChild(buttonsWrap);
    }

    // Pin button — save the card from bulk-dismiss. Can still be dismissed
    // individually. Toggles `pinned` via POST /api/presenter/toggle-pin/:id.
    //
    // Optimistic: flip the button + card visual state BEFORE the POST lands.
    // Joshua said "Click = visible change in the same frame." Roll back on
    // POST error. Apply the `pinned` class to the bubble for the card-wide
    // tint/glow, add a corner badge, bounce the button.
    const pinBtn = document.createElement('button');
    function applyPinVisual(isPinned) {
      if (isPinned) {
        pinBtn.classList.add('pinned');
        pinBtn.textContent = '📌 Pinned';
        pinBtn.title = 'Pinned — excluded from bulk-dismiss. Click to unpin.';
        bubble.classList.add('pinned');
        // Add/ensure corner badge exists
        let badge = bubble.querySelector('.msg-pin-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'msg-pin-badge';
          badge.textContent = '📌';
          badge.title = 'Pinned';
          bubble.appendChild(badge);
        }
      } else {
        pinBtn.classList.remove('pinned');
        pinBtn.textContent = '📌 Pin';
        pinBtn.title = 'Pin this card so it\'s skipped by bulk-dismiss';
        bubble.classList.remove('pinned');
        const badge = bubble.querySelector('.msg-pin-badge');
        if (badge) badge.remove();
      }
      // Short bounce animation reinforces the state change
      pinBtn.classList.remove('pin-bounce');
      // Force reflow so the class removal + re-add actually replays the animation
      void pinBtn.offsetWidth;
      pinBtn.classList.add('pin-bounce');
    }
    pinBtn.className = 'msg-btn msg-btn-pin';
    applyPinVisual(!!item.pinned);
    pinBtn.addEventListener('click', async () => {
      if (pinBtn.disabled) return;
      const wasPinned = bubble.classList.contains('pinned');
      const nextPinned = !wasPinned;
      // Optimistic flip — same frame as click
      applyPinVisual(nextPinned);
      pinBtn.disabled = true;
      try {
        const SERVER_URL = window.location.origin || 'http://localhost:3005';
        const res = await fetch(`${SERVER_URL}/api/presenter/toggle-pin/${item.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: nextPinned }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // Mutate the in-memory item too, so subsequent re-renders preserve state
        item.pinned = nextPinned;
      } catch (err) {
        console.error('[Presenter] pin toggle failed — rolling back:', err);
        applyPinVisual(wasPinned);
      } finally {
        pinBtn.disabled = false;
      }
    });
    bubble.appendChild(pinBtn);

    // Dismiss button — always at bottom, muted style.
    // Optimistic flow (Josh 2026-04-21): tap → card instantly hidden +
    // advance + bar undo toast. Tap UNDO during countdown = un-hide and
    // cancel. If countdown expires, fire the real dismiss.
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'msg-btn msg-btn-dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      stopTts();
      if (convThread) preserveScrollPosition = convThread.scrollTop;
      optimisticDismiss(item, bubble);
    });
    bubble.appendChild(dismissBtn);

    // R21 (Josh 2026-04-21): floating persistent pin + dismiss, bottom-right
    // of the card. Always visible regardless of body scroll. Triggers the
    // SAME handlers as the in-body buttons — pinBtn.click() / dismissBtn.click()
    // — so there's only one source of truth for each action. If either
    // in-body button changes state or gets disabled, the persistent ones
    // inherit that via pointer-event forwarding (no state sync needed).
    if (document.body.classList.contains('embedded')) {
      // R4 (Josh 2026-08-13): action buttons are FIXED to the card frame in a
      // full-width footer bar — Dismiss + Links (left→right), with the Pin as a
      // compact glyph. The bar is appended to the .chat-row (the card FRAME =
      // .mobile-deck-card, position:absolute inset:0), NOT the scrolling bubble,
      // so it never scrolls with body content. This replaces the R21 floating
      // bottom-right pin/dismiss pair. Every button forwards to the canonical
      // in-body handler (dismissBtn.click() / pinBtn.click()) — one source of
      // truth per action, no logic dup.
      const footer = document.createElement('div');
      footer.className = 'card-footer-actions';

      // Dismiss — icon only (✕), matching the pre-R4 glyph (Josh R5 2026-08-13).
      const floatDismiss = document.createElement('button');
      floatDismiss.type = 'button';
      floatDismiss.className = 'card-footer-btn card-footer-icon card-footer-dismiss';
      floatDismiss.title = 'Dismiss this card';
      floatDismiss.textContent = '✕';
      floatDismiss.setAttribute('aria-label', 'Dismiss this card');
      floatDismiss.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        dismissBtn.click();
      });
      footer.appendChild(floatDismiss);

      // Links — just the icon (🔗). Opens the shared #card-links-dropdown.
      //
      // Josh 2026-09-09 RETIRES the count that R5 asked for ("keep the number
      // displayed"): "we can remove how many total links there are, that's not
      // really all that helpful or interesting." Same call as the toolbar
      // button, so both entry points into the panel read the same.
      const linksBtn = document.createElement('button');
      linksBtn.type = 'button';
      linksBtn.className = 'card-footer-btn card-footer-icon card-footer-links';
      function paintLinksBtn() {
        linksBtn.innerHTML = '';
        const ic = document.createElement('span');
        ic.className = 'card-footer-link-icon';
        ic.textContent = '🔗';
        linksBtn.appendChild(ic);
        linksBtn.title = 'Links for this steward';
        linksBtn.setAttribute('aria-label', linksBtn.title);
      }
      paintLinksBtn();
      linksBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        if (window._cardLinks && typeof window._cardLinks.toggle === 'function') {
          window._cardLinks.toggle();
        }
      });
      footer.appendChild(linksBtn);

      const floatPin = document.createElement('button');
      floatPin.type = 'button';
      floatPin.className = 'card-footer-btn card-footer-icon card-footer-pin' + (item.pinned ? ' pinned' : '');
      floatPin.title = item.pinned ? 'Unpin this card' : 'Pin this card';
      floatPin.textContent = item.pinned ? '📌' : '📍';
      // Keep the footer pin glyph in sync with the in-body pinBtn's .pinned
      // class. applyPinVisual runs on every toggle so just observe the
      // bubble's `.pinned` class via a mutation observer.
      const syncFloatPin = () => {
        const nowPinned = bubble.classList.contains('pinned');
        floatPin.textContent = nowPinned ? '📌' : '📍';
        floatPin.classList.toggle('pinned', nowPinned);
        floatPin.title = nowPinned ? 'Unpin this card' : 'Pin this card';
      };
      const bubbleObserver = new MutationObserver(syncFloatPin);
      bubbleObserver.observe(bubble, { attributes: true, attributeFilter: ['class'] });
      floatPin.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        pinBtn.click();
      });
      footer.appendChild(floatPin);

      row.appendChild(footer);
    }

    // Send Here removed — unified into card send arrow button (pulses green when input ready)
  }

  // --- User response INSIDE the same bubble (for archived items with feedback) ---
  if (isArchived && (item.feedback || item.feedback_button || item.feedback_text)) {
    const fb = item.feedback || {};
    const fbButton = fb.button || item.feedback_button;
    const fbText = fb.text || item.feedback_text;
    const fbDismissed = fb.dismissed || item.feedback_dismissed;

    if (fbButton || fbText || fbDismissed) {
      const responseSection = document.createElement('div');
      responseSection.className = 'msg-inline-response';

      const responseLabel = document.createElement('div');
      responseLabel.className = 'msg-response-label';
      responseLabel.textContent = fbDismissed ? 'Dismissed' : '👤 You replied:';
      responseSection.appendChild(responseLabel);

      if (fbButton && !fbDismissed) {
        const btnEl = document.createElement('div');
        btnEl.className = 'msg-response-button';
        btnEl.textContent = fbButton;
        responseSection.appendChild(btnEl);
      }
      if (fbText) {
        const textEl = document.createElement('div');
        textEl.className = 'msg-response-text';
        textEl.textContent = fbText;
        responseSection.appendChild(textEl);
      }

      bubble.appendChild(responseSection);
    }
  }

  // Card-level context menu was removed per Joshua's request — only the steward
  // icons in the bottom toolbar carry the right-click / long-press menu now.

  wrapper.appendChild(bubble);
  row.appendChild(wrapper);
  elements.push(row);

  return elements;
}

// Build the menu items for a card's context menu. Returns [] if the card's
// session is no longer visible in the presenter (worker torn down) — in that
// case the menu is suppressed entirely so we don't offer a stale attach.
function buildBubbleCtxMenuItems(item) {
  const sessionId = (item && (item.session_id || item.callback_session)) || null;
  if (!window._isSessionVisibleInPresenter(sessionId)) return [];
  const items = [];
  items.push({
    label: 'Copy attach command',
    onClick: function () {
      // Peek-window wrapper. Lands the user in a fresh shell beside the live
      // session window; `exit` / Ctrl-D kills only the peek window and runs
      // detach-client, so the underlying session keeps running.
      const cmd = 'tmux new-window -t ' + sessionId + ' -n peek '
        + '\'echo "Welcome to peek window. Ctrl-b 0 = view session, Ctrl-b 1 = back here, exit = leave safely."; '
        + '$SHELL; tmux detach-client\' \\; attach -t ' + sessionId;
      window._presenterCopyText(cmd).then(function (ok) {
        if (ok) showInfoToast('Copied attach command');
        else showErrorToast('Copy failed — long-press the text to copy: ' + cmd);
      });
    }
  });
  return items;
}

// Generic right-click + long-press wiring, shared by card bubbles and
// the topbar/subbar/sub-sub icons. `getItems` returns the menu items at
// the moment of trigger (lets the allowlist re-check live each time).
function _wireCtxMenu(el, getItems, opts) {
  if (!el) return;
  const ignoreSelector = (opts && opts.ignoreInteractiveChildren !== false)
    ? 'button, a, input, textarea, select, .msg-input, .msg-btn, .card-footer-btn, .btn-tts'
    : null;
  el.addEventListener('contextmenu', function (ev) {
    const items = getItems();
    if (!items || items.length === 0) return;
    ev.preventDefault();
    window._presenterCtxMenu.open({ x: ev.clientX, y: ev.clientY, items: items });
  });
  let pressTimer = null;
  let startX = 0, startY = 0;
  let pressing = false;
  function clearPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressing = false;
  }
  el.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (ignoreSelector) {
      const t = ev.target;
      if (t && t.closest && t.closest(ignoreSelector)) return;
    }
    pressing = true;
    startX = ev.clientX;
    startY = ev.clientY;
    pressTimer = setTimeout(function () {
      if (!pressing) return;
      const items = getItems();
      if (!items || items.length === 0) return;
      window._presenterCtxMenu.open({ x: startX, y: startY, items: items });
      pressing = false;
      pressTimer = null;
    }, 500);
  }, { passive: true });
  el.addEventListener('pointermove', function (ev) {
    if (!pressing) return;
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if ((dx * dx + dy * dy) > 64) clearPress();
  }, { passive: true });
  el.addEventListener('pointerup', clearPress, { passive: true });
  el.addEventListener('pointercancel', clearPress, { passive: true });
  el.addEventListener('pointerleave', clearPress, { passive: true });
}

// Wire long-press + contextmenu on a card's .msg-bubble. Pointer events
// cover mouse, touch, and pen across Electron + APK WebView.
function attachBubbleContextMenu(bubble, item) {
  if (!bubble || !item) return;
  _wireCtxMenu(bubble, function () { return buildBubbleCtxMenuItems(item); });
}

// Build menu items for a steward/substeward icon. Same allowlist gate as
// the bubble path — if the session isn't visible in the presenter, no menu.
function buildIconCtxMenuItems(sessionId) {
  if (!sessionId) return [];
  if (!window._isSessionVisibleInPresenter(sessionId)) return [];
  const items = [];
  items.push({
    label: 'Copy attach command',
    onClick: function () {
      // Peek-window wrapper. Lands the user in a fresh shell beside the live
      // session window; `exit` / Ctrl-D kills only the peek window and runs
      // detach-client, so the underlying session keeps running.
      const cmd = 'tmux new-window -t ' + sessionId + ' -n peek '
        + '\'echo "Welcome to peek window. Ctrl-b 0 = view session, Ctrl-b 1 = back here, exit = leave safely."; '
        + '$SHELL; tmux detach-client\' \\; attach -t ' + sessionId;
      window._presenterCopyText(cmd).then(function (ok) {
        if (ok) showInfoToast('Copied attach command');
        else showErrorToast('Copy failed — long-press the text to copy: ' + cmd);
      });
    }
  });
  items.push({
    label: 'Open tmux view',
    onClick: function () {
      window._presenterTmuxView.open(sessionId);
    }
  });
  // Composer-aware send-here item. Joshua 2026-05-20: one button that
  // flips label based on whether the composer has staged text.
  //  - Composer empty → "Send recording here" (existing behavior).
  //  - Composer has text → "Send message here" (walkie that text to the
  //    right-clicked steward; mirrors sendTextToStewardDirect's envelope
  //    but with an explicit target session id, not the selected steward).
  const composerEl = document.getElementById('conv-bottom-textarea');
  const composerText = (composerEl ? composerEl.value : '').trim();
  if (composerText) {
    items.push({
      label: 'Send message here',
      onClick: function () {
        window._presenterSendTextTo(sessionId, composerText);
      }
    });
  } else {
    items.push({
      label: 'Send recording here',
      onClick: function () {
        window._presenterSendRecordingTo(sessionId);
      }
    });
  }
  // Delete-worker item. Only real workers are deletable — a worker session is
  // `holler-<steading>--<name>` (has a `--`); a bare top-level steward is
  // `holler-<steading>` (no `--`) and must never expose this. Guests /
  // josh-presenter don't have the holler-steading--name shape either. The
  // server re-validates this (never trust the client), but we also hide the
  // item so Josh never sees "Delete" on something that isn't a worker.
  if (sessionId.indexOf('--') >= 0 && sessionId.indexOf('holler-') === 0) {
    items.push({
      label: '🗑️ Delete worker',
      onClick: function () {
        window._presenterDeleteWorker.open(sessionId);
      }
    });
  }
  return items;
}

// --- Delete-worker confirmation modal ---
// Long-press a worker icon → "🗑️ Delete worker" → this opens a card/resurrect-
// aware confirmation. It first PREVIEWS the worker's outstanding presenter cards
// (server runs the orphan-card gate in check-only mode) so Josh sees whether
// deleting will also clear un-answered cards. On confirm it calls the teardown
// endpoint, which kills the session, removes the worktree+branch, and rm -rf's
// the worker dir (deleting steward.json = the resurrect key), so a deleted
// worker can never come back.
//
// DELETE BEHAVIOR FLAGS (Josh's card answers set these; defaults = recommended):
//   destroyWorktree   — throw away the worker's git worktree + branch (default on)
//   bypassScratchGate — skip the graduation discipline gate for a manual delete
//                       (default on — "you tapped delete, I delete")
window._presenterDeleteWorker = (function () {
  // Josh's confirmed answers. Both default to the recommended behavior; his
  // card reply can flip either. Kept module-scoped so a single place drives it.
  const OPTS = { destroyWorktree: true, bypassScratchGate: true };

  let overlay = null;

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  }

  function shortName(sessionId) {
    try {
      const sub = (typeof findSubstewardForSession === 'function')
        ? findSubstewardForSession(sessionId) : null;
      if (sub && (sub.name || sub.id)) return sub.name || sub.id;
      if (typeof shortSessionName === 'function') return shortSessionName(sessionId);
    } catch (e) { /* fall through */ }
    return sessionId;
  }

  function buildOverlay() {
    const ov = document.createElement('div');
    ov.className = 'delete-worker-overlay';
    const box = document.createElement('div');
    box.className = 'delete-worker-modal';
    ov.appendChild(box);
    // Tap outside the box closes (cancel).
    ov.addEventListener('click', function (ev) { if (ev.target === ov) close(); });
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey, true);
    return { ov: ov, box: box };
  }

  function renderLoading(box, name) {
    box.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'dw-title';
    h.textContent = 'Delete ' + name + '?';
    const p = document.createElement('div');
    p.className = 'dw-body';
    p.textContent = 'Checking for messages waiting on you…';
    box.appendChild(h);
    box.appendChild(p);
  }

  function renderConfirm(box, sessionId, name, preview) {
    box.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'dw-title';
    h.textContent = 'Delete ' + name + '?';
    box.appendChild(h);

    const body = document.createElement('div');
    body.className = 'dw-body';

    if (preview.gateError) {
      // Presenter unreachable — we couldn't confirm whether cards exist. Refuse
      // rather than guess "no cards" and silently orphan a real one.
      body.innerHTML =
        '<p>Couldn\'t check whether this helper has messages still waiting on you, so I won\'t delete it yet — I don\'t want to lose something you haven\'t seen.</p>' +
        '<p>Try again in a moment.</p>';
      box.appendChild(body);
      const row = document.createElement('div');
      row.className = 'dw-buttons';
      const cancel = mkBtn('Close', 'dw-cancel', close);
      row.appendChild(cancel);
      box.appendChild(row);
      return;
    }

    // 1) Outstanding cards — count + titles (Josh asked to see the titles, not
    //    just the number, so he knows what he'd be clearing).
    const n = preview.cardCount || 0;
    const lead = document.createElement('p');
    if (n > 0) {
      const strong = document.createElement('strong');
      strong.textContent = 'This helper has ' + n + ' message' + (n === 1 ? '' : 's') + ' still waiting on you.';
      lead.appendChild(strong);
      lead.appendChild(document.createTextNode(' Deleting will clear ' + (n === 1 ? 'it' : 'them') + ' too:'));
    } else {
      lead.textContent = 'No messages waiting on you.';
    }
    body.appendChild(lead);
    if (n > 0 && Array.isArray(preview.cards) && preview.cards.length) {
      const ul = document.createElement('ul');
      ul.className = 'dw-card-list';
      preview.cards.forEach(function (c) {
        const li = document.createElement('li');
        li.textContent = (c && c.title) ? c.title : '(untitled)';
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }

    // 2) How far ahead/behind its main branch — Josh's tell for "is there real
    //    unmerged work in here, or is this safe to throw away?"
    if (preview.hasWorktree) {
      const workP = document.createElement('p');
      workP.className = 'dw-work';
      const wk = preview.work;
      if (wk && typeof wk.ahead === 'number') {
        // Only AHEAD matters for a delete decision — that's the worker's OWN
        // unmerged work that would be LOST. "behind" only measures how stale the
        // worker is vs its base (it started a while ago / base moved on); deleting
        // a behind-but-not-ahead branch loses NOTHING, so surfacing "behind" here
        // is alarming noise (Josh saw "22 commits behind main" on an already-merged
        // worker and — correctly — got nervous). Gate purely on ahead.
        if (wk.ahead === 0) {
          workP.innerHTML = '<strong>Nothing to lose here.</strong> All of this helper\'s work is already saved into ' +
            escapeHtml(wk.base) + '. Safe to delete.';
        } else {
          workP.innerHTML = 'Heads up: this helper has <strong>' + wk.ahead + ' unsaved change' +
            (wk.ahead === 1 ? '' : 's') + ' of its own</strong> (not yet in ' + escapeHtml(wk.base) +
            '). Deleting throws that away.';
          // Line-diff — how BIG that unsaved work is (Josh's ask): "+X / −Y lines".
          if (typeof wk.insertions === 'number' &&
              (wk.insertions > 0 || wk.deletions > 0 || wk.filesChanged > 0)) {
            var sizeLine = document.createElement('span');
            sizeLine.className = 'dw-diffsize';
            sizeLine.innerHTML = '<span class="dw-add">+' + wk.insertions +
              '</span> / <span class="dw-del">−' + wk.deletions + '</span> line' +
              ((wk.insertions + wk.deletions) === 1 ? '' : 's') +
              ' across ' + wk.filesChanged + ' file' + (wk.filesChanged === 1 ? '' : 's');
            workP.appendChild(document.createElement('br'));
            workP.appendChild(sizeLine);
          }
        }
      } else {
        // Couldn't compute (branch/repo gone). Don't block — just be honest.
        workP.textContent = 'Couldn\'t check how much unfinished work it has. Deleting still throws away whatever\'s there.';
      }
      body.appendChild(workP);
    }

    const tail = document.createElement('p');
    tail.textContent = preview.hasWorktree ? 'It won\'t come back.' : 'It won\'t come back.';
    body.appendChild(tail);
    box.appendChild(body);

    const row = document.createElement('div');
    row.className = 'dw-buttons';
    const del = mkBtn('Delete', 'dw-delete', function () {
      runDelete(box, sessionId, name);
    });
    const cancel = mkBtn('Cancel', 'dw-cancel', close);
    row.appendChild(del);
    row.appendChild(cancel);
    box.appendChild(row);
  }

  function renderError(box, name, msg) {
    box.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'dw-title';
    h.textContent = 'Couldn\'t delete ' + name;
    const p = document.createElement('div');
    p.className = 'dw-body';
    p.textContent = msg || 'Something went wrong.';
    const row = document.createElement('div');
    row.className = 'dw-buttons';
    row.appendChild(mkBtn('Close', 'dw-cancel', close));
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(row);
  }

  function mkBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dw-btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      onClick();
    });
    return b;
  }

  function runDelete(box, sessionId, name) {
    // Disable buttons + show progress in place.
    box.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'dw-title';
    h.textContent = 'Deleting ' + name + '…';
    const p = document.createElement('div');
    p.className = 'dw-body';
    p.textContent = 'Shutting it down and cleaning up.';
    box.appendChild(h);
    box.appendChild(p);

    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    fetch(SERVER_URL + '/api/delete-worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,
        action: 'delete',
        destroyWorktree: OPTS.destroyWorktree,
        bypassScratchGate: OPTS.bypassScratchGate
      })
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (!r.ok || !r.data || !r.data.success) {
        renderError(box, name, (r.data && r.data.error) || 'Delete failed.');
        return;
      }
      close();
      showInfoToast(name + ' deleted');
      // Refresh the sidebar so the icon disappears immediately (the worker is
      // gone from tmux + disk, so /api/stewards no longer returns it).
      if (typeof fetchStewards === 'function') fetchStewards();
    }).catch(function (err) {
      console.error('[_presenterDeleteWorker] delete failed:', err);
      renderError(box, name, 'Couldn\'t reach the server. Try again.');
    });
  }

  function open(sessionId) {
    if (!sessionId) return;
    const name = shortName(sessionId);
    const built = buildOverlay();
    overlay = built.ov;
    renderLoading(built.box, name);

    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    fetch(SERVER_URL + '/api/delete-worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, action: 'preview' })
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (!overlay) return; // closed while loading
      if (!r.ok || !r.data || !r.data.success) {
        renderError(built.box, name, (r.data && r.data.error) || 'Couldn\'t check this helper.');
        return;
      }
      renderConfirm(built.box, sessionId, name, r.data);
    }).catch(function (err) {
      console.error('[_presenterDeleteWorker] preview failed:', err);
      if (!overlay) return;
      renderError(built.box, name, 'Couldn\'t reach the server. Try again.');
    });
  }

  return { open: open, close: close, _opts: OPTS };
})();

// Walkie composer text to an arbitrary session, bypassing the bottom-bar
// steward picker. Mirrors sendTextToStewardDirect's envelope (target_session,
// type: action, message_override with from: josh-presenter) but with an
// explicit target so Joshua can route a typed reply to ANY substeward
// from the icon context menu. Clears the composer's active-card draft on
// success.
window._presenterSendTextTo = function (targetSessionId, text) {
  if (!targetSessionId || !text) return;
  const SERVER_URL = window.location.origin || 'http://localhost:3005';
  let shortName = targetSessionId;
  try {
    const sub = (typeof findSubstewardForSession === 'function')
      ? findSubstewardForSession(targetSessionId) : null;
    if (sub && (sub.name || sub.id)) shortName = sub.name || sub.id;
    else if (typeof shortSessionName === 'function') shortName = shortSessionName(targetSessionId);
  } catch (e) {
    if (typeof shortSessionName === 'function') shortName = shortSessionName(targetSessionId);
  }
  fetch(`${SERVER_URL}/api/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_session: targetSessionId,
      type: 'action',
      message_override: JSON.stringify({
        type: 'action',
        from: 'josh-presenter',
        instruction: text
      })
    })
  }).then(function (res) {
    if (!res.ok) throw new Error('Server returned ' + res.status);
    showInfoToast('Message → ' + shortName);
    const ta = document.getElementById('conv-bottom-textarea');
    if (ta) {
      ta.value = '';
      if (typeof window.__composerClearActiveDraft === 'function') window.__composerClearActiveDraft();
    }
  }).catch(function (err) {
    console.error('[_presenterSendTextTo] failed:', err);
    showErrorToast('Message failed to send');
  });
};

// Route the active recording (Android phone OR Whisper Village laptop)
// directly to an arbitrary session, bypassing the bottom-bar steward picker.
// Used by the icon context menu's "Send recording here" item so Joshua can
// route a voice message to ANY sub-substeward by pointing at their icon —
// not just the top-level stewards the bottom bar exposes.
//
// Mirrors the bottom-bar recording path (sendBottomMessage's Priority-2
// branch) but with an explicit target. No bottom-bar button to mutate, so
// feedback is via toast.
window._presenterSendRecordingTo = function (targetSessionId) {
  if (!targetSessionId) return;
  const walkieId = '_walkie_' + targetSessionId;
  const isAndroid = !!(window.Android && window.Android.getRecordingStatus);
  // Prefer the sub/sub-sub-steward's actual name when available; fall back
  // to the short session-name collapse. Without this, sending to an Auditor
  // or any sub-substeward shows "homestead" in the toast, which obscures
  // which specific steward Joshua targeted.
  let shortName = targetSessionId;
  try {
    const sub = (typeof findSubstewardForSession === 'function')
      ? findSubstewardForSession(targetSessionId) : null;
    if (sub && (sub.name || sub.id)) {
      shortName = sub.name || sub.id;
    } else if (typeof shortSessionName === 'function') {
      shortName = shortSessionName(targetSessionId);
    }
  } catch (e) {
    if (typeof shortSessionName === 'function') shortName = shortSessionName(targetSessionId);
  }

  if (isAndroid) {
    try {
      const status = JSON.parse(window.Android.getRecordingStatus());
      if (status.isRecording || status.hasRecording) {
        window.Android.claimRecordingForCard(walkieId);
        showInfoToast('Recording → ' + shortName + ' (transcribing…)');
        return;
      }
      showInfoToast('No active recording — record first, then try again');
      return;
    } catch (e) {
      console.log('[SendRecordingTo] Android bridge error:', e);
      showErrorToast('Phone bridge error — try the bottom bar');
      return;
    }
  }

  // Desktop / Electron: try Whisper Village
  fetch('http://localhost:8179/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardId: walkieId })
  }).then(function (res) {
    if (!res.ok) throw new Error('no-recording');
    showInfoToast('Recording → ' + shortName + ' (transcribing…)');
  }).catch(function () {
    showInfoToast('No active recording — record first, then try again');
  });
};

// Wire long-press + contextmenu on a topbar/subbar/sub-sub icon.
// The icons have their own click handlers (select-steward); right-click
// and long-press should NOT trigger those, only open the menu.
function attachIconContextMenu(el, sessionId) {
  if (!el) return;
  _wireCtxMenu(el, function () { return buildIconCtxMenuItems(sessionId); }, { ignoreInteractiveChildren: false });
}

// --- In-app tmux viewer (read-only) ---
// Long-press / right-click a steward icon → "Open tmux view" → mounts a
// full-app overlay with xterm.js fed by the same socket.io tmux:* events
// the React TerminalManager uses. Read-only by construction: we never
// emit tmux:input and the xterm textarea is readonly.
window._presenterTmuxView = (function () {
  let overlay = null;
  let xterm = null;
  let fitAddon = null;
  let socket = null;
  let resizeObs = null;
  let currentSession = null;
  let snapshotPoll = null;
  let allowlistPoll = null;
  let receivedData = false;
  let redrawRetry1 = null;
  let redrawRetry2 = null;

  // --- Clean-scrollback state (PIECE 1) ---
  // claude runs in the tmux ALTERNATE screen (alternate_on=1, history_size=0),
  // so tmux holds NO scrollback and xterm's own scrollback is corrupted by
  // claude's in-place cursor-addressed repaints (scroll-up shows garble).
  // Fix: poll clean `tmux capture-pane -p` frames while the viewer is open,
  // dedup the overlap between consecutive frames (claude repaints the same
  // viewport, so only the genuinely-new BOTTOM lines are appended), and keep a
  // clean, in-order line buffer. When Josh scrolls UP we show this buffer as
  // plain readable text (a <pre>, inherently un-garbled) instead of xterm's
  // poisoned scrollback. The live xterm keeps rendering the pristine bottom.
  let histLines = [];          // clean, in-order text lines (the reconstructed scrollback)
  let histDirty = false;       // set when appendFrame added lines; gates DOM rewrite
  let histMode = 'live';       // 'live' (show xterm) | 'history' (show clean <pre>)
  const HIST_MAX = 30 * 6;     // ~6 screen-heights at 30 rows — a touch over Josh's "~5 screens"

  // Fold a fresh clean capture frame into histLines. claude repaints the same
  // viewport, so consecutive frames overlap heavily — only the genuinely-new
  // BOTTOM lines are new. We find the overlap by matching the new frame's
  // PREFIX against the TAIL of the accumulated history (whole-line longest
  // common suffix/prefix) and append only what's beyond it. Matching against
  // the real history tail (not just the last frame) means a full-screen repaint
  // whose top re-shows lines already in history won't duplicate them — no
  // jump-back. Line-granular matching means a changed/spinner line simply
  // re-appends rather than corrupting history; the text is always clean (it's
  // a plain `capture-pane -p` frame — no cursor addressing), never garbled.
  function appendFrame(frameText) {
    if (!frameText) return;
    const frame = frameText.replace(/\r/g, '').split('\n').map(function (l) { return l.replace(/\s+$/, ''); });
    while (frame.length && frame[frame.length - 1] === '') frame.pop();
    if (!frame.length) return;

    if (!histLines.length) { // seed from the first frame (on-open snapshot)
      histLines = frame.slice();
      histDirty = true;
      return;
    }

    // Largest k: last k lines of history === first k lines of frame.
    const maxK = Math.min(histLines.length, frame.length);
    let k = 0;
    for (let cand = maxK; cand >= 1; cand--) {
      let ok = true;
      for (let i = 0; i < cand; i++) {
        if (histLines[histLines.length - cand + i] !== frame[i]) { ok = false; break; }
      }
      if (ok) { k = cand; break; }
    }

    let added = false;
    for (let i = k; i < frame.length; i++) { histLines.push(frame[i]); added = true; }

    if (histLines.length > HIST_MAX) histLines = histLines.slice(histLines.length - HIST_MAX);
    if (added) histDirty = true;
  }

  // Push the clean buffer into the history <pre>. Keeps it pinned to bottom
  // unless the user has scrolled up to read (then preserves their scrollTop).
  function renderHistory(parts) {
    if (!parts || !parts.history) return;
    if (!histDirty) return;
    histDirty = false;
    const pre = parts.history;
    const nearBottom = (pre.scrollHeight - pre.scrollTop - pre.clientHeight) < 24;
    pre.textContent = histLines.join('\n');
    if (nearBottom) pre.scrollTop = pre.scrollHeight;
  }

  // Switch which pane is visible. 'live' = the pristine live xterm (bottom);
  // 'history' = the clean reconstructed-scrollback <pre> (scroll-up).
  function setHistMode(parts, mode) {
    if (!parts || histMode === mode) return;
    histMode = mode;
    if (mode === 'history') {
      histDirty = true;              // force a render of current buffer
      renderHistory(parts);
      if (parts.history) {
        parts.history.style.display = 'block';
        // Land the user at the bottom of history (contiguous with the live
        // bottom they just scrolled away from), then they scroll up to read.
        parts.history.scrollTop = parts.history.scrollHeight;
      }
      if (parts.term) parts.term.style.visibility = 'hidden';
    } else {
      if (parts.history) parts.history.style.display = 'none';
      if (parts.term) parts.term.style.visibility = 'visible';
    }
  }

  // Read-only theme palette. Resolves the live CSS tokens so the xterm
  // body matches whichever reading-mode preset (iowa / gruvbox /
  // gruvbox-hard) the user is on. Falls back to a dark gruvbox-ish palette
  // when reading-mode is off. Theme is read at open time; close+reopen to
  // pick up a preset switch.
  function pickTheme() {
    const isReading = document.body && document.body.classList.contains('reading-mode');
    if (isReading) {
      const cs = getComputedStyle(document.body);
      const v = function (name, fallback) {
        const raw = cs.getPropertyValue(name).trim();
        return raw || fallback;
      };
      const bg = v('--iowa-bg', '#F4EFE6');
      const fg = v('--iowa-text', '#1A1815');
      const fgSoft = v('--iowa-text-soft', '#5A4430');
      const accent = v('--iowa-accent', '#7A5C3E');
      const gold = v('--iowa-gold', '#C8A96A');
      const sage = v('--iowa-sage', '#6B8E4E');
      const slate = v('--iowa-slate', '#4A6B8E');
      const red = v('--iowa-red', '#8E4A3E');
      const border = v('--iowa-border', '#D0C4AE');
      return {
        background: bg,
        foreground: fg,
        cursor: fgSoft,
        selectionBackground: border,
        black: fg, red: red, green: sage, yellow: gold,
        blue: slate, magenta: accent, cyan: slate, white: fgSoft,
        brightBlack: v('--iowa-text-faint', '#7A6B55'),
        brightRed: red, brightGreen: sage, brightYellow: gold,
        brightBlue: slate, brightMagenta: accent, brightCyan: slate, brightWhite: fg
      };
    }
    // Default dark — gruvbox-ish, matches presenter's dark chrome.
    return {
      background: '#0a0a0a',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      selectionBackground: '#3c3836',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
      brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
      brightCyan: '#8ec07c', brightWhite: '#ebdbb2'
    };
  }

  function buildOverlay(sessionId) {
    const o = document.createElement('div');
    o.className = 'tmux-view-overlay';
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-label', 'tmux view: ' + sessionId);

    const header = document.createElement('div');
    header.className = 'tmux-view-header';

    const back = document.createElement('button');
    back.className = 'tmux-view-back';
    back.setAttribute('aria-label', 'Close tmux view');
    back.textContent = '←';
    back.addEventListener('click', function () { closeView(); });
    header.appendChild(back);

    const title = document.createElement('span');
    title.className = 'tmux-view-title';
    title.textContent = sessionId;
    header.appendChild(title);

    const status = document.createElement('span');
    status.className = 'tmux-view-status';
    status.textContent = 'connecting…';
    header.appendChild(status);

    const body = document.createElement('div');
    body.className = 'tmux-view-body';

    const term = document.createElement('div');
    term.className = 'tmux-view-term';
    body.appendChild(term);

    // Clean-scrollback pane (PIECE 1). Plain-text <pre>, so it is inherently
    // un-garbled. Hidden until the user scrolls up off the live bottom.
    const history = document.createElement('pre');
    history.className = 'tmux-view-history';
    history.style.display = 'none';
    body.appendChild(history);

    const empty = document.createElement('div');
    empty.className = 'tmux-view-empty';
    empty.style.display = 'none';
    empty.textContent = 'This session is no longer active. Closing…';
    body.appendChild(empty);

    o.appendChild(header);
    o.appendChild(body);

    return { root: o, term: term, status: status, empty: empty, history: history };
  }

  function setStatus(parts, text) {
    if (parts && parts.status) parts.status.textContent = text;
  }

  function showEmpty(parts, text) {
    if (!parts) return;
    if (parts.empty) {
      parts.empty.style.display = 'flex';
      if (text) parts.empty.textContent = text;
    }
    if (parts.term) parts.term.style.display = 'none';
  }

  function open(sessionId) {
    if (!sessionId) return;
    if (overlay) closeView();
    // FitAddon UMD exposes a namespace object: window.FitAddon.FitAddon is the
    // constructor. Terminal is a direct global.
    const FitCtor = window.FitAddon && window.FitAddon.FitAddon;
    if (typeof window.Terminal !== 'function' || typeof FitCtor !== 'function') {
      showErrorToast('tmux viewer not loaded yet — try again in a moment');
      return;
    }
    if (typeof window.io !== 'function') {
      showErrorToast('socket.io not available — cannot open tmux view');
      return;
    }
    if (!window._isSessionVisibleInPresenter(sessionId)) {
      showErrorToast('Session is no longer in the sidebar.');
      return;
    }

    currentSession = sessionId;
    receivedData = false;
    const parts = buildOverlay(sessionId);
    overlay = parts.root;
    document.body.appendChild(overlay);
    // PIECE 2: keep the bottom send bar (dictate + the two send buttons) usable
    // over the tmux view. CSS on this class lifts #conv-bottom-input above the
    // overlay and reserves its height at the overlay's bottom. Measure the bar's
    // real height so the reserved gap is exact across presets/viewports.
    try {
      const bar = document.getElementById('conv-bottom-input');
      const h = bar ? Math.round(bar.getBoundingClientRect().height) : 0;
      if (h > 0) document.body.style.setProperty('--tmux-sendbar-h', h + 'px');
    } catch (e) { /* fall back to CSS default */ }
    document.body.classList.add('tmux-view-open');

    const theme = pickTheme();
    xterm = new window.Terminal({
      cols: 100,
      rows: 30,
      fontSize: 13,
      lineHeight: 1.0,
      fontFamily: 'Menlo, Monaco, "SF Mono", "Fira Code", Consolas, "Courier New", monospace',
      cursorBlink: false,
      cursorStyle: 'underline',
      scrollback: 5000,
      theme: theme,
      disableStdin: true,
      // Reduce tearing on theme/dim panels; xterm DOM renderer is the default
      // and works in both Electron and APK WebView without WebGL deps.
    });
    fitAddon = new FitCtor();
    xterm.loadAddon(fitAddon);
    xterm.open(parts.term);

    // Read-only: prevent any keyboard input from being sent to the PTY by
    // refusing it at the xterm layer. We never bind onData/onKey to a
    // tmux:input emit, but this also disables the textarea cursor capture
    // so users can't accidentally type a stuck key.
    const ta = parts.term.querySelector('textarea');
    if (ta) {
      ta.setAttribute('readonly', 'true');
      ta.setAttribute('aria-readonly', 'true');
    }
    // Block ALL key events from xterm reaching the PTY path (defense in depth).
    xterm.attachCustomKeyEventHandler(function () { return false; });

    // Scroll routing (PIECE 1). Two mutually-exclusive panes share the body
    // box: the live xterm (bottom) and the clean-history <pre> (scroll-up).
    // An UP intent while live flips to history; scrolling history DOWN past its
    // bottom flips back to live. The <pre> scrolls natively in history mode.
    const scrollHost = parts.term.parentNode; // .tmux-view-body — always receives events

    function historyAtBottom() {
      const pre = parts.history;
      if (!pre) return true;
      return (pre.scrollHeight - pre.scrollTop - pre.clientHeight) < 4;
    }

    // Wheel scroll.
    scrollHost.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      const up = ev.deltaY < 0;
      if (histMode === 'live') {
        if (up && histLines.length) setHistMode(parts, 'history');
        return;
      }
      // history mode
      const lines = Math.max(1, Math.ceil(Math.abs(ev.deltaY) / 40));
      const pre = parts.history;
      if (!up && historyAtBottom()) { setHistMode(parts, 'live'); return; }
      pre.scrollTop += (up ? -1 : 1) * lines * 18;
    }, { passive: false });

    // Touch scroll (mobile) — drag-to-scroll.
    let touchStartY = null;
    scrollHost.addEventListener('touchstart', function (ev) {
      if (ev.touches && ev.touches.length === 1) touchStartY = ev.touches[0].clientY;
    }, { passive: true });
    scrollHost.addEventListener('touchmove', function (ev) {
      if (touchStartY == null || !ev.touches || ev.touches.length !== 1) return;
      const dy = ev.touches[0].clientY - touchStartY;
      if (Math.abs(dy) < 12) return;
      const up = dy > 0; // finger drags down → content scrolls up (reveal older)
      if (histMode === 'live') {
        if (up && histLines.length) setHistMode(parts, 'history');
        touchStartY = ev.touches[0].clientY;
        return;
      }
      const pre = parts.history;
      if (!up && historyAtBottom()) { setHistMode(parts, 'live'); touchStartY = ev.touches[0].clientY; return; }
      pre.scrollTop += (up ? -1 : 1) * Math.abs(dy);
      touchStartY = ev.touches[0].clientY;
    }, { passive: true });

    // Connect socket. Use window.location.origin so it works on Electron
    // (localhost:3005), Tailscale MagicDNS, and APK WebView (whatever the
    // server origin is) without hard-coding.
    //
    // Transports: DO NOT force websocket-first. Over Tailscale's HTTPS proxy
    // the raw websocket upgrade fails ("websocket error") and — because
    // engine.io only falls back to polling when polling is the FIRST attempt,
    // not when a websocket-first initial connect fails — the socket never
    // connects at all. It sits at "disconnected — retrying" forever and the
    // viewer stays blank on the phone. Omitting `transports` lets socket.io
    // use its default (polling, then transparent upgrade to websocket on
    // networks that allow it, e.g. local Electron). This is the real reason
    // the overlay blanked over Tailscale — the redraw-retry net below could
    // never help because there was no live socket to redraw through.
    socket = window.io(window.location.origin, {
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    // Redraw-retry safety net. The dashboard TerminalManager has this; the
    // presenter overlay did not — which is why it blanked over Tailscale on
    // the phone. If the snapshot ack is slow/dropped OR the server's single
    // attach-time redraw is lost, nothing ever paints and there's no recovery.
    // Ctrl+L (\x0c) is a repaint, not a state mutation, so emitting it keeps
    // the viewer read-only in spirit while forcing tmux to re-send the screen.
    function forceRedraw() {
      if (socket && socket.connected) socket.emit('tmux:input', sessionId, '\x0c');
    }
    function clearRedrawRetries() {
      if (redrawRetry1) { clearTimeout(redrawRetry1); redrawRetry1 = null; }
      if (redrawRetry2) { clearTimeout(redrawRetry2); redrawRetry2 = null; }
    }

    socket.on('connect', function () {
      setStatus(parts, 'attaching…');
      socket.emit('tmux:attach', sessionId);

      // If no visible output lands, force a tmux redraw at 3s and again at 6s.
      // Mirrors TerminalManager.tsx's fallback — the difference that makes the
      // dashboard robust over Tailscale where this overlay was not.
      clearRedrawRetries();
      redrawRetry1 = setTimeout(function () {
        if (!receivedData) { setStatus(parts, 'loading…'); forceRedraw(); }
      }, 3000);
      redrawRetry2 = setTimeout(function () {
        if (!receivedData) forceRedraw();
      }, 6000);
    });

    socket.on('disconnect', function () {
      setStatus(parts, 'disconnected — retrying');
      clearRedrawRetries();
    });

    socket.on('tmux:ready', function () {
      setStatus(parts, 'live');
      // Fit, then snapshot.
      doFit();
      setTimeout(doFit, 50);
      setTimeout(function () {
        doFit();
        const dims = fitAddon.proposeDimensions();
        const opts = (dims && dims.cols && dims.rows) ? { cols: dims.cols, rows: dims.rows } : {};
        socket.emit('tmux:snapshot', sessionId, opts, function (response) {
          if (response && response.success && response.data) {
            xterm.write('\x1b[2J\x1b[H\x1b[0m');
            xterm.write(response.data);
            xterm.scrollToBottom();
            // Seed the clean-scrollback buffer from the same first clean frame.
            appendFrame(response.data);
          }
          // Trigger the colored redraw through the normal pty pipeline (matches
          // TerminalManager.tsx). Also recovers the case where the snapshot ack
          // came back empty over Tailscale — the redraw repaints from tmux.
          forceRedraw();
          startHistoryPoll();
        });
      }, 200);
    });

    // Poll clean capture frames while the viewer is open and fold them into the
    // clean-scrollback buffer. Resize-free `tmux:capture` (NOT `tmux:snapshot`,
    // which resizes the pane and would flicker Josh's live desk). 500ms is slow
    // enough to let transient spinner frames settle before they're deduped.
    function startHistoryPoll() {
      if (snapshotPoll) return;
      snapshotPoll = setInterval(function () {
        if (!socket || !socket.connected) return;
        socket.emit('tmux:capture', sessionId, function (r) {
          if (r && r.success && r.data) {
            appendFrame(r.data);
            if (histMode === 'history') renderHistory(parts);
          }
        });
      }, 500);
    }

    socket.on('tmux:output', function (data) {
      xterm.write(data);
      if (!receivedData) {
        const visible = data.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\r|\n|\x0c/g, '').trim();
        if (visible.length > 0) {
          receivedData = true;
          setStatus(parts, 'live');
          clearRedrawRetries();
        }
      }
    });

    socket.on('tmux:error', function (msg) {
      setStatus(parts, 'error');
      showEmpty(parts, 'tmux error: ' + msg);
    });

    function doFit() {
      try {
        if (parts.term.offsetWidth > 0 && parts.term.offsetHeight > 0) {
          fitAddon.fit();
          const dims = fitAddon.proposeDimensions();
          if (dims && dims.cols && dims.rows && socket && socket.connected) {
            socket.emit('tmux:resize', sessionId, dims.cols, dims.rows);
          }
        }
      } catch (e) { /* layout not ready yet */ }
    }

    resizeObs = new ResizeObserver(doFit);
    resizeObs.observe(parts.term);

    // Initial fit triggers (mirror TerminalManager.tsx — multi-attempt).
    setTimeout(doFit, 10);
    setTimeout(doFit, 80);

    // Allowlist watchdog: if the session leaves the sidebar (worker torn
    // down mid-view), close gracefully with the empty state. Cheap poll —
    // sidebar mutations don't fire DOM events we can subscribe to here.
    allowlistPoll = setInterval(function () {
      if (!currentSession) return;
      if (!window._isSessionVisibleInPresenter(currentSession)) {
        showEmpty(parts, 'Session is no longer active. Closing…');
        setTimeout(closeView, 1500);
      }
    }, 2000);

    // Esc key → close (desktop convenience).
    overlay.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); closeView(); }
    });
    document.addEventListener('keydown', _escHandler, true);
  }

  function _escHandler(ev) {
    if (!overlay) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeView();
    }
  }

  function closeView() {
    if (snapshotPoll) { clearInterval(snapshotPoll); snapshotPoll = null; }
    if (allowlistPoll) { clearInterval(allowlistPoll); allowlistPoll = null; }
    if (redrawRetry1) { clearTimeout(redrawRetry1); redrawRetry1 = null; }
    if (redrawRetry2) { clearTimeout(redrawRetry2); redrawRetry2 = null; }
    document.removeEventListener('keydown', _escHandler, true);
    if (socket) {
      try {
        if (currentSession) socket.emit('tmux:detach', currentSession);
        socket.disconnect();
      } catch (e) { /* socket may already be down */ }
      socket = null;
    }
    if (resizeObs) { try { resizeObs.disconnect(); } catch (e) { /* noop */ } resizeObs = null; }
    if (xterm) { try { xterm.dispose(); } catch (e) { /* noop */ } xterm = null; }
    fitAddon = null;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    currentSession = null;
    receivedData = false;
    // Reset clean-scrollback state so a reopen starts fresh.
    histLines = [];
    histDirty = false;
    histMode = 'live';
    document.body.classList.remove('tmux-view-open');
  }

  return { open: open, close: closeView };
})();

// --- Inline undo ---

let pendingUndo = null; // { timer, itemId }
// Set by bottom-bar send paths just before they clear #conv-bottom-textarea.
// Read+consumed by showInlineUndo's rollback so undo restores the text
// to the box the user was actually typing in (not just the card-internal
// textarea, which may not even be visible). Cleared on send commit.
let __bottomBarSendOriginText = null;

// showInlineUndo(item, buttonLabel, text, originalBubble, wrapper, row, keepCard?)
// keepCard=true (Josh 2026-07-10): send the reply + card context to the steward
// but DON'T dismiss the card. On commit the card's input is restored so Josh can
// reply again, and the confirmation reads "kept" instead of swapping the card
// into a terminal replied-state.
function showInlineUndo(item, buttonLabel, text, originalBubble, wrapper, row, keepCard) {
  // Cancel any existing pending undo
  if (pendingUndo) {
    clearTimeout(pendingUndo.timer);
    pendingUndo = null;
  }

  // Hide the input/buttons area in the original bubble
  const inputWrap = originalBubble.querySelector('.msg-input-wrap');
  const buttonsWrap = originalBubble.querySelector('.msg-buttons');
  if (inputWrap) inputWrap.style.display = 'none';
  if (buttonsWrap) buttonsWrap.style.display = 'none';

  // Create inline response section INSIDE the same bubble (still load-bearing
  // — Josh sees "👤 You replied: …" so they know what the deck just sent).
  const responseSection = document.createElement('div');
  responseSection.className = 'msg-inline-response pending-response';

  const responseLabel = document.createElement('div');
  responseLabel.className = 'msg-response-label';
  responseLabel.textContent = keepCard ? '👤 You replied (card kept):' : '👤 You replied:';
  responseSection.appendChild(responseLabel);

  if (buttonLabel && buttonLabel !== 'Reply') {
    const btnEl = document.createElement('div');
    btnEl.className = 'msg-response-button';
    btnEl.textContent = buttonLabel;
    responseSection.appendChild(btnEl);
  }
  if (text) {
    const textEl = document.createElement('div');
    textEl.className = 'msg-response-text';
    textEl.textContent = text;
    responseSection.appendChild(textEl);
  }

  originalBubble.appendChild(responseSection);

  // --- Advance the deck (Josh 2026-08-30) --------------------------------
  // THE BUG: replying to card 3 of 10 landed Josh on card 10. The dismiss
  // route has advanced correctly for months; the reply route had NO advance
  // logic at all. The replied card gets removed server-side, renderThread
  // rebuilds, findCurrentIndex can't find the dead id and fell through to
  // `bubbles.length - 1` — the NEWEST card. With 91 unseen cards that threw
  // him out of his backlog on every single answer.
  //
  // Register in pendingReplyIds FIRST so (a) this card is excluded as an
  // advance target, (b) a poll re-render mid-countdown can't resurrect it as
  // a live sibling for a concurrent action, and (c) findCurrentIndex's
  // fallback knows the id is dying rather than merely missing.
  //
  // A PINNED card survives the reply (keepCard) — Josh stays on it so he can
  // fire another reply at the same card. Only advance when the card is going
  // away.
  if (!keepCard) {
    pendingReplyIds.add(item.id);
    advanceDeckAwayFrom(item.id, 'reply-advance');
  }

  const startTime = Date.now();

  function rollback() {
    // Undo tapped — the card is NOT going away after all. Un-register before
    // anything else so it's immediately a legal advance/nav target again.
    pendingReplyIds.delete(item.id);
    // We advanced off this card when the reply fired. UNDO means "put me back
    // where I was" — jump the deck back to it, otherwise Josh taps UNDO and
    // watches a different card's input get focused below.
    if (!keepCard) {
      try {
        if (typeof window.mobileDeckJumpTo === 'function') window.mobileDeckJumpTo(item.id);
      } catch (err) { console.error('[reply-advance] undo jump-back:', err); }
    }
    // Remove the response section
    responseSection.remove();
    // Show input/buttons again
    if (inputWrap) inputWrap.style.display = '';
    if (buttonsWrap) buttonsWrap.style.display = '';
    // Re-enable buttons
    originalBubble.querySelectorAll('.msg-btn').forEach(b => { b.disabled = false; });
    // Restore text + repopulate the persisted draft so a refresh during undo
    // window still recovers the in-flight response.
    const textarea = originalBubble.querySelector('.msg-input');
    if (textarea && text) {
      textarea.value = text;
      try { setDraft(item.session_id || selectedSteward, item.id, text); } catch {}
      textarea.focus();
    }
    // If the send originated from the bottom typing box, put the text
    // back there too — that's where Josh's eyes are.
    if (__bottomBarSendOriginText && __bottomBarSendOriginText === text) {
      try {
        if (typeof window.__composerRestoreActiveDraft === 'function') {
          window.__composerRestoreActiveDraft(text);
        }
      } catch (err) { console.error('[undo] bottom-bar restore:', err); }
      __bottomBarSendOriginText = null;
    }
  }

  // Shared upper-left undo pill (Josh 2026-06-02)
  const pill = showUpperLeftUndo({
    label: 'UNDO',
    durationMs: UNDO_DELAY,
    onUndo: () => {
      clearTimeout(timer);
      clearInterval(countdownInterval);
      pendingUndo = null;
      rollback();
    }
  });

  const countdownInterval = setInterval(() => {
    const remaining = Math.max(0, (UNDO_DELAY - (Date.now() - startTime)) / 1000);
    pill.setCountdown(remaining);
    if (remaining <= 0) clearInterval(countdownInterval);
  }, 200);

  // One stable idempotency key per logical send — reused by the initial commit
  // AND every retry below, so a retry of an already-delivered reply (its first
  // response lost on a flaky link) returns success instead of a permanent 404,
  // and never double-sends. See window.presenter.respond().
  const sendId = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : `snd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function doRespond() {
    return window.presenter.respond(item.id, buttonLabel, text || undefined, keepCard, sendId);
  }

  // Retire this card from pendingReplyIds. On SUCCESS we hold the id a few
  // seconds: the server removes the card asynchronously, and a poll landing in
  // that window would otherwise re-render the bubble as "live" and let a
  // concurrent advance land back on a card Josh already answered. On FAILURE
  // the card is staying, so free it immediately.
  function finishReplyPending(succeeded) {
    if (keepCard) { pendingReplyIds.delete(item.id); return; }
    if (succeeded) setTimeout(() => pendingReplyIds.delete(item.id), 8000);
    else pendingReplyIds.delete(item.id);
  }

  // In keepCard mode the card survives, so once the reply is committed we
  // restore the card's input row and drop the inline "You replied" section —
  // Josh can immediately type another reply to the same card.
  function restoreForAnotherReply() {
    responseSection.remove();
    if (inputWrap) inputWrap.style.display = '';
    if (buttonsWrap) buttonsWrap.style.display = '';
    originalBubble.querySelectorAll('.msg-btn').forEach(b => { b.disabled = false; });
    const ta = originalBubble.querySelector('.msg-input');
    if (ta) { ta.value = ''; }
  }

  function showRetry() {
    pill.setFailed('Failed — tap to retry');
    showErrorToast('Response failed to deliver', () => {
      pill.setCommitting('Retrying…');
      doRespond()
        .then(() => {
          finishReplyPending(true);
          pill.setSuccess(keepCard ? 'Sent — card kept' : 'Sent');
          setTimeout(() => pill.remove(), 1200);
          responseSection.classList.remove('pending-response');
          if (keepCard) restoreForAnotherReply();
        })
        .catch(() => { finishReplyPending(false); showRetry(); });
    });
  }

  const timer = setTimeout(() => {
    pendingUndo = null;
    clearInterval(countdownInterval);
    if (!pill.isUndoable()) return; // user cancelled between tick and timeout
    console.log('[Presenter] Sending response (undo expired):', item.id, buttonLabel, text);
    // Send committed — kill the persisted draft so it doesn't haunt the next render.
    try { clearDraft(item.session_id || selectedSteward, item.id); } catch {}
    if (__bottomBarSendOriginText === text) __bottomBarSendOriginText = null;
    pill.setCommitting('Sending…');
    if (convThread) preserveScrollPosition = convThread.scrollTop;
    doRespond()
      .then(() => {
        finishReplyPending(true);
        pill.setSuccess(keepCard ? 'Sent — card kept' : 'Sent');
        setTimeout(() => pill.remove(), 1500);
        responseSection.classList.remove('pending-response');
        if (keepCard) restoreForAnotherReply();
      })
      .catch(err => {
        console.error('[Presenter] Response failed, showing retry:', err);
        finishReplyPending(false);
        showRetry();
      });
  }, UNDO_DELAY);

  pendingUndo = { timer, itemId: item.id };
}

// --- Chat view rendering ---

function renderChatView() {
  if (!convThread) return;
  if (!selectedSteward) {
    convThread.style.display = 'none';
    if (convEmpty) convEmpty.style.display = '';
    return;
  }

  convThread.style.display = '';
  if (convEmpty) convEmpty.style.display = 'none';

  const messages = chatCache[selectedSteward] || [];
  const prevCount = convThread.children.length;
  const isFirstLoad = prevCount === 0;
  // Check if user is scrolled near bottom (within 100px) — auto-scroll if so
  const wasNearBottom = convThread.scrollTop + convThread.clientHeight >= convThread.scrollHeight - 100;

  // Snapshot any focus/selection on the bottom textarea before the wipe,
  // so if the user was mid-typing when a steward switch fires, focus
  // comes back cleanly.
  const _chatSnapshot = captureFormState(convThread);

  convThread.innerHTML = '';

  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'thread-empty';
    empty.textContent = 'No conversation yet';
    convThread.appendChild(empty);
    restoreFormState(_chatSnapshot);
    return;
  }

  messages.forEach(msg => {
    const isUser = msg.role === 'user';
    const row = document.createElement('div');
    row.className = 'chat-row ' + (isUser ? 'from-user' : 'from-steward');

    const wrapper = document.createElement('div');
    wrapper.style.maxWidth = '90%';

    // Avatar bar
    const avatarBar = document.createElement('div');
    avatarBar.className = 'msg-avatar-bar ' + (isUser ? 'user' : 'steward');

    const avIcon = document.createElement('span');
    avIcon.className = 'avatar-icon';
    avIcon.textContent = isUser ? '👤' : '🤖';
    avatarBar.appendChild(avIcon);

    const avName = document.createElement('span');
    avName.className = 'avatar-name';
    avName.textContent = isUser ? 'You' : 'Agent';
    avatarBar.appendChild(avName);

    if (msg.timestamp) {
      const timeBlock = document.createElement('span');
      timeBlock.className = 'avatar-time-block';
      const actual = formatActualTime(msg.timestamp);
      if (actual) {
        const ta = document.createElement('span');
        ta.className = 'avatar-time-actual';
        ta.textContent = actual;
        timeBlock.appendChild(ta);
      }
      const tr = document.createElement('span');
      tr.className = 'avatar-time-relative';
      tr.textContent = relativeTime(msg.timestamp) + ' ago';
      timeBlock.appendChild(tr);
      avatarBar.appendChild(timeBlock);
    }

    wrapper.appendChild(avatarBar);

    // Message bubble
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble ' + (isUser ? 'from-user' : 'from-steward');

    const body = document.createElement('div');
    body.className = 'msg-body';
    // Parse JSON content (walkie-talkie messages)
    const content = parseMessageContent(msg.content || '');
    if (content) {
      body.innerHTML = renderMarkdown(content);
      processLinks(body);
    }
    bubble.appendChild(body);

    wrapper.appendChild(bubble);
    row.appendChild(wrapper);
    convThread.appendChild(row);
  });

  // Scroll to bottom on first load or when user was already near bottom
  if (isFirstLoad || wasNearBottom) {
    convThread.scrollTop = convThread.scrollHeight;
  }
  restoreFormState(_chatSnapshot);
}

// --- Queue update handler ---

window.presenter.onQueueUpdate((newQueue) => {
  const oldIds = new Set(queue.map(i => i.id));
  const oldPinById = new Map(queue.map(i => [i.id, !!i.pinned]));
  const hasNewItems = newQueue.some(i => !oldIds.has(i.id));
  const removedIds = queue.filter(i => !newQueue.find(n => n.id === i.id));
  // Detect in-place field mutations (e.g. pin toggle) by diffing `pinned`.
  // Without this, `changed` stays false and renderView() never fires — the
  // card keeps its stale HTML and Joshua sees no visual update.
  const mutatedInPlace = newQueue.some(i => oldIds.has(i.id) && oldPinById.get(i.id) !== !!i.pinned);
  const changed = newQueue.length !== queue.length || hasNewItems || mutatedInPlace;
  queue = newQueue;

  renderSidebar();

  // FEATURE 2 timeline/play view: re-render on ANY queue change so newly-arrived
  // cards STACK UP behind the one Josh is looking at (his "nothing cuts in line,
  // but they queue up while I watch"). Independent of selectedSteward — the
  // timeline is a macro view across all sessions. Preserve the current front
  // card (don't yank him off it); renderTimelineView re-jumps to newest-unseen
  // only on entry, and mobileDeckJumpTo below keeps him on his current card if
  // it's still live. Guard on `changed` so status-only polls don't thrash.
  if (selectedViewMode === 'timeline') {
    if (changed) {
      // Remember the card Josh is currently viewing so the re-render restores it
      // (new cards stack BEHIND, they don't steal focus).
      const keepId = (window.mobileDeckGetState && window.mobileDeckGetState().currentItemId) || null;
      window._skipAutoScroll = true;
      renderTimelineView(keepId);
      if (hasNewItems) showBottomGlow();
    }
    if (queueCount) queueCount.textContent = queue.length > 0 ? `(${queue.length})` : '';
    return;
  }

  if (selectedSteward && changed) {
    if (removedIds.length > 0) {
      const _sub = findSubstewardForSession(selectedSteward);
      const steward = findStewardForSession(selectedSteward);
      const sessionIds = _sub ? [selectedSteward] : (steward ? getSessionIdsForSteward(steward) : [selectedSteward]);
      Promise.all(sessionIds.map(sid => {
        delete historyCache[sid];
        return fetchHistory(sid);
      })).then(() => renderView());
    } else if (hasNewItems) {
      // New items — render but do NOT scroll to bottom (don't disrupt)
      window._skipAutoScroll = true;
      window._hasUnseenBelow = true;
      renderView();
      showBottomGlow();
    } else if (mutatedInPlace) {
      // In-place field change (e.g. pin toggled on another client). Re-render
      // without scrolling so Joshua's view stays put.
      window._skipAutoScroll = true;
      renderView();
    }
  } else if (!selectedSteward && !window.__pendingRestore) {
    // Auto-select first steward with unread items. Guarded by __pendingRestore
    // so a queue update arriving mid-boot doesn't front-run the localStorage
    // restore. Once the restore block runs, it either picks the saved steward
    // or clears the guard — this path only runs when there's genuinely no
    // saved selection to restore.
    for (const steward of stewards) {
      const unread = getUnreadCountForSteward(steward);
      if (unread > 0) {
        selectSteward(`holler-${steward.id}`);
        return;
      }
    }
    // Check orphan sessions
    const stewardSessionIds = new Set();
    stewards.forEach(s => getSessionIdsForSteward(s).forEach(id => stewardSessionIds.add(id)));
    for (const item of queue) {
      if (item.session_id && !stewardSessionIds.has(item.session_id) && !readState[item.id]) {
        selectSteward(item.session_id);
        return;
      }
    }
  }

  // Update queue count in titlebar
  if (queueCount) {
    queueCount.textContent = queue.length > 0 ? `(${queue.length})` : '';
  }
});

// --- Initial load ---

// Load stewards FIRST, then queue, then render
// --- Restore sidebar state from localStorage ---
try {
  const savedExpanded = localStorage.getItem('presenter-expanded-stewards');
  if (savedExpanded) expandedStewardIds = new Set(JSON.parse(savedExpanded));
} catch {}

// Josh 2026-04-23: set this BEFORE any socket / queue listener fires so the
// unread-auto-select fallback in onQueueUpdate doesn't race ahead of the
// localStorage restore. Cleared once restore completes (success or fallback).
try {
  const _hasSaved = !!localStorage.getItem('presenter-selected-steward');
  if (_hasSaved) window.__pendingRestore = true;
} catch {}

fetchStewards().then(() => {
  return window.presenter.getQueue();
}).then((initialQueue) => {
  queue = initialQueue;
  if (queueCount) {
    queueCount.textContent = queue.length > 0 ? `(${queue.length})` : '';
  }
  renderSidebar();

  // Restore selected steward/substeward after sidebar is rendered.
  // Validates the saved session against the known steward tree + queue
  // session_ids; falls back gracefully if the saved steward is gone
  // (renamed/retired). Josh 2026-04-23: wants deterministic restore
  // across page reloads and Electron relaunches.
  try {
    const savedSteward = localStorage.getItem('presenter-selected-steward');
    const savedMode = localStorage.getItem('presenter-selected-mode');
    const known = new Set();
    for (const s of (stewards || [])) {
      getSessionIdsForSteward(s).forEach(id => known.add(id));
    }
    for (const item of (queue || [])) {
      if (item.session_id) known.add(item.session_id);
    }
    if (savedSteward && known.has(savedSteward)) {
      if (savedMode) selectedViewMode = savedMode;
      selectSteward(savedSteward);
    } else if (savedSteward) {
      // Stale saved steward — clear so the fallback auto-select is clean.
      try { localStorage.removeItem('presenter-selected-steward'); } catch {}
    }
  } catch {}
  // Restore complete (or abandoned) — release the onQueueUpdate guard so
  // future queue updates can drive auto-select when appropriate.
  window.__pendingRestore = false;
});

setInterval(fetchStewards, 30000);
fetchSessionStatuses();
setInterval(fetchSessionStatuses, 10000);
// Per-worker ahead-only git diff — relaxed cadence (30s); the numbers change
// only when a worker commits, and the server caches per-session.
setTimeout(fetchWorkerGitDiffs, 2000);
setInterval(fetchWorkerGitDiffs, 30000);
// Context dashboard — poll every 30s (jsonl scan is moderately heavy)
setTimeout(fetchSessionContext, 1500);
setInterval(fetchSessionContext, 30000);

// Recency/frequency ring — paint once on load, then recompute + repaint every
// time JOSH SENDS a walkie (walkie:enqueued carries his from-tag). This is the
// trigger Josh asked for: the ring updates when he invokes the walkie-talkie.
// A light 5-min poll backstops missed socket events (server restart mid-send).
setTimeout(fetchRecencyRing, 1800);
if (window.presenter && typeof window.presenter.onWalkieEnqueued === 'function') {
  window.presenter.onWalkieEnqueued((payload) => {
    const msg = (payload && payload.message) || '';
    // Only Josh's OWN sends move the ring — not steward-to-steward chatter.
    if (msg.includes('josh-presenter') || msg.includes('josh-mobile')) {
      // Small delay so the archive/queue write has committed before we re-read.
      setTimeout(fetchRecencyRing, 400);
    }
  });
}
setInterval(fetchRecencyRing, 300000);

// Refresh relative timestamps every 30s (sidebar only — don't touch thread while typing)
setInterval(() => {
  renderSidebar();
}, 30000);

// --- Minimize button ---

if (btnMinimize) btnMinimize.addEventListener('click', () => {
  if (window.presenter.collapse) {
    window.presenter.collapse();
  } else {
    window.presenter.minimize();
  }
});

// --- StewInt right panel (native, no iframe) ---
(function() {
  const stewintPanel = document.getElementById('stewint-panel');
  const stewintIframe = document.getElementById('stewint-iframe');
  const stewintContent = document.getElementById('stewint-content');
  const stewintToggle = document.getElementById('stewint-toggle');
  const stewintOpenBtn = document.getElementById('stewint-open-btn');
  const stewintDragHandle = document.getElementById('stewint-drag-handle');
  if (!stewintPanel || !stewintContent) return;

  let stewintVisible = false;
  let stewintStewardId = null;
  let activeTab = 'stewint'; // 'stewint' or 'metadata'

  // Per-steward dashboard state (localStorage-backed)
  let stewintPerSteward = {};
  try {
    const stored = localStorage.getItem('stewint-per-steward');
    if (stored) stewintPerSteward = JSON.parse(stored);
  } catch { stewintPerSteward = {}; }

  function saveStewintPerSteward() {
    try { localStorage.setItem('stewint-per-steward', JSON.stringify(stewintPerSteward)); } catch {}
  }

  function getStewintOpenForSteward(stewardId) {
    return stewintPerSteward[stewardId] === true;
  }

  function setStewintOpenForSteward(stewardId, open) {
    stewintPerSteward[stewardId] = open;
    saveStewintPerSteward();
  }

  const isNarrow = () => window.innerWidth < 600 || document.body.classList.contains('embedded');

  // --- Tab switching ---
  const tabs = stewintPanel.querySelectorAll('.stewint-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      if (activeTab === 'stewint') {
        stewintIframe.style.display = '';
        stewintContent.style.display = 'none';
      } else {
        stewintIframe.style.display = 'none';
        stewintContent.style.display = '';
      }
    });
  });

  // --- Drag handle for resizing ---
  if (stewintDragHandle) {
    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    stewintDragHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startWidth = stewintPanel.offsetWidth;
      stewintDragHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      if (stewintIframe) stewintIframe.style.pointerEvents = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const diff = startX - e.clientX;
      const newWidth = Math.max(200, Math.min(window.innerWidth * 0.8, startWidth + diff));
      stewintPanel.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      stewintDragHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (stewintIframe) stewintIframe.style.pointerEvents = '';
      try { localStorage.setItem('stewint-width', stewintPanel.style.width); } catch {}
    });

    try {
      const savedWidth = localStorage.getItem('stewint-width');
      if (savedWidth) stewintPanel.style.width = savedWidth;
    } catch {}
  }

  // --- Sidebar drag handle for resizing ---
  const sidebarEl = document.getElementById('sidebar');
  const sidebarDragHandle = document.getElementById('sidebar-drag-handle');
  if (sidebarDragHandle && sidebarEl) {
    let isSidebarDragging = false;
    let sidebarStartX = 0;
    let sidebarStartWidth = 0;

    sidebarDragHandle.addEventListener('mousedown', (e) => {
      isSidebarDragging = true;
      sidebarStartX = e.clientX;
      sidebarStartWidth = sidebarEl.offsetWidth;
      sidebarDragHandle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isSidebarDragging) return;
      const diff = e.clientX - sidebarStartX;
      const newWidth = Math.max(120, Math.min(500, sidebarStartWidth + diff));
      sidebarEl.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isSidebarDragging) return;
      isSidebarDragging = false;
      sidebarDragHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('sidebar-width', sidebarEl.style.width); } catch {}
    });

    try {
      const savedSidebarWidth = localStorage.getItem('sidebar-width');
      if (savedSidebarWidth) sidebarEl.style.width = savedSidebarWidth;
    } catch {}
  }

  function renderStewintContent(steward) {
    stewintContent.innerHTML = '';
    if (!steward) return;

    // Steward info section
    const infoSection = document.createElement('div');
    infoSection.className = 'si-section';
    const infoTitle = document.createElement('div');
    infoTitle.className = 'si-section-title';
    infoTitle.textContent = steward.icon ? `${steward.icon} ${steward.name}` : steward.name;
    infoSection.appendChild(infoTitle);

    const typeInfo = document.createElement('div');
    typeInfo.className = 'si-info';
    typeInfo.innerHTML = `<div class="si-info-label">Type</div><div class="si-info-value">${steward.type || 'unknown'}</div>`;
    infoSection.appendChild(typeInfo);

    if (steward.buildData && steward.buildData.project) {
      const projInfo = document.createElement('div');
      projInfo.className = 'si-info';
      projInfo.innerHTML = `<div class="si-info-label">Project</div><div class="si-info-value">${steward.buildData.project}</div>`;
      infoSection.appendChild(projInfo);
    }

    stewintContent.appendChild(infoSection);

    // Builds section (for build stewards)
    if (steward.buildData && steward.buildData.builds && steward.buildData.builds.length > 0) {
      const buildsSection = document.createElement('div');
      buildsSection.className = 'si-section';
      const buildsTitle = document.createElement('div');
      buildsTitle.className = 'si-section-title';
      buildsTitle.textContent = `Builds (${steward.buildData.builds.filter(b => b.status === 'active').length} active)`;
      buildsSection.appendChild(buildsTitle);

      steward.buildData.builds.forEach(build => {
        const buildEl = document.createElement('div');
        buildEl.className = 'si-build';

        const dot = document.createElement('div');
        dot.className = 'si-build-dot';
        // Check session status for this build
        const folder = (build.worktree || '').split('/').pop() || '';
        const buildSessionId = `holler-${steward.buildData.project}--${folder}`;
        const status = sessionStatuses[buildSessionId];
        const isWorking = status && status.status === 'working';
        const isWaiting = status && status.status === 'waiting';
        dot.style.background = isWorking ? '#FFCC00' : isWaiting ? '#00FF66' : '#333';
        if (isWorking) dot.style.animation = 'pulse 1s ease-in-out infinite';
        buildEl.appendChild(dot);

        const name = document.createElement('div');
        name.className = 'si-build-name';
        name.textContent = build.branch
          .replace(/^joshua-mullet-town\//, '')
          .replace(/^jmullet\//, '')
          .replace(/^(feature|bugfix|hotfix|fix)\//, '');
        buildEl.appendChild(name);

        const statusLabel = document.createElement('div');
        statusLabel.className = 'si-build-status';
        statusLabel.textContent = isWorking ? 'working' : isWaiting ? 'waiting' : build.status;
        buildEl.appendChild(statusLabel);

        buildsSection.appendChild(buildEl);
      });

      stewintContent.appendChild(buildsSection);
    }

    // Session status section
    const statusSection = document.createElement('div');
    statusSection.className = 'si-section';
    const statusTitle = document.createElement('div');
    statusTitle.className = 'si-section-title';
    statusTitle.textContent = 'Sessions';
    statusSection.appendChild(statusTitle);

    const stewardIds = getSessionIdsForSteward(steward);
    stewardIds.forEach(sid => {
      const status = sessionStatuses[sid];
      if (!status) return;
      const row = document.createElement('div');
      row.className = 'si-build';
      const dot = document.createElement('div');
      dot.className = 'si-build-dot';
      dot.style.background = status.status === 'working' ? '#FFCC00' : '#00FF66';
      if (status.status === 'working') dot.style.animation = 'pulse 1s ease-in-out infinite';
      row.appendChild(dot);
      const name = document.createElement('div');
      name.className = 'si-build-name';
      name.textContent = sessionDisplayName(sid);
      row.appendChild(name);
      const label = document.createElement('div');
      label.className = 'si-build-status';
      label.textContent = status.status;
      row.appendChild(label);
      statusSection.appendChild(row);
    });

    if (statusSection.children.length > 1) {
      stewintContent.appendChild(statusSection);
    }
  }

  function showStewintPanel(stewardId) {
    if (isNarrow()) return;
    stewintStewardId = stewardId;
    setStewintOpenForSteward(stewardId, true);
    const steward = findStewardForSession(`holler-${stewardId}`);
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    stewintPanel.style.display = 'flex';
    if (stewintDragHandle) stewintDragHandle.style.display = '';
    stewintVisible = true;
    if (stewintOpenBtn) stewintOpenBtn.style.display = 'none';
    if (stewintIframe) stewintIframe.src = `${SERVER_URL}/stewint/${stewardId}`;
    if (activeTab === 'stewint') {
      stewintIframe.style.display = '';
      stewintContent.style.display = 'none';
    } else {
      stewintIframe.style.display = 'none';
      stewintContent.style.display = '';
    }
    renderStewintContent(steward);
  }

  function hideStewintPanel() {
    if (stewintStewardId) setStewintOpenForSteward(stewintStewardId, false);
    stewintPanel.style.display = 'none';
    if (stewintDragHandle) stewintDragHandle.style.display = 'none';
    if (stewintIframe) stewintIframe.src = '';
    if (stewintContent) stewintContent.innerHTML = '';
    stewintVisible = false;
    stewintStewardId = null;
    if (stewintOpenBtn && selectedSteward) stewintOpenBtn.style.display = 'flex';
  }

  if (stewintToggle) stewintToggle.addEventListener('click', hideStewintPanel);
  if (stewintOpenBtn) {
    stewintOpenBtn.addEventListener('click', () => {
      if (selectedSteward) {
        const id = selectedSteward.replace(/^holler-(?:steward-)?/, '');
        showStewintPanel(id);
      }
    });
  }

  window._stewint = {
    update(sessionId) {
      if (!sessionId) return;
      const id = sessionId.replace(/^holler-(?:steward-)?/, '');
      const shouldBeOpen = getStewintOpenForSteward(id);

      if (!isNarrow()) {
        // Show the open button only if this steward's dashboard is closed
        if (stewintOpenBtn) stewintOpenBtn.style.display = shouldBeOpen ? 'none' : 'flex';
      }

      if (shouldBeOpen) {
        // This steward had their dashboard open — restore it
        if (id !== stewintStewardId) {
          showStewintPanel(id);
        } else if (stewintContent) {
          const steward = findStewardForSession(sessionId);
          if (steward) renderStewintContent(steward);
        }
      } else if (stewintVisible) {
        // Switching to a steward with dashboard closed — hide it
        // But don't save state (it's already false for this steward)
        stewintPanel.style.display = 'none';
        if (stewintDragHandle) stewintDragHandle.style.display = 'none';
        if (stewintIframe) stewintIframe.src = '';
        if (stewintContent) stewintContent.innerHTML = '';
        stewintVisible = false;
        stewintStewardId = null;
        if (stewintOpenBtn) stewintOpenBtn.style.display = 'flex';
      }
    },
    hide() {
      if (stewintOpenBtn) stewintOpenBtn.style.display = 'none';
      hideStewintPanel();
    },
    refresh() {
      if (stewintVisible && stewintStewardId) {
        const steward = findStewardForSession(`holler-${stewintStewardId}`);
        if (steward) renderStewintContent(steward);
      }
    }
  };
})();

// --- Local sent bubble helpers ---

// --- Persistent sent messages ---
// Save sent messages to localStorage so they survive re-renders and steward switches
let sentMessages = {};
try {
  const stored = localStorage.getItem('presenter-sent-messages');
  if (stored) sentMessages = JSON.parse(stored);
} catch { sentMessages = {}; }

function saveSentMessages() {
  try { localStorage.setItem('presenter-sent-messages', JSON.stringify(sentMessages)); } catch {}
}

// Clean up messages older than 24 hours
function cleanOldSentMessages() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const sid of Object.keys(sentMessages)) {
    sentMessages[sid] = (sentMessages[sid] || []).filter(m => m.timestamp > cutoff);
    if (sentMessages[sid].length === 0) delete sentMessages[sid];
  }
  saveSentMessages();
}
cleanOldSentMessages();

function addSentMessage(sessionId, text) {
  if (!sentMessages[sessionId]) sentMessages[sessionId] = [];
  const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), text, timestamp: Date.now(), status: 'sending' };
  sentMessages[sessionId].push(msg);
  saveSentMessages();
  return msg.id;
}

function updateSentMessageStatus(sessionId, msgId, status) {
  const msgs = sentMessages[sessionId] || [];
  const msg = msgs.find(m => m.id === msgId);
  if (msg) { msg.status = status; saveSentMessages(); }
}

function getSentMessagesForSteward(sessionId) {
  if (!sessionId) return [];
  const steward = findStewardForSession(sessionId);
  const sessionIds = steward ? getSessionIdsForSteward(steward) : [sessionId];
  let all = [];
  sessionIds.forEach(sid => { all = all.concat(sentMessages[sid] || []); });
  // Also include messages sent to the primary session ID
  if (!all.length && sentMessages[sessionId]) all = sentMessages[sessionId];
  return all.sort((a, b) => a.timestamp - b.timestamp);
}

function appendLocalSentBubble(text) {
  if (!convThread) return null;

  const row = document.createElement('div');
  row.className = 'chat-row from-user just-sent';

  const wrapper = document.createElement('div');
  wrapper.style.maxWidth = '90%';

  // Avatar bar
  const avatarBar = document.createElement('div');
  avatarBar.className = 'msg-avatar-bar user';

  const avIcon = document.createElement('span');
  avIcon.className = 'avatar-icon';
  avIcon.textContent = '👤';
  avatarBar.appendChild(avIcon);

  const avName = document.createElement('span');
  avName.className = 'avatar-name';
  avName.textContent = 'You';
  avatarBar.appendChild(avName);

  const timeBlock = document.createElement('span');
  timeBlock.className = 'avatar-time-block';
  const timeActual = document.createElement('span');
  timeActual.className = 'avatar-time-actual';
  timeActual.textContent = formatActualTime(Date.now());
  timeBlock.appendChild(timeActual);
  const timeRel = document.createElement('span');
  timeRel.className = 'avatar-time-relative';
  timeRel.textContent = 'now';
  timeBlock.appendChild(timeRel);
  avatarBar.appendChild(timeBlock);

  const statusSpan = document.createElement('span');
  statusSpan.className = 'sent-status';
  statusSpan.style.cssText = 'font-size:12px;color:#888;margin-left:4px;';
  statusSpan.textContent = 'sending...';
  avatarBar.appendChild(statusSpan);

  wrapper.appendChild(avatarBar);

  // Bubble
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble from-user sent-local';

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = renderMarkdown(text);
  processLinks(body);
  bubble.appendChild(body);

  wrapper.appendChild(bubble);
  row.appendChild(wrapper);
  convThread.appendChild(row);

  // Scroll to bottom
  convThread.scrollTop = convThread.scrollHeight;

  return row;
}

function markSentConfirmed(row) {
  if (!row) return;
  const status = row.querySelector('.sent-status');
  if (status) {
    status.innerHTML = '<span class="sent-check">✓</span>';
    setTimeout(() => { if (status.parentNode) status.textContent = ''; }, 3000);
  }
  const bubble = row.querySelector('.msg-bubble');
  if (bubble) {
    bubble.classList.remove('sent-local');
    bubble.classList.add('sent-confirmed');
  }
}

function markSentFailed(row) {
  if (!row) return;
  const status = row.querySelector('.sent-status');
  if (status) {
    status.textContent = 'failed';
    status.style.color = '#FF3333';
  }
}

// Build DOM element for a persisted sent message
function buildSentMessageElement(msg) {
  const row = document.createElement('div');
  row.className = 'chat-row from-user';
  row.dataset.sentId = msg.id;

  const wrapper = document.createElement('div');
  wrapper.style.maxWidth = '90%';

  const avatarBar = document.createElement('div');
  avatarBar.className = 'msg-avatar-bar user';
  avatarBar.innerHTML = `<span class="avatar-icon">👤</span><span class="avatar-name">You</span>` +
    `<span class="avatar-time-block"><span class="avatar-time-actual">${formatActualTime(msg.timestamp)}</span>` +
    `<span class="avatar-time-relative">${relativeTime(msg.timestamp)}</span></span>`;
  if (msg.status === 'failed') {
    avatarBar.innerHTML += '<span style="font-size:12px;color:#FF3333;margin-left:4px;">failed</span>';
  }
  wrapper.appendChild(avatarBar);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble from-user' + (msg.status === 'sent' ? ' sent-confirmed' : msg.status === 'failed' ? ' sent-failed' : ' sent-local');
  bubble.innerHTML = `<div class="msg-body">${renderMarkdown(msg.text)}</div>`;
  processLinks(bubble);
  wrapper.appendChild(bubble);

  row.appendChild(wrapper);
  return row;
}

// --- Bookmarks: per-steward link list, opens real browser via shell.openExternal ---
(function() {
  const pill = document.getElementById('embedded-view-pill');
  const dropdown = document.getElementById('bookmarks-dropdown');
  if (!pill || !dropdown) return;

  let bookmarks = {};
  let openState = {};
  try { bookmarks = JSON.parse(localStorage.getItem('steward-bookmarks') || '{}'); } catch {}
  try { openState = JSON.parse(localStorage.getItem('steward-bookmarks-open') || '{}'); } catch {}

  // Hydrate from server. Server is source of truth for any session it knows
  // about; localStorage-only entries (manual UI adds while offline) are
  // preserved. Used both on startup and on every `presenter:bookmarks-updated`
  // socket event so steward-initiated POSTs surface without a reload.
  async function hydrateFromServer() {
    try {
      const res = await fetch('/api/bookmarks');
      if (!res.ok) return;
      const serverStore = await res.json();
      if (!serverStore || typeof serverStore !== 'object') return;
      let changed = false;
      for (const sessionId of Object.keys(serverStore)) {
        const incoming = Array.isArray(serverStore[sessionId]) ? serverStore[sessionId] : [];
        bookmarks[sessionId] = incoming;
        changed = true;
      }
      if (changed) {
        try { localStorage.setItem('steward-bookmarks', JSON.stringify(bookmarks)); } catch {}
        if (selectedSteward) {
          updatePillLabel(selectedSteward);
          if (openState[selectedSteward]) render();
        }
      }
    } catch (err) {
      console.warn('[bookmarks] server hydrate failed:', err);
    }
  }

  hydrateFromServer();

  // Real-time push: server emits `presenter:bookmarks-updated` after every
  // POST/DELETE to /api/bookmarks. Re-run the same hydrate path.
  if (window.presenter && typeof window.presenter.onBookmarksUpdated === 'function') {
    window.presenter.onBookmarksUpdated(() => { hydrateFromServer(); });
  }

  function pushToServer(stewardId) {
    if (!stewardId) return;
    fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_name: stewardId,
        bookmarks: bookmarks[stewardId] || [],
        mode: 'replace',
      }),
    }).catch((err) => console.warn('[bookmarks] server push failed:', err));
  }

  function save() {
    try { localStorage.setItem('steward-bookmarks', JSON.stringify(bookmarks)); } catch {}
    pushToServer(selectedSteward);
  }
  function saveOpen() {
    try { localStorage.setItem('steward-bookmarks-open', JSON.stringify(openState)); } catch {}
  }
  function listFor(stewardId) {
    if (!bookmarks[stewardId]) bookmarks[stewardId] = [];
    return bookmarks[stewardId];
  }
  function updatePillLabel(stewardId) {
    const n = stewardId ? listFor(stewardId).length : 0;
    pill.textContent = n > 0 ? `Bookmarks (${n})` : 'Bookmarks';
  }

  function render() {
    const stewardId = selectedSteward;
    dropdown.innerHTML = '';
    if (!stewardId) {
      const empty = document.createElement('div');
      empty.className = 'bookmarks-empty';
      empty.textContent = 'Select a steward first';
      dropdown.appendChild(empty);
      return;
    }
    const items = listFor(stewardId);
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bookmarks-empty';
      empty.textContent = 'No bookmarks yet';
      dropdown.appendChild(empty);
    } else {
      items.forEach((bm, idx) => {
        const row = document.createElement('div');
        row.className = 'bookmark-row';

        const link = document.createElement('button');
        link.className = 'bookmark-link';
        const isScript = !!bm.run;
        const fallbackText = bm.url || bm.run || '';
        link.textContent = bm.label || (isScript ? fallbackText.slice(0, 40) : fallbackText);
        link.title = bm.url || bm.run || '';
        link.addEventListener('click', () => {
          if (isScript) {
            // Scripted bookmarks always run on the laptop, but can be triggered
            // from any client. On the Electron presenter we have a direct IPC
            // path to the main process. On the APK / mobile web we POST to
            // /api/presenter/run-command, which validates the command against
            // the saved bookmark store and forwards it via socket to the
            // Electron client.
            const isEmbedded = document.body.classList.contains('embedded');
            if (!isEmbedded) {
              window.presenter.runCommand(bm.run);
              return;
            }
            const SERVER_URL = window.location.origin || 'http://localhost:3005';
            fetch(`${SERVER_URL}/api/presenter/run-command`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ stewardId, runValue: bm.run }),
            }).then(async (res) => {
              if (!res.ok) {
                const body = await res.text().catch(() => '');
                console.warn('[bookmarks] remote run failed:', res.status, body);
              }
            }).catch((err) => console.warn('[bookmarks] remote run fetch error:', err));
            return;
          }
          if (window.presenter && window.presenter.openUrl) window.presenter.openUrl(bm.url);
        });

        const editBtn = document.createElement('button');
        editBtn.className = 'bookmark-action';
        editBtn.textContent = '✎';
        editBtn.title = 'Edit';
        editBtn.addEventListener('click', () => promptEdit(stewardId, idx));

        const delBtn = document.createElement('button');
        delBtn.className = 'bookmark-action';
        delBtn.textContent = '✕';
        delBtn.title = 'Remove';
        delBtn.addEventListener('click', () => {
          items.splice(idx, 1);
          save();
          render();
          updatePillLabel(stewardId);
        });

        row.appendChild(link);
        row.appendChild(editBtn);
        row.appendChild(delBtn);
        dropdown.appendChild(row);
      });
    }

    const addRow = document.createElement('div');
    addRow.className = 'bookmark-add-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'bookmark-add-btn';
    addBtn.textContent = '+ Add bookmark';
    addBtn.addEventListener('click', () => promptAdd(stewardId));
    addRow.appendChild(addBtn);
    dropdown.appendChild(addRow);
  }

  function promptAdd(stewardId) {
    const url = window.prompt('URL (leave blank for script bookmark):') || '';
    let run = '';
    if (!url.trim()) {
      run = window.prompt('Script (shell command to run on click):') || '';
      if (!run.trim()) return;
    }
    const defaultLabel = url.trim() || run.trim();
    const label = window.prompt('Label (leave blank to use URL/script):') || defaultLabel;
    const entry = url.trim() ? { label, url: url.trim() } : { label, run: run.trim() };
    listFor(stewardId).push(entry);
    save();
    render();
    updatePillLabel(stewardId);
  }

  function promptEdit(stewardId, idx) {
    const items = listFor(stewardId);
    const current = items[idx];
    const isScript = !!current.run;
    let newEntry;
    if (isScript) {
      const run = window.prompt('Script:', current.run);
      if (!run || !run.trim()) return;
      const label = window.prompt('Label:', current.label) || run.trim();
      newEntry = { label, run: run.trim() };
    } else {
      const url = window.prompt('URL:', current.url);
      if (!url || !url.trim()) return;
      const label = window.prompt('Label:', current.label) || url.trim();
      newEntry = { label, url: url.trim() };
    }
    items[idx] = newEntry;
    save();
    render();
    updatePillLabel(stewardId);
  }

  // Tap-outside-to-close (Joshua 2026-07-14): same idiom as the Links pill —
  // tapping outside the panel AND the pill closes through setOpen() so the
  // persisted open-state stays coherent. Deferred capture-phase listener.
  function _bookmarksOutsideClick(e) {
    if (dropdown.contains(e.target) || pill.contains(e.target)) return;
    setOpen(selectedSteward, false);
  }
  // Arm/disarm from every show/hide path (pill tap, steward-switch, restore)
  // so the listener is present whenever the panel is actually open.
  function armBookmarksOutsideClick(open) {
    document.removeEventListener('click', _bookmarksOutsideClick, true);
    if (open) {
      setTimeout(() => document.addEventListener('click', _bookmarksOutsideClick, true), 0);
    }
  }

  function setOpen(stewardId, open) {
    if (!stewardId) return;
    openState[stewardId] = open;
    saveOpen();
    dropdown.style.display = open ? 'flex' : 'none';
    armBookmarksOutsideClick(open);
  }

  pill.addEventListener('click', () => {
    if (!selectedSteward) return;
    const isOpen = dropdown.style.display === 'flex';
    setOpen(selectedSteward, !isOpen);
    if (!isOpen) render();
  });

  async function refreshFromServer(sessionId) {
    if (!sessionId) return false;
    try {
      const res = await fetch(`/api/bookmarks?session=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return false;
      const payload = await res.json();
      const incoming = Array.isArray(payload?.bookmarks) ? payload.bookmarks : null;
      if (!incoming) return false;
      bookmarks[sessionId] = incoming;
      try { localStorage.setItem('steward-bookmarks', JSON.stringify(bookmarks)); } catch {}
      return true;
    } catch (err) {
      console.warn('[bookmarks] per-session refresh failed:', err);
      return false;
    }
  }

  window._bookmarks = {
    update(sessionId) {
      updatePillLabel(sessionId);
      const wantOpen = !!openState[sessionId];
      dropdown.style.display = wantOpen ? 'flex' : 'none';
      armBookmarksOutsideClick(wantOpen);
      if (wantOpen) render();
      refreshFromServer(sessionId).then((changed) => {
        if (!changed || sessionId !== selectedSteward) return;
        updatePillLabel(sessionId);
        if (openState[sessionId]) render();
      });
    }
  };

  updatePillLabel(selectedSteward);
  if (selectedSteward && openState[selectedSteward]) {
    dropdown.style.display = 'flex';
    armBookmarksOutsideClick(true);
    render();
  }
})();

// --- Card Links: auto-saved links from presenter cards, per top-steward ---
// Populated automatically by the server when a labeled card link is posted
// (see lib/presenter-queue.js addItem). This UI is read + open + forget only;
// there is no manual add (that's what Bookmarks is for). Each entry is a
// living record { title, url, created_at, last_opened }. Clicking opens the
// real browser AND stamps last_opened. The X forgets the entry.
(function() {
  // R4 (Josh 2026-08-13): the top #card-links-pill was removed; Links now open
  // from a per-card FOOTER button (see the card renderer, window._cardLinks
  // .toggle()). The pill is optional now — only the #card-links-dropdown
  // overlay is required. All pill.* uses below are null-guarded.
  const pill = document.getElementById('card-links-pill');
  const dropdown = document.getElementById('card-links-dropdown');
  if (!dropdown) return;

  let links = {};   // { stewardId: [ {title,url,created_at,last_opened} ] }
  let openState = {};
  try { links = JSON.parse(localStorage.getItem('steward-card-links') || '{}'); } catch {}
  try { openState = JSON.parse(localStorage.getItem('steward-card-links-open') || '{}'); } catch {}

  function saveLocal() {
    try { localStorage.setItem('steward-card-links', JSON.stringify(links)); } catch {}
  }
  function saveOpen() {
    try { localStorage.setItem('steward-card-links-open', JSON.stringify(openState)); } catch {}
  }
  function listFor(stewardId) {
    if (!links[stewardId]) links[stewardId] = [];
    return links[stewardId];
  }
  function updatePillLabel(stewardId) {
    // Links live under the TOP steward (prefix before "--"), same as render().
    // Resolve here too so the live count reflects the right collection whether a
    // sub-steward or the top steward is selected.
    const top = topStewardOf(stewardId);
    const n = top ? listFor(top).length : 0;
    if (pill) pill.textContent = n > 0 ? `Links (${n})` : 'Links';
    // Repaint any per-card footer Links buttons currently in the deck so their
    // live count stays in sync (R4).
    if (typeof window._repaintFooterLinks === 'function') window._repaintFooterLinks();
  }

  // Server is the source of truth. Hydrate the full store on startup and on
  // every `presenter:card-links-updated` socket event.
  async function hydrateFromServer() {
    try {
      const res = await fetch('/api/card-links');
      if (!res.ok) return;
      const serverStore = await res.json();
      if (!serverStore || typeof serverStore !== 'object') return;
      let changed = false;
      for (const sessionId of Object.keys(serverStore)) {
        links[sessionId] = Array.isArray(serverStore[sessionId]) ? serverStore[sessionId] : [];
        changed = true;
      }
      if (changed) {
        saveLocal();
        if (selectedSteward) {
          updatePillLabel(selectedSteward);
          if (openState[selectedSteward]) render();
        }
      }
    } catch (err) {
      console.warn('[card-links] server hydrate failed:', err);
    }
  }

  hydrateFromServer();

  if (window.presenter && typeof window.presenter.onCardLinksUpdated === 'function') {
    window.presenter.onCardLinksUpdated(() => { hydrateFromServer(); });
  }

  // Links roll up to the top steward (prefix before first "--"), mirroring the
  // server. The pill is anchored to whichever steward is selected; the top
  // steward is who owns the collection.
  function topStewardOf(sessionId) {
    if (!sessionId) return sessionId;
    const idx = sessionId.indexOf('--');
    return idx === -1 ? sessionId : sessionId.slice(0, idx);
  }

  function fmtRelative(ts) {
    if (!ts) return null;
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  }

  // Facelift shorthand (Josh 2026-08-23 "make created/last-opened clearer, nicer
  // shorthand"). Recent reads relative ("2m ago","3h ago","yesterday"); older
  // collapses to a short absolute date ("Aug 14", plus year across years) so a
  // glance tells time-of-day-ago vs which-day. Returns null for a falsy ts so the
  // caller can render a clean "Never opened" instead of an ugly blank.
  const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Badge-sized time (Josh 2026-09-04): "25m", not "OPENED 25m ago". He was
  // blunt about the noise — "of course it's gonna be 25 minutes ago, we don't
  // need to add the word ago". So: no "ago", no "just now", no "yesterday"
  // spelled out. fmtShorthand stays as-is because other callers still want the
  // long form; this is the compact variant the hanging badges use.
  function fmtBadgeTime(ts) {
    if (!ts) return null;
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const d = Math.floor(hr / 24);
    if (d < 7) return `${d}d`;
    // Older than a week → short absolute date, year only when it differs.
    const then = new Date(ts);
    const label = `${_MONTHS[then.getMonth()]} ${then.getDate()}`;
    return then.getFullYear() === new Date().getFullYear()
      ? label
      : `${label} '${String(then.getFullYear()).slice(2)}`;
  }

  function fmtShorthand(ts) {
    if (!ts) return null;
    const now = Date.now();
    const diff = now - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return `${d}d ago`;
    // Older than a week → short absolute date, with year only when it differs.
    const then = new Date(ts);
    const nowD = new Date(now);
    const label = `${_MONTHS[then.getMonth()]} ${then.getDate()}`;
    return then.getFullYear() === nowD.getFullYear()
      ? label
      : `${label}, ${then.getFullYear()}`;
  }

  // Recency → COLOR (Josh 2026-08-23, "Signal Dots" design #1 of the 10-variation
  // gallery he picked). Time is encoded as color so it reads at a glance without
  // squinting at text: OPENED runs a warm scale (fresh green → lime → amber →
  // orange → muted brick as it ages), ADDED runs a distinct cool scale (new blue
  // → violet → indigo → grey) so the two are instantly tellable apart. A null ts
  // ("never") returns a neutral grey. `freshness` normalizes age to 0..1 over a
  // 45-day span (1 = brand new, 0 = old).
  function _freshness(ts) {
    if (!ts) return -1;
    const span = 45 * 24 * 60 * 60 * 1000;
    return Math.max(0, Math.min(1, 1 - (Date.now() - ts) / span));
  }
  function _lerpStops(stops, f) {
    for (let i = 0; i < stops.length - 1; i++) {
      const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
      if (f >= p0 && f <= p1) {
        const t = (f - p0) / (p1 - p0 || 1);
        const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
      }
    }
    const last = stops[stops.length - 1][1];
    return `rgb(${last[0]},${last[1]},${last[2]})`;
  }
  function openColor(ts) {
    const f = _freshness(ts);
    if (f < 0) return '#5a5a62';
    return _lerpStops([[0.0, [154,107,107]], [0.25, [224,138,58]], [0.5, [224,195,65]], [0.75, [143,209,79]], [1.0, [47,224,138]]], f);
  }
  function addColor(ts) {
    const f = _freshness(ts);
    if (f < 0) return '#5a5a62';
    return _lerpStops([[0.0, [106,106,114]], [0.33, [138,109,154]], [0.66, [127,123,230]], [1.0, [74,163,255]]], f);
  }
  function _rgba(rgb, a) { return rgb.replace('rgb(', 'rgba(').replace(')', `,${a})`); }
  // Build a color-coded time chip (label + value), tinted to `color`. `muted`
  // renders the neutral "never" treatment.
  function timeChip(kind, value, color, muted) {
    const c = document.createElement('span');
    c.className = 'card-link-chip' + (muted ? ' is-muted' : '');
    // The tint goes on as a background-IMAGE layer, not a translucent
    // background-color, so it composites over the OPAQUE panel-toned color the
    // stylesheet sets rather than over whatever the badge is overlapping. That
    // is what stops the button's border line showing through the badge
    // (Josh 2026-09-04: "that orange shows right through all the badges").
    if (muted) {
      c.style.backgroundImage = 'linear-gradient(#202024, #202024)';
      c.style.color = '#8a8a8a';
      c.style.borderColor = '#2c2c31';
    } else {
      const tint = _rgba(color, 0.14);
      c.style.backgroundImage = `linear-gradient(${tint}, ${tint})`;
      c.style.color = color;
      c.style.borderColor = _rgba(color, 0.32);
    }
    const k = document.createElement('span');
    k.className = 'card-link-chip-k';
    k.textContent = kind;
    k.style.color = muted ? '#6a6a6a' : _rgba(color, 0.9);
    const v = document.createElement('span');
    v.className = 'card-link-chip-v';
    v.textContent = value;
    c.appendChild(k);
    c.appendChild(v);
    return c;
  }

  // Friendly worker name for a link's `by …` label (Josh 2026-08-14). Prefer the
  // human source label, drop the trailing role noise ("worker"/"build"/
  // "builder") so it reads as the worker's name, then fall back to the raw
  // branch suffix (created_by). Returns '' when no worker made the link.
  function friendlyWorker(lk) {
    if (!lk || !lk.created_by) return '';
    const label = typeof lk.created_by_label === 'string' ? lk.created_by_label.trim() : '';
    const base = label || String(lk.created_by);
    const trimmed = base.replace(/[\s-]*(worker|build|builder)$/i, '').trim();
    const out = trimmed || String(lk.created_by);
    // Josh 2026-09-04: when created_by_label is null (most workers), `base` is
    // the RAW session id and this returned it verbatim — "homestead-story-
    // interview-guide", lowercase and dashed. Route it through dnHumanize, the
    // presenter's ONE canonical display-name formatter, which is what every
    // other worker label in the UI already uses: it title-cases, de-dashes, and
    // turns a "gh-1606" suffix into "#1606". Formatting is the display layer's
    // job — nothing about the stored name changes.
    try {
      if (typeof dnHumanize === 'function') return dnHumanize(out) || out;
    } catch (e) {}
    return out;
  }

  // The per-row three-dot menu (Josh 2026-09-09). Exactly two actions: Pin/
  // Unpin and Remove. Rendered into document.body rather than into the row so
  // the panel's own scroll/overflow can't clip it, and positioned against the
  // dot button's live rect. Any open menu is torn down first, so at most one
  // exists at a time.
  let _openRowMenu = null;
  function closeRowMenu() {
    if (_openRowMenu) {
      _openRowMenu.remove();
      _openRowMenu = null;
      document.removeEventListener('click', closeRowMenu, true);
    }
  }
  function openRowMenu(anchorEl, lk, onTogglePin, onRemove) {
    const wasMine = _openRowMenu && _openRowMenu._anchor === anchorEl;
    closeRowMenu();
    if (wasMine) return;   // second tap on the same dots closes it

    const menu = document.createElement('div');
    menu.className = 'card-link-menu';
    menu._anchor = anchorEl;

    const mkItem = (label, glyph, handler) => {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'card-link-menu-item';
      const g = document.createElement('span');
      g.className = 'card-link-menu-glyph';
      g.textContent = glyph;
      it.appendChild(g);
      const t = document.createElement('span');
      t.textContent = label;
      it.appendChild(t);
      it.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        closeRowMenu();
        handler();
      });
      return it;
    };

    menu.appendChild(mkItem(lk.pinned ? 'Unpin' : 'Pin', lk.pinned ? '📌' : '📌', onTogglePin));
    menu.appendChild(mkItem('Remove', '🗑', onRemove));
    document.body.appendChild(menu);

    // Anchor to the dots, flipping above/left when it would run off-screen.
    const r = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth || 150;
    const mh = menu.offsetHeight || 80;
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    let left = r.right - mw;
    if (left < 8) left = 8;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;

    _openRowMenu = menu;
    setTimeout(() => document.addEventListener('click', closeRowMenu, true), 0);
  }

  function render() {
    const stewardId = topStewardOf(selectedSteward);
    closeRowMenu();
    dropdown.innerHTML = '';
    if (!stewardId) {
      const empty = document.createElement('div');
      empty.className = 'card-links-empty';
      empty.textContent = 'Select a steward first';
      dropdown.appendChild(empty);
      return;
    }
    const stored = listFor(stewardId);

    // Header strip (facelift Josh 2026-08-23) — gives the panel a top edge and
    // labels it, with a live count. Rendered whether or not there are links so
    // the empty state (persistent-button entry point with zero cards) still
    // reads as a real, intentional panel and not a bare error line.
    const header = document.createElement('div');
    header.className = 'card-links-header';
    const hTitle = document.createElement('span');
    hTitle.className = 'cl-h-title';
    hTitle.textContent = 'Links';
    header.appendChild(hTitle);
    // Josh 2026-09-09: the total-links count is gone from the panel header too,
    // for the same reason it left the 🔗 buttons — it isn't interesting.
    dropdown.appendChild(header);

    if (stored.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'card-links-empty';
      empty.textContent = 'No links shared here yet';
      dropdown.appendChild(empty);
      return;
    }
    // Sort (Josh 2026-08-23): rank by last-opened, falling back to created_at
    // when a link was never opened. Repeatedly/recently-opened links float to
    // the FRESH end; never-opened links sort among themselves by created_at.
    // The `|| 0` chain is null-safe — an absent last_opened AND created_at
    // sinks to 0.
    //
    // Direction (Josh 2026-09-04): ASCENDING, so the freshest link lands at the
    // BOTTOM of the panel — right by his thumb — instead of forcing him to
    // reach to the top of a tall list. This flips ONLY the direction; the
    // recency-float ranking above is unchanged, and the .card-link-dot recency
    // colors still read off the same signal. Pairs with the scroll-to-bottom
    // below, without which a reversed list would open at the stale end and
    // defeat the whole point.
    //
    // Pinning (Josh 2026-09-09): pinned links group together at ONE end and
    // stay there until unpinned, with the recency ranking above still ordering
    // within each group. PIN_AT_BOTTOM is the single knob — his words were
    // "pinned links would stay at the bottom", which matches the thumb-reach
    // logic behind the ascending sort; flip this one constant to move them to
    // the top instead.
    const PIN_AT_BOTTOM = true;
    const keyOf = (lk) => lk.last_opened || lk.created_at || 0;
    const items = stored.slice().sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return PIN_AT_BOTTOM ? ap - bp : bp - ap;
      return keyOf(a) - keyOf(b);
    });
    items.forEach((lk) => {
      const row = document.createElement('div');
      row.className = 'card-link-row';

      // "Signal Dots" layout (Josh 2026-08-23, design #1). A colored dot leads
      // each row — colored by how recently the link was OPENED (fresh green →
      // amber → brick), glowing so it pops; muted grey when never opened. It's
      // the at-a-glance recency signal Josh asked for.
      const openColorVal = openColor(lk.last_opened);
      const dot = document.createElement('span');
      dot.className = 'card-link-dot' + (lk.last_opened ? '' : ' is-never');
      if (lk.last_opened) {
        dot.style.background = openColorVal;
        dot.style.boxShadow = `0 0 8px ${_rgba(openColorVal, 0.6)}`;
      }

      const btn = document.createElement('button');
      btn.className = 'card-link-btn';
      btn.title = lk.url || '';

      const titleEl = document.createElement('span');
      titleEl.className = 'card-link-title';
      titleEl.textContent = lk.title || lk.url || '';
      btn.appendChild(titleEl);

      // Color-coded time chips (Josh design #1): OPENED on the warm recency
      // scale, ADDED on the cool blue→violet scale, so the two read as distinct
      // colors at a glance. Never-opened shows a clean muted "never" chip.
      const metaRow = document.createElement('span');
      metaRow.className = 'card-link-meta-row';

      // Glyphs, not words (Josh 2026-09-04: "make it more obvious as to the
      // opened and added without having to have the whole words"). An eye =
      // when you last LOOKED at it, a plus = when it was ADDED. Each is one
      // character where "OPENED"/"ADDED" were six and five, and the two colour
      // scales (warm for opened, cool for added) still carry the distinction.
      // Tooltips keep the words for anything ambiguous.
      const openedShort = fmtBadgeTime(lk.last_opened);
      const openChip = timeChip('👁', openedShort || 'never', openColorVal, !openedShort);
      openChip.title = openedShort ? `Last opened ${fmtShorthand(lk.last_opened)}` : 'Never opened';
      metaRow.appendChild(openChip);

      const addedShort = fmtBadgeTime(lk.created_at);
      if (addedShort) {
        const addChip = timeChip('+', addedShort, addColor(lk.created_at), false);
        addChip.title = `Added ${fmtShorthand(lk.created_at)}`;
        metaRow.appendChild(addChip);
      }

      // Originating worker (Josh 2026-08-14: "if a worker did make it, I want to
      // see the worker that was associated with it"). Only shown when a worker
      // made the link — created_by is null for the bare top steward / presenter
      // UI. Prefer the friendly source label, stripped of the trailing role word
      // ("worker"/"build"/"builder"), else the raw branch suffix.
      // Josh 2026-09-04: this is the THIRD hanging badge, and it gets shortened
      // the way he asked — "show the icon for that setting, and then also show
      // the worker's name". The steading icon replaces the wordy "by " prefix,
      // so the badge reads e.g. "🏠 Wallpaper Redraw" instead of
      // "by Wallpaper Redraw". Icon comes from the canonical steward lookup
      // (same source the topbar strip uses), not a new hand-rolled map. The
      // panel is scoped to ONE top steward, so every row shares that steading.
      const workerName = friendlyWorker(lk);
      if (workerName) {
        const byMeta = document.createElement('span');
        byMeta.className = 'card-link-badge card-link-worker';
        // A worker's stored label often already CARRIES its own emoji
        // ("Catalog Field Overrides 🎚️"). Pull that out and fly it as the
        // badge's icon instead of leaving it buried mid-string — it's a more
        // specific signal than the steading's, and it stops the emoji from
        // eating name width. Fall back to the steading icon (the "setting"
        // Josh means) when the worker has no emoji of its own.
        const emojiRe = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;
        const own = (workerName.match(emojiRe) || [])[0] || '';
        const bare = workerName.replace(emojiRe, '').replace(/\s+/g, ' ').trim();
        const ic = document.createElement('span');
        ic.className = 'card-link-worker-icon';
        ic.textContent = own || urgencySteadingIcon(stewardId);
        byMeta.appendChild(ic);
        const nm = document.createElement('span');
        nm.className = 'card-link-worker-name';
        nm.textContent = bare || workerName;
        byMeta.appendChild(nm);
        byMeta.title = lk.created_by_label || lk.created_by || '';
        metaRow.appendChild(byMeta);
      }

      // Josh 2026-09-04: the badges HANG OFF the button rather than living
      // inside it, so the button's whole width belongs to the title. metaRow is
      // therefore appended to the ROW (the positioned parent), not to btn —
      // inside btn it would be part of the title's flex line again, which is
      // the crowding we're removing. CSS floats it above the button's top edge.
      row.appendChild(metaRow);
      row.appendChild(dot);

      btn.addEventListener('click', () => {
        // Open the real browser.
        if (window.presenter && window.presenter.openUrl) window.presenter.openUrl(lk.url);
        // Stamp last_opened on the server; optimistic local update.
        lk.last_opened = Date.now();
        saveLocal();
        render();
        fetch('/api/card-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_name: stewardId, opened_url: lk.url }),
        }).catch((err) => console.warn('[card-links] touch failed:', err));
      });

      // Row menu (Josh 2026-09-09): the bare ✕ becomes a three-dot menu with
      // exactly TWO actions — Remove, and Pin/Unpin. His words: "turn that X
      // that's on the right into a three dot menu, and when I click it I can
      // either remove it from the list or I can pin it." Nothing else goes in
      // this menu.
      const menuBtn = document.createElement('button');
      menuBtn.className = 'card-link-action card-link-menu-btn';
      menuBtn.textContent = '⋯';
      menuBtn.title = 'More';
      menuBtn.setAttribute('aria-label', 'Link options');

      const doRemove = () => {
        const url = lk.url;
        const list = listFor(stewardId);
        const i = list.indexOf(lk);
        if (i !== -1) list.splice(i, 1);
        saveLocal();
        render();
        updatePillLabel(selectedSteward);
        fetch(`/api/card-links?session=${encodeURIComponent(stewardId)}&url=${encodeURIComponent(url)}`, {
          method: 'DELETE',
        }).catch((err) => console.warn('[card-links] forget failed:', err));
      };

      const doTogglePin = () => {
        const next = !lk.pinned;
        lk.pinned = next;           // optimistic — server confirms via socket
        saveLocal();
        render();
        fetch('/api/card-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_name: stewardId, pin_url: lk.url, pinned: next }),
        }).catch((err) => console.warn('[card-links] pin failed:', err));
      };

      menuBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openRowMenu(menuBtn, lk, doTogglePin, doRemove);
      });

      row.appendChild(btn);
      row.appendChild(menuBtn);
      if (lk.pinned) row.classList.add('is-pinned');
      dropdown.appendChild(row);
    });

    // Newest-at-the-bottom (Josh 2026-09-04) only pays off if the panel OPENS
    // parked at that end — otherwise a long list opens showing the stalest
    // links and he's reaching again, just in the other direction. Every path
    // that shows the panel funnels through render(), so anchoring here covers
    // the pill tap, the footer button, the steward-switch restore and the
    // page-load restore in one place, and re-anchors after a forget/open
    // re-render too. Set synchronously (layout is already resolved — the rows
    // are in the DOM) and once more on the next frame, because the panel is
    // display:none on the first open and a hidden element has no scrollable
    // height to move to yet.
    const parkAtBottom = () => { dropdown.scrollTop = dropdown.scrollHeight; };
    parkAtBottom();
    requestAnimationFrame(parkAtBottom);
  }

  // Tap-outside-to-close (Joshua 2026-07-14): when the dropdown is open,
  // tapping anywhere outside the panel AND outside the pill closes it —
  // through the same setOpen() path so persistence/state stays coherent.
  // Deferred capture-phase listener (matches the CPU-pill / bulk-popover
  // idiom); the one-tick defer prevents the opening click from closing it.
  function _cardLinksOutsideClick(e) {
    if (dropdown.contains(e.target) || (pill && pill.contains(e.target))) return;
    // The row three-dot menu is portaled to <body>, so it reads as "outside"
    // the panel — without this, tapping Pin or Remove would also close the
    // whole links panel out from under the action (Josh 2026-09-09).
    if (e.target.closest && e.target.closest('.card-link-menu')) return;
    // Don't close when the tap lands on a Links button that owns the toggle —
    // letting this handler also fire would double-toggle (close here, then
    // toggle() sees isOpen===false and reopens), so the panel never closes.
    // R4 covered the per-card footer button; the phone-toolbar button
    // (.links-toolbar-btn, added 2026-08-23) needs the same exemption —
    // without it, tapping Links while open was a no-op (Josh 2026-09-05).
    if (e.target.closest && e.target.closest('.card-footer-links, .links-toolbar-btn')) return;
    setOpen(selectedSteward, false);
  }
  // Arm/disarm the outside-click listener. Called from EVERY path that shows
  // or hides the dropdown (pill tap, steward-switch update, page-load restore)
  // so the listener is present whenever the panel is actually open — not just
  // when opened by a pill tap.
  function armLinksOutsideClick(open) {
    document.removeEventListener('click', _cardLinksOutsideClick, true);
    if (open) {
      setTimeout(() => document.addEventListener('click', _cardLinksOutsideClick, true), 0);
    }
  }

  function setOpen(stewardId, open) {
    if (!stewardId) return;
    openState[stewardId] = open;
    saveOpen();
    dropdown.style.display = open ? 'flex' : 'none';
    armLinksOutsideClick(open);
  }

  if (pill) {
    pill.addEventListener('click', () => {
      if (!selectedSteward) return;
      const isOpen = dropdown.style.display === 'flex';
      setOpen(selectedSteward, !isOpen);
      if (!isOpen) render();
    });
  }

  window._cardLinks = {
    update(sessionId) {
      updatePillLabel(sessionId);
      const wantOpen = !!openState[sessionId];
      dropdown.style.display = wantOpen ? 'flex' : 'none';
      armLinksOutsideClick(wantOpen);
      if (wantOpen) render();
    },
    // R4 (Josh 2026-08-13): Links moved off the top pill onto a per-card
    // footer button. The button calls toggle() to open/close the SAME
    // #card-links-dropdown overlay — one dropdown, one render path, no dup.
    toggle() {
      if (!selectedSteward) return;
      const isOpen = dropdown.style.display === 'flex';
      setOpen(selectedSteward, !isOpen);
      if (!isOpen) render();
    },
    // Live link count for the current steward — footer button label uses it.
    count() {
      const top = topStewardOf(selectedSteward);
      return top ? listFor(top).length : 0;
    }
  };

  // R4: repaint every per-card footer Links button label with the current
  // count. Called from updatePillLabel so counts stay live as links arrive /
  // are forgotten (server push, forget, open) without a full card re-render.
  window._repaintFooterLinks = function () {
    const n = (window._cardLinks && typeof window._cardLinks.count === 'function')
      ? window._cardLinks.count() : 0;
    document.querySelectorAll('.card-footer-links').forEach((btn) => {
      // Icon only — Josh 2026-09-09 dropped the number from both 🔗 entry points.
      btn.innerHTML = '';
      const ic = document.createElement('span');
      ic.className = 'card-footer-link-icon';
      ic.textContent = '🔗';
      btn.appendChild(ic);
      btn.title = 'Links for this steward';
      btn.setAttribute('aria-label', btn.title);
    });
    // Keep the persistent toolbar Links button (Josh 2026-08-23) in sync too, so
    // its count updates live on server push / forget / open without waiting for
    // the next full toolbar rebuild. It's always in the DOM (unlike footer
    // buttons that come and go with cards), so update it in place.
    // Josh 2026-09-09: no number on the toolbar button any more — only the lit/
    // muted state tracks the count. Any .links-count left over from a stale
    // render is removed so the digit can't survive a hot reload.
    const toolbarLinks = document.querySelector('.links-toolbar-btn');
    if (toolbarLinks) {
      const cntEl = toolbarLinks.querySelector('.links-count');
      if (cntEl) cntEl.remove();
      toolbarLinks.classList.toggle('has-links', n > 0);
      toolbarLinks.title = 'Links for this steward';
    }
  };

  updatePillLabel(selectedSteward);
  if (selectedSteward && openState[selectedSteward]) {
    dropdown.style.display = 'flex';
    armLinksOutsideClick(true);
    render();
  }
})();

// --- Embedded sidebar expand/collapse (handled by topbar expand button) ---
// Close expanded sidebar overlay when overlay clicked
(function() {
  const overlay = document.getElementById('sidebar-overlay');
  if (!overlay) return;
  overlay.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('expanded-overlay');
    overlay.classList.remove('visible');
  });
})();

// --- Make last-refresh timestamp clickable to trigger refresh ---
(function() {
  const refreshInfo = document.getElementById('refresh-info');
  if (!refreshInfo) return;
  refreshInfo.style.cursor = 'pointer';
  refreshInfo.title = 'Tap to refresh';
  refreshInfo.addEventListener('click', () => {
    window.location.reload();
  });
})();

// --- Under the Hood toggle ---
// iframe is loaded ONCE and kept alive — toggling just swaps visibility
(function() {
  const hoodBtn = document.getElementById('btn-hood');
  const hoodIframe = document.getElementById('hood-iframe');
  const inboxContainer = document.getElementById('inbox-container');
  if (!hoodBtn || !hoodIframe || !inboxContainer) return;

  let hoodActive = false;
  let hoodLoaded = false;
  const SERVER_URL = window.location.origin || 'http://localhost:3005';
  const titleText = document.getElementById('titlebar-text');
  const queueCountEl = document.getElementById('queue-count');
  const viewToggle = document.getElementById('embedded-view-toggle');

  hoodBtn.addEventListener('click', () => {
    hoodActive = !hoodActive;
    if (hoodActive) {
      inboxContainer.style.display = 'none';
      if (viewToggle) viewToggle.style.display = 'none';
      // Load iframe only once, then just show/hide
      if (!hoodLoaded) {
        hoodIframe.src = SERVER_URL;
        hoodLoaded = true;
      }
      hoodIframe.style.display = 'flex';
      hoodBtn.textContent = 'Back to Presenter';
      if (titleText) titleText.textContent = 'Under the Hood';
      if (queueCountEl) queueCountEl.style.display = 'none';
    } else {
      hoodIframe.style.display = 'none';
      // Do NOT clear src — keep iframe alive
      inboxContainer.style.display = '';
      if (viewToggle) viewToggle.style.display = '';
      hoodBtn.textContent = 'Under the Hood';
      if (titleText) titleText.textContent = 'Presenter';
      if (queueCountEl) queueCountEl.style.display = '';
    }
  });
})();

// --- Embedded refresh button removed (Josh 2026-04-20): nonfunctional, took
// space in the mobile top bar. If mobile needs a manual refresh, trigger it
// via the APK-side UI, not the in-page button. ---

// --- Bottom persistent input ---
(function() {
  const bottomTextarea = document.getElementById('conv-bottom-textarea');
  const bottomSend = document.getElementById('conv-bottom-send');
  if (!bottomTextarea || !bottomSend) return;

  // --- Pre-send persistence (Joshua 2026-07-22) ---
  // Josh lost a long message typed from his PHONE when the send failed IN
  // TRANSIT over Tailscale (laptop momentarily unreachable). The old failure
  // path only restored text to the live textarea for that session — a reload
  // or a second dead-hop Retry lost it forever. The server-backed composer
  // draft can't save it either: it rides the SAME dead hop and .catch()es
  // silently. So we stash the text in localStorage (fully on-device, no
  // network) the INSTANT send is pressed, BEFORE the fetch. It survives the
  // failure AND a full WebView/app reload. Cleared ONLY on send-success. On
  // boot, a leftover slot triggers a "resend unsent message?" offer.
  const UNSENT_KEY = 'presenter-unsent-message';
  function stashUnsent(text, steward) {
    try {
      localStorage.setItem(UNSENT_KEY, JSON.stringify({
        text: text,
        steward: steward || selectedSteward || '',
        ts: Date.now()
      }));
    } catch (e) { console.warn('[unsent] stash failed', e); }
  }
  function clearUnsent() {
    try { localStorage.removeItem(UNSENT_KEY); } catch (e) {}
  }
  function readUnsent() {
    try {
      const raw = localStorage.getItem(UNSENT_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && typeof obj.text === 'string' && obj.text.trim()) return obj;
    } catch (e) {}
    return null;
  }

  function sendTextAsWalkie(text) {
    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    return fetch(`${SERVER_URL}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_session: selectedSteward,
        type: 'action',
        message_override: JSON.stringify({
          type: 'action',
          from: 'josh-presenter',
          instruction: text
        })
      })
    });
  }

  // Steward-walkie path — used when user explicitly wants to send to the
  // steward (pill-LEFT half tap, or bottomSend ➤ click on desktop, or
  // fallback from sendBottomMessage when there's no active card).
  // In-flight guard for the steward send path (Josh 2026-08-30).
  //
  // ONE tap on send produced SIXTEEN separate queue items — distinct ids, all
  // first attempts, spread over 11 seconds. Not dispatcher retries: sixteen
  // genuine enqueues that flooded the steward's session.
  //
  // Why the existing `bottomSend.disabled` did NOT prevent it: that guards the
  // legacy ➤ button, which is hidden on this surface. What Josh actually taps
  // is the split pill, and the pill halves have no disabled state at all — so
  // every tap re-entered this function and fired another POST.
  //
  // So the guard lives on the FUNCTION, not the control. Every caller inherits
  // it: the pill halves, sendBottomMessage, the Enter key, and the native
  // bridge. Guarding click handlers one by one is what let this through.
  let stewardSendInFlight = false;

  function sendTextToStewardDirect(text) {
    if (stewardSendInFlight) {
      console.warn('[steward-send] a send is already in flight — ignoring duplicate tap');
      return Promise.resolve();
    }
    stewardSendInFlight = true;
    // Persist to on-device localStorage BEFORE the network call. If the send
    // fails in transit (or the app reloads), the text survives here — the
    // clear below only runs on send-success. See stashUnsent() comment.
    stashUnsent(text, selectedSteward);
    bottomTextarea.value = '';
    if (typeof window.__composerClearActiveDraft === 'function') window.__composerClearActiveDraft();
    bottomSend.disabled = true;
    bottomSend.textContent = '⏳';
    return sendTextAsWalkie(text).then(res => {
      if (!res.ok) throw new Error('Server returned ' + res.status);
      clearUnsent(); // send confirmed landed — safe to drop the on-device copy
      // Native box empties only once the send is CONFIRMED landed. The web
      // textarea above is cleared optimistically because stashUnsent() has an
      // on-device copy to restore from on failure; the native box has no such
      // safety net, so it waits for the ✓ (Josh 2026-09-02).
      clearNativeInputBox();
      bottomSend.textContent = '✓';
      setTimeout(() => { bottomSend.textContent = '➤'; bottomSend.disabled = false; }, 1500);
      if (typeof fetchPendingQueue === 'function') fetchPendingQueue().then(() => renderBottomToolbar());
    }).catch(err => {
      // Leave the localStorage stash IN PLACE — this is exactly the dropped
      // phone→laptop hop Josh hit. Text stays recoverable across reload.
      console.error('[Presenter] Failed to send:', err);
      bottomSend.textContent = '❌';
      bottomSend.disabled = false;
      bottomTextarea.value = text;
      showErrorToast('Message failed to send', () => {
        bottomTextarea.value = text;
        sendTextToStewardDirect(text);
      });
      setTimeout(() => { bottomSend.textContent = '➤'; }, 3000);
    }).finally(() => {
      // ALWAYS release, on success AND on failure. A guard that sticks after a
      // failed send would leave Josh unable to send at all — strictly worse
      // than the flood it prevents. `finally` also covers the retry offered in
      // the toast above, which re-enters this function.
      stewardSendInFlight = false;
    });
  }
  // Expose so pill-left-half can call it directly (not via bottomSend.click).
  window.__sendTextToStewardDirect = sendTextToStewardDirect;

  // Josh replies to a card by typing in the bottom TYPE box and hitting this
  // ➤ — a normal tap routes to the active card via cardSend.click(). Whether
  // that card survives the reply is governed by its own 📌 pin (Josh
  // 2026-07-14 unification) — no separate keep-card menu on this surface.

  function sendBottomMessage() {
    if (!selectedSteward) return;
    // readComposerText, not bottomTextarea.value — picks up text typed in the
    // native Android box too (Josh 2026-08-30).
    const text = readComposerText();

    // 🚨 URGENT FIX 2026-04-21 (Josh + Venture caught):
    // The old "v4 two-button" comment was LYING. There's no standalone
    // [↳ Card] button anymore — R14 consolidated it into the split-pill
    // [icon│N]. When Josh types a reply + hits Enter, it MUST route to
    // the focused card (same path as pill-right-half), not the steward
    // via walkie. Misrouted approvals were causing real damage: Josh's
    // admin-light-theme graduation approval got pinned to a Venture
    // timer proposal card, triggering a fake worker spawn.
    //
    // Intended routing (for Enter-key + desktop-➤ path):
    //  - Text + active card → route to that card (cardInput + cardSend.click)
    //  - Text + no active card → fallback to steward walkie
    //  - No text → continue to voice-recording priority branch below
    //
    // Note: pill-LEFT-half click bypasses this fn and calls
    // sendTextToStewardDirect() unconditionally — explicit user intent
    // "send to steward" should not secretly route to the card.

    if (text) {
      const targets = (typeof getActiveDeckTargets === 'function') ? getActiveDeckTargets() : null;
      if (targets && targets.cardInput && targets.cardSend) {
        // Stage into the card's input + fire its send button — same
        // code path the pill-right-half uses. Single source of truth.
        console.log('[sendBottomMessage] routing to active card=' + (targets.bubble?.dataset?.itemId || '?'));
        targets.cardInput.value = text;
        targets.cardInput.dispatchEvent(new Event('input', { bubbles: true }));
        __bottomBarSendOriginText = text;
        bottomTextarea.value = '';
        if (typeof window.__composerClearActiveDraft === 'function') window.__composerClearActiveDraft();
        clearNativeInputBox();
        targets.cardSend.click();
        return;
      }
      console.log('[sendBottomMessage] no active card — falling back to steward walkie');
      sendTextToStewardDirect(text);
      return;
    }

    // Priority 2: active recording
    const isAndroid = !!(window.Android && window.Android.getRecordingStatus);

    // Bottom bar voice sends use _walkie_ prefix — server routes transcript to walkie-talkie queue.
    // Source-aware: Android recordings go phone→server→transcribe→respond (all on phone side).
    // Whisper Village recordings go claim→transcribe→respond (all on Mac side).
    const walkieId = '_walkie_' + selectedSteward;
    let bottomAutoRetried = false;
    let bottomSendSource = null; // 'android' or 'whisper-village'

    function pollForWalkieDelivery(timeoutMs, onSuccess, onTimeout) {
      // Primary: explicit socket signal `walkie:enqueued` — fires the instant
      // the laptop accepts the walkie message (server-side, before any
      // dispatch/confirm). The old polling-only path produced fake "voice
      // send failed" toasts when transcription took longer than the poll
      // window (35s for Android, 24s for Whisper Village).
      //
      // The poll-based path is retained as a safety net (socket disconnected,
      // server restart mid-send, etc.) but its timeout is raised to a long
      // floor so a slow transcription pipeline doesn't false-positive while
      // the socket signal is the actual source of truth.
      const SAFETY_NET_MS = Math.max(timeoutMs, 120000);
      const startedAt = Date.now();
      const SERVER_URL = window.location.origin || 'http://localhost:3005';

      let done = false;
      let unsubscribe = null;
      let pollInterval = null;
      function finish(cb) {
        if (done) return;
        done = true;
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        if (unsubscribe) { try { unsubscribe(); } catch (e) {} unsubscribe = null; }
        cb();
      }

      // Subscribe to the enqueue signal. Filter by target_session and
      // from-tag (josh-presenter OR josh-mobile) so we only fire on OUR send.
      if (window.presenter && typeof window.presenter.onWalkieEnqueued === 'function') {
        unsubscribe = window.presenter.onWalkieEnqueued((payload) => {
          if (!payload || payload.target_session !== selectedSteward) return;
          const msg = payload.message || '';
          if (!msg.includes('josh-presenter') && !msg.includes('josh-mobile')) return;
          finish(onSuccess);
        });
      }

      // Fallback safety net (kept from old logic): baseline-diff poll. Only
      // matters if the socket connection is down or the event was missed.
      const baselineIds = new Set();
      fetch(`${SERVER_URL}/api/queue`).then(r => r.json()).then(resp => {
        const q = (resp && resp.queue) || (Array.isArray(resp) ? resp : []);
        for (const item of q) {
          if (item.target_session === selectedSteward
              && item.message
              && (item.message.includes('josh-presenter') || item.message.includes('josh-mobile'))) {
            baselineIds.add(item.id);
          }
        }
      }).catch(() => {});

      let pollCount = 0;
      const maxPolls = Math.ceil(SAFETY_NET_MS / 2000);
      pollInterval = setInterval(() => {
        pollCount++;
        if (pollCount > maxPolls) {
          finish(onTimeout);
          return;
        }
        fetch(`${SERVER_URL}/api/queue`).then(r => r.json()).then(resp => {
          const q = (resp && resp.queue) || (Array.isArray(resp) ? resp : []);
          const recent = q.find(item =>
            item.target_session === selectedSteward &&
            item.message &&
            (item.message.includes('josh-presenter') || item.message.includes('josh-mobile')) &&
            !baselineIds.has(item.id) &&
            (Date.now() - new Date(item.created_at).getTime()) < (SAFETY_NET_MS + 10000));
          if (recent) finish(onSuccess);
        }).catch(() => {});
      }, 2000);
    }

    function awaitBottomBarDelivery() {
      bottomSend.textContent = '🎤';
      bottomSend.title = 'Transcribing...';
      // Android gets more time (phone→server→transcribe→respond pipeline)
      const timeout = bottomSendSource === 'android' ? 35000 : 24000;
      pollForWalkieDelivery(timeout, () => {
        // Success
        bottomSend.textContent = '✓';
        bottomSend.title = 'Delivered';
        setTimeout(() => { bottomSend.textContent = '➤'; bottomSend.disabled = false; bottomSend.title = ''; }, 2000);
        fetchPendingQueue().then(() => renderBottomToolbar());
      }, () => {
        // Timeout — auto-retry once
        if (!bottomAutoRetried) {
          bottomAutoRetried = true;
          bottomAutoRetry();
          return;
        }
        showBottomBarFailure();
      });
    }

    function bottomAutoRetry() {
      bottomSend.textContent = '⏳';
      bottomSend.title = 'Auto-retrying...';

      if (bottomSendSource === 'android') {
        // Android: phone pipeline may still be working. Give it more poll time.
        console.log('[BottomBar][android] Auto-retry: extending poll time...');
        pollForWalkieDelivery(15000, () => {
          bottomSend.textContent = '✓'; bottomSend.title = 'Delivered';
          setTimeout(() => { bottomSend.textContent = '➤'; bottomSend.disabled = false; bottomSend.title = ''; }, 2000);
          fetchPendingQueue().then(() => renderBottomToolbar());
        }, () => {
          console.error('[BottomBar][android] Auto-retry poll also timed out');
          showBottomBarFailure();
        });
      } else {
        // Whisper Village: try /peek for transcript
        console.log('[BottomBar][whisper-village] Auto-retry: fetching transcript via peek...');
        fetch('http://localhost:8179/peek', { method: 'POST' })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data && data.transcript && data.transcript.trim()) {
              return sendTextAsWalkie(data.transcript.trim()).then(r => {
                if (!r.ok) throw new Error('Send failed');
                bottomSend.textContent = '✓'; bottomSend.title = 'Delivered (retried)';
                setTimeout(() => { bottomSend.textContent = '➤'; bottomSend.disabled = false; bottomSend.title = ''; }, 2000);
                fetchPendingQueue().then(() => renderBottomToolbar());
              });
            }
            throw new Error('No transcript');
          })
          .catch(() => showBottomBarFailure());
      }
    }

    function showBottomBarFailure() {
      bottomSend.textContent = '❌';
      bottomSend.title = 'Failed';
      bottomSend.disabled = false;
      const source = bottomSendSource === 'android' ? 'Phone' : 'Whisper Village';
      showErrorToast(`${source} voice send failed`, () => {
        bottomSend.disabled = true; bottomSend.textContent = '⏳'; bottomSend.title = 'Retrying...';
        // Source-appropriate retry
        const peekPromise = bottomSendSource === 'android'
          ? Promise.resolve(null)
          : fetch('http://localhost:8179/peek', { method: 'POST' }).then(r => r.ok ? r.json() : null).catch(() => null);
        peekPromise.then(data => {
          const text = (data && data.transcript) ? data.transcript.trim() : '';
          if (text) {
            return sendTextAsWalkie(text).then(r => {
              if (!r.ok) throw new Error('Send failed');
              bottomSend.textContent = '✓'; bottomSend.title = 'Delivered';
              setTimeout(() => { bottomSend.textContent = '➤'; bottomSend.disabled = false; bottomSend.title = ''; }, 2000);
            });
          }
          throw new Error('No text');
        }).catch(() => {
          bottomSend.textContent = '➤'; bottomSend.disabled = false; bottomSend.title = '';
          showErrorToast('Retry failed — type your message in the text field');
        });
      });
      setTimeout(() => { bottomSend.textContent = '➤'; bottomSend.title = ''; }, 8000);
    }

    if (isAndroid) {
      try {
        const status = JSON.parse(window.Android.getRecordingStatus());
        if (status.isRecording || status.hasRecording) {
          bottomSendSource = 'android';
          bottomSend.disabled = true;
          bottomSend.textContent = '⏳';
          bottomSend.title = 'Claiming...';
          window.Android.claimRecordingForCard(walkieId);
          awaitBottomBarDelivery();
          return;
        }
      } catch (e) { console.log('[SmartSend] Android bridge error:', e); }
      // On the phone there IS no Whisper Village to fall through to (it runs on
      // the Mac at localhost:8179 — unreachable from the phone's WebView), so
      // the fetch below would just fail and quietly reset the button. Josh
      // taps send and nothing happens, with no reason given. Tell him instead
      // (Josh 2026-08-30: "Never leave a silent no-op").
      showErrorToast('Nothing to send — type a message or record something first.');
      return;
    }

    // Desktop: try Whisper Village
    bottomSendSource = 'whisper-village';
    bottomSend.disabled = true;
    bottomSend.textContent = '⏳';
    bottomSend.title = 'Claiming...';
    fetch('http://localhost:8179/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId: walkieId })
    }).then(res => {
      if (!res.ok) throw new Error('No recording');
      awaitBottomBarDelivery();
    }).catch(() => {
      // Nothing to send — no text typed and no recording waiting to be claimed.
      bottomSend.textContent = '➤';
      bottomSend.disabled = false;
      bottomSend.title = '';
      showErrorToast('Nothing to send — type a message or record something first.');
    });
  }

  // Poll recording status to change button appearance (bottom bar + all card send buttons)
  let recordingPollInterval = null;
  function updateAllSendButtons(hasRecording) {
    // Bottom bar send button
    if (hasRecording) {
      bottomSend.classList.add('has-recording');
    } else {
      bottomSend.classList.remove('has-recording');
    }
    // All card send buttons
    document.querySelectorAll('.msg-send-btn').forEach(btn => {
      if (hasRecording) {
        btn.classList.add('has-recording');
      } else {
        btn.classList.remove('has-recording');
      }
    });
    // Split-pill armed state — driven by recording OR textarea-has-text.
    // hasRecording gets a second class so we can pulse only in rec mode.
    updatePillArmedState(hasRecording);
  }
  function updatePillArmedState(hasRecording) {
    const hasText = !!bottomTextarea.value.trim();
    const armed = hasRecording || hasText;
    document.body.classList.toggle('pill-armed', armed);
    document.body.classList.toggle('pill-armed-recording', !!hasRecording);
  }
  // Expose to reflectTextareaHasText so textarea-input events refresh arm.
  window.__updatePillArmedState = updatePillArmedState;
  function startRecordingPoll() {
    if (recordingPollInterval) return;
    recordingPollInterval = setInterval(() => {
      if (bottomTextarea.value.trim()) {
        // Text in bottom bar — show normal send for all
        updateAllSendButtons(false);
        return;
      }
      const isAndroid = !!(window.Android && window.Android.getRecordingStatus);
      if (isAndroid) {
        try {
          const raw = window.Android.getRecordingStatus();
          const status = JSON.parse(raw);
          const hasRec = !!(status.isRecording || status.hasRecording || status.hasText);
          if (hasRec && !bottomSend.classList.contains('has-recording')) {
            console.log('[RecPoll] Recording detected:', raw);
          }
          updateAllSendButtons(hasRec);
        } catch (e) { console.error('[RecPoll] Android bridge error:', e); }
        return; // Don't also check Whisper Village on Android
      }
      // Desktop: check Whisper Village recording status
      fetch('http://localhost:8179/status', { method: 'GET' }).then(r => r.json()).then(d => {
        updateAllSendButtons(!!(d && d.recording));
      }).catch(() => {
        updateAllSendButtons(false);
      });
    }, 2000);
  }
  startRecordingPoll();

  // --- Resend-unsent-message offer on boot (Joshua 2026-07-22) ---
  // If a previous send failed in transit (or the app was reloaded mid-send),
  // an unsent message is still sitting in localStorage. Restore it to the
  // typing box and offer a one-tap resend so Josh never loses typed text to a
  // dropped phone→laptop hop. Runs once, shortly after boot so selectedSteward
  // has restored from its own localStorage first.
  function offerResendUnsent() {
    const pending = readUnsent();
    if (!pending) return;
    // Restore into the typing box so Josh sees exactly what he'd lose.
    if (bottomTextarea && !bottomTextarea.value.trim()) {
      bottomTextarea.value = pending.text;
      try { bottomTextarea.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    }
    const preview = pending.text.length > 40 ? pending.text.slice(0, 40) + '…' : pending.text;
    showErrorToast('Unsent message recovered: "' + preview + '"', () => {
      const txt = pending.text;
      // Restore the target steward if it was captured and none is selected now.
      if (pending.steward && typeof selectSteward === 'function' && !selectedSteward) {
        try { selectSteward(pending.steward); } catch {}
      }
      if (bottomTextarea) bottomTextarea.value = '';
      sendTextToStewardDirect(txt);
    });
    // Relabel the toast's Retry button to "Resend" for clarity.
    try {
      const rb = document.querySelector('#error-toast .error-toast-retry');
      if (rb) rb.textContent = 'Resend';
    } catch {}
  }
  setTimeout(offerResendUnsent, 1500);

  bottomSend.addEventListener('click', sendBottomMessage);

  bottomTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      sendBottomMessage();
    }
  });

  // --- Card-send button (v4 two-button model) ---
  // Dedicated [↳ Card] button that always routes to the active deck card,
  // regardless of the steward pill. Card's own .msg-send-btn handles text
  // OR mid-recording claim.
  const cardSendBtn = document.getElementById('conv-bottom-card-send');

  function getActiveDeckTargets() {
    const thread = document.getElementById('conv-thread');
    if (!thread) return null;
    // Source of truth: mobileDeckGetState().currentItemId is the card the
    // user is actually navigating to (updated by setCurrent on arrow tap
    // or finger swipe). DOM's .msg-bubble.active is STATIC across all
    // non-archived bubbles and gave the WRONG card on every navigation.
    let activeBubble = null;
    try {
      const st = (typeof window.mobileDeckGetState === 'function') ? window.mobileDeckGetState() : null;
      if (st && st.currentItemId) {
        activeBubble = thread.querySelector(`.msg-bubble[data-item-id="${st.currentItemId}"]`);
      }
    } catch {}
    if (!activeBubble) {
      // Fallback: first non-archived bubble in thread
      activeBubble = thread.querySelector('.mobile-deck-card .msg-bubble[data-item-id]');
    }
    if (!activeBubble) return null;
    const cardInput = activeBubble.querySelector('.msg-input');
    const cardSend = activeBubble.querySelector('.msg-send-btn');
    if (!cardInput || !cardSend) return null;
    return { cardInput, cardSend, bubble: activeBubble };
  }

  // __refreshCardSendBtn DEPRECATED 2026-04-20: the button label is now
  // updated INLINE inside setCurrent() (see the IIFE in app.js around the
  // mobile-deck module) so the counter pill and card-send button share
  // one state machine. Leave a stub so any remaining caller no-ops
  // safely instead of throwing.
  window.__refreshCardSendBtn = function noopRefreshCardSendBtn() {
    // Intentionally empty — setCurrent owns the update now.
  };

  // Trackpad-overlay bridges (Joshua 2026-04-28). The native trackpad
  // panel needs to know the current card ID + selected steward to claim
  // the next Whisper Village transcript on his Mac. These read from the
  // same state desktop's pill / send-bottom path uses, so the trackpad
  // round-trips through the exact same routing as the desktop buttons.
  window.__trackpadGetCurrentCardId = function () {
    try {
      const targets = getActiveDeckTargets();
      return targets?.bubble?.dataset?.itemId || '';
    } catch { return ''; }
  };
  window.__trackpadGetSelectedSteward = function () {
    try {
      return selectedSteward || '';
    } catch { return ''; }
  };

  // Desktop-only: push current focused card + selected steward to the
  // Homestead server every time they change. The Mac PhoneMouse companion
  // reads this when Joshua taps "→ Card" / "→ Steward" on his phone, so
  // the claim routes to whatever his DESKTOP is showing — not whatever
  // his phone WebView happens to have focused (which is irrelevant — he
  // uses the phone as a remote for his desktop). Phone WebView runs the
  // same JS but with body.embedded; we suppress reporting there.
  let __reportDesktopCurrentTimer = null;
  function reportDesktopCurrent() {
    if (document.body.classList.contains('embedded')) return; // phone WebView, not authoritative
    if (__reportDesktopCurrentTimer) clearTimeout(__reportDesktopCurrentTimer);
    __reportDesktopCurrentTimer = setTimeout(() => {
      __reportDesktopCurrentTimer = null;
      const cardId = window.__trackpadGetCurrentCardId() || '';
      const sel = window.__trackpadGetSelectedSteward() || '';
      const SERVER_URL = window.location.origin || 'http://localhost:3005';
      fetch(`${SERVER_URL}/api/presenter/desktop-current`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId, selectedSteward: sel }),
      }).catch(() => {/* server not running, ignore */});
    }, 60); // tiny debounce — coalesce arrow-mash + steward-flip
  }
  window.__reportDesktopCurrent = reportDesktopCurrent;
  // Fire one initial report after a beat so the server has the desktop's
  // state cached before Joshua's first phone tap. setCurrent + steward
  // selection will keep it fresh from there.
  if (!document.body.classList.contains('embedded')) {
    setTimeout(() => reportDesktopCurrent(), 800);
  }

  // Expose without the window. prefix for our in-IIFE alias used by
  // updateBottomTargetPill (it sees `refreshCardSendBtn` globally).
  window.refreshCardSendBtn = window.__refreshCardSendBtn;

  // Read the text Josh actually typed, wherever he typed it.
  //
  // Josh 2026-08-30: "I thought I had access to both send options... but I'm
  // trying to send this using the icon button and it isn't send when typing
  // using the APK." Cause: the native Android box is a separate widget whose
  // text lived only in Kotlin, so every send path read an empty web textarea,
  // hit `if (!text) return`, and did nothing — no error, no hint, nothing.
  //
  // The native box now mirrors each keystroke into bottomTextarea, so this
  // normally just reads the textarea. The bridge pull is the backstop: it keeps
  // send working if a mirror push is ever dropped, and — importantly — on an
  // APK that predates the mirroring, so sending isn't broken between installs.
  // Returns '' if there genuinely is no text anywhere.
  // Is a voice recording in flight (or captured and waiting to be claimed)?
  // A recording is a deliberate act Josh just performed, so it OUTRANKS any
  // text sitting in a box — see readComposerText.
  function hasLiveRecording() {
    try {
      if (window.Android && typeof window.Android.getRecordingStatus === 'function') {
        const st = JSON.parse(window.Android.getRecordingStatus());
        return !!(st && (st.isRecording || st.hasRecording));
      }
    } catch (err) {
      console.error('[composer] getRecordingStatus failed:', err);
    }
    return false;
  }

  // Empty the APK's OWN text box after a send actually goes through.
  //
  // readComposerText() below READS that native box and copies its text into
  // the web textarea. Clearing the web side (bottomTextarea.value = '') never
  // touched the native one, so Josh's words stayed in the phone's box and he
  // wiped it by hand after every single send (Josh 2026-09-02).
  //
  // Guarded three ways because this same file runs in the DESKTOP Electron
  // presenter, where window.Android does not exist at all: existence check,
  // typeof check (an older APK has no clearInputText), and try/catch. A bare
  // call here breaks the desktop presenter outright.
  //
  // ONLY call this once text has REALLY been consumed and sent. On an aborted
  // send — nothing typed, no card to send to, a recording winning instead —
  // the box must keep its text. Destroying what Josh typed is worse than the
  // bug this fixes.
  function clearNativeInputBox() {
    try {
      if (window.Android && typeof window.Android.clearInputText === 'function') {
        window.Android.clearInputText();
        console.log('[composer] cleared the native input box');
      }
    } catch (err) {
      console.error('[composer] native clearInputText failed:', err);
    }
  }
  window.__clearNativeInputBox = clearNativeInputBox;

  function readComposerText() {
    const webText = bottomTextarea ? bottomTextarea.value.trim() : '';
    if (webText) return webText;
    // REGRESSION FIX 2026-08-30 (Josh: "when I'm actively recording via the APK
    // and I try to hit the icon button it's not fucking working"):
    //
    // The native-box fallback below reads the SAME EditText that the composer
    // now mirrors into. So during a voice send, leftover text in that box made
    // this return non-empty, the send routed as TEXT, and the recording was
    // never claimed — the tap looked dead.
    //
    // A recording always wins. Report "no text" so the caller falls through to
    // its recording path, exactly as it did before the fallback existed. The
    // web textarea above is still checked first: text Josh can actually SEE in
    // the composer is a deliberate choice and keeps priority.
    if (hasLiveRecording()) {
      console.log('[composer] recording in flight — skipping native-box text fallback');
      return '';
    }
    try {
      if (window.Android && typeof window.Android.getInputText === 'function') {
        const nativeText = (window.Android.getInputText() || '').trim();
        if (nativeText) {
          // Pull it into the web textarea so drafts + downstream paths see it.
          bottomTextarea.value = nativeText;
          bottomTextarea.dispatchEvent(new Event('input', { bubbles: true }));
          console.log('[composer] recovered ' + nativeText.length + ' chars from the native box');
          return nativeText;
        }
      }
    } catch (err) {
      console.error('[composer] native getInputText failed:', err);
    }
    return '';
  }
  window.__readComposerText = readComposerText;

  function sendToActiveCard() {
    const targets = getActiveDeckTargets();
    if (!targets) return; // disabled button; should never fire
    const text = readComposerText();
    if (text) {
      targets.cardInput.value = text;
      targets.cardInput.dispatchEvent(new Event('input', { bubbles: true }));
      __bottomBarSendOriginText = text;
      bottomTextarea.value = '';
      if (typeof window.__composerClearActiveDraft === 'function') window.__composerClearActiveDraft();
      clearNativeInputBox();
    }
    // Click the card's existing send. It owns its own success/failure UI
    // and knows how to claim a mid-recording + route transcript back to
    // itself. Do NOT show our own toast.
    targets.cardSend.click();
  }

  if (cardSendBtn) {
    cardSendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendToActiveCard();
    });
    // Initial state
    window.__refreshCardSendBtn();
  }

  // --- Split-pill click routing (Josh 2026-04-21) ---
  // LEFT half (icon) → same as the ➤ send button (send to steward).
  // RIGHT half (card#) → fires the *current active card's own .msg-send-btn*
  // directly — reuse the existing card-send flow 1:1 (claim-recording,
  // undo-toast, dismiss, advance). DO NOT reimplement here (Josh 2026-04-21
  // after broken wiring shipped once — "we already had a working fucking path.
  // Don't reinvent this wheel.").
  const pillIconHalf = document.querySelector('#conv-bottom-target-pill .pill-icon-half');
  const pillCardHalf = document.querySelector('#conv-bottom-target-pill .pill-card-half');
  if (pillIconHalf) {
    pillIconHalf.addEventListener('click', (e) => {
      e.preventDefault();
      console.log('[pill-left] tap — selectedSteward=' + selectedSteward);
      if (!selectedSteward) return;
      // Explicit "send to steward" — bypass the auto-router in
      // sendBottomMessage so text always goes to the steward walkie,
      // never to the active card. (Josh + Venture 2026-04-21 misroute
      // bug: the previous bottomSend.click() was routing to the wrong
      // destination because sendBottomMessage has since become an
      // auto-router.)
      // A recording in flight ALWAYS wins over text (Josh 2026-08-30). He just
      // held the mic down; that's the thing he means to send. Any text in the
      // box stays put as a draft rather than being fired off in its place.
      // sendBottomMessage owns the claim-and-deliver path for voice.
      if (hasLiveRecording()) {
        console.log('[pill-left] recording in flight — routing to the voice path');
        sendBottomMessage();
        return;
      }
      const text = readComposerText();
      if (!text) {
        // No text — fall through to the voice-recording path which
        // sendBottomMessage still owns.
        sendBottomMessage();
        return;
      }
      sendTextToStewardDirect(text);
    });
  }
  if (pillCardHalf) {
    pillCardHalf.addEventListener('click', (e) => {
      e.preventDefault();
      const targets = getActiveDeckTargets();
      console.log('[pill-right] tap — targets=' + (targets ? `bubble=${targets.bubble?.dataset?.itemId} cardSend=${!!targets.cardSend} hasRec=${targets.cardSend?.classList?.contains('has-recording')}` : 'null'));
      if (!targets) {
        console.warn('[pill-right] no active card — bailing');
        return;
      }
      // A recording in flight ALWAYS wins over text (Josh 2026-08-30) — same
      // rule as the icon half, so both send options behave identically. Skip
      // the text staging entirely and let the card's own send button run its
      // recording-claim path, which it already knows how to do.
      if (hasLiveRecording()) {
        console.log('[pill-right] recording in flight — letting the card claim it');
        targets.cardSend.click();
        return;
      }
      // Stage any bottom-bar text into the card's input so the card's
      // sendTextResponse closure (not-recording path) picks it up.
      // readComposerText also recovers text typed in the native Android box
      // (Josh 2026-08-30) — that used to read empty here and the send below
      // then died silently inside the card handler's `if (!text) return`.
      const text = readComposerText();
      if (text) {
        targets.cardInput.value = text;
        targets.cardInput.dispatchEvent(new Event('input', { bubbles: true }));
        __bottomBarSendOriginText = text;
        bottomTextarea.value = '';
        if (typeof window.__composerClearActiveDraft === 'function') window.__composerClearActiveDraft();
        clearNativeInputBox();
        console.log('[pill-right] staged text into cardInput, cleared bottomTextarea');
      } else if (!targets.cardSend.classList.contains('has-recording')) {
        // No text anywhere AND no recording to claim — the card's send button
        // would return silently. Say something instead of swallowing the tap
        // (Josh 2026-08-30: "Never leave a silent no-op").
        console.warn('[pill-right] nothing to send — no text, no recording');
        showErrorToast('Nothing to send — type something first.');
        return;
      }
      // Fire the card's own send button — same exact path as pre-refactor
      // [Send to card N] button. Handles recording-claim, undo-toast,
      // dismiss, advance. Do not reimplement.
      console.log('[pill-right] invoking targets.cardSend.click()');
      targets.cardSend.click();
    });

    // A normal tap on the card-number pill sends the typed reply to the active
    // card. Whether that card survives is governed by its own 📌 pin (Josh
    // 2026-07-14 unification) — the old long-press/right-click "Send without
    // dismissing" keep-card menu on this pill is gone. One control: the pin.
  }

  // The split-pill card-number + card-disabled state needs to stay in sync
  // with setCurrent() (fires on arrow-nav) AND with renderBottomToolbar
  // (fires on steward/queue changes). Keep it in one updater.
  function updateSplitPillCardHalf() {
    const pill = document.getElementById('conv-bottom-target-pill');
    if (!pill) return;
    const cardHalf = pill.querySelector('.pill-card-half');
    const divider = pill.querySelector('.pill-divider');
    const numEl = pill.querySelector('.pill-card-num');
    if (!cardHalf || !numEl) return;
    // Determine current card index + total from the mobile deck (the single
    // source of truth for what's actually on screen). mobileDeckGetState()
    // returns {count, currentIndex, ...}.
    let idx = 0, total = 0;
    try {
      if (typeof window.mobileDeckGetState === 'function') {
        const st = window.mobileDeckGetState();
        if (st) {
          total = st.count || 0;
          idx = (typeof st.currentIndex === 'number' && st.currentIndex >= 0) ? st.currentIndex : 0;
        }
      }
    } catch {}
    // ZERO cards to display → the card-number half exists ONLY to respond to a
    // card. With no card there's nothing to respond to, so REMOVE the half
    // entirely (not a stale number, not a '—'). The icon-half (message-the-
    // steward) stays so Josh can still reach the steward. (Josh 2026-08-11.)
    //
    // Also collapse the pill to a SINGLE SOLID button in this state: the
    // `pill-single` class drops the two-half min-width and lets the icon-half
    // fill the whole pill, so the recording glow/pulse wraps the one live
    // button instead of lighting up empty space. Josh 2026-08-11: "when
    // there's only one [option] it should just be one solid button… right now
    // it just looks so dorky since there's nothing to click in there."
    if (total <= 0) {
      cardHalf.hidden = true;
      if (divider) divider.hidden = true;
      pill.classList.remove('card-disabled');
      pill.classList.add('pill-single');
      return;
    }
    cardHalf.hidden = false;
    if (divider) divider.hidden = false;
    pill.classList.remove('pill-single');
    const targets = getActiveDeckTargets();
    const hasCardInput = !!targets;
    numEl.textContent = String(idx + 1);
    pill.classList.toggle('card-disabled', !hasCardInput);
  }
  window.__updateSplitPillCardHalf = updateSplitPillCardHalf;

  // --- ⌨ composer toggle (Joshua 2026-05-20) ---
  // Tap to OPEN a roomy multi-line composer panel rendered between the
  // deck and the bottom bar (#conv-composer). Tap again, Esc, or
  // tap-outside to close. Drafts are per-card, kept in a small Map
  // keyed by the currently-active deck card; swapping cards swaps the
  // textarea content. The panel does NOT block deck navigation —
  // Joshua can swipe between cards with the composer open and his
  // active-card draft follows him.
  const typeBtn = document.getElementById('conv-bottom-type-btn');
  const composerPanel = document.getElementById('conv-composer');

  // Per-card draft store. Map<cardId, string>. Mirrored to the server
  // (was in-memory only pre-2026-06-06) so the same draft text shows up
  // on phone + laptop. Server key shape:
  // `presenter-draft-composer:<sessionId>:<composerKey>` where
  // composerKey = currentItemId or "_steward" (no active card).
  // Server is the single source of truth; this Map is just the hot cache.
  const composerDrafts = new Map();
  let composerActiveKey = '_steward';
  const composerLastLocalEdit = new Map(); // key (server-shaped) -> ms timestamp
  const COMPOSER_SAVE_DEBOUNCE_MS = 400;
  const COMPOSER_RACE_GATE_MS = 2000;
  // composerServerKey returns the full server-side key for a (sessionId, composerKey) pair.
  function composerServerKey(sessionId, composerKey) {
    return 'presenter-draft-composer:' + (sessionId || 'unknown') + ':' + (composerKey || '_steward');
  }
  function composerKeyToActiveKey(serverKey) {
    if (typeof serverKey !== 'string' || !serverKey.startsWith('presenter-draft-composer:')) return null;
    const rest = serverKey.slice('presenter-draft-composer:'.length);
    const colon = rest.indexOf(':');
    return colon === -1 ? null : { sessionId: rest.slice(0, colon), composerKey: rest.slice(colon + 1) };
  }
  const composerSaveTimers = new Map(); // serverKey -> setTimeout handle
  function composerPostToServer(sessionId, composerKey, value) {
    const serverKey = composerServerKey(sessionId, composerKey);
    composerLastLocalEdit.set(serverKey, Date.now());
    const prev = composerSaveTimers.get(serverKey);
    if (prev) clearTimeout(prev);
    composerSaveTimers.set(serverKey, setTimeout(() => {
      composerSaveTimers.delete(serverKey);
      fetch('/api/presenter/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: serverKey, value: value || '' }),
      }).catch((err) => { console.warn('[composer-drafts] save failed:', err); });
    }, COMPOSER_SAVE_DEBOUNCE_MS));
  }
  // Immediate-flush version for terminal actions (send committed, clear button).
  function composerPostNow(sessionId, composerKey, value) {
    const serverKey = composerServerKey(sessionId, composerKey);
    composerLastLocalEdit.set(serverKey, Date.now());
    const prev = composerSaveTimers.get(serverKey);
    if (prev) { clearTimeout(prev); composerSaveTimers.delete(serverKey); }
    fetch('/api/presenter/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: serverKey, value: value || '' }),
    }).catch((err) => { console.warn('[composer-drafts] flush failed:', err); });
  }

  function composerCurrentKey() {
    try {
      const st = (typeof window.mobileDeckGetState === 'function') ? window.mobileDeckGetState() : null;
      if (st && st.currentItemId) return st.currentItemId;
    } catch {}
    return '_steward';
  }

  // Save the visible textarea content into the draft Map under the
  // PREVIOUS active key. Then restore the NEW active key's draft (or
  // empty). Called from the setCurrent hook on every card navigation.
  function composerSwapForKey(newKey) {
    if (!bottomTextarea) return;
    if (composerActiveKey !== newKey) {
      const oldVal = bottomTextarea.value;
      composerDrafts.set(composerActiveKey, oldVal);
      // Mirror to server so other devices see what we stashed when we leave.
      composerPostToServer(selectedSteward, composerActiveKey, oldVal);
      composerActiveKey = newKey;
      const restored = composerDrafts.get(newKey) || '';
      bottomTextarea.value = restored;
      bottomTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      try {
        if (typeof window.__reflectTypeBtnDraftIndicator === 'function') {
          window.__reflectTypeBtnDraftIndicator();
        }
      } catch {}
    }
  }
  window.__composerSwapForActiveCard = function () {
    composerSwapForKey(composerCurrentKey());
  };
  // Called from sendBottomMessage / pill handlers AFTER a successful
  // send so the just-sent draft for the active card clears (other
  // cards' drafts remain — spec point 8 "send-on-clear").
  //
  // CONTRACT: callers MUST set `bottomTextarea.value = ''` BEFORE
  // calling this. Otherwise the NEXT deck navigation runs
  // composerSwapForKey, which saves the still-visible textarea text
  // back into the Map under the same key — undoing the clear. Every
  // existing send path already does the value-clear first; preserve
  // that ordering if you add a new caller.
  window.__composerClearActiveDraft = function () {
    const k = composerCurrentKey();
    composerDrafts.set(k, '');
    // Terminal action: flush server now, kill any debounce so a stale draft
    // can't reappear on the other device after send.
    composerPostNow(selectedSteward, k, '');
    try {
      if (typeof window.__reflectTypeBtnDraftIndicator === 'function') {
        window.__reflectTypeBtnDraftIndicator();
      }
    } catch {}
    // Joshua 2026-06-05: after a send, the composer should auto-close
    // (same effect as tapping Type again) so the deck/toolbar/stewards
    // rows come back. Every send path calls __composerClearActiveDraft
    // — funnel the close here so all send routes get the behavior.
    try {
      if (isComposerOpen()) closeComposer();
    } catch {}
  };

  // Inverse of __composerClearActiveDraft — used when an undo-send rolls
  // back text that originated from the bottom typing box. Restores the
  // visible textarea, the in-memory draft, and the server-side draft so
  // refresh / cross-device sync see the recovered text.
  window.__composerRestoreActiveDraft = function (text) {
    if (!bottomTextarea || typeof text !== 'string' || !text) return;
    bottomTextarea.value = text;
    const k = composerCurrentKey();
    composerDrafts.set(k, text);
    composerPostNow(selectedSteward, k, text);
    bottomTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    try { bottomTextarea.focus(); } catch {}
    try {
      if (typeof window.__reflectTypeBtnDraftIndicator === 'function') {
        window.__reflectTypeBtnDraftIndicator();
      }
    } catch {}
  };

  function isComposerOpen() {
    return !!(composerPanel && !composerPanel.hidden);
  }
  function openComposer() {
    if (!composerPanel) return;
    // Make sure the visible textarea reflects the active card's draft
    // (a card may have arrived/been navigated to while the composer
    // was closed). composerSwapForKey only restores when the active key
    // changes — but if a server push arrived while closed for the
    // SAME key, we still need to restore. So force-restore here.
    const k = composerCurrentKey();
    composerSwapForKey(k);
    if (composerActiveKey === k) {
      const cached = composerDrafts.get(k) || '';
      if (bottomTextarea && bottomTextarea.value !== cached) {
        bottomTextarea.value = cached;
        bottomTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    composerPanel.hidden = false;
    document.body.classList.add('composer-open');
    // Joshua 2026-08-08: the composer now opens in SHORT (one-liner)
    // mode by default — a slim strip pinned below the worker row that
    // hides NOTHING. Only the ⤢ expand button grows it into the old
    // tall, hide-the-rows composer. Always land in short mode on open;
    // the expand toggle sets .composer-expanded when the user asks for
    // the immersive height.
    document.body.classList.remove('composer-expanded');
    reflectComposerExpandBtn();
    // .is-engaged is the shared engaged-state class used by Type, Q,
    // and History buttons so all three light up the same way when
    // their panel is open (Joshua 2026-05-20: "hard to tell if they're
    // engaged or not because once you click on them the buttons
    // themselves don't change").
    if (typeBtn) typeBtn.classList.add('is-engaged');
    try { bottomTextarea.focus(); } catch {}
  }
  function closeComposer(opts) {
    if (!composerPanel) return;
    // Persist whatever's typed for the active card before we close, so
    // re-opening restores it. Do NOT clear the draft.
    const k = composerCurrentKey();
    composerDrafts.set(k, bottomTextarea.value);
    composerPostToServer(selectedSteward, k, bottomTextarea.value);
    try { bottomTextarea.blur(); } catch {}
    composerPanel.hidden = true;
    document.body.classList.remove('composer-open');
    // Reset to short mode so the next open starts non-intrusive.
    document.body.classList.remove('composer-expanded');
    // If the native box was standing in for this strip, that arrangement is
    // over too — clear it so a later desktop/no-bridge open is never left
    // invisible.
    try {
      if (typeof window.__nativeComposerReleaseScreen === 'function') {
        window.__nativeComposerReleaseScreen();
      }
    } catch {}
    if (typeBtn) typeBtn.classList.remove('is-engaged');
  }
  // --- Expand / collapse toggle (Joshua 2026-08-08) ---
  // SHORT (default): slim one-liner below the worker row, hides nothing.
  // TALL: .composer-expanded grows the textarea and hides the arrows /
  // stewards / worker rows (the pre-2026-08-08 always-on behavior).
  const composerExpandBtn = document.getElementById('conv-composer-expand');
  function isComposerExpanded() {
    return document.body.classList.contains('composer-expanded');
  }
  function reflectComposerExpandBtn() {
    if (!composerExpandBtn) return;
    const expanded = isComposerExpanded();
    // ⤢ = grow (short mode), ⤡ = shrink (tall mode).
    composerExpandBtn.textContent = expanded ? '⤡' : '⤢';
    composerExpandBtn.title = expanded ? 'Shrink composer' : 'Expand composer';
    composerExpandBtn.setAttribute('aria-label', composerExpandBtn.title);
  }
  function setComposerExpanded(expanded) {
    document.body.classList.toggle('composer-expanded', !!expanded);
    reflectComposerExpandBtn();
    try { bottomTextarea && bottomTextarea.focus(); } catch {}
  }
  if (composerExpandBtn) {
    composerExpandBtn.addEventListener('click', (e) => {
      e.preventDefault();
      setComposerExpanded(!isComposerExpanded());
    });
  }
  window.__composerOpen = openComposer;
  window.__composerClose = closeComposer;
  window.__composerIsOpen = isComposerOpen;
  window.__composerSetExpanded = setComposerExpanded;

  if (typeBtn) {
    typeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (isComposerOpen()) {
        // On the phone the native box is the visible box and the web strip
        // is hidden behind it, so there is nothing on screen to tap to get
        // the keyboard back once it's been dismissed. Make Type itself the
        // re-raise: if the composer is open but the native box is gone,
        // raise it again instead of closing (Josh 2026-09-03). A second tap
        // WITH the box up still closes, so the toggle stays symmetric.
        try {
          if (typeof window.__nativeComposerOpen === 'function' &&
              typeof window.__nativeComposerActive === 'function' &&
              !window.__nativeComposerActive() &&
              window.__nativeComposerOpen()) {
            return;
          }
        } catch {}
        closeComposer();
      } else openComposer();
    });
  }

  // Joshua 2026-05-20 iteration: the ONLY way to close the composer is
  // a second tap on the Type button. No tap-outside, no Esc. He
  // explicitly rejected the "tries to close it so cleverly" behavior
  // and wants explicit user control symmetric with how the Q + History
  // dropdowns work.

  // --- Saved-draft indicator on the Type button (2026-06-05) ---
  // When the composer is CLOSED but the active card has a preserved
  // draft, the Type button gets a small dot indicator (CSS .has-draft).
  // While the composer is open, the live textarea is the source of
  // truth; while closed, the composerDrafts Map under the current key
  // is the source of truth.
  function reflectTypeBtnDraftIndicator() {
    if (!typeBtn) return;
    const open = isComposerOpen();
    const liveText = (bottomTextarea && bottomTextarea.value) ? bottomTextarea.value.trim() : '';
    const storedText = (composerDrafts.get(composerCurrentKey()) || '').trim();
    const hasDraft = open ? !!liveText : !!storedText;
    typeBtn.classList.toggle('has-draft', hasDraft);
  }
  window.__reflectTypeBtnDraftIndicator = reflectTypeBtnDraftIndicator;
  // Update on textarea edits (live updates while open).
  if (bottomTextarea) {
    bottomTextarea.addEventListener('input', reflectTypeBtnDraftIndicator);
    // Live mid-typing server sync so other devices see drafts as Joshua types
    // (not just on close / swap / send). Per-key debounced — same shape as
    // .msg-input drafts. Matches his mental model: "phone shows what laptop
    // has."
    bottomTextarea.addEventListener('input', () => {
      const k = composerCurrentKey();
      // Keep the in-memory Map in lockstep with live textarea content, not
      // just on close/swap, so that an incoming socket push during the
      // typing burst won't have a stale Map to compare against.
      composerDrafts.set(k, bottomTextarea.value);
      composerPostToServer(selectedSteward, k, bottomTextarea.value);
    });
  }
  // Update on open/close (wrap the existing functions).
  const _origOpen = openComposer;
  const _origClose = closeComposer;
  window.__composerOpen = function () { _origOpen(); reflectTypeBtnDraftIndicator(); };
  window.__composerClose = function () { _origClose(); reflectTypeBtnDraftIndicator(); };
  // The typeBtn click handler above calls openComposer/closeComposer
  // directly (local refs), not through window.__composer*. Patch the
  // click flow to also refresh the indicator.
  if (typeBtn) {
    typeBtn.addEventListener('click', () => {
      // Run after the open/close has flipped state.
      setTimeout(reflectTypeBtnDraftIndicator, 0);
    });
  }

  // --- ✕ Clear button INSIDE the open composer (2026-06-05) ---
  // Empties the visible textarea AND the stored draft for the active
  // key, then refreshes UI state (has-text reflection + indicator).
  const composerClearBtn = document.getElementById('conv-composer-clear');
  if (composerClearBtn) {
    composerClearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!bottomTextarea) return;
      bottomTextarea.value = '';
      const k = composerCurrentKey();
      composerDrafts.set(k, '');
      composerPostNow(selectedSteward, k, '');
      bottomTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      try { bottomTextarea.focus(); } catch {}
      reflectTypeBtnDraftIndicator();
    });
  }

  // --- 🔄 hard-reload button ---
  // APK WebView aggressively caches the JS/CSS bundle; normal refresh
  // doesn't reliably drop it. Navigating to a URL with a fresh query
  // param forces the WebView to fetch index.html again, which pulls the
  // current ?v=<ts> asset refs.
  const reloadBtn = document.getElementById('conv-bottom-reload-btn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      reloadBtn.classList.add('is-reloading');
      reloadBtn.textContent = '⏳';
      // On the phone (APK), do a REAL hard kill + cold restart of the whole app —
      // same mechanism as the recovery app's "FULL APK RESTART" button. A JS soft
      // reload only re-fetches inside the same WebView/process and never re-runs
      // MainActivity.onCreate, so APK-level Homestead updates never appear. The
      // native Android bridge below actually cold-starts the process so updates show.
      if (window.Android && typeof window.Android.fullRestart === 'function') {
        try {
          window.Android.fullRestart();
          return;
        } catch {
          // fall through to soft-reload if the bridge call throws
        }
      }
      // Desktop browser / non-embedded fallback: cachebust soft-reload.
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('cachebust', String(Date.now()));
        window.location.replace(url.toString());
      } catch {
        try { window.location.reload(); } catch {}
      }
    });
  }

  // --- 🧹 clear-cards button ---
  // Opens the existing bulk-actions popover above the 🧹 button.
  // That popover already surfaces "Dismiss all" + adaptive time-cluster
  // buttons (e.g. "Older than 2h (5)") that Josh built into the side-nav
  // kebab. Reusing 1:1 so there's one time-clear UI, not two.
  const clearCardsBtn = document.getElementById('conv-bottom-clear-cards-btn');
  if (clearCardsBtn) {
    clearCardsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!selectedSteward) return;
      // Resolve the TOP-LEVEL steward — getItemsForSteward builds session
      // ids from `holler-${steward.id}` + all descendant subs, so we need
      // the root to get the full card set (matches sidebar-kebab UX).
      const stw = (typeof findStewardForSession === 'function') ? findStewardForSession(selectedSteward) : null;
      let stewardLike;
      if (stw) {
        stewardLike = stw;
      } else {
        const displayName = sessionDisplayName(selectedSteward);
        // Orphan/unknown — shim a stewardLike that only resolves its own
        // session. openBulkActionsPopover → getItemsForSteward →
        // getSessionIdsForSteward generates `holler-${id}`, so pick an id
        // that, prefixed with "holler-", matches selectedSteward exactly.
        const shimId = selectedSteward.startsWith('holler-') ? selectedSteward.slice('holler-'.length) : selectedSteward;
        stewardLike = { id: shimId, name: displayName };
      }
      if (typeof openBulkActionsPopover === 'function') {
        openBulkActionsPopover(clearCardsBtn, stewardLike);
      } else {
        console.error('[clear-cards] openBulkActionsPopover missing');
      }
    });
  }

  // --- ⚙️ settings button ---
  // Placeholder: toggles a stub settings panel (theme switcher target).
  // Full settings-panel build is its own task.
  const settingsBtn = document.getElementById('conv-bottom-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof openSettingsPanel === 'function') {
        openSettingsPanel();
      } else {
        alert('Settings panel — coming next. Theme switcher + config will live here.');
      }
    });
  }
  function reflectTextareaHasText() {
    if (!bottomTextarea) return;
    if (bottomTextarea.value.trim()) bottomTextarea.classList.add('has-text');
    else bottomTextarea.classList.remove('has-text');
    // Arm state tracks textarea-text too; pass current has-recording by
    // reading the body class set by the recording poll.
    const hasRec = document.body.classList.contains('pill-armed-recording');
    if (typeof window.__updatePillArmedState === 'function') {
      window.__updatePillArmedState(hasRec);
    }
  }
  bottomTextarea.addEventListener('input', reflectTextareaHasText);
  bottomTextarea.addEventListener('change', reflectTextareaHasText);
  // Clear .has-text when programmatic clears happen (send success).
  const _origValSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  // Lightweight: just reflect on blur too.
  bottomTextarea.addEventListener('blur', reflectTextareaHasText);
  reflectTextareaHasText();
  try { reflectTypeBtnDraftIndicator(); } catch {}

  // --- Hydrate composer drafts from server (was in-memory only pre-2026-06-06) ---
  // Server is single source of truth — fetch full map at boot, populate
  // composerDrafts Map (filtered to the composer-keyed entries only). If the
  // composer is already open with a matching active key when hydrate lands,
  // backfill the live textarea so the draft shows up without a re-toggle.
  async function hydrateComposerDraftsFromServer() {
    try {
      const res = await fetch('/api/presenter/drafts');
      if (!res.ok) return;
      const serverMap = await res.json();
      if (!serverMap || typeof serverMap !== 'object') return;
      // Drop stale entries first — switching stewards means the old steward's
      // _steward / itemId buckets aren't valid for the new view. Server is
      // canonical; if it has the entry, we'll repopulate below.
      composerDrafts.clear();
      for (const k of Object.keys(serverMap)) {
        const parsed = composerKeyToActiveKey(k);
        if (!parsed) continue;
        // Only populate composerDrafts entries for the CURRENTLY-selected
        // steward — Joshua sees one steward at a time in the composer.
        // Other-steward drafts stay on the server; they reload when he
        // switches.
        if (parsed.sessionId !== selectedSteward) continue;
        const val = serverMap[k];
        if (typeof val === 'string' && val.length > 0) {
          composerDrafts.set(parsed.composerKey, val);
        }
      }
      // Backfill live textarea if the composer is open with a matching key.
      // We backfill even if the textarea is focused — focus alone isn't a
      // "user is actively typing" signal here, and the only thing that could
      // be in an empty focused textarea is post-open default state.
      if (isComposerOpen() && bottomTextarea) {
        const cached = composerDrafts.get(composerActiveKey);
        if (cached && !bottomTextarea.value) {
          bottomTextarea.value = cached;
          bottomTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      try { reflectTypeBtnDraftIndicator(); } catch {}
    } catch (err) {
      console.warn('[composer-drafts] hydrate failed:', err);
    }
  }
  hydrateComposerDraftsFromServer();
  // Also re-hydrate when the user switches to a different steward — other
  // steward's composer drafts may not yet be in our Map.
  window.__hydrateComposerDraftsFromServer = hydrateComposerDraftsFromServer;

  // Real-time push: server emits `presenter:drafts-updated` after every
  // POST to /api/presenter/drafts. Merge composer-keyed entries into our
  // Map; if the composer is open with a matching key, update the live
  // textarea (race-gate: skip if local user typed within the gate window).
  if (window.presenter && typeof window.presenter.onDraftsUpdated === 'function') {
    window.presenter.onDraftsUpdated((payload) => {
      if (!payload || typeof payload !== 'object') return;
      const { key, value } = payload;
      const parsed = composerKeyToActiveKey(key);
      if (!parsed) return; // not a composer-keyed draft (probably a .msg-input one)
      const incoming = typeof value === 'string' ? value : '';
      // Only react to drafts for the steward we're currently viewing.
      if (parsed.sessionId !== selectedSteward) return;
      // Update the Map first (cheap; reflects server truth).
      if (incoming) composerDrafts.set(parsed.composerKey, incoming);
      else composerDrafts.delete(parsed.composerKey);
      // Race-gate the visible-textarea update.
      const lastLocal = composerLastLocalEdit.get(key) || 0;
      if (Date.now() - lastLocal < COMPOSER_RACE_GATE_MS) {
        try { reflectTypeBtnDraftIndicator(); } catch {}
        return;
      }
      // Only touch the textarea if the composer is open AND the incoming
      // key matches the currently-active composer key.
      if (isComposerOpen() && parsed.composerKey === composerActiveKey && bottomTextarea) {
        if (document.activeElement !== bottomTextarea || !bottomTextarea.value) {
          bottomTextarea.value = incoming;
          bottomTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      try { reflectTypeBtnDraftIndicator(); } catch {}
    });
  }
})();

// --- Keyboard shortcuts ---

document.addEventListener('keydown', (e) => {
  // Skip keyboard shortcuts when typing in an input
  const tag = (e.target.tagName || '').toLowerCase();
  const isTyping = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

  // Desktop-only shortcuts (skip if typing or on mobile/embedded)
  if (isTyping || document.body.classList.contains('embedded')) return;

  // Up/Down arrows: navigate steward list
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const rows = Array.from(document.querySelectorAll('#steward-list .steward-row'));
    if (rows.length === 0) return;
    const currentIdx = rows.findIndex(r => r.classList.contains('active'));
    let nextIdx;
    if (e.key === 'ArrowUp') {
      nextIdx = currentIdx <= 0 ? rows.length - 1 : currentIdx - 1;
    } else {
      nextIdx = currentIdx >= rows.length - 1 ? 0 : currentIdx + 1;
    }
    rows[nextIdx]?.click();
  }
});

// --- Scroll to bottom button ---
(function() {
  const scrollBtn = document.getElementById('scroll-to-bottom');
  const thread = document.getElementById('conv-thread');
  if (!scrollBtn || !thread) return;

  scrollBtn.addEventListener('click', () => {
    thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
  });

  function checkScroll() {
    const distFromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    if (distFromBottom > 300) {
      scrollBtn.classList.add('visible');
    } else {
      scrollBtn.classList.remove('visible');
      // User scrolled to bottom — hide glow
      if (window._hasUnseenBelow) {
        window._hasUnseenBelow = false;
        hideBottomGlow();
      }
    }
  }
  thread.addEventListener('scroll', checkScroll, { passive: true });
  setInterval(checkScroll, 2000);
})();

// --- Bottom glow for unseen cards ---
function showBottomGlow() {
  let glow = document.getElementById('bottom-glow');
  if (!glow) {
    glow = document.createElement('div');
    glow.id = 'bottom-glow';
    const thread = document.getElementById('conv-thread');
    if (thread && thread.parentNode) {
      thread.parentNode.insertBefore(glow, thread.nextSibling);
    }
  }
  glow.classList.add('active');
}

function hideBottomGlow() {
  const glow = document.getElementById('bottom-glow');
  if (glow) glow.classList.remove('active');
}

// --- Pause agent (send Escape to tmux session) ---
(function() {
  const SERVER_URL = window.location.origin || 'http://localhost:3005';

  window.pauseAgent = function(sessionId) {
    const sid = sessionId || selectedSteward;
    if (!sid) return Promise.reject('No session selected');
    return fetch(`${SERVER_URL}/api/sessions/send-escape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid })
    }).then(r => r.json());
  };
})();

// --- Pending queue items for selected steward ---
let pendingQueueItems = [];

let allQueueItems = [];

// --- Unified message log (read-time merge) ---
// The server merges live cards + archived history + walkie queue into one
// chronological log per steward (NO new persistent store). Cached per steward
// and refreshed whenever the queue panel is open / re-rendered.
// Josh's #3: the log is GLOBAL now — one chronological view of every steward's
// traffic — so the fetch always pulls the full merged log (steward=*) and the
// client's two toggles ("only my messages" / "only this steward") slice it.
// Cache under a single '*' key; the selectedSteward is only used to scope the
// "only this steward" filter, never the fetch.
let unifiedLogCache = {};      // '*' -> [entry, ...] (global)
const UNIFIED_LOG_KEY = '*';
async function fetchUnifiedLog(_sessionId) {
  const SERVER_URL = window.location.origin || 'http://localhost:3005';
  try {
    const res = await fetch(`${SERVER_URL}/api/presenter/unified-log?steward=*&limit=400`);
    const data = await res.json();
    unifiedLogCache[UNIFIED_LOG_KEY] = (data && data.entries) || [];
  } catch { unifiedLogCache[UNIFIED_LOG_KEY] = unifiedLogCache[UNIFIED_LOG_KEY] || []; }
  return unifiedLogCache[UNIFIED_LOG_KEY];
}

async function fetchPendingQueue() {
  const SERVER_URL = window.location.origin || 'http://localhost:3005';
  try {
    const res = await fetch(`${SERVER_URL}/api/queue`);
    const data = await res.json();
    const prev = pendingQueueItems.map(i => i.id).sort().join(',') + '|' + allQueueItems.length;
    pendingQueueItems = (data.queue || []).filter(item => item.status !== 'confirmed' && item.status !== 'failed');
    allQueueItems = data.queue || [];
    const curr = pendingQueueItems.map(i => i.id).sort().join(',') + '|' + allQueueItems.length;
    if (prev !== curr && selectedSteward) {
      updatePendingSection();
    }
  } catch { pendingQueueItems = []; allQueueItems = []; }
}

function parsePendingItem(item) {
  let msgText = '', fromId = '';
  // For Joshua-feedback envelopes, we also extract the original card he was
  // replying to so the Q view can render the pair (card + reply) together.
  let cardTitle = '', cardBody = '', replyText = '', buttonClicked = '', isFeedbackEnvelope = false;
  try {
    let parsed = JSON.parse(item.message);
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch {} }
    if (typeof parsed === 'object') {
      msgText = parsed.instruction || parsed.feedback || parsed.text || parsed.message || parsed.title || '';
      fromId = parsed.from || '';
      // Feedback envelope from the presenter carries the original card halves
      // (title + message = the steward's card) plus Joshua's reply (text +
      // button). Detect and surface both so the Q view can pair them.
      if (parsed.source === 'presenter' && (parsed.title || parsed.message)) {
        isFeedbackEnvelope = true;
        cardTitle = parsed.title || '';
        cardBody = parsed.message || '';
        replyText = parsed.text || '';
        buttonClicked = parsed.button || '';
      }
    } else { msgText = String(parsed); }
  } catch { msgText = item.message || ''; }
  if (typeof msgText !== 'string') {
    try { msgText = JSON.stringify(msgText); } catch { msgText = String(msgText); }
  }
  if (msgText.startsWith('{') || msgText.startsWith('[')) {
    try { const p = JSON.parse(msgText); msgText = p.instruction || p.text || p.message || msgText; } catch {}
  }
  return { msgText, fromId, cardTitle, cardBody, replyText, buttonClicked, isFeedbackEnvelope };
}

// Kept as a thin alias so existing call sites keep working — the canonical
// formatter is sessionDisplayName(). The old body threw away everything after
// "--" (the worker's actual name) and never capitalized.
function shortSessionName(sid) {
  return sessionDisplayName(sid);
}

function queueStatusIcon(status) {
  if (status === 'confirmed') return '✓';
  if (status === 'delivered') return '↗';
  if (status === 'failed') return '✗';
  return '⏳';
}

function queueStatusClass(status) {
  if (status === 'confirmed') return 'status-confirmed';
  if (status === 'delivered') return 'status-delivered';
  if (status === 'failed') return 'status-failed';
  return 'status-pending';
}

function buildPendingRow(item) {
  const parsed = parsePendingItem(item);
  const { msgText, fromId, cardTitle, cardBody, replyText, buttonClicked, isFeedbackEnvelope } = parsed;
  // Only "You" if explicitly from josh-presenter
  const isFromJosh = fromId === 'josh-presenter';
  // Resolve target name — use substeward name+emoji if available
  let targetName = shortSessionName(item.target_session);
  const targetSub = findSubstewardForSession(item.target_session);
  if (targetSub) {
    targetName = (targetSub.icon ? targetSub.icon + ' ' : '') + (targetSub.name || targetSub.id);
  }
  let fromName;
  if (isFromJosh) {
    fromName = 'You';
  } else if (fromId) {
    fromName = shortSessionName(fromId);
  } else {
    // No from field — infer: if target is a build session (has --), sender is parent steward
    const target = item.target_session || '';
    const ddIdx = target.indexOf('--');
    fromName = ddIdx > 0 ? shortSessionName(target.substring(0, ddIdx)) : '?';
  }
  const status = item.status || 'pending';
  const isPending = status !== 'confirmed' && status !== 'failed';

  const row = document.createElement('div');
  row.className = 'pending-item ' + (isFromJosh ? 'from-josh' : 'from-steward') + ' ' + queueStatusClass(status);
  if (isFeedbackEnvelope) row.classList.add('has-pair');

  // Direction + status + time
  const direction = document.createElement('div');
  direction.className = 'pending-direction';
  const itemTime = item.timestamp || item.created_at;
  const timeStr = itemTime ? relativeTime(itemTime) : '';
  direction.innerHTML = `<span class="pending-status-icon">${queueStatusIcon(status)}</span> <span class="pending-from">${fromName}</span> → <span class="pending-to">${targetName}</span>${timeStr ? ` <span class="pending-time">${timeStr}</span>` : ''}`;
  row.appendChild(direction);

  if (isFeedbackEnvelope) {
    // Paired view: original card on top, Joshua's reply below.
    const TRUNC = 240;
    const cardCombined = (cardTitle ? cardTitle + (cardBody ? ' — ' : '') : '') + (cardBody || '');
    const replyCombined = replyText || (buttonClicked ? `(button: ${buttonClicked})` : '');

    const cardEl = document.createElement('div');
    cardEl.className = 'pair-card';
    const cardLabel = document.createElement('div');
    cardLabel.className = 'pair-label pair-label-card';
    cardLabel.textContent = `↘ from ${shortSessionName(item.target_session)}`;
    const cardText = document.createElement('div');
    cardText.className = 'pair-card-text';
    const cardTrunc = cardCombined.length > TRUNC ? cardCombined.slice(0, TRUNC) + '…' : cardCombined;
    cardText.textContent = cardTrunc;
    let cardExpanded = false;
    if (cardCombined.length > TRUNC) {
      cardText.style.cursor = 'pointer';
      cardText.addEventListener('click', (e) => {
        e.stopPropagation();
        cardExpanded = !cardExpanded;
        cardText.textContent = cardExpanded ? cardCombined : cardTrunc;
      });
    }
    cardEl.appendChild(cardLabel);
    cardEl.appendChild(cardText);
    row.appendChild(cardEl);

    const replyEl = document.createElement('div');
    replyEl.className = 'pair-reply';
    const replyLabel = document.createElement('div');
    replyLabel.className = 'pair-label pair-label-reply';
    replyLabel.textContent = buttonClicked ? `↗ You replied (button: ${buttonClicked})` : '↗ You replied';
    const replyTextEl = document.createElement('div');
    replyTextEl.className = 'pair-reply-text';
    const replyTrunc = replyCombined.length > TRUNC ? replyCombined.slice(0, TRUNC) + '…' : replyCombined;
    replyTextEl.textContent = replyTrunc || '(no text — only button clicked)';
    let replyExpanded = false;
    if (replyCombined.length > TRUNC) {
      replyTextEl.style.cursor = 'pointer';
      replyTextEl.addEventListener('click', (e) => {
        e.stopPropagation();
        replyExpanded = !replyExpanded;
        replyTextEl.textContent = replyExpanded ? replyCombined : replyTrunc;
      });
    }
    replyEl.appendChild(replyLabel);
    replyEl.appendChild(replyTextEl);
    row.appendChild(replyEl);
  } else {
    // Truncated text (expandable) — non-feedback rows (e.g. steward→steward action items)
    const truncated = msgText.length > 100 ? msgText.slice(0, 100) + '…' : msgText;
    const textEl = document.createElement('div');
    textEl.className = 'pending-text';
    textEl.textContent = truncated;
    let expanded = false;
    if (msgText.length > 100) {
      textEl.style.cursor = 'pointer';
      textEl.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded = !expanded;
        textEl.textContent = expanded ? msgText : truncated;
      });
    }
    row.appendChild(textEl);
  }

  // Cancel button (only for pending items)
  if (isPending) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'pending-cancel';
    cancelBtn.textContent = '✕';
    cancelBtn.addEventListener('click', () => {
      const SERVER_URL = window.location.origin || 'http://localhost:3005';
      fetch(`${SERVER_URL}/api/queue/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id })
      }).then(() => fetchPendingQueue());
    });
    row.appendChild(cancelBtn);
  }

  return row;
}

// Friendly counterparty name for a unified-log entry — always emoji + name
// (Josh's #2: "we'd also have the actual emoji associated with it").
// Resolution order: exact substeward → top-level steward (both carry an .icon
// from /api/stewards) → bare shortened session name as a last resort.
function unifiedCounterpartyName(sid) {
  if (!sid) return '?';
  const sub = findSubstewardForSession(sid);
  if (sub) return (sub.icon ? sub.icon + ' ' : '') + (sub.name || sub.id);
  const stw = findStewardForSession(sid);
  if (stw) return (stw.icon ? stw.icon + ' ' : '') + (stw.name || stw.id);
  return shortSessionName(sid);
}

// buildUnifiedRow — render ONE entry of the unified message log.
//
// Direction is made obvious: RECEIVED (↙ steward → you) vs SENT (↗ you →
// steward) vs steward↔steward traffic (⇄). The counterparty name is always
// shown in the header.
//
// THE COLLAPSE CONTRACT (Josh's V3 pivot): collapse/expand lives in ONE
// dedicated BUTTON (the chevron). NOTHING else toggles — not the header, not
// the body. This kills the select-vs-collapse ambiguity BY DESIGN: tapping the
// header does nothing, long-press-to-copy on the body does nothing to the
// collapse state, only the button flips it. Emulated-touch gesture guards
// passed the harness but failed Josh's real phone in V2 — a real <button> with
// a real click target does not have that failure mode.
//
// LAYOUT (Josh's #5): each row is [ big relative-time column | content column ].
// The "how long ago" number is the large, prominent left element; the dir
// badge, status, name, and body sit in the content column to its right.
function buildUnifiedRow(entry) {
  const dir = entry.direction || 'steward';
  const isSent = dir === 'sent';
  const isReceived = dir === 'received';
  const cpName = unifiedCounterpartyName(entry.counterparty);

  const row = document.createElement('div');
  row.className = 'ulog-item ulog-' + dir + (entry.isJosh ? ' ulog-mine' : '');

  // Full body text (markdown source). For a Josh reply we prefix the button.
  let fullText = entry.body || '';
  if (entry.replyButton) {
    fullText = (fullText ? fullText + '\n\n' : '') + `_(button: ${entry.replyButton})_`;
  }
  if (entry.title && isReceived) {
    fullText = `**${entry.title}**` + (fullText ? '\n\n' + fullText : '');
  }
  fullText = fullText || '(no text)';

  // --- TIME COLUMN (big prominent left element — Josh's #5) ---
  // Big "how long ago" number, with the real abbreviated date+time under it
  // (Josh's ask: "under the 'time since' value, include a real abbreviated
  // date and time").
  const timeEl = document.createElement('div');
  timeEl.className = 'ulog-time';

  const timeAgoEl = document.createElement('div');
  timeAgoEl.className = 'ulog-time-ago';
  timeAgoEl.textContent = entry.ts ? relativeTime(entry.ts) : '';
  timeEl.appendChild(timeAgoEl);

  // Real absolute date+time under the relative number, split across TWO lines
  // (Josh's tweak): line 1 = date ("Jul 22"), line 2 = clock ("7:27 AM").
  const timeAbsEl = document.createElement('div');
  timeAbsEl.className = 'ulog-time-abs';
  if (entry.ts) {
    const dateLine = document.createElement('div');
    dateLine.className = 'ulog-time-date';
    dateLine.textContent = abbrevDate(entry.ts);
    timeAbsEl.appendChild(dateLine);

    const clockLine = document.createElement('div');
    clockLine.className = 'ulog-time-clock';
    clockLine.textContent = formatActualTime(entry.ts);
    timeAbsEl.appendChild(clockLine);
  }
  timeEl.appendChild(timeAbsEl);

  row.appendChild(timeEl);

  // --- CONTENT COLUMN (everything to the right of the time) ---
  const content = document.createElement('div');
  content.className = 'ulog-content';

  // --- HEADER (dir badge + status + collapse button). NOT a toggle target. ---
  const header = document.createElement('div');
  header.className = 'ulog-header';

  const dirBadge = document.createElement('span');
  dirBadge.className = 'ulog-dir ' + (isSent ? 'ulog-dir-sent' : isReceived ? 'ulog-dir-recv' : 'ulog-dir-steward');
  if (isSent) dirBadge.textContent = '↗ You → ' + cpName;
  else if (isReceived) dirBadge.textContent = '↙ ' + cpName + ' → You';
  else dirBadge.textContent = '⇄ ' + cpName;
  header.appendChild(dirBadge);

  // Status badge — driven by the server's explicit booleans, NOT by guessing
  // from a status string (Josh's #4: the string-guess badged every delivered
  // card/message "⏳ queued"). Only a genuinely-undispatched walkie item is
  // queued; `sending` = dispatched-awaiting-ack; `failed` = terminal error.
  // Delivered cards and confirmed messages get NO badge.
  if (entry.queued) {
    const q = document.createElement('span');
    q.className = 'ulog-status ulog-status-queued';
    q.textContent = '⏳ queued';
    header.appendChild(q);
  } else if (entry.sending) {
    const q = document.createElement('span');
    q.className = 'ulog-status ulog-status-queued';
    q.textContent = '↗ sending';
    header.appendChild(q);
  } else if (entry.failed) {
    const q = document.createElement('span');
    q.className = 'ulog-status ulog-status-failed';
    q.textContent = '✗ failed';
    header.appendChild(q);
  }

  // THE collapse control — a real <button>, the ONLY toggle hit-target.
  const chevron = document.createElement('button');
  chevron.type = 'button';
  chevron.className = 'ulog-chevron';
  chevron.textContent = '▸';
  chevron.setAttribute('aria-label', 'Expand message');
  header.appendChild(chevron);

  content.appendChild(header);

  // --- BODY (free for selection/copy — NO collapse listener) ---
  const TRUNC = 140;
  const oneLine = fullText.replace(/\s+/g, ' ').trim();
  const preview = oneLine.length > TRUNC ? oneLine.slice(0, TRUNC) + '…' : oneLine;

  const body = document.createElement('div');
  body.className = 'ulog-body';

  const previewEl = document.createElement('div');
  previewEl.className = 'ulog-preview';
  previewEl.textContent = preview;
  body.appendChild(previewEl);

  const fullEl = document.createElement('div');
  fullEl.className = 'ulog-full';
  fullEl.style.display = 'none';
  fullEl.innerHTML = renderMarkdown(fullText);
  try { processLinks(fullEl); } catch {}
  body.appendChild(fullEl);

  // One-click "copy whole message" button at the BOTTOM of the expanded view
  // (Josh's ask). Lives inside fullEl so it only appears when expanded. Copies
  // the full markdown source via the WebView-safe clipboard helper.
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'ulog-copy';
  copyBtn.textContent = '⧉ Copy message';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window._presenterCopyText(fullText).then((ok) => {
      copyBtn.textContent = ok ? '✓ Copied' : '✗ Copy failed';
      copyBtn.classList.toggle('ulog-copy-done', ok);
      setTimeout(() => {
        copyBtn.textContent = '⧉ Copy message';
        copyBtn.classList.remove('ulog-copy-done');
      }, 1600);
    });
  });
  fullEl.appendChild(copyBtn);

  content.appendChild(body);
  row.appendChild(content);

  // Collapse is driven ONLY from the chevron button. Toggling swaps preview↔full
  // and rotates the chevron. The header and body are never toggle targets — so
  // a text-select or long-press-copy anywhere in the row can never collapse it.
  let expanded = false;
  function setExpanded(next) {
    expanded = next;
    previewEl.style.display = expanded ? 'none' : '';
    fullEl.style.display = expanded ? '' : 'none';
    chevron.textContent = expanded ? '▾' : '▸';
    chevron.setAttribute('aria-label', expanded ? 'Collapse message' : 'Expand message');
    row.classList.toggle('ulog-expanded', expanded);
  }
  chevron.addEventListener('click', (e) => {
    e.stopPropagation();
    setExpanded(!expanded);
  });

  return row;
}

// topLevelOf — the steward's top-level id from a session id. The sub-session
// delimiter is the DOUBLE dash, so everything before the first `--` is the
// steward (e.g. holler-crowne-vault--foo → holler-crowne-vault).
function topLevelOf(sid) {
  return (sid || '').split('--')[0].toLowerCase();
}

// entryTouchesSteward — does this log entry involve the given steward (TO or
// FROM), folding in the whole steading/crew (any sub-session sharing the
// top-level id)? Josh's #3 (b): "only this steward" = messages sent TO or FROM
// the current steward, OR anyone in that steading/crew.
function entryTouchesSteward(entry, sessionId) {
  if (!sessionId) return true;
  const wantTop = topLevelOf(sessionId);
  if (!wantTop) return true;
  const sides = [entry.counterparty, entry.from, entry.target].filter(Boolean);
  return sides.some(s => topLevelOf(s) === wantTop);
}

// getUnifiedRowsForSteward — TWO independent filters over the GLOBAL log
// (Josh's #3). DEFAULT = both OFF = ALL messages across every steward.
//   • onlyMine       → only messages Josh is party to (cards to him + replies)
//   • onlyThisSteward → only traffic touching the selected steward/crew
// The two compose (AND) when both are on.
function getUnifiedRowsForSteward(sessionId, opts) {
  const onlyMine = !!(opts && opts.onlyMine);
  const onlyThisSteward = !!(opts && opts.onlyThisSteward);
  const entries = (unifiedLogCache[UNIFIED_LOG_KEY] || []).slice();
  return entries.filter(e => {
    if (onlyMine && !(e.direction === 'received' || e.direction === 'sent')) return false;
    if (onlyThisSteward && !entryTouchesSteward(e, sessionId)) return false;
    return true;
  });
}

function updatePendingSection() {
  // Re-render the bottom toolbar to reflect queue changes
  renderBottomToolbar();
}

function getPendingForSteward(sessionId) {
  if (!sessionId) return [];
  const steward = findStewardForSession(sessionId);
  const sessionIds = steward ? getSessionIdsForSteward(steward) : [sessionId];
  return pendingQueueItems.filter(item => sessionIds.includes(item.target_session));
}

function getQueueItemTime(item) {
  if (item.timestamp) return item.timestamp;
  if (item.created_at) return new Date(item.created_at).getTime();
  return 0;
}

function getRecentQueueForSteward(sessionId, limit, opts) {
  if (!sessionId) return [];
  const steward = findStewardForSession(sessionId);
  const sessionIds = steward ? getSessionIdsForSteward(steward) : [sessionId];
  const onlyMine = !!(opts && opts.onlyMine);
  return allQueueItems
    .filter(item => sessionIds.includes(item.target_session))
    .filter(item => {
      if (!onlyMine) return true;
      // "Only my messages" = only items Joshua sent (feedback envelopes from
      // the presenter, identified by source/from on the parsed envelope).
      const p = parsePendingItem(item);
      return p.fromId === 'josh-presenter' || p.isFeedbackEnvelope;
    })
    .sort((a, b) => getQueueItemTime(b) - getQueueItemTime(a))
    .slice(0, limit || 100);
}

// Poll pending queue every 5 seconds
setInterval(fetchPendingQueue, 5000);
fetchPendingQueue();

// --- Activity log ---
let activityCache = {}; // sessionId -> { activities, is_working, current_tool }

async function fetchActivity(sessionId) {
  if (!sessionId) return;
  const SERVER_URL = window.location.origin || 'http://localhost:3005';
  // Fetch for all session IDs of this steward
  const steward = findStewardForSession(sessionId);
  const sessionIds = steward ? getSessionIdsForSteward(steward) : [sessionId];
  for (const sid of sessionIds) {
    try {
      const res = await fetch(`${SERVER_URL}/api/fast-activity/${encodeURIComponent(sid)}`);
      const data = await res.json();
      if (data.activities && data.activities.length > 0) {
        activityCache[sid] = data;
      }
    } catch {}
  }
}

function getActivityForSteward(sessionId) {
  if (!sessionId) return [];
  const steward = findStewardForSession(sessionId);
  const sessionIds = steward ? getSessionIdsForSteward(steward) : [sessionId];
  let all = [];
  sessionIds.forEach(sid => {
    const cached = activityCache[sid];
    if (cached && cached.activities) {
      all = all.concat(cached.activities.map(a => ({ ...a, _session: sid })));
    }
  });
  // Sort by timestamp, return last 30
  all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return all.slice(-30);
}

function buildActivitySection(sessionId) {
  const activities = getActivityForSteward(sessionId);

  const section = document.createElement('div');
  section.className = 'activity-log-section';

  // Check if previously expanded
  let isExpanded = false;
  try { isExpanded = localStorage.getItem('activity-log-expanded') === 'true'; } catch {}
  if (isExpanded) section.classList.add('expanded');

  // Latest activity for the minimized header summary
  const latest = activities[activities.length - 1];
  const latestIcon = !latest ? '' : latest.tool === 'thinking' ? '💭' : latest.tool === 'response' ? '💬' : latest.tool === 'Bash' ? '💻' : latest.tool === 'Read' ? '📖' : latest.tool === 'Edit' ? '✏️' : latest.tool === 'Write' ? '📝' : latest.tool === 'Grep' ? '🔍' : latest.tool === 'Glob' ? '📁' : latest.tool === 'Agent' ? '🤖' : latest.tool && latest.tool.startsWith('mcp__') ? '🔌' : '🔧';
  const latestMsg = latest ? (latest.message || '').replace(/</g, '&lt;').substring(0, 60) : '';

  const header = document.createElement('div');
  header.className = 'activity-log-header';
  header.innerHTML = `<span class="activity-expand-icon">▸</span><span>⚡ Activity</span><span class="activity-latest">${latestIcon} ${latestMsg}</span>`;

  const body = document.createElement('div');
  body.className = 'activity-log-body';

  if (activities.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding: 12px 8px; color: #444; font-size: 11px; font-family: VT323, monospace; text-align: center;';
    empty.textContent = 'No activity yet — waiting for agent to start working';
    body.appendChild(empty);
  }

  header.addEventListener('click', () => {
    const expanding = !section.classList.contains('expanded');
    section.classList.toggle('expanded');
    try { localStorage.setItem('activity-log-expanded', expanding ? 'true' : 'false'); } catch {}
    if (expanding) {
      setTimeout(() => { body.scrollTop = body.scrollHeight; }, 50);
    }
  });

  function getToolIcon(tool) {
    if (tool === 'thinking') return '💭';
    if (tool === 'response') return '💬';
    if (tool === 'Bash') return '💻';
    if (tool === 'Read') return '📖';
    if (tool === 'Edit') return '✏️';
    if (tool === 'Write') return '📝';
    if (tool === 'Grep') return '🔍';
    if (tool === 'Glob') return '📁';
    if (tool === 'Agent') return '🤖';
    if (tool && tool.startsWith('mcp__')) return '🔌';
    return '🔧';
  }

  activities.forEach(a => {
    const row = document.createElement('div');
    row.className = 'activity-row' + (a.phase === 'start' ? ' in-progress' : '');
    const toolIcon = getToolIcon(a.tool);
    const time = new Date(a.timestamp);
    const timeStr = `${time.getHours() % 12 || 12}:${time.getMinutes().toString().padStart(2, '0')}`;
    const msgLimit = a.tool === 'response' ? 200 : 80;
    if (a.tool === 'response') row.classList.add('response-entry');
    row.innerHTML = `<span class="activity-time">${timeStr}</span><span class="activity-tool">${toolIcon} ${a.tool || '?'}</span><span class="activity-msg">${(a.message || '').replace(/</g, '&lt;').substring(0, msgLimit)}</span>`;
    body.appendChild(row);
  });

  // Auto-scroll to bottom if expanded
  if (isExpanded) {
    setTimeout(() => { body.scrollTop = body.scrollHeight; }, 10);
  }

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

// Fallback: refresh activity for selected steward every 30 seconds (real-time via socket)
setInterval(() => {
  if (selectedSteward) {
    fetchActivity(selectedSteward).then(() => {
      renderBottomToolbar();
    });
  }
}, 30000);

// --- Exposed API for native mobile app ---

window.getActiveCardId = function() {
  if (!selectedSteward) return null;
  const substeward = findSubstewardForSession(selectedSteward);
  if (substeward) {
    const items = queue.filter(i => i.session_id === selectedSteward);
    return items.length > 0 ? items[0].id : null;
  }
  const steward = findStewardForSession(selectedSteward);
  const items = steward ? getItemsForSteward(steward) : queue.filter(i => i.session_id === selectedSteward);
  return items.length > 0 ? items[0].id : null;
};

window.getActiveCardSessionId = function() {
  return selectedSteward || null;
};

window.navigateToCard = function(cardId) {
  const item = queue.find(i => i.id === cardId);
  if (item) {
    // Register the target BEFORE selectSteward, because selectSteward kicks
    // off the async history fetch whose .then(renderView) is exactly what used
    // to clobber this navigation. With the target registered up front, EVERY
    // render in the storm that follows — the synchronous one below, and the
    // late one when the fetch lands — resolves to this card. That is the
    // snap-back fix (Josh 2026-09-03); the old fixed 100ms timeout simply
    // raced the fetch and usually lost.
    if (typeof window.__deckSetPendingNav === 'function') {
      window.__deckSetPendingNav(cardId);
    }
    selectSteward(item.session_id);
    // Land on the card immediately if it's already rendered. If it isn't yet,
    // the pending target above catches it when the fetch resolves.
    if (typeof window.mobileDeckJumpTo === 'function') window.mobileDeckJumpTo(cardId);
    setTimeout(() => {
      // Desktop/timeline surfaces still scroll; on the phone deck the cards are
      // absolutely positioned inside an overflow:hidden frame, so this is a
      // no-op there and the deck transition provides the motion instead.
      const el = document.querySelector(`[data-item-id="${cardId}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // External-nav entry: setCurrent fires the per-card composer
      // swap on deck-internal navigation, but a deep-link or
      // sidebar-jump can hit this path. Re-sync after the DOM
      // settles.
      if (typeof window.__composerSwapForActiveCard === 'function') {
        window.__composerSwapForActiveCard();
      }
    }, 100);
    return true;
  }
  return false;
};

// Voice transcription with undo — called from Android Kotlin
window.sendVoiceWithUndo = function(transcript) {
  if (!selectedSteward) return;
  const substeward = findSubstewardForSession(selectedSteward);
  let items;
  if (substeward) {
    items = queue.filter(i => i.session_id === selectedSteward);
  } else {
    const steward = findStewardForSession(selectedSteward);
    items = steward ? getItemsForSteward(steward) : queue.filter(i => i.session_id === selectedSteward);
  }
  if (items.length === 0) return;

  const item = items[0];
  let buttonLabel = 'Voice Response';
  if (item.buttons && item.buttons.length > 0) {
    const btn = item.buttons[0];
    buttonLabel = typeof btn === 'string' ? btn : (btn.label || 'Voice Response');
  }

  stopTts();
  // A PINNED card survives every reply route including this Android voice
  // path (Josh 2026-07-14 unification: pin governs survival, only ✕ dismisses).
  startUndoSend(buttonLabel, item.session_id, item.id, () =>
    window.presenter.respond(item.id, buttonLabel, transcript, !!item.pinned)
  );
};

// --- Titlebar settings controls (Electron only) ---
(function() {
  var opacitySlider = document.getElementById('ctrl-opacity');
  var fontDownBtn = document.getElementById('ctrl-font-down');
  var fontUpBtn = document.getElementById('ctrl-font-up');
  var fontValEl = document.getElementById('ctrl-font-val');
  if (!opacitySlider || !fontDownBtn || !fontUpBtn || !fontValEl) return;

  var currentFontSize = 14;

  function applyFontSize(size) {
    currentFontSize = size;
    fontValEl.textContent = size;
    // Use CSS variable so dynamically created elements inherit the size
    document.documentElement.style.setProperty('--presenter-font-size', size + 'px');
  }

  opacitySlider.addEventListener('input', function() {
    var val = parseInt(this.value) / 100;
    if (window.presenter && window.presenter.setOpacity) {
      window.presenter.setOpacity(val);
    } else {
      // Web fallback — apply opacity via CSS
      document.body.style.opacity = val;
      try { localStorage.setItem('presenter-opacity', val); } catch {}
    }
  });

  fontDownBtn.addEventListener('click', function() {
    var newSize = Math.max(10, currentFontSize - 1);
    applyFontSize(newSize);
    if (window.presenter && window.presenter.setFontSize) {
      window.presenter.setFontSize(newSize);
    }
    try { localStorage.setItem('presenter-font-size', newSize); } catch {}
  });

  fontUpBtn.addEventListener('click', function() {
    var newSize = Math.min(24, currentFontSize + 1);
    applyFontSize(newSize);
    if (window.presenter && window.presenter.setFontSize) {
      window.presenter.setFontSize(newSize);
    }
    try { localStorage.setItem('presenter-font-size', newSize); } catch {}
  });

  // Load initial settings — try Electron IPC first, then localStorage
  if (window.presenter && window.presenter.getSettings) {
    window.presenter.getSettings().then(function(s) {
      if (s.opacity) opacitySlider.value = Math.round(s.opacity * 100);
      if (s.fontSize) applyFontSize(s.fontSize);
    });
  } else {
    // Web fallback — load from localStorage
    try {
      var savedFontSize = localStorage.getItem('presenter-font-size');
      if (savedFontSize) applyFontSize(parseInt(savedFontSize));
      var savedOpacity = localStorage.getItem('presenter-opacity');
      if (savedOpacity) {
        opacitySlider.value = Math.round(parseFloat(savedOpacity) * 100);
        document.body.style.opacity = savedOpacity;
      }
    } catch {}
  }

  // Listen for settings updates from main process (Electron only)
  if (window.presenter && window.presenter.onSettingsUpdate) {
    window.presenter.onSettingsUpdate(function(s) {
      if (s.fontSize) applyFontSize(s.fontSize);
      if (s.opacity) opacitySlider.value = Math.round(s.opacity * 100);
    });
  }

  // --- Reading mode toggle (Iowa + Gruvbox presets) ---
  // Cycles off → iowa → gruvbox → off. Persists in localStorage.
  // Same-origin iframes get a preset-aware overlay injected.
  var readingBtn = document.getElementById('ctrl-reading-mode');
  if (readingBtn) {
    // Palette definitions per preset — kept in sync with style.css blocks.
    // Used only by the iframe overlay (parent DOM reads palette from CSS).
    var PRESET_PALETTES = {
      iowa: {
        bg:        '#F4EFE6',
        panel:     '#FAF5EC',
        panelAlt:  '#EFE4CD',
        border:    '#D0C4AE',
        text:      '#1A1815',
        textSoft:  '#5A4430',
        accent:    '#7A5C3E',
        accentH:   '#5A4430',
        sage:      '#6B8E4E',
        slate:     '#4A6B8E',
        gold:      '#C8A96A',
      },
      gruvbox: {
        // Gruvbox Dark Medium — iconic warm-dark bg, cream fg, orange accent
        bg:        '#282828',
        panel:     '#3C3836',
        panelAlt:  '#504945',
        border:    '#504945',
        text:      '#EBDBB2',
        textSoft:  '#BDAE93',
        accent:    '#FE8019',
        accentH:   '#D65D0E',
        sage:      '#B8BB26',
        slate:     '#83A598',
        gold:      '#FABD2F',
      },
      'gruvbox-hard': {
        // Very-dark variant, brighter cream fg for contrast
        bg:        '#1D2021',
        panel:     '#282828',
        panelAlt:  '#3C3836',
        border:    '#3C3836',
        text:      '#FBF1C7',
        textSoft:  '#EBDBB2',
        accent:    '#FE8019',
        accentH:   '#D65D0E',
        sage:      '#B8BB26',
        slate:     '#83A598',
        gold:      '#FABD2F',
      },
    };

    function buildIframeCss(preset) {
      var p = PRESET_PALETTES[preset] || PRESET_PALETTES.iowa;
      // Tiny CSS string — one pass gets every surface in the iframe.
      // Also expose the palette as CSS custom properties so iframe content
      // can use `var(--iowa-text, #fff)` and have it resolve per preset.
      return [
        ':root {',
        '  --iowa-bg: ' + p.bg + ';',
        '  --iowa-panel: ' + p.panel + ';',
        '  --iowa-panel-alt: ' + p.panelAlt + ';',
        '  --iowa-border: ' + p.border + ';',
        '  --iowa-text: ' + p.text + ';',
        '  --iowa-text-soft: ' + p.textSoft + ';',
        '  --iowa-accent: ' + p.accent + ';',
        '  --iowa-accent-hover: ' + p.accentH + ';',
        '  --iowa-sage: ' + p.sage + ';',
        '  --iowa-slate: ' + p.slate + ';',
        '  --iowa-gold: ' + p.gold + ';',
        '}',
        'html, body {',
        '  background: ' + p.bg + ' !important;',
        '  color: ' + p.text + ' !important;',
        '  font-family: "iA Writer Quattro", "Charter", "Iowan Old Style", Georgia, serif !important;',
        '  font-size: 17px !important;',
        '  line-height: 1.65 !important;',
        '}',
        'h1, h2, h3, h4, h5, h6 {',
        '  color: ' + p.text + ' !important;',
        '  font-family: inherit !important;',
        '  font-weight: 700 !important;',
        '}',
        'a { color: ' + p.slate + ' !important; }',
        'a:hover { color: ' + p.accent + ' !important; }',
        'code, pre, pre code {',
        '  font-family: "Menlo", "Monaco", "Courier New", monospace !important;',
        '  background: ' + p.panelAlt + ' !important;',
        '  color: ' + p.text + ' !important;',
        '  border-color: ' + p.border + ' !important;',
        '}',
        'button {',
        '  font-family: inherit !important;',
        '  background: transparent !important;',
        '  border: 1px solid ' + p.border + ' !important;',
        '  color: ' + p.text + ' !important;',
        '  box-shadow: none !important;',
        '}',
        'button:hover {',
        '  background: ' + p.panelAlt + ' !important;',
        '  border-color: ' + p.accent + ' !important;',
        '  color: ' + p.accent + ' !important;',
        '}',
        'input, textarea, select {',
        '  background: ' + p.panel + ' !important;',
        '  color: ' + p.text + ' !important;',
        '  border: 1px solid ' + p.border + ' !important;',
        '  font-family: inherit !important;',
        '}',
        'input:focus, textarea:focus, select:focus {',
        '  border-color: ' + p.accent + ' !important;',
        '  outline: none !important;',
        '}',
        'blockquote { border-left-color: ' + p.accent + ' !important; color: ' + p.textSoft + ' !important; }',
        '.bg-black, .bg-gray-900, .bg-neutral-900 { background: ' + p.panel + ' !important; }',
        '.bg-gray-800, .bg-neutral-800 { background: ' + p.panel + ' !important; }',
        '[class*="bg-[#1"],[class*="bg-[#0"],[class*="bg-[rgb(1"],[class*="bg-[rgb(0"] { background: ' + p.panel + ' !important; color: ' + p.text + ' !important; }',
        '[class*="text-[#1"],[class*="text-[#0"],[class*="text-white"] { color: ' + p.text + ' !important; }',
        '.text-white, .text-gray-100, .text-neutral-100 { color: ' + p.text + ' !important; }',
        '.text-gray-300, .text-gray-400, .text-neutral-300, .text-neutral-400 { color: ' + p.textSoft + ' !important; }',
        '.border-gray-700, .border-gray-800, .border-neutral-700, .border-neutral-800 { border-color: ' + p.border + ' !important; }',
        '.text-orange-500, .text-orange-400, .text-orange-600 { color: ' + p.accent + ' !important; }',
        '.text-green-500, .text-green-400 { color: ' + p.sage + ' !important; }',
        '.text-blue-500, .text-blue-400, .text-cyan-500 { color: ' + p.slate + ' !important; }',
        '.text-yellow-400, .text-yellow-500 { color: ' + p.gold + ' !important; }',
      ].join('\n');
    }

    function injectReadingModeCssIntoIframe(iframe, preset) {
      if (!iframe) return;
      try {
        var doc = iframe.contentDocument;
        if (!doc || !doc.head) return;
        // Always replace — preset may have changed
        var existing = doc.getElementById('iowa-reading-mode-overlay');
        if (existing) existing.remove();
        var style = doc.createElement('style');
        style.id = 'iowa-reading-mode-overlay';
        style.textContent = buildIframeCss(preset);
        doc.head.appendChild(style);
      } catch (e) {
        // Cross-origin iframe — can't inject. Expected for hood-iframe etc.
      }
    }

    function removeReadingModeCssFromIframe(iframe) {
      if (!iframe) return;
      try {
        var doc = iframe.contentDocument;
        if (!doc) return;
        var existing = doc.getElementById('iowa-reading-mode-overlay');
        if (existing) existing.remove();
      } catch (e) {}
    }

    function syncAllIframes(preset) {
      var iframes = document.querySelectorAll('iframe');
      iframes.forEach(function(iframe) {
        if (preset) injectReadingModeCssIntoIframe(iframe, preset);
        else removeReadingModeCssFromIframe(iframe);
        if (!iframe._iowaLoadHooked) {
          iframe._iowaLoadHooked = true;
          iframe.addEventListener('load', function() {
            var active = document.body.classList.contains('reading-mode')
              ? document.body.getAttribute('data-reading-preset')
              : null;
            if (active) injectReadingModeCssIntoIframe(iframe, active);
          });
        }
      });
    }

    function applyReadingMode(preset) {
      // preset is 'iowa' | 'gruvbox' | 'gruvbox-hard' | null (off)
      if (preset) {
        document.body.classList.add('reading-mode');
        document.body.setAttribute('data-reading-preset', preset);
        readingBtn.classList.add('active');
        readingBtn.title = 'Reading mode: ' + preset + ' (click to change)';
      } else {
        document.body.classList.remove('reading-mode');
        document.body.removeAttribute('data-reading-preset');
        readingBtn.classList.remove('active');
        readingBtn.title = 'Reading mode (click to change theme)';
      }
      syncAllIframes(preset);
      // Plumb the active theme to the collapsed-bar window (via main.js) so its
      // pill matches the current theme. Fires on startup restore and on every
      // live theme switch. null (off) → 'off' → the default video-game pill.
      try { window.presenter.setTheme(preset || 'off'); } catch {}
    }

    // Restore from localStorage on load.
    try {
      var saved = localStorage.getItem('presenter-reading-mode');
      if (saved === 'iowa' || saved === 'gruvbox' || saved === 'gruvbox-hard') {
        applyReadingMode(saved);
      } else {
        // Off (or unset): applyReadingMode isn't called above, so report the
        // resolved theme to the collapsed bar directly on startup.
        try { window.presenter.setTheme('off'); } catch {}
      }
    } catch {}

    // --- Theme picker popover ---
    // Replaces the prior off→iowa→gruvbox cycle. Four tiles with mini
    // color-swatch previews. Clicking a tile applies + closes. Click
    // outside or Esc closes without changing.
    var _themePickerEl = null;
    var _themePickerOutside = function(e) {
      if (_themePickerEl && !_themePickerEl.contains(e.target) && e.target !== readingBtn) {
        closeThemePicker();
      }
    };
    var _themePickerEsc = function(e) {
      if (e.key === 'Escape') closeThemePicker();
    };
    function closeThemePicker() {
      if (_themePickerEl && _themePickerEl.parentNode) {
        _themePickerEl.parentNode.removeChild(_themePickerEl);
      }
      _themePickerEl = null;
      document.removeEventListener('click', _themePickerOutside, true);
      document.removeEventListener('keydown', _themePickerEsc, true);
    }
    // Tiles in display order. Each swatches array renders a 3-color preview strip.
    var THEME_TILES = [
      {
        id: null,
        name: 'Off',
        subtitle: 'Video-game',
        swatches: ['#111111', '#FF6600', '#00FF66'],
      },
      {
        id: 'iowa',
        name: 'Iowa',
        subtitle: 'Warm cream',
        swatches: ['#F4EFE6', '#1A1815', '#7A5C3E'],
      },
      {
        id: 'gruvbox',
        name: 'Gruvbox',
        subtitle: 'Dark medium',
        swatches: ['#282828', '#EBDBB2', '#FE8019'],
      },
      {
        id: 'gruvbox-hard',
        name: 'Gruvbox Hard',
        subtitle: 'Near-black',
        swatches: ['#1D2021', '#FBF1C7', '#FE8019'],
      },
    ];
    function openThemePicker(anchorEl) {
      if (_themePickerEl) { closeThemePicker(); return; }
      var current = document.body.classList.contains('reading-mode')
        ? document.body.getAttribute('data-reading-preset')
        : null;
      var pop = document.createElement('div');
      pop.className = 'theme-picker-popover';
      var anchor = anchorEl || readingBtn;
      var rect = anchor.getBoundingClientRect();
      // Anchor below the button. Right-align when the anchor is near the
      // right edge (titlebar desktop case); left-align when the anchor is
      // in the sidebar (mobile case) so the popover doesn't clip offscreen.
      pop.style.top = (rect.bottom + 6) + 'px';
      if (rect.left < window.innerWidth / 2) {
        pop.style.left = rect.left + 'px';
      } else {
        pop.style.right = (window.innerWidth - rect.right) + 'px';
      }
      var header = document.createElement('div');
      header.className = 'theme-picker-header';
      header.textContent = 'Reading mode theme';
      pop.appendChild(header);
      var grid = document.createElement('div');
      grid.className = 'theme-picker-grid';
      THEME_TILES.forEach(function(tile) {
        var el = document.createElement('button');
        el.className = 'theme-tile' + (current === tile.id ? ' active' : '');
        el.type = 'button';
        el.innerHTML = '';
        var swStrip = document.createElement('div');
        swStrip.className = 'theme-tile-swatches';
        tile.swatches.forEach(function(hex) {
          var sw = document.createElement('span');
          sw.className = 'theme-tile-swatch';
          sw.style.background = hex;
          swStrip.appendChild(sw);
        });
        el.appendChild(swStrip);
        var name = document.createElement('div');
        name.className = 'theme-tile-name';
        name.textContent = tile.name;
        el.appendChild(name);
        var sub = document.createElement('div');
        sub.className = 'theme-tile-sub';
        sub.textContent = tile.subtitle;
        el.appendChild(sub);
        if (current === tile.id) {
          var chk = document.createElement('span');
          chk.className = 'theme-tile-check';
          chk.textContent = '✓';
          el.appendChild(chk);
        }
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          applyReadingMode(tile.id);
          try { localStorage.setItem('presenter-reading-mode', tile.id || 'off'); } catch {}
          closeThemePicker();
        });
        grid.appendChild(el);
      });
      pop.appendChild(grid);
      document.body.appendChild(pop);
      _themePickerEl = pop;
      // Defer so triggering click doesn't immediately close
      setTimeout(function() {
        document.addEventListener('click', _themePickerOutside, true);
        document.addEventListener('keydown', _themePickerEsc, true);
      }, 0);
    }

    readingBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      openThemePicker();
    });

    // Expose so sidebar inline-tiles (mobile) can apply without reopening
    window.openThemePicker = openThemePicker;
    window.applyReadingMode = applyReadingMode;
  }

  // --- Machine health pill + full-screen diagnostics sheet ---
  // Josh 2026-08-29: keep the REAL numbers ("I like the real numbers"), show
  // how much of the CPU is Claude vs the rest of the machine, and make tapping
  // it "overtake the whole screen ... a really in-depth, beautiful stat sheet"
  // that is easy to leave. Load becomes a gauge because the three raw numbers
  // meant nothing on their own.
  //
  // Data comes from /api/machine-stats, which samples instantaneous per-process
  // CPU (top's second sample) and attributes it BY PID — never by process name,
  // because Claude reports its version string as its command name.
  var cpuPillBtn = document.getElementById('ctrl-cpu-pill');
  if (cpuPillBtn) {
    var _ms = null;            // latest machine-stats payload
    var _msHistory = [];       // rolling samples for the charts
    var _msPollInterval = null;
    var _msOpen = false;

    function msNum(v, digits) {
      if (v == null || isNaN(v)) return '—';
      return (Math.round(v * Math.pow(10, digits || 0)) / Math.pow(10, digits || 0)).toString();
    }
    function msPct(v) { return v == null ? '—' : msNum(v, 1) + '%'; }

    // Human span between the first and last sample, so a chart always says what
    // window it covers. Josh: "your charts are hard to read because I don't know
    // what time frame it's over."
    function msSpanLabel(points) {
      if (!points || points.length < 2) return null;
      var ms = points[points.length - 1].t - points[0].t;
      var mins = Math.round(ms / 60000);
      if (mins < 1) return 'last ' + Math.max(1, Math.round(ms / 1000)) + ' seconds';
      if (mins < 60) return 'last ' + mins + ' minute' + (mins === 1 ? '' : 's');
      var hrs = ms / 3600000;
      return 'last ' + (hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)) + ' hours';
    }
    function msClockRange(points) {
      if (!points || points.length < 2) return null;
      function hhmm(t) {
        var d = new Date(t);
        var hr = d.getHours(), m = d.getMinutes();
        var ampm = hr >= 12 ? 'pm' : 'am';
        hr = hr % 12; if (hr === 0) hr = 12;
        return hr + ':' + (m < 10 ? '0' : '') + m + ampm;
      }
      return hhmm(points[0].t) + ' → ' + hhmm(points[points.length - 1].t);
    }
    function msGb(mb) {
      if (mb == null) return '—';
      return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
    }

    // Headline verdict.
    //
    // This used to do Math.max(cpuPct, clampedLoadPct), which silently compared
    // two DIFFERENT scales: CPU is a share of capacity (0-100) while load is a
    // queue depth that routinely runs past 100% of cores. A load of 26 on 8
    // cores clamped to 100 and pinned the word at "Slammed" while the number on
    // screen said 38% — Josh reasonably asked why. (Reported 2026-08-29.)
    //
    // Now each signal is graded on its OWN scale, the worst one decides the
    // word, and we return WHICH signal drove it so the screen can say so. A
    // verdict the reader can't trace back to a visible number is a bug.
    function msSeverity(s) {
      if (!s || s.cpu.total == null) {
        return { key: 'unknown', word: 'Checking…', cls: '', reason: null, rank: -1 };
      }

      // CPU: share of total capacity actually being used.
      var cpuPct = s.cpu.total;
      var cpuRank = cpuPct >= 85 ? 2 : cpuPct >= 55 ? 1 : 0;

      // Load: queue depth against cores. 1.0x means exactly saturated; work
      // only really piles up meaningfully past that.
      var cores = s.cores || 1;
      var loadX = s.load ? s.load.one / cores : 0;
      var loadRank = loadX >= 2 ? 2 : loadX >= 1 ? 1 : 0;

      var rank = Math.max(cpuRank, loadRank);
      var reason;
      if (rank === 0) {
        reason = 'plenty of headroom';
      } else if (cpuRank >= loadRank) {
        reason = 'processor at ' + msNum(cpuPct, 0) + '%';
      } else {
        reason = 'work queued ' + loadX.toFixed(1) + '\u00d7 deeper than the ' + cores + ' cores';
      }

      if (rank === 2) return { key: 'high', word: 'Slammed', cls: 'ms-bad', reason: reason, rank: rank };
      if (rank === 1) return { key: 'mid', word: 'Working', cls: 'ms-warn', reason: reason, rank: rank };
      return { key: 'low', word: 'Relaxed', cls: 'ms-good', reason: reason, rank: rank };
    }

    function renderCpuPill() {
      var cpuEl = document.getElementById('cpu-pill-cpu');
      var procsEl = document.getElementById('cpu-pill-procs');
      if (!_ms) {
        if (cpuEl) cpuEl.textContent = '—';
        if (procsEl) procsEl.textContent = '—';
        return;
      }
      // Real numbers on the pill, as asked: total CPU% and the session count.
      if (cpuEl) cpuEl.textContent = _ms.cpu.total == null ? '—' : Math.round(_ms.cpu.total) + '%';
      if (procsEl) procsEl.textContent = _ms.counts.claude + ' cc · ' + _ms.counts.mcp + ' mcp';
      var sev = msSeverity(_ms);
      cpuPillBtn.classList.remove('cpu-low', 'cpu-mid', 'cpu-high');
      if (sev.key === 'high') cpuPillBtn.classList.add('cpu-high');
      else if (sev.key === 'mid') cpuPillBtn.classList.add('cpu-mid');
      else if (sev.key === 'low') cpuPillBtn.classList.add('cpu-low');
      applyHealthClass();
    }

    // --- second signal on the same dot: "something is DOWN or MISSING" ---
    //
    // Josh 2026-09-11: "if it's just red throbbing then we know that it's just
    // the CPU is running hot, but otherwise it would just be nice to take
    // action and actually fix whatever's going on."
    //
    // So this is a SEPARATE class in a SEPARATE colour, never an overload of
    // cpu-high — if a busy machine and a broken thing looked the same, the dot
    // would be telling him less than it does today, which is the exact
    // confusion he asked us to remove.
    //
    // It also OUTRANKS the CPU colour: a machine that is merely busy has
    // nothing for him to do, while a down thing does. `applyHealthClass` runs
    // after the cpu-* classes are set on every render for that reason.
    var _health = null;         // latest /api/health-checks payload
    var _healthOpen = false;

    function healthDownChecks() {
      if (!_health || !_health.checks) return [];
      return _health.checks.filter(function (c) { return c.state === 'down'; });
    }

    function applyHealthClass() {
      var down = healthDownChecks().length > 0;
      cpuPillBtn.classList.toggle('health-down', down);
      cpuPillBtn.title = down
        ? 'Something is down \u2014 tap to see what'
        : 'Host CPU / process counts (click to expand)';
    }

    async function fetchHealthChecks() {
      try {
        var res = await fetch('/api/health-checks');
        if (res.ok) _health = await res.json();
      } catch (e) { /* leave last-known state up; never invent an alarm */ }
      // Share the payload with the engine panel rather than making it fetch
      // the same thing twice.
      if (window.__enginePanel && _health) window.__enginePanel.setHealth(_health);
      applyHealthClass();
      if (_healthOpen) renderHealthModal();
    }

    async function fetchMachineStats(withHistory) {
      try {
        var res = await fetch('/api/machine-stats' + (withHistory ? '' : '?history=0'));
        if (res.ok) {
          var j = await res.json();
          _ms = j;
          if (j.history) _msHistory = j.history;
        }
      } catch (e) { /* leave last-known values up */ }
      if (window.__enginePanel && _ms) window.__enginePanel.setStats(_ms);
      renderCpuPill();
      if (_msOpen) renderMachineSheet();
    }

    // ---- charts (hand-rolled SVG; no library, themed by currentColor) ----

    // Sparkline-style stacked area of CPU by category over time.
    function msAreaChart(points, w, h) {
      if (!points || points.length < 2) return null;
      var n = points.length;
      var maxV = 100;
      var stepX = w / (n - 1);
      function band(keyFns) {
        var top = [], bottom = [];
        for (var i = 0; i < n; i++) {
          var x = i * stepX;
          var lo = keyFns.lo(points[i]);
          var hi = keyFns.hi(points[i]);
          top.push(x.toFixed(1) + ',' + (h - (hi / maxV) * h).toFixed(1));
          bottom.push(x.toFixed(1) + ',' + (h - (lo / maxV) * h).toFixed(1));
        }
        return 'M' + top.join(' L') + ' L' + bottom.reverse().join(' L') + ' Z';
      }
      var c = function (p) { return p.c || 0; };
      var m = function (p) { return (p.c || 0) + (p.m || 0); };
      var o = function (p) { return (p.c || 0) + (p.m || 0) + (p.o || 0); };
      var svg = '<svg class="ms-chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" height="' + h + '">';
      svg += '<path d="' + band({ lo: function () { return 0; }, hi: c }) + '" fill="#d8a33a" opacity=".95"/>';
      svg += '<path d="' + band({ lo: c, hi: m }) + '" fill="#7fa8d8" opacity=".9"/>';
      svg += '<path d="' + band({ lo: m, hi: o }) + '" fill="#5c574d" opacity=".75"/>';
      svg += '</svg>';
      return svg;
    }

    // Simple line chart for a single series (used for sessions over time).
    function msLineChart(points, pick, w, h, color) {
      if (!points || points.length < 2) return null;
      var vals = points.map(pick);
      var max = Math.max.apply(null, vals);
      var min = Math.min.apply(null, vals);
      if (max === min) { max = min + 1; }
      var stepX = w / (points.length - 1);
      var d = vals.map(function (v, i) {
        var x = (i * stepX).toFixed(1);
        var y = (h - ((v - min) / (max - min)) * (h - 4) - 2).toFixed(1);
        return (i ? 'L' : 'M') + x + ',' + y;
      }).join(' ');
      return '<svg class="ms-chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" height="' + h + '">'
        + '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" '
        + 'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
    }

    // Radial gauge for load-vs-cores. 270° sweep, over-100% shows a red overrun.
    function msGauge(pctOfCores, cores, load1) {
      var size = 116, r = 46, cx = size / 2, cy = size / 2;
      var sweep = 270, start = 135;
      var frac = Math.max(0, Math.min(1, (pctOfCores || 0) / 100));
      var over = (pctOfCores || 0) > 100;
      function pt(angDeg, rad) {
        var a = (angDeg * Math.PI) / 180;
        return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
      }
      function arc(fromFrac, toFrac, rad) {
        var a0 = start + sweep * fromFrac, a1 = start + sweep * toFrac;
        var p0 = pt(a0, rad), p1 = pt(a1, rad);
        var large = (a1 - a0) > 180 ? 1 : 0;
        return 'M' + p0[0].toFixed(1) + ',' + p0[1].toFixed(1)
          + ' A' + rad + ',' + rad + ' 0 ' + large + ' 1 ' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1);
      }
      var col = over ? '#e0655a' : (frac > 0.7 ? '#e0a83a' : '#6fcf6f');
      var svg = '<svg class="ms-gauge" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">';
      svg += '<path d="' + arc(0, 1, r) + '" fill="none" stroke="#2c2a25" stroke-width="11" stroke-linecap="round"/>';
      svg += '<path d="' + arc(0, frac, r) + '" fill="none" stroke="' + col + '" stroke-width="11" stroke-linecap="round"/>';
      // Overrun ring: when load exceeds the core count the main arc is already
      // full, so draw a second, inner arc showing HOW FAR past full it is.
      // Without this a load of 9 and a load of 30 look identical.
      if (over) {
        var overFrac = Math.max(0, Math.min(1, ((pctOfCores - 100) / 100)));
        svg += '<path d="' + arc(0, 1, r - 13) + '" fill="none" stroke="rgba(224,101,90,.16)" stroke-width="5" stroke-linecap="round"/>';
        svg += '<path d="' + arc(0, overFrac, r - 13) + '" fill="none" stroke="#e0655a" stroke-width="5" stroke-linecap="round"/>';
      }
      svg += '<text x="' + cx + '" y="' + (cy - 1) + '" text-anchor="middle" font-size="25" font-weight="700" fill="currentColor">'
        + (load1 == null ? '—' : load1.toFixed(1)) + '</text>';
      svg += '<text x="' + cx + '" y="' + (cy + 17) + '" text-anchor="middle" font-size="11" fill="#8d8676">of ' + cores + '</text>';
      svg += '</svg>';
      return svg;
    }

    function renderMachineSheet() {
      var body = document.getElementById('machine-sheet-body');
      var verdictEl = document.getElementById('machine-sheet-verdict');
      if (!body) return;

      if (!_ms) {
        body.innerHTML = '<div class="ms-chart-empty">Reading the machine…</div>';
        return;
      }
      var s = _ms;
      var sev = msSeverity(s);
      if (verdictEl) {
        verdictEl.textContent = sev.word;
        verdictEl.className = sev.cls;
      }
      // Say WHY, right under the word. The verdict must always trace back to a
      // number that is visible on this screen.
      var subEl = document.getElementById('machine-sheet-sub');
      if (subEl) subEl.textContent = sev.reason || 'machine diagnostics';

      var cores = s.cores;
      var cpu = s.cpu;
      var mem = s.memory;
      var h = '';

      // Counts first and big. Josh asked to keep these prominent — they were the
      // numbers he actually watched, and burying them in a legend lost them.
      h += '<div class="ms-grid">';
      h += '<div class="ms-card"><div class="ms-card-label">Claude Code</div>'
        + '<div class="ms-tile-val">' + s.counts.claude + '</div>'
        + '<div class="ms-tile-sub">sessions running · ' + msGb(mem.claudeMb) + ' held</div></div>';
      h += '<div class="ms-card"><div class="ms-card-label">MCP helpers</div>'
        + '<div class="ms-tile-val">' + s.counts.mcp + '</div>'
        + '<div class="ms-tile-sub">helpers running · ' + msGb(mem.mcpMb) + ' held</div></div>';
      h += '</div>';

      // ---- CPU: the headline plus who is actually using it ----
      var idle = cpu.total == null ? 0 : Math.max(0, 100 - cpu.total);
      h += '<div class="ms-card">';
      h += '<div class="ms-card-label">Processor · all ' + cores + ' cores</div>';
      h += '<div class="ms-headline"><span class="ms-big ' + sev.cls + '">' + msPct(cpu.total) + '</span>'
        + '<span class="ms-unit">busy right now</span></div>';
      // The bar spans the WHOLE machine (100% = all cores fully busy), so the
      // empty tail is genuine headroom rather than unaccounted work. A tiny but
      // non-zero slice still gets a hairline so it doesn't vanish entirely.
      function seg(cls, val) {
        if (val == null || val <= 0) return '';
        return '<div class="ms-bar-seg ' + cls + '" style="width:' + Math.max(val, 0.6) + '%"></div>';
      }
      h += '<div class="ms-bar">';
      h += seg('ms-seg-claude', cpu.claude);
      h += seg('ms-seg-mcp', cpu.mcp);
      h += seg('ms-seg-other', cpu.other);
      h += '<div class="ms-bar-seg ms-seg-idle" style="width:' + idle + '%"></div>';
      h += '</div>';
      h += '<div class="ms-caption" style="margin-top:0">Full width = all ' + cores
        + ' cores maxed. Empty space on the right is headroom.</div>';
      h += '<div class="ms-legend">';
      h += '<div class="ms-leg-row"><span class="ms-dot" style="background:#d8a33a"></span>'
        + '<span class="ms-leg-name">Claude Code sessions<span class="ms-leg-sub">' + s.counts.claude + ' running</span></span>'
        + '<span class="ms-leg-val">' + msPct(cpu.claude) + '</span></div>';
      h += '<div class="ms-leg-row"><span class="ms-dot" style="background:#7fa8d8"></span>'
        + '<span class="ms-leg-name">MCP helpers<span class="ms-leg-sub">' + s.counts.mcp + ' running</span></span>'
        + '<span class="ms-leg-val">' + msPct(cpu.mcp) + '</span></div>';
      h += '<div class="ms-leg-row"><span class="ms-dot" style="background:#5c574d"></span>'
        + '<span class="ms-leg-name">Everything else<span class="ms-leg-sub">Chrome, system, apps</span></span>'
        + '<span class="ms-leg-val">' + msPct(cpu.other) + '</span></div>';
      h += '</div>';
      if (cpu.claudeShareOfBusy != null) {
        h += '<div class="ms-caption">Claude Code is ' + msNum(cpu.claudeShareOfBusy, 1)
          + '% of everything the processor is doing.</div>';
      }
      h += '</div>';

      // ---- CPU over time ----
      var area = msAreaChart(_msHistory, 320, 74);
      var span = msSpanLabel(_msHistory);
      var clock = msClockRange(_msHistory);
      h += '<div class="ms-card">';
      h += '<div class="ms-card-label">Processor over time'
        + (span ? '<span class="ms-span"> · ' + span + '</span>' : '') + '</div>';
      if (area) {
        // Y-axis top label so the height is readable, then the chart, then the
        // actual clock times under each end.
        // Axis stays pinned 0-100% on purpose: auto-scaling would make a calm
        // machine look identical to a hammered one. Peak is called out in words
        // instead, so a low-but-spiky window is still readable.
        var peak = Math.max.apply(null, _msHistory.map(function (p) { return p.tot || 0; }));
        h += '<div class="ms-axis-y"><span>100% (all ' + cores + ' cores)</span>'
          + '<span>peak ' + msNum(peak, 1) + '%</span></div>';
        h += '<div class="ms-chart-wrap">' + area + '</div>';
        h += '<div class="ms-axis-x"><span>' + (clock ? clock.split(' \u2192 ')[0] : '') + '</span>'
          + '<span>now</span></div>';
        h += '<div class="ms-caption">Gold is Claude Code, blue is helpers, grey is everything else · '
          + _msHistory.length + ' samples, one every 10 seconds.</div>';
      } else {
        h += '<div class="ms-chart-empty">Collecting history — the chart fills in as samples arrive '
          + '(one every 10 seconds).</div>';
      }
      h += '</div>';

      // ---- load gauge + memory ----
      h += '<div class="ms-card">';
      h += '<div class="ms-card-label">Load — how deep the queue is</div>';
      h += '<div class="ms-gauge-wrap">';
      h += msGauge(s.load.pctOfCores, cores, s.load.one);
      h += '<div class="ms-gauge-meta">';
      var overBy = s.load.one > cores ? (s.load.one / cores) : null;
      h += '<div class="ms-tile-sub" style="margin-top:0">Jobs waiting on ' + cores + ' cores. '
        + 'Under ' + cores + ' means nothing is queuing; above it, work is stacking up.'
        + (overBy ? ' <span class="ms-bad">Currently ' + overBy.toFixed(1) + '\u00d7 oversubscribed.</span>' : '')
        + '</div>';
      h += '<div class="ms-row" style="margin-top:9px"><span class="ms-row-label">1 min</span>'
        + '<span class="ms-row-val">' + msNum(s.load.one, 2) + '</span></div>';
      h += '<div class="ms-row"><span class="ms-row-label">5 min</span>'
        + '<span class="ms-row-val">' + msNum(s.load.five, 2) + '</span></div>';
      h += '<div class="ms-row"><span class="ms-row-label">15 min</span>'
        + '<span class="ms-row-val">' + msNum(s.load.fifteen, 2) + '</span></div>';
      h += '</div></div></div>';

      // ---- memory: the honest pair ----
      var freeCls = mem.freePct == null ? '' : (mem.freePct < 15 ? 'ms-bad' : mem.freePct < 30 ? 'ms-warn' : 'ms-good');
      var swapPct = (mem.swapUsedMb != null && mem.swapTotalMb) ? (mem.swapUsedMb / mem.swapTotalMb) * 100 : null;
      var swapCls = swapPct == null ? '' : (swapPct > 70 ? 'ms-bad' : swapPct > 35 ? 'ms-warn' : 'ms-good');
      h += '<div class="ms-grid">';
      h += '<div class="ms-card"><div class="ms-card-label">Memory free</div>'
        + '<div class="ms-tile-val ' + freeCls + '">' + (mem.freePct == null ? '—' : mem.freePct + '%') + '</div>'
        + '<div class="ms-tile-sub">Of ' + msGb(mem.totalMb) + ' total. This is the real availability figure, '
        + 'not "used" — most used memory is scratch the machine drops instantly.</div></div>';
      h += '<div class="ms-card"><div class="ms-card-label">Swap in use</div>'
        + '<div class="ms-tile-val ' + swapCls + '">' + msGb(mem.swapUsedMb) + '</div>'
        + '<div class="ms-tile-sub">Of ' + msGb(mem.swapTotalMb) + '. Memory spilled to disk — this is what '
        + 'actually makes the machine feel slow.</div></div>';
      h += '</div>';

      // ---- sessions over time ----
      var sessVals = _msHistory.map(function (p) { return p.sessions || 0; });
      var sessLine = msLineChart(_msHistory, function (p) { return p.sessions || 0; }, 320, 54, '#d8a33a');
      h += '<div class="ms-card">';
      h += '<div class="ms-card-label">Claude Code sessions over time'
        + (span ? '<span class="ms-span"> · ' + span + '</span>' : '') + '</div>';
      if (sessLine) {
        var sMax = Math.max.apply(null, sessVals);
        var sMin = Math.min.apply(null, sessVals);
        h += '<div class="ms-axis-y"><span>' + sMax + '</span><span>' + sMin + '</span></div>';
        h += '<div class="ms-chart-wrap">' + sessLine + '</div>';
        h += '<div class="ms-axis-x"><span>' + (clock ? clock.split(' \u2192 ')[0] : '') + '</span>'
          + '<span>now</span></div>';
        h += '<div class="ms-caption">Ranged ' + sMin + '\u2013' + sMax + ' over this window · now '
          + s.counts.claude + '.</div>';
      } else {
        h += '<div class="ms-chart-empty">Collecting history.</div>';
      }
      h += '</div>';

      // ---- memory by category ----
      h += '<div class="ms-card">';
      h += '<div class="ms-card-label">Memory held</div>';
      h += '<div class="ms-row"><span class="ms-row-label">Claude Code sessions</span>'
        + '<span class="ms-row-val">' + msGb(mem.claudeMb) + '</span></div>';
      h += '<div class="ms-row"><span class="ms-row-label">MCP helpers</span>'
        + '<span class="ms-row-val">' + msGb(mem.mcpMb) + '</span></div>';
      h += '<div class="ms-row"><span class="ms-row-label">Installed</span>'
        + '<span class="ms-row-val">' + msGb(mem.totalMb) + '</span></div>';
      h += '</div>';

      h += '<div class="ms-foot">Updates every 10 seconds · sampled live from the machine</div>';

      body.innerHTML = h;
    }

    function openMachineSheet() {
      var sheet = document.getElementById('machine-sheet');
      if (!sheet) return;
      sheet.classList.add('open');
      sheet.setAttribute('aria-hidden', 'false');
      _msOpen = true;
      renderMachineSheet();
      fetchMachineStats(true);
      document.addEventListener('keydown', _msEsc, true);
    }
    function closeMachineSheet() {
      var sheet = document.getElementById('machine-sheet');
      if (!sheet) return;
      sheet.classList.remove('open');
      sheet.setAttribute('aria-hidden', 'true');
      _msOpen = false;
      document.removeEventListener('keydown', _msEsc, true);
    }
    var _msEsc = function (e) { if (e.key === 'Escape') closeMachineSheet(); };

    var msCloseBtn = document.getElementById('machine-sheet-close');
    if (msCloseBtn) {
      msCloseBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeMachineSheet();
      });
    }
    // ---- the "something is down" modal ----
    //
    // Small on purpose. The full-screen stat sheet is the right shape for
    // browsing numbers; this is the right shape for "yep this is down, here is
    // the button." Anything it claims is broken must also SHOW the observed
    // fact behind that claim (.hm-evidence) — same rule msSeverity lives under.
    // `_healthFocus` is a single check id when the reader arrived by tapping
    // ONE lamp on the engine panel (Josh: "each one has its own flow instead
    // of this two-dot system"). Null = the old shared list, still used by any
    // caller that doesn't name a check.
    var _healthFocus = null;

    function renderHealthModal() {
      var body = document.getElementById('health-modal-body');
      var titleEl = document.getElementById('health-modal-title');
      if (!body) return;

      // Focused flow: show THIS instrument's check, whatever its state, so a
      // lamp always explains itself when tapped — including the calm answer
      // "this one is fine" and the honest answer "I can't tell right now".
      var focused = null;
      if (_healthFocus && _health && _health.checks) {
        focused = _health.checks.filter(function (c) { return c.id === _healthFocus; })[0] || null;
      }

      if (focused) {
        if (titleEl) titleEl.textContent = focused.title;
        body.innerHTML = healthItemHtml(focused, { omitTitle: true });
        wireHealthFixes(body);
        return;
      }

      if (titleEl) titleEl.textContent = 'Something needs you';
      var down = healthDownChecks();

      if (!down.length) {
        body.innerHTML = '<div class="hm-empty">Everything is answering '
          + 'normally right now.</div>';
        return;
      }

      var h = '';
      down.forEach(function (c) {
        h += healthItemHtml(c);
      });
      body.innerHTML = h;
      wireHealthFixes(body);
    }

    // The engraved status plate that opens every check.
    //
    // Josh 2026-09-15: "when i click it again it's still on it still looks on
    // this as your phone is reachable for debugging so it doesn't — i don't
    // know, the on off state is hard for me to read."
    //
    // He was reading a PARAGRAPH to answer a yes/no question. The state was
    // only ever carried in prose ("Your phone is reachable for debugging"),
    // which is a sentence you have to parse before you know which way it
    // points — and the two outcomes read very similarly at a glance. The plate
    // answers it before he reads anything: one word, big, in its own colour,
    // with the sentence demoted underneath as the explanation rather than the
    // finding.
    function healthPlate(c) {
      var key = c.state === 'down' ? 'off' : c.state === 'unknown' ? 'unknown' : 'on';
      var word = key === 'off' ? 'OFF' : key === 'unknown' ? 'UNKNOWN' : 'ON';
      var sub = key === 'off' ? 'not working right now'
              : key === 'unknown' ? "can't tell from here"
              : 'working normally';
      return '<div class="hm-plate is-' + key + '">'
        + '<span class="hm-plate-word">' + word + '</span>'
        + '<span class="hm-plate-sub">' + esc(sub) + '</span>'
        + '</div>';
    }

    // One check's markup. Anything it claims is broken must also SHOW the
    // observed fact behind that claim (.hm-evidence) — the same rule
    // msSeverity lives under.
    //
    // The fix button appears ONLY for a check that is actually down. Offering
    // "Open Settings on my phone" next to a green ON plate invites Josh to go
    // fix something that isn't broken, and a panel that sends you on errands
    // when nothing is wrong is how a panel stops being trusted.
    function healthItemHtml(c, opts) {
      var h = '<div class="hm-item" data-check="' + esc(c.id) + '">';
      if (!(opts && opts.omitTitle)) h += '<div class="hm-what">' + esc(c.title) + '</div>';
      h += healthPlate(c);
      h += '<div class="hm-why">' + esc(c.summary || '') + '</div>';
      if (c.detail) h += '<div class="hm-evidence">' + esc(c.detail) + '</div>';
      if (c.fix && c.state === 'down') {
        h += '<button class="hm-fix" data-fix="' + esc(c.id) + '">'
          + esc(c.fix.label) + '</button>';
        if (c.fix.hint) h += '<div class="hm-hint">' + esc(c.fix.hint) + '</div>';
      }
      h += '<div class="hm-result" data-result="' + esc(c.id) + '"></div>';
      h += '</div>';
      return h;
    }

    function wireHealthFixes(scope) {
      Array.prototype.forEach.call(scope.querySelectorAll('.hm-fix'), function (btn) {
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          runHealthFix(btn.getAttribute('data-fix'), btn);
        });
      });
    }

    // Minimal escaper — check text is server-authored, but it is rendered as
    // HTML, so it gets escaped on principle rather than on trust.
    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function runHealthFix(id, btn) {
      var out = document.querySelector('[data-result="' + id + '"]');
      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = 'Opening\u2026';
      if (out) { out.className = 'hm-result'; out.textContent = ''; }
      try {
        var res = await fetch('/api/health-checks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id })
        });
        var j = await res.json();
        if (out) {
          out.className = 'hm-result ' + (j.success ? 'ok' : 'err');
          out.textContent = j.success
            ? 'Opened on your phone \u2014 have a look at it now.'
            : (j.error || 'That did not work.');
        }
      } catch (e) {
        if (out) { out.className = 'hm-result err'; out.textContent = 'That did not work.'; }
      }
      btn.disabled = false;
      btn.textContent = original;
    }

    function openHealthModal(focusId) {
      var m = document.getElementById('health-modal');
      if (!m) return;
      _healthFocus = focusId || null;
      m.classList.add('open');
      m.setAttribute('aria-hidden', 'false');
      _healthOpen = true;
      renderHealthModal();
      fetchHealthChecks();
      document.addEventListener('keydown', _healthEsc, true);
    }
    function closeHealthModal() {
      var m = document.getElementById('health-modal');
      if (!m) return;
      m.classList.remove('open');
      m.setAttribute('aria-hidden', 'true');
      _healthOpen = false;
      _healthFocus = null;
      document.removeEventListener('keydown', _healthEsc, true);
    }
    var _healthEsc = function (e) { if (e.key === 'Escape') closeHealthModal(); };

    var healthCloseBtn = document.getElementById('health-modal-close');
    if (healthCloseBtn) {
      healthCloseBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeHealthModal();
      });
    }
    // Tapping the dimmed backdrop closes too — on a phone that is the reflex.
    var healthOverlay = document.getElementById('health-modal');
    if (healthOverlay) {
      healthOverlay.addEventListener('click', function (e) {
        if (e.target === healthOverlay) closeHealthModal();
      });
    }

    // The engine dashboard in the steward row owns the TAPS now — the gauge
    // opens the stat sheet, each lamp opens its own check. That replaces the
    // old single dot whose one tap had to GUESS which of two meanings the
    // reader was after (Josh: "each one has its own flow instead of this
    // two-dot system, it's kinda dorky"). These sheets are unchanged; only
    // who addresses them moved.
    window.__openMachineSheet = function () {
      if (_msOpen) closeMachineSheet(); else openMachineSheet();
    };
    window.__openHealthModal = function (focusId) {
      if (_healthOpen) closeHealthModal(); else openHealthModal(focusId);
    };

    // The desktop pill still works as a pill (it shows real numbers and Josh
    // uses it there). On the phone it is hidden outright — see index.html —
    // because the engine panel is the phone readout now.
    cpuPillBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (healthDownChecks().length) {
        if (_healthOpen) closeHealthModal(); else openHealthModal();
        return;
      }
      if (_msOpen) closeMachineSheet(); else openMachineSheet();
    });

    // Kick off polling. History only comes down when the sheet is open, so the
    // background poll stays light.
    fetchMachineStats(false);
    _msPollInterval = setInterval(function () { fetchMachineStats(_msOpen); }, 10000);

    // Health checks shell out to the network and are cached server-side ~20s,
    // so they poll on their own, slower cadence than the CPU sampler.
    fetchHealthChecks();
    setInterval(fetchHealthChecks, 30000);
  }

  // --- Fullscreen toggle (⛶ button + Cmd+Ctrl+F hotkey) ---
  // Uses Electron's setSimpleFullScreen so the presenter doesn't get
  // shoved into its own macOS Space. Tick (`) hide/show + Option-P duck
  // still work because they operate on window level, not fullscreen state.
  var fullscreenBtn = document.getElementById('ctrl-fullscreen');
  if (fullscreenBtn) {
    function setFullscreenButtonState(on) {
      if (on) {
        fullscreenBtn.classList.add('active');
        fullscreenBtn.title = 'Exit fullscreen (Cmd+Ctrl+F)';
      } else {
        fullscreenBtn.classList.remove('active');
        fullscreenBtn.title = 'Toggle fullscreen (Cmd+Ctrl+F)';
      }
    }
    // Restore button visual state from actual window state on boot
    if (window.presenter && window.presenter.getFullscreenState) {
      window.presenter.getFullscreenState().then(function(isFs) {
        setFullscreenButtonState(!!isFs);
      });
    }
    // Sync when main process reports a change
    if (window.presenter && window.presenter.onFullscreenUpdate) {
      window.presenter.onFullscreenUpdate(function(data) {
        setFullscreenButtonState(!!(data && data.fullscreen));
      });
    }
    function toggleFullscreen() {
      if (window.presenter && window.presenter.toggleFullscreen) {
        window.presenter.toggleFullscreen();
      }
    }
    fullscreenBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleFullscreen();
    });
    // Cmd+Ctrl+F hotkey (local — global registration is the tick key + Option-P)
    document.addEventListener('keydown', function(e) {
      if (e.metaKey && e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        toggleFullscreen();
      }
    });
  }

  // === History Viewer ===
  // Cross-steward archive search. Distinct from the Q (walkie-talkie queue)
  // panel — this surfaces past presenter cards across every steward archive
  // file in /data/presenter-history/.
  (function initHistoryViewer() {
    const hvPanel = document.getElementById('history-viewer-panel');
    const hvSearch = document.getElementById('hv-search');
    const hvStewardFilter = document.getElementById('hv-steward-filter');
    const hvList = document.getElementById('hv-list');
    const hvClose = document.getElementById('hv-close');
    const hvCount = document.getElementById('hv-count');
    if (!hvPanel || !hvList || !hvSearch) return;

    const SERVER_URL = window.location.origin || 'http://localhost:3005';
    const HV_PAGE = 10;
    let hvOpen = false;
    let hvDebounce = null;
    let hvExpandedKey = null; // session_id::id of expanded result
    let hvRequestId = 0; // race-cancel old fetches
    // Joshua's iter-1 brief: open default = active steward, last 10. Toggle to
    // "See all stewards" drops the steward filter. "See more" pages by HV_PAGE.
    // Both reset to defaults every time the surface is opened.
    let hvFilterMine = true;
    let hvLimit = HV_PAGE;
    // Build a "See all" / "Only [steward]" toggle and a "See more" button on
    // demand — they live alongside the search field in the subheader / list.
    let hvToggleBtn = null;
    let hvMoreBtn = null;

    function shortSession(sid) {
      return sessionDisplayName(sid);
    }

    function timeAgoLong(ts) {
      if (!ts) return '';
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      const days = Math.floor(hours / 24);
      if (days < 30) return days + 'd ago';
      const months = Math.floor(days / 30);
      if (months < 12) return months + 'mo ago';
      return Math.floor(months / 12) + 'y ago';
    }

    function escapeHtml(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function highlightMatches(text, needle) {
      const safe = escapeHtml(text || '');
      if (!needle) return safe;
      const n = needle.trim();
      if (!n) return safe;
      const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return safe.replace(re, function(m) { return '<span class="hv-mark">' + m + '</span>'; });
    }

    async function loadStewardOptions() {
      try {
        const res = await fetch(SERVER_URL + '/api/presenter/history-stewards');
        if (!res.ok) return;
        const stewards = await res.json();
        const current = hvStewardFilter.value;
        // Preserve "All stewards" option, replace the rest
        hvStewardFilter.innerHTML = '<option value="">All stewards (' + stewards.length + ')</option>';
        stewards.forEach(function(s) {
          const opt = document.createElement('option');
          opt.value = s.session_id;
          opt.textContent = shortSession(s.session_id) + ' (' + s.count + ')';
          hvStewardFilter.appendChild(opt);
        });
        if (current) hvStewardFilter.value = current;
      } catch {}
    }

    function activeStewardId() {
      // Use the global selectedSteward (declared in module scope) so the
      // History surface filters to whichever steward Joshua has open.
      try { return (typeof selectedSteward === 'string') ? selectedSteward : ''; } catch { return ''; }
    }

    function updateToggleLabel() {
      if (!hvToggleBtn) return;
      const sid = activeStewardId();
      const name = sid ? shortSession(sid) : '';
      if (hvFilterMine && sid) {
        hvToggleBtn.textContent = 'See all stewards';
        hvToggleBtn.title = 'Currently filtered to ' + name + ' — tap to show every steward';
      } else if (!hvFilterMine && sid) {
        hvToggleBtn.textContent = 'Only ' + name;
        hvToggleBtn.title = 'Currently showing every steward — tap to filter back to ' + name;
      } else {
        // No active steward selected — toggle is meaningless. Hide it.
        hvToggleBtn.textContent = 'All stewards';
        hvToggleBtn.title = 'No active steward selected';
      }
    }

    async function runSearch() {
      const myReq = ++hvRequestId;
      const q = hvSearch.value.trim();
      // Steward filter source-of-truth:
      //   1. If hvFilterMine is true AND there's an active steward → exact match on it.
      //   2. Else if hvFilterMine is false AND the dropdown has a value → use that
      //      (substring match, preserves the legacy "filter via dropdown" path).
      //   3. Else → no filter (every steward).
      const activeSid = activeStewardId();
      const useMine = hvFilterMine && !!activeSid;
      const dropdownVal = hvStewardFilter ? hvStewardFilter.value : '';
      const stewardParam = useMine ? activeSid : (dropdownVal || '');
      const stewardExactParam = useMine ? '1' : '';
      // Reflect the toggle state in the dropdown's enabled/value so legacy
      // change-handlers don't fight us.
      if (hvStewardFilter) hvStewardFilter.style.display = useMine ? 'none' : '';
      updateToggleLabel();
      hvList.innerHTML = '<div class="hv-loading">Searching…</div>';
      try {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (stewardParam) params.set('steward', stewardParam);
        if (stewardExactParam) params.set('stewardExact', stewardExactParam);
        params.set('limit', String(hvLimit));
        const res = await fetch(SERVER_URL + '/api/presenter/history-search?' + params.toString());
        if (myReq !== hvRequestId) return; // newer search in flight
        if (!res.ok) {
          hvList.innerHTML = '<div class="hv-empty">Search failed.</div>';
          return;
        }
        const data = await res.json();
        const results = (data && data.results) || [];
        if (hvCount) {
          const scopeLabel = useMine ? (' for ' + shortSession(activeSid)) : (stewardParam ? (' for ' + shortSession(stewardParam)) : '');
          hvCount.textContent = results.length + ' result' + (results.length === 1 ? '' : 's') + scopeLabel;
        }
        if (results.length === 0) {
          hvList.innerHTML = '<div class="hv-empty">' + (q || stewardParam ? 'No matches.' : 'No history yet.') + '</div>';
          return;
        }
        hvList.innerHTML = '';
        results.forEach(function(item) {
          const key = (item._session_id || '') + '::' + (item.id || '');
          const row = document.createElement('div');
          row.className = 'hv-item' + (hvExpandedKey === key ? ' expanded' : '');
          row.dataset.key = key;

          const ts = item.resolved_at || item.timestamp;
          const state = item.feedback && item.feedback.dismissed ? 'dismissed' : 'responded';
          const stateLabel = state === 'dismissed' ? 'dismissed' : 'responded';
          const title = item.title || '(untitled)';
          const snippet = item.message || '';

          const row1 = document.createElement('div');
          row1.className = 'hv-row1';
          row1.innerHTML =
            '<span class="hv-steward">' + escapeHtml(shortSession(item._session_id)) + '</span>' +
            '<span class="hv-state ' + state + '">' + stateLabel + '</span>' +
            '<span class="hv-when">' + escapeHtml(timeAgoLong(ts)) + '</span>';
          row.appendChild(row1);

          const titleEl = document.createElement('div');
          titleEl.className = 'hv-title';
          titleEl.innerHTML = highlightMatches(title, q);
          row.appendChild(titleEl);

          if (snippet) {
            const snipEl = document.createElement('div');
            snipEl.className = 'hv-snippet';
            // Snippet: trim to ~140 chars near match if any
            let s = snippet.replace(/\s+/g, ' ');
            if (q) {
              const lo = s.toLowerCase().indexOf(q.toLowerCase());
              if (lo > 60) s = '…' + s.slice(lo - 40);
            }
            if (s.length > 160) s = s.slice(0, 160) + '…';
            snipEl.innerHTML = highlightMatches(s, q);
            row.appendChild(snipEl);
          }

          if (hvExpandedKey === key) {
            row.appendChild(buildDetail(item, q));
          }

          row.addEventListener('click', function(e) {
            // Don't toggle if user is selecting text inside the detail block
            if (e.target.closest('.hv-detail')) return;
            hvExpandedKey = (hvExpandedKey === key) ? null : key;
            renderListFromCache();
          });

          hvList.appendChild(row);
        });
        // "See more" — appears when the page is full (results.length === hvLimit).
        // Server may or may not have more behind it; Joshua sees it disappear
        // naturally when he hits the end (next page returns < limit).
        if (results.length >= hvLimit) {
          const more = document.createElement('button');
          more.className = 'hv-more-btn';
          more.type = 'button';
          more.textContent = 'See more';
          more.addEventListener('click', function() {
            hvLimit += HV_PAGE;
            runSearch();
          });
          hvList.appendChild(more);
        }
      } catch {
        if (myReq !== hvRequestId) return;
        hvList.innerHTML = '<div class="hv-empty">Search error.</div>';
      }
    }

    // Re-render from current DOM state without re-fetching (used after expand toggle).
    // Cheaper would be to keep results in memory; current scale (≤300) makes a
    // re-fetch fine, but skip it on expand-only by keeping last results.
    let hvLastResults = [];
    let hvLastQuery = '';
    function renderListFromCache() {
      // Easiest: re-run search. Search is already debounced & cancellable.
      runSearch();
    }

    function buildDetail(item, q) {
      const wrap = document.createElement('div');
      wrap.className = 'hv-detail';

      const sessionLine = document.createElement('div');
      sessionLine.className = 'hv-detail-label';
      sessionLine.textContent = 'STEWARD';
      wrap.appendChild(sessionLine);
      const sessionVal = document.createElement('div');
      sessionVal.textContent = item._session_id || '?';
      wrap.appendChild(sessionVal);

      const titleLabel = document.createElement('div');
      titleLabel.className = 'hv-detail-label';
      titleLabel.textContent = 'TITLE';
      wrap.appendChild(titleLabel);
      const titleVal = document.createElement('div');
      titleVal.innerHTML = highlightMatches(item.title || '(untitled)', q);
      wrap.appendChild(titleVal);

      if (item.message) {
        const msgLabel = document.createElement('div');
        msgLabel.className = 'hv-detail-label';
        msgLabel.textContent = 'MESSAGE';
        wrap.appendChild(msgLabel);
        const msgVal = document.createElement('div');
        msgVal.innerHTML = highlightMatches(item.message, q);
        wrap.appendChild(msgVal);
      }

      const fb = item.feedback;
      if (fb) {
        const fbLabel = document.createElement('div');
        fbLabel.className = 'hv-detail-label';
        fbLabel.textContent = fb.dismissed ? 'DISMISSED' : 'JOSHUA RESPONDED';
        wrap.appendChild(fbLabel);
        const fbBlock = document.createElement('div');
        fbBlock.className = 'hv-feedback';
        let txt = '';
        if (fb.button) txt += '[' + fb.button + '] ';
        if (fb.text) txt += fb.text;
        if (!txt) txt = fb.dismissed ? '(swiped away without reply)' : '(no reply text)';
        fbBlock.innerHTML = highlightMatches(txt, q);
        wrap.appendChild(fbBlock);
      }

      const tsLabel = document.createElement('div');
      tsLabel.className = 'hv-detail-label';
      tsLabel.textContent = 'WHEN';
      wrap.appendChild(tsLabel);
      const tsVal = document.createElement('div');
      const ts = item.resolved_at || item.timestamp;
      tsVal.textContent = ts ? new Date(ts).toLocaleString() + '  (' + timeAgoLong(ts) + ')' : '?';
      wrap.appendChild(tsVal);

      return wrap;
    }

    function ensureToggleBtn() {
      if (hvToggleBtn) return;
      const subheader = document.getElementById('hv-subheader');
      if (!subheader) return;
      hvToggleBtn = document.createElement('button');
      hvToggleBtn.id = 'hv-scope-toggle';
      hvToggleBtn.type = 'button';
      hvToggleBtn.className = 'hv-scope-toggle';
      hvToggleBtn.addEventListener('click', function() {
        hvFilterMine = !hvFilterMine;
        hvLimit = HV_PAGE; // reset paging when scope flips
        runSearch();
      });
      // Place toggle BEFORE the steward dropdown so it leads visually.
      subheader.insertBefore(hvToggleBtn, subheader.firstChild);
    }

    function dockHVForEmbedded() {
      if (!document.body.classList.contains('embedded')) return;
      const toolbar = document.getElementById('bottom-toolbar');
      hvPanel.classList.add('docked-above-toolbar');
      if (toolbar) {
        // Anchor so the popover's bottom edge sits flush with the toolbar
        // button row's top edge. The composer is `position: fixed` at
        // viewport-bottom and lives below the toolbar in screen coords, so
        // measuring from viewport-bottom to the toolbar's top gives the
        // exact `bottom` distance we need (covers both composer height and
        // any padding gap automatically).
        const tbTop = toolbar.getBoundingClientRect().top;
        const distance = Math.max(0, window.innerHeight - tbTop);
        hvPanel.style.bottom = distance + 'px';
      }
    }
    function undockHV() {
      hvPanel.classList.remove('docked-above-toolbar');
      hvPanel.style.bottom = '';
    }
    // Tap-outside-to-close (Joshua 2026-07-14): closes through closeHV() so
    // the __historyOpen flag + engaged-button paint stay coherent across the
    // ~5s toolbar rebuilds. The toolbar History button is a fresh DOM node
    // each rebuild, so we resolve it by selector at event time. Deferred
    // capture-phase listener; one-tick defer avoids the opening click.
    function _hvOutsideClick(e) {
      if (hvPanel.contains(e.target)) return;
      const hb = document.querySelector('#bottom-toolbar .toolbar-history');
      if (hb && hb.contains(e.target)) return;
      closeHV();
    }
    function openHV() {
      hvOpen = true;
      window.__historyOpen = true;
      document.removeEventListener('click', _hvOutsideClick, true);
      setTimeout(() => document.addEventListener('click', _hvOutsideClick, true), 0);
      // Engaged-state on the toolbar History button (Joshua 2026-05-20
      // iteration): toolbar rebuilds also read window.__historyOpen so
      // the class re-applies on poll-driven re-renders.
      const hb = document.querySelector('#bottom-toolbar .toolbar-history');
      if (hb) hb.classList.add('is-engaged');
      dockHVForEmbedded();
      hvPanel.style.display = 'flex';
      // Joshua's iter-1 brief: every open resets to defaults — last 10,
      // filtered to active steward (if any).
      hvFilterMine = !!activeStewardId();
      hvLimit = HV_PAGE;
      hvExpandedKey = null;
      ensureToggleBtn();
      loadStewardOptions();
      runSearch();
      setTimeout(function() { hvSearch.focus(); }, 50);
    }
    function closeHV() {
      hvOpen = false;
      window.__historyOpen = false;
      document.removeEventListener('click', _hvOutsideClick, true);
      const hb = document.querySelector('#bottom-toolbar .toolbar-history');
      if (hb) hb.classList.remove('is-engaged');
      hvPanel.style.display = 'none';
      undockHV();
    }
    function toggleHV() { hvOpen ? closeHV() : openHV(); }

    window.toggleHistoryViewer = toggleHV;
    if (hvClose) hvClose.addEventListener('click', closeHV);

    hvSearch.addEventListener('input', function() {
      if (hvDebounce) clearTimeout(hvDebounce);
      hvDebounce = setTimeout(runSearch, 200);
    });
    hvSearch.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeHV(); }
    });
    hvStewardFilter.addEventListener('change', runSearch);
  })();
})();

// =============================================================================
// MOBILE SWIPE-DECK (body.embedded only — desktop is untouched)
// =============================================================================
(function() {
  let currentItemId = null;  // active card id; survives re-renders
  let deckRoot = null;       // wrapper inside #conv-thread

  function isMobile() {
    return document.body.classList.contains('embedded');
  }

  function getActiveBubbles() {
    const thread = document.getElementById('conv-thread');
    if (!thread) return [];
    // Active cards = chat-row wrappers whose bubble has an input wrap.
    // buildChatMessages emits <div class="chat-row"><div class="msg-bubble">...
    // We transform the ROW (the flow element) so the bubble's absolute
    // positioning takes the row out of vertical stacking.
    const bubbles = Array.from(thread.querySelectorAll('.msg-bubble[data-item-id]'))
      .filter(b => b.querySelector('.msg-input-wrap'));
    // Map bubble -> closest chat-row ancestor; fall back to bubble if no row.
    return bubbles.map(b => b.closest('.chat-row') || b).filter(Boolean);
  }

  function bubbleId(rowOrBubble) {
    const b = rowOrBubble.querySelector('.msg-bubble[data-item-id]') || rowOrBubble;
    return b.dataset.itemId;
  }

  // --- Per-steward position memory (Josh 2026-08-30) -----------------------
  //
  // REGRESSION THIS FIXES: this started life as a single module-scoped
  // `lastKnownIndex`, shared by EVERY steward and never reset on switch. A
  // positional index from one deck is meaningless in a different deck, so
  // leaving steward A on card 3 and entering steward B put Josh on card 3 of
  // 12 — and on card 1 whenever the carried index was 0. His words: "whenever
  // I switch between stewards it starts me at card 1 instead of card 12...
  // Definitely not the beginning."
  //
  // Keyed by steward, and storing an ITEM ID rather than an index on purpose:
  // indices shift as cards arrive and get answered, an id doesn't. If the
  // remembered card is gone, we fall through to the newest card.
  //
  // The three behaviors Josh asked for, and which mechanism serves each:
  //   1. after replying  → advance to the next NEWER card (the walk below)
  //   2. re-entering a steward → the card he was last on THERE (this map)
  //   3. fresh steward, or remembered card gone → the LAST card (newest)
  const stewardLastCardId = new Map();   // steward session_id -> item id

  function rememberPosition(itemId) {
    if (selectedSteward && itemId) stewardLastCardId.set(selectedSteward, itemId);
  }

  // Index we were sitting on within the CURRENT deck. Only meaningful for the
  // after-reply case, where the deck is the same one minus the answered card —
  // which is why it is cleared the moment we change steward.
  let lastKnownIndex = -1;
  let lastKnownSteward = null;

  // --- External nav target (notification tap / deep link) -------------------
  // Set by window.navigateToCard before the steward's cards finish loading;
  // consumed by findCurrentIndex (CASE -1) on whichever render lands last.
  // See the long comment at CASE -1 for the snap-back bug this kills.
  let pendingNavItemId = null;
  let pendingNavExpires = 0;

  function setPendingNav(itemId) {
    pendingNavItemId = itemId || null;
    // Safety valve: if the target card never shows up (deleted server-side,
    // wrong steward, fetch failed), stop overriding Josh's position rather
    // than pinning the deck forever.
    pendingNavExpires = Date.now() + 4000;
  }
  function clearPendingNav() {
    pendingNavItemId = null;
    pendingNavExpires = 0;
  }
  function expirePendingNavIfStale() {
    if (pendingNavItemId && Date.now() > pendingNavExpires) clearPendingNav();
  }
  window.__deckSetPendingNav = setPendingNav;

  // Detect a steward change and clear the position state that only makes sense
  // within a single deck.
  //
  // CRITICAL: this must be its OWN step, not folded into findCurrentIndex.
  // findCurrentIndex is called FIVE times per render (nav buttons, arrow
  // enable/disable, mobileDeckGetState, applyMobileDeckImpl...). A
  // "changed?" test that clears the flag as a side effect is consumed by
  // whichever caller happens to run first, and every later call in the same
  // render sees "unchanged" and takes the stale-index path. That is exactly
  // the bug this function exists to prevent, so keep the detection idempotent
  // and call it from ONE place: syncStewardScope, at the top of the render.
  // No-op kept intentionally simple: findCurrentIndex now derives freshness
  // itself (selectedSteward vs lastKnownSteward) and setCurrent commits the
  // new scope. Nothing needs to pre-clear state, and a second mechanism that
  // could disagree with the first is what caused the last round of bugs.
  // Runs ONCE per render, before anything reads position state (see the
  // caller in applyMobileDeckImpl). The only work here is aging out a
  // pending external-nav target that never resolved.
  function syncStewardScope() { expirePendingNavIfStale(); }

  // PURE. Decides which card should be current and RETURNS its index —
  // it writes NOTHING.
  //
  // This function is called ~6 times per render (nav buttons, arrow
  // enable/disable, mobileDeckGetState, applyMobileDeckImpl, ...) and callers
  // reasonably treat it as a query. When it also MUTATED lastKnownIndex /
  // currentItemId / the per-steward map, whichever call happened to run first
  // — including a mobileDeckGetState() from outside, before the deck had even
  // re-rendered for the new steward — silently wrote the wrong position and
  // every later call inherited it. That is how a stale index from the previous
  // steward kept winning. setCurrent() is the single writer; keep it that way.
  function findCurrentIndex(bubbles) {
    if (!bubbles.length) return -1;
    const freshSteward = selectedSteward !== lastKnownSteward;

    // CASE -1 — EXTERNAL NAV TARGET WINS OVER EVERYTHING (Josh 2026-09-03).
    //
    // THE SNAP-BACK BUG, in his words: "it'll go all the way to the right card
    // and then boom, it like snaps to some totally different card... this only
    // happens after I click a notification."
    //
    // Why it happened: navigateToCard() called selectSteward(), which kicks off
    // an ASYNC Promise.all([fetchHistory..., fetchActivity]).then(renderView).
    // navigateToCard then waited a FIXED 100ms and focused the target. The
    // fetches almost always land AFTER that 100ms, so renderThread() rebuilt
    // every bubble from scratch, applyMobileDeck re-ran, and this function —
    // seeing a fresh steward and a currentItemId that no longer matched
    // anything — fell through to CASE 2a/3 and returned the NEWEST card. The
    // deck yanked him off the card the notification was about.
    //
    // The fix is NOT a bigger timeout (that just re-races the same fetch).
    // The target is held as durable state and consumed HERE, so whichever
    // render happens to run last still lands on the right card. It is cleared
    // once honored, or when Josh navigates himself (setCurrent), so it can
    // never pin him to a stale card later.
    if (pendingNavItemId) {
      const idx = bubbles.findIndex(b => bubbleId(b) === pendingNavItemId);
      if (idx >= 0) return idx;
      // Target not in this deck YET — the steward's cards may still be
      // in flight. Keep holding it; a later render will find it.
    }

    // CASE 0 — still on a card that exists in THIS deck.
    if (!freshSteward && currentItemId) {
      const idx = bubbles.findIndex(b => bubbleId(b) === currentItemId);
      if (idx >= 0) return idx;
    }

    // CASE 2 — arriving at a steward: the card Josh was last on HERE. "If it's
    // on cards like say 3 of 12 and I navigate to a different setting and come
    // back, it should just be back on 3 of 12."
    if (freshSteward || lastKnownIndex < 0) {
      // CASE 2a — NEWEST-UNREAD JUMP (Josh 2026-09-01). Re-entering a steward
      // whose NEWEST card arrived while he was away should land on that card,
      // not on his old place in line: "if a new one comes in during that time
      // while I'm away from that setting, I would expect that I would go back
      // and it would be on the newest one."
      //
      // ONLY the newest card's read-state matters — deliberately NOT "any
      // unread exists." Josh was explicit that it has to be the newest card in
      // the thread. A steward holding five old unread cards behind a READ
      // newest card still restores his remembered position.
      //
      // The signal is `readState`, the same per-card read map that drives the
      // unread badge on each steward icon (getUnreadCountForSteward) and that
      // setCurrent flips the moment a card becomes front. NOT `seen_at`: that
      // field is stamped ONLY in timeline mode — the per-steward deck
      // deliberately never marks seen — so a seen_at test here would read
      // always-unread and would blow away his remembered position everywhere.
      const newestIdx = bubbles.length - 1;
      const newestId = bubbleId(bubbles[newestIdx]);
      if (readStateHydrated && newestId && !readState[newestId]
          && isLiveBubble(bubbles[newestIdx])) {
        return newestIdx;
      }

      const rememberedId = stewardLastCardId.get(selectedSteward);
      if (rememberedId) {
        const idx = bubbles.findIndex(b => bubbleId(b) === rememberedId);
        if (idx >= 0 && isLiveBubble(bubbles[idx])) return idx;
      }
      // CASE 3 — never been here, or that card is gone: the LAST card, the
      // newest. "Default to the end. Definitely not the beginning."
      return bubbles.length - 1;
    }

    // CASE 1 — same steward, but the card we were on is GONE (answered,
    // dismissed, removed server-side). The ONLY case that walks.
    //
    // This used to return `bubbles.length - 1` — the newest card — which is how
    // answering card 3 of 10 threw Josh to card 10 and out of his backlog. The
    // deck shrank by one, so the slot the dead card occupied now holds the card
    // that sat right after it: the next one toward the newest, the direction he
    // asked for. Walk forward, then backward if we were already at the end.
    const start = Math.min(lastKnownIndex, bubbles.length - 1);
    for (let i = start; i < bubbles.length; i++) {
      if (isLiveBubble(bubbles[i])) return i;
    }
    for (let i = start - 1; i >= 0; i--) {
      if (isLiveBubble(bubbles[i])) return i;
    }
    return start;
  }

  // --- Card motion (Josh 2026-09-03) ---------------------------------------
  //
  // HISTORY, so nobody "fixes" this back: on 2026-04-20 Josh had ALL slide
  // animation removed and locked it down (transition:none !important, twice).
  // On 2026-09-03 he asked for the opposite, verbatim: "if I use my left and
  // right arrows, it's just a very jerky experience... they flash very quickly.
  // It's very ugly." So motion is back — deliberately, at his request.
  //
  // Only the horizontal slide is animated. The card's INNER content still has
  // transition:none, because animating text/inputs is what made the old
  // version feel like a flash rather than a slide.
  const SLIDE_MS = 260;
  const SLIDE_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';  // ease-out; no overshoot

  // Josh 2026-09-03 (round 2): "give the cards like a tiny bit of padding in
  // between them as they move... they just butt up against each other and
  // giving them a little bit of space I think would look cool."
  //
  // The deck spaces cards by exactly this stride, so widening it past the
  // viewport width opens a real gutter between neighbours. Nothing else has to
  // change: drag, commit threshold and rubber-band all derive from it, so the
  // gap stays consistent whether he's mid-drag or watching a glide.
  const CARD_GAP = 18;
  function deckWidth() { return (window.innerWidth || 390) + CARD_GAP; }

  // `animate` false = position instantly (first render, re-render mid-drag,
  // finger-follow). True = glide (arrows, swipe release, external nav).
  // Writes the backdrop drift (see the ::before rule in style.css). Kept in
  // ONE place so the glide path and the drag path can't disagree.
  function setParallax(px, ms) {
    const thread = document.getElementById('conv-thread');
    if (!thread) return;
    thread.style.setProperty('--deck-parallax', px + 'px');
    thread.style.setProperty('--deck-parallax-ms', (ms || 0) + 'ms');
  }

  function applyDeckPositions(bubbles, currentIdx, animate) {
    const w = deckWidth();
    // Backdrop tracks the deck's absolute position, so it keeps drifting in
    // one direction as he moves through the deck rather than resetting.
    setParallax(-currentIdx * w, animate ? SLIDE_MS : 0);
    bubbles.forEach((b, i) => {
      const offset = i - currentIdx;
      b.classList.add('mobile-deck-card');
      b.style.zIndex = offset === 0 ? '2' : '1';
      b.setAttribute('aria-hidden', offset === 0 ? 'false' : 'true');
      b.style.animation = 'none';
      // Only neighbours need to animate; anything further out is off-screen
      // either way, and transitioning all N cards is what costs frames on a
      // long deck.
      const near = Math.abs(offset) <= 1;
      b.style.transition = (animate && near)
        ? `transform ${SLIDE_MS}ms ${SLIDE_EASE}`
        : 'none';
      b.style.transform = `translate3d(${offset * w}px, 0, 0)`;
    });
    // Keep the undo stack welded to the (stationary) active card's upper-right
    // corner across deck re-renders, font-size changes and orientation flips.
    if (typeof positionUndoSlotToCard === 'function') positionUndoSlotToCard();
    // ...and again once the 260ms slide has LANDED. The call above measures the
    // card at the start of its transition, so during a deck advance it reads a
    // card that is still off-screen — which is how a freshly-created undo pill
    // ended up parked off the viewport for its whole life (Josh 2026-09-06).
    if (typeof scheduleUndoAnchorSettle === 'function') scheduleUndoAnchorSettle();
    // PERF (2026-08-29): removed a debug getComputedStyle(first)+console.log that
    // ran here on every deck render — getComputedStyle after the style writes
    // above FORCES a synchronous reflow (flagged in the perf trace). It was only
    // a leftover verification log; the transition:none is enforced inline + via
    // CSS !important, so nothing needs to read it back.
  }

  function setCurrent(bubbles, idx, opts) {
    if (idx < 0 || idx >= bubbles.length) return;
    const prevItemId = currentItemId;
    currentItemId = bubbleId(bubbles[idx]);
    // Release the external-nav hold as soon as we've actually landed on the
    // requested card (or the moment Josh navigates himself — goNext/goPrev/
    // swipe pass userInitiated, and his intent always outranks a deep link).
    if (pendingNavItemId &&
        (pendingNavItemId === currentItemId || (opts && opts.userInitiated))) {
      clearPendingNav();
    }
    // Remember where Josh is in THIS steward so leaving and coming back puts
    // him right back here (Josh 2026-08-30). Every navigation funnels through
    // setCurrent — arrows, jumps, swipe — so this one line covers them all.
    lastKnownIndex = idx;
    lastKnownSteward = selectedSteward;
    rememberPosition(currentItemId);
    // Josh 2026-08-27: in timeline mode, retitle the header to the sender of the
    // card that just became current (real steward icon + name), so Josh can see
    // who actually sent the card on screen as the timeline plays.
    if (selectedViewMode === 'timeline' && typeof updateTimelineHeaderForItem === 'function') {
      updateTimelineHeaderForItem(currentItemId);
    }
    // 2026-04-28 Joshua's phone-trackpad: when his phone fires "→ Card"
    // it should claim THIS card (the one he's looking at on his desktop)
    // not whatever's focused in the phone's own WebView. Push current
    // state to the server so the Mac PhoneMouse companion can read it
    // on each phone-side claim. Desktop-only — the phone WebView runs
    // this same JS but with body.embedded set, and we want only the
    // desktop instance to be authoritative for "current card."
    if (typeof reportDesktopCurrent === 'function') reportDesktopCurrent();
    // Composer per-card draft swap (Joshua 2026-05-20). On every nav,
    // stash the visible textarea content under the OLD active key and
    // restore the NEW card's draft. Safe pre-init: noop if composer
    // wiring hasn't run yet.
    if (typeof window.__composerSwapForActiveCard === 'function') {
      window.__composerSwapForActiveCard();
    }
    // Animate only when the card actually CHANGES, and only for real
    // navigation (arrows / swipe / external nav). A background re-render that
    // lands on the same card must not replay the slide — that would make the
    // deck twitch every poll.
    const cardChanged = prevItemId !== currentItemId;
    applyDeckPositions(bubbles, idx, !!(opts && opts.animate) && cardChanged);
    syncMobileInputBar(bubbles[idx]);
    if (typeof renderBottomToolbar === 'function') renderBottomToolbar();
    if (typeof updateCardPositionLabel === 'function') updateCardPositionLabel(bubbles, idx);
    // R18 per-card read-on-focus. Mark THIS card read; debounce the
    // server POST so rapid arrow-mashing doesn't thrash the network.
    // Accrue all newly-read ids into a Set so the debounce window can flush
    // every flip — earlier per-flip scalar lost the middle ids during rapid
    // arrow-mashing because clearTimeout dropped them before they ever POSTed.
    if (currentItemId && !readState[currentItemId]) {
      readState[currentItemId] = true;
      if (!window.__pendingReadStateIds) window.__pendingReadStateIds = new Set();
      window.__pendingReadStateIds.add(currentItemId);
      if (window.__readStateSaveTimer) clearTimeout(window.__readStateSaveTimer);
      window.__readStateSaveTimer = setTimeout(() => {
        const batch = window.__pendingReadStateIds;
        window.__pendingReadStateIds = new Set();
        window.__readStateSaveTimer = null;
        try { saveReadState(batch); } catch {}
        if (typeof renderSidebar === 'function') renderSidebar();
        if (document.body.classList.contains('embedded') && typeof renderEmbeddedTopbar === 'function') {
          renderEmbeddedTopbar();
        }
      }, 120);
    }
    // FEATURE 2 mark-seen: in the timeline/play view, the FIRST time a card
    // becomes the front card Josh has "laid eyes on it" → stamp seen_at server
    // side so it stops being the newest-unseen. Only in timeline mode (the
    // per-steward deck must NOT mark seen — that would silently consume the
    // whole queue's unseen state just by browsing a steading). Fire-and-forget;
    // the server guards first-lay-eyes-wins so a re-focus is a cheap no-op.
    if (window.__timelineMode && window.__timelineFocusSettled && currentItemId) {
      if (!window.__timelineSeenSent) window.__timelineSeenSent = new Set();
      if (!window.__timelineSeenSent.has(currentItemId)) {
        window.__timelineSeenSent.add(currentItemId);
        const seenId = currentItemId;
        try {
          const base = window.location.origin || 'http://localhost:3005';
          fetch(`${base}/api/presenter/mark-seen/${seenId}`, { method: 'POST' })
            .then(r => { if (!r.ok) window.__timelineSeenSent.delete(seenId); })
            .catch(() => { window.__timelineSeenSent.delete(seenId); });
        } catch { window.__timelineSeenSent.delete(seenId); }
      }
    }
    // R18 arrow-direction unread-count badges — recomputed on every setCurrent
    // since nav moves the "before/after" line even when no cards arrive.
    if (typeof updateDeckArrowUnreadBadges === 'function') {
      updateDeckArrowUnreadBadges(bubbles, idx);
    }
    // Split-pill card-half — delegate to the single authoritative updater so
    // arrow-nav (here) and steading-switch (updateBottomTargetPill) can't
    // diverge. It reads deck state and hides the card-half entirely when the
    // steading has zero cards. (Josh 2026-08-11 — was an inline IIFE that
    // only ran when bubbles existed, leaving stale counts on empty steadings.)
    if (typeof window.__updateSplitPillCardHalf === 'function') {
      window.__updateSplitPillCardHalf();
    }
  }

  // Inject / update a small mobile-only pill at the top of the current
  // card: "{emoji} {stewardName} · {N} of {M}". Swappable on every
  // setCurrent call. Lives INSIDE the card bubble so it scrolls with
  // content; keeps Josh oriented even on long cards mid-read.
  // R17 + R20 (Josh 2026-04-21): card header stacks
  //   Row 1: big bold TITLE
  //   Row 2: small muted "N of M" + sender chip
  // Sender chip (R20) restores the identity info we lost killing the
  // avatar-bar in R16. Shows substeward/worker icon + name when the
  // card came from a descendant (not the steward itself). Name-only
  // for workers that don't have an icon.
  function updateCardPositionLabel(bubbles, idx) {
    if (!document.body.classList.contains('embedded')) return;
    // Wipe any label from previously-labeled cards. Disconnect each one's
    // header-height ResizeObserver first so navigation never accumulates them.
    document.querySelectorAll('.card-position-label').forEach(el => {
      try { if (el._cplResizeObserver) el._cplResizeObserver.disconnect(); } catch {}
      el.remove();
    });
    const current = bubbles[idx];
    if (!current) return;
    const bubble = current.querySelector('.msg-bubble[data-item-id]') || current;
    if (!bubble) return;
    // R4 (Josh 2026-08-13): the header is DETACHED from the scroll region — it
    // anchors to the card FRAME (the .mobile-deck-card row), not the scrolling
    // bubble. `current` is that row. We build the label below and append it to
    // `current` (position:absolute top:0 via CSS), then reserve matching space
    // at the top of the scrolling bubble so body content clears the header.
    const frame = current;
    const total = bubbles.length;
    const cur = idx + 1;
    // Pull the item's title from the now-hidden .msg-card-title element.
    const titleEl = bubble.querySelector('.msg-card-title');
    const titleText = titleEl ? (titleEl.textContent || '').trim() : '';
    // Resolve sender identity from the item's session_id. Use existing
    // tree walkers (don't reinvent). Reach the item via bubble.dataset.itemId
    // → queue lookup.
    const itemId = bubble.dataset.itemId;
    const item = (queue || []).find(i => i.id === itemId);
    let sender = null;
    if (item) sender = resolveCardSender(item);
    const label = document.createElement('div');
    label.className = 'card-position-label';
    // Josh 2026-09-03: the steading's icon as a big, faint watermark in the
    // lower-right of the header — "almost like a background, watermarked
    // style... really big but faint" so it reads as stylistic texture, not a
    // control. Resolved from the TOP steward (via the existing helper) so a
    // worker card still shows its project's mark; workers deliberately carry
    // no icon of their own (name-only, Josh R20), and top-steward cards set
    // showChip:false, so neither path can supply it — this is independent of
    // both. aria-hidden: it is decoration, and the name is already in text.
    // R2 (Josh): the mark HANGS OVER the header's bottom edge rather than being
    // cut off by it, so it cannot live inside the header — the header sets
    // z-index + position, which creates a stacking context its children can
    // never paint outside of. It is appended to the card FRAME instead and
    // positioned against the header's height (set as --cpl-h below).
    let steadingMark = null;
    try {
      const markChar = (typeof urgencySteadingIcon === 'function' && item && item.session_id)
        ? urgencySteadingIcon(urgencyTopOf(item.session_id))
        : '';
      if (markChar) {
        steadingMark = document.createElement('div');
        steadingMark.className = 'cpl-steading-mark';
        steadingMark.textContent = markChar;
        steadingMark.setAttribute('aria-hidden', 'true');
      }
    } catch (e) { /* decoration only — never break the header */ }
    if (titleText) {
      const titleRow = document.createElement('div');
      titleRow.className = 'cpl-title';
      titleRow.textContent = titleText;
      label.appendChild(titleRow);
    }
    // Josh 2026-09-03: the worker/project name sits DIRECTLY under the title —
    // it's identity, so it belongs with the title, not buried in the
    // navigational meta row at the bottom.
    if (sender && sender.showChip) {
      const nameRow = document.createElement('div');
      nameRow.className = 'cpl-name-row';
      if (sender.icon) {
        const ic = document.createElement('span');
        ic.className = 'cpl-sender-icon';
        ic.textContent = sender.icon;
        nameRow.appendChild(ic);
      }
      const nm = document.createElement('span');
      nm.className = 'cpl-name-under';
      nm.textContent = (item && item.session_id)
        ? sessionDisplayName(item.session_id, { withSteward: true })
        : sender.name;
      nameRow.appendChild(nm);
      label.appendChild(nameRow);
    }
    // Timestamp row — date + time + relative. Shows when this card was sent.
    const itemTs = item ? (item.timestamp || item.created_at) : null;
    const fullTs = formatFullCardTimestamp(itemTs);
    if (fullTs) {
      const tsRow = document.createElement('div');
      tsRow.className = 'cpl-timestamp';
      tsRow.textContent = fullTs;
      label.appendChild(tsRow);
    }
    // Row 2: count + sender chip (inline, right of count).
    const metaRow = document.createElement('div');
    metaRow.className = 'cpl-meta-row';
    const countSpan = document.createElement('span');
    countSpan.className = 'cpl-count';
    countSpan.textContent = `${cur} of ${total}`;
    metaRow.appendChild(countSpan);
    // (The sender name used to repeat here; it now lives under the title.)
    label.appendChild(metaRow);
    // R4: anchor the header to the FRAME (row), not the scrolling bubble. It
    // sits inside the bubble's gradient border ring (see CSS), so it needs no
    // border color of its own — the ring frames it.
    frame.appendChild(label);
    // The watermark rides on the FRAME, immediately after the header, so it can
    // hang past the header's bottom edge (a header child could not — see above).
    if (steadingMark) frame.appendChild(steadingMark);

    // Engine dashboard — mounted ON the card header, over the steading
    // watermark that already overhangs there.
    //
    // Josh 2026-09-12, correcting a first attempt that put this in the steward
    // row: "That's not at all where I asked them to be. I asked it to be in
    // the icon that's up in the header of the cards. Take up that space, not
    // in the same row as the actual stewards. That's precious space down
    // there. I'm already running out of room down there."
    //
    // And from the original ask: "that's the background of the dashboard is
    // whatever that icon is" — the watermark is literally the panel's
    // backdrop, which is why the instruments sit directly on top of it with no
    // bezel of their own.
    let engineEl = null;
    try {
      const ep = initEnginePanel();
      if (ep) { engineEl = ep.el; frame.appendChild(engineEl); }
    } catch (e) { /* instrumentation must never break a card */ }
    // Reserve top space in the scrolling bubble equal to the header height so
    // the first line of body content isn't hidden under the fixed header. Set
    // via the --card-header-h custom property (consumed by the bubble's
    // padding-top !important rule) because a plain inline padding-top is beaten
    // by the R17 `padding: 0 !important` rule. Measured post-insert because the
    // title wraps to a variable line count.
    //
    // SELF-CORRECTING, not a one-shot measure (Josh 2026-09-18).
    //
    // THE BUG, as Josh reported it: on the first card after an APK install the
    // body started FAR TOO LOW — "an enormous amount of padding above it", a
    // long scroll to reach the text. Over-reservation, not under-reservation.
    //
    // MECHANISM (measured, not inferred). The title is 26px/700 with
    // `overflow-wrap:anywhere`, and the header inherits body's
    // `font-family:'VT323', monospace`. VT323 is a REMOTE Google font on a
    // display=swap link, so on a cold WebView the header first lays out in the
    // MONOSPACE FALLBACK, which is far wider per glyph — so the title wraps
    // onto MORE lines and the header measures TALLER than it will ever actually
    // be. Measured at 26px with a real card title:
    //     card width   fallback   VT323   over-reserved
    //        320px       231px    147px      +84px
    //        360px       183px    147px      +36px
    //        200px       355px    236px     +119px
    // The single rAF captured that inflated height, wrote it, and never looked
    // again; VT323 then swapped in and the header SHRANK, leaving a phantom gap
    // the size of the difference. Worst when the card is narrow at measure
    // time, which is why it looked like "way down deep".
    //
    // Navigating away and back cured it only because updateCardPositionLabel
    // runs solely from setCurrent — i.e. on navigation — by which point the
    // font is warm and the measurement is correct.
    //
    // Three guards, so a header that CHANGES height after the first
    // measurement — in either direction — has its reservation corrected:
    //   1. A ResizeObserver on the label re-applies on every real height
    //      change. This is the one that fixes Josh's bug: it catches the
    //      shrink when VT323 swaps in. It also covers his text-size control
    //      and title re-wrap in the same mechanism.
    //   2. document.fonts.ready as a belt-and-braces re-measure, for the case
    //      where the swap lands without tripping the observer.
    //   3. Never write 0 — a 0 measure means "not laid out yet", and because
    //      the CSS fallback is also 0px it would drop the body UNDER the
    //      header. Keeping the previous value is strictly safer. (This guards
    //      the opposite failure from the one Josh hit; both are one-shot-
    //      measurement bugs.)
    const applyHeaderHeight = () => {
      try {
        const h = label.offsetHeight || 0;
        // Guard 1: a 0 measure means the header isn't laid out yet. Writing
        // '0px' here is strictly worse than leaving the previous value — it is
        // exactly how the body ended up underneath the header.
        if (!h) return;
        bubble.style.setProperty('--card-header-h', h + 'px');
        // Bottom-align the watermark to the header's bottom edge; CSS then
        // lets it hang past by a fraction of its own size.
        if (steadingMark) steadingMark.style.setProperty('--cpl-h', h + 'px');
        // The engine panel rides the same header-height anchor, so the
        // instruments stay locked to the watermark they sit on as the title
        // wraps or Josh changes his text size.
        if (engineEl) engineEl.style.setProperty('--cpl-h', h + 'px');
      } catch {}
    };
    requestAnimationFrame(applyHeaderHeight);
    // Guard 2. The observer is owned by the label, so it dies with the card:
    // updateCardPositionLabel removes every .card-position-label on each run,
    // and an observed element being GC'd takes its observation with it. We also
    // disconnect explicitly on removal to be certain we never leak one per nav.
    try {
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(applyHeaderHeight);
        ro.observe(label);
        label._cplResizeObserver = ro;
      }
    } catch (e) { /* observer is an enhancement — never break a card */ }
    // Guard 3.
    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          // The card may already be gone by the time fonts settle.
          if (label.isConnected) applyHeaderHeight();
        }).catch(() => {});
      }
    } catch (e) { /* font API is optional */ }
  }

  // R20 helper: resolve a card's session_id → {icon, name, showChip}.
  // showChip=false means "sender IS the selected top-level steward" —
  // suppress the chip (page header already shows it; no need to duplicate).
  function resolveCardSender(item) {
    if (!item) return null;
    const sid = item.session_id || item.callback_session || '';
    if (!sid) return null;
    // Top-level steward — suppress chip (page header owns this identity).
    const topStw = (typeof findStewardForSession === 'function') ? findStewardForSession(sid) : null;
    const topOwnSid = topStw ? `holler-${topStw.id}` : null;
    if (topStw && sid === topOwnSid) {
      return { icon: topStw.icon, name: dnHumanize(topStw.name || topStw.id), showChip: false };
    }
    // Substeward (covers sub-subs too — findSubstewardForSession walks both levels).
    const sub = (typeof findSubstewardForSession === 'function') ? findSubstewardForSession(sid) : null;
    if (sub) {
      return {
        icon: sub.icon || '',
        // A tree record may carry no name at all (live: retire-interface1,
        // wallpaper-redraw) — fall back to the id-derived canonical label.
        name: sub.name ? dnHumanize(sub.name) : sessionDisplayName(sid),
        showChip: true,
      };
    }
    // Orphan / unknown (e.g., a worker session not yet in the steward tree).
    // Derive a readable name from the session id. Prefer the last path
    // segment after stripping "holler-" and any parent prefixes.
    return {
      icon: '',  // no icon — name-only (Josh R20 explicit)
      name: sessionDisplayName(sid),
      showChip: true,
    };
  }

  // v4: composer has TWO explicit send buttons. The textarea + pill ALWAYS
  // represent the walkie-to-steward path. Card-replies go through the
  // dedicated [↳ Card] button. syncMobileInputBar only updates the textarea
  // placeholder to match the card's placeholder (hint of what the card is
  // asking for), plus refreshes the Card button's enabled state.
  function syncMobileInputBar(rowOrBubble) {
    const ta = document.getElementById('conv-bottom-textarea');
    if (!ta) return;
    const bubble = rowOrBubble && (rowOrBubble.querySelector
      ? rowOrBubble.querySelector('.msg-bubble[data-item-id]')
      : null) || rowOrBubble;
    const cardInput = bubble && bubble.querySelector('.msg-input');
    const cardSend = bubble && bubble.querySelector('.msg-send-btn');
    if (!cardInput || !cardSend) {
      hideMobileInputBar();
      return;
    }
    if (cardInput.placeholder) ta.placeholder = cardInput.placeholder;
    const itemId = bubble.dataset.itemId || '';
    ta.dataset.nativeInputId = `card-${itemId}`;
    if (typeof window.__refreshCardSendBtn === 'function') window.__refreshCardSendBtn();
  }

  function hideMobileInputBar() {
    const ta = document.getElementById('conv-bottom-textarea');
    if (ta) {
      ta.placeholder = 'Type a message...';
      delete ta.dataset.nativeInputId;
    }
    if (typeof window.__refreshCardSendBtn === 'function') window.__refreshCardSendBtn();
  }

  function getCurrentCardSendTargets() {
    if (!currentItemId) return null;
    const thread = document.getElementById('conv-thread');
    if (!thread) return null;
    const bubble = thread.querySelector(`.msg-bubble[data-item-id="${currentItemId}"]`);
    if (!bubble) return null;
    const cardInput = bubble.querySelector('.msg-input');
    const cardSend = bubble.querySelector('.msg-send-btn');
    if (!cardInput || !cardSend) return null;
    return { cardInput, cardSend };
  }

  function submitMobileInputBar() {
    const ta = document.getElementById('mobile-card-input-textarea');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) return;
    const targets = getCurrentCardSendTargets();
    if (!targets) {
      // Card vanished (dismissed/responded mid-typing). Drop quietly; the
      // deck re-sync will hide the bar on the next applyMobileDeck pass.
      hideMobileInputBar();
      return;
    }
    // Mirror text into the card's hidden textarea, then click its send btn.
    targets.cardInput.value = text;
    targets.cardInput.dispatchEvent(new Event('input', { bubbles: true }));
    ta.value = '';
    targets.cardSend.click();
  }

  function wireMobileInputBarOnce() {
    const bar = document.getElementById('mobile-card-input-bar');
    if (!bar || bar.dataset.wired === '1') return;
    bar.dataset.wired = '1';
    const ta = document.getElementById('mobile-card-input-textarea');
    const sendBtn = document.getElementById('mobile-card-input-send');
    if (ta) {
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.metaKey) {
          e.preventDefault();
          submitMobileInputBar();
        }
      });
      // Step 6: Android native input bridge. On focus, defer to APK's
      // bottom-bar overlay if available; HTML textarea is the fallback.
      ta.addEventListener('focus', onMobileInputFocus);
    }
    if (sendBtn) {
      sendBtn.addEventListener('click', () => submitMobileInputBar());
    }
    installNativeInputResultHandlerOnce();
  }

  // -------- Step 6: Native Android input bridge --------
  // Pending requests indexed by request id. Map<id, { ta, itemId }>.
  const pendingNativeInputs = new Map();

  function hasAndroidBridge() {
    return !!(window.Android && typeof window.Android.requestNativeInput === 'function');
  }

  function onMobileInputFocus(e) {
    if (!hasAndroidBridge()) return;            // HTML keyboard fallback
    const ta = e.target;
    if (!ta || !ta.dataset.nativeInput) return;
    // Generate a fresh id per focus event so multiple sequential focuses don't
    // collide on the cancel/supersede semantics from the APK side.
    const id = `${ta.dataset.nativeInputId || 'mobile-bar'}-${Date.now()}`;
    const itemId = currentItemId;               // snapshot — card may change before result returns
    pendingNativeInputs.set(id, { ta, itemId });
    try {
      window.Android.requestNativeInput(
        id,
        ta.placeholder || '',
        ta.value || '',
        'text'
      );
    } catch (err) {
      console.error('[mobile-deck] requestNativeInput failed', err);
      pendingNativeInputs.delete(id);
      return;
    }
    // Blur the HTML textarea so the soft keyboard doesn't double-pop alongside
    // APK's native overlay. Use rAF — blurring inside the focus handler is
    // ignored by some browsers.
    requestAnimationFrame(() => { try { ta.blur(); } catch (e) {} });
  }

  function installNativeInputResultHandlerOnce() {
    if (installNativeInputResultHandlerOnce.__done) return;
    installNativeInputResultHandlerOnce.__done = true;
    const handler = function(id, action, value) {
      const pending = pendingNativeInputs.get(id);
      if (!pending) {
        // Not one of ours. The composer owns its own ids (see the native
        // composer bridge below) and registers as a second consumer on the same
        // dispatcher, so decline instead of swallowing (Josh 2026-08-30).
        return false;
      }
      pendingNativeInputs.delete(id);
      const { ta, itemId } = pending;
      if (action === 'cancel') return true;
      if (action !== 'submit') return true;
      // If the deck advanced to another card while the user was typing in the
      // native overlay, route this submission to the card it was started for —
      // not the current one.
      const targetCard = itemId ? document.querySelector(`#conv-thread .msg-bubble[data-item-id="${itemId}"]`) : null;
      const cardInput = targetCard ? targetCard.querySelector('.msg-input') : null;
      const cardSend = targetCard ? targetCard.querySelector('.msg-send-btn') : null;
      if (cardInput && cardSend) {
        cardInput.value = value || '';
        cardInput.dispatchEvent(new Event('input', { bubbles: true }));
        cardSend.click();
      } else if (ta) {
        // Card vanished — fall back to current card via existing submit path.
        ta.value = value || '';
        submitMobileInputBar();
      }
      return true;
    };
    registerNativeInputConsumer('mobile-deck', handler);
  }

  function ensureNavButtons(thread, bubbles, currentIdx) {
    let nav = document.getElementById('mobile-deck-nav');
    if (!nav) {
      nav = document.createElement('div');
      nav.id = 'mobile-deck-nav';
      nav.innerHTML =
        '<button id="mobile-deck-prev" aria-label="Previous card">‹</button>' +
        '<span id="mobile-deck-counter"></span>' +
        '<button id="mobile-deck-next" aria-label="Next card">›</button>';
      thread.appendChild(nav);
      document.getElementById('mobile-deck-prev').addEventListener('click', () => goPrev());
      document.getElementById('mobile-deck-next').addEventListener('click', () => goNext());
    }
    const counter = document.getElementById('mobile-deck-counter');
    if (counter) {
      counter.textContent = bubbles.length ? `${currentIdx + 1} / ${bubbles.length}` : '0';
    }
    document.getElementById('mobile-deck-prev').disabled = findNextLive(bubbles, currentIdx, -1) < 0;
    document.getElementById('mobile-deck-next').disabled = findNextLive(bubbles, currentIdx, 1) < 0;
  }

  // Joshua 2026-06-26: arrow nav must skip slots whose bubble is mid-dismiss
  // (carries .optimistic-dismissed and renders blank). Walk in `step` direction
  // until we land on a live bubble; if none found, stay put.
  function isLiveBubble(rowOrBubble) {
    const b = rowOrBubble.querySelector
      ? (rowOrBubble.querySelector('.msg-bubble[data-item-id]') || rowOrBubble)
      : rowOrBubble;
    if (!b) return false;
    // Persistent pending-dismiss set is authoritative — a card mid-countdown
    // is NOT live even if a re-render dropped its class (2026-07-31). Same for
    // a card whose reply is mid-flight: arrow-nav must not park Josh back on
    // something he just answered (Josh 2026-08-30).
    const id = b.dataset && b.dataset.itemId;
    if (id) {
      const dismissing = window.pendingDismissIds;
      if (dismissing && dismissing.has(id)) return false;
      const replying = window.pendingReplyIds;
      if (replying && replying.has(id)) return false;
    }
    return !b.classList.contains('optimistic-dismissed');
  }

  function findNextLive(bubbles, fromIdx, step) {
    for (let i = fromIdx + step; i >= 0 && i < bubbles.length; i += step) {
      if (isLiveBubble(bubbles[i])) return i;
    }
    return -1;
  }

  // NAV_OPTS: every user-driven move slides, and outranks a pending deep link.
  const NAV_OPTS = { animate: true, userInitiated: true };

  function goNext() {
    const bubbles = getActiveBubbles();
    const idx = findCurrentIndex(bubbles);
    const targetIdx = findNextLive(bubbles, idx, 1);
    if (targetIdx >= 0) setCurrent(bubbles, targetIdx, NAV_OPTS);
  }

  function goPrev() {
    const bubbles = getActiveBubbles();
    const idx = findCurrentIndex(bubbles);
    const targetIdx = findNextLive(bubbles, idx, -1);
    if (targetIdx >= 0) setCurrent(bubbles, targetIdx, NAV_OPTS);
  }

  // Josh 2026-08-11: long-press/right-click the Prev button jumps all the way
  // to the FIRST live card, Next jumps to the LAST live card. Walk from the
  // far edge inward so dismiss-in-progress cards (isLiveBubble=false) are
  // skipped — same live-bubble rule the one-at-a-time arrows use.
  function goFirst() {
    const bubbles = getActiveBubbles();
    const targetIdx = findNextLive(bubbles, -1, 1);
    if (targetIdx >= 0) setCurrent(bubbles, targetIdx, NAV_OPTS);
  }

  function goLast() {
    const bubbles = getActiveBubbles();
    const targetIdx = findNextLive(bubbles, bubbles.length, -1);
    if (targetIdx >= 0) setCurrent(bubbles, targetIdx, NAV_OPTS);
  }

  function applyMobileDeckImpl() {
    const thread = document.getElementById('conv-thread');
    if (!thread) return;
    if (!isMobile()) {
      thread.classList.remove('mobile-deck-active');
      thread.querySelectorAll('.mobile-deck-card').forEach(b => {
        b.classList.remove('mobile-deck-card');
        b.style.transform = '';
        b.style.zIndex = '';
        b.removeAttribute('aria-hidden');
      });
      const nav = document.getElementById('mobile-deck-nav');
      if (nav) nav.remove();
      hideMobileInputBar();
      return;
    }
    wireMobileInputBarOnce();
    initDeckSwipe();
    // ONE place, before anything reads position state: notice a steward change
    // and drop the previous deck's index/card. Everything downstream then sees
    // a consistent "fresh steward" view for the whole render.
    syncStewardScope();
    const bubbles = getActiveBubbles();
    thread.classList.add('mobile-deck-active');
    // Reset scroll — deck cards are absolute-positioned, scroll would just
    // hide them off-viewport (renderThread normally scrolls to bottom).
    thread.scrollTop = 0;
    if (bubbles.length === 0) {
      const nav = document.getElementById('mobile-deck-nav');
      if (nav) nav.remove();
      currentItemId = null;
      hideMobileInputBar();
      // Zero cards → setCurrent never runs, so the split-pill would keep the
      // PREVIOUS steading's stale card number. Sync it here so the card-number
      // half is removed entirely on empty steadings. (Josh 2026-08-11.)
      if (typeof window.__updateSplitPillCardHalf === 'function') {
        window.__updateSplitPillCardHalf();
      }
      return;
    }
    const idx = findCurrentIndex(bubbles);
    if (idx >= 0) currentItemId = bubbleId(bubbles[idx]);
    applyDeckPositions(bubbles, idx);
    // Temp dev nav removed (real swipe gestures live now). Stale nav element
    // from earlier renders gets cleaned up here.
    const staleNav = document.getElementById('mobile-deck-nav');
    if (staleNav) staleNav.remove();
    // Use setCurrent as the SINGLE source of truth for initial render too.
    // It runs all the per-card updates (deck positions, syncMobileInputBar,
    // renderBottomToolbar, updateCardPositionLabel, inline card-send button
    // label). Keeps the same state machine both on load and on arrow click.
    setCurrent(bubbles, idx);
    // Josh 2026-04-20: finger-swipe nav + all slide/spring animations
    // REMOVED. Arrow-only navigation, instant snap.
  }

  // =========================================================================
  // THUMB SWIPE (Josh 2026-09-03)
  // =========================================================================
  // Verbatim: "It'd be really cool too if I could actually also swipe between
  // cards. So instead of hitting previous and next all the time, I could
  // actually just move left and right on my screen with my thumb."
  //
  // THE THREE THINGS IT MUST NOT BREAK, all checked before shipping:
  //   1. VERTICAL SCROLL. The bubble is the scroller for long cards. We stay
  //      undecided until the finger has moved 10px, then lock to ONE axis for
  //      the rest of the gesture. A vertical lock hands the touch straight
  //      back to the browser and we never touch it again.
  //   2. THE LONG-PRESS CARD MENU (_wireCtxMenu, 500ms). It cancels itself
  //      once the finger moves >8px, which any real swipe passes — so a swipe
  //      never opens the menu, and a stationary press still does.
  //   3. TAPS on buttons/inputs inside the card. Movement under the 10px
  //      threshold never locks an axis and never preventDefaults, so a tap
  //      stays a tap.
  //
  // At the ends of the deck the drag is rubber-banded rather than blocked, so
  // "nothing there" is something Josh can feel instead of a dead screen.
  function initDeckSwipe() {
    const thread = document.getElementById('conv-thread');
    if (!thread || thread.dataset.swipeWired === '1') return;
    thread.dataset.swipeWired = '1';

    const AXIS_LOCK_PX = 10;   // movement before we commit to an axis
    const COMMIT_RATIO = 0.22; // fraction of screen width that flips the card
    const COMMIT_VELOCITY = 0.45; // px/ms — a fast flick commits on less travel

    let startX = 0, startY = 0, startT = 0;
    let axis = null;           // null (undecided) | 'x' | 'y'
    let dragging = false;
    let bubbles = [], idx = -1, prevIdx = -1, nextIdx = -1;

    function resetDrag() {
      axis = null; dragging = false; bubbles = []; idx = -1;
    }

    // Position the live cards under the finger, no transition (instant follow).
    function paintDrag(dx) {
      const w = deckWidth();
      // Instant (0ms) — the backdrop is glued to the finger like the cards are.
      setParallax(-idx * w + dx, 0);
      bubbles.forEach((b, i) => {
        const offset = i - idx;
        if (Math.abs(offset) > 1) return;   // only the 3 visible slots move
        b.style.transition = 'none';
        b.style.transform = `translate3d(${offset * w + dx}px, 0, 0)`;
      });
    }

    thread.addEventListener('touchstart', function (ev) {
      if (!isMobile()) return;
      if (!ev.touches || ev.touches.length !== 1) return;
      const t = ev.touches[0];
      startX = t.clientX; startY = t.clientY; startT = Date.now();
      axis = null;
      bubbles = getActiveBubbles();
      idx = findCurrentIndex(bubbles);
      if (idx < 0 || bubbles.length === 0) { resetDrag(); return; }
      prevIdx = findNextLive(bubbles, idx, -1);
      nextIdx = findNextLive(bubbles, idx, 1);
      dragging = true;
    }, { passive: true });

    thread.addEventListener('touchmove', function (ev) {
      if (!dragging || !ev.touches || ev.touches.length !== 1) return;
      const t = ev.touches[0];
      let dx = t.clientX - startX;
      const dy = t.clientY - startY;

      // Undecided: pick the axis once the finger has travelled far enough.
      if (axis === null) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'y') { dragging = false; return; }  // vertical → browser keeps it
      }
      if (axis !== 'x') return;

      // Horizontal: we own this gesture now. Stop the page from panning too.
      if (ev.cancelable) ev.preventDefault();

      // Rubber-band at the ends — there is no card to bring in, so the deck
      // only gives a little.
      if ((dx > 0 && prevIdx < 0) || (dx < 0 && nextIdx < 0)) dx *= 0.28;
      paintDrag(dx);
    }, { passive: false });

    function endDrag(ev) {
      if (!dragging) { resetDrag(); return; }
      const wasX = axis === 'x';
      if (!wasX) { resetDrag(); return; }
      const t = (ev.changedTouches && ev.changedTouches[0]) || null;
      const dx = t ? t.clientX - startX : 0;
      const dt = Math.max(1, Date.now() - startT);
      const velocity = Math.abs(dx) / dt;
      const threshold = deckWidth() * COMMIT_RATIO;
      const far = Math.abs(dx) > threshold || velocity > COMMIT_VELOCITY;

      let target = idx;
      if (far && dx < 0 && nextIdx >= 0) target = nextIdx;
      else if (far && dx > 0 && prevIdx >= 0) target = prevIdx;

      const snapBubbles = bubbles;
      const snapIdx = target;
      const committed = snapIdx !== idx;
      resetDrag();
      if (committed) {
        // New card — setCurrent runs the full per-card state machine and
        // animates (the card changed).
        setCurrent(snapBubbles, snapIdx, NAV_OPTS);
      } else {
        // Not far enough: glide back home. No setCurrent — the current card
        // never changed, so none of its per-card side effects should re-fire.
        applyDeckPositions(snapBubbles, snapIdx, true);
      }
    }

    thread.addEventListener('touchend', endDrag, { passive: true });
    thread.addEventListener('touchcancel', function () {
      const b = bubbles, i = idx, wasDragging = dragging && axis === 'x';
      resetDrag();
      if (wasDragging && i >= 0) applyDeckPositions(b, i, true);
    }, { passive: true });
  }

  // Expose to renderThread() and to me for debugging.
  window.applyMobileDeck = applyMobileDeckImpl;
  window.mobileDeckGoNext = goNext;
  window.mobileDeckGoPrev = goPrev;
  window.mobileDeckGoFirst = goFirst;
  window.mobileDeckGoLast = goLast;
  window.mobileDeckJumpTo = function(itemId) {
    const bubbles = getActiveBubbles();
    const idx = bubbles.findIndex(b => bubbleId(b) === itemId);
    if (idx < 0) return false;
    // Glides like the arrows do. NOT userInitiated — this IS the external-nav
    // path, so it must not clear its own pending target.
    setCurrent(bubbles, idx, { animate: true });
    return true;
  };
  window.mobileDeckGetState = function() {
    const bubbles = getActiveBubbles();
    const idx = findCurrentIndex(bubbles);
    return {
      count: bubbles.length,
      currentIndex: idx,
      currentItemId: currentItemId,
      ids: bubbles.map(bubbleId),
    };
  };
  // Debug helper: re-enable temp arrow nav when troubleshooting on real device.
  window.mobileDeckShowNav = function() {
    const thread = document.getElementById('conv-thread');
    if (!thread) return;
    const bubbles = getActiveBubbles();
    ensureNavButtons(thread, bubbles, findCurrentIndex(bubbles));
  };
})();

// Make applyMobileDeck visible to renderThread (which is at top-level module scope).
function applyMobileDeck() {
  if (window.applyMobileDeck) window.applyMobileDeck();
}

// ===========================================================================
// Native composer bridge (Josh 2026-08-30)
// ===========================================================================
// Josh, verbatim: "when I'm on my phone and I hit the TYPE button in the lower
// left of the screen, I'd prefer for the native android apk text box that is
// already in homestead to appear... the reason I'm moving this direction is bc
// there is lag when I use the react text box on mobile but no lag when i use
// the native one."
//
// So on the phone, tapping Type hands typing duty to the APK's own EditText.
// The catch is that everything else in the Presenter — per-card drafts, the
// split-pill send buttons, the card's own send button — reads
// #conv-bottom-textarea. Native text used to live ONLY in Kotlin, which is
// exactly why tapping send after typing natively did nothing at all: the send
// path found an empty textarea, bailed on `if (!text) return`, and showed
// nothing.
//
// THE CONTRACT, and the thing to preserve if you touch this:
//   #conv-bottom-textarea remains the ONE web-side source of truth. The native
//   box is an input DEVICE for it, not a second store. Every keystroke is
//   mirrored in and dispatches a real `input` event, so the existing draft
//   persistence and every existing send path keep working untouched.
//
// That single rule is what makes drafts-per-card and both send buttons work
// without any of them knowing the native box exists.
(function initNativeComposerBridge() {
  const NATIVE_ID_PREFIX = 'composer';

  let activeRequestId = null;   // the id currently open on the APK side
  let suppressMirror = false;   // guard: we're writing INTO the textarea ourselves

  function ta() { return document.getElementById('conv-bottom-textarea'); }

  function hasAndroidBridge() {
    return !!(window.Android && typeof window.Android.requestNativeInput === 'function');
  }

  function isMobileSurface() {
    // The phone-embedded Presenter. Desktop keeps the web textarea — Josh has
    // no lag there and a real keyboard.
    return document.body.classList.contains('embedded');
  }

  function ownsId(id) {
    return typeof id === 'string' && id.indexOf(NATIVE_ID_PREFIX + ':') === 0;
  }

  // Ask the APK to raise its native box, seeded with whatever draft is already
  // showing for the current card.
  function openNativeBox() {
    const el = ta();
    if (!el) return false;
    if (!isMobileSurface() || !hasAndroidBridge()) return false;

    // A fresh id per open. The APK cancels any prior card when a new request
    // arrives, and that stale cancel must not be mistaken for this one.
    const id = NATIVE_ID_PREFIX + ':' + Date.now();
    activeRequestId = id;
    try {
      window.Android.requestNativeInput(
        id,
        el.placeholder || 'Type a message…',
        el.value || '',
        'textarea'                       // multi-line: this is the composer
      );
    } catch (err) {
      console.error('[native-composer] requestNativeInput failed', err);
      activeRequestId = null;
      return false;
    }
    // The native box is now the ONE visible typing surface. Hide the web
    // composer strip (Josh 2026-09-03: "the screen already struggles for
    // vertical room during this moment when the keyboard is up" — one tap
    // was yielding two stacked boxes). The panel stays in the DOM and the
    // textarea keeps its value: it remains the single source of truth for
    // per-card drafts and for BOTH send buttons. Only its pixels go away.
    setNativeBoxOwnsScreen(true);
    // Don't let the WebView's own soft keyboard come up alongside the native
    // one. Blurring inside a focus handler is ignored by some browsers, so do
    // it on the next frame.
    requestAnimationFrame(() => { try { el.blur(); } catch (e) {} });
    console.log('[native-composer] opened native box id=' + id);
    return true;
  }

  // Toggle the "native box is the visible box" state. Guarded so the web
  // composer is never hidden on desktop/Electron, where there is no native
  // box to replace it and hiding it would leave nothing to type into.
  function setNativeBoxOwnsScreen(on) {
    if (on && !(isMobileSurface() && hasAndroidBridge())) return;
    document.body.classList.toggle('native-box-owns-screen', !!on);
  }
  // Give the composer's own close path a way to undo this without knowing
  // the class name.
  window.__nativeComposerReleaseScreen = function () { setNativeBoxOwnsScreen(false); };

  // Write native text into the web textarea AS IF the user typed it there.
  // The dispatched `input` event is load-bearing: it's what drives per-card
  // draft persistence, the Type button's has-draft dot, and the send buttons'
  // has-text state.
  function mirrorIntoTextarea(value) {
    const el = ta();
    if (!el) return;
    const next = value || '';
    if (el.value === next) return;
    suppressMirror = true;
    try {
      el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
      suppressMirror = false;
    }
  }

  // --- Live keystroke mirroring: this is what makes drafts + send work ------
  registerNativeInputChangeConsumer('native-composer', function (id, value) {
    if (!ownsId(id)) return false;
    if (id !== activeRequestId) return true;   // stale box, still ours — swallow
    mirrorIntoTextarea(value);
    return true;
  });

  // --- Submit / cancel ------------------------------------------------------
  registerNativeInputConsumer('native-composer', function (id, action, value) {
    if (!ownsId(id)) return false;
    const isActive = id === activeRequestId;
    if (isActive) {
      activeRequestId = null;
      // The native box has closed (send or back-out). Whatever happens next,
      // it is no longer the visible typing surface.
      setNativeBoxOwnsScreen(false);
    }

    // Always mirror the final value first, whatever the action. On CANCEL
    // (Josh backed out of the keyboard) that's the whole point: his half-typed
    // text lands in the composer, gets saved as this card's draft, and is
    // sitting right there for the pill buttons. Losing it would be the same
    // silent-swallow bug in a different coat.
    if (isActive) mirrorIntoTextarea(value);

    if (action !== 'submit') return true;

    // Submit = the keyboard's send key. Route it exactly where a tap on the
    // card half of the send pill goes, so native and web submit are the same
    // path — no second implementation to drift.
    const el = ta();
    const text = el ? el.value.trim() : '';
    if (!text) {
      // NEVER silently swallow a send (Josh 2026-08-30). Empty submit is a
      // no-op by definition, but say so rather than vanishing.
      showComposerSendProblem('Nothing to send — the box was empty.');
      return true;
    }
    const routed = routeComposerTextToCard();
    if (!routed) {
      showComposerSendProblem('No card is open to reply to. Your text is saved in the box.');
    }
    return true;
  });

  // Fire the ACTIVE CARD's own send button, staging the composer text into it
  // first — the identical sequence the split-pill's card half runs. Returns
  // false when there's no card to send to, so the caller can surface it
  // instead of doing nothing.
  function routeComposerTextToCard() {
    const pillCardHalf = document.querySelector('#conv-bottom-target-pill .pill-card-half');
    if (pillCardHalf && !pillCardHalf.hidden) {
      pillCardHalf.click();
      return true;
    }
    return false;
  }

  // Surface a send that couldn't complete. The old failure mode here was a
  // dead-silent return; Josh tapped send and nothing happened, with no way to
  // tell whether it had gone through.
  function showComposerSendProblem(msg) {
    console.warn('[native-composer] ' + msg);
    try {
      showErrorToast(msg);
    } catch (err) {
      console.error('[native-composer] could not surface problem:', err);
    }
  }
  window.__nativeComposerProblem = showComposerSendProblem;

  // --- Entry point: focusing the composer hands off to the native box -------
  // openComposer() focuses #conv-bottom-textarea, so a focus listener is all
  // the Type button needs — no change to the button's own handler. This is the
  // wiring the codebase was already reaching for: the element has carried
  // data-native-input="true" since the native bridge landed, but nothing ever
  // listened for focus on it, so requestNativeInput was never called from here.
  function wire() {
    const el = ta();
    if (!el || el.dataset.nativeComposerWired === '1') return;
    el.dataset.nativeComposerWired = '1';
    el.addEventListener('focus', () => {
      if (!el.dataset.nativeInput) return;
      openNativeBox();
    });
    // Tapping the textarea when it's already focused should re-raise the
    // native box (Josh dismissed the keyboard and wants it back). focus won't
    // fire a second time, so listen for the tap too.
    el.addEventListener('click', () => {
      if (!el.dataset.nativeInput) return;
      if (activeRequestId) return;             // already open
      openNativeBox();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // Exposed for the composer's own code and for debugging from the phone.
  window.__nativeComposerOpen = openNativeBox;
  window.__nativeComposerActive = function () { return !!activeRequestId; };
})();

// --- Mobile debug readout — opt-in via ?debug=1 ---
// Stashes the last [setCurrent]/[refreshCardSendBtn] console line in a
// small long-press-selectable DOM strip at the bottom of the viewport
// so Josh can copy diagnostic output from his phone without hooking up
// devtools. Intercepts console.log without breaking it.
(function initMobileDebug() {
  try {
    if (!new URLSearchParams(window.location.search).has('debug')) return;
  } catch { return; }
  const el = document.createElement('div');
  el.id = 'mobile-debug-readout';
  Object.assign(el.style, {
    position: 'fixed', left: '6px', right: '6px', bottom: '82px',
    zIndex: '99998', background: 'rgba(20, 20, 20, 0.92)', color: '#9fe',
    padding: '6px 8px', font: '10px/1.3 monospace',
    border: '1px solid #333', borderRadius: '4px',
    maxHeight: '80px', overflow: 'auto',
    userSelect: 'text', WebkitUserSelect: 'text',
  });
  el.textContent = '[debug] ready — tap an arrow, log will appear here. Long-press to select/copy.';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(el));
  if (document.body) document.body.appendChild(el);

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  function capture(kind, args) {
    try {
      const line = Array.from(args).map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
      // Only stash lines tagged with our debug markers to keep the readout useful.
      if (line.includes('[setCurrent]') || line.includes('[refreshCardSendBtn]')) {
        const t = new Date().toLocaleTimeString();
        el.textContent = `${t} ${kind} ${line}\n` + el.textContent;
        if (el.textContent.length > 2000) el.textContent = el.textContent.slice(0, 2000);
      }
    } catch {}
  }
  console.log = function(...args) { capture('LOG', args); return origLog(...args); };
  console.warn = function(...args) { capture('WRN', args); return origWarn(...args); };
})();

// --- Swipe performance overlay — opt-in via ?perf=1 ---
// Surfaces frame cadence during drag so we can SEE lag instead of
// guessing. Shows: current FPS, recent max frame time (ms), drag-write
// count. Plus a PerformanceObserver long-task counter so any >50ms JS
// task during swipe is visible as a red tick.
(function initPerfOverlay() {
  try {
    if (!new URLSearchParams(window.location.search).has('perf')) return;
  } catch { return; }
  const el = document.createElement('div');
  el.id = 'perf-overlay';
  el.innerHTML = `
    <div class="po-row"><span>fps</span><b id="po-fps">—</b></div>
    <div class="po-row"><span>max ms</span><b id="po-max">—</b></div>
    <div class="po-row"><span>drag writes</span><b id="po-dw">0</b></div>
    <div class="po-row"><span>long tasks</span><b id="po-lt">0</b></div>
  `;
  Object.assign(el.style, {
    position: 'fixed', bottom: '84px', right: '8px', zIndex: '99999',
    background: 'rgba(0,0,0,0.8)', color: '#0f0', padding: '6px 8px',
    font: '11px/1.2 monospace', border: '1px solid #0f0', borderRadius: '4px',
    pointerEvents: 'none', minWidth: '110px',
  });
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(el));
  if (document.body) document.body.appendChild(el);

  let frames = 0, lastFpsT = performance.now(), maxMs = 0, lastFrameT = performance.now();
  let dragWrites = 0, longTasks = 0;

  const fpsEl = () => document.getElementById('po-fps');
  const maxEl = () => document.getElementById('po-max');
  const dwEl  = () => document.getElementById('po-dw');
  const ltEl  = () => document.getElementById('po-lt');

  function tick(t) {
    const dt = t - lastFrameT;
    if (dt > maxMs) maxMs = dt;
    lastFrameT = t;
    frames++;
    if (t - lastFpsT >= 1000) {
      const fps = Math.round(frames * 1000 / (t - lastFpsT));
      if (fpsEl()) fpsEl().textContent = fps;
      if (maxEl()) maxEl().textContent = maxMs.toFixed(1);
      if (dwEl()) dwEl().textContent = dragWrites;
      if (ltEl()) ltEl().textContent = longTasks;
      frames = 0; lastFpsT = t; maxMs = 0;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const po = new PerformanceObserver((list) => { longTasks += list.getEntries().length; });
      po.observe({ entryTypes: ['longtask'] });
    } catch {}
  }

  window.__perfOverlay = {
    markDragFrame() { dragWrites++; },
  };
})();

