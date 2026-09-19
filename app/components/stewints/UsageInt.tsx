'use client';

import { useState, useEffect, useCallback } from 'react';
import type { StewIntProps } from './StewIntLoader';

interface StewardUsage {
  name: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  estimated_cost: number;
  sessions: number;
  models: string[];
}

interface UsageReport {
  timeRange: string;
  generatedAt: string;
  totalCost: number;
  totalSessions: number;
  stewards: StewardUsage[];
}

type TimeRange = '24h' | '7d' | 'current';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n: number): string {
  return '$' + n.toFixed(2);
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

export default function UsageInt({ color }: StewIntProps) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<TimeRange>('24h');
  const accentColor = color || '#E8820C';

  const fetchUsage = useCallback(async (r: TimeRange) => {
    setLoading(true);
    setError(null);
    try {
      const params = r === 'current'
        ? 'current=true'
        : r === '7d'
        ? 'hours=168'
        : 'hours=24';
      const res = await fetch(`/api/token-usage?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setReport(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage(range);
    const interval = setInterval(() => fetchUsage(range), 60000);
    return () => clearInterval(interval);
  }, [range, fetchUsage]);

  const ranges: { key: TimeRange; label: string }[] = [
    { key: '24h', label: '24h' },
    { key: '7d', label: '7d' },
    { key: 'current', label: 'Active' },
  ];

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ fontFamily: 'VT323, monospace' }}>
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span style={{ fontSize: '22px' }}>📊</span>
          <span style={{ color: accentColor, fontSize: '22px', fontWeight: 'bold' }}>TOKEN USAGE</span>
        </div>
        {report && (
          <span style={{ fontSize: '13px', color: '#555' }}>
            {timeAgo(report.generatedAt)}
          </span>
        )}
      </div>

      {/* Time range selector */}
      <div className="flex-shrink-0 flex border-b border-gray-800">
        {ranges.map(r => {
          const isActive = range === r.key;
          return (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className="flex-1 py-2 text-center transition-colors"
              style={{
                fontSize: '16px',
                background: isActive ? accentColor : '#111',
                color: isActive ? '#000' : accentColor + '99',
              }}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      {/* Total cost banner */}
      {report && !loading && (
        <div
          className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex items-center justify-between"
          style={{ background: 'rgba(255,255,255,0.02)' }}
        >
          <div>
            <div style={{ fontSize: '32px', color: accentColor, lineHeight: 1 }}>
              {fmtCost(report.totalCost)}
            </div>
            <div style={{ fontSize: '14px', color: '#555', marginTop: '2px' }}>
              total estimated cost — {report.timeRange}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '20px', color: '#888' }}>
              {report.stewards.length}
            </div>
            <div style={{ fontSize: '13px', color: '#555' }}>
              stewards
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && !report && (
          <div className="p-8 text-center" style={{ fontSize: '18px', color: '#555' }}>
            Scanning session files...
          </div>
        )}

        {error && (
          <div className="p-4" style={{ fontSize: '16px', color: '#FF4444' }}>
            Error: {error}
          </div>
        )}

        {report && report.stewards.length === 0 && (
          <div className="p-8 text-center" style={{ fontSize: '18px', color: '#555' }}>
            No usage data for this time range
          </div>
        )}

        {report && report.stewards.map((s, i) => {
          const pct = report.totalCost > 0 ? (s.estimated_cost / report.totalCost) * 100 : 0;
          return (
            <div
              key={s.name}
              className="border-b border-gray-800/50 px-4 py-3"
              style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}
            >
              {/* Row 1: name + cost */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span style={{ fontSize: '14px', color: '#555', minWidth: '24px' }}>
                    #{i + 1}
                  </span>
                  <span
                    style={{
                      fontSize: '18px',
                      color: '#fff',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.name}
                  </span>
                </div>
                <span style={{ fontSize: '22px', color: accentColor, flexShrink: 0, marginLeft: '8px' }}>
                  {fmtCost(s.estimated_cost)}
                </span>
              </div>

              {/* Cost bar */}
              <div
                style={{
                  height: '3px',
                  background: '#222',
                  borderRadius: '2px',
                  marginTop: '6px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max(pct, 0.5)}%`,
                    background: accentColor,
                    borderRadius: '2px',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>

              {/* Row 2: token breakdown */}
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <span style={{ fontSize: '14px', color: '#888' }}>
                  in: {fmtTokens(s.input_tokens)}
                </span>
                <span style={{ fontSize: '14px', color: '#888' }}>
                  out: {fmtTokens(s.output_tokens)}
                </span>
                {s.cache_read_tokens > 0 && (
                  <span style={{ fontSize: '14px', color: '#666' }}>
                    cache: {fmtTokens(s.cache_read_tokens)}
                  </span>
                )}
                <span style={{ fontSize: '13px', color: '#555' }}>
                  {s.models.join(', ')}
                </span>
                <span style={{ fontSize: '13px', color: '#444' }}>
                  {s.sessions} sess
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
