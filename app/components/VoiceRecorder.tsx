'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Keyboard, X, Send, Command, ArrowUp, ArrowDown, CornerDownLeft, XCircle, ClipboardPaste, ChevronDown, ChevronUp, MousePointer, Chrome, Loader2 } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { usePathname } from 'next/navigation';
import { useSession } from '../context/SessionContext';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { readFromClipboard } from '../lib/clipboard';

// Check if running in native Android app (hides web input UI)
function useIsNativeApp(): boolean {
  // Use useState to avoid SSR issues - default to false
  const [isNative, setIsNative] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsNative(params.get('native') === 'true');
  }, []);

  return isNative;
}

// Format recording duration
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface VoiceRecorderProps {
  activeSession: string | null;
}

export default function VoiceRecorder({ activeSession }: VoiceRecorderProps) {
  const isNativeApp = useIsNativeApp();
  const isDesktop = useIsDesktop();
  const pathname = usePathname();
  const {
    setIsInputExpanded,
    setPendingUserMessage,
    inputMode,
    setInputMode,
    terminalSettings,
  } = useSession();

  // On desktop AND on a session page, the bottom bar only spans the left panel (terminal area)
  const splitRatio = terminalSettings.desktopSplitRatio ?? 60;
  // Right offset: on desktop in session, stop before the gutter (which is at divider + 8px, and is 52px wide)
  // So we need: (100 - splitRatio)% + 8px (gutter position) + 52px (gutter width) + 4px (gap)
  // On mobile or home screen, leave 56px for the RightGutter
  const isOnSessionPage = pathname?.startsWith('/session/');
  const rightOffset = (isDesktop && isOnSessionPage) ? `calc(${100 - splitRatio}% + 82px)` : '56px';

  // Pure local state for typing - no context sync until send
  const [localDraft, setLocalDraft] = useState('');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [targetSession, setTargetSession] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [showSpecialKeys, setShowSpecialKeys] = useState(false);
  const [utilitiesButtonRect, setUtilitiesButtonRect] = useState<DOMRect | null>(null);
  const [recentMessages, setRecentMessagesState] = useState<string[]>([]);
  const [showRecentDropdown, setShowRecentDropdown] = useState(false);
  const [chromeDebugRunning, setChromeDebugRunning] = useState<boolean | null>(null);
  const [chromeDebugLoading, setChromeDebugLoading] = useState(false);
  const [selectMode, setSelectMode] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Helper to load recent messages from localStorage
  const loadRecentMessages = useCallback(() => {
    const stored = localStorage.getItem('homestead-recent-messages');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setRecentMessagesState(parsed);
        }
      } catch (e) {
        console.error('[VoiceRecorder] Failed to parse recent messages:', e);
      }
    }
  }, []);

  // Load on mount
  useEffect(() => {
    loadRecentMessages();
  }, [loadRecentMessages]);

  // Reload when Utilities modal opens (to catch messages saved by RightGutter)
  useEffect(() => {
    if (showSpecialKeys) {
      loadRecentMessages();
      // Also check Chrome debug status
      fetch('/api/chrome-debug')
        .then(r => r.json())
        .then(data => setChromeDebugRunning(data.running))
        .catch(() => setChromeDebugRunning(false));
    }
  }, [showSpecialKeys, loadRecentMessages]);

  // Toggle Chrome debug
  const toggleChromeDebug = useCallback(async () => {
    setChromeDebugLoading(true);
    try {
      if (chromeDebugRunning) {
        await fetch('/api/chrome-debug', { method: 'DELETE' });
        setChromeDebugRunning(false);
      } else {
        const res = await fetch('/api/chrome-debug', { method: 'POST' });
        const data = await res.json();
        setChromeDebugRunning(data.success);
      }
    } catch (e) {
      console.error('Chrome debug toggle failed:', e);
    } finally {
      setChromeDebugLoading(false);
    }
  }, [chromeDebugRunning]);

  // Add a message to recent history (keeps last 5, no duplicates)
  const addRecentMessage = useCallback((message: string) => {
    if (!message?.trim()) return;
    const trimmed = message.trim();
    setRecentMessagesState(prev => {
      const filtered = prev.filter(m => m !== trimmed);
      const updated = [trimmed, ...filtered].slice(0, 5);
      localStorage.setItem('homestead-recent-messages', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // For backwards compatibility - get the most recent message
  const lastTranscript = recentMessages[0] || null;
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Sync input expanded state
  useEffect(() => {
    setIsInputExpanded(inputMode === 'keyboard' || inputMode === 'transcript');
  }, [inputMode, setIsInputExpanded]);

  // Focus textarea and move cursor to end when entering keyboard mode
  useEffect(() => {
    if (inputMode === 'keyboard' && textareaRef.current) {
      const textarea = textareaRef.current;
      textarea.focus();
      // Move cursor to end
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);
    }
  }, [inputMode]);

  // Global paste handler - paste anywhere goes to input (both chat and terminal mode)
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Skip if focused on an input or a writable textarea (not xterm's readonly one)
      const activeElement = document.activeElement;
      if (activeElement?.tagName === 'INPUT') return;
      if (activeElement?.tagName === 'TEXTAREA' && !(activeElement as HTMLTextAreaElement).readOnly) return;

      // Skip if focused inside xterm terminal (xterm handles its own paste)
      if (activeElement?.closest('.xterm')) return;

      const text = e.clipboardData?.getData('text');
      if (!text) return;

      // Prevent default paste behavior
      e.preventDefault();

      // Switch to keyboard mode and add the pasted text
      if (inputMode === 'idle') {
        setInputMode('keyboard');
        setLocalDraft(text);
        setTargetSession(activeSession);
      } else if (inputMode === 'keyboard') {
        // Append to existing draft
        setLocalDraft(prev => prev + text);
      }

      // Focus the textarea after a brief delay to let the mode switch happen
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const len = textareaRef.current.value.length;
          textareaRef.current.setSelectionRange(len, len);
        }
      }, 50);
    };

    document.addEventListener('paste', handleGlobalPaste);
    return () => document.removeEventListener('paste', handleGlobalPaste);
  }, [inputMode, activeSession, setInputMode]);

  // Connect socket
  useEffect(() => {
    if (!activeSession) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      return;
    }

    let socketUrl: string;
    if (typeof window !== 'undefined') {
      socketUrl = window.location.origin;
    } else {
      socketUrl = 'http://localhost:3005';
    }

    const socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
    };
  }, [activeSession]);

  const sendKeyboardText = () => {
    const destination = targetSession || activeSession;
    if (socketRef.current && destination && localDraft.trim()) {
      const message = localDraft.trim();
      addRecentMessage(message); // Save for "paste last" feature
      setPendingUserMessage(message);
      // Clear input immediately for instant feedback
      setLocalDraft('');
      setInputMode('idle');
      setTargetSession(null);
      // Send to terminal (after UI update)
      socketRef.current.emit('tmux:input', destination, message);
      setTimeout(() => {
        socketRef.current?.emit('tmux:input', destination, '\r');
      }, 100);
    }
  };

  const sendTranscript = () => {
    const destination = targetSession || activeSession;
    if (socketRef.current && destination && transcript.trim()) {
      const message = transcript.trim();
      addRecentMessage(message); // Save for "paste last" feature
      setPendingUserMessage(message);
      // Clear input immediately for instant feedback
      setTranscript('');
      setInputMode('idle');
      setTargetSession(null);
      // Send to terminal (after UI update)
      socketRef.current.emit('tmux:input', destination, message);
      setTimeout(() => {
        socketRef.current?.emit('tmux:input', destination, '\r');
      }, 100);
    }
  };

  const cancelKeyboardMode = () => {
    setInputMode('idle');
    setTargetSession(null);
  };

  const cancelTranscript = () => {
    setTranscript('');
    setInputMode('idle');
    setTargetSession(null);
  };

  const clearDraft = () => {
    setLocalDraft('');
  };

  const openKeyboard = () => {
    setInputMode('keyboard');
    setTargetSession(activeSession);
  };

  // Paste a message to terminal (defaults to most recent)
  const pasteMessage = useCallback((message?: string) => {
    const textToSend = message || lastTranscript;
    if (!socketRef.current || !activeSession || !textToSend) return;

    setPendingUserMessage(textToSend);
    socketRef.current.emit('tmux:input', activeSession, textToSend);
    setTimeout(() => {
      socketRef.current?.emit('tmux:input', activeSession, '\r');
    }, 500);
    setShowSpecialKeys(false);
    setShowRecentDropdown(false);
  }, [activeSession, lastTranscript, setPendingUserMessage]);

  // Send special key to terminal
  const sendSpecialKey = useCallback((key: string) => {
    if (!socketRef.current || !activeSession) return;

    let sequence: string;
    switch (key) {
      case 'enter':
        sequence = '\r';
        break;
      case 'escape':
        sequence = '\x1b';
        break;
      case 'ctrl-b':
        sequence = '\x02'; // Ctrl+B
        break;
      case 'ctrl-c':
        sequence = '\x03'; // Ctrl+C
        break;
      case 'up':
        sequence = '\x1b[A'; // Arrow up
        break;
      case 'down':
        sequence = '\x1b[B'; // Arrow down
        break;
      default:
        return;
    }

    socketRef.current.emit('tmux:input', activeSession, sequence);
  }, [activeSession]);

  // Toggle select mode (disables tmux mouse capture for text selection)
  const toggleSelectMode = useCallback(async () => {
    if (!activeSession) return;
    const newMode = !selectMode;
    try {
      await fetch('/api/tmux-mouse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession, enabled: !newMode }),
      });
      setSelectMode(newMode);
    } catch (err) {
      console.error('Failed to toggle select mode:', err);
    }
  }, [activeSession, selectMode]);

  // Reset select mode when switching sessions (default to select mode on)
  useEffect(() => {
    if (activeSession) {
      // Enable select mode by default (tmux mouse off)
      setSelectMode(true);
      fetch('/api/tmux-mouse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: activeSession, enabled: false }),
      }).catch(() => {});
    }
  }, [activeSession]);

  // Direct send function for native Android app to use
  const sendMessage = useCallback((text: string) => {
    const destination = targetSession || activeSession;
    if (socketRef.current && destination && text.trim()) {
      const message = text.trim();
      addRecentMessage(message);
      setPendingUserMessage(message);
      socketRef.current.emit('tmux:input', destination, message);
      setTimeout(() => {
        socketRef.current?.emit('tmux:input', destination, '\r');
      }, 100);
      console.log('[VoiceRecorder] sendMessage: sent to', destination, ':', message.slice(0, 50));
      return true;
    }
    console.log('[VoiceRecorder] sendMessage: failed - no socket or session');
    return false;
  }, [activeSession, targetSession, addRecentMessage, setPendingUserMessage]);

  // Expose methods for RightGutter and native Android app to use
  useEffect(() => {
    (window as any).__voiceRecorder = {
      setTranscript,
      setTargetSession,
      sendKeyboardText,
      sendTranscript,
      cancelKeyboardMode,
      cancelTranscript,
      openKeyboard,
      inputMode,
      socketRef,
      setRecordingDuration,
      setAudioLevel,
      setShowSpecialKeys,
      setUtilitiesButtonRect,
      sendMessage, // For Android native app
    };
    // Also expose at window.Homestead for cleaner API
    (window as any).Homestead = {
      sendMessage,
      getActiveSession: () => activeSession,
    };
    return () => {
      delete (window as any).__voiceRecorder;
      delete (window as any).Homestead;
    };
  });

  if (!mounted) {
    return (
      <div className="fixed bottom-0 left-0 z-50 safe-area-bottom" style={{ right: rightOffset }}>
        <div className="h-20" />
      </div>
    );
  }

  // Utilities Modal - extracted so it can render even in native mode
  const utilitiesModal = showSpecialKeys && utilitiesButtonRect && typeof document !== 'undefined' && createPortal(
    <div
      className="fixed inset-0 z-[99999]"
      onClick={() => setShowSpecialKeys(false)}
    >
      {/* Semi-transparent backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Modal content - positioned left of button, guaranteed on screen */}
      <div
        className="fixed p-4 overflow-y-auto"
        style={{
          width: '300px',
          maxWidth: '85vw',
          maxHeight: 'min(70vh, 500px)',
          background: '#0a0a0a',
          border: '2px solid #FF660060',
          borderRadius: '12px',
          right: `calc(100vw - ${utilitiesButtonRect.left}px + 8px)`,
          // Position near button but ensure panel fits on screen
          top: `${Math.min(Math.max(20, utilitiesButtonRect.top - 100), window.innerHeight - Math.min(window.innerHeight * 0.7, 500) - 20)}px`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <span style={{ fontFamily: 'VT323, monospace', fontSize: '18px', color: '#FF6600' }}>
            UTILITIES
          </span>
          <button
            onClick={() => setShowSpecialKeys(false)}
            className="p-1 hover:bg-gray-700 rounded transition-colors"
          >
            <X size={18} className="text-gray-400" />
          </button>
        </div>

        {/* Key buttons grid */}
        <div className="grid grid-cols-3 gap-3">
          {/* Enter */}
          <button
            onClick={() => sendSpecialKey('enter')}
            className="flex flex-col items-center gap-1 p-3 rounded-xl transition-all active:scale-95"
            style={{
              background: 'rgba(0, 255, 102, 0.15)',
              border: '2px solid rgba(0, 255, 102, 0.4)',
            }}
          >
            <CornerDownLeft size={24} className="text-[#00FF66]" />
            <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: '#00FF66' }}>
              Enter
            </span>
          </button>

          {/* Escape */}
          <button
            onClick={() => sendSpecialKey('escape')}
            className="flex flex-col items-center gap-1 p-3 rounded-xl transition-all active:scale-95"
            style={{
              background: 'rgba(255, 204, 0, 0.15)',
              border: '2px solid rgba(255, 204, 0, 0.4)',
            }}
          >
            <XCircle size={24} className="text-[#FFCC00]" />
            <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: '#FFCC00' }}>
              Esc
            </span>
          </button>

          {/* Ctrl+C */}
          <button
            onClick={() => sendSpecialKey('ctrl-c')}
            className="flex flex-col items-center gap-1 p-3 rounded-xl transition-all active:scale-95"
            style={{
              background: 'rgba(255, 51, 51, 0.15)',
              border: '2px solid rgba(255, 51, 51, 0.4)',
            }}
          >
            <span style={{ fontFamily: 'VT323, monospace', fontSize: '20px', color: '#FF3333', fontWeight: 'bold' }}>
              ^C
            </span>
            <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: '#FF3333' }}>
              Ctrl+C
            </span>
          </button>

          {/* Up Arrow */}
          <button
            onClick={() => sendSpecialKey('up')}
            className="flex flex-col items-center gap-1 p-3 rounded-xl transition-all active:scale-95"
            style={{
              background: 'rgba(102, 153, 255, 0.15)',
              border: '2px solid rgba(102, 153, 255, 0.4)',
            }}
          >
            <ArrowUp size={24} className="text-[#6699FF]" />
            <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: '#6699FF' }}>
              Up
            </span>
          </button>

          {/* Down Arrow */}
          <button
            onClick={() => sendSpecialKey('down')}
            className="flex flex-col items-center gap-1 p-3 rounded-xl transition-all active:scale-95"
            style={{
              background: 'rgba(102, 153, 255, 0.15)',
              border: '2px solid rgba(102, 153, 255, 0.4)',
            }}
          >
            <ArrowDown size={24} className="text-[#6699FF]" />
            <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: '#6699FF' }}>
              Down
            </span>
          </button>

          {/* Ctrl+B (tmux prefix) */}
          <button
            onClick={() => sendSpecialKey('ctrl-b')}
            className="flex flex-col items-center gap-1 p-3 rounded-xl transition-all active:scale-95"
            style={{
              background: 'rgba(255, 102, 0, 0.15)',
              border: '2px solid rgba(255, 102, 0, 0.4)',
            }}
          >
            <span style={{ fontFamily: 'VT323, monospace', fontSize: '20px', color: '#FF6600', fontWeight: 'bold' }}>
              ^B
            </span>
            <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: '#FF6600' }}>
              Ctrl+B
            </span>
          </button>

          {/* Select Mode Toggle - spans full width */}
          <button
            onClick={toggleSelectMode}
            className="col-span-3 flex items-center justify-between p-3 rounded-xl transition-all active:scale-95"
            style={{
              background: selectMode ? 'rgba(0, 200, 255, 0.25)' : 'rgba(100, 100, 100, 0.15)',
              border: selectMode ? '2px solid rgba(0, 200, 255, 0.6)' : '2px solid rgba(100, 100, 100, 0.3)',
            }}
          >
            <div className="flex items-center gap-2">
              <MousePointer size={20} className={selectMode ? 'text-[#00C8FF]' : 'text-gray-500'} />
              <span style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: selectMode ? '#00C8FF' : '#999' }}>
                Select Mode
              </span>
            </div>
            <div
              className="w-10 h-5 rounded-full relative transition-colors"
              style={{ background: selectMode ? 'rgba(0, 200, 255, 0.4)' : 'rgba(60, 60, 60, 0.8)' }}
            >
              <div
                className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                style={{
                  left: selectMode ? '22px' : '2px',
                  background: selectMode ? '#00C8FF' : '#666',
                }}
              />
            </div>
          </button>

          {/* Chrome Debug Toggle - spans full width */}
          <button
            onClick={toggleChromeDebug}
            disabled={chromeDebugLoading}
            className="col-span-3 flex items-center justify-between p-3 rounded-xl transition-all active:scale-95 disabled:opacity-50"
            style={{
              background: chromeDebugRunning ? 'rgba(76, 175, 80, 0.25)' : 'rgba(100, 100, 100, 0.15)',
              border: chromeDebugRunning ? '2px solid rgba(76, 175, 80, 0.6)' : '2px solid rgba(100, 100, 100, 0.3)',
            }}
          >
            <div className="flex items-center gap-2">
              {chromeDebugLoading ? (
                <Loader2 size={20} className="text-gray-400 animate-spin" />
              ) : (
                <Chrome size={20} className={chromeDebugRunning ? 'text-[#4CAF50]' : 'text-gray-500'} />
              )}
              <span style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: chromeDebugRunning ? '#4CAF50' : '#999' }}>
                Chrome Debug
              </span>
            </div>
            <div
              className="w-10 h-5 rounded-full relative transition-colors"
              style={{ background: chromeDebugRunning ? 'rgba(76, 175, 80, 0.4)' : 'rgba(60, 60, 60, 0.8)' }}
            >
              <div
                className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                style={{
                  left: chromeDebugRunning ? '22px' : '2px',
                  background: chromeDebugRunning ? '#4CAF50' : '#666',
                }}
              />
            </div>
          </button>
        </div>

        {/* Recent Messages section */}
        {recentMessages.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-700">
            <button
              onClick={() => setShowRecentDropdown(!showRecentDropdown)}
              className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 transition-colors"
            >
              <span style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: '#888' }}>
                Recent Messages ({recentMessages.length})
              </span>
              {showRecentDropdown ? (
                <ChevronUp size={18} className="text-gray-500" />
              ) : (
                <ChevronDown size={18} className="text-gray-500" />
              )}
            </button>

            {showRecentDropdown && (
              <div className="mt-2 space-y-2 max-h-32 overflow-y-auto">
                {recentMessages.map((msg, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (activeSession && socketRef.current?.connected) {
                        socketRef.current.emit('terminal-input', {
                          sessionId: activeSession,
                          data: msg + '\n'
                        });
                        setShowSpecialKeys(false);
                      }
                    }}
                    className="w-full text-left p-2 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors"
                  >
                    <span className="text-sm text-gray-300 line-clamp-2">{msg}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Paste from Clipboard */}
        <button
          onClick={async () => {
            try {
              const text = await readFromClipboard();
              if (text && activeSession && socketRef.current?.connected) {
                socketRef.current.emit('terminal-input', {
                  sessionId: activeSession,
                  data: text
                });
                setShowSpecialKeys(false);
              }
            } catch (e) {
              console.error('Failed to paste:', e);
            }
          }}
          className="w-full mt-4 flex items-center justify-center gap-2 p-3 rounded-xl transition-all active:scale-95"
          style={{
            background: 'rgba(170, 102, 255, 0.15)',
            border: '2px solid rgba(170, 102, 255, 0.4)',
          }}
        >
          <ClipboardPaste size={20} className="text-[#AA66FF]" />
          <span style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: '#AA66FF' }}>
            Paste from Clipboard
          </span>
        </button>
      </div>
    </div>,
    document.body
  );

  // In native Android app, hide all web UI but keep socket/API active for native to use
  // Still render utilities modal since it's triggered from RightGutter
  if (isNativeApp) {
    return <>{utilitiesModal}</>;
  }

  const isExpanded = inputMode === 'keyboard' || inputMode === 'transcript';
  const showRecordingBar = inputMode === 'recording' || inputMode === 'transcribing';

  // Handle send from recording bar - tells RightGutter to stop and send
  const handleRecordingSend = () => {
    // This triggers RightGutter's stopRecording(true) via the exposed method
    const rg = (window as any).__rightGutter;
    if (rg?.stopRecordingAndSend) {
      rg.stopRecordingAndSend();
    }
  };

  return (
    <div className="fixed bottom-0 left-0 z-30 safe-area-bottom" style={{ right: rightOffset }}>
      {/* Recording bar - single button with pulsing background */}
      {showRecordingBar && (
        <div className="px-3 pb-2">
          {inputMode === 'recording' ? (
            <button
              onClick={handleRecordingSend}
              className="w-full rounded-xl px-4 py-2 flex items-center justify-center gap-4 transition-all active:scale-[0.98]"
              style={{
                background: `linear-gradient(180deg, rgba(255, ${102 + audioLevel * 50}, 0, ${0.7 + audioLevel * 0.3}) 0%, rgba(204, ${68 + audioLevel * 40}, 0, ${0.7 + audioLevel * 0.3}) 100%)`,
                border: '2px solid rgba(255, 153, 0, 0.7)',
                boxShadow: `0 0 ${15 + audioLevel * 25}px rgba(255, 102, 0, ${0.3 + audioLevel * 0.5})`,
                transition: 'background 100ms ease-out, box-shadow 100ms ease-out',
              }}
            >
              {/* Timer badge */}
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                style={{
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                }}
              >
                <div
                  className="w-2 h-2 rounded-full animate-pulse"
                  style={{ background: '#FF3333', boxShadow: '0 0 4px #FF3333' }}
                />
                <span
                  className="tabular-nums font-bold"
                  style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: 'white' }}
                >
                  {formatDuration(recordingDuration)}
                </span>
              </div>

              {/* Send text */}
              <div className="flex items-center gap-2">
                <Send size={22} className="text-white" />
                <span style={{ fontFamily: 'VT323, monospace', fontSize: '22px', color: 'white', fontWeight: 'bold' }}>
                  SEND
                </span>
              </div>
            </button>
          ) : (
            /* Transcribing state - same style as recording, with animated pulsing */
            <div
              className="w-full rounded-xl px-4 py-2 flex items-center justify-center gap-4 animate-transcribe-pulse"
              style={{
                border: '2px solid rgba(255, 153, 0, 0.7)',
              }}
            >
              {/* Timer badge - frozen */}
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                style={{
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                }}
              >
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: '#888' }}
                />
                <span
                  className="tabular-nums font-bold"
                  style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: 'rgba(255, 255, 255, 0.7)' }}
                >
                  {formatDuration(recordingDuration)}
                </span>
              </div>

              {/* Transcribing text with animated dots */}
              <div className="flex items-center gap-2">
                <div className="flex items-end justify-center gap-[2px] h-5">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="w-[3px] rounded-full animate-audio-wave"
                      style={{
                        background: 'rgba(255, 255, 255, 0.8)',
                        height: `${[10, 14, 12][i]}px`,
                        animationDuration: `${[0.4, 0.5, 0.35][i]}s`,
                        animationDelay: `${[0, 0.1, 0.05][i]}s`,
                      }}
                    />
                  ))}
                </div>
                <span style={{ fontFamily: 'VT323, monospace', fontSize: '22px', color: 'white', fontWeight: 'bold' }}>
                  Transcribing
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Utilities Modal */}
      {utilitiesModal}


      {/* Collapsed typing bar removed — keyboard button is now in RightGutter */}

      {/* Expanded textarea */}
      {isExpanded && (
        <div className="px-3 pb-2 relative">
          <textarea
            ref={textareaRef}
            value={inputMode === 'keyboard' ? localDraft : transcript}
            onChange={(e) => inputMode === 'keyboard' ? setLocalDraft(e.target.value) : setTranscript(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter adds newline
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                inputMode === 'keyboard' ? sendKeyboardText() : sendTranscript();
              }
              // Shift+Enter just adds a newline (default textarea behavior)
            }}
            className={`w-full bg-gray-900/95 text-white rounded-xl p-4 resize-none border-2 ${
              inputMode === 'keyboard' ? 'border-[#3366FF]' : 'border-[#FF6600]'
            } focus:outline-none backdrop-blur-sm`}
            style={{ fontFamily: 'VT323, monospace', fontSize: '24px', lineHeight: '1.3' }}
            rows={4}
            placeholder={inputMode === 'keyboard' ? 'Type your message...' : 'Edit your message...'}
          />
          {/* Clear button - floats in corner, doesn't take space */}
          {((inputMode === 'keyboard' && localDraft.length > 0) || (inputMode === 'transcript' && transcript.length > 0)) && (
            <button
              onClick={inputMode === 'keyboard' ? clearDraft : cancelTranscript}
              className="absolute flex items-center gap-1 px-2 py-0.5 rounded-full transition-all active:scale-95"
              style={{
                top: '8px',
                right: '20px',
                background: 'rgba(0, 0, 0, 0.7)',
                border: '1px solid rgba(255, 51, 51, 0.5)',
                zIndex: 10,
              }}
            >
              <X size={12} className="text-[#FF6666]" />
              <span style={{ fontFamily: 'VT323, monospace', fontSize: '12px', color: '#FF6666' }}>
                Clear
              </span>
            </button>
          )}
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="px-3 pb-2">
          <div
            className="px-3 py-1.5 bg-[#FF3333]/90 rounded-lg text-white text-xs text-center backdrop-blur-sm"
            style={{ fontFamily: 'VT323, monospace' }}
          >
            {error}
          </div>
        </div>
      )}
    </div>
  );
}
