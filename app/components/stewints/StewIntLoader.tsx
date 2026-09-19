'use client';

import { useState, useEffect, type ComponentType } from 'react';
import DefaultStewInt from './DefaultStewInt';

export interface StewIntProps {
  stewardId: string;
  stewIntName: string;
  color?: string;  // steward's color for consistent styling
}

// Registry of available StewInt components
// When adding a new StewInt, import it here and add to the map
const STEWINT_REGISTRY: Record<string, () => Promise<{ default: ComponentType<StewIntProps> }>> = {
  'DefaultStewInt': () => import('./DefaultStewInt'),
  'SchedulerInt': () => import('./SchedulerInt'),
  'BuildStewardInt': () => import('./BuildStewardInt'),
  'WatchdogInt': () => import('./WatchdogInt'),
  'FunnelInt': () => import('./FunnelInt'),
  'TodoStewInt': () => import('./TodoStewInt'),
  'OrgChartInt': () => import('./OrgChartInt'),
  'UsageInt': () => import('./UsageInt'),
  'TimersInt': () => import('./TimersInt'),
};

// Human-readable tab labels for stewInts
const STEWINT_LABELS: Record<string, string> = {
  'SchedulerInt': 'Scheduler',
  'UsageInt': 'Usage',
  'BuildStewardInt': 'Build',
  'WatchdogInt': 'Watchdog',
  'FunnelInt': 'Funnel',
  'TodoStewInt': 'Todos',
  'OrgChartInt': 'Org Chart',
  'TimersInt': 'Timers',
  'DefaultStewInt': 'Docs',
};

interface StewIntLoaderProps {
  stewIntName: string;  // supports comma-separated: "SchedulerInt,UsageInt"
  stewardId: string;
  color?: string;
  fallback: React.ReactNode;
}

export default function StewIntLoader({ stewIntName, stewardId, color, fallback }: StewIntLoaderProps) {
  // Parse comma-separated stewInt names
  const declaredNames = stewIntName.split(',').map(s => s.trim()).filter(Boolean);
  const [hasTimers, setHasTimers] = useState(false);
  const [components, setComponents] = useState<Record<string, ComponentType<StewIntProps>>>({});
  const [loadErrors, setLoadErrors] = useState<Set<string>>(new Set());
  const accentColor = color || '#FF6600';

  // Probe for timers.json — if present, auto-inject TimersInt into tabs even
  // when the steward.json doesn't declare it. Rooster owns the engine so ALWAYS
  // shows the aggregated Timers tab (TimersInt handles the _all view itself).
  useEffect(() => {
    let cancelled = false;
    if (stewardId === 'rooster') {
      setHasTimers(true);
      return () => { cancelled = true; };
    }
    fetch(`/api/steward-timers/${encodeURIComponent(stewardId)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setHasTimers(!!d?.exists); })
      .catch(() => { if (!cancelled) setHasTimers(false); });
    return () => { cancelled = true; };
  }, [stewardId]);

  // Effective list of stewInts to render: declared + auto-detected TimersInt if applicable.
  // Dedupe in case a steward both declares TimersInt AND has timers.json.
  const stewIntNames = (() => {
    const list = [...declaredNames];
    if (hasTimers && !list.includes('TimersInt')) list.push('TimersInt');
    return list;
  })();

  const [activeTab, setActiveTab] = useState<string>(stewIntNames[0] || 'docs');

  useEffect(() => {
    let cancelled = false;

    async function loadAll() {
      const loaded: Record<string, ComponentType<StewIntProps>> = {};
      const errors = new Set<string>();

      await Promise.all(
        stewIntNames.map(async (name) => {
          const loader = STEWINT_REGISTRY[name];
          if (!loader) {
            console.warn(`[StewInt] Component "${name}" not found in registry.`);
            errors.add(name);
            return;
          }
          try {
            const mod = await loader();
            loaded[name] = mod.default;
          } catch (err) {
            console.warn(`[StewInt] Failed to load "${name}":`, err);
            errors.add(name);
          }
        })
      );

      if (!cancelled) {
        setComponents(loaded);
        setLoadErrors(errors);
      }
    }

    loadAll();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stewIntName, hasTimers]);

  // All tabs: each stewInt name + docs
  const tabs = [...stewIntNames, 'docs'];

  // If all custom components failed to load, show fallback
  const allFailed = stewIntNames.length > 0 && stewIntNames.every(n => loadErrors.has(n));
  if (allFailed) {
    return <>{fallback}</>;
  }

  // Check if we're still loading (no components loaded yet and no errors)
  const stillLoading = Object.keys(components).length === 0 && loadErrors.size === 0;
  if (stillLoading) {
    return <div className="p-4 text-gray-500" style={{ fontFamily: 'VT323, monospace' }}>Loading StewInt...</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="flex-shrink-0 flex border-b border-gray-800">
        {tabs.map(tab => {
          const isActive = activeTab === tab;
          const label = tab === 'docs'
            ? 'CLAUDE.md'
            : STEWINT_LABELS[tab] || tab.replace(/Int$/, '').replace(/Steward/, '');
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="flex-1 py-1.5 text-center transition-colors text-xs"
              style={{
                fontFamily: 'VT323, monospace',
                fontSize: '13px',
                background: isActive ? accentColor : '#111',
                color: isActive ? '#000' : accentColor + '99',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'docs' ? (
          <DefaultStewInt stewardId={stewardId} stewIntName="DefaultStewInt" color={color} />
        ) : components[activeTab] ? (
          (() => {
            const Comp = components[activeTab];
            return <Comp stewardId={stewardId} stewIntName={activeTab} color={color} />;
          })()
        ) : loadErrors.has(activeTab) ? (
          <>{fallback}</>
        ) : (
          <div className="p-4 text-gray-500" style={{ fontFamily: 'VT323, monospace' }}>Loading...</div>
        )}
      </div>
    </div>
  );
}
