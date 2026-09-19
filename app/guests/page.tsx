'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft, RefreshCw, UserPlus, Trash2, Play, Square, ToggleLeft, ToggleRight,
  Home, Activity, Radio, Users, Send, MessageSquare, ChevronDown, ChevronUp, Bot, User, RotateCcw
} from 'lucide-react';

interface PersonalSession {
  name: string;
  sessionName: string;
  sessionDir: string;
  alive: boolean;
}

interface SharedSession {
  sessionName: string;
  sessionDir: string;
}

interface Guest {
  login: string;
  name: string;
  shortName: string;
  profilePic: string | null;
  sharedSession: SharedSession;
  personalSessions: PersonalSession[];
  enabled: boolean;
  createdAt: string;
  lastSeen: string | null;
  sharedSessionAlive: boolean;
}

interface TailnetUser {
  login: string;
  displayName: string;
  profilePicUrl: string;
}

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

  // Try to parse [Name]: prefix
  const match = msg.content.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/);
  if (match) {
    const name = match[1];
    const content = match[2];
    if (name === guestName) {
      return { ...msg, sender: 'guest', senderName: name, displayContent: content };
    }
    return { ...msg, sender: 'owner', senderName: name, displayContent: content };
  }

  // No prefix — default to guest (pre-attribution messages)
  return { ...msg, sender: 'guest', senderName: guestName, displayContent: msg.content };
}

