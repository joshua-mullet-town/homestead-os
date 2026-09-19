'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Inbox, X, RotateCcw, Trash2, ChevronDown, ChevronUp, Copy, Check, Zap, Send } from 'lucide-react';
import { copyToClipboard } from '../lib/clipboard';

interface QueueItem {
  id: string;
  target_session: string;
  type: string;
  message: string;
  status: 'pending' | 'dispatched' | 'delivered' | 'confirmed' | 'failed';
  created_at: string;
  dispatched_at?: string;
  confirmed_at?: string;
  failed_at?: string;
  attempts?: number;
  error?: string;
  dispatched_ready?: boolean;
}

type FilterStatus = 'all' | 'active' | 'confirmed' | 'failed';

function parseMessage(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return { instruction: raw };
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true,
  });
}

function shortSession(name: string | null | undefined): string {
  if (!name) return 'unknown';
  return name.replace(/^holler-/, '');
}

const statusColors: Record<string, string> = {
  pending: '#FFCC00',
  dispatched: '#00CCFF',
  delivered: '#00CCFF',
  confirmed: '#00FF66',
  failed: '#FF3333',
};

const statusLabels: Record<string, string> = {
  pending: 'PENDING',
  dispatched: 'SENT',
  delivered: 'SENT',
  confirmed: 'OK',
  failed: 'FAILED',
};

function getPreview(parsed: Record<string, unknown>): string {
  const instruction = parsed.instruction || parsed.feedback || parsed.message || '';
  if (typeof instruction !== 'string') return '';
  return instruction.slice(0, 100) + (instruction.length > 100 ? '...' : '');
}

