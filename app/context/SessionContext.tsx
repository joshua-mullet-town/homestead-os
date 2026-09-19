'use client';

import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { io as createSocket, Socket } from 'socket.io-client';

// Status values matching Whisper Village exactly
export type ClaudeSessionStatus = 'working' | 'waiting' | 'idle' | 'terminated' | 'interrupted';

export interface SessionInfo {
  name: string;           // e.g., "holler-homestead" or "holler-GiveGrove--prod-debug"
  project: string;        // e.g., "homestead" or "GiveGrove" (base project name)
  worktree?: string;      // e.g., "prod-debug" (only set if this is a worktree session)
  cwd: string;            // working directory for matching with Claude session files
  status: ClaudeSessionStatus;
  statusChangedAt: Date;  // Date object for when status last changed (from hook's updatedAt)
  summary?: string;
  userSummary?: string;
  agentSummary?: string;
}

// Claude session file format (from ~/.claude/sessions/*.json)
interface ClaudeSessionFile {
  sessionId: string;
  cwd: string;
  status: ClaudeSessionStatus;
  tmuxSession?: string; // The actual tmux session name (e.g., holler-GiveGrove--prod-debug)
  summary?: string;
  userSummary?: string;
  agentSummary?: string;
  updatedAt: string; // ISO-8601 timestamp
}

// Terminal theme presets - All Gruvbox variants
export const terminalThemes = {
  gruvboxDark: {
    name: 'Gruvbox Dark',
    theme: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#fabd2f',
      cursorAccent: '#282828',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    }
  },
  gruvboxHard: {
    name: 'Gruvbox Hard',
    theme: {
      background: '#1d2021',
      foreground: '#ebdbb2',
      cursor: '#fe8019',
      cursorAccent: '#1d2021',
      selectionBackground: '#3c3836',
      black: '#1d2021',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#fbf1c7',
    }
  },
  gruvboxLight: {
    name: 'Gruvbox Light',
    theme: {
      background: '#fbf1c7',
      foreground: '#3c3836',
      cursor: '#d65d0e',
      cursorAccent: '#fbf1c7',
      selectionBackground: '#d5c4a1',
      black: '#fbf1c7',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#7c6f64',
      brightBlack: '#928374',
      brightRed: '#9d0006',
      brightGreen: '#79740e',
      brightYellow: '#b57614',
      brightBlue: '#076678',
      brightMagenta: '#8f3f71',
      brightCyan: '#427b58',
      brightWhite: '#3c3836',
    }
  },
  gruvboxSoft: {
    name: 'Gruvbox Soft',
    theme: {
      background: '#32302f',
      foreground: '#ebdbb2',
      cursor: '#b8bb26',
      cursorAccent: '#32302f',
      selectionBackground: '#504945',
      black: '#32302f',
      red: '#fb4934',
      green: '#b8bb26',
      yellow: '#fabd2f',
      blue: '#83a598',
      magenta: '#d3869b',
      cyan: '#8ec07c',
      white: '#d5c4a1',
      brightBlack: '#665c54',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#fbf1c7',
    }
  },
};

export type TerminalThemeKey = keyof typeof terminalThemes;

// TTS Voice options - Azure Neural voices
export const TTS_VOICES = [
  { id: 'en-US-AndrewNeural', name: 'Andrew', description: 'Male - Warm, Confident' },
  { id: 'en-US-BrianNeural', name: 'Brian', description: 'Male - Professional' },
  { id: 'en-US-ChristopherNeural', name: 'Christopher', description: 'Male - Mature, Authoritative' },
  { id: 'en-US-EricNeural', name: 'Eric', description: 'Male - Friendly, Casual' },
  { id: 'en-US-GuyNeural', name: 'Guy', description: 'Male - Clear, Newscaster' },
  { id: 'en-US-RogerNeural', name: 'Roger', description: 'Male - Elderly, Wise' },
  { id: 'en-US-AriaNeural', name: 'Aria', description: 'Female - Expressive, Warm' },
  { id: 'en-US-JennyNeural', name: 'Jenny', description: 'Female - Conversational' },
  { id: 'en-US-MichelleNeural', name: 'Michelle', description: 'Female - Professional' },
  { id: 'en-US-SaraNeural', name: 'Sara', description: 'Female - Cheerful' },
] as const;

