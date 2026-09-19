'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useSession, terminalThemes } from '../context/SessionContext';
import { User, Bot, RefreshCw, Zap, Loader2, X, Maximize2, Play, Pause, RotateCcw, Volume2, CheckCircle2, XCircle, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ActivityEntry {
  id: string;
  tool: string;
  type?: 'text' | 'tool';
  phase: 'start' | 'complete';
  message: string;
  timestamp: string;
}

interface ActivityData {
  activities: ActivityEntry[];
  is_working: boolean;
  current_tool: string | null;
  updated_at: string | null;
}

interface WatcherReport {
  id: string;
  session: string;
  timestamp: string;
  type: 'verified' | 'flagged' | 'responded' | 'info';
  summary: string;
  details?: string;
  action_taken?: string;
  needs_attention: boolean;
}

// Parse <task-notification> blocks out of message content
interface TaskNotification {
  taskId: string;
  status: string;
  summary: string;
  result: string;
  usage?: string;
}

function parseTaskNotifications(content: string): { parts: (string | TaskNotification)[]; } {
  const parts: (string | TaskNotification)[] = [];
  const regex = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(content)) !== null) {
    // Text before this notification
    const before = content.slice(lastIndex, match.index).trim();
    if (before) parts.push(before);

    const xml = match[1];
    const get = (tag: string) => {
      const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : '';
    };

    parts.push({
      taskId: get('task-id'),
      status: get('status'),
      summary: get('summary'),
      result: get('result') || get('output-file') || '',
      usage: get('usage') || undefined,
    });

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last notification (strip transcript/output-file paths)
  const after = content.slice(lastIndex)
    .replace(/Full transcript available at:.*$/gm, '')
    .replace(/Read the output file to retrieve the result:.*$/gm, '')
    .trim();
  if (after) parts.push(after);

  return { parts };
}

