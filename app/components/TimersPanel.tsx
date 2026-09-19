'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import CronParser from 'cron-parser';

interface TimerState {
  last_run?: string;
  last_exit_code?: number;
  run_count?: number;
}

interface Timer {
  id: string;
  description?: string;
  cron?: string;
  script?: string;
  enabled?: boolean;
  state: TimerState;
}

interface StewardTimers {
  stewardId: string;
  owner: string | null;
  dir: string | null;
  exists: boolean;
  timers: Timer[];
  error?: string;
}

interface Props {
  stewardId: string;                // individual steward id, or "_all" for aggregated view
  color?: string;
  refreshMs?: number;                // default 7000
}

function nextRunFromCron(cron: string | undefined): string | null {
  if (!cron) return null;
  try {
    const iter = CronParser.parseExpression(cron);
    return iter.next().toDate().toISOString();
  } catch {
    return null;
  }
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const absSec = Math.abs(Math.round(diff / 1000));
  const sign = diff >= 0 ? '' : 'in ';
  const suffix = diff >= 0 ? ' ago' : '';
  if (absSec < 60) return `${sign}${absSec}s${suffix}`;
  if (absSec < 3600) return `${sign}${Math.floor(absSec / 60)}m${suffix}`;
  if (absSec < 86400) return `${sign}${Math.floor(absSec / 3600)}h${suffix}`;
  return `${sign}${Math.floor(absSec / 86400)}d${suffix}`;
}

function formatExitCode(code: number | undefined): { label: string; color: string } {
  if (code === undefined) return { label: '—', color: '#666' };
  if (code === 0) return { label: `✓ 0`, color: '#66FF66' };
  return { label: `✗ ${code}`, color: '#FF6666' };
}

export default function TimersPanel({ stewardId, color, refreshMs = 7000 }: Props) {
  const accent = color || '#FFAA00';
  const isAggregated = stewardId === '_all';
  const [data, setData] = useState<StewardTimers[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const fetchTimers = useCallback(async () => {
    try {
      const url = isAggregated
        ? '/api/steward-timers'
        : `/api/steward-timers/${encodeURIComponent(stewardId)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (isAggregated) {
        setData((json.stewards || []).filter((s: StewardTimers) => s.exists));
      } else {
        setData([json]);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [stewardId, isAggregated]);

  useEffect(() => {
    fetchTimers();
    const i = setInterval(fetchTimers, refreshMs);
    return () => clearInterval(i);
  }, [fetchTimers, refreshMs]);

  // Tick every second so relative times stay fresh.
  useEffect(() => {
    const i = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(i);
  }, []);

  const anyTimers = useMemo(() => data.some(s => s.timers.length > 0), [data]);

  if (loading) {
    return <div className="p-4" style={{ color: '#888', fontFamily: 'VT323, monospace', fontSize: '16px' }}>Loading timers...</div>;
  }

  if (error) {
    return (
      <div className="p-4" style={{ color: '#FF6666', fontFamily: 'VT323, monospace', fontSize: '16px' }}>
        Failed to load timers: {error}
      </div>
    );
  }

  if (!isAggregated && data.length === 1 && !data[0].exists) {
    return (
      <div className="p-4" style={{ color: '#888', fontFamily: 'VT323, monospace', fontSize: '16px' }}>
        <div style={{ color: accent, fontSize: '18px', letterSpacing: '1px', marginBottom: '8px' }}>NO TIMERS</div>
        <div>This steward has no <code style={{ color: '#FFAA00' }}>timers.json</code> file yet.</div>
        <div style={{ marginTop: '8px', fontSize: '14px', color: '#666' }}>
          Create one at <code>{data[0].dir || '(unknown dir)'}/timers.json</code> to declare timers.
        </div>
      </div>
    );
  }

  if (!anyTimers) {
    return (
      <div className="p-4" style={{ color: '#888', fontFamily: 'VT323, monospace', fontSize: '16px' }}>
        No timers declared.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto" style={{ background: '#0a0a0a' }}>
      {data.map(steward => (
        steward.timers.length > 0 && (
          <div key={steward.stewardId} style={{ borderBottom: '1px solid #222' }}>
            {isAggregated && (
              <div
                className="px-4 py-2"
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  fontFamily: 'VT323, monospace',
                  fontSize: '16px',
                  color: accent,
                  letterSpacing: '1px',
                  borderBottom: '1px solid #222',
                }}
              >
                {steward.owner || steward.stewardId} <span style={{ color: '#555' }}>· {steward.stewardId}</span>
              </div>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'VT323, monospace', fontSize: '14px' }}>
              <thead>
                <tr style={{ color: accent + 'AA', borderBottom: '1px solid #222' }}>
                  <th style={th}>id</th>
                  <th style={th}>description</th>
                  <th style={th}>cron</th>
                  <th style={th}>last run</th>
                  <th style={th}>next run</th>
                  <th style={th}>exit</th>
                  <th style={th}>runs</th>
                  <th style={th}>on</th>
                </tr>
              </thead>
              <tbody>
                {steward.timers.map(t => {
                  const next = nextRunFromCron(t.cron);
                  const exit = formatExitCode(t.state.last_exit_code);
                  return (
                    <tr key={`${steward.stewardId}-${t.id}`} data-tick={tick} style={{ borderBottom: '1px solid #161616', color: '#ddd' }}>
                      <td style={{ ...td, color: '#fff' }}>{t.id}</td>
                      <td style={{ ...td, color: '#aaa' }}>{t.description || ''}</td>
                      <td style={{ ...td, color: '#999', fontFamily: 'Menlo, monospace', fontSize: '12px' }}>{t.cron || '—'}</td>
                      <td style={td} title={t.state.last_run}>{formatRelative(t.state.last_run)}</td>
                      <td style={td} title={next || undefined}>{formatRelative(next)}</td>
                      <td style={{ ...td, color: exit.color }}>{exit.label}</td>
                      <td style={{ ...td, color: '#aaa' }}>{t.state.run_count ?? 0}</td>
                      <td style={{ ...td, color: t.enabled ? '#66FF66' : '#FF6666' }}>{t.enabled ? '✓' : '✗'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ))}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '6px 10px',
  textAlign: 'left',
  fontWeight: 'normal',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  fontSize: '11px',
};

const td: React.CSSProperties = {
  padding: '6px 10px',
  verticalAlign: 'top',
  whiteSpace: 'nowrap',
};
