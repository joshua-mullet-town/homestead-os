'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Bot, User, Send, RefreshCw, Globe, ExternalLink, Play, Square } from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ParsedMessage extends ChatMessage {
  sender: 'owner' | 'guest' | 'claude';
  senderName: string;
  displayContent: string;
}

interface PersonalSession {
  name: string;
  sessionName: string;
  sessionDir: string;
  alive?: boolean;
}

interface Guest {
  login: string;
  name: string;
  shortName: string;
  profilePic: string | null;
  sharedSession: { sessionName: string; sessionDir: string };
  sharedSessionAlive: boolean;
  personalSessions?: PersonalSession[];
  enabled: boolean;
}

interface DevServerStatus {
  running: boolean;
  pid?: number;
  port?: number;
}

interface ReactionMap {
  [messageId: string]: {
    [emoji: string]: string[];
  };
}

const REACTION_EMOJIS = [
  // Love & flirty
  '❤️', '😍', '🥰', '😘', '💋', '🫦', '🍑', '🍆', '💦', '🥵',
  // Fun & expressive
  '😂', '🤣', '😭', '🥺', '😏', '😈', '👀', '🫣', '🤤', '🤭',
  // Hype & reactions
  '🔥', '💀', '👏', '🙌', '💪', '🎉', '🥳', '⚡', '✨', '💯',
  // Thumbs & gestures
  '👍', '👎', '🤞', '🤙', '👋', '🫶', '🙏', '✌️', '🤟', '💅',
];

function parseAttribution(msg: ChatMessage, guestName: string, ownerName: string): ParsedMessage {
  if (msg.role === 'assistant') {
    return { ...msg, sender: 'claude', senderName: 'Claude', displayContent: msg.content };
  }
  const match = msg.content.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/);
  if (match) {
    const name = match[1];
    const content = match[2];
    if (name === guestName) {
      return { ...msg, sender: 'guest', senderName: name, displayContent: content };
    }
    return { ...msg, sender: 'owner', senderName: name, displayContent: content };
  }
  return { ...msg, sender: 'guest', senderName: guestName, displayContent: msg.content };
}