export default function QueueViewer() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch('/api/queue');
      if (res.ok) {
        const data = await res.json();
        setQueue(data.queue || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, open ? 10000 : 30000);
    return () => clearInterval(interval);
  }, [fetchQueue, open]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const activeCount = queue.filter(q => ['pending', 'dispatched', 'delivered'].includes(q.status)).length;

  const filtered = queue.filter(item => {
    switch (filter) {
      case 'active': return ['pending', 'dispatched', 'delivered'].includes(item.status);
      case 'confirmed': return item.status === 'confirmed';
      case 'failed': return item.status === 'failed';
      default: return true;
    }
  }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const markBusy = (id: string, busy: boolean) => {
    setBusyIds(prev => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  };

  // Re-add: creates a brand new queue item with the same message content
  const readdItem = async (item: QueueItem) => {
    markBusy(item.id, true);
    try {
      const parsed = parseMessage(item.message);
      // Strip dispatcher-injected fields so it gets fresh ones
      const { _queue_id, _confirm, ...cleanMessage } = parsed;
      await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_session: item.target_session,
          type: item.type,
          message_override: JSON.stringify(cleanMessage),
        }),
      });
      await fetchQueue();
    } catch { /* ignore */ }
    markBusy(item.id, false);
  };

  const deleteItem = async (itemId: string) => {
    markBusy(itemId, true);
    try {
      await fetch(`/api/queue/${itemId}`, { method: 'DELETE' });
      await fetchQueue();
    } catch { /* ignore */ }
    markBusy(itemId, false);
  };

  const sendNow = async (item: QueueItem, mode: 'interrupt' | 'inject') => {
    const verb = mode === 'interrupt' ? 'INTERRUPT and send' : 'inject without interrupting';
    if (!confirm(`${verb} this message to ${shortSession(item.target_session)} right now?`)) return;
    markBusy(item.id, true);
    try {
      const res = await fetch('/api/queue/send-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, mode }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`Send failed: ${data.error || res.statusText}`);
      }
      await fetchQueue();
    } catch (e) {
      alert(`Send failed: ${(e as Error).message}`);
    }
    markBusy(item.id, false);
  };

  const copyMessage = async (item: QueueItem) => {
    await copyToClipboard(item.message);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const isExpanded = (id: string) => expandedId === id;
  const toggleExpand = (id: string) => setExpandedId(prev => prev === id ? null : id);

  return (
    <div className="relative" ref={panelRef}>
      {/* Icon Button */}
      <button
        onClick={() => setOpen(!open)}
        className={`p-2 rounded transition-colors relative ${
          open
            ? 'bg-[#FF6600] text-black'
            : 'bg-gray-800 hover:bg-gray-700 text-[#FF6600]'
        }`}
        title="Message Queue"
      >
        <Inbox size={20} />
        {activeCount > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-black text-xs font-bold px-1"
            style={{
              fontFamily: 'VT323, monospace',
              fontSize: '12px',
              backgroundColor: '#FFCC00',
              boxShadow: '0 0 6px #FFCC00',
            }}
          >
            {activeCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel */}
      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[400px] max-h-[75vh] bg-gray-900 border-2 border-[#FF6600] rounded-lg overflow-hidden z-[9999] flex flex-col"
          style={{ boxShadow: '4px 4px 0 #FF6600' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700">
            <span
              style={{ fontFamily: 'VT323, monospace' }}
              className="text-[#FF6600] text-lg"
            >
              QUEUE ({queue.length})
            </span>
            <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-white">
              <X size={16} />
            </button>
          </div>

          {/* Filter Tabs */}
          <div className="flex border-b border-gray-700">
            {([
              ['all', 'All'],
              ['active', 'Active'],
              ['confirmed', 'Done'],
              ['failed', 'Failed'],
            ] as [FilterStatus, string][]).map(([key, label]) => {
              const count = key === 'all' ? queue.length
                : key === 'active' ? queue.filter(q => ['pending', 'dispatched', 'delivered'].includes(q.status)).length
                : key === 'confirmed' ? queue.filter(q => q.status === 'confirmed').length
                : queue.filter(q => q.status === 'failed').length;
              return (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`flex-1 py-1.5 text-xs transition-colors ${
                    filter === key
                      ? 'text-[#FFCC00] border-b-2 border-[#FFCC00]'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                  style={{ fontFamily: 'VT323, monospace', fontSize: '14px' }}
                >
                  {label} ({count})
                </button>
              );
            })}
          </div>

          {/* Queue Items */}
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-6 text-center text-gray-600" style={{ fontFamily: 'VT323, monospace' }}>
                No items
              </div>
            ) : (
              filtered.map(item => {
                const parsed = parseMessage(item.message);
                const preview = getPreview(parsed);
                const expanded = isExpanded(item.id);
                const busy = busyIds.has(item.id);

                return (
                  <div
                    key={item.id}
                    className={`border-b border-gray-800 transition-colors ${expanded ? 'bg-gray-800/70' : 'hover:bg-gray-800/30'}`}
                  >
                    {/* Clickable summary row */}
                    <button
                      onClick={() => toggleExpand(item.id)}
                      className="w-full text-left px-3 py-2"
                    >
                      {/* Top row: target + status + time */}
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span
                          style={{ fontFamily: 'VT323, monospace', fontSize: '14px' }}
                          className="text-white truncate"
                        >
                          → {shortSession(item.target_session)}
                        </span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span
                            style={{
                              fontFamily: 'VT323, monospace',
                              fontSize: '12px',
                              color: statusColors[item.status] || '#888',
                            }}
                          >
                            {statusLabels[item.status] || item.status.toUpperCase()}
                          </span>
                          <span
                            style={{ fontFamily: 'VT323, monospace', fontSize: '11px' }}
                            className="text-gray-600"
                          >
                            {timeAgo(item.created_at)}
                          </span>
                          {expanded ? <ChevronUp size={12} className="text-gray-500" /> : <ChevronDown size={12} className="text-gray-500" />}
                        </div>
                      </div>

                      {/* Message preview */}
                      <div
                        style={{ fontFamily: 'VT323, monospace', fontSize: '13px' }}
                        className="text-gray-400 leading-tight"
                      >
                        {preview || <span className="italic text-gray-600">no preview</span>}
                      </div>
                    </button>

                    {/* Expanded detail */}
                    {expanded && (
                      <div className="px-3 pb-3 space-y-2">
                        {/* Send-now controls — only shown while still pending */}
                        {item.status === 'pending' && (
                          <div
                            className="rounded p-2 border-2"
                            style={{
                              borderColor: '#FFCC00',
                              backgroundColor: 'rgba(255,204,0,0.08)',
                              boxShadow: '0 0 6px rgba(255,204,0,0.4)',
                            }}
                          >
                            <div
                              className="mb-2 text-[#FFCC00]"
                              style={{ fontFamily: 'VT323, monospace', fontSize: '14px' }}
                            >
                              STILL QUEUED — waiting for {shortSession(item.target_session)} to be idle
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2">
                              <button
                                onClick={() => sendNow(item, 'interrupt')}
                                disabled={busy}
                                className="flex items-center justify-center gap-1 flex-1 px-2.5 py-1.5 bg-[#FF3333] text-white rounded hover:bg-[#FF5555] transition-colors disabled:opacity-50"
                                style={{ fontFamily: 'VT323, monospace', fontSize: '14px' }}
                                title="Send Escape key to interrupt current work, then deliver this message"
                              >
                                <Zap size={14} />
                                Interrupt + Send
                              </button>
                              <button
                                onClick={() => sendNow(item, 'inject')}
                                disabled={busy}
                                className="flex items-center justify-center gap-1 flex-1 px-2.5 py-1.5 bg-[#00CCFF] text-black rounded hover:bg-[#33DDFF] transition-colors disabled:opacity-50"
                                style={{ fontFamily: 'VT323, monospace', fontSize: '14px' }}
                                title="Deliver immediately without interrupting — message arrives alongside current work"
                              >
                                <Send size={14} />
                                Inject Now
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Detail rows */}
                        <div className="bg-gray-900 rounded p-2 space-y-1" style={{ fontFamily: 'VT323, monospace', fontSize: '13px' }}>
                          <div className="flex justify-between">
                            <span className="text-gray-500">ID</span>
                            <span className="text-gray-300">{item.id}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Target</span>
                            <span className="text-white">{shortSession(item.target_session)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Type</span>
                            <span className="text-gray-300">{item.type}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Status</span>
                            <span style={{ color: statusColors[item.status] }}>{item.status}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-500">Created</span>
                            <span className="text-gray-300">{formatTimestamp(item.created_at)}</span>
                          </div>
                          {item.dispatched_at && (
                            <div className="flex justify-between">
                              <span className="text-gray-500">Dispatched</span>
                              <span className="text-gray-300">{formatTimestamp(item.dispatched_at)}</span>
                            </div>
                          )}
                          {item.confirmed_at && (
                            <div className="flex justify-between">
                              <span className="text-gray-500">Confirmed</span>
                              <span className="text-gray-300">{formatTimestamp(item.confirmed_at)}</span>
                            </div>
                          )}
                          {item.failed_at && (
                            <div className="flex justify-between">
                              <span className="text-gray-500">Failed</span>
                              <span className="text-[#FF3333]">{formatTimestamp(item.failed_at)}</span>
                            </div>
                          )}
                          {item.attempts != null && item.attempts > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-500">Attempts</span>
                              <span className="text-[#FFCC00]">{item.attempts}/3</span>
                            </div>
                          )}
                          {!!parsed.from && (
                            <div className="flex justify-between">
                              <span className="text-gray-500">From</span>
                              <span className="text-gray-300">{shortSession(String(parsed.from))}</span>
                            </div>
                          )}
                          {item.error && (
                            <div className="flex justify-between">
                              <span className="text-gray-500">Error</span>
                              <span className="text-[#FF3333] text-right max-w-[200px]">{item.error}</span>
                            </div>
                          )}
                        </div>

                        {/* Full message */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span style={{ fontFamily: 'VT323, monospace', fontSize: '12px' }} className="text-gray-500">MESSAGE</span>
                            <button
                              onClick={() => copyMessage(item)}
                              className="flex items-center gap-1 text-gray-500 hover:text-white transition-colors"
                              style={{ fontFamily: 'VT323, monospace', fontSize: '12px' }}
                            >
                              {copiedId === item.id ? <Check size={10} className="text-[#00FF66]" /> : <Copy size={10} />}
                              {copiedId === item.id ? 'Copied' : 'Copy'}
                            </button>
                          </div>
                          <pre
                            className="bg-black rounded p-2 text-gray-300 overflow-x-auto text-xs leading-relaxed max-h-[200px] overflow-y-auto"
                            style={{ fontFamily: 'VT323, monospace', fontSize: '12px' }}
                          >
                            {(() => {
                              try {
                                return JSON.stringify(JSON.parse(item.message), null, 2);
                              } catch {
                                return item.message;
                              }
                            })()}
                          </pre>
                        </div>

                        {/* Action buttons — available on ALL items */}
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={() => readdItem(item)}
                            disabled={busy}
                            className="flex items-center gap-1 px-2.5 py-1 bg-[#FFCC00] text-black rounded text-xs hover:bg-[#FFD700] transition-colors disabled:opacity-50"
                            style={{ fontFamily: 'VT323, monospace', fontSize: '13px' }}
                            title="Create a new queue item with the same message"
                          >
                            <RotateCcw size={12} className={busy ? 'animate-spin' : ''} />
                            Re-add
                          </button>
                          <button
                            onClick={() => deleteItem(item.id)}
                            disabled={busy}
                            className="flex items-center gap-1 px-2.5 py-1 bg-gray-700 text-gray-300 rounded text-xs hover:bg-[#FF3333] hover:text-white transition-colors disabled:opacity-50"
                            style={{ fontFamily: 'VT323, monospace', fontSize: '13px' }}
                            title="Remove this item from the queue"
                          >
                            <Trash2 size={12} />
                            Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
