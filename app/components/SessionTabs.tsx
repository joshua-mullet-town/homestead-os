'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession, type SessionInfo, type ClaudeSessionStatus, terminalThemes, type TerminalThemeKey } from '../context/SessionContext';
import { Play, Square, RotateCcw, ExternalLink, X, Server, Terminal, FileText, GitBranch, Globe, Trash2, Plus, Minus, Palette, MessageCircle, ChevronDown, ChevronRight, RefreshCw, Bell } from 'lucide-react';

interface ProjectInfo {
  name: string;
  path: string;
  type: 'nextjs' | 'node' | 'other';
  hasDevScript: boolean;
  devPort?: number;
}

interface ServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
}

interface GitData {
  branch: string;
  files: { file: string; status: string; additions: number; deletions: number }[];
  summary: {
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
  };
}

// Format time like Whisper Village: "5s", "2m35s", "1h02m"
function formatTimeSince(date: Date | null): string {
  if (!date) return '—';

  const now = new Date();
  const elapsed = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (elapsed < 0) return '—';

  const seconds = elapsed % 60;
  const minutes = Math.floor(elapsed / 60) % 60;
  const hours = Math.floor(elapsed / 3600);

  if (hours > 0) {
    return `${hours}h${minutes.toString().padStart(2, '0')}m`;
  } else if (minutes > 0) {
    return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  } else {
    return `${seconds}s`;
  }
}

// Get status color like Whisper Village
function getStatusColor(status: ClaudeSessionStatus): string {
  switch (status) {
    case 'working':
      return '#FFCC00'; // Yellow - agent processing
    case 'waiting':
      return '#00FF66'; // Green - ready for user
    case 'terminated':
      return '#FF3333'; // Red - session ended
    case 'interrupted':
      return '#FF6633'; // Orange - stale/interrupted
    case 'idle':
    default:
      return '#666666'; // Gray - no session
  }
}

