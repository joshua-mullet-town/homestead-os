'use client';

import { useState, useEffect, useCallback } from 'react';
import type { StewIntProps } from './StewIntLoader';

interface TodoItem {
  id: string;
  text: string;
  added: string;
  notes: string;
}

interface TodoCategory {
  label: string;
  items: TodoItem[];
}

interface CompletedItem extends TodoItem {
  category: string;
  completed_at: string;
}

interface TodoData {
  version: number;
  categories: Record<string, TodoCategory>;
  completed: CompletedItem[];
}

function TodoRow({
  item,
  categorySlug,
  accent,
  onComplete,
  onRemove,
}: {
  item: TodoItem;
  categorySlug: string;
  accent: string;
  onComplete: (cat: string, id: string) => void;
  onRemove: (cat: string, id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [checked, setChecked] = useState(false);

  const handleCheck = () => {
    setChecked(!checked);
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px',
        borderRadius: '6px',
        background: checked
          ? 'rgba(80,200,80,0.08)'
          : hovered
            ? 'rgba(255,255,255,0.06)'
            : 'rgba(255,255,255,0.02)',
        transition: 'background 0.2s ease',
        cursor: 'pointer',
      }}
      onClick={handleCheck}
    >
      {/* Checkbox */}
      <div
        style={{
          width: '20px',
          height: '20px',
          border: `2px solid ${checked ? '#4ade80' : hovered ? accent : '#555'}`,
          borderRadius: '4px',
          background: checked ? '#4ade80' : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'all 0.2s ease',
          cursor: 'pointer',
        }}
      >
        {checked && (
          <span style={{ color: '#000', fontSize: '13px', fontWeight: 'bold', lineHeight: 1 }}>✓</span>
        )}
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          color: checked ? '#666' : '#e0e0e0',
          fontSize: '15px',
          textDecoration: checked ? 'line-through' : 'none',
          transition: 'all 0.3s ease',
        }}>
          {item.text}
        </div>
        {item.notes && !checked && (
          <div style={{ color: '#666', fontSize: '12px', marginTop: '2px' }}>{item.notes}</div>
        )}
      </div>

      {/* Remove button — visible on hover or after check. Moves item to completed. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onComplete(categorySlug, item.id);
        }}
        style={{
          opacity: (hovered || checked) ? 1 : 0,
          color: '#aaa',
          background: checked ? 'rgba(255,60,60,0.15)' : 'rgba(255,255,255,0.08)',
          border: `1px solid ${checked ? 'rgba(255,60,60,0.3)' : 'rgba(255,255,255,0.15)'}`,
          borderRadius: '4px',
          padding: '3px 10px',
          cursor: 'pointer',
          fontSize: '12px',
          flexShrink: 0,
          transition: 'opacity 0.15s ease',
          fontFamily: 'VT323, monospace',
          pointerEvents: (hovered || checked) ? 'auto' : 'none',
        }}
      >
        {checked ? 'remove' : 'done'}
      </button>
    </div>
  );
}

function CompletedRow({
  item,
  onRestore,
  onDelete,
}: {
  item: CompletedItem;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        borderRadius: '4px',
        background: hovered ? 'rgba(255,255,255,0.03)' : 'transparent',
        transition: 'background 0.15s ease',
      }}
    >
      <span style={{ color: '#4ade80', fontSize: '12px', flexShrink: 0 }}>✓</span>
      <span style={{ flex: 1, color: '#555', fontSize: '14px', textDecoration: 'line-through' }}>
        {item.text}
      </span>
      <button
        onClick={() => onRestore(item.id)}
        style={{
          opacity: hovered ? 1 : 0,
          color: '#4ade80',
          background: 'rgba(74,222,128,0.1)',
          border: '1px solid rgba(74,222,128,0.2)',
          borderRadius: '4px',
          padding: '2px 8px',
          cursor: 'pointer',
          fontSize: '11px',
          fontFamily: 'VT323, monospace',
          transition: 'opacity 0.15s ease',
          pointerEvents: hovered ? 'auto' : 'none',
        }}
      >
        restore
      </button>
      <button
        onClick={() => onDelete(item.id)}
        style={{
          opacity: hovered ? 1 : 0,
          color: '#666',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '13px',
          transition: 'opacity 0.15s ease',
          pointerEvents: hovered ? 'auto' : 'none',
        }}
      >
        ✕
      </button>
    </div>
  );
}

export default function TodoStewInt({ stewardId, color }: StewIntProps) {
  const [data, setData] = useState<TodoData | null>(null);
  const [error, setError] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const accent = color || '#F5D442';

  const apiUrl = `/api/stewards/${encodeURIComponent(stewardId)}/data?file=todos.json`;

  const fetchTodos = useCallback(async () => {
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) { setError(true); return; }
      const json = await res.json();
      setData(json);
      setError(false);
    } catch {
      setError(true);
    }
  }, [apiUrl]);

  useEffect(() => {
    fetchTodos();
    const interval = setInterval(fetchTodos, 15000);
    return () => clearInterval(interval);
  }, [fetchTodos]);

  const completeItem = async (category: string, itemId: string) => {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete', category, itemId }),
      });
      if (res.ok) {
        const updated = await res.json();
        setData(updated);
      }
    } catch { /* will recover on next poll */ }
  };

  const removeItem = async (category: string, itemId: string) => {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', category, itemId }),
      });
      if (res.ok) {
        const updated = await res.json();
        setData(updated);
      }
    } catch { /* will recover on next poll */ }
  };

  const removeCompleted = async (itemId: string) => {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove-completed', itemId }),
      });
      if (res.ok) {
        const updated = await res.json();
        setData(updated);
      }
    } catch { /* will recover on next poll */ }
  };

  const restoreItem = async (itemId: string) => {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', itemId }),
      });
      if (res.ok) {
        const updated = await res.json();
        setData(updated);
      }
    } catch { /* will recover on next poll */ }
  };

  if (error) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', fontFamily: 'VT323, monospace', color: '#FF4444' }}>
        Failed to load to-do list
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', fontFamily: 'VT323, monospace', color: accent }}>
        Loading...
      </div>
    );
  }

  const categories = Object.entries(data.categories);
  const totalItems = categories.reduce((sum, [, cat]) => sum + cat.items.length, 0);
  const completedCount = data.completed.length;

  return (
    <div style={{ height: '100%', overflow: 'auto', fontFamily: 'VT323, monospace' }}>
      {/* Header */}
      <div style={{ padding: '16px 16px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
          <span style={{ color: accent, fontSize: '22px' }}>TO-DO LIST</span>
          <span style={{ color: '#888', fontSize: '14px' }}>
            {totalItems} item{totalItems !== 1 ? 's' : ''}
          </span>
        </div>
        <div style={{ height: '2px', background: `linear-gradient(to right, ${accent}, transparent)` }} />
      </div>

      {/* Categories */}
      <div style={{ padding: '8px 16px' }}>
        {categories.map(([slug, category]) => {
          if (category.items.length === 0) return null;
          return (
            <div key={slug} style={{ marginBottom: '16px' }}>
              <div style={{ color: accent, fontSize: '16px', letterSpacing: '1px', marginBottom: '6px' }}>
                {category.label}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {category.items.map((item) => (
                  <TodoRow
                    key={item.id}
                    item={item}
                    categorySlug={slug}
                    accent={accent}
                    onComplete={completeItem}
                    onRemove={completeItem}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {/* Empty state */}
        {categories.every(([, cat]) => cat.items.length === 0) && (
          <div style={{ textAlign: 'center', padding: '32px 0', color: '#555', fontSize: '16px' }}>
            Nothing on the list. Nice.
          </div>
        )}
      </div>

      {/* Completed section */}
      {completedCount > 0 && (
        <div style={{ padding: '8px 16px', marginTop: '8px' }}>
          <button
            onClick={() => setShowCompleted(!showCompleted)}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: '4px 0',
              color: '#555',
              fontSize: '14px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'VT323, monospace',
            }}
          >
            {showCompleted ? '▾' : '▸'} {completedCount} completed
          </button>
          {showCompleted && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
              {data.completed.map((item) => (
                <CompletedRow key={item.id} item={item} onRestore={restoreItem} onDelete={removeCompleted} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{ padding: '12px 16px', marginTop: '8px', borderTop: '1px solid rgba(100,100,100,0.15)' }}>
        <div style={{ color: '#444', fontSize: '12px', textAlign: 'center' }}>
          Check off · Remove when done · Restore from completed · Tell Alfred to add items
        </div>
      </div>
    </div>
  );
}
