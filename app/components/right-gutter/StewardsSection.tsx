'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSession, type SessionInfo } from '../../context/SessionContext';
import { getStatusColor } from './utils';
import type { StewardData, SubstewardData } from './types';

interface StewardsSectionProps {
  onSessionClick: (session: SessionInfo, buttonRect?: DOMRect) => void;
  // Click handler for substewards/workers — forces the tmux terminal view.
  // Falls back to onSessionClick if not provided.
  onSubSessionClick?: (session: SessionInfo, buttonRect?: DOMRect) => void;
  onStewardSettings?: (steward: StewardData, buttonRect?: DOMRect) => void;
  isNativeApp?: boolean;
}

export default function StewardsSection({ onSessionClick, onSubSessionClick, onStewardSettings, isNativeApp }: StewardsSectionProps) {
  const openSubSession = onSubSessionClick ?? onSessionClick;
  const { sessions, activeSession, getStatusForSession } = useSession();
  const [stewards, setStewards] = useState<StewardData[]>([]);
  const [expandedSteward, setExpandedSteward] = useState<string | null>(null);
  const expandedButtonRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const miniIconsRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStewards = useCallback(() => {
    fetch('/api/stewards')
      .then(res => res.json())
      .then(data => setStewards(data.stewards || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchStewards();
    const interval = setInterval(fetchStewards, 30000);
    return () => clearInterval(interval);
  }, [fetchStewards]);

  // Close on outside click (mobile) or mouse leave area (desktop)
  useEffect(() => {
    if (!expandedSteward) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inButton = expandedButtonRef.current?.contains(target);
      const inFlyout = flyoutRef.current?.contains(target);
      const inMiniIcons = miniIconsRef.current?.contains(target);
      if (!inButton && !inFlyout && !inMiniIcons) {
        setExpandedSteward(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [expandedSteward]);

  const findSessionForBuild = useCallback((steward: StewardData, buildWorktree: string): SessionInfo | null => {
    // buildWorktree is the full path from builder.json (e.g. /Users/.../jmullet-feature-gh-1383)
    // Match against session.cwd (full path) or session.worktree (just the folder name)
    const buildFolder = buildWorktree.split('/').pop() || '';
    for (const [, session] of sessions) {
      if (session.project === steward.buildData?.project) {
        if (session.cwd === buildWorktree || session.cwd?.includes(buildFolder) || session.worktree === buildFolder) {
          return session;
        }
      }
    }
    return null;
  }, [sessions]);

  const findStewardSession = useCallback((steward: StewardData): SessionInfo | null => {
    // Check steward ID (lowercase) and project name (may be capitalized)
    const projectName = steward.buildData?.project;
    for (const [, session] of sessions) {
      if (session.name === `holler-steward-${steward.id}` || session.name === `holler-${steward.id}`
        || (projectName && session.name === `holler-${projectName}`)) {
        return session;
      }
    }
    return null;
  }, [sessions]);

  const findSubstewardSession = useCallback((sub: SubstewardData): SessionInfo | null => {
    // Substeward sessions use holler-{parentId}--{subId} naming
    for (const [, session] of sessions) {
      if (session.name === `holler-${sub.parentId}--${sub.id}`) {
        return session;
      }
    }
    return null;
  }, [sessions]);

  const openSettings = (steward: StewardData) => {
    setExpandedSteward(null);
    onStewardSettings?.(steward, expandedButtonRef.current?.getBoundingClientRect());
  };

  const openStewardConversation = async (steward: StewardData) => {
    const stewardSession = findStewardSession(steward);
    if (stewardSession) {
      onSessionClick(stewardSession);
    } else {
      try {
        const res = await fetch(`/api/stewards/${steward.id}/ensure-session`, { method: 'POST' });
        const data = await res.json();
        if (data.ok && data.sessionName) {
          setTimeout(() => {
            const session = Array.from(sessions.values()).find(s => s.name === data.sessionName);
            if (session) {
              onSessionClick(session);
            } else {
              window.location.href = `/session/${steward.id}`;
            }
          }, data.started ? 3000 : 500);
        }
      } catch {}
    }
    setExpandedSteward(null);
  };

  if (stewards.length === 0) return null;

  return (
    <>
      <div className="w-6 h-px my-1" style={{ background: 'rgba(0, 200, 255, 0.3)' }} />
      {stewards.map((steward) => {
        const isBuildSteward = steward.type === 'build' && steward.buildData;
        const activeBuilds = steward.buildData?.builds.filter(b => b.status === 'active') || [];
        const isExpanded = expandedSteward === steward.id;
        const stewardSession = findStewardSession(steward);
        const isActive = stewardSession?.name === activeSession ||
          activeBuilds.some(b => {
            const s = findSessionForBuild(steward, b.worktree);
            return s?.name === activeSession;
          });

        const buildSessions = activeBuilds
          .map(b => findSessionForBuild(steward, b.worktree))
          .filter((s): s is SessionInfo => s !== null);
        const substewardSessions = (steward.substewards || [])
          .map(sub => findSubstewardSession(sub))
          .filter((s): s is SessionInfo => s !== null);
        // Include steward's own session + substeward sessions in status calculation
        const allStewardSessions = stewardSession ? [stewardSession, ...buildSessions, ...substewardSessions] : [...buildSessions, ...substewardSessions];
        const hasWorking = allStewardSessions.some(s => getStatusForSession(s.name) === 'working');
        const hasWaiting = allStewardSessions.some(s => getStatusForSession(s.name) === 'waiting');
        const aggregateStatus = hasWorking ? 'working' : hasWaiting ? 'waiting' : 'idle';
        const dotColor = getStatusColor(aggregateStatus);
        const showDot = allStewardSessions.length > 0;

        return (
          <div
            key={steward.id}
            className="relative"
            // Desktop: hover to expand, mouse leave to collapse
            onMouseEnter={!isNativeApp ? () => {
              if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
              setExpandedSteward(steward.id);
            } : undefined}
            onMouseLeave={!isNativeApp ? () => {
              hoverTimeoutRef.current = setTimeout(() => setExpandedSteward(null), 200);
            } : undefined}
          >
            {/* Settings icon — appears above the button when expanded */}
            {isExpanded && (
              <div
                ref={miniIconsRef}
                className="absolute flex gap-1 items-center justify-center z-50"
                style={{ bottom: '100%', left: '50%', transform: 'translateX(-50%)', paddingBottom: 3 }}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); openSettings(steward); }}
                  className="w-7 h-7 flex items-center justify-center rounded-md transition-all hover:scale-110"
                  style={{
                    fontSize: '13px',
                    color: '#aaa',
                    background: 'rgba(30,30,30,0.95)',
                    border: '1px solid #444',
                  }}
                  title="Settings"
                >⚙</button>
              </div>
            )}

            <button
              ref={isExpanded ? expandedButtonRef : undefined}
              onClick={async () => {
                if (isNativeApp) {
                  // Mobile/APK: click toggles expand, double-click opens conversation
                  if (isExpanded) {
                    openStewardConversation(steward);
                  } else {
                    setExpandedSteward(steward.id);
                  }
                } else {
                  // Desktop: click always opens conversation (hover handles expand)
                  openStewardConversation(steward);
                }
              }}
              className="relative w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-200 active:scale-95"
              style={{
                background: isActive
                  ? `linear-gradient(135deg, ${steward.color}40 0%, ${steward.color}20 100%)`
                  : `linear-gradient(135deg, ${steward.color}20 0%, ${steward.color}10 100%)`,
                border: isActive || isExpanded
                  ? `2px solid ${steward.color}`
                  : `2px solid ${steward.color}40`,
                boxShadow: isActive ? `0 0 12px ${steward.color}50` : 'none',
              }}
            >
              <div className="flex flex-col items-center leading-none gap-0">
                {steward.icon && (
                  <span style={{ fontSize: '13px', lineHeight: 1 }}>{steward.icon}</span>
                )}
                <span style={{
                  fontFamily: 'VT323, monospace',
                  fontSize: steward.shorthand.length > 2 ? '11px' : '14px',
                  fontWeight: 'bold',
                  color: isActive ? steward.color : `${steward.color}99`,
                  lineHeight: 1,
                }}>
                  {steward.shorthand}
                </span>
              </div>
              {isBuildSteward && activeBuilds.length > 0 && (
                <span
                  className="absolute -bottom-1 -left-1 w-4 h-4 flex items-center justify-center rounded-full"
                  style={{
                    fontFamily: 'VT323, monospace',
                    fontSize: '11px',
                    color: '#fff',
                    background: 'rgba(40,40,40,0.9)',
                    border: `1px solid ${steward.color}60`,
                    lineHeight: 1,
                  }}
                >
                  {activeBuilds.length}
                </span>
              )}
              {showDot && (
                <div
                  className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full"
                  style={{
                    background: dotColor,
                    boxShadow: aggregateStatus !== 'idle' ? `0 0 6px ${dotColor}` : 'none',
                    animation: hasWorking ? 'pulse 1s ease-in-out infinite' : 'none',
                    border: '2px solid rgba(20, 20, 20, 0.8)',
                  }}
                />
              )}
            </button>

            {/* Flyout — shows when expanded (builds + substewards) */}
            {isExpanded && ((isBuildSteward && activeBuilds.length > 0) || (steward.substewards && steward.substewards.length > 0)) && expandedButtonRef.current && createPortal(
              <div
                ref={flyoutRef}
                className="fixed bg-gray-900 border rounded-lg shadow-xl overflow-hidden z-[9999]"
                style={{
                  borderColor: `${steward.color}40`,
                  bottom: window.innerHeight - expandedButtonRef.current!.getBoundingClientRect().bottom,
                  right: window.innerWidth - expandedButtonRef.current!.getBoundingClientRect().left + 8,
                  minWidth: '200px',
                  maxHeight: '70vh',
                  overflowY: 'auto',
                  boxShadow: `0 4px 20px rgba(0, 0, 0, 0.5), 0 0 15px ${steward.color}15`,
                }}
                onMouseEnter={!isNativeApp ? () => {
                  if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                } : undefined}
                onMouseLeave={!isNativeApp ? () => {
                  hoverTimeoutRef.current = setTimeout(() => setExpandedSteward(null), 200);
                } : undefined}
              >
                <div className="px-3 py-1.5 border-b border-gray-800 flex items-center gap-2">
                  <span className="text-xs font-bold" style={{ fontFamily: 'VT323, monospace', color: steward.color }}>
                    {steward.name}
                  </span>
                </div>
                {/* Substewards */}
                {(steward.substewards || []).map((sub) => {
                  const subSession = findSubstewardSession(sub);
                  const isSubActive = subSession?.name === activeSession;
                  const subStatus = subSession ? getStatusForSession(subSession.name) : 'idle';
                  const subStatusColor = getStatusColor(subStatus);
                  const isSubWorking = subStatus === 'working';

                  return (
                    <button
                      key={sub.id}
                      onClick={() => {
                        if (subSession) {
                          openSubSession(subSession);
                          setExpandedSteward(null);
                        }
                      }}
                      disabled={!subSession}
                      className={`w-full flex items-center gap-2 px-3 py-2 transition-colors ${
                        isSubActive ? 'bg-opacity-20' : 'hover:bg-gray-800'
                      } ${!subSession ? 'opacity-50' : ''}`}
                      style={isSubActive ? { backgroundColor: `${sub.color}20` } : undefined}
                    >
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{
                          background: subSession ? subStatusColor : '#333',
                          boxShadow: subSession && subStatus !== 'idle' ? `0 0 4px ${subStatusColor}` : 'none',
                          animation: isSubWorking ? 'pulse 1s ease-in-out infinite' : 'none',
                        }}
                      />
                      <div className="flex-1 min-w-0 text-left flex items-center gap-1.5">
                        {sub.icon && <span style={{ fontSize: '13px' }}>{sub.icon}</span>}
                        <span
                          className={`text-sm truncate block ${isSubActive ? '' : 'text-gray-300'}`}
                          style={{
                            fontFamily: 'VT323, monospace',
                            fontSize: '15px',
                            color: isSubActive ? sub.color : undefined,
                          }}
                        >
                          {sub.name}
                        </span>
                      </div>
                    </button>
                  );
                })}
                {/* Builds */}
                {isBuildSteward && activeBuilds.length > 0 && activeBuilds.map((build) => {
                  const buildSession = findSessionForBuild(steward, build.worktree);
                  const isBuildActive = buildSession?.name === activeSession;
                  const status = buildSession ? getStatusForSession(buildSession.name) : 'idle';
                  const statusColor = getStatusColor(status);
                  const isWorking = status === 'working';
                  const branchLabel = build.branch
                    .replace(/^joshua-mullet-town\//, '')
                    .replace(/^(feature|bugfix|hotfix|fix)\//, '');

                  return (
                    <button
                      key={build.branch}
                      onClick={() => {
                        if (buildSession) {
                          openSubSession(buildSession);
                          setExpandedSteward(null);
                        }
                      }}
                      disabled={!buildSession}
                      className={`w-full flex items-center gap-2 px-3 py-2 transition-colors ${
                        isBuildActive ? 'bg-opacity-20' : 'hover:bg-gray-800'
                      } ${!buildSession ? 'opacity-50' : ''}`}
                      style={isBuildActive ? { backgroundColor: `${steward.color}20` } : undefined}
                    >
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{
                          background: buildSession ? statusColor : '#333',
                          boxShadow: buildSession && status !== 'idle' ? `0 0 4px ${statusColor}` : 'none',
                          animation: isWorking ? 'pulse 1s ease-in-out infinite' : 'none',
                        }}
                      />
                      <div className="flex-1 min-w-0 text-left">
                        <span
                          className={`text-sm truncate block ${isBuildActive ? '' : 'text-gray-300'}`}
                          style={{
                            fontFamily: 'VT323, monospace',
                            fontSize: '15px',
                            color: isBuildActive ? steward.color : undefined,
                          }}
                        >
                          {branchLabel}
                        </span>
                        {!buildSession && (
                          <span className="text-xs text-gray-600" style={{ fontFamily: 'VT323, monospace' }}>No session</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>,
              document.body
            )}
          </div>
        );
      })}
    </>
  );
}
