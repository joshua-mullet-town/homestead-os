'use client';

import { useState, useEffect, useCallback } from 'react';
import type { StewIntProps } from './StewIntLoader';

interface WatchSession {
  name: string;
  enabled: boolean;
  cadence: string;
  status: 'running' | 'stopped';
  lastChecked: number | null;
}

function shortName(name: string): string {
  return name.replace('holler-', '').replace(/--/g, ' / ');
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

const CADENCE_OPTIONS = ['1m', '5m', '15m'];

export default function WatchdogInt({ stewardId, color }: StewIntProps) {
  const [sessions, setSessions] = useState<WatchSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [, tick] = useState(0);
  const accentColor = color || '#D63031';

  // Tick every 10s to keep timestamps fresh
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 10000);
    return () => clearInterval(t);
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/watchdog');
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 10000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const updateSession = async (name: string, body: Record<string, unknown>) => {
    setActing(name);
    try {
      await fetch(`/api/watchdog?name=${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await fetchSessions();
    } catch {}
    setActing(null);
  };

  const watched = sessions.filter(s => s.enabled);
  const unwatched = sessions.filter(s => !s.enabled);
  const runningCount = watched.filter(s => s.status === 'running').length;

  if (loading) {
    return <div className="p-4 text-gray-500" style={{ fontFamily: 'VT323, monospace', fontSize: '18px' }}>Loading watchlist...</div>;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ fontFamily: 'VT323, monospace' }}>
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex items-center gap-3">
        <span style={{ fontSize: '22px' }}>🐕</span>
        <span style={{ color: accentColor, fontSize: '22px', fontWeight: 'bold' }}>WATCHDOG</span>
        <div className="flex-1" />
        <span style={{ fontSize: '16px', color: '#22c55e' }}>{runningCount}/{watched.length} up</span>
      </div>

      <div className="flex-1 overflow-auto">
        {/* Watched section header */}
        <div className="px-4 py-2 border-b border-gray-800/50" style={{ background: 'rgba(255,255,255,0.01)' }}>
          <span style={{ fontSize: '14px', color: '#888' }}>WATCHING ({watched.length})</span>
          <span style={{ fontSize: '12px', color: '#555', marginLeft: '8px' }}>Watchdog checks these on their cadence</span>
        </div>

        {watched.map(session => {
          const isActing = acting === session.name;
          const isRunning = session.status === 'running';

          return (
            <div key={session.name} className="border-b border-gray-800/50">
              <div className="flex items-center gap-3 px-4 py-3">
                {/* Status dot — shows if the actual session is running */}
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{
                    background: isRunning ? '#22c55e' : '#ef4444',
                    boxShadow: isRunning ? '0 0 6px #22c55e' : '0 0 6px #ef4444',
                  }}
                />

                {/* Name + info */}
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: '18px', color: '#fff' }}>
                    {shortName(session.name)}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span style={{ fontSize: '13px', color: isRunning ? '#22c55e' : '#ef4444' }}>
                      {isRunning ? 'running' : 'down'}
                    </span>
                    <span style={{ fontSize: '13px', color: '#555' }}>·</span>
                    <span style={{ fontSize: '13px', color: '#666' }}>
                      checked {timeAgo(session.lastChecked)}
                    </span>
                  </div>
                </div>

                {/* Watchdog controls only */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* Cadence */}
                  <select
                    value={session.cadence}
                    onChange={(e) => updateSession(session.name, { cadence: e.target.value })}
                    className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs"
                    style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: accentColor }}
                  >
                    {CADENCE_OPTIONS.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>

                  {/* Unwatch */}
                  <button
                    onClick={() => updateSession(session.name, { enabled: false })}
                    disabled={isActing}
                    title="Stop watching this session"
                    style={{
                      fontSize: '14px', padding: '4px 10px', borderRadius: '6px',
                      background: '#111', color: '#888',
                      border: '1px solid #333',
                      opacity: isActing ? 0.5 : 1,
                    }}
                  >
                    {isActing ? '...' : 'Unwatch'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {/* Unwatched section */}
        {unwatched.length > 0 && (
          <>
            <div className="px-4 py-2 border-b border-gray-800/50" style={{ background: 'rgba(255,255,255,0.01)' }}>
              <span style={{ fontSize: '14px', color: '#555' }}>NOT WATCHING ({unwatched.length})</span>
              <span style={{ fontSize: '12px', color: '#444', marginLeft: '8px' }}>Watchdog ignores these</span>
            </div>

            {unwatched.map(session => {
              const isActing = acting === session.name;
              const isRunning = session.status === 'running';

              return (
                <div key={session.name} className="border-b border-gray-800/30" style={{ opacity: 0.5 }}>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <div
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: isRunning ? '#555' : '#333' }}
                    />
                    <div className="flex-1 min-w-0">
                      <span style={{ fontSize: '16px', color: '#666' }}>{shortName(session.name)}</span>
                      {isRunning && <span style={{ fontSize: '12px', color: '#555', marginLeft: '8px' }}>running</span>}
                    </div>
                    <button
                      onClick={() => updateSession(session.name, { enabled: true })}
                      disabled={isActing}
                      style={{
                        fontSize: '14px', padding: '4px 10px', borderRadius: '6px',
                        background: `${accentColor}15`, color: accentColor,
                        border: `1px solid ${accentColor}40`,
                        opacity: isActing ? 0.5 : 1,
                      }}
                    >
                      {isActing ? '...' : 'Watch'}
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