// Compact card for agent task completion notifications
function TaskNotificationCard({ notification, theme, fontSize }: {
  notification: TaskNotification;
  theme: typeof terminalThemes.gruvboxDark.theme;
  fontSize: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const isSuccess = notification.status === 'completed';
  const borderColor = isSuccess ? theme.green : theme.red;
  const Icon = isSuccess ? CheckCircle2 : XCircle;

  // Parse usage stats
  let tokens = '';
  let duration = '';
  if (notification.usage) {
    const tokMatch = notification.usage.match(/total_tokens:\s*([\d,]+)/);
    const durMatch = notification.usage.match(/duration_ms:\s*(\d+)/);
    if (tokMatch) tokens = parseInt(tokMatch[1].replace(/,/g, '')).toLocaleString();
    if (durMatch) {
      const ms = parseInt(durMatch[1]);
      duration = ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(0)}s`;
    }
  }

  // Clean up the summary for display
  const label = notification.summary
    .replace(/^Agent\s*/, '')
    .replace(/^Background command\s*/, '')
    .replace(/^"(.+)".*$/, '$1');

  return (
    <div
      style={{
        display: 'inline-block',
        maxWidth: '85%',
        border: `1px solid ${borderColor}30`,
        borderLeft: `3px solid ${borderColor}`,
        borderRadius: '6px',
        padding: '4px 10px',
        marginBottom: '8px',
        background: `${borderColor}08`,
      }}
    >
      {/* Single compact line */}
      <div className="flex items-center gap-1.5" style={{ flexWrap: 'wrap' }}>
        <Icon size={13} style={{ color: borderColor, flexShrink: 0 }} />
        <span style={{
          fontFamily: 'VT323, monospace',
          fontSize: `${fontSize - 1}px`,
          color: theme.brightBlack,
        }}>
          {label}
        </span>
        {(tokens || duration) && (
          <span style={{
            fontFamily: 'VT323, monospace',
            fontSize: `${fontSize - 3}px`,
            color: `${theme.brightBlack}80`,
          }}>
            {[tokens && `${tokens} tok`, duration].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      {/* Expandable result - only show if result is actual content (not just a file path) */}
      {notification.result && !notification.result.startsWith('/') && (
        <>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 mt-1"
            style={{ color: theme.brightBlack, fontSize: `${fontSize - 2}px`, fontFamily: 'VT323, monospace' }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? 'Hide details' : 'Show details'}
          </button>
          {expanded && (
            <div style={{
              marginTop: '8px',
              paddingTop: '8px',
              borderTop: `1px solid ${theme.brightBlack}30`,
              fontSize: `${fontSize - 1}px`,
            }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                p: ({ children }: any) => <p style={{ color: theme.foreground, marginBottom: '6px', lineHeight: 1.4 }}>{children}</p>,
                strong: ({ children }: any) => <strong style={{ color: theme.yellow }}>{children}</strong>,
                code: ({ children }: any) => (
                  <code style={{
                    background: `${theme.brightBlack}30`,
                    padding: '1px 4px',
                    borderRadius: '3px',
                    fontSize: `${fontSize - 2}px`,
                    color: theme.cyan,
                  }}>{children}</code>
                ),
                table: ({ children }: any) => (
                  <div style={{ overflowX: 'auto', margin: '8px 0', borderRadius: '6px', border: `1px solid ${theme.brightBlack}40` }}>
                    <table className="md-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: `${fontSize - 2}px` }}>{children}</table>
                  </div>
                ),
                th: ({ children }: any) => (
                  <th style={{ padding: '5px 8px', textAlign: 'left', color: theme.yellow, fontFamily: 'VT323, monospace', fontSize: `${fontSize - 1}px`, borderBottom: `2px solid ${theme.yellow}30`, borderRight: `1px solid ${theme.brightBlack}20`, whiteSpace: 'nowrap' }}>{children}</th>
                ),
                td: ({ children }: any) => (
                  <td style={{ padding: '4px 8px', color: theme.foreground, borderRight: `1px solid ${theme.brightBlack}15` }}>{children}</td>
                ),
                tr: ({ children }: any) => <tr style={{ borderBottom: `1px solid ${theme.brightBlack}20` }}>{children}</tr>,
                thead: ({ children }: any) => <thead style={{ background: `${theme.brightBlack}20` }}>{children}</thead>,
                tbody: ({ children }: any) => <tbody>{children}</tbody>,
              }}>
                {notification.result}
              </ReactMarkdown>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Arcade-style markdown components
const MarkdownComponents = {
  // Headers with neon glow
  h1: ({ children }: any) => (
    <h1 className="text-xl font-bold mb-3 mt-4" style={{
      fontFamily: 'VT323, monospace',
      color: '#FFCC00',
      textShadow: '0 0 10px #FFCC00, 0 0 20px #FF6600',
    }}>
      {children}
    </h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-lg font-bold mb-2 mt-3" style={{
      fontFamily: 'VT323, monospace',
      color: '#00FF66',
      textShadow: '0 0 8px #00FF66',
    }}>
      {children}
    </h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-base font-bold mb-2 mt-2" style={{
      fontFamily: 'VT323, monospace',
      color: '#FF6600',
      textShadow: '0 0 6px #FF6600',
    }}>
      {children}
    </h3>
  ),

  // Paragraphs
  p: ({ children }: any) => (
    <p className="mb-2 leading-relaxed" style={{
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '14px',
      color: '#e0e0e0',
    }}>
      {children}
    </p>
  ),

  // Code blocks with retro terminal feel
  code: ({ inline, className, children }: any) => {
    if (inline) {
      return (
        <code style={{
          fontFamily: 'Menlo, Monaco, monospace',
          fontSize: '13px',
          background: 'rgba(255, 102, 0, 0.2)',
          border: '1px solid rgba(255, 102, 0, 0.4)',
          borderRadius: '4px',
          padding: '2px 6px',
          color: '#FFCC00',
        }}>
          {children}
        </code>
      );
    }
    return (
      <pre style={{
        fontFamily: 'Menlo, Monaco, monospace',
        fontSize: '12px',
        background: 'linear-gradient(180deg, #0d0d0d 0%, #1a1a1a 100%)',
        border: '2px solid #333',
        borderRadius: '8px',
        padding: '12px',
        margin: '8px 0',
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.5), 0 0 10px rgba(0,255,102,0.1)',
      }}>
        <code style={{ color: '#00FF66' }}>
          {children}
        </code>
      </pre>
    );
  },

  // Lists with pixel-art bullets
  ul: ({ children }: any) => (
    <ul className="mb-2 ml-4 space-y-1">
      {children}
    </ul>
  ),
  ol: ({ children }: any) => (
    <ol className="mb-2 ml-4 space-y-1 list-decimal">
      {children}
    </ol>
  ),
  li: ({ children }: any) => (
    <li className="flex items-start gap-2" style={{ fontSize: '14px', color: '#e0e0e0' }}>
      <span style={{ color: '#FF6600', fontFamily: 'VT323, monospace' }}>▸</span>
      <span>{children}</span>
    </li>
  ),

  // Bold with glow
  strong: ({ children }: any) => (
    <strong style={{
      color: '#FFCC00',
      fontWeight: 'bold',
      textShadow: '0 0 4px rgba(255,204,0,0.5)',
    }}>
      {children}
    </strong>
  ),

  // Links
  a: ({ href, children }: any) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: '#00CCFF',
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
      }}
    >
      {children}
    </a>
  ),

  // Blockquotes
  blockquote: ({ children }: any) => (
    <blockquote style={{
      borderLeft: '3px solid #FF6600',
      paddingLeft: '12px',
      margin: '8px 0',
      fontStyle: 'italic',
      color: '#999',
    }}>
      {children}
    </blockquote>
  ),

  // Horizontal rule
  hr: () => (
    <hr style={{
      border: 'none',
      height: '2px',
      background: 'linear-gradient(90deg, transparent, #FF6600, transparent)',
      margin: '16px 0',
    }} />
  ),
};

// Scanline overlay effect
function ScanlineOverlay() {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-50"
      style={{
        background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.1) 0px, rgba(0,0,0,0.1) 1px, transparent 1px, transparent 2px)',
        opacity: 0.3,
      }}
    />
  );
}

// TTS Playback button for assistant messages
type TTSState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';

interface TTSButtonProps {
  text: string;
  theme: typeof terminalThemes.gruvboxDark.theme;
  voice?: string;
  playbackSpeed?: number;
}

function TTSButton({ text, theme, voice = 'en-US-AndrewNeural', playbackSpeed = 1.0 }: TTSButtonProps) {
  const [state, setState] = useState<TTSState>('idle');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Track if we've ever loaded audio (to show dual controls)
  const hasAudio = audioUrl !== null;

  // Cleanup audio URL on unmount
  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const handlePlayPause = async () => {
    // If we have audio loaded, toggle play/pause
    if (audioRef.current && audioUrl) {
      if (state === 'playing') {
        audioRef.current.pause();
        setState('paused');
        return;
      }
      if (state === 'paused' || state === 'ended') {
        if (state === 'ended') {
          audioRef.current.currentTime = 0;
        }
        audioRef.current.play();
        setState('playing');
        return;
      }
    }

    // Fetch new audio
    setState('loading');
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
      });

      if (!response.ok) {
        throw new Error('TTS request failed');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      // Clean up old URL if exists
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }

      setAudioUrl(url);

      const audio = new Audio(url);
      audio.playbackRate = playbackSpeed;
      audioRef.current = audio;

      audio.onended = () => setState('ended');
      audio.onerror = () => setState('idle');

      await audio.play();
      setState('playing');
    } catch (error) {
      console.error('TTS error:', error);
      setState('idle');
    }
  };

  const handleRestart = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      setState('playing');
    }
  };

  const buttonStyle = {
    background: `${theme.cyan}20`,
    border: `1px solid ${theme.cyan}40`,
    color: theme.cyan,
    fontFamily: 'VT323, monospace',
    fontSize: '12px',
  };

  // Before audio is loaded: single "Listen" button
  if (!hasAudio) {
    return (
      <button
        onClick={handlePlayPause}
        disabled={state === 'loading'}
        className="flex items-center gap-1.5 px-2 py-1 rounded transition-all hover:opacity-80 active:scale-95"
        style={{
          ...buttonStyle,
          opacity: state === 'loading' ? 0.7 : 1,
          cursor: state === 'loading' ? 'wait' : 'pointer',
        }}
      >
        {state === 'loading' ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Volume2 size={14} />
        )}
        <span>{state === 'loading' ? 'Loading...' : 'Listen'}</span>
      </button>
    );
  }

  // After audio is loaded: show play/pause AND restart buttons
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handlePlayPause}
        className="flex items-center gap-1.5 px-2 py-1 rounded transition-all hover:opacity-80 active:scale-95"
        style={buttonStyle}
      >
        {state === 'playing' ? (
          <>
            <Pause size={14} />
            <span>Pause</span>
          </>
        ) : (
          <>
            <Play size={14} />
            <span>{state === 'ended' ? 'Play' : 'Resume'}</span>
          </>
        )}
      </button>
      <button
        onClick={handleRestart}
        className="flex items-center gap-1.5 px-2 py-1 rounded transition-all hover:opacity-80 active:scale-95"
        style={buttonStyle}
      >
        <RotateCcw size={14} />
        <span>Restart</span>
      </button>
    </div>
  );
}

// Individual message bubble with arcade styling - compact overlapping avatar design
interface MessageBubbleProps {
  message: ChatMessage;
  index: number;
  theme: typeof terminalThemes.gruvboxDark.theme;
  fontSize: number;
  instant?: boolean;
  ttsVoice?: string;
  ttsPlaybackSpeed?: number;
}

function MessageBubble({ message, index, theme, fontSize, instant = false, ttsVoice, ttsPlaybackSpeed }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [visible, setVisible] = useState(instant); // Start visible if instant

  // Animate in on mount (skip animation if instant)
  useEffect(() => {
    if (instant) {
      setVisible(true);
      return;
    }
    // Cap the delay at 500ms max (10 messages worth) for better UX on long conversations
    const delay = Math.min(index * 50, 500);
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [index, instant]);

  if (!message.content) return null;

  // Dynamic markdown components that use theme and fontSize
  const ThemedMarkdownComponents = {
    h1: ({ children }: any) => (
      <h1 style={{
        fontFamily: 'VT323, monospace',
        fontSize: `${fontSize + 6}px`,
        color: theme.yellow,
        marginBottom: '8px',
        marginTop: '12px',
      }}>
        {children}
      </h1>
    ),
    h2: ({ children }: any) => (
      <h2 style={{
        fontFamily: 'VT323, monospace',
        fontSize: `${fontSize + 4}px`,
        color: theme.green,
        marginBottom: '6px',
        marginTop: '10px',
      }}>
        {children}
      </h2>
    ),
    h3: ({ children }: any) => (
      <h3 style={{
        fontFamily: 'VT323, monospace',
        fontSize: `${fontSize + 2}px`,
        color: theme.cyan,
        marginBottom: '4px',
        marginTop: '8px',
      }}>
        {children}
      </h3>
    ),
    p: ({ children }: any) => (
      <p style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: `${fontSize}px`,
        color: theme.foreground,
        marginBottom: '8px',
        lineHeight: 1.5,
      }}>
        {children}
      </p>
    ),
    // Inline code only - block code is handled by `pre`
    code: ({ children }: any) => {
      return (
        <code style={{
          fontFamily: 'Menlo, Monaco, monospace',
          fontSize: `${fontSize - 1}px`,
          background: theme.black,
          border: `1px solid ${theme.brightBlack}`,
          padding: '1px 4px',
          borderRadius: '3px',
          color: theme.yellow,
        }}>
          {children}
        </code>
      );
    },
    // Code blocks (``` ... ```)
    pre: ({ children }: any) => {
      return (
        <pre style={{
          fontFamily: 'Menlo, Monaco, monospace',
          fontSize: `${fontSize - 1}px`,
          background: theme.black,
          border: `3px solid ${theme.brightBlack}`,
          padding: '12px',
          margin: '8px 0',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {children}
        </pre>
      );
    },
    ul: ({ children }: any) => (
      <ul style={{ marginBottom: '8px', marginLeft: '16px' }}>
        {children}
      </ul>
    ),
    ol: ({ children }: any) => (
      <ol style={{ marginBottom: '8px', marginLeft: '16px', listStyleType: 'decimal' }}>
        {children}
      </ol>
    ),
    li: ({ children }: any) => (
      <li style={{ fontSize: `${fontSize}px`, color: theme.foreground, display: 'flex', alignItems: 'start', gap: '8px' }}>
        <span style={{ color: theme.red, fontFamily: 'VT323, monospace' }}>▸</span>
        <span>{children}</span>
      </li>
    ),
    strong: ({ children }: any) => (
      <strong style={{ color: theme.yellow, fontWeight: 'bold' }}>
        {children}
      </strong>
    ),
    a: ({ href, children }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: theme.cyan, textDecoration: 'underline' }}>
        {children}
      </a>
    ),
    blockquote: ({ children }: any) => (
      <blockquote style={{
        borderLeft: `4px solid ${theme.magenta}`,
        paddingLeft: '12px',
        margin: '8px 0',
        color: theme.brightBlack,
      }}>
        {children}
      </blockquote>
    ),
    // Table components
    table: ({ children }: any) => (
      <div style={{
        overflowX: 'auto',
        margin: '14px 0',
        borderRadius: '8px',
        border: `1px solid ${theme.brightBlack}50`,
      }}>
        <table className="md-table" style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: `${fontSize - 1}px`,
        }}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children }: any) => (
      <thead style={{
        background: `${theme.brightBlack}25`,
        borderBottom: `2px solid ${theme.yellow}30`,
      }}>
        {children}
      </thead>
    ),
    tbody: ({ children }: any) => (
      <tbody>
        {children}
      </tbody>
    ),
    tr: ({ children }: any) => (
      <tr style={{
        borderBottom: `1px solid ${theme.brightBlack}25`,
        transition: 'background 0.1s ease',
      }}>
        {children}
      </tr>
    ),
    th: ({ children }: any) => (
      <th style={{
        padding: '10px 14px',
        textAlign: 'left',
        fontWeight: 'bold',
        color: theme.yellow,
        fontFamily: 'VT323, monospace',
        fontSize: `${fontSize + 1}px`,
        borderRight: `1px solid ${theme.brightBlack}20`,
        whiteSpace: 'nowrap',
        letterSpacing: '0.02em',
      }}>
        {children}
      </th>
    ),
    td: ({ children }: any) => (
      <td style={{
        padding: '8px 14px',
        color: theme.foreground,
        borderRight: `1px solid ${theme.brightBlack}15`,
        lineHeight: '1.5',
      }}>
        {children}
      </td>
    ),
  };

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 transition-all duration-300`}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(20px)',
      }}
    >
      <div className={`relative max-w-[95%] ${isUser ? 'pl-4' : 'pr-4'}`}>
        {/* Overlapping Avatar */}
        <div
          className={`absolute top-0 ${isUser ? 'right-0 translate-x-2' : 'left-0 -translate-x-2'} -translate-y-2 z-20 w-7 h-7 rounded-full flex items-center justify-center`}
          style={{
            background: isUser ? theme.red : theme.black,
            border: `3px solid ${isUser ? theme.yellow : theme.green}`,
            boxShadow: `0 0 0 1px ${theme.black}`,
          }}
        >
          {isUser ? (
            <User size={14} color={theme.white} />
          ) : (
            <Bot size={14} color={theme.green} />
          )}
        </div>

        {/* Message bubble - solid colors, hard borders */}
        <div
          className={`px-3 py-2 ${isUser ? 'mr-2' : 'ml-2'}`}
          style={{
            background: isUser ? `${theme.red}20` : theme.black,
            border: `3px solid ${isUser ? theme.red : theme.green}`,
            borderRadius: isUser ? '0 0 12px 12px' : '0 0 12px 12px',
          }}
        >
          {/* Content */}
          {isUser ? (
            <p
              className="whitespace-pre-wrap break-words"
              style={{
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: `${fontSize}px`,
                color: theme.foreground,
                lineHeight: 1.5,
              }}
            >
              {message.content}
            </p>
          ) : (
            <div className="max-w-none">
              {(() => {
                const hasTaskNotif = message.content.includes('<task-notification>');
                if (!hasTaskNotif) {
                  return (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={ThemedMarkdownComponents}>
                      {message.content}
                    </ReactMarkdown>
                  );
                }
                const { parts } = parseTaskNotifications(message.content);
                return parts.map((part, i) => {
                  if (typeof part === 'string') {
                    return (
                      <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={ThemedMarkdownComponents}>
                        {part}
                      </ReactMarkdown>
                    );
                  }
                  return <TaskNotificationCard key={i} notification={part} theme={theme} fontSize={fontSize} />;
                });
              })()}
              {/* TTS Listen button for assistant messages */}
              <div className="mt-2 pt-2 border-t border-gray-800">
                <TTSButton text={message.content} theme={theme} voice={ttsVoice} playbackSpeed={ttsPlaybackSpeed} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Arcade-style loading animation
function ArcadeLoader() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <div className="relative">
        {/* Outer ring */}
        <div
          className="w-16 h-16 rounded-full"
          style={{
            border: '3px solid #333',
            borderTopColor: '#FF6600',
            animation: 'spin 1s linear infinite',
          }}
        />
        {/* Inner ring */}
        <div
          className="absolute inset-2 rounded-full"
          style={{
            border: '3px solid #333',
            borderTopColor: '#00FF66',
            animation: 'spin 0.7s linear infinite reverse',
          }}
        />
        {/* Center dot */}
        <div
          className="absolute inset-0 flex items-center justify-center"
        >
          <Zap size={20} color="#FFCC00" className="animate-pulse" />
        </div>
      </div>
      <p style={{
        fontFamily: 'VT323, monospace',
        color: '#FF6600',
        fontSize: '18px',
        letterSpacing: '3px',
        animation: 'pulse 1.5s ease-in-out infinite',
      }}>
        LOADING...
      </p>
    </div>
  );
}

