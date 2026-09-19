'use client';

import { useEffect, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { XCircle } from 'lucide-react';
import { useSession, terminalThemes } from '../context/SessionContext';
import { useIsDesktop } from '../hooks/useMediaQuery';

interface TerminalInstance {
  xterm: any;
  fitAddon: any;
  socket: Socket;
  resizeObserver: ResizeObserver;
  containerRef: HTMLDivElement;
}

export default function TerminalManager() {
  const pathname = usePathname();
  const isDesktop = useIsDesktop();
  const { sessions, activeSession, activeTab, setTerminalConnected, setTerminalReady, isActiveTerminalReady, terminalSettings, sessionRestartSignal, terminalRefreshSignal } = useSession();
  const { theme: themeKey, fontSize, lineHeight, letterSpacing, desktopSplitRatio } = terminalSettings;
  const terminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const initializingRef = useRef<Set<string>>(new Set());
  const hasReceivedDataRef = useRef<Set<string>>(new Set());
  const hasEverConnectedRef = useRef<Set<string>>(new Set());
  // Last time we sent Ctrl+L (\x0c) per session, to debounce force-redraws.
  const lastCtrlLRef = useRef<Map<string, number>>(new Map());

  // Send a Ctrl+L force-redraw, but NEVER two in rapid succession for the same
  // session. Claude Code has a native double-Ctrl+L → /clear keyboard shortcut:
  // two \x0c bytes landing inside its double-tap window make Claude insert and
  // fire /clear, which WIPES the session's context. Multiple redraw sites fire
  // on open (tmux:ready, createTerminal, the visibility effect) and can collide.
  // A single redraw is harmless — only rapid pairs are dangerous — so we throttle
  // to one per CTRL_L_DEBOUNCE_MS. The window is intentionally wider than Claude's
  // shortcut window; a skipped redundant redraw costs nothing (another just ran).
  const CTRL_L_DEBOUNCE_MS = 1500;
  const sendCtrlL = useCallback((socket: Socket, sessionName: string) => {
    const now = performance.now();
    const last = lastCtrlLRef.current.get(sessionName) ?? -Infinity;
    if (now - last < CTRL_L_DEBOUNCE_MS) {
      return; // A redraw already fired recently — skip to avoid a double-tap.
    }
    lastCtrlLRef.current.set(sessionName, now);
    socket.emit('tmux:input', sessionName, '\x0c');
  }, []);

  // Determine if we should show the terminal overlay
  // Mobile: Show when on a session page AND terminal tab is active (or null, meaning first load)
  // Desktop: Show always when on a session page (terminal is always visible in left panel)
  const isOnSessionPage = pathname?.startsWith('/session/');
  const showTerminal = isOnSessionPage && (isDesktop || activeTab === 'terminal' || activeTab === null);

  // Get socket URL - use the origin so it works on any port
  const getSocketUrl = useCallback(() => {
    if (typeof window !== 'undefined') {
      return window.location.origin;
    }
    return 'http://localhost:3005';
  }, []);

  // Create a new terminal instance for a session
  const createTerminal = useCallback(async (sessionName: string) => {
    if (terminalsRef.current.has(sessionName) || initializingRef.current.has(sessionName)) {
      return;
    }

    initializingRef.current.add(sessionName);

    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit')
      ]);

      // Create container div for this terminal
      const terminalContainer = document.createElement('div');
      terminalContainer.className = 'absolute inset-0 p-2 overflow-hidden';
      terminalContainer.style.display = 'none';
      terminalContainer.style.overscrollBehavior = 'none';
      terminalContainer.style.touchAction = 'pan-y pinch-zoom';
      terminalContainer.dataset.session = sessionName;

      if (containerRef.current) {
        containerRef.current.appendChild(terminalContainer);
      }

      const currentTheme = terminalThemes[themeKey]?.theme || terminalThemes.gruvboxDark.theme;

      const xterm = new Terminal({
        cols: 100,
        rows: 30,
        fontSize,
        lineHeight,
        letterSpacing,
        fontFamily: 'Menlo, Monaco, "SF Mono", "Fira Code", Consolas, "Courier New", monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: currentTheme,
      });

      const fitAddon = new FitAddon();
      xterm.loadAddon(fitAddon);

      xterm.open(terminalContainer);

      // Disable keyboard by default
      const textarea = terminalContainer.querySelector('textarea');
      if (textarea) {
        textarea.setAttribute('readonly', 'true');
        textarea.blur();
      }

      // Create socket connection with reconnection settings
      const socket = io(getSocketUrl(), {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 20,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });

      // Custom key bindings for terminal usability
      xterm.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== 'keydown') return true;

        // Cmd+Backspace → Ctrl+U (kill line backward)
        if (e.metaKey && e.key === 'Backspace') {
          socket.emit('tmux:input', sessionName, '\x15');
          return false;
        }
        // Cmd+Delete → Ctrl+K (kill to end of line)
        if (e.metaKey && e.key === 'Delete') {
          socket.emit('tmux:input', sessionName, '\x0b');
          return false;
        }
        // Option+Backspace → Ctrl+W (delete previous word)
        if (e.altKey && !e.metaKey && e.key === 'Backspace') {
          socket.emit('tmux:input', sessionName, '\x17');
          return false;
        }
        // Shift+Enter → insert literal newline (via bracketed paste so shell doesn't execute)
        if (e.shiftKey && e.key === 'Enter') {
          socket.emit('tmux:input', sessionName, '\x1b[200~\n\x1b[201~');
          return false;
        }
        return true;
      });

      // Intercept mouse wheel → scroll xterm.js's own scrollback buffer (client-side, instant)
      // Claude Code enables mouse tracking inside tmux, so xterm.js would normally send
      // wheel events to the pty as escape sequences. We block that and scroll the local
      // 5000-line scrollback buffer instead — smooth, zero latency.
      const xtermViewport = terminalContainer.querySelector('.xterm-screen');
      if (xtermViewport) {
        xtermViewport.addEventListener('wheel', (e: Event) => {
          const wheelEvent = e as WheelEvent;
          wheelEvent.preventDefault();
          wheelEvent.stopPropagation();
          const lines = Math.max(1, Math.ceil(Math.abs(wheelEvent.deltaY) / 40));
          xterm.scrollLines(wheelEvent.deltaY < 0 ? -lines : lines);
        }, { passive: false });
      }

      // Retry timers for fresh sessions that may not produce output immediately
      let refreshRetryTimer: ReturnType<typeof setTimeout>;
      let refreshRetryTimer2: ReturnType<typeof setTimeout>;
      let forceReadyTimer: ReturnType<typeof setTimeout>;

      const clearRetryTimers = () => {
        clearTimeout(refreshRetryTimer);
        clearTimeout(refreshRetryTimer2);
        clearTimeout(forceReadyTimer);
      };

      // Socket event handlers
      socket.on('connect', () => {
        const isReconnect = hasEverConnectedRef.current.has(sessionName);
        console.log(`[TerminalManager] Socket connected for ${sessionName}${isReconnect ? ' (reconnect)' : ' (initial)'}`);
        hasEverConnectedRef.current.add(sessionName);
        setTerminalConnected(sessionName, true);
        socket.emit('tmux:attach', sessionName);

        // If no visible output within 3s, send Ctrl+L to force tmux redraw
        refreshRetryTimer = setTimeout(() => {
          if (!hasReceivedDataRef.current.has(sessionName)) {
            console.log(`[TerminalManager] No output from ${sessionName} after 3s, sending refresh`);
            sendCtrlL(socket, sessionName);
          }
        }, 3000);

        // Second attempt at 6s
        refreshRetryTimer2 = setTimeout(() => {
          if (!hasReceivedDataRef.current.has(sessionName)) {
            console.log(`[TerminalManager] No output from ${sessionName} after 6s, sending refresh`);
            sendCtrlL(socket, sessionName);
          }
        }, 6000);

        // After 10s, force the overlay away regardless — session may be slow but don't block forever
        forceReadyTimer = setTimeout(() => {
          if (!hasReceivedDataRef.current.has(sessionName)) {
            console.log(`[TerminalManager] Forcing ready for ${sessionName} after 10s timeout`);
            hasReceivedDataRef.current.add(sessionName);
            setTerminalReady(sessionName, true);
          }
        }, 10000);
      });

      socket.on('disconnect', (reason) => {
        console.log(`[TerminalManager] Socket disconnected for ${sessionName}: ${reason}`);
        setTerminalConnected(sessionName, false);
        // Reset ready state so the "Connecting to terminal..." overlay shows
        // instead of a frozen/blank screen
        hasReceivedDataRef.current.delete(sessionName);
        setTerminalReady(sessionName, false);
        clearRetryTimers();
      });

      socket.on('tmux:ready', () => {
        // Fit terminal dimensions
        const doFit = () => {
          if (terminalContainer.offsetWidth > 0) {
            fitAddon.fit();
            const dims = fitAddon.proposeDimensions();
            if (dims?.cols && dims?.rows) {
              xterm.resize(dims.cols, dims.rows);
              socket.emit('tmux:resize', sessionName, dims.cols, dims.rows);
            }
          }
        };

        doFit();
        setTimeout(doFit, 50);
        setTimeout(doFit, 150);

        // Request capture-pane snapshot for a clean initial render.
        // We do NOT send our own Ctrl+L here: the server fires exactly one
        // redraw on tmux:attach (its own writeCtrlL), which is the single
        // colored redraw for this open. Emitting a second \x0c from the client
        // would pair with the server's and trip Claude's double-Ctrl+L -> /clear
        // whenever the guard is cold (e.g. right after a restart). The snapshot
        // supplies instant text; the server's attach redraw supplies the colors.
        setTimeout(() => {
          const dims = fitAddon.proposeDimensions();
          const snapshotOpts = dims?.cols && dims?.rows ? { cols: dims.cols, rows: dims.rows } : {};
          socket.emit('tmux:snapshot', sessionName, snapshotOpts, (response: { success: boolean; data?: string }) => {
            if (response?.success && response.data) {
              xterm.write('\x1b[2J\x1b[H\x1b[0m');
              xterm.write(response.data);
            }
            xterm.scrollToBottom();
          });
        }, 200);
      });

      socket.on('tmux:output', (data) => {
        xterm.write(data);
        // Mark terminal as ready when we receive substantial visible content
        // (not just control characters or empty data)
        if (!hasReceivedDataRef.current.has(sessionName)) {
          // Check if data contains visible characters (not just control codes)
          const visibleContent = data.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\r|\n|\x0c/g, '').trim();
          if (visibleContent.length > 0) {
            hasReceivedDataRef.current.add(sessionName);
            setTerminalReady(sessionName, true);
            clearRetryTimers();
          }
        }
      });

      socket.on('tmux:error', (message) => {
        xterm.write(`\r\n\x1b[1;31mError: ${message}\x1b[0m\r\n`);
      });

      // Terminal event handlers
      xterm.onData((data: string) => {
        socket.emit('tmux:input', sessionName, data);
      });

      xterm.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        socket.emit('tmux:resize', sessionName, cols, rows);
        setTimeout(() => xterm.scrollToBottom(), 250);
      });

      // ResizeObserver for container
      const resizeObserver = new ResizeObserver(() => {
        if (terminalContainer.style.display !== 'none') {
          fitAddon.fit();
        }
      });
      resizeObserver.observe(terminalContainer);

      // Store the instance
      terminalsRef.current.set(sessionName, {
        xterm,
        fitAddon,
        socket,
        resizeObserver,
        containerRef: terminalContainer,
      });

      // CRITICAL FIX: Check if this terminal should already be visible
      // The visibility effect may have already run before this terminal was created,
      // so we need to immediately show and fit if this is the active session
      const shouldBeVisible = sessionName === activeSession && showTerminal;
      if (shouldBeVisible) {
        terminalContainer.style.display = 'block';

        const doFitInitial = () => {
          if (terminalContainer.offsetWidth > 0 && terminalContainer.offsetHeight > 0) {
            fitAddon.fit();
            const dims = fitAddon.proposeDimensions();
            if (dims?.cols && dims?.rows) {
              xterm.resize(dims.cols, dims.rows);
              socket.emit('tmux:resize', sessionName, dims.cols, dims.rows);
            }
          }
        };

        setTimeout(doFitInitial, 10);
        setTimeout(doFitInitial, 50);

        // Snapshot for instant text — the server's attach-time redraw supplies
        // the colors. See the tmux:ready handler above for why we never emit a
        // second client-side \x0c here (double-Ctrl+L -> /clear on a cold guard).
        setTimeout(() => {
          doFitInitial();
          const dims = fitAddon.proposeDimensions();
          const snapshotOpts = dims?.cols && dims?.rows ? { cols: dims.cols, rows: dims.rows } : {};
          socket.emit('tmux:snapshot', sessionName, snapshotOpts, (response: { success: boolean; data?: string }) => {
            if (response?.success && response.data) {
              xterm.write('\x1b[2J\x1b[H\x1b[0m');
              xterm.write(response.data);
              xterm.scrollToBottom();
            }
          });
        }, 150);
      }

    } catch (err) {
      console.error(`Failed to create terminal for ${sessionName}:`, err);
    } finally {
      initializingRef.current.delete(sessionName);
    }
  }, [fontSize, getSocketUrl, setTerminalConnected, activeSession, showTerminal, setTerminalReady, sendCtrlL]);

  // Dispose a terminal instance
  const disposeTerminal = useCallback((sessionName: string) => {
    console.log(`[TerminalManager] disposeTerminal called for: ${sessionName}`);
    console.trace('[TerminalManager] disposeTerminal stack trace');
    const instance = terminalsRef.current.get(sessionName);
    if (instance) {
      console.log(`[TerminalManager] Disposing terminal instance for: ${sessionName}`);
      instance.socket.emit('tmux:detach', sessionName);
      instance.socket.disconnect();
      instance.resizeObserver.disconnect();
      instance.xterm.dispose();
      instance.containerRef.remove();
      terminalsRef.current.delete(sessionName);
      hasReceivedDataRef.current.delete(sessionName);
      setTerminalConnected(sessionName, false);
      setTerminalReady(sessionName, false);
    } else {
      console.log(`[TerminalManager] No instance found for: ${sessionName}`);
    }
  }, [setTerminalConnected, setTerminalReady]);

  // Create terminals for all registered sessions
  useEffect(() => {
    console.log(`[TerminalManager] Sessions effect - sessions count: ${sessions.size}, terminal count: ${terminalsRef.current.size}`);
    console.log(`[TerminalManager] Registered sessions:`, Array.from(sessions.keys()));
    console.log(`[TerminalManager] Terminal instances:`, Array.from(terminalsRef.current.keys()));

    sessions.forEach((session) => {
      if (!terminalsRef.current.has(session.name)) {
        console.log(`[TerminalManager] Creating terminal for new session: ${session.name}`);
        createTerminal(session.name);
      }
    });

    // Clean up terminals for sessions that no longer exist
    terminalsRef.current.forEach((_, sessionName) => {
      if (!sessions.has(sessionName)) {
        console.log(`[TerminalManager] Session ${sessionName} no longer in sessions map - DISPOSING`);
        disposeTerminal(sessionName);
      }
    });
  }, [sessions, createTerminal, disposeTerminal]);

  // Show/hide terminals based on active session
  useEffect(() => {
    terminalsRef.current.forEach((instance, sessionName) => {
      const isActive = sessionName === activeSession && showTerminal;
      instance.containerRef.style.display = isActive ? 'block' : 'none';

      // When becoming visible: fit terminal, then request a tmux snapshot for instant render
      if (isActive) {
        const doFit = () => {
          if (instance.containerRef.offsetWidth > 0 && instance.containerRef.offsetHeight > 0) {
            instance.fitAddon.fit();
            const dims = instance.fitAddon.proposeDimensions();
            if (dims?.cols && dims?.rows) {
              instance.xterm.resize(dims.cols, dims.rows);
              instance.socket.emit('tmux:resize', sessionName, dims.cols, dims.rows);
            }
          }
        };

        // Fit immediately so dimensions are correct before snapshot
        setTimeout(doFit, 10);
        setTimeout(doFit, 50);

        // Request a capture-pane snapshot for instant render on view-open.
        //
        // This is the path Josh hit: "opening the tmux view is sending the
        // clear again." Switching to an already-attached session sends NO new
        // tmux:attach, so a client \x0c here has no server redraw to pair with
        // in steady state — but on a fresh page (reconnect after restart) the
        // attach redraw and this one DID pair and fired /clear. The snapshot
        // already paints the current screen, so we render from it and send NO
        // \x0c at all. If the snapshot fails, we fall through to the retry
        // timers / server attach refresh (both debounced) rather than risk a
        // paired double-tap here.
        setTimeout(() => {
          doFit();
          const dims = instance.fitAddon.proposeDimensions();
          const snapshotOpts = dims?.cols && dims?.rows ? { cols: dims.cols, rows: dims.rows } : {};
          instance.socket.emit('tmux:snapshot', sessionName, snapshotOpts, (response: { success: boolean; data?: string; error?: string }) => {
            if (response?.success && response.data) {
              // Reset terminal state, write plain-text snapshot for instant display
              instance.xterm.write('\x1b[2J\x1b[H\x1b[0m');
              instance.xterm.write(response.data);
              instance.xterm.scrollToBottom();
            }
          });
        }, 150);
      }
    });
  }, [activeSession, showTerminal, sendCtrlL]);

  // Update terminal settings for all terminals
  useEffect(() => {
    const currentTheme = terminalThemes[themeKey]?.theme || terminalThemes.gruvboxDark.theme;

    terminalsRef.current.forEach((instance) => {
      instance.xterm.options.fontSize = fontSize;
      instance.xterm.options.lineHeight = lineHeight;
      instance.xterm.options.letterSpacing = letterSpacing;
      instance.xterm.options.theme = currentTheme;
      setTimeout(() => {
        instance.fitAddon.fit();
        instance.xterm.scrollToBottom();
      }, 100);
    });
  }, [fontSize, lineHeight, letterSpacing, themeKey]);

  // Refit terminals when desktop split ratio changes
  useEffect(() => {
    if (!isDesktop) return;

    terminalsRef.current.forEach((instance, sessionName) => {
      const isActive = sessionName === activeSession && showTerminal;
      if (isActive) {
        // Debounce the refit to avoid excessive calls during drag
        const timer = setTimeout(() => {
          instance.fitAddon.fit();
          const dims = instance.fitAddon.proposeDimensions();
          if (dims?.cols && dims?.rows) {
            instance.xterm.resize(dims.cols, dims.rows);
            instance.socket.emit('tmux:resize', sessionName, dims.cols, dims.rows);
          }
        }, 50);
        return () => clearTimeout(timer);
      }
    });
  }, [desktopSplitRatio, isDesktop, activeSession, showTerminal]);

  // Handle session restart signal - dispose and recreate terminal for active session
  useEffect(() => {
    if (sessionRestartSignal === 0 || !activeSession) return;

    // Dispose the current terminal for this session
    const instance = terminalsRef.current.get(activeSession);
    if (instance) {
      console.log(`[TerminalManager] Restart signal received, disposing terminal for ${activeSession}`);
      disposeTerminal(activeSession);

      // Give tmux a moment to fully initialize the new session, then recreate terminal
      setTimeout(() => {
        console.log(`[TerminalManager] Recreating terminal for ${activeSession}`);
        createTerminal(activeSession);
      }, 1000);
    }
  }, [sessionRestartSignal, activeSession, disposeTerminal, createTerminal]);

  // Handle terminal refresh signal - refit and redraw without reconnecting
  useEffect(() => {
    if (terminalRefreshSignal === 0 || !activeSession) return;

    const instance = terminalsRef.current.get(activeSession);
    if (instance) {
      const doFit = () => {
        if (instance.containerRef.offsetWidth > 0 && instance.containerRef.offsetHeight > 0) {
          instance.fitAddon.fit();
          const dims = instance.fitAddon.proposeDimensions();
          if (dims?.cols && dims?.rows) {
            instance.xterm.resize(dims.cols, dims.rows);
            instance.socket.emit('tmux:resize', activeSession, dims.cols, dims.rows);
          }
          instance.xterm.scrollToBottom();
        }
      };

      doFit();
      setTimeout(doFit, 50);
      setTimeout(() => {
        doFit();
        sendCtrlL(instance.socket, activeSession); // Ctrl+L refresh (debounced)
      }, 150);
    }
  }, [terminalRefreshSignal, activeSession, sendCtrlL]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      terminalsRef.current.forEach((_, sessionName) => {
        disposeTerminal(sessionName);
      });
    };
  }, [disposeTerminal]);

  // Send escape key to active terminal
  const sendEscape = useCallback(() => {
    if (!activeSession) return;
    const instance = terminalsRef.current.get(activeSession);
    if (instance?.socket) {
      instance.socket.emit('tmux:input', activeSession, '\x1b'); // ESC character
    }
  }, [activeSession]);

  // The terminal overlay - positioned to fill the content area below the header
  // Mobile: top bar (~44px) + tab bar (~38px) = ~82px
  // Desktop: just top bar (~46px) since there's no tab bar
  const topOffset = isDesktop ? '46px' : '82px';

  // On desktop, terminal only takes up the left portion based on split ratio
  // The right side is the width of the right panel (100% - splitRatio%)
  // Plus 4px for the divider
  // Default to 60% if not set (for sessions created before this feature)
  const splitRatio = desktopSplitRatio ?? 60;
  const rightOffset = isDesktop ? `calc(${100 - splitRatio}% + 4px)` : '0px';

  // Debug logging
  useEffect(() => {
    console.log('[TerminalManager] Layout state:', {
      isDesktop,
      splitRatio,
      desktopSplitRatio,
      rightOffset,
      topOffset,
      activeSession,
      showTerminal,
    });
  }, [isDesktop, splitRatio, desktopSplitRatio, rightOffset, topOffset, activeSession, showTerminal]);

  return (
    <>
      <div
        ref={containerRef}
        className="fixed bg-[#0a0a0a]"
        style={{
          display: showTerminal ? 'block' : 'none',
          top: topOffset,
          left: 0,
          right: rightOffset,
          bottom: '0px',
          zIndex: 10,
        }}
      />

      {/* ESC button - always visible in terminal view */}
      {showTerminal && isActiveTerminalReady && (
        <button
          onClick={sendEscape}
          className="fixed flex items-center gap-1 px-2 py-1 rounded-md transition-all active:scale-95 hover:opacity-80"
          style={{
            top: `calc(${topOffset} + 8px)`,
            left: '8px',
            zIndex: 20,
            background: 'rgba(255, 204, 0, 0.15)',
            border: '1px solid rgba(255, 204, 0, 0.4)',
            opacity: 0.6,
          }}
          title="Send Escape key (interrupt Claude, clear prompts)"
        >
          <XCircle size={14} className="text-[#FFCC00]" />
          <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: '#FFCC00' }}>
            ESC
          </span>
        </button>
      )}

      {/* Loading overlay - shows when terminal is visible but hasn't received data yet */}
      {showTerminal && !isActiveTerminalReady && (
        <div
          className="fixed flex items-center justify-center bg-[#0a0a0a]"
          style={{
            top: topOffset,
            left: 0,
            right: rightOffset,
            bottom: '0px',
            zIndex: 15,
          }}
        >
          <div className="flex flex-col items-center gap-3">
            <div
              className="w-8 h-8 border-2 border-[#FFCC00] border-t-transparent rounded-full animate-spin"
            />
            <span
              style={{ fontFamily: 'VT323, monospace', fontSize: '16px' }}
              className="text-[#FFCC00]"
            >
              Connecting to terminal...
            </span>
          </div>
        </div>
      )}
    </>
  );
}
