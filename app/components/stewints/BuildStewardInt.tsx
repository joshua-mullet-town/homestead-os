'use client';

import { useState, useEffect, useCallback } from 'react';
import type { StewIntProps } from './StewIntLoader';

interface Build {
  branch: string;
  worktree: string;
  issue?: string;
  created: string;
  status: 'active' | 'archived';
  archivedAt?: string;
}

interface BuildData {
  project: string;
  codeDir: string;
  worktreeDir: string;
  builds: Build[];
}

interface StewardInfo {
  id: string;
  name: string;
  color: string;
  buildData?: BuildData;
}

interface SessionStatus {
  status: 'working' | 'waiting' | 'idle';
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function extractCurrentStep(planMd: string): string | null {
  // Look for ## Current section, then extract the step title
  const currentMatch = planMd.match(/## Current\s*\n+###\s+(?:Step \d+:\s*)?(.+)/);
  if (currentMatch) return currentMatch[1].trim();
  // Fallback: look for the first unchecked item
  const unchecked = planMd.match(/- \[ \]\s+(.+)/);
  if (unchecked) return unchecked[1].trim();
  // Check if all done
  if (planMd.includes('All steps completed')) return 'All steps completed';
  return null;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'working': return '#FFCC00';
    case 'waiting': return '#00FF66';
    default: return '#555';
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'working': return 'Working';
    case 'waiting': return 'Waiting';
    default: return 'Offline';
  }
}

export default function BuildStewardInt({ stewardId, color }: StewIntProps) {
  const [steward, setSteward] = useState<StewardInfo | null>(null);
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, SessionStatus>>({});
  const [planSteps, setPlanSteps] = useState<Record<string, string | null>>({});
  const [showArchived, setShowArchived] = useState(false);
  const accentColor = color || '#FF6600';

  // Fetch steward data
  const fetchSteward = useCallback(async () => {
    try {
      const res = await fetch('/api/stewards');
      if (!res.ok) return;
      const data = await res.json();
      const found = (data.stewards || []).find((s: any) => s.id === stewardId);
      if (found) setSteward(found);
    } catch {}
  }, [stewardId]);

  // Fetch session statuses
  const fetchStatuses = useCallback(async () => {
    try {
      const res = await fetch('/api/session-status');
      if (!res.ok) return;
      const data = await res.json();
      setSessionStatuses(data.statuses || {});
    } catch {}
  }, []);

  // Fetch PLAN.md for each active build
  const fetchPlans = useCallback(async () => {
    if (!steward?.buildData) return;
    const activeBuilds = steward.buildData.builds.filter(b => b.status === 'active');
    const project = steward.buildData.project;

    const plans: Record<string, string | null> = {};
    await Promise.all(activeBuilds.map(async (build) => {
      const worktreeFolder = build.worktree.split('/').pop() || '';
      try {
        const res = await fetch(`/api/session/${project}/docs?worktree=${encodeURIComponent(worktreeFolder)}`);
        if (res.ok) {
          const data = await res.json();
          plans[build.branch] = data.plan ? extractCurrentStep(data.plan) : null;
        }
      } catch {}
    }));
    setPlanSteps(plans);
  }, [steward]);

  useEffect(() => {
    fetchSteward();
    fetchStatuses();
    const i1 = setInterval(fetchSteward, 30000);
    const i2 = setInterval(fetchStatuses, 5000);
    return () => { clearInterval(i1); clearInterval(i2); };
  }, [fetchSteward, fetchStatuses]);

  useEffect(() => {
    fetchPlans();
    const i = setInterval(fetchPlans, 30000);
    return () => clearInterval(i);
  }, [fetchPlans]);

  if (!steward?.buildData) {
    return <div className="p-4 text-gray-500" style={{ fontFamily: 'VT323, monospace' }}>Loading builds...</div>;
  }

  const activeBuilds = steward.buildData.builds.filter(b => b.status === 'active');
  const archivedBuilds = steward.buildData.builds.filter(b => b.status === 'archived');
  const project = steward.buildData.project;

  // Find session name for a build
  const getSessionName = (build: Build): string => {
    const folder = build.worktree.split('/').pop() || '';
    return `holler-${project}--${folder}`;
  };

  const getSessionStatus = (build: Build): string => {
    const sessionName = getSessionName(build);
    // Try exact match first, then check all keys for tail match
    if (sessionStatuses[sessionName]) return sessionStatuses[sessionName].status;
    const folder = build.worktree.split('/').pop() || '';
    const parts = folder.split('-');
    const tail = parts.slice(-2).join('-');
    for (const [name, status] of Object.entries(sessionStatuses)) {
      if (name.includes(tail) && name.includes(project)) return status.status;
    }
    return 'idle';
  };

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ fontFamily: 'VT323, monospace' }}>
      {/* Header */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold" style={{ color: accentColor }}>BUILDS</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: accentColor + '99' }}>{activeBuilds.length} active</span>
          {archivedBuilds.length > 0 && (
            <span className="text-xs text-gray-600">{archivedBuilds.length} archived</span>
          )}
        </div>
      </div>

      {/* Active Builds */}
      <div className="flex-1 overflow-auto">
        {activeBuilds.map(build => {
          const status = getSessionStatus(build);
          const statusColor = getStatusColor(status);
          const currentStep = planSteps[build.branch];
          const branchLabel = build.branch
            .replace(/^joshua-mullet-town\//, '')
            .replace(/^jmullet\//, '')
            .replace(/^(feature|bugfix|hotfix|fix)\//, '');

          return (
            <div key={build.branch} className="border-b border-gray-800/50 px-3 py-3">
              {/* Branch + Status */}
              <div className="flex items-center gap-2 mb-1">
                <div
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{
                    background: statusColor,
                    boxShadow: status !== 'idle' ? `0 0 4px ${statusColor}` : 'none',
                    animation: status === 'working' ? 'pulse 1s ease-in-out infinite' : 'none',
                  }}
                />
                <span className="text-sm font-bold" style={{ color: '#fff', fontSize: '16px' }}>
                  {branchLabel}
                </span>
                <span className="text-xs ml-auto" style={{ color: statusColor }}>
                  {getStatusLabel(status)}
                </span>
              </div>

              {/* Issue */}
              {build.issue && (
                <div className="text-xs text-gray-500 mb-1 ml-4">
                  {build.issue}
                </div>
              )}

              {/* Current Plan Step */}
              {currentStep && (
                <div className="ml-4 mt-1 px-2 py-1 rounded" style={{ background: `${accentColor}10`, borderLeft: `2px solid ${accentColor}40` }}>
                  <span className="text-xs text-gray-500">Current: </span>
                  <span className="text-xs" style={{ color: accentColor }}>
                    {currentStep.length > 80 ? currentStep.slice(0, 80) + '...' : currentStep}
                  </span>
                </div>
              )}

              {/* Created */}
              <div className="text-xs text-gray-600 ml-4 mt-1">
                Created {timeSince(build.created)}
              </div>
            </div>
          );
        })}

        {activeBuilds.length === 0 && (
          <div className="p-4 text-center text-gray-600 text-sm">No active builds</div>
        )}

        {/* Archived Section */}
        {archivedBuilds.length > 0 && (
          <div className="border-t border-gray-800">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-800/30 transition-colors"
            >
              <span className="text-xs text-gray-500">{showArchived ? '▼' : '▶'}</span>
              <span className="text-xs text-gray-500">Archived ({archivedBuilds.length})</span>
            </button>
            {showArchived && archivedBuilds.map(build => {
              const branchLabel = build.branch
                .replace(/^joshua-mullet-town\//, '')
                .replace(/^jmullet\//, '')
                .replace(/^(feature|bugfix|hotfix|fix)\//, '');
              return (
                <div key={build.branch} className="px-3 py-2 border-b border-gray-800/30 ml-4">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-gray-700 flex-shrink-0" />
                    <span className="text-xs text-gray-600">{branchLabel}</span>
                    {build.archivedAt && (
                      <span className="text-xs text-gray-700 ml-auto">{timeSince(build.archivedAt)}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