export default function GuestsPage() {
  const router = useRouter();
  const [guests, setGuests] = useState<Guest[]>([]);
  const [tailnetUsers, setTailnetUsers] = useState<TailnetUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [replyInputs, setReplyInputs] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState<string | null>(null);
  const [expandedChats, setExpandedChats] = useState<Record<string, boolean>>({});
  const [chatMessages, setChatMessages] = useState<Record<string, ChatMessage[]>>({});
  const [chatReactions, setChatReactions] = useState<Record<string, ReactionMap>>({});
  const [ownerName, setOwnerName] = useState('Josh');

  const fetchGuests = useCallback(async () => {
    try {
      const res = await fetch('/api/guests');
      if (res.ok) {
        const data = await res.json();
        setGuests(data.guests || []);
        // Derive owner name from owner email
        if (data.owner) {
          const local = data.owner.split('@')[0] || 'Josh';
          setOwnerName(local.charAt(0).toUpperCase() + local.slice(1));
        }
      }
    } catch (e) {
      console.error('Failed to fetch guests:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTailnetUsers = async () => {
    try {
      const res = await fetch('/api/guests/tailnet');
      if (res.ok) {
        const data = await res.json();
        setTailnetUsers(data.users || []);
      }
    } catch (e) {
      console.error('Failed to fetch tailnet users:', e);
    }
  };

  const fetchChatMessages = useCallback(async (sessionName: string, guestLogin: string) => {
    try {
      const [msgRes, reactRes] = await Promise.all([
        fetch(`/api/chat-messages/guest?session=${encodeURIComponent(sessionName)}`),
        fetch(`/api/guests/reactions?session=${encodeURIComponent(sessionName)}`),
      ]);
      if (msgRes.ok) {
        const data = await msgRes.json();
        setChatMessages(prev => ({ ...prev, [guestLogin]: data.messages || [] }));
      }
      if (reactRes.ok) {
        const data = await reactRes.json();
        setChatReactions(prev => ({ ...prev, [guestLogin]: data.reactions || {} }));
      }
    } catch (e) {
      console.error('Failed to fetch chat messages:', e);
    }
  }, []);

  // Poll chat messages for expanded guests
  useEffect(() => {
    const expandedGuests = guests.filter(g => expandedChats[g.login] && g.sharedSessionAlive);
    if (expandedGuests.length === 0) return;

    // Fetch immediately
    expandedGuests.forEach(g => fetchChatMessages(g.sharedSession.sessionName, g.login));

    // Poll every 3s
    const interval = setInterval(() => {
      expandedGuests.forEach(g => fetchChatMessages(g.sharedSession.sessionName, g.login));
    }, 3000);

    return () => clearInterval(interval);
  }, [expandedChats, guests, fetchChatMessages]);

  const refresh = async () => {
    setRefreshing(true);
    await fetchGuests();
    setRefreshing(false);
  };

  useEffect(() => {
    fetchGuests();
    const interval = setInterval(fetchGuests, 10000);
    return () => clearInterval(interval);
  }, [fetchGuests]);

  const addGuest = async (user: TailnetUser) => {
    setActionLoading(user.login);
    try {
      await fetch('/api/guests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: user.login, name: user.displayName, profilePic: user.profilePicUrl }),
      });
      await fetchGuests();
      setShowAddPanel(false);
    } catch (e) {
      console.error('Failed to add guest:', e);
    }
    setActionLoading(null);
  };

  const removeGuest = async (login: string) => {
    setActionLoading(login);
    try {
      await fetch(`/api/guests?login=${encodeURIComponent(login)}`, { method: 'DELETE' });
      await fetchGuests();
    } catch (e) {
      console.error('Failed to remove guest:', e);
    }
    setActionLoading(null);
  };

  const toggleGuest = async (login: string, enabled: boolean) => {
    setActionLoading(login);
    try {
      await fetch('/api/guests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, enabled }),
      });
      await fetchGuests();
    } catch (e) {
      console.error('Failed to toggle guest:', e);
    }
    setActionLoading(null);
  };

  const createSession = async (login: string) => {
    setActionLoading(login);
    try {
      await fetch('/api/guests/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login }),
      });
      await fetchGuests();
    } catch (e) {
      console.error('Failed to create session:', e);
    }
    setActionLoading(null);
  };

  const killSession = async (login: string) => {
    setActionLoading(login);
    try {
      await fetch('/api/guests/session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login }),
      });
      await fetchGuests();
    } catch (e) {
      console.error('Failed to kill session:', e);
    }
    setActionLoading(null);
  };

  const restartSession = async (login: string) => {
    setActionLoading(login);
    try {
      await fetch('/api/guests/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login }),
      });
      await fetchGuests();
    } catch (e) {
      console.error('Failed to restart session:', e);
    }
    setActionLoading(null);
  };

  const sendSharedMessage = async (guestLogin: string) => {
    const message = replyInputs[guestLogin]?.trim();
    if (!message) return;

    setSendingReply(guestLogin);
    try {
      await fetch('/api/guests/send-shared-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestLogin, message }),
      });
      setReplyInputs(prev => ({ ...prev, [guestLogin]: '' }));
      // Refresh messages after sending
      const guest = guests.find(g => g.login === guestLogin);
      if (guest) {
        setTimeout(() => fetchChatMessages(guest.sharedSession.sessionName, guestLogin), 1000);
      }
    } catch (e) {
      console.error('Failed to send message:', e);
    }
    setSendingReply(null);
  };

  const toggleReaction = useCallback(async (guestLogin: string, sessionName: string, messageId: string, emoji: string) => {
    try {
      const res = await fetch('/api/guests/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: sessionName,
          messageId,
          emoji,
          userName: ownerName,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setChatReactions(prev => ({ ...prev, [guestLogin]: data.reactions || {} }));
      }
    } catch (e) {
      console.error('Failed to toggle reaction:', e);
    }
  }, [ownerName]);

  const toggleChat = (login: string) => {
    setExpandedChats(prev => ({ ...prev, [login]: !prev[login] }));
  };

  function timeAgo(isoString: string | null): string {
    if (!isoString) return 'never';
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  return (
    <div className="min-h-screen bg-black text-white p-4 pb-24">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/')}
              className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 style={{ fontFamily: 'VT323, monospace' }} className="text-3xl text-[#FF6600]">
              GUESTS
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowAddPanel(!showAddPanel); if (!showAddPanel) fetchTailnetUsers(); }}
              className="p-2 text-[#00FF66] hover:bg-gray-800 rounded-lg"
            >
              <UserPlus className="w-5 h-5" />
            </button>
            <button
              onClick={refresh}
              className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg"
            >
              <RefreshCw className={`w-5 h-5 ${refreshing || loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Add Guest Panel */}
        {showAddPanel && (
          <div className="bg-gray-900 border-2 border-[#00FF66] rounded-lg p-4 mb-4">
            <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-lg text-[#00FF66] mb-3">
              ADD FROM TAILNET
            </h2>
            {tailnetUsers.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-4">
                No available tailnet users (or tailscale not running)
              </p>
            ) : (
              <div className="space-y-2">
                {tailnetUsers.map((user) => (
                  <button
                    key={user.login}
                    onClick={() => addGuest(user)}
                    disabled={actionLoading === user.login}
                    className="w-full flex items-center gap-3 p-3 bg-gray-800 rounded-lg hover:bg-gray-700 active:scale-[0.98] transition-all disabled:opacity-50"
                  >
                    {user.profilePicUrl ? (
                      <img src={user.profilePicUrl} alt="" className="w-8 h-8 rounded-full" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-gray-400 text-sm">
                        {user.displayName?.[0] || '?'}
                      </div>
                    )}
                    <div className="flex-1 text-left min-w-0">
                      <div className="text-white text-sm font-medium truncate">{user.displayName}</div>
                      <div className="text-gray-500 text-xs truncate">{user.login}</div>
                    </div>
                    <UserPlus className="w-4 h-4 text-[#00FF66] flex-shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Guest List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-8 h-8 text-[#FF6600] animate-spin" />
          </div>
        ) : guests.length === 0 ? (
          <div className="text-center py-20">
            <Users className="w-12 h-12 text-gray-700 mx-auto mb-4" />
            <p className="text-gray-500">No guests yet</p>
            <p className="text-gray-600 text-sm mt-1">Tap + to add from your tailnet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {guests.map((guest) => {
              const isLoading = actionLoading === guest.login;
              const isExpanded = expandedChats[guest.login];
              const messages = chatMessages[guest.login] || [];
              return (
                <div
                  key={guest.login}
                  className={`bg-gray-900 border-2 rounded-lg transition-all ${
                    guest.enabled ? 'border-gray-800' : 'border-gray-800 opacity-60'
                  }`}
                >
                  <div className="p-4">
                    {/* Guest info row */}
                    <div className="flex items-center gap-3 mb-3">
                      {guest.profilePic ? (
                        <img src={guest.profilePic} alt="" className="w-10 h-10 rounded-full" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-[#FF6600]/20 flex items-center justify-center text-[#FF6600] font-bold">
                          {guest.name?.[0]?.toUpperCase() || '?'}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-white font-medium truncate">{guest.name}</div>
                        <div className="text-gray-500 text-xs truncate">{guest.login}</div>
                      </div>
                      {/* Shared session status dot */}
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            guest.sharedSessionAlive ? 'bg-[#00FF66]' : 'bg-gray-600'
                          }`}
                          title={guest.sharedSessionAlive ? 'Shared session running' : 'No shared session'}
                        />
                      </div>
                    </div>

                    {/* Meta */}
                    <div className="flex items-center gap-4 text-xs text-gray-500 mb-3">
                      <span>Last seen: {timeAgo(guest.lastSeen)}</span>
                      <span>{guest.sharedSession?.sessionName}</span>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      {/* Toggle enabled */}
                      <button
                        onClick={() => toggleGuest(guest.login, !guest.enabled)}
                        disabled={isLoading}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all disabled:opacity-50 ${
                          guest.enabled
                            ? 'bg-[#00FF66]/10 text-[#00FF66]'
                            : 'bg-gray-800 text-gray-500'
                        }`}
                      >
                        {guest.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                        {guest.enabled ? 'ON' : 'OFF'}
                      </button>

                      {/* Session control */}
                      {guest.sharedSessionAlive ? (
                        <>
                          <button
                            onClick={() => restartSession(guest.login)}
                            disabled={isLoading}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-yellow-900/30 text-yellow-400 transition-all disabled:opacity-50"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            RESTART
                          </button>
                          <button
                            onClick={() => killSession(guest.login)}
                            disabled={isLoading}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-red-900/30 text-red-400 transition-all disabled:opacity-50"
                          >
                            <Square className="w-3.5 h-3.5" />
                            KILL
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => createSession(guest.login)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-[#00FF66]/10 text-[#00FF66] transition-all disabled:opacity-50"
                        >
                          <Play className="w-3.5 h-3.5" />
                          START
                        </button>
                      )}

                      {/* Chat toggle */}
                      {guest.sharedSessionAlive && (
                        <button
                          onClick={() => toggleChat(guest.login)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all ${
                            isExpanded ? 'bg-blue-600/20 text-blue-400' : 'bg-gray-800 text-gray-400'
                          }`}
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                      )}

                      {/* Spacer */}
                      <div className="flex-1" />

                      {/* Remove */}
                      <button
                        onClick={() => removeGuest(guest.login)}
                        disabled={isLoading}
                        className="p-1.5 text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Expandable Chat View */}
                  {isExpanded && guest.sharedSessionAlive && (
                    <SharedChatView
                      messages={messages}
                      guestName={guest.name}
                      ownerName={ownerName}
                      guestLogin={guest.login}
                      replyInput={replyInputs[guest.login] || ''}
                      onReplyChange={(val) => setReplyInputs(prev => ({ ...prev, [guest.login]: val }))}
                      onSend={() => sendSharedMessage(guest.login)}
                      sending={sendingReply === guest.login}
                      reactions={chatReactions[guest.login] || {}}
                      onReact={(messageId, emoji) => toggleReaction(guest.login, guest.sharedSession.sessionName, messageId, emoji)}
                    />
                  )}

                  {/* Personal sessions list */}
                  {guest.personalSessions && guest.personalSessions.length > 0 && (
                    <div className="px-4 pb-4 pt-2 border-t border-gray-800">
                      <div className="text-xs text-gray-500 mb-2" style={{ fontFamily: 'VT323, monospace' }}>
                        PERSONAL SESSIONS
                      </div>
                      <div className="space-y-1">
                        {guest.personalSessions.map((session) => (
                          <div
                            key={session.name}
                            className="flex items-center gap-2 text-sm text-gray-400"
                          >
                            <span className={`w-2 h-2 rounded-full ${session.alive ? 'bg-[#00FF66]' : 'bg-gray-600'}`} />
                            <span className="truncate">{session.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom Nav */}
      <BottomNav currentPage="guests" router={router} />
    </div>
  );
}

/** Inline shared chat view with attribution and markdown */
function SharedChatView({
  messages,
  guestName,
  ownerName,
  guestLogin,
  replyInput,
  onReplyChange,
  onSend,
  sending,
  reactions,
  onReact,
}: {
  messages: ChatMessage[];
  guestName: string;
  ownerName: string;
  guestLogin: string;
  replyInput: string;
  onReplyChange: (val: string) => void;
  onSend: () => void;
  sending: boolean;
  reactions: ReactionMap;
  onReact: (messageId: string, emoji: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  // Only auto-scroll when new messages arrive, not on every poll
  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
    prevCountRef.current = messages.length;
  }, [messages]);

  const parsed = messages
    .filter(m => !(m.role === 'assistant' && m.content.trim() === '---'))
    .map(m => parseAttribution(m, guestName, ownerName));

  return (
    <div className="border-t border-gray-800">
      {/* Messages area */}
      <div ref={scrollRef} className="max-h-96 overflow-y-auto p-3 space-y-3">
        {parsed.length === 0 ? (
          <div className="text-center py-8">
            <Bot className="w-8 h-8 text-gray-700 mx-auto mb-2" />
            <p className="text-gray-600 text-xs">No messages yet</p>
          </div>
        ) : (
          parsed.map((msg) => (
            <SharedBubble
              key={msg.id}
              msg={msg}
              reactions={reactions[msg.id] || {}}
              onReact={(emoji) => onReact(msg.id, emoji)}
              currentUser={ownerName}
            />
          ))
        )}
      </div>

      {/* Reply input */}
      <div className="flex items-center gap-2 p-3 bg-gray-950 border-t border-gray-800">
        <input
          type="text"
          value={replyInput}
          onChange={(e) => onReplyChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSend()}
          placeholder={`Reply to ${guestName}...`}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={onSend}
          disabled={!replyInput.trim() || sending}
          className="p-2 rounded-lg bg-blue-600 text-white disabled:opacity-40 active:scale-95 transition-all"
        >
          {sending ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}

/** Individual message bubble with attribution colors and reactions */
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
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleLongPressStart = () => {
    longPressTimer.current = setTimeout(() => {
      setShowPicker(true);
    }, 500);
  };
  const handleLongPressEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowPicker(true);
  };

  const hasReactions = Object.keys(reactions).length > 0;

  const reactionBar = (
    <div className="relative">
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

  const longPressProps = {
    onTouchStart: handleLongPressStart,
    onTouchEnd: handleLongPressEnd,
    onTouchCancel: handleLongPressEnd,
    onContextMenu: handleContextMenu,
  };

  if (msg.sender === 'claude') {
    return (
      <div className="flex gap-2">
        <div className="w-6 h-6 rounded-full bg-[#00FF66]/20 flex items-center justify-center flex-shrink-0 mt-1">
          <Bot className="w-3 h-3 text-[#00FF66]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-[#00FF66] mb-0.5">Claude</div>
          <div
            {...longPressProps}
            className="bg-gray-800 rounded-xl p-2.5 text-sm text-white prose prose-invert prose-sm max-w-none [&_pre]:bg-gray-900 [&_pre]:p-2 [&_pre]:rounded [&_code]:text-[#00FF66] [&_p]:m-0 [&_p]:mb-1 [&_p:last-child]:mb-0 [&_ul]:m-0 [&_ol]:m-0"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {msg.displayContent.length > 1500 ? msg.displayContent.slice(0, 1500) + '\n\n...' : msg.displayContent}
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
          <div
            {...longPressProps}
            className="bg-blue-600/30 border border-blue-600/40 rounded-xl p-2.5 text-sm text-white"
          >
            <p className="whitespace-pre-wrap break-words">{msg.displayContent}</p>
          </div>
          <div className="flex justify-end">{reactionBar}</div>
        </div>
        <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 mt-1">
          <User className="w-3 h-3 text-blue-400" />
        </div>
      </div>
    );
  }

  // Guest message
  return (
    <div className="flex gap-2">
      <div className="w-6 h-6 rounded-full bg-[#FF6600]/20 flex items-center justify-center flex-shrink-0 mt-1">
        <User className="w-3 h-3 text-[#FF6600]" />
      </div>
      <div className="max-w-[85%]">
        <div className="text-[10px] text-[#FF6600] mb-0.5">{msg.senderName}</div>
        <div
          {...longPressProps}
          className="bg-[#FF6600]/20 border border-[#FF6600]/30 rounded-xl p-2.5 text-sm text-white"
        >
          <p className="whitespace-pre-wrap break-words">{msg.displayContent}</p>
        </div>
        {reactionBar}
      </div>
    </div>
  );
}

function BottomNav({ currentPage, router }: { currentPage: string; router: ReturnType<typeof useRouter> }) {
  const tabs = [
    { id: 'home', label: 'Home', icon: Home, path: '/' },
    { id: 'status', label: 'Status', icon: Activity, path: '/status' },
    { id: 'remote', label: 'Remote', icon: Radio, path: '/remote' },
    { id: 'guests', label: 'Guests', icon: Users, path: '/guests' },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-800 px-2 py-2 safe-area-bottom z-50">
      <div className="flex justify-around max-w-lg mx-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentPage === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => router.push(tab.path)}
              className={`flex flex-col items-center gap-1 px-4 py-2 rounded-xl transition-all active:scale-95 ${
                isActive ? 'text-[#FF6600]' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <Icon className="w-6 h-6" />
              <span className="text-xs font-medium" style={{ fontFamily: 'VT323, monospace' }}>
                {tab.label.toUpperCase()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
