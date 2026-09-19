'use client';

import { useState, useEffect, use } from 'react';
import StewIntLoader from '../../components/stewints/StewIntLoader';

interface StewardData {
  id: string;
  name: string;
  type: string;
  shorthand: string;
  icon?: string;
  color: string;
  stewInt?: string;
  buildData?: Record<string, unknown>;
}

export default function StewIntPage({ params }: { params: Promise<{ stewardId: string }> }) {
  const { stewardId } = use(params);
  const [steward, setSteward] = useState<StewardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stewards')
      .then(res => res.json())
      .then(data => {
        // Search top-level stewards
        let found = (data.stewards || []).find((s: StewardData) =>
          s.id === stewardId ||
          `steward-${s.id}` === stewardId ||
          s.id === `steward-${stewardId}` ||
          (s.buildData as any)?.project?.toLowerCase() === stewardId.toLowerCase()
        );

        // Search substewards if not found at top level
        if (!found) {
          const searchSubs = (subs: any[], parentPath: string): any => {
            for (const sub of subs) {
              const compositeId = `${parentPath}--${sub.id}`;
              if (compositeId === stewardId || sub.id === stewardId) {
                return { ...sub, id: compositeId };
              }
              if (sub.substewards) {
                const result = searchSubs(sub.substewards, compositeId);
                if (result) return result;
              }
            }
            return null;
          };
          for (const s of data.stewards || []) {
            if (s.substewards) {
              found = searchSubs(s.substewards, s.id);
              if (found) break;
            }
          }
        }

        setSteward(found || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [stewardId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#111] flex items-center justify-center">
        <span style={{ fontFamily: 'VT323, monospace', color: '#555', fontSize: '16px' }}>Loading...</span>
      </div>
    );
  }

  if (!steward) {
    return (
      <div className="min-h-screen bg-[#111] flex items-center justify-center">
        <span style={{ fontFamily: 'VT323, monospace', color: '#FF3333', fontSize: '16px' }}>Steward not found: {stewardId}</span>
      </div>
    );
  }

  const stewIntName = steward.stewInt || 'DefaultStewInt';

  return (
    <div className="min-h-screen bg-[#111] text-white overflow-auto" style={{ fontFamily: 'VT323, monospace' }}>
      <StewIntLoader
        stewIntName={stewIntName}
        stewardId={steward.id}
        color={steward.color}
        fallback={
          <div className="p-4 text-gray-500" style={{ fontFamily: 'VT323, monospace' }}>
            No custom StewInt for {steward.name}
          </div>
        }
      />
    </div>
  );
}
