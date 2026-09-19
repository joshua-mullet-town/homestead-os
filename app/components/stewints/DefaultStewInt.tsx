'use client';

import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StewIntProps } from './StewIntLoader';

interface DocTab {
  id: string;
  label: string;
  content: string;
}

const mdComponents = {
  h1: ({ children }: any) => <h1 className="text-2xl text-[#FFCC00] border-b border-[#FF6600] pb-2 mb-4">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-xl text-[#FFCC00] mt-6 mb-3">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-lg text-[#FF6600] mt-4 mb-2">{children}</h3>,
  h4: ({ children }: any) => <h4 className="text-base text-[#FF6600] mt-3 mb-2">{children}</h4>,
  p: ({ children }: any) => <p className="text-gray-300 mb-3 leading-relaxed">{children}</p>,
  li: ({ children }: any) => <li className="text-gray-300 ml-4">{children}</li>,
  ul: ({ children }: any) => <ul className="text-gray-300 mb-3 list-disc list-inside">{children}</ul>,
  ol: ({ children }: any) => <ol className="text-gray-300 mb-3 list-decimal list-inside">{children}</ol>,
  code: ({ children, className }: any) => {
    const isInline = !className;
    return isInline
      ? <code className="bg-gray-800 text-[#FF6600] px-1 rounded">{children}</code>
      : <code className="block bg-gray-900 p-3 rounded text-[#FF6600] overflow-x-auto">{children}</code>;
  },
  pre: ({ children }: any) => <pre className="bg-gray-900 p-3 rounded overflow-x-auto mb-4">{children}</pre>,
  strong: ({ children }: any) => <strong className="text-[#FFCC00]">{children}</strong>,
  em: ({ children }: any) => <em className="text-gray-300 italic">{children}</em>,
  a: ({ children, href }: any) => <a href={href} className="text-[#00FF66] underline">{children}</a>,
  blockquote: ({ children }: any) => <blockquote className="border-l-4 border-[#FF6600] pl-4 text-gray-400 italic my-3">{children}</blockquote>,
  hr: () => <hr className="border-gray-700 my-6" />,
  table: ({ children }: any) => (
    <div className="overflow-x-auto my-3 rounded-lg" style={{ border: '1px solid rgba(100,100,100,0.3)' }}>
      <table className="md-table w-full" style={{ borderCollapse: 'collapse' }}>{children}</table>
    </div>
  ),
  thead: ({ children }: any) => (
    <thead style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '2px solid rgba(255,204,0,0.2)' }}>{children}</thead>
  ),
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => (
    <tr style={{ borderBottom: '1px solid rgba(100,100,100,0.15)' }}>{children}</tr>
  ),
  th: ({ children }: any) => (
    <th className="text-left text-[#FFCC00] whitespace-nowrap" style={{ padding: '10px 14px', fontFamily: 'VT323, monospace', fontSize: '15px', borderRight: '1px solid rgba(100,100,100,0.15)' }}>{children}</th>
  ),
  td: ({ children }: any) => (
    <td className="text-gray-300" style={{ padding: '8px 14px', borderRight: '1px solid rgba(100,100,100,0.1)', lineHeight: '1.5' }}>{children}</td>
  ),
};

/**
 * DefaultStewInt — The default StewInt that renders markdown files from the steward directory.
 * This is identical in behavior to DocsTab in steward mode, but self-contained —
 * it fetches its own data instead of receiving it as props.
 *
 * Use this as a reference implementation for building custom StewInt components.
 */
export default function DefaultStewInt({ stewardId, color }: StewIntProps) {
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('CLAUDE.md');
  const [defaultTabResolved, setDefaultTabResolved] = useState(false);

  // Fetch steward config to check for defaultTab preference
  useEffect(() => {
    fetch('/api/stewards')
      .then(res => res.json())
      .then(data => {
        const steward = (data.stewards || []).find((s: any) =>
          s.id === stewardId || s.id === `steward-${stewardId}` || `steward-${s.id}` === stewardId
        );
        if (steward?.defaultTab) {
          setActiveTabId(steward.defaultTab);
        }
        setDefaultTabResolved(true);
      })
      .catch(() => setDefaultTabResolved(true));
  }, [stewardId]);

  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch(`/api/session/${stewardId}/docs?steward=${encodeURIComponent(stewardId)}`);
      if (!res.ok) return;
      const data = await res.json();
      const files: Record<string, string> = data.stewardFiles || {};

      const newTabs: DocTab[] = [];
      if (files['CLAUDE.md']) {
        newTabs.push({ id: 'CLAUDE.md', label: 'CLAUDE.md', content: files['CLAUDE.md'] });
      }
      for (const [name, content] of Object.entries(files).sort()) {
        if (name !== 'CLAUDE.md' && content) {
          newTabs.push({ id: name, label: name, content });
        }
      }
      setTabs(newTabs);
    } catch {
      // Silent fail
    }
  }, [stewardId]);

  useEffect(() => {
    fetchDocs();
    const interval = setInterval(fetchDocs, 30000);
    return () => clearInterval(interval);
  }, [fetchDocs]);

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];
  const accentColor = color || '#FF6600';

  return (
    <div className="h-full flex flex-col">
      {/* Tab Toggle — hidden when only one file */}
      {tabs.length > 1 && (
        <div className="flex-shrink-0 flex border-b border-gray-800">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className="flex-1 py-3 text-center transition-colors"
              style={{
                fontFamily: 'VT323, monospace',
                fontSize: tabs.length > 2 ? '12px' : undefined,
                background: activeTab?.id === tab.id ? accentColor : '#111',
                color: activeTab?.id === tab.id ? '#000' : accentColor,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {activeTab ? (
          <div className="prose prose-invert prose-orange max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {activeTab.content}
            </ReactMarkdown>
          </div>
        ) : (
          <div style={{ fontFamily: 'VT323, monospace', color: accentColor }}>Loading...</div>
        )}
      </div>
    </div>
  );
}