export default function SessionTabs() {
  const router = useRouter();
  const { sessions, activeSession, setActiveSession, activeTab, triggerTerminalFocus, setActiveTab, terminalSettings, setTerminalSettings, getStatusForSession, getStatusChangedAtForSession, triggerSessionRestart } = useSession();
  const [, forceUpdate] = useState(0);
  const [showPopup, setShowPopup] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [gitData, setGitData] = useState<GitData | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);

  // Force re-render every second to update timers
  useEffect(() => {
    const interval = setInterval(() => {
      forceUpdate(n => n + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch project info and git data when popup opens
  useEffect(() => {
    if (showPopup) {
      fetchProjectInfo(showPopup);
      fetchGitData(showPopup);
    } else {
      setProjectInfo(null);
      setServerStatus(null);
      setGitData(null);
    }
  }, [showPopup]);

  const fetchProjectInfo = async (project: string) => {
    try {
      const response = await fetch(`/api/dev-server?project=${project}`);
      if (response.ok) {
        const data = await response.json();
        setProjectInfo(data.project);
        setServerStatus(data.server);
      }
    } catch (error) {
      console.error('Failed to fetch project info:', error);
    }
  };

  const fetchGitData = async (project: string) => {
    try {
      const response = await fetch(`/api/session/${project}/git`);
      if (response.ok) {
        const data = await response.json();
        setGitData(data);
      }
    } catch (error) {
      console.error('Failed to fetch git data:', error);
    }
  };

  const handleStartServer = async () => {
    if (!showPopup) return;
    setLoading(true);
    try {
      const response = await fetch('/api/dev-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: showPopup }),
      });
      if (response.ok) {
        await fetchProjectInfo(showPopup);
      }
    } catch (error) {
      console.error('Failed to start server:', error);
    }
    setLoading(false);
  };

  const handleStopServer = async () => {
    if (!showPopup) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/dev-server?project=${showPopup}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        await fetchProjectInfo(showPopup);
      }
    } catch (error) {
      console.error('Failed to stop server:', error);
    }
    setLoading(false);
  };

  const handleRestartServer = async () => {
    if (!showPopup) return;
    setLoading(true);
    try {
      // Stop then start
      await fetch(`/api/dev-server?project=${showPopup}`, { method: 'DELETE' });
      await new Promise(resolve => setTimeout(resolve, 1000));
      await fetch('/api/dev-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: showPopup }),
      });
      await fetchProjectInfo(showPopup);
    } catch (error) {
      console.error('Failed to restart server:', error);
    }
    setLoading(false);
  };

  const handleOpenPreview = () => {
    if (serverStatus?.port) {
      window.open(`http://localhost:${serverStatus.port}`, '_blank');
    }
  };

  const handleRestartSession = async () => {
    if (!showPopup) return;

    // Find the session to get full details
    const session = Array.from(sessions.values()).find(s =>
      s.project === showPopup || s.name === showPopup || s.name === `holler-${showPopup}`
    );
    if (!session) return;

    setLoading(true);
    try {
      // 1. Kill the existing session
      await fetch(`/api/sessions?session=${encodeURIComponent(session.name)}`, {
        method: 'DELETE',
      });

      // 2. Small delay to ensure tmux fully cleans up
      await new Promise(resolve => setTimeout(resolve, 500));

      // 3. Create a new session with --continue
      const body: Record<string, string> = {
        project: session.project,
        mode: 'continue',
      };

      // If it's a worktree, include the worktree path
      if (session.worktree) {
        body.worktreePath = session.cwd;
        body.branch = session.worktree;
      }

      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json();
        console.error('Failed to restart session:', data.error);
        alert(`Failed to restart: ${data.error}`);
        return;
      }

      // Signal TerminalManager to dispose and recreate the terminal connection
      triggerSessionRestart();
      setShowPopup(null);
    } catch (error) {
      console.error('Failed to restart session:', error);
      alert('Failed to restart session');
    } finally {
      setLoading(false);
    }
  };

  const handleDestroySession = async () => {
    if (!showPopup) return;
    const sessionName = `holler-${showPopup}`;
    if (!confirm(`Destroy session for ${showPopup}? This will terminate the tmux session.`)) {
      return;
    }
    try {
      const response = await fetch(`/api/sessions?session=${sessionName}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        setShowPopup(null);
        router.push('/');
      }
    } catch (error) {
      console.error('Failed to destroy session:', error);
    }
  };

  const handleNavigate = (tab: 'terminal' | 'preview' | 'docs' | 'git') => {
    if (!showPopup) return;
    setShowPopup(null);
    // Navigate directly to the tab route
    router.push(`/session/${showPopup}/${tab}`);
  };

  const sessionList = Array.from(sessions.values());

  // Separate alert sessions from regular project sessions
  const alertSessions = sessionList.filter(s => s.name.startsWith('alert-'));
  const regularSessions = sessionList.filter(s => !s.name.startsWith('alert-'));

  if (sessionList.length === 0) {
    return null;
  }

  const handleTabClick = (session: SessionInfo) => {
    // For worktree sessions, use the full session name (e.g., holler-GiveGrove--prod-debug)
    // For regular sessions, just use the project name (e.g., homestead)
    const urlParam = session.worktree ? session.name : session.project;
    const sessionPath = `/session/${urlParam}`;
    const isSameSession = session.name === activeSession;
    const isOnTerminalTab = isSameSession && activeTab === 'terminal';

    if (isOnTerminalTab) {
      // Already active AND viewing the terminal tab - show the popup
      setShowPopup(urlParam);
    } else if (isSameSession && activeTab !== null) {
      // Same session but on a different tab (Docs, Git, Preview) - switch to terminal
      triggerTerminalFocus();
    } else {
      // Different session or not on a session page - navigate there
      setActiveSession(session.name);
      router.push(sessionPath);
    }
  };

  return (
    <>
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide">
        {/* Alert sessions - styled differently with alert icon */}
        {alertSessions.map((session) => {
          const isActive = session.name === activeSession;
          const status = getStatusForSession(session.name);
          const statusChangedAt = getStatusChangedAtForSession(session.name);
          const statusColor = getStatusColor(status);
          const isWorking = status === 'working';
          const alertName = session.name.replace('alert-', '');

          return (
            <button
              key={session.name}
              onClick={() => {
                setActiveSession(session.name);
                router.push(`/session/${encodeURIComponent(session.name)}`);
              }}
              className="flex-shrink-0 flex items-center gap-2 px-3 py-2 transition-all"
              style={{
                fontFamily: 'VT323, monospace',
                fontSize: '14px',
                background: isActive
                  ? 'linear-gradient(180deg, #3d2a1a 0%, #1f150d 100%)'
                  : 'linear-gradient(180deg, #2a1a1a 0%, #150d0d 100%)',
                border: isActive
                  ? '2px solid #FF6600'
                  : '2px solid #4a2a2a',
                borderBottom: isActive ? '2px solid #FF6600' : '2px solid #2a1a1a',
                boxShadow: isActive
                  ? 'inset 0 1px 0 rgba(255,102,0,0.1), 0 2px 4px rgba(0,0,0,0.5)'
                  : 'inset 0 1px 0 rgba(255,102,0,0.05)',
              }}
            >
              {/* Status indicator */}
              <div
                className="w-2 h-2 flex-shrink-0 rounded-full"
                style={{
                  background: statusColor,
                  boxShadow: status === 'working' || status === 'waiting' ? `0 0 6px ${statusColor}` : 'none',
                  animation: isWorking ? 'pulse 1s ease-in-out infinite' : 'none',
                }}
              />

              {/* Alert icon + name */}
              <Bell size={14} className="text-[#FF6600]" />
              <span style={{ color: isActive ? '#FF6600' : '#8a5a5a' }}>
                {alertName}
              </span>

              {/* Timer */}
              <span
                className="text-xs tabular-nums"
                style={{
                  color: getStatusColor(status),
                  minWidth: '36px',
                }}
              >
                {formatTimeSince(statusChangedAt)}
              </span>
            </button>
          );
        })}

        {/* Divider if both alert and regular sessions exist */}
        {alertSessions.length > 0 && regularSessions.length > 0 && (
          <div className="flex-shrink-0 w-px bg-gray-700 my-1" />
        )}

        {/* Regular sessions */}
        {regularSessions.map((session) => {
          const isActive = session.name === activeSession;
          // Get status from Claude session files (like Whisper Village)
          const status = getStatusForSession(session.name);
          const statusChangedAt = getStatusChangedAtForSession(session.name);
          const statusColor = getStatusColor(status);
          const isWorking = status === 'working';

          return (
            <button
              key={session.name}
              onClick={() => handleTabClick(session)}
              className="flex-shrink-0 flex items-center gap-2 px-3 py-2 transition-all"
              style={{
                fontFamily: 'VT323, monospace',
                fontSize: '14px',
                background: isActive
                  ? 'linear-gradient(180deg, #333 0%, #1a1a1a 100%)'
                  : 'linear-gradient(180deg, #222 0%, #111 100%)',
                border: isActive
                  ? '2px solid #FF6600'
                  : '2px solid #444',
                borderBottom: isActive ? '2px solid #FF6600' : '2px solid #333',
                boxShadow: isActive
                  ? 'inset 0 1px 0 rgba(255,255,255,0.1), 0 2px 4px rgba(0,0,0,0.5)'
                  : 'inset 0 1px 0 rgba(255,255,255,0.05)',
              }}
            >
              {/* Status indicator - colors match Whisper Village */}
              <div
                className="w-2 h-2 flex-shrink-0 rounded-full"
                style={{
                  background: statusColor,
                  boxShadow: status === 'working' || status === 'waiting' ? `0 0 6px ${statusColor}` : 'none',
                  animation: isWorking ? 'pulse 1s ease-in-out infinite' : 'none',
                }}
              />

              {/* Project name + worktree badge */}
              <div className="flex items-center gap-1 truncate max-w-[120px]">
                <span
                  className="truncate"
                  style={{
                    color: isActive ? '#FF6600' : '#888',
                  }}
                >
                  {session.project}
                </span>
                {session.worktree && (
                  <span
                    className="flex-shrink-0 px-1 rounded text-[10px]"
                    style={{
                      background: 'rgba(0, 255, 102, 0.2)',
                      color: '#00FF66',
                      border: '1px solid rgba(0, 255, 102, 0.4)',
                    }}
                  >
                    {session.worktree}
                  </span>
                )}
              </div>

              {/* Timer - time since status changed (like Whisper Village) */}
              <span
                className="text-xs tabular-nums"
                style={{
                  color: getStatusColor(status),
                  minWidth: '36px',
                }}
              >
                {formatTimeSince(statusChangedAt)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Session Control Popup */}
      {showPopup && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          onClick={() => setShowPopup(null)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60" />

          {/* Popup Panel */}
          <div
            className="relative w-full max-w-lg bg-gray-900 border-t-4 border-[#FF6600] rounded-t-2xl safe-area-bottom max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Sticky Header */}
            <div className="sticky top-0 z-10 bg-gray-900 px-4 pt-4 pb-2 border-b border-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h3 style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FF6600]">
                  {showPopup.toUpperCase()}
                </h3>
                {projectInfo && (
                  <span className="text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded">
                    {projectInfo.type === 'nextjs' ? 'Next.js' : projectInfo.type === 'node' ? 'Node' : 'Project'}
                  </span>
                )}
              </div>
              <button
                onClick={() => setShowPopup(null)}
                className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
              >
                <X size={20} className="text-gray-400" />
              </button>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto px-4 pb-8 pt-4">

            {/* Quick Navigation */}
            <div className="mb-4">
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => handleNavigate('terminal')}
                  className="flex flex-col items-center gap-1 p-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
                >
                  <Terminal size={20} className="text-[#FF6600]" />
                  <span style={{ fontFamily: 'VT323, monospace' }} className="text-xs text-gray-300">TERM</span>
                </button>
                <button
                  onClick={() => handleNavigate('preview')}
                  className="flex flex-col items-center gap-1 p-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
                >
                  <Globe size={20} className={serverStatus?.running ? 'text-[#00FF66]' : 'text-gray-500'} />
                  <span style={{ fontFamily: 'VT323, monospace' }} className="text-xs text-gray-300">PREVIEW</span>
                </button>
                <button
                  onClick={() => handleNavigate('docs')}
                  className="flex flex-col items-center gap-1 p-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
                >
                  <FileText size={20} className="text-[#FFCC00]" />
                  <span style={{ fontFamily: 'VT323, monospace' }} className="text-xs text-gray-300">DOCS</span>
                </button>
              </div>
            </div>

            {/* Git Preview - Clickable to navigate to Git page */}
            <button
              onClick={() => handleNavigate('git')}
              className="w-full mb-4 p-3 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-left"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <GitBranch size={14} className="text-[#00FF66]" />
                  <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-[#00FF66]">
                    {gitData?.branch || 'main'}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs" style={{ fontFamily: 'VT323, monospace' }}>
                  {gitData && gitData.summary.totalFiles > 0 ? (
                    <>
                      <span className="text-gray-400">{gitData.summary.totalFiles} files</span>
                      <span className="text-[#00FF66]">+{gitData.summary.totalAdditions}</span>
                      <span className="text-[#FF3333]">-{gitData.summary.totalDeletions}</span>
                    </>
                  ) : (
                    <span className="text-gray-500">Clean</span>
                  )}
                  <ChevronRight size={14} className="text-gray-500" />
                </div>
              </div>
              {/* Show first few changed files if any */}
              {gitData && gitData.files.length > 0 && (
                <div className="space-y-1">
                  {gitData.files.slice(0, 3).map((file) => (
                    <div key={file.file} className="flex items-center gap-2 text-xs">
                      <span className={`w-4 ${
                        file.status === 'M' ? 'text-[#FFCC00]' :
                        file.status === 'A' || file.status === '?' ? 'text-[#00FF66]' :
                        file.status === 'D' ? 'text-[#FF3333]' : 'text-gray-400'
                      }`}>
                        {file.status === '?' ? 'A' : file.status}
                      </span>
                      <span className="text-gray-400 truncate flex-1 font-mono">{file.file}</span>
                    </div>
                  ))}
                  {gitData.files.length > 3 && (
                    <div className="text-xs text-gray-500" style={{ fontFamily: 'VT323, monospace' }}>
                      +{gitData.files.length - 3} more...
                    </div>
                  )}
                </div>
              )}
            </button>

            {/* Dev Server Controls */}
            {projectInfo?.hasDevScript && (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Server size={14} className="text-gray-400" />
                  <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400">DEV SERVER</span>
                </div>
                <div className="flex items-center gap-2 p-2 bg-gray-800 rounded-lg mb-2">
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{
                      background: serverStatus?.running ? '#00FF66' : '#666',
                      boxShadow: serverStatus?.running ? '0 0 6px #00FF66' : 'none',
                    }}
                  />
                  <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-white flex-1">
                    {serverStatus?.running ? `Port ${serverStatus.port}` : 'Stopped'}
                  </span>
                  {!serverStatus?.running ? (
                    <button
                      onClick={handleStartServer}
                      disabled={loading}
                      className="px-3 py-1.5 bg-[#00FF66] hover:bg-[#00CC52] text-black rounded transition-colors disabled:opacity-50 text-sm"
                      style={{ fontFamily: 'VT323, monospace' }}
                    >
                      START
                    </button>
                  ) : (
                    <div className="flex gap-1">
                      <button
                        onClick={handleRestartServer}
                        disabled={loading}
                        className="px-2 py-1.5 bg-[#FFCC00] hover:bg-[#CC9900] text-black rounded transition-colors disabled:opacity-50"
                        title="Restart"
                      >
                        <RotateCcw size={14} />
                      </button>
                      <button
                        onClick={handleStopServer}
                        disabled={loading}
                        className="px-2 py-1.5 bg-[#FF3333] hover:bg-[#CC2222] text-white rounded transition-colors disabled:opacity-50"
                        title="Stop"
                      >
                        <Square size={14} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* View Mode Toggle */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <MessageCircle size={14} className="text-gray-400" />
                <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400">VIEW MODE</span>
              </div>

              <div className="grid grid-cols-2 gap-2 mb-3">
                <button
                  onClick={() => setTerminalSettings({ viewMode: 'terminal' })}
                  className={`flex items-center justify-center gap-2 p-3 rounded-lg transition-colors ${
                    terminalSettings.viewMode === 'terminal'
                      ? 'ring-2 ring-[#FF6600] bg-gray-800'
                      : 'bg-gray-800/50 hover:bg-gray-800'
                  }`}
                >
                  <Terminal size={18} className={terminalSettings.viewMode === 'terminal' ? 'text-[#FF6600]' : 'text-gray-400'} />
                  <span style={{ fontFamily: 'VT323, monospace' }} className={terminalSettings.viewMode === 'terminal' ? 'text-[#FF6600]' : 'text-gray-400'}>
                    Terminal
                  </span>
                </button>
                <button
                  onClick={() => setTerminalSettings({ viewMode: 'chat' })}
                  className={`flex items-center justify-center gap-2 p-3 rounded-lg transition-colors ${
                    terminalSettings.viewMode === 'chat'
                      ? 'ring-2 ring-[#00FF66] bg-gray-800'
                      : 'bg-gray-800/50 hover:bg-gray-800'
                  }`}
                >
                  <MessageCircle size={18} className={terminalSettings.viewMode === 'chat' ? 'text-[#00FF66]' : 'text-gray-400'} />
                  <span style={{ fontFamily: 'VT323, monospace' }} className={terminalSettings.viewMode === 'chat' ? 'text-[#00FF66]' : 'text-gray-400'}>
                    Chat
                  </span>
                </button>
              </div>
            </div>

            {/* Appearance Settings - Collapsible, starts collapsed */}
            <div className="mb-4">
              <button
                onClick={() => setShowAppearance(!showAppearance)}
                className="w-full flex items-center justify-between p-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Palette size={14} className="text-gray-400" />
                  <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400">APPEARANCE</span>
                </div>
                <div className="flex items-center gap-2">
                  <span style={{ fontFamily: 'VT323, monospace' }} className="text-xs text-gray-500">
                    {terminalThemes[terminalSettings.theme].name} • {terminalSettings.fontSize}px
                  </span>
                  {showAppearance ? (
                    <ChevronDown size={14} className="text-gray-500" />
                  ) : (
                    <ChevronRight size={14} className="text-gray-500" />
                  )}
                </div>
              </button>

              {showAppearance && (
                <div className="mt-2 space-y-2">
                  {/* Theme buttons */}
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(terminalThemes) as TerminalThemeKey[]).map((key) => (
                      <button
                        key={key}
                        onClick={() => setTerminalSettings({ theme: key })}
                        className={`p-2 rounded-lg text-left transition-colors ${
                          terminalSettings.theme === key
                            ? 'ring-2 ring-[#FF6600]'
                            : ''
                        }`}
                        style={{
                          background: terminalThemes[key].theme.background,
                          border: `1px solid ${terminalThemes[key].theme.foreground}40`,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'VT323, monospace',
                            fontSize: '14px',
                            color: terminalThemes[key].theme.foreground,
                          }}
                        >
                          {terminalThemes[key].name}
                        </span>
                        <div className="flex gap-1 mt-1">
                          <div className="w-3 h-3 rounded-sm" style={{ background: terminalThemes[key].theme.red }} />
                          <div className="w-3 h-3 rounded-sm" style={{ background: terminalThemes[key].theme.green }} />
                          <div className="w-3 h-3 rounded-sm" style={{ background: terminalThemes[key].theme.yellow }} />
                          <div className="w-3 h-3 rounded-sm" style={{ background: terminalThemes[key].theme.blue }} />
                        </div>
                      </button>
                    ))}
                  </div>

                  {/* Font size */}
                  <div className="flex items-center gap-3 p-2 bg-gray-800 rounded-lg">
                    <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400 w-20">Font Size</span>
                    <button
                      onClick={() => setTerminalSettings({ fontSize: Math.max(10, terminalSettings.fontSize - 2) })}
                      className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                    >
                      <Minus size={14} className="text-white" />
                    </button>
                    <span style={{ fontFamily: 'VT323, monospace' }} className="text-white w-12 text-center">
                      {terminalSettings.fontSize}px
                    </span>
                    <button
                      onClick={() => setTerminalSettings({ fontSize: Math.min(28, terminalSettings.fontSize + 2) })}
                      className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                    >
                      <Plus size={14} className="text-white" />
                    </button>
                  </div>

                  {/* Line height - Terminal mode only */}
                  {terminalSettings.viewMode === 'terminal' && (
                    <div className="flex items-center gap-3 p-2 bg-gray-800 rounded-lg">
                      <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-400 w-20">Line Height</span>
                      <button
                        onClick={() => setTerminalSettings({ lineHeight: Math.max(1.0, terminalSettings.lineHeight - 0.1) })}
                        className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                      >
                        <Minus size={14} className="text-white" />
                      </button>
                      <span style={{ fontFamily: 'VT323, monospace' }} className="text-white w-12 text-center">
                        {terminalSettings.lineHeight.toFixed(1)}
                      </span>
                      <button
                        onClick={() => setTerminalSettings({ lineHeight: Math.min(2.0, terminalSettings.lineHeight + 0.1) })}
                        className="p-1.5 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                      >
                        <Plus size={14} className="text-white" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Session Actions */}
            <div className="space-y-2">
              {/* Restart Session */}
              <button
                onClick={handleRestartSession}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 p-3 bg-gray-800 hover:bg-[#FFCC00] text-[#FFCC00] hover:text-black rounded-lg transition-colors disabled:opacity-50"
                style={{ fontFamily: 'VT323, monospace' }}
              >
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                <span>RESTART CLAUDE --CONTINUE</span>
              </button>

              {/* Destroy Session */}
              <button
                onClick={handleDestroySession}
                className="w-full flex items-center justify-center gap-2 p-3 bg-gray-800 hover:bg-[#FF3333] text-[#FF3333] hover:text-white rounded-lg transition-colors"
                style={{ fontFamily: 'VT323, monospace' }}
              >
                <Trash2 size={18} />
                <span>DESTROY SESSION</span>
              </button>
            </div>
            </div>{/* End Scrollable Content */}
          </div>
        </div>
      )}
    </>
  );
}