// Single activity item with markdown support
function ActivityItem({ activity, theme, fontSize, isLast, isWorking }: {
  activity: ActivityEntry;
  theme: typeof terminalThemes.gruvboxDark.theme;
  fontSize: number;
  isLast: boolean;
  isWorking: boolean;
}) {
  const isText = activity.type === 'text';
  const isTool = activity.type === 'tool';

  // Markdown components for activity text
  const ActivityMarkdown = {
    p: ({ children }: any) => (
      <span style={{ color: theme.foreground }}>{children}</span>
    ),
    strong: ({ children }: any) => (
      <strong style={{ color: theme.yellow, fontWeight: 'bold' }}>{children}</strong>
    ),
    em: ({ children }: any) => (
      <em style={{ color: theme.cyan }}>{children}</em>
    ),
    code: ({ children }: any) => (
      <code style={{
        fontFamily: 'Menlo, Monaco, monospace',
        fontSize: `${fontSize - 2}px`,
        background: theme.black,
        padding: '1px 4px',
        borderRadius: '3px',
        color: theme.yellow,
      }}>
        {children}
      </code>
    ),
    ul: ({ children }: any) => (
      <ul style={{ marginLeft: '12px', marginTop: '4px', marginBottom: '4px' }}>{children}</ul>
    ),
    ol: ({ children }: any) => (
      <ol style={{ marginLeft: '12px', marginTop: '4px', marginBottom: '4px', listStyleType: 'decimal' }}>{children}</ol>
    ),
    li: ({ children }: any) => (
      <li style={{ display: 'flex', alignItems: 'start', gap: '6px', marginBottom: '2px' }}>
        <span style={{ color: theme.magenta }}>•</span>
        <span>{children}</span>
      </li>
    ),
    a: ({ href, children }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: theme.cyan, textDecoration: 'underline' }}>
        {children}
      </a>
    ),
  };

  return (
    <div className="flex items-start gap-2 mb-1">
      {/* Icon */}
      <span
        className="flex-shrink-0 mt-0.5"
        style={{
          fontFamily: 'VT323, monospace',
          fontSize: `${fontSize}px`,
          color: isTool ? theme.magenta : (activity.phase === 'complete' ? theme.green : theme.cyan),
        }}
      >
        {isTool ? '⚡' : (activity.phase === 'complete' ? '✓' : '▸')}
      </span>

      {/* Content */}
      <div
        style={{
          fontFamily: isText ? 'system-ui, -apple-system, sans-serif' : 'VT323, monospace',
          fontSize: `${fontSize}px`,
          color: theme.foreground,
          opacity: isWorking && !isLast ? 0.6 : 1,
          lineHeight: 1.4,
        }}
      >
        {isText ? (
          <ReactMarkdown components={ActivityMarkdown}>
            {activity.message}
          </ReactMarkdown>
        ) : (
          <span style={{ color: theme.brightBlack }}>{activity.message}</span>
        )}
      </div>
    </div>
  );
}

