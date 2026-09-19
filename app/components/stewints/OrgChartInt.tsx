'use client';

import { useState, useEffect } from 'react';
import type { StewIntProps } from './StewIntLoader';

interface Steward {
  id: string;
  name: string;
  type: string;
  shorthand: string;
  icon?: string | null;
  color: string;
  domain?: string;
  stewInt?: string | null;
  substewards?: Steward[];
}

function StewardNode({ steward, depth = 0 }: { steward: Steward; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasSubs = steward.substewards && steward.substewards.length > 0;
  const indent = depth * 20;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 px-2 rounded cursor-default hover:bg-white/5 transition-colors"
        style={{ marginLeft: indent }}
        onClick={() => hasSubs && setExpanded(!expanded)}
      >
        {/* Expand/collapse indicator */}
        <span className="w-3 text-center text-[11px] opacity-40" style={{ fontFamily: 'VT323, monospace' }}>
          {hasSubs ? (expanded ? '▾' : '▸') : '·'}
        </span>

        {/* Icon */}
        <span className="text-sm">{steward.icon || '○'}</span>

        {/* Name + shorthand */}
        <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: steward.color }}>
          {steward.name}
        </span>
        <span style={{ fontFamily: 'VT323, monospace', fontSize: '11px', opacity: 0.4 }}>
          [{steward.shorthand}]
        </span>

        {/* Type badge */}
        <span
          className="px-1 rounded"
          style={{
            fontFamily: 'VT323, monospace',
            fontSize: '10px',
            background: steward.type === 'build' ? '#00FF6622' : steward.type === 'manager' ? '#FFB30022' : '#ffffff11',
            color: steward.type === 'build' ? '#00FF66' : steward.type === 'manager' ? '#FFB300' : '#888',
          }}
        >
          {steward.type}
        </span>
      </div>

      {/* Domain description for substewards */}
      {depth > 0 && steward.domain && (
        <div
          className="opacity-30 truncate"
          style={{ marginLeft: indent + 28, fontFamily: 'VT323, monospace', fontSize: '11px', maxWidth: '300px' }}
          title={steward.domain}
        >
          {steward.domain}
        </div>
      )}

      {/* Substewards */}
      {hasSubs && expanded && (
        <div>
          {steward.substewards!.map(sub => (
            <StewardNode key={sub.id} steward={sub} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function OrgChartInt({ color }: StewIntProps) {
  const [stewards, setStewards] = useState<Steward[]>([]);
  const [loading, setLoading] = useState(true);
  const accentColor = color || '#FFB300';

  useEffect(() => {
    fetch('/api/stewards')
      .then(res => res.json())
      .then(data => {
        setStewards(data.stewards || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Count all stewards recursively
  const countAll = (list: Steward[]): number =>
    list.reduce((n, s) => n + 1 + (s.substewards ? countAll(s.substewards) : 0), 0);

  const total = countAll(stewards);
  const topLevel = stewards.length;
  const withSubs = stewards.filter(s => s.substewards && s.substewards.length > 0).length;

  if (loading) {
    return (
      <div className="p-4" style={{ fontFamily: 'VT323, monospace', color: '#555' }}>
        Loading org chart...
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-3">
      {/* Header stats */}
      <div className="flex gap-4 mb-3 pb-2 border-b border-gray-800">
        <div style={{ fontFamily: 'VT323, monospace', fontSize: '12px', color: accentColor }}>
          {total} total
        </div>
        <div style={{ fontFamily: 'VT323, monospace', fontSize: '12px', opacity: 0.4 }}>
          {topLevel} top-level
        </div>
        <div style={{ fontFamily: 'VT323, monospace', fontSize: '12px', opacity: 0.4 }}>
          {withSubs} with teams
        </div>
      </div>

      {/* Org tree */}
      <div>
        {stewards.map(s => (
          <StewardNode key={s.id} steward={s} depth={0} />
        ))}
      </div>
    </div>
  );
}