export type TTSVoiceId = typeof TTS_VOICES[number]['id'];

interface TTSSettings {
  voice: TTSVoiceId;
  playbackSpeed: number;
  autoPlay: boolean;
}

const defaultTTSSettings: TTSSettings = {
  voice: 'en-US-AndrewNeural',
  playbackSpeed: 1.0,
  autoPlay: false,
};

interface TerminalSettings {
  theme: TerminalThemeKey;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  viewMode: 'terminal' | 'chat';
  tts: TTSSettings;
  desktopSplitRatio: number; // 0-100, percentage for left (terminal) panel
  watcherEnabled: boolean; // Build manager enabled for this session
  scribeEnabled: boolean; // Session scribe enabled for this session
}

interface SessionContextType {
  activeSession: string | null;
  setActiveSession: (session: string | null) => void;
  sessions: Map<string, SessionInfo>;
  claudeSessions: ClaudeSessionFile[]; // Raw session files from ~/.claude/sessions/
  registerSession: (sessionName: string, project: string, cwd: string, worktree?: string) => void;
  unregisterSession: (sessionName: string) => void;
  getStatusForSession: (sessionName: string) => ClaudeSessionStatus;
  getStatusChangedAtForSession: (sessionName: string) => Date | null;
  activeTab: string | null;
  setActiveTab: (tab: string | null) => void;
  requestTerminalFocus: number;
  triggerTerminalFocus: () => void;
  fontSize: number;
  setFontSize: (size: number) => void;
  // Terminal connection state
  terminalConnections: Map<string, boolean>;
  setTerminalConnected: (sessionName: string, connected: boolean) => void;
  isActiveTerminalConnected: boolean;
  // Terminal ready state (has received first data)
  terminalReady: Map<string, boolean>;
  setTerminalReady: (sessionName: string, ready: boolean) => void;
  isActiveTerminalReady: boolean;
  // Terminal appearance settings
  terminalSettings: TerminalSettings;
  setTerminalSettings: (settings: Partial<TerminalSettings>) => void;
  // Write settings for a specific session (not just the active one)
  setTerminalSettingsForSession: (sessionName: string, settings: Partial<TerminalSettings>) => void;
  // Session restart signal - increments to trigger terminal reconnection
  sessionRestartSignal: number;
  triggerSessionRestart: () => void;
  // Terminal refresh signal - increments to trigger fit + redraw without reconnecting
  terminalRefreshSignal: number;
  triggerTerminalRefresh: () => void;
  // Keyboard/input expanded state for chat view padding
  isInputExpanded: boolean;
  setIsInputExpanded: (expanded: boolean) => void;
  // Optimistic user message per session (shows immediately before hooks capture it)
  pendingUserMessage: string | null;  // Returns pending message for active session
  setPendingUserMessage: (message: string | null) => void;  // Sets for active session
  // Chat message cache per session
  chatCache: Map<string, any[]>;
  setChatCache: (sessionName: string, messages: any[]) => void;
  // Draft text (persists across navigation)
  draftText: string;
  setDraftText: (text: string) => void;
  // Voice/input state for unified gutter
  inputMode: 'idle' | 'recording' | 'transcribing' | 'keyboard' | 'transcript';
  setInputMode: (mode: 'idle' | 'recording' | 'transcribing' | 'keyboard' | 'transcript') => void;
  // Gutter visibility
  isGutterCollapsed: boolean;
  setIsGutterCollapsed: (collapsed: boolean) => void;
  // Alert session detection (alert-* sessions)
  isAlertSession: boolean;
  // Chat scroll position per session
  chatScrollPositions: Map<string, number>;
  setChatScrollPosition: (sessionName: string, position: number) => void;
  getChatScrollPosition: (sessionName: string) => number;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

const STORAGE_KEY = 'homestead-sessions';
const TERMINAL_SETTINGS_KEY = 'homestead-terminal-settings'; // Now stores per-session settings

const defaultTerminalSettings: TerminalSettings = {
  theme: 'gruvboxDark',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  viewMode: 'terminal',
  tts: defaultTTSSettings,
  desktopSplitRatio: 60, // Default 60% terminal, 40% right panel
  watcherEnabled: false, // Build manager disabled by default
  scribeEnabled: false, // Session scribe disabled by default
};

// Load all per-session terminal settings
function loadAllTerminalSettings(): Map<string, TerminalSettings> {
  try {
    const stored = localStorage.getItem(TERMINAL_SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Handle migration from old single-settings format
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Check if it's old format (has theme/fontSize directly) vs new format (has session keys)
        if ('theme' in parsed || 'fontSize' in parsed) {
          // Old format - return empty map, will use defaults
          return new Map();
        }
        // New format - object with session keys
        const map = new Map<string, TerminalSettings>();
        Object.entries(parsed).forEach(([sessionName, settings]) => {
          map.set(sessionName, { ...defaultTerminalSettings, ...(settings as Partial<TerminalSettings>) });
        });
        return map;
      }
    }
  } catch (e) {
    console.error('Failed to load terminal settings:', e);
  }
  return new Map();
}

