'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useSession, type SessionInfo, terminalThemes, type TerminalThemeKey } from '../context/SessionContext';
import { X, Terminal, MessageCircle, Palette, Plus, Minus, RefreshCw, Trash2, Server, GitBranch, Globe, FileText, Square, Eye, MoreHorizontal, ChevronUp, ChevronDown, Command, Wifi, WifiOff, XCircle, Bot, Keyboard } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useIsDesktop } from '../hooks/useMediaQuery';
import ConfirmModal from './ConfirmModal';
import { getSessionColor, getStatusColor, formatTimeSince, buildSessionAbbrevs } from './right-gutter/utils';
import type { ProjectInfo, ServerStatus, GitData, StewardData } from './right-gutter/types';
import StewardsSection from './right-gutter/StewardsSection';

const PHONE_API = 'http://100.84.84.102:8888';

function useIsNativeApp(): boolean {
  const [isNative, setIsNative] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsNative(params.get('native') === 'true');
  }, []);
  return isNative;
}

export default function RightGutter() {
  const router = useRouter();
  const pathname = usePathname();
  const isNativeApp = useIsNativeApp();
  const isDesktop = useIsDesktop();
  const {
    sessions, activeSession, setActiveSession, activeTab,
    terminalSettings, setTerminalSettings, setTerminalSettingsForSession,
    getStatusForSession, getStatusChangedAtForSession,
    triggerSessionRestart,
    isGutterCollapsed, setIsGutterCollapsed,
  } = useSession();

  const splitRatio = terminalSettings.desktopSplitRatio ?? 60;
  const isOnSessionPage = pathname?.startsWith('/session/');
  const gutterRightPosition = (isDesktop && isOnSessionPage) ? `calc(${100 - splitRatio}% + 26px)` : '0px';

  const buildSessionUrl = useCallback((path: string) => {
    return `${path}${isNativeApp ? '?native=true' : ''}`;
  }, [isNativeApp]);

  // === State ===
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [showSettings, setShowSettings] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean; title: string; message: string | React.ReactNode;
    confirmText: string; cancelText: string; confirmColor: 'red' | 'orange' | 'green' | 'purple';
    onConfirm: () => void; onCancel?: () => void;
  } | null>(null);
  const [, forceUpdate] = useState(0);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [gitData, setGitData] = useState<GitData | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [draggedSession, setDraggedSession] = useState<string | null>(null);
  const [editingAbbrev, setEditingAbbrev] = useState<string | null>(null);
  const [abbrevOverrides, setAbbrevOverrides] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      try { return JSON.parse(localStorage.getItem('homestead-abbrev-overrides') || '{}'); } catch { return {}; }
    }
    return {};
  });
  const [phoneConnected, setPhoneConnected] = useState(false);
  const [phoneChecking, setPhoneChecking] = useState(true);
  // Steward settings
  const [stewardSettings, setStewardSettings] = useState<StewardData | null>(null);
  const [editShorthand, setEditShorthand] = useState('');
  const [editIcon, setEditIcon] = useState('');
  const [editColor, setEditColor] = useState('');
  const [stewardSaving, setStewardSaving] = useState(false);
  const [stewardNames, setStewardNames] = useState<string[]>([]);
  const [showStewardPicker, setShowStewardPicker] = useState(false);
  const stewardButtonRef = useRef<HTMLButtonElement>(null);
  const stewardPickerRef = useRef<HTMLDivElement>(null);
  const sessionsButtonRef = useRef<HTMLButtonElement>(null);
  const [sessionsButtonRect, setSessionsButtonRect] = useState<DOMRect | null>(null);
  const [settingsButtonRect, setSettingsButtonRect] = useState<DOMRect | null>(null);

  // === Escape key ===
  const sendEscape = useCallback(() => {
    const vr = (window as any).__voiceRecorder;
    if (vr?.socketRef?.current && activeSession) {
      vr.socketRef.current.emit('tmux:input', activeSession, '\x1b');
    }
  }, [activeSession]);

  // === Timers ===
  useEffect(() => {
    const interval = setInterval(() => forceUpdate(n => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // === Session order ===
  useEffect(() => {
    const sessionNames = Array.from(sessions.keys());
    const savedOrder = localStorage.getItem('homestead-session-order');
    let savedOrderArray: string[] = [];
    if (savedOrder) { try { savedOrderArray = JSON.parse(savedOrder); } catch {} }
    const existingFromSaved = savedOrderArray.filter(name => sessionNames.includes(name));
    const newSessions = sessionNames.filter(name => !savedOrderArray.includes(name));
    setSessionOrder([...existingFromSaved, ...newSessions]);
  }, [sessions]);

  useEffect(() => {
    if (sessionOrder.length > 0) localStorage.setItem('homestead-session-order', JSON.stringify(sessionOrder));
  }, [sessionOrder]);

  // === Settings data ===
  useEffect(() => {
    if (showSettings) { fetchProjectInfo(showSettings); fetchGitData(showSettings); }
    else { setProjectInfo(null); setServerStatus(null); setGitData(null); }
  }, [showSettings]);

  const fetchProjectInfo = async (project: string) => {
    try { const r = await fetch(`/api/dev-server?project=${project}`); if (r.ok) { const d = await r.json(); setProjectInfo(d.project); setServerStatus(d.server); } } catch {}
  };
  const fetchGitData = async (project: string) => {
    try { const r = await fetch(`/api/session/${project}/git`); if (r.ok) { const d = await r.json(); setGitData(d); } } catch {}
  };

  // === Phone check ===
  useEffect(() => {
    (async () => {
      setPhoneChecking(true);
      try { const r = await fetch(`${PHONE_API}/health`, { method: 'GET', signal: AbortSignal.timeout(3000) }); setPhoneConnected(r.ok); } catch { setPhoneConnected(false); }
      setPhoneChecking(false);
    })();
  }, []);

  // === Stewards ===
  useEffect(() => {
    const f = () => { fetch('/api/stewards').then(r => r.json()).then(d => setStewardNames((d.stewards || []).map((s: any) => s.name))).catch(() => {}); };
    f(); const i = setInterval(f, 30000); return () => clearInterval(i);
  }, []);

  // === Steward session names (to hide from regular session icons) ===
  const [stewardSessionNames, setStewardSessionNames] = useState<Set<string>>(new Set());
  const [stewardBuildTails, setStewardBuildTails] = useState<Array<{ project: string; tail: string }>>([]);
  useEffect(() => {
    const f = () => {
      fetch('/api/stewards').then(r => r.json()).then(data => {
        const names = new Set<string>();
        const tails: Array<{ project: string; tail: string }> = [];
        for (const s of data.stewards || []) {
          names.add(`holler-${s.id}`);
          names.add(`holler-steward-${s.id}`);
          if (s.buildData?.project) {
            const proj = s.buildData.project;
            names.add(`holler-${proj}`);
            names.add(`holler-${proj.toLowerCase()}`);
            for (const b of s.buildData.builds || []) {
              if (b.status === 'active' && b.worktree) {
                const folder = b.worktree.split('/').pop() || '';
                names.add(`holler-${proj}--${folder}`);
                // Store tail for fuzzy matching (e.g. "gh-1427")
                const parts = folder.split('-');
                if (parts.length >= 2) {
                  tails.push({ project: proj, tail: parts.slice(-2).join('-') });
                }
              }
            }
          }
        }
        setStewardSessionNames(names);
        setStewardBuildTails(tails);
      }).catch(() => {});
    };
    f(); const i = setInterval(f, 30000); return () => clearInterval(i);
  }, []);

  useEffect(() => {
    if (!showStewardPicker) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!stewardButtonRef.current?.parentElement?.contains(t) && !stewardPickerRef.current?.contains(t)) setShowStewardPicker(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showStewardPicker]);

  // === Server controls ===
  const handleStartServer = async () => {
    if (!showSettings) return; setLoading(true);
    try { const r = await fetch('/api/dev-server', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: showSettings }) }); if (r.ok) await fetchProjectInfo(showSettings); } catch {}
    setLoading(false);
  };
  const handleStopServer = async () => {
    if (!showSettings) return; setLoading(true);
    try { const r = await fetch(`/api/dev-server?project=${showSettings}`, { method: 'DELETE' }); if (r.ok) await fetchProjectInfo(showSettings); } catch {}
    setLoading(false);
  };
  const handleRestartSession = async () => {
    if (!showSettings) return;
    const session = Array.from(sessions.values()).find(s => s.project === showSettings || s.name === showSettings || s.name === `holler-${showSettings}`);
    if (!session) return;
    setLoading(true);
    try {
      await fetch(`/api/sessions?session=${encodeURIComponent(session.name)}`, { method: 'DELETE' });
      await new Promise(r => setTimeout(r, 500));
      const body: Record<string, string> = { project: session.project, mode: 'continue' };
      if (session.worktree) { body.worktreePath = session.cwd; body.branch = session.worktree; }
      const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const d = await r.json(); alert(`Failed to restart: ${d.error}`); return; }
      triggerSessionRestart(); setShowSettings(null);
    } catch { alert('Failed to restart session'); }
    finally { setLoading(false); }
  };

  const handleDestroySession = () => {
    if (!showSettings) return;
    const session = Array.from(sessions.values()).find(s => s.project === showSettings || s.name === showSettings || s.name === `holler-${showSettings}`);
    if (!session) return;
    if (!session.worktree) {
      setConfirmModal({ isOpen: true, title: 'KILL SESSION', message: (<div><p>Kill tmux session for <span className="text-[#FF6600]">{session.project}</span>?</p><p className="text-gray-500 mt-2">This will only terminate the session.</p></div>), confirmText: 'KILL SESSION', cancelText: 'CANCEL', confirmColor: 'red',
        onConfirm: async () => { setConfirmModal(null); try { await fetch(`/api/sessions?session=${encodeURIComponent(session.name)}`, { method: 'DELETE' }); setShowSettings(null); if (activeSession === session.name) router.push('/'); } catch {} },
      });
      return;
    }
    setConfirmModal({ isOpen: true, title: 'DELETE WORKTREE', message: (<div><p>Delete worktree <span className="text-[#9966FF]">{session.worktree}</span>?</p><div className="mt-3 text-gray-400 text-base space-y-1"><p>• Kill the tmux session</p><p>• Delete files at:</p><p className="text-[#FFCC00] text-sm ml-2 break-all">{session.cwd}</p></div></div>), confirmText: 'DELETE', cancelText: 'CANCEL', confirmColor: 'red',
      onConfirm: () => { setConfirmModal(null); setConfirmModal({ isOpen: true, title: 'DELETE BRANCH?', message: (<div><p>Also delete git branch <span className="text-[#9966FF]">{session.worktree}</span>?</p><p className="text-gray-500 mt-2">Choose KEEP BRANCH to preserve it.</p></div>), confirmText: 'DELETE BRANCH', cancelText: 'KEEP BRANCH', confirmColor: 'purple', onConfirm: () => performWorktreeDestroy(session, true), onCancel: () => performWorktreeDestroy(session, false) }); },
    });
  };

  const performWorktreeDestroy = async (session: SessionInfo, deleteBranch: boolean) => {
    setConfirmModal(null); setLoading(true);
    try {
      await fetch(`/api/sessions?session=${encodeURIComponent(session.name)}`, { method: 'DELETE' });
      await fetch(`/api/worktrees?${new URLSearchParams({ path: session.cwd, deleteBranch: String(deleteBranch) })}`, { method: 'DELETE' });
      setShowSettings(null); if (activeSession === session.name) router.push('/');
    } catch {} finally { setLoading(false); }
  };

  // === Session click ===
  const handleSessionClick = useCallback((session: SessionInfo, buttonRect?: DOMRect) => {
    const isSameSession = session.name === activeSession;
    const urlParam = session.worktree ? session.name : session.project;
    const isOnTerminal = typeof window !== 'undefined' && (window.location.pathname === `/session/${urlParam}/terminal` || window.location.pathname === `/session/${urlParam}`);
    if (isSameSession && isOnTerminal) {
      if (buttonRect) setSettingsButtonRect(buttonRect);
      // Check if this is a steward session — if so, open steward settings
      const stewardId = session.name.replace(/^holler-(?:steward-)?/, '');
      fetch(`/api/stewards/${stewardId}/settings`).then(r => r.ok ? r.json() : null).then(data => {
        if (data && data.name) {
          const steward: StewardData = { id: stewardId, name: data.name, type: data.type, shorthand: data.shorthand, icon: data.icon, color: data.color };
          setStewardSettings(steward);
          setEditShorthand(steward.shorthand);
          setEditIcon(steward.icon || '');
          setEditColor(steward.color);
          setShowSettings(`steward:${stewardId}`);
        } else {
          setShowSettings(urlParam);
        }
        setShowSessionModal(false);
      }).catch(() => { setShowSettings(urlParam); setShowSessionModal(false); });
      return;
    }
    setActiveSession(session.name); router.push(buildSessionUrl(`/session/${urlParam}/terminal`)); setShowSessionModal(false);
  }, [activeSession, setActiveSession, router, buildSessionUrl]);

  // Substeward/worker click: force the CLICKED session to the tmux terminal view
  // (default-to-terminal, non-destructive — the gutter toggle can still flip it to
  // chat). Writes to the explicit session name because activeSession updates async.
  const handleSessionClickTerminal = useCallback((session: SessionInfo, buttonRect?: DOMRect) => {
    const isSameSession = session.name === activeSession;
    const urlParam = session.worktree ? session.name : session.project;
    const isOnTerminal = typeof window !== 'undefined' && (window.location.pathname === `/session/${urlParam}/terminal` || window.location.pathname === `/session/${urlParam}`);
    // Same-session re-click while already on its terminal → open settings (matches handleSessionClick).
    if (isSameSession && isOnTerminal) {
      handleSessionClick(session, buttonRect);
      return;
    }
    setTerminalSettingsForSession(session.name, { viewMode: 'terminal' });
    handleSessionClick(session, buttonRect);
  }, [activeSession, handleSessionClick, setTerminalSettingsForSession]);

  // === Build ordered sessions ===
  const allSessions: SessionInfo[] = [];
  sessionOrder.forEach(name => { const s = sessions.get(name); if (s) allSessions.push(s); });
  sessions.forEach((session, name) => { if (!sessionOrder.includes(name)) allSessions.push(session); });

  const isGuestSession = (s: SessionInfo) => s.name.startsWith('holler-guest-');
  const isStewardSession = (s: SessionInfo) => {
    if (stewardSessionNames.has(s.name)) return true;
    // Tail-match: session name may differ from worktree folder name
    // e.g. holler-GiveGrove--joshua-mullet-town-feature-gh-1427 matches tail "gh-1427"
    if (s.name.includes('--')) {
      const proj = s.name.replace('holler-', '').split('--')[0];
      return stewardBuildTails.some(t =>
        t.project.toLowerCase() === proj.toLowerCase() && s.name.includes(t.tail)
      );
    }
    return false;
  };
  const stewardSessions = allSessions.filter(isStewardSession);
  const orderedSessions = allSessions.filter(s => !isStewardSession(s) && !isGuestSession(s));
  const sessionAbbrevs = buildSessionAbbrevs(orderedSessions, abbrevOverrides);

  // === Keyboard shortcuts ===
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.altKey || orderedSessions.length < 2) return;
      const ci = orderedSessions.findIndex(s => s.name === activeSession);
      let target: SessionInfo | null = null;
      if (!e.shiftKey && e.code >= 'Digit1' && e.code <= 'Digit9') { e.preventDefault(); e.stopPropagation(); const i = parseInt(e.code.replace('Digit', '')) - 1; if (i < orderedSessions.length) target = orderedSessions[i]; }
      if (e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); target = orderedSessions[(ci - 1 + orderedSessions.length) % orderedSessions.length]; }
      else if (e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); target = orderedSessions[(ci + 1) % orderedSessions.length]; }
      if (target && target.name !== activeSession) handleSessionClick(target);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [orderedSessions, activeSession, handleSessionClick]);

  // === Early returns ===
  if (orderedSessions.length === 0 && stewardSessions.length === 0 && stewardSessionNames.size === 0) return null;
  if (pathname === '/guest' || pathname === '/no-access') return null;
  if (pathname?.startsWith('/stewint')) return null;

  // ========== RENDER ==========
  return (
    <>
      <div className="fixed bottom-0 z-40 flex flex-col items-center safe-area-bottom" style={{
        right: isNativeApp ? 'auto' : gutterRightPosition,
        left: isNativeApp ? '0px' : 'auto',
        paddingBottom: isNativeApp ? '120px' : '8px'
      }}>
        <div className={`flex flex-col items-center gap-1 p-1.5 transition-all duration-300 ease-in-out ${isNativeApp ? 'rounded-r-xl' : 'rounded-l-xl'}`} style={{ width: '52px', background: 'rgba(0, 0, 0, 0.25)', transform: isGutterCollapsed ? 'translateY(calc(100% - 52px))' : 'translateY(0)' }}>

          {/* Toggle */}
          <button onClick={() => setIsGutterCollapsed(!isGutterCollapsed)} className="w-10 h-8 flex items-center justify-center rounded-lg transition-all active:scale-95 mb-1" style={{ background: isGutterCollapsed ? 'rgba(255, 102, 0, 0.3)' : 'rgba(40, 40, 40, 0.6)', border: isGutterCollapsed ? '1px solid rgba(255, 102, 0, 0.5)' : '1px solid transparent' }}>
            {isGutterCollapsed ? <ChevronUp size={18} className="text-[#FF6600]" /> : <ChevronDown size={18} className="text-gray-400" />}
          </button>

          {/* Collapsible content */}
          <div className="flex flex-col items-center gap-1 transition-all duration-300 ease-in-out overflow-hidden" style={{ opacity: isGutterCollapsed ? 0 : 1, maxHeight: isGutterCollapsed ? 0 : '1000px', pointerEvents: isGutterCollapsed ? 'none' : 'auto' }}>

            {/* Phone indicator */}
            <div className="w-10 h-6 flex items-center justify-center rounded-lg mb-1" style={{ background: phoneConnected ? 'rgba(0, 255, 102, 0.15)' : 'rgba(255, 51, 51, 0.15)', border: `1px solid ${phoneConnected ? 'rgba(0, 255, 102, 0.3)' : 'rgba(255, 51, 51, 0.3)'}` }}>
              {phoneChecking ? <RefreshCw size={12} className="text-gray-400 animate-spin" /> : phoneConnected ? <Wifi size={12} className="text-[#00FF66]" /> : <WifiOff size={12} className="text-[#FF3333]" />}
            </div>

            <div className="w-8 h-px my-1" style={{ background: 'rgba(100, 100, 100, 0.4)' }} />

            {/* ESC */}
            <button onClick={sendEscape} disabled={!activeSession} className="w-10 h-6 flex items-center justify-center rounded-lg transition-all active:scale-95 mb-1" style={{ background: 'rgba(255, 204, 0, 0.15)', border: '1px solid rgba(255, 204, 0, 0.4)', opacity: activeSession ? 1 : 0.4 }} title="Send Escape key">
              <XCircle size={12} className="text-[#FFCC00]" />
            </button>

            {/* Keyboard input */}
            <button onClick={() => { const vr = (window as any).__voiceRecorder; if (vr) { if (vr.inputMode === 'keyboard') { vr.cancelKeyboardMode(); } else { vr.openKeyboard(); } } }} disabled={!activeSession} className="w-10 h-6 flex items-center justify-center rounded-lg transition-all active:scale-95 mb-1" style={{ background: 'rgba(51, 102, 255, 0.15)', border: '1px solid rgba(51, 102, 255, 0.4)', opacity: activeSession ? 1 : 0.4 }} title="Type a message">
              <Keyboard size={13} className="text-[#3366FF]" />
            </button>

            {/* Special keys */}
            <button onClick={(e) => { const vr = (window as any).__voiceRecorder; if (vr?.setShowSpecialKeys && vr?.setUtilitiesButtonRect) { vr.setUtilitiesButtonRect(e.currentTarget.getBoundingClientRect()); vr.setShowSpecialKeys(true); } }} className="w-10 h-6 flex items-center justify-center rounded-lg transition-all active:scale-95 mb-1" style={{ background: 'rgba(40, 40, 40, 0.6)' }}>
              <Command size={14} className="text-gray-500" />
            </button>

            {/* Session manager */}
            <button ref={sessionsButtonRef} onClick={() => { if (sessionsButtonRef.current) setSessionsButtonRect(sessionsButtonRef.current.getBoundingClientRect()); setShowSessionModal(true); }} className="w-10 h-6 flex items-center justify-center rounded-lg transition-colors mb-1" style={{ background: 'rgba(40, 40, 40, 0.6)' }}>
              <MoreHorizontal size={14} className="text-gray-500" />
            </button>

            {/* View mode toggle */}
            {activeSession && isOnSessionPage && (
              <button onClick={() => setTerminalSettings({ viewMode: terminalSettings.viewMode === 'terminal' ? 'chat' : 'terminal' })} className="w-10 h-6 flex items-center justify-center rounded-lg transition-all active:scale-95 mb-1" style={{ background: terminalSettings.viewMode === 'chat' ? 'rgba(0, 255, 102, 0.15)' : 'rgba(255, 102, 0, 0.15)', border: terminalSettings.viewMode === 'chat' ? '1px solid rgba(0, 255, 102, 0.3)' : '1px solid rgba(255, 102, 0, 0.3)' }}>
                {terminalSettings.viewMode === 'chat' ? <MessageCircle size={13} className="text-[#00FF66]" /> : <Terminal size={13} className="text-[#FF6600]" />}
              </button>
            )}

            {/* Stewards */}
            <div className="flex flex-col items-center gap-1 transition-all duration-300 ease-out">
              <StewardsSection isNativeApp={isNativeApp} onSessionClick={handleSessionClick} onSubSessionClick={handleSessionClickTerminal} onStewardSettings={(steward, rect) => {
                setStewardSettings(steward);
                setEditShorthand(steward.shorthand);
                setEditIcon(steward.icon || '');
                setEditColor(steward.color);
                setShowSettings(`steward:${steward.id}`);
                if (rect) setSettingsButtonRect(rect);
              }} />
            </div>

          </div>
        </div>
      </div>

      {/* Session Modal */}
      {showSessionModal && sessionsButtonRect && (
        <div className="fixed inset-0 z-50" onClick={() => setShowSessionModal(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="fixed overflow-hidden shadow-2xl" style={{ width: '288px', maxWidth: '85vw', maxHeight: 'min(70vh, 500px)', right: `calc(100vw - ${sessionsButtonRect.left}px + 8px)`, top: `${Math.min(Math.max(20, sessionsButtonRect.top - 100), window.innerHeight - Math.min(window.innerHeight * 0.7, 500) - 20)}px`, background: '#0a0a0a', borderRadius: '12px', border: '2px solid #FF660060' }} onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <span style={{ fontFamily: 'VT323, monospace' }} className="text-lg text-[#FF6600]">SESSIONS</span>
              <button onClick={() => setShowSessionModal(false)} className="p-1 hover:bg-gray-800 rounded transition-colors"><X size={18} className="text-gray-400" /></button>
            </div>
            <div className="overflow-y-auto max-h-[calc(70vh-60px)]">
              {orderedSessions.map((session, index) => {
                const isActive = session.name === activeSession; const status = getStatusForSession(session.name); const statusChangedAt = getStatusChangedAtForSession(session.name); const statusColor = getStatusColor(status); const sessionColor = getSessionColor(session.name); const abbrev = sessionAbbrevs.get(session.name) || '??';
                return (
                  <div key={session.name} draggable onDragStart={() => setDraggedSession(session.name)} onDragOver={e => { e.preventDefault(); if (!draggedSession || draggedSession === session.name) return; setSessionOrder(prev => { const n = [...prev]; const di = n.indexOf(draggedSession); const ti = n.indexOf(session.name); if (di === -1 || ti === -1) return prev; n.splice(di, 1); n.splice(ti, 0, draggedSession); return n; }); }} onDragEnd={() => setDraggedSession(null)} className={`flex items-center gap-2 px-4 py-3 transition-colors cursor-grab active:cursor-grabbing ${isActive ? 'bg-gray-800' : 'hover:bg-gray-800/50'} ${draggedSession === session.name ? 'opacity-50' : ''}`}>
                    <div className="flex flex-col gap-0.5 opacity-30"><div className="w-1 h-1 bg-gray-400 rounded-full" /><div className="w-1 h-1 bg-gray-400 rounded-full" /><div className="w-1 h-1 bg-gray-400 rounded-full" /></div>
                    <button onClick={e => handleSessionClick(session, e.currentTarget.getBoundingClientRect())} className="flex-1 flex items-center gap-3 text-left">
                      <div className="relative w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-lg" style={{ background: `linear-gradient(135deg, ${sessionColor}40 0%, ${sessionColor}20 100%)`, border: `2px solid ${sessionColor}` }}>
                        <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', fontWeight: 'bold', color: sessionColor }}>{abbrev}</span>
                        {index < 9 && <span className="absolute -bottom-1 -left-1 w-4 h-4 flex items-center justify-center rounded-full" style={{ fontFamily: 'VT323, monospace', fontSize: '11px', color: '#fff', background: 'rgba(40,40,40,0.9)', border: `1px solid ${isActive ? sessionColor : 'rgba(100,100,100,0.5)'}`, lineHeight: 1 }}>{index + 1}</span>}
                        <div className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-gray-900" style={{ background: statusColor }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold truncate" style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: isActive ? '#FF6600' : '#fff' }}>{session.project}</span>
                          {session.worktree && <span className="px-1.5 py-0.5 rounded text-xs" style={{ fontFamily: 'VT323, monospace', background: '#3366FF30', color: '#6699FF' }}>{session.worktree}</span>}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs" style={{ fontFamily: 'VT323, monospace', color: statusColor }}>{status === 'working' ? 'Working' : status === 'waiting' ? 'Waiting' : status === 'terminated' ? 'Terminated' : status === 'interrupted' ? 'Interrupted' : 'Idle'}</span>
                          <span style={{ fontFamily: 'VT323, monospace', fontSize: '12px', color: '#555' }}>{formatTimeSince(statusChangedAt)}</span>
                        </div>
                      </div>
                      {isActive && <div className="w-2 h-2 rounded-full bg-[#FF6600]" />}
                    </button>
                    <button onClick={e => { setSettingsButtonRect(e.currentTarget.getBoundingClientRect()); const urlParam = session.worktree ? session.name : session.project; setShowSettings(urlParam); setShowSessionModal(false); }} className="p-2 hover:bg-gray-700 rounded-lg transition-colors"><MoreHorizontal size={16} className="text-gray-400" /></button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Settings Panel — unified for sessions and stewards */}
      {showSettings && (
        <div className="fixed inset-0 z-[60]" onClick={() => { setShowSettings(null); setStewardSettings(null); }}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="fixed flex flex-col overflow-hidden shadow-2xl" style={{ width: '320px', maxWidth: '85vw', height: 'min(70vh, 600px)', maxHeight: 'calc(100vh - 40px)', right: settingsButtonRect ? `calc(100vw - ${settingsButtonRect.left}px + 8px)` : `calc(${gutterRightPosition} + 70px)`, top: settingsButtonRect ? `${Math.min(Math.max(20, settingsButtonRect.top - 150), window.innerHeight - Math.min(window.innerHeight * 0.7, 600) - 20)}px` : '20px', background: '#0a0a0a', borderRadius: '12px', border: `2px solid ${stewardSettings ? stewardSettings.color + '60' : '#FF660060'}` }} onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0 safe-area-top" style={{ borderColor: stewardSettings ? stewardSettings.color + '40' : '#FF660040' }}>
              {stewardSettings ? (
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 flex flex-col items-center justify-center rounded-lg" style={{ background: `linear-gradient(135deg, ${editColor}40 0%, ${editColor}20 100%)`, border: `2px solid ${editColor}` }}>
                    {editIcon && <span style={{ fontSize: '13px', lineHeight: 1 }}>{editIcon}</span>}
                    <span style={{ fontFamily: 'VT323, monospace', fontSize: editShorthand.length > 2 ? '11px' : '14px', fontWeight: 'bold', color: editColor, lineHeight: 1 }}>{editShorthand}</span>
                  </div>
                  <span style={{ fontFamily: 'VT323, monospace', color: stewardSettings.color }} className="text-xl">{stewardSettings.name}</span>
                </div>
              ) : (() => {
                const ss = Array.from(sessions.values()).find(s => s.project === showSettings || s.name === showSettings || s.name === `holler-${showSettings}`);
                const sa = ss ? (sessionAbbrevs.get(ss.name) || '??') : '??'; const sc = ss ? getSessionColor(ss.name) : '#FF6600';
                return (
                  <div className="flex items-center gap-3">
                    <div className="relative w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-lg cursor-pointer group" style={{ background: `linear-gradient(135deg, ${sc}40 0%, ${sc}20 100%)`, border: editingAbbrev === ss?.name ? '2px solid #FFCC00' : `2px solid ${sc}` }} onClick={() => ss && setEditingAbbrev(ss.name)}>
                      {editingAbbrev === ss?.name ? (
                        <input autoFocus maxLength={2} defaultValue={ss ? (abbrevOverrides[ss.name] || '') : ''} placeholder={sa} className="w-full h-full bg-transparent text-center outline-none" style={{ fontFamily: 'VT323, monospace', fontSize: '16px', fontWeight: 'bold', color: '#FFCC00', caretColor: '#FFCC00' }} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setEditingAbbrev(null); e.preventDefault(); } }} onBlur={e => { const v = e.target.value.trim(); const n = { ...abbrevOverrides }; if (v && ss) n[ss.name] = v; else if (ss) delete n[ss.name]; setAbbrevOverrides(n); localStorage.setItem('homestead-abbrev-overrides', JSON.stringify(n)); setEditingAbbrev(null); }} />
                      ) : (
                        <><span style={{ fontFamily: 'VT323, monospace', fontSize: '16px', fontWeight: 'bold', color: sc }}>{sa}</span><div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"><span style={{ fontFamily: 'VT323, monospace', fontSize: '10px', color: '#FFCC00' }}>EDIT</span></div></>
                      )}
                    </div>
                    <span style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FF6600]">{(showSettings || '').toUpperCase()}</span>
                  </div>
                );
              })()}
              <button onClick={() => { setShowSettings(null); setStewardSettings(null); }} className="p-2 hover:bg-gray-800 rounded-lg transition-colors"><X size={20} className="text-gray-400" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {stewardSettings ? (
                <>
                  {/* === STEWARD IDENTITY === */}
                  <div>
                    <div className="flex items-center gap-2 mb-2"><Bot size={14} className="text-gray-400" /><span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400">IDENTITY</span></div>
                    <div className="space-y-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-gray-500" style={{ fontFamily: 'VT323, monospace' }}>SHORTHAND (max 4)</span>
                        <input type="text" maxLength={4} value={editShorthand} onChange={e => setEditShorthand(e.target.value.toUpperCase())} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white outline-none focus:border-gray-500" style={{ fontFamily: 'VT323, monospace', fontSize: '16px', width: '80px' }} />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-gray-500" style={{ fontFamily: 'VT323, monospace' }}>ICON (emoji)</span>
                        <input type="text" value={editIcon} onChange={e => setEditIcon(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white outline-none focus:border-gray-500" style={{ fontSize: '16px', width: '60px' }} placeholder="🍋" />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-gray-500" style={{ fontFamily: 'VT323, monospace' }}>COLOR</span>
                        <div className="flex items-center gap-2">
                          <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)} className="w-8 h-8 rounded border-0 cursor-pointer" style={{ background: 'transparent' }} />
                          <input type="text" value={editColor} onChange={e => setEditColor(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-gray-500" style={{ fontFamily: 'VT323, monospace', fontSize: '14px', width: '90px' }} />
                        </div>
                      </label>
                      <button
                        onClick={async () => {
                          setStewardSaving(true);
                          try {
                            await fetch(`/api/stewards/${stewardSettings.id}/settings`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ shorthand: editShorthand, icon: editIcon || null, color: editColor }),
                            });
                          } catch {}
                          setStewardSaving(false);
                        }}
                        disabled={stewardSaving}
                        className="px-4 py-2 rounded-lg text-sm font-bold transition-colors"
                        style={{ fontFamily: 'VT323, monospace', background: editColor, color: '#000', opacity: stewardSaving ? 0.5 : 1 }}
                      >{stewardSaving ? 'SAVING...' : 'SAVE'}</button>
                    </div>
                  </div>

                  {/* === FONT SIZE === */}
                  <div>
                    <div className="flex items-center gap-2 mb-2"><Palette size={14} className="text-gray-400" /><span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400">DISPLAY</span></div>
                    <div className="flex items-center gap-3 p-2 bg-gray-800 rounded-lg">
                      <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400 w-20">Font Size</span>
                      <button onClick={() => setTerminalSettings({ fontSize: Math.max(10, terminalSettings.fontSize - 2) })} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors"><Minus size={14} className="text-white" /></button>
                      <span style={{ fontFamily: 'VT323, monospace' }} className="text-white w-12 text-center">{terminalSettings.fontSize}px</span>
                      <button onClick={() => setTerminalSettings({ fontSize: Math.min(28, terminalSettings.fontSize + 2) })} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors"><Plus size={14} className="text-white" /></button>
                    </div>
                  </div>

                  {/* === SLEEP ACTION === */}
                  <div className="space-y-2 pt-4 border-t border-gray-800">
                    <button onClick={async () => {
                      setLoading(true);
                      try {
                        const sessionName = `holler-${stewardSettings.id}`;
                        await fetch(`/api/sessions?session=${encodeURIComponent(sessionName)}`, { method: 'DELETE' });
                      } catch {}
                      setLoading(false);
                      setShowSettings(null);
                      setStewardSettings(null);
                    }} disabled={loading} className="w-full flex items-center justify-center gap-2 p-3 bg-gray-800 hover:bg-[#FFCC00] text-[#FFCC00] hover:text-black rounded-lg transition-colors disabled:opacity-50" style={{ fontFamily: 'VT323, monospace' }}>
                      <Eye size={18} /><span>SLEEP</span>
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* === REGULAR SESSION SETTINGS === */}
                  {/* Font size */}
                  <div>
                    <div className="flex items-center gap-2 mb-2"><Palette size={14} className="text-gray-400" /><span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400">DISPLAY</span></div>
                    <div className="flex items-center gap-3 p-2 bg-gray-800 rounded-lg">
                      <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400 w-20">Font Size</span>
                      <button onClick={() => setTerminalSettings({ fontSize: Math.max(10, terminalSettings.fontSize - 2) })} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors"><Minus size={14} className="text-white" /></button>
                      <span style={{ fontFamily: 'VT323, monospace' }} className="text-white w-12 text-center">{terminalSettings.fontSize}px</span>
                      <button onClick={() => setTerminalSettings({ fontSize: Math.min(28, terminalSettings.fontSize + 2) })} className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors"><Plus size={14} className="text-white" /></button>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="space-y-2 pt-4 border-t border-gray-800">
                    <button onClick={handleRestartSession} disabled={loading} className="w-full flex items-center justify-center gap-2 p-3 bg-gray-800 hover:bg-[#FFCC00] text-[#FFCC00] hover:text-black rounded-lg transition-colors disabled:opacity-50" style={{ fontFamily: 'VT323, monospace' }}><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /><span>RESTART --CONTINUE</span></button>
                    <button onClick={handleDestroySession} className="w-full flex items-center justify-center gap-2 p-3 bg-gray-800 hover:bg-[#FF3333] text-[#FF3333] hover:text-white rounded-lg transition-colors" style={{ fontFamily: 'VT323, monospace' }}><Trash2 size={18} /><span>{(() => { const s = Array.from(sessions.values()).find(s => s.project === showSettings || s.name === showSettings || s.name === `holler-${showSettings}`); return s?.worktree ? 'DELETE WORKTREE' : 'KILL SESSION'; })()}</span></button>
                  </div>
                </>
              )}
            </div>

            {/* Bottom view mode */}
            <div className="flex-shrink-0 border-t border-gray-800 bg-gray-900 p-4 safe-area-bottom">
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => { setTerminalSettings({ viewMode: 'terminal' }); setShowSettings(null); setStewardSettings(null); }} className={`flex items-center justify-center gap-2 p-3 rounded-lg transition-colors ${terminalSettings.viewMode === 'terminal' ? 'ring-2 ring-[#FF6600] bg-gray-800' : 'bg-gray-800/50 hover:bg-gray-800'}`}><Terminal size={18} className={terminalSettings.viewMode === 'terminal' ? 'text-[#FF6600]' : 'text-gray-400'} /><span style={{ fontFamily: 'VT323, monospace' }} className={terminalSettings.viewMode === 'terminal' ? 'text-[#FF6600]' : 'text-gray-400'}>Terminal</span></button>
                <button onClick={() => { setTerminalSettings({ viewMode: 'chat' }); setShowSettings(null); setStewardSettings(null); }} className={`flex items-center justify-center gap-2 p-3 rounded-lg transition-colors ${terminalSettings.viewMode === 'chat' ? 'ring-2 ring-[#00FF66] bg-gray-800' : 'bg-gray-800/50 hover:bg-gray-800'}`}><MessageCircle size={18} className={terminalSettings.viewMode === 'chat' ? 'text-[#00FF66]' : 'text-gray-400'} /><span style={{ fontFamily: 'VT323, monospace' }} className={terminalSettings.viewMode === 'chat' ? 'text-[#00FF66]' : 'text-gray-400'}>Chat</span></button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmModal && <ConfirmModal isOpen={confirmModal.isOpen} title={confirmModal.title} message={confirmModal.message} confirmText={confirmModal.confirmText} cancelText={confirmModal.cancelText} confirmColor={confirmModal.confirmColor} onConfirm={confirmModal.onConfirm} onCancel={confirmModal.onCancel || (() => setConfirmModal(null))} />}
    </>
  );
}