// Watcher report bubble - shows the turn watcher's analysis
function WatcherReportBubble({ report, theme }: {
  report: WatcherReport;
  theme: typeof terminalThemes.gruvboxDark.theme;
}) {
  const [expanded, setExpanded] = useState(false);

  const typeColors: Record<string, string> = {
    verified: theme.green,
    flagged: theme.yellow,
    responded: theme.blue,
    info: theme.brightBlack,
  };

  const typeIcons: Record<string, string> = {
    verified: '✓',
    flagged: '⚠',
    responded: '↩',
    info: 'ℹ',
  };

  return (
    <div
      className="mx-4 my-2 p-3 rounded-lg border transition-all"
      style={{
        background: 'linear-gradient(180deg, rgba(139,69,19,0.1) 0%, rgba(139,69,19,0.05) 100%)',
        borderColor: typeColors[report.type] || theme.brightBlack,
        borderWidth: '1px',
      }}
    >
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ color: typeColors[report.type], fontSize: '14px' }}>
          {typeIcons[report.type]}
        </span>
        <span style={{
          fontFamily: 'VT323, monospace',
          fontSize: '12px',
          color: theme.brightBlack,
          textTransform: 'uppercase',
        }}>
          Watcher
        </span>
        <span style={{
          fontFamily: 'VT323, monospace',
          fontSize: '12px',
          color: typeColors[report.type],
          textTransform: 'uppercase',
        }}>
          [{report.type}]
        </span>
        {report.needs_attention && (
          <span style={{
            background: theme.red,
            color: '#000',
            fontSize: '10px',
            padding: '1px 4px',
            borderRadius: '2px',
            fontFamily: 'VT323, monospace',
          }}>
            NEEDS ATTENTION
          </span>
        )}
        <div className="flex-1" />
        {expanded ? <ChevronDown size={14} style={{ color: theme.brightBlack }} /> : <ChevronRight size={14} style={{ color: theme.brightBlack }} />}
      </div>

      <p style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        color: theme.foreground,
        marginTop: '6px',
      }}>
        {report.summary}
      </p>

      {expanded && (
        <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: `1px solid ${theme.brightBlack}33` }}>
          {report.details && (
            <p style={{
              fontFamily: 'Menlo, Monaco, monospace',
              fontSize: '11px',
              color: theme.brightBlack,
              marginBottom: '4px',
            }}>
              {report.details}
            </p>
          )}
          {report.action_taken && (
            <p style={{
              fontFamily: 'Menlo, Monaco, monospace',
              fontSize: '11px',
              color: theme.cyan,
            }}>
              Action: {report.action_taken}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Live activity stream component - shows what the agent is doing
function ActivityStream({ activities, isWorking, theme }: {
  activities: ActivityEntry[];
  isWorking: boolean;
  theme: typeof terminalThemes.gruvboxDark.theme;
}) {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const shouldShow = activities.length > 0 || isWorking;

  useEffect(() => {
    if (shouldShow) {
      setVisible(true);
    } else {
      // Delay hiding to allow fade out
      const timer = setTimeout(() => setVisible(false), 300);
      return () => clearTimeout(timer);
    }
  }, [shouldShow]);

  if (!visible && !shouldShow) return null;

  const accentColor = isWorking ? theme.cyan : theme.green;

  return (
    <>
      {/* Compact view */}
      <div
        className="flex justify-start mb-3 transition-all duration-300 ease-out"
        style={{
          opacity: shouldShow ? 1 : 0,
          transform: shouldShow ? 'translateY(0)' : 'translateY(-10px)',
        }}
      >
        <div className="relative max-w-[95%] pr-4">
          {/* Bot avatar - shows spinner when working, checkmark when done */}
          <div
            className="absolute top-0 left-0 -translate-x-2 -translate-y-2 z-20 w-7 h-7 rounded-full flex items-center justify-center"
            style={{
              background: theme.black,
              border: `3px solid ${accentColor}`,
              boxShadow: `0 0 0 1px ${theme.black}`,
            }}
          >
            {isWorking ? (
              <Loader2 size={14} color={theme.cyan} className="animate-spin" />
            ) : (
              <span style={{ color: theme.green, fontSize: '12px' }}>✓</span>
            )}
          </div>

          {/* Activity bubble - entire thing is clickable */}
          <div
            className="relative ml-2 cursor-pointer transition-all hover:opacity-90 active:scale-[0.99]"
            onClick={() => setExpanded(true)}
          >
            {/* Expand icon - positioned relative to this wrapper, outside the overflow container */}
            <div
              className="absolute top-0 right-0 translate-x-2 -translate-y-2 w-6 h-6 rounded-md flex items-center justify-center z-30"
              style={{
                background: theme.black,
                border: `2px solid ${accentColor}`,
              }}
            >
              <Maximize2 size={12} color={accentColor} />
            </div>

            {/* Scrollable content area */}
            <div
              className="px-3 py-2 overflow-y-auto"
              style={{
                background: `${accentColor}10`,
                border: `2px ${isWorking ? 'dashed' : 'solid'} ${accentColor}40`,
                borderRadius: '0 0 12px 12px',
                maxHeight: '150px',
              }}
            >
              <div className="space-y-0.5">
              {activities.map((activity, i) => (
                <ActivityItem
                  key={activity.id + activity.phase}
                  activity={activity}
                  theme={theme}
                  fontSize={12}
                  isLast={i === activities.length - 1}
                  isWorking={isWorking}
                />
              ))}
              {isWorking && activities.length === 0 && (
                <div className="flex items-center gap-2">
                  <Loader2 size={12} color={theme.cyan} className="animate-spin" />
                  <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: theme.cyan }}>
                    Thinking...
                  </span>
                </div>
              )}
            </div>
          </div>
          </div>
        </div>
      </div>

      {/* Expanded modal overlay */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={() => setExpanded(false)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

          {/* Modal content */}
          <div
            className="relative w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-xl"
            style={{
              background: theme.background,
              border: `3px solid ${accentColor}`,
              boxShadow: `0 0 30px ${accentColor}40`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{
                background: `${accentColor}20`,
                borderBottom: `2px solid ${accentColor}40`,
              }}
            >
              <div className="flex items-center gap-2">
                {isWorking ? (
                  <Loader2 size={18} color={theme.cyan} className="animate-spin" />
                ) : (
                  <span style={{ color: theme.green, fontSize: '18px' }}>✓</span>
                )}
                <span style={{ fontFamily: 'VT323, monospace', fontSize: '18px', color: accentColor }}>
                  {isWorking ? 'Working...' : 'Activity Log'}
                </span>
              </div>
              <button
                onClick={() => setExpanded(false)}
                className="p-1 rounded hover:bg-white/10 transition-colors"
                style={{ color: theme.foreground }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Scrollable content */}
            <div
              className="overflow-y-auto p-4"
              style={{ maxHeight: 'calc(80vh - 60px)' }}
            >
              <div className="space-y-1">
                {activities.map((activity, i) => (
                  <ActivityItem
                    key={activity.id + activity.phase}
                    activity={activity}
                    theme={theme}
                    fontSize={15}
                    isLast={i === activities.length - 1}
                    isWorking={isWorking}
                  />
                ))}
                {isWorking && activities.length === 0 && (
                  <div className="flex items-center gap-2">
                    <Loader2 size={16} color={theme.cyan} className="animate-spin" />
                    <span style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: theme.cyan }}>
                      Thinking...
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface ChatViewProps {
  // When provided, this instance is for a specific session (used by ChatManager)
  sessionName?: string;
  // Whether this instance is currently visible/active (controls polling frequency)
  isActive?: boolean;
}

export default function ChatView({ sessionName: propSessionName, isActive: propIsActive }: ChatViewProps = {}) {
  const { activeSession: contextActiveSession, sessions, terminalSettings, isInputExpanded, getStatusForSession, pendingUserMessage: contextPendingMessage, setPendingUserMessage, chatCache, setChatCache, inputMode } = useSession();

  // Use prop session if provided, otherwise fall back to context (backward compat)
  const sessionName = propSessionName ?? contextActiveSession;
  // If isActive prop not provided, assume active if we're using the context session
  const isActive = propIsActive ?? (sessionName === contextActiveSession);

  // Pending message is only for the context's active session
  const pendingUserMessage = sessionName === contextActiveSession ? contextPendingMessage : null;

  // Initialize from cache if available
  const cachedMessages = sessionName ? chatCache.get(sessionName) : undefined;
  const [messages, setMessages] = useState<ChatMessage[]>(cachedMessages || []);
  const [loading, setLoading] = useState(!cachedMessages); // Don't show loading if we have cached data
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityData>({
    activities: [],
    is_working: false,
    current_tool: null,
    updated_at: null
  });
  const [watcherReports, setWatcherReports] = useState<WatcherReport[]>([]);
  // watcherEnabled comes from terminalSettings (per-session, managed in RightGutter settings)
  const watcherEnabled = terminalSettings.watcherEnabled ?? false;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const hasInitiallyScrolledRef = useRef(false);
  const prevSessionNameRef = useRef<string | null>(null);

  // Robust scroll-to-bottom helper
  const forceScrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, []);

  // Reset scroll state when session changes
  useEffect(() => {
    if (sessionName !== prevSessionNameRef.current) {
      hasInitiallyScrolledRef.current = false;
      prevMessageCountRef.current = 0;
      isNearBottomRef.current = true;
      prevSessionNameRef.current = sessionName;

      // Multiple scroll attempts to catch content at different render stages
      forceScrollToBottom();
      setTimeout(forceScrollToBottom, 0);
      setTimeout(forceScrollToBottom, 50);
      setTimeout(forceScrollToBottom, 150);
      setTimeout(forceScrollToBottom, 300);
    }
  }, [sessionName, forceScrollToBottom]);

  // Get the current session's project name
  const currentSession = sessionName ? sessions.get(sessionName) : null;
  const projectName = currentSession?.project || 'homestead';

  // Check if agent is currently working (from session status)
  const sessionStatus = sessionName ? getStatusForSession(sessionName) : 'idle';
  const isAgentWorking = sessionStatus === 'working';

  // Get current theme colors
  const currentTheme = terminalThemes[terminalSettings.theme]?.theme || terminalThemes.gruvboxDark.theme;

  // Check if user is near the bottom of the scroll container
  const checkIfNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const threshold = 100; // pixels from bottom
    const isNear = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    isNearBottomRef.current = isNear;
    return isNear;
  }, []);

  // Track scroll position (no longer need to save/restore - each instance persists)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      checkIfNearBottom();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [checkIfNearBottom]);

  // Auto-scroll to bottom only if user was already near bottom and new messages arrived
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Expose scrollToBottom globally for RightGutter's double-down button in chat mode
  // Only register when THIS ChatView instance is the active one
  useEffect(() => {
    if (!isActive) return;

    (window as any).__homesteadChatView = {
      scrollToBottom: () => {
        // Log to server for debugging
        fetch('/api/debug-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'ChatView.scrollToBottom',
            sessionName,
            isActive,
            scrollContainerExists: !!scrollContainerRef.current,
            scrollHeight: scrollContainerRef.current?.scrollHeight,
            scrollTop: scrollContainerRef.current?.scrollTop,
            clientHeight: scrollContainerRef.current?.clientHeight,
          })
        }).catch(() => {});

        // Scroll the container directly to the bottom
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({
            top: scrollContainerRef.current.scrollHeight,
            behavior: 'smooth'
          });
        }
      }
    };
    return () => {
      delete (window as any).__homesteadChatView;
    };
  }, [isActive, sessionName]); // Re-register when active state changes

  useEffect(() => {
    // On initial load with messages, scroll to bottom aggressively
    if (!hasInitiallyScrolledRef.current && messages.length > 0) {
      hasInitiallyScrolledRef.current = true;
      // Multiple attempts to catch content at different render stages
      forceScrollToBottom();
      setTimeout(forceScrollToBottom, 0);
      setTimeout(forceScrollToBottom, 50);
      setTimeout(forceScrollToBottom, 150);
      setTimeout(forceScrollToBottom, 300);
      prevMessageCountRef.current = messages.length;
      return;
    }

    // Only auto-scroll if user is near bottom AND new messages arrived
    const hasNewMessages = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    // Only scroll if near bottom - never force scroll when user has scrolled up
    if (isNearBottomRef.current && hasNewMessages) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom, forceScrollToBottom]);

  // Auto-scroll to bottom when input expands (so chat is visible above keyboard)
  useEffect(() => {
    if (isInputExpanded) {
      // Wait for the padding transition to fully complete before scrolling
      setTimeout(() => {
        scrollToBottom();
      }, 400);
    }
  }, [isInputExpanded, scrollToBottom]);

  // Scroll to bottom when this ChatView becomes active (switching between cached instances)
  useEffect(() => {
    if (isActive && messages.length > 0) {
      // Use requestAnimationFrame for reliable timing after render
      requestAnimationFrame(() => {
        forceScrollToBottom();
        // One more attempt after a tick
        setTimeout(forceScrollToBottom, 50);
      });
    }
  }, [isActive, forceScrollToBottom, messages.length]);

  // Fetch messages from the simple API
  const fetchMessages = useCallback(async () => {
    if (!projectName || !sessionName) {
      setMessages([]);
      setLoading(false);
      return;
    }

    try {
      // Pass session name to ensure we get the right conversation
      const res = await fetch(`/api/chat-messages/${projectName}?session=${encodeURIComponent(sessionName)}`);
      const data = await res.json();

      if (data.error && data.messages?.length === 0) {
        setError(data.error);
      } else {
        setError(null);
        const newMessages = data.messages || [];
        setMessages(newMessages);
        // Cache messages for instant display when switching back
        if (sessionName) {
          setChatCache(sessionName, newMessages);
        }
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
      setError('Failed to load conversation');
    } finally {
      setLoading(false);
    }
  }, [projectName, sessionName, setChatCache]);

  // Initial fetch and polling for updates (only poll when active to save resources)
  useEffect(() => {
    fetchMessages();

    // Only poll when this chat view is active
    if (isActive) {
      const pollInterval = setInterval(fetchMessages, 2000);
      return () => clearInterval(pollInterval);
    }
  }, [fetchMessages, isActive]);

  // Clear pending message once it appears in real messages
  // Use trimmed comparison to handle whitespace differences
  useEffect(() => {
    if (pendingUserMessage) {
      const pendingTrimmed = pendingUserMessage.trim();
      const found = messages.some(m =>
        m.role === 'user' && m.content.trim() === pendingTrimmed
      );
      if (found) {
        setPendingUserMessage(null);
      }
    }
  }, [messages, pendingUserMessage, setPendingUserMessage]);

  // Auto-scroll when pending user message appears (after transcription completes)
  useEffect(() => {
    if (pendingUserMessage) {
      // Small delay to let the message render first
      setTimeout(() => {
        scrollToBottom();
      }, 100);
    }
  }, [pendingUserMessage, scrollToBottom]);

  // Fetch activity when agent is working
  const fetchActivity = useCallback(async () => {
    if (!sessionName) return;

    try {
      const res = await fetch(`/api/activity?session=${encodeURIComponent(sessionName)}`);
      const data: ActivityData = await res.json();
      setActivity(data);
    } catch (err) {
      console.error('Failed to fetch activity:', err);
    }
  }, [sessionName]);

  // Track previous working state to detect transitions
  const wasWorkingRef = useRef(false);

  // Poll activity - fast while working, slower when idle to catch final state
  // Only poll when this view is active
  useEffect(() => {
    if (!isActive) return;

    // Always fetch immediately when session changes or working state changes
    fetchActivity();

    if (isAgentWorking) {
      // Fast polling while working
      wasWorkingRef.current = true;
      const pollInterval = setInterval(fetchActivity, 500);
      return () => clearInterval(pollInterval);
    } else if (wasWorkingRef.current) {
      // Agent just finished - fetch a few more times to catch final activity
      wasWorkingRef.current = false;
      const finalFetches = [500, 1000, 2000]; // Fetch at these delays after stopping
      const timeouts = finalFetches.map(delay =>
        setTimeout(fetchActivity, delay)
      );
      return () => timeouts.forEach(t => clearTimeout(t));
    }
    // If not working and wasn't working, no polling needed
  }, [isAgentWorking, fetchActivity, sessionName, isActive]);

  // Clear activity when a new user message is sent (start of new exchange)
  useEffect(() => {
    if (pendingUserMessage) {
      setActivity({
        activities: [],
        is_working: false,
        current_tool: null,
        updated_at: null
      });
    }
  }, [pendingUserMessage]);

  // Fetch watcher reports for this session
  const fetchWatcherReports = useCallback(async () => {
    if (!sessionName || !watcherEnabled) return;

    try {
      const res = await fetch(`/api/watcher-reports?session=${encodeURIComponent(sessionName)}&limit=10`);
      const data = await res.json();
      setWatcherReports(data.reports || []);
    } catch (err) {
      console.error('Failed to fetch watcher reports:', err);
    }
  }, [sessionName, watcherEnabled]);

  // Poll for watcher reports when enabled
  useEffect(() => {
    if (!watcherEnabled || !sessionName) return;

    fetchWatcherReports();
    const interval = setInterval(fetchWatcherReports, 5000);
    return () => clearInterval(interval);
  }, [watcherEnabled, sessionName, fetchWatcherReports]);

  if (!sessionName) {
    return (
      <div className="flex items-center justify-center h-full">
        <p style={{ color: '#666', fontFamily: 'VT323, monospace', fontSize: '18px' }}>
          NO ACTIVE SESSION
        </p>
      </div>
    );
  }

  if (loading && messages.length === 0) {
    return <ArcadeLoader />;
  }

  if (error && messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-4">
        <div
          className="p-6 rounded-xl text-center"
          style={{
            background: 'linear-gradient(135deg, rgba(30,30,30,0.9) 0%, rgba(20,20,20,0.95) 100%)',
            border: '2px solid #333',
            boxShadow: '0 0 20px rgba(0,0,0,0.5)',
          }}
        >
          <p style={{
            fontFamily: 'VT323, monospace',
            color: '#FFCC00',
            fontSize: '20px',
            marginBottom: '8px',
          }}>
            NO MESSAGES YET
          </p>
          <p style={{
            fontFamily: 'VT323, monospace',
            color: '#666',
            fontSize: '14px',
          }}>
            Chat with Claude in the terminal
          </p>
          <p style={{
            fontFamily: 'VT323, monospace',
            color: '#666',
            fontSize: '14px',
          }}>
            to see messages here
          </p>
        </div>
        <button
          onClick={fetchMessages}
          className="flex items-center gap-2 px-6 py-3 rounded-lg transition-all hover:scale-105"
          style={{
            background: 'linear-gradient(135deg, #FF6600 0%, #CC4400 100%)',
            border: '2px solid #FFCC00',
            color: '#fff',
            fontFamily: 'VT323, monospace',
            fontSize: '16px',
            letterSpacing: '2px',
            boxShadow: '0 0 15px rgba(255,102,0,0.4)',
          }}
        >
          <RefreshCw size={18} />
          REFRESH
        </button>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-4">
        <Bot size={48} color="#333" />
        <p style={{
          fontFamily: 'VT323, monospace',
          color: '#666',
          fontSize: '18px',
          textAlign: 'center',
        }}>
          START A CONVERSATION
        </p>
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      className="h-full overflow-y-auto relative"
      style={{ background: currentTheme.background }}
    >
      {/* Messages - extra padding when input is expanded, small bump when idle */}
      <div
        className="p-4 relative z-10 transition-[padding] duration-300 ease-out"
        style={{ paddingBottom: isInputExpanded ? '200px' : '56px' }}
      >
        {messages.map((msg, i) => {
          const isLastAssistantMessage = msg.role === 'assistant' && i === messages.length - 1;
          const showActivityBeforeThis = isLastAssistantMessage && (isAgentWorking || activity.activities.length > 0);

          // Find watcher report for this message (match by approximate timestamp)
          const msgTime = new Date(msg.timestamp).getTime();
          const matchingReport = watcherEnabled && msg.role === 'assistant'
            ? watcherReports.find(r => {
                const reportTime = new Date(r.timestamp).getTime();
                // Report should be within 5 minutes after the message
                return reportTime >= msgTime && reportTime <= msgTime + 5 * 60 * 1000;
              })
            : null;

          return (
            <div key={msg.id}>
              {/* Activity stream - show above the last assistant message */}
              {showActivityBeforeThis && (
                <ActivityStream
                  activities={activity.activities}
                  isWorking={isAgentWorking}
                  theme={currentTheme}
                />
              )}
              <MessageBubble message={msg} index={i} theme={currentTheme} fontSize={terminalSettings.fontSize} ttsVoice={terminalSettings.tts.voice} ttsPlaybackSpeed={terminalSettings.tts.playbackSpeed} />
              {/* Watcher report - show after assistant messages */}
              {matchingReport && (
                <WatcherReportBubble report={matchingReport} theme={currentTheme} />
              )}
            </div>
          );
        })}

        {/* Pending user message - shows immediately before hooks capture it */}
        {/* Only show if the message doesn't already exist in messages */}
        {pendingUserMessage && !messages.some(m => m.role === 'user' && m.content === pendingUserMessage) && (
          <>
            {/* Show activity after pending user message if no assistant response yet */}
            {(isAgentWorking || activity.activities.length > 0) && messages[messages.length - 1]?.role !== 'assistant' && (
              <ActivityStream
                activities={activity.activities}
                isWorking={isAgentWorking}
                theme={currentTheme}
              />
            )}
            <MessageBubble
              key="pending-user"
              message={{
                id: 'pending-user',
                role: 'user',
                content: pendingUserMessage,
                timestamp: new Date().toISOString()
              }}
              index={messages.length}
              theme={currentTheme}
              fontSize={terminalSettings.fontSize}
              instant={true}
              ttsVoice={terminalSettings.tts.voice}
              ttsPlaybackSpeed={terminalSettings.tts.playbackSpeed}
            />
          </>
        )}

        {/* Activity stream fallback - show at bottom if no messages or last message is user */}
        {(isAgentWorking || activity.activities.length > 0) &&
          !pendingUserMessage &&
          (messages.length === 0 || messages[messages.length - 1]?.role === 'user') && (
          <ActivityStream
            activities={activity.activities}
            isWorking={isAgentWorking}
            theme={currentTheme}
          />
        )}

        {/* Latest watcher report - show at bottom when enabled and there's a recent report */}
        {watcherEnabled && watcherReports.length > 0 && !isAgentWorking && (
          <div className="mt-4">
            <WatcherReportBubble report={watcherReports[0]} theme={currentTheme} />
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} className="h-4" />
      </div>


      {/* CSS for animations */}
      <style jsx global>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.2s ease-out forwards;
        }
      `}</style>
    </div>
  );
}