// Save all per-session terminal settings
function saveAllTerminalSettings(settingsMap: Map<string, TerminalSettings>) {
  try {
    const obj: Record<string, TerminalSettings> = {};
    settingsMap.forEach((settings, sessionName) => {
      obj[sessionName] = settings;
    });
    localStorage.setItem(TERMINAL_SETTINGS_KEY, JSON.stringify(obj));
  } catch (e) {
    console.error('Failed to save terminal settings:', e);
  }
}

// Helper to serialize Map to localStorage
function saveSessions(sessions: Map<string, SessionInfo>) {
  try {
    const arr = Array.from(sessions.values());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch (e) {
    console.error('Failed to save sessions to localStorage:', e);
  }
}

// Helper to load Map from localStorage
function loadSessions(): Map<string, SessionInfo> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const arr: SessionInfo[] = JSON.parse(stored);
      const map = new Map<string, SessionInfo>();
      arr.forEach(s => map.set(s.name, s));
      return map;
    }
  } catch (e) {
    console.error('Failed to load sessions from localStorage:', e);
  }
  return new Map();
}

// Parse ISO-8601 date string (handles multiple formats like Whisper Village)
function parseISO8601Date(dateStr: string): Date | null {
  if (!dateStr) return null;
  try {
    // Try standard Date parsing first
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      return date;
    }
  } catch {
    // Fall through
  }
  return null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Map<string, SessionInfo>>(new Map());
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSessionFile[]>([]);
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, { status: 'working' | 'waiting' }>>({});
  const statusChangedAtRef = useRef<Map<string, Date>>(new Map());
  const prevStatusRef = useRef<Record<string, string>>({});
  const [initialized, setInitialized] = useState(false);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [requestTerminalFocus, setRequestTerminalFocus] = useState(0);
  const [fontSize, setFontSize] = useState(14);
  const [terminalConnections, setTerminalConnections] = useState<Map<string, boolean>>(new Map());
  const [terminalReady, setTerminalReadyState] = useState<Map<string, boolean>>(new Map());
  const [allTerminalSettings, setAllTerminalSettings] = useState<Map<string, TerminalSettings>>(new Map());
  const [sessionRestartSignal, setSessionRestartSignal] = useState(0);
  const [terminalRefreshSignal, setTerminalRefreshSignal] = useState(0);
  const [isInputExpanded, setIsInputExpanded] = useState(false);
  const [pendingUserMessages, setPendingUserMessages] = useState<Map<string, string>>(new Map());
  const [chatCache, setChatCacheState] = useState<Map<string, any[]>>(new Map());
  const [draftText, setDraftText] = useState<string>('');
  const [inputMode, setInputMode] = useState<'idle' | 'recording' | 'transcribing' | 'keyboard' | 'transcript'>('idle');
  const [isGutterCollapsed, setIsGutterCollapsed] = useState(false);
  const [chatScrollPositions, setChatScrollPositionsState] = useState<Map<string, number>>(new Map());

  const setChatCache = useCallback((sessionName: string, messages: any[]) => {
    setChatCacheState(prev => {
      const next = new Map(prev);
      next.set(sessionName, messages);
      return next;
    });
  }, []);

  const setChatScrollPosition = useCallback((sessionName: string, position: number) => {
    setChatScrollPositionsState(prev => {
      const next = new Map(prev);
      next.set(sessionName, position);
      return next;
    });
  }, []);

  const getChatScrollPosition = useCallback((sessionName: string) => {
    return chatScrollPositions.get(sessionName) ?? 0;
  }, [chatScrollPositions]);

  // Pending user message getter/setter - session-specific
  const pendingUserMessage = activeSession ? (pendingUserMessages.get(activeSession) ?? null) : null;

  const setPendingUserMessage = useCallback((message: string | null) => {
    if (!activeSession) return;
    setPendingUserMessages(prev => {
      const next = new Map(prev);
      if (message === null) {
        next.delete(activeSession);
      } else {
        next.set(activeSession, message);
      }
      return next;
    });
  }, [activeSession]);

  const triggerSessionRestart = useCallback(() => {
    setSessionRestartSignal(n => n + 1);
  }, []);

  const triggerTerminalRefresh = useCallback(() => {
    setTerminalRefreshSignal(n => n + 1);
  }, []);

  const setTerminalConnected = useCallback((sessionName: string, connected: boolean) => {
    setTerminalConnections(prev => {
      const next = new Map(prev);
      next.set(sessionName, connected);
      return next;
    });
    // When disconnecting, also reset ready state
    if (!connected) {
      setTerminalReadyState(prev => {
        const next = new Map(prev);
        next.delete(sessionName);
        return next;
      });
    }
  }, []);

  const setTerminalReady = useCallback((sessionName: string, ready: boolean) => {
    setTerminalReadyState(prev => {
      const next = new Map(prev);
      if (ready) {
        next.set(sessionName, true);
      } else {
        next.delete(sessionName);
      }
      return next;
    });
  }, []);

  // Get terminal settings for the active session (or defaults if no session)
  const terminalSettings = activeSession
    ? (allTerminalSettings.get(activeSession) ?? defaultTerminalSettings)
    : defaultTerminalSettings;

  const setTerminalSettings = useCallback((newSettings: Partial<TerminalSettings>) => {
    if (!activeSession) return;

    setAllTerminalSettings(prev => {
      const next = new Map(prev);
      const currentSettings = prev.get(activeSession) ?? defaultTerminalSettings;
      const updated = { ...currentSettings, ...newSettings };
      next.set(activeSession, updated);
      saveAllTerminalSettings(next);
      // Sync fontSize with the legacy fontSize state
      if (newSettings.fontSize !== undefined) {
        setFontSize(newSettings.fontSize);
      }
      // Sync steward toggles to server-side files
      if (newSettings.watcherEnabled !== undefined) {
        fetch('/api/watcher-enabled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: activeSession, enabled: newSettings.watcherEnabled }),
        }).catch(() => {});
      }
      if (newSettings.scribeEnabled !== undefined) {
        fetch('/api/scribe-enabled', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: activeSession, enabled: newSettings.scribeEnabled }),
        }).catch(() => {});
      }
      return next;
    });
  }, [activeSession]);

  // Write terminal settings for an explicit session (used when activating a
  // session and forcing its viewMode in the same tick — activeSession hasn't
  // updated yet, so setTerminalSettings would target the wrong session).
  const setTerminalSettingsForSession = useCallback((sessionName: string, newSettings: Partial<TerminalSettings>) => {
    if (!sessionName) return;
    setAllTerminalSettings(prev => {
      const next = new Map(prev);
      const currentSettings = prev.get(sessionName) ?? defaultTerminalSettings;
      const updated = { ...currentSettings, ...newSettings };
      next.set(sessionName, updated);
      saveAllTerminalSettings(next);
      return next;
    });
  }, []);

  const isActiveTerminalConnected = activeSession ? (terminalConnections.get(activeSession) ?? false) : false;
  const isActiveTerminalReady = activeSession ? (terminalReady.get(activeSession) ?? false) : false;
  const isAlertSession = activeSession?.startsWith('alert-') ?? false;

  const triggerTerminalFocus = useCallback(() => {
    setRequestTerminalFocus(n => n + 1);
  }, []);

  // Sync fontSize when active session changes
  useEffect(() => {
    if (activeSession && initialized) {
      const sessionSettings = allTerminalSettings.get(activeSession) ?? defaultTerminalSettings;
      setFontSize(sessionSettings.fontSize);
    }
  }, [activeSession, allTerminalSettings, initialized]);

  // Load sessions and terminal settings from localStorage on mount
  useEffect(() => {
    const loaded = loadSessions();
    if (loaded.size > 0) {
      setSessions(loaded);
    }
    const loadedSettings = loadAllTerminalSettings();
    setAllTerminalSettings(loadedSettings);
    setInitialized(true);
  }, []);

  // Save sessions to localStorage whenever they change (after initial load)
  useEffect(() => {
    if (initialized) {
      saveSessions(sessions);
    }
  }, [sessions, initialized]);

  // Register a session with its working directory for Claude session matching
  const registerSession = useCallback((sessionName: string, project: string, cwd: string, worktree?: string) => {
    console.log(`[SessionContext] registerSession: ${sessionName}, project: ${project}, cwd: ${cwd}`);
    setSessions(prev => {
      const next = new Map(prev);
      const existing = next.get(sessionName);
      if (existing) {
        // Session exists - update cwd/worktree if changed
        if (existing.cwd !== cwd || existing.worktree !== worktree) {
          console.log(`[SessionContext] Updating existing session: ${sessionName}`);
          next.set(sessionName, { ...existing, cwd, worktree });
          return next;
        }
        console.log(`[SessionContext] Session already exists, no changes: ${sessionName}`);
        return prev;
      }
      // New session - start as idle
      console.log(`[SessionContext] Creating new session: ${sessionName}`);
      next.set(sessionName, {
        name: sessionName,
        project,
        worktree,
        cwd,
        status: 'idle',
        statusChangedAt: new Date(),
      });
      console.log(`[SessionContext] Sessions map now has ${next.size} sessions:`, Array.from(next.keys()));
      return next;
    });
  }, []);

  const unregisterSession = useCallback((sessionName: string) => {
    console.log(`[SessionContext] unregisterSession: ${sessionName}`);
    console.trace('[SessionContext] unregisterSession stack trace');
    setSessions(prev => {
      const next = new Map(prev);
      next.delete(sessionName);
      console.log(`[SessionContext] Sessions map now has ${next.size} sessions:`, Array.from(next.keys()));
      return next;
    });
  }, []);

  // Match a session to its Claude session file
  // Strict cwd matching - only match sessions with exact cwd
  // We control session registration so we know the exact cwd for each session
  const findClaudeSessionForSession = useCallback((sessionName: string, cwd: string): ClaudeSessionFile | null => {
    if (claudeSessions.length === 0) return null;

    // Find session with exact cwd match (strict matching)
    const exactMatch = claudeSessions.find(cs => cs.cwd === cwd);
    if (exactMatch) return exactMatch;

    // No match found
    return null;
  }, [claudeSessions]);

  // Get status for a registered session (from hook activity files)
  const getStatusForSession = useCallback((sessionName: string): ClaudeSessionStatus => {
    const tmuxStatus = sessionStatuses[sessionName];
    if (tmuxStatus) return tmuxStatus.status;
    return 'idle';
  }, [sessionStatuses]);

  // Get statusChangedAt for a registered session (from status transitions)
  const getStatusChangedAtForSession = useCallback((sessionName: string): Date | null => {
    return statusChangedAtRef.current.get(sessionName) || null;
  }, []);

  // Poll session status via activity files every 3 seconds
  useEffect(() => {
    if (!initialized) return;

    const pollSessionStatus = async () => {
      try {
        const response = await fetch('/api/session-status');
        if (response.ok) {
          const data = await response.json();
          const statuses = data.statuses || {};

          // Track when status transitions happen
          for (const [name, info] of Object.entries(statuses) as [string, { status: string }][]) {
            const prev = prevStatusRef.current[name];
            if (prev !== info.status) {
              statusChangedAtRef.current.set(name, new Date());
            }
          }
          prevStatusRef.current = Object.fromEntries(
            Object.entries(statuses).map(([name, info]) => [name, (info as { status: string }).status])
          );

          setSessionStatuses(statuses);
        }
      } catch (e) {
        // Ignore fetch errors
      }
    };

    pollSessionStatus();
    const interval = setInterval(pollSessionStatus, 3000);

    return () => clearInterval(interval);
  }, [initialized]);

  // Keep a stable ref to syncSessions so both the 5s poll and the socket listeners
  // can call it without recreating the handler each render.
  const syncSessionsRef = useRef<() => Promise<void>>(async () => {});
  syncSessionsRef.current = async () => {
    try {
      const response = await fetch('/api/sessions');
      if (!response.ok) return;
      const data = await response.json();
      const tmuxSessions = data.sessions || [];
      const activeSessionNames = new Set(tmuxSessions.map((s: { name: string }) => s.name));

      setSessions(prev => {
        let changed = false;
        const next = new Map(prev);

        // Remove sessions that no longer exist in tmux
        next.forEach((_, name) => {
          if (!activeSessionNames.has(name)) {
            next.delete(name);
            changed = true;
          }
        });

        // Add or update sessions from tmux API (which has isWorktree, path, etc.)
        for (const tmuxSession of tmuxSessions) {
          const { name, project, path, isWorktree } = tmuxSession as {
            name: string;
            project: string;
            path: string;
            isWorktree: boolean;
          };

          let worktree: string | undefined;
          if (isWorktree && name.includes('--')) {
            const withoutPrefix = name.replace('holler-', '');
            const parts = withoutPrefix.split('--');
            worktree = parts.slice(1).join('--');
          }

          const existing = next.get(name);
          if (!existing) {
            next.set(name, {
              name,
              project,
              worktree,
              cwd: path,
              status: 'idle',
              statusChangedAt: new Date(),
            });
            changed = true;
          } else if (existing.cwd !== path || existing.worktree !== worktree || existing.project !== project) {
            next.set(name, { ...existing, cwd: path, worktree, project });
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    } catch (e) {
      // Ignore fetch errors
    }
  };

  // 5s poll belt-and-suspenders fallback (in case a socket event is missed).
  useEffect(() => {
    if (!initialized) return;
    syncSessionsRef.current();
    const interval = setInterval(() => syncSessionsRef.current(), 5000);
    return () => clearInterval(interval);
  }, [initialized]);

  // Real-time session lifecycle via Socket.IO — fires syncSessions on create/delete
  // from any path (API, spawn-worker, cleanup-ephemeral, notification-triage, etc.).
  useEffect(() => {
    if (!initialized) return;

    const socketUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3005';
    const socket: Socket = createSocket(socketUrl, { transports: ['websocket', 'polling'] });

    const handler = () => { syncSessionsRef.current(); };
    socket.on('session:created', handler);
    socket.on('session:deleted', handler);

    return () => {
      socket.off('session:created', handler);
      socket.off('session:deleted', handler);
      socket.disconnect();
    };
  }, [initialized]);

  return (
    <SessionContext.Provider value={{
      activeSession,
      setActiveSession,
      sessions,
      claudeSessions,
      registerSession,
      unregisterSession,
      getStatusForSession,
      getStatusChangedAtForSession,
      activeTab,
      setActiveTab,
      requestTerminalFocus,
      triggerTerminalFocus,
      fontSize,
      setFontSize,
      terminalConnections,
      setTerminalConnected,
      isActiveTerminalConnected,
      terminalReady,
      setTerminalReady,
      isActiveTerminalReady,
      terminalSettings,
      setTerminalSettings,
      setTerminalSettingsForSession,
      sessionRestartSignal,
      triggerSessionRestart,
      terminalRefreshSignal,
      triggerTerminalRefresh,
      isInputExpanded,
      setIsInputExpanded,
      pendingUserMessage,
      setPendingUserMessage,
      chatCache,
      setChatCache,
      draftText,
      setDraftText,
      inputMode,
      setInputMode,
      isGutterCollapsed,
      setIsGutterCollapsed,
      isAlertSession,
      chatScrollPositions,
      setChatScrollPosition,
      getChatScrollPosition,
    }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const context = useContext(SessionContext);
  if (context === undefined) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