export default function GuestChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const login = searchParams?.get('login') || '';

  const [guest, setGuest] = useState<Guest | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ownerName, setOwnerName] = useState('Josh');
  const [reactions, setReactions] = useState<ReactionMap>({});
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [playgroundMode, setPlaygroundMode] = useState(false);
  const [devServer, setDevServer] = useState<DevServerStatus | null>(null);
  const [devServerLoading, setDevServerLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);

  const fetchGuest = useCallback(async () => {
    if (!login) return;
    try {
      const res = await fetch('/api/guests');
      if (res.ok) {
        const data = await res.json();
        const found = (data.guests || []).find((g: Guest) => g.login === login);
        setGuest(found || null);
        if (data.owner) {
          const local = data.owner.split('@')[0] || 'Josh';
          setOwnerName(local.charAt(0).toUpperCase() + local.slice(1));
        }
      }
    } catch (e) {
      console.error('Failed to fetch guest:', e);
    } finally {
      setLoading(false);
    }
  }, [login]);

  const fetchMessages = useCallback(async () => {
    if (!guest?.sharedSession?.sessionName) return;
    try {
      const [msgRes, reactRes] = await Promise.all([
        fetch(`/api/chat-messages/guest?session=${encodeURIComponent(guest.sharedSession.sessionName)}`),
        fetch(`/api/guests/reactions?session=${encodeURIComponent(guest.sharedSession.sessionName)}`),
      ]);
      if (msgRes.ok) {
        const data = await msgRes.json();
        setMessages(data.messages || []);
      }
      if (reactRes.ok) {
        const data = await reactRes.json();
        setReactions(data.reactions || {});
      }
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    }
  }, [guest]);

  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!guest?.sharedSession?.sessionName) return;
    try {
      const res = await fetch('/api/guests/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: guest.sharedSession.sessionName,
          messageId,
          emoji,
          userName: guest.name,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setReactions(data.reactions || {});
      }
    } catch (e) {
      console.error('Failed to toggle reaction:', e);
    }
  }, [guest]);

  useEffect(() => { fetchGuest(); }, [fetchGuest]);

  useEffect(() => {
    if (!guest?.sharedSessionAlive) return;
    fetchMessages();
    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, [guest, fetchMessages]);

  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
    prevCountRef.current = messages.length;
  }, [messages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending || !guest) return;
    setSending(true);
    setInput('');
    try {
      await fetch('/api/guests/send-shared-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestLogin: guest.login, message: text }),
      });
      setTimeout(fetchMessages, 1000);
    } catch (e) {
      console.error('Failed to send:', e);
    }
    setSending(false);
    inputRef.current?.focus();
  };

  // Derive project name from personalSessions
  const projectName = guest?.personalSessions?.[0]?.name || null;

  const fetchDevServerStatus = useCallback(async () => {
    if (!projectName) return;
    try {
      const res = await fetch(`/api/dev-server?project=${encodeURIComponent(projectName)}`);
      if (res.ok) {
        const data = await res.json();
        setDevServer(data.server || { running: false });
      }
    } catch (e) {
      console.error('Failed to fetch dev server status:', e);
    }
  }, [projectName]);

  const startDevServer = async () => {
    if (!projectName) return;
    setDevServerLoading(true);
    try {
      const res = await fetch('/api/dev-server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: projectName }),
      });
      if (res.ok) {
        const data = await res.json();
        setDevServer({ running: true, pid: data.pid, port: data.port });
      }
    } catch (e) {
      console.error('Failed to start dev server:', e);
    }
    setDevServerLoading(false);
  };

  const stopDevServer = async () => {
    if (!projectName) return;
    setDevServerLoading(true);
    try {
      await fetch(`/api/dev-server?project=${encodeURIComponent(projectName)}`, { method: 'DELETE' });
      setDevServer({ running: false });
    } catch (e) {
      console.error('Failed to stop dev server:', e);
    }
    setDevServerLoading(false);
  };

  // Poll dev server status when playground mode is active
  useEffect(() => {
    if (!playgroundMode || !projectName) return;
    fetchDevServerStatus();
    const interval = setInterval(fetchDevServerStatus, 3000);
    return () => clearInterval(interval);
  }, [playgroundMode, projectName, fetchDevServerStatus]);

  if (loading) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-[#FF6600] animate-spin" />
      </div>
    );
  }

  if (!guest) {
    return (
      <div className="h-screen bg-black flex flex-col items-center justify-center p-8">
        <p className="text-gray-400 mb-4">Guest not found</p>
        <button onClick={() => router.back()} className="text-[#FF6600]">Go back</button>
      </div>
    );
  }

  const parsed = messages
    .filter(m => !(m.role === 'assistant' && m.content.trim() === '---'))
    .map(m => parseAttribution(m, guest.name, ownerName));

  return (
    <div className="h-screen bg-black flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 py-3 bg-gray-900 border-b border-gray-800">
        <button onClick={() => router.back()} className="p-1 text-gray-400 hover:text-white">
          <ArrowLeft className="w-5 h-5" />
        </button>
        {guest.profilePic ? (
          <img src={guest.profilePic} alt="" className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-[#FF6600]/20 flex items-center justify-center text-[#FF6600] font-bold text-sm">
            {guest.name[0]?.toUpperCase() || '?'}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-white text-sm font-medium truncate">{guest.name}</div>
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${guest.sharedSessionAlive ? 'bg-[#00FF66]' : 'bg-gray-600'}`} />
            <span className="text-xs text-gray-500">
              {guest.sharedSessionAlive ? 'Session active' : 'Session offline'}
            </span>
          </div>
        </div>
        {projectName && (
          <button
            onClick={() => setPlaygroundMode(!playgroundMode)}
            className={`p-2 rounded-lg transition-all active:scale-95 ${
              playgroundMode
                ? 'bg-[#FF6600]/20 text-[#FF6600]'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Globe className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Preview Panel (playground mode) */}
      {playgroundMode && (
        <div className="flex-shrink-0" style={{ height: '55vh' }}>
          {devServer?.running && devServer.port ? (
            <div className="h-full flex flex-col bg-gray-950">
              {/* Preview controls */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-900 border-b border-gray-800">
                <span className="w-2 h-2 rounded-full bg-[#00FF66] animate-pulse" />
                <span className="text-[11px] text-gray-400 font-mono">:{devServer.port}</span>
                <div className="flex-1" />
                <button
                  onClick={() => setIframeKey(k => k + 1)}
                  className="p-1.5 text-gray-500 hover:text-white active:scale-95 transition-all"
                  title="Refresh preview"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => window.open(`/api/proxy/${devServer.port}/`, '_blank')}
                  className="p-1.5 text-gray-500 hover:text-white active:scale-95 transition-all"
                  title="Open in new tab"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={stopDevServer}
                  disabled={devServerLoading}
                  className="p-1.5 text-gray-500 hover:text-red-400 active:scale-95 transition-all"
                  title="Stop server"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              </div>
              {/* iframe */}
              <iframe
                key={iframeKey}
                ref={iframeRef}
                src={`/api/proxy/${devServer.port}/`}
                className="flex-1 w-full bg-white"
                title="Site preview"
              />
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center bg-gray-950 gap-4">
              <Globe className="w-12 h-12 text-gray-700" />
              <p className="text-gray-500 text-sm">Dev server not running</p>
              <button
                onClick={startDevServer}
                disabled={devServerLoading || !projectName}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#FF6600] text-white text-sm font-medium disabled:opacity-40 active:scale-95 transition-all"
              >
                {devServerLoading ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                Start Server
              </button>
              {projectName && (
                <p className="text-gray-600 text-xs">{projectName}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className={`flex-1 overflow-y-auto p-4 space-y-3 ${playgroundMode ? 'min-h-0' : ''}`}>
        {!guest.sharedSessionAlive ? (
          <div className="text-center py-20">
            <Bot className="w-12 h-12 text-gray-700 mx-auto mb-4" />
            <p className="text-gray-500">Session not running</p>
            <p className="text-gray-600 text-sm mt-1">Start {guest.name}&apos;s shared session first</p>
          </div>
        ) : parsed.length === 0 ? (
          <div className="text-center py-20">
            <Bot className="w-12 h-12 text-gray-700 mx-auto mb-4" />
            <p className="text-gray-500">No messages yet</p>
          </div>
        ) : (
          parsed.map((msg) => (
            <SharedBubble
              key={msg.id}
              msg={msg}
              reactions={reactions[msg.id] || {}}
              onReact={(emoji) => toggleReaction(msg.id, emoji)}
              currentUser={guest.name}
            />
          ))
        )}
      </div>

      {/* Input */}
      {guest.sharedSessionAlive && (
        <div className="flex-shrink-0 p-3 bg-gray-900 border-t border-gray-800 safe-area-bottom">
          <div className="flex items-center gap-2 max-w-lg mx-auto">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              placeholder={`Message ${guest.name}...`}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || sending}
              className="p-3 rounded-xl bg-blue-600 text-white disabled:opacity-40 active:scale-95 transition-all flex-shrink-0"
            >
              {sending ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SharedBubble({
  msg,
  reactions,
  onReact,
  currentUser,
}: {
  msg: ParsedMessage;
  reactions: { [emoji: string]: string[] };
  onReact: (emoji: string) => void;
  currentUser: string;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPicker) return;
    const handleTap = (e: MouseEvent | TouchEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener('mousedown', handleTap);
    document.addEventListener('touchstart', handleTap);
    return () => {
      document.removeEventListener('mousedown', handleTap);
      document.removeEventListener('touchstart', handleTap);
    };
  }, [showPicker]);

  const hasReactions = Object.keys(reactions).length > 0;

  const reactionBar = (
    <div className="relative">
      {/* Existing reactions */}
      {hasReactions && (
        <div className="flex flex-wrap gap-1 mt-1">
          {Object.entries(reactions).map(([emoji, users]) => {
            const iReacted = users.includes(currentUser);
            return (
              <button
                key={emoji}
                onClick={() => onReact(emoji)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-all active:scale-95 ${
                  iReacted
                    ? 'bg-blue-600/30 border border-blue-500/50'
                    : 'bg-gray-800 border border-gray-700'
                }`}
              >
                <span>{emoji}</span>
                <span className="text-gray-400">{users.length}</span>
              </button>
            );
          })}
          <button
            onClick={() => setShowPicker(!showPicker)}
            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-gray-800 border border-gray-700 text-gray-500 active:scale-95 transition-all"
          >
            +
          </button>
        </div>
      )}

      {/* Add reaction button (when no reactions yet) */}
      {!hasReactions && (
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="mt-1 text-gray-600 hover:text-gray-400 text-xs active:scale-95 transition-all"
        >
          +
        </button>
      )}

      {/* Emoji picker */}
      {showPicker && (
        <div
          ref={pickerRef}
          className="absolute z-10 mt-1 flex flex-wrap gap-1 bg-gray-900 border border-gray-700 rounded-xl p-2 shadow-lg max-w-[320px] max-h-[200px] overflow-y-auto"
        >
          {REACTION_EMOJIS.map((emoji) => {
            const alreadyReacted = reactions[emoji]?.includes(currentUser);
            return (
              <button
                key={emoji}
                onClick={() => onReact(emoji)}
                className={`text-lg active:scale-95 transition-transform p-1 rounded ${
                  alreadyReacted ? 'bg-blue-600/30' : 'hover:scale-125'
                }`}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  if (msg.sender === 'claude') {
    return (
      <div className="flex gap-2">
        <div className="w-7 h-7 rounded-full bg-[#00FF66]/20 flex items-center justify-center flex-shrink-0 mt-1">
          <Bot className="w-3.5 h-3.5 text-[#00FF66]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-[#00FF66] mb-0.5">Claude</div>
          <div className="bg-gray-800 rounded-xl p-3 text-sm text-white prose prose-invert prose-sm max-w-none [&_pre]:bg-gray-900 [&_pre]:p-2 [&_pre]:rounded [&_code]:text-[#00FF66] [&_p]:m-0 [&_p]:mb-1 [&_p:last-child]:mb-0 [&_ul]:m-0 [&_ol]:m-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.displayContent.length > 2000 ? msg.displayContent.slice(0, 2000) + '\n\n...' : msg.displayContent}
            </ReactMarkdown>
          </div>
          {reactionBar}
        </div>
      </div>
    );
  }

  if (msg.sender === 'owner') {
    return (
      <div className="flex gap-2 justify-end">
        <div className="max-w-[85%]">
          <div className="text-[10px] text-blue-400 mb-0.5 text-right">{msg.senderName}</div>
          <div className="bg-blue-600/30 border border-blue-600/40 rounded-xl p-3 text-sm text-white">
            <p className="whitespace-pre-wrap break-words">{msg.displayContent}</p>
          </div>
          <div className="flex justify-end">{reactionBar}</div>
        </div>
        <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 mt-1">
          <User className="w-3.5 h-3.5 text-blue-400" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <div className="w-7 h-7 rounded-full bg-[#FF6600]/20 flex items-center justify-center flex-shrink-0 mt-1">
        <User className="w-3.5 h-3.5 text-[#FF6600]" />
      </div>
      <div className="max-w-[85%]">
        <div className="text-[10px] text-[#FF6600] mb-0.5">{msg.senderName}</div>
        <div className="bg-[#FF6600]/20 border border-[#FF6600]/30 rounded-xl p-3 text-sm text-white">
          <p className="whitespace-pre-wrap break-words">{msg.displayContent}</p>
        </div>
        {reactionBar}
      </div>
    </div>
  );
}
