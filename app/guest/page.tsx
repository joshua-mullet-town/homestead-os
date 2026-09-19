'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, User, Send, RefreshCw, Plus, Trash2, MessageSquare, Folder, Users, RotateCcw, Mic } from 'lucide-react';

interface SharedSession {
  sessionName: string;
  sessionDir: string;
  alive: boolean;
}

interface PersonalSession {
  name: string;
  sessionName: string;
  sessionDir: string;
  alive: boolean;
}

interface Identity {
  role: string;
  login: string | null;
  name: string | null;
  shortName?: string;
  profilePic: string | null;
  sharedSession: SharedSession | null;
  personalSessions: PersonalSession[];
  ownerName?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sender?: 'owner' | 'guest' | 'claude';
  senderName?: string;
}

type ActiveTab = 'shared' | 'sessions';

export default function GuestPage() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('shared');
  const [activePersonalSession, setActivePersonalSession] = useState<string | null>(null);
  const [personalMessages, setPersonalMessages] = useState<Message[]>([]);
  const [newSessionName, setNewSessionName] = useState('');
  const [creatingSession, setCreatingSession] = useState(false);
  const [restartingSession, setRestartingSession] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevMsgCountRef = useRef(0);
  const prevPersonalCountRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const isHoldingRef = useRef(false);

  const fetchIdentity = useCallback(async () => {
    try {
      const res = await fetch('/api/guest/identity');
      if (res.ok) {
        const data = await res.json();
        setIdentity(data);
      }
    } catch (e) {
      console.error('Failed to fetch identity:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMessages = useCallback(async (sessionParam?: string) => {
    try {
      const url = sessionParam
        ? `/api/guest/messages?session=${encodeURIComponent(sessionParam)}`
        : '/api/guest/messages';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (sessionParam) {
          setPersonalMessages(data.messages || []);
        } else {
          setMessages(data.messages || []);
        }
      }
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    }
  }, []);

  useEffect(() => {
    fetchIdentity();
  }, [fetchIdentity]);

  // Poll shared messages
  useEffect(() => {
    if (identity?.role !== 'guest' || !identity?.sharedSession) return;
    if (activeTab !== 'shared') return;

    fetchMessages();
    const interval = setInterval(() => fetchMessages(), 2000);
    return () => clearInterval(interval);
  }, [identity, fetchMessages, activeTab]);

  // Poll personal session messages
  useEffect(() => {
    if (!activePersonalSession) return;
    if (activeTab !== 'sessions') return;

    fetchMessages(activePersonalSession);
    const interval = setInterval(() => fetchMessages(activePersonalSession), 2000);
    return () => clearInterval(interval);
  }, [activePersonalSession, fetchMessages, activeTab]);

  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    if (personalMessages.length > prevPersonalCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevPersonalCountRef.current = personalMessages.length;
  }, [personalMessages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput('');
    try {
      const sessionParam = activeTab === 'sessions' && activePersonalSession
        ? `?session=${encodeURIComponent(activePersonalSession)}`
        : '';
      await fetch(`/api/guest/send-message${sessionParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      // Fetch messages after a short delay
      setTimeout(() => {
        if (activeTab === 'sessions' && activePersonalSession) {
          fetchMessages(activePersonalSession);
        } else {
          fetchMessages();
        }
      }, 1000);
    } catch (e) {
      console.error('Failed to send:', e);
    }
    setSending(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const createPersonalSession = async () => {
    if (!newSessionName.trim() || creatingSession) return;
    setCreatingSession(true);
    try {
      const res = await fetch('/api/guest/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSessionName.trim() }),
      });
      if (res.ok) {
        setNewSessionName('');
        fetchIdentity(); // refresh sessions list
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to create session');
      }
    } catch (e) {
      console.error('Failed to create session:', e);
    }
    setCreatingSession(false);
  };

  const restartSharedSession = async () => {
    if (restartingSession) return;
    setRestartingSession(true);
    try {
      await fetch('/api/guest/restart-session', { method: 'POST' });
      // Wait a bit then refresh identity to pick up alive status
      setTimeout(() => fetchIdentity(), 3000);
    } catch (e) {
      console.error('Failed to restart session:', e);
    }
    setRestartingSession(false);
  };

  const deletePersonalSession = async (name: string) => {
    try {
      const res = await fetch('/api/guest/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        if (activePersonalSession === name) {
          setActivePersonalSession(null);
          setPersonalMessages([]);
        }
        fetchIdentity();
      }
    } catch (e) {
      console.error('Failed to delete session:', e);
    }
  };

  // --- Walkie-talkie: hold mic to record, release to send ---

  const startRecording = async () => {
    if (isRecording || isTranscribing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        if (audioBlob.size > 0) {
          await transcribeAndSend(audioBlob);
        } else {
          setIsRecording(false);
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(100);
      setIsRecording(true);
      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => setRecordingDuration(d => d + 1), 1000);
      if (navigator.vibrate) navigator.vibrate(50);
    } catch (err) {
      console.error('Failed to start recording:', err);
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      mediaRecorderRef.current.stop();
    }
  };

  const transcribeAndSend = async (audioBlob: Blob) => {
    setIsRecording(false);
    setIsTranscribing(true);
    try {
      // Step 1: Transcribe
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      const transcribeRes = await fetch('/api/transcribe', { method: 'POST', body: formData });
      if (!transcribeRes.ok) throw new Error('Transcription failed');
      const { transcript } = await transcribeRes.json();
      if (!transcript?.trim()) {
        setIsTranscribing(false);
        return;
      }

      // Step 2: Send via guest message API (handles [Name]: prefix for shared sessions)
      const sessionParam = activeTab === 'sessions' && activePersonalSession
        ? `?session=${encodeURIComponent(activePersonalSession)}`
        : '';
      await fetch(`/api/guest/send-message${sessionParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: transcript.trim() }),
      });

      if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
      // Refresh messages
      setTimeout(() => {
        if (activeTab === 'sessions' && activePersonalSession) {
          fetchMessages(activePersonalSession);
        } else {
          fetchMessages();
        }
      }, 1000);
    } catch (e) {
      console.error('Walkie-talkie failed:', e);
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleMicPressStart = (e: React.TouchEvent | React.MouseEvent) => {
    if ('touches' in e) {
      const touch = e.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    } else {
      e.preventDefault();
    }
    isHoldingRef.current = false;
    holdTimerRef.current = setTimeout(() => {
      isHoldingRef.current = true;
      startRecording();
    }, 200);
  };

  const handleMicPressMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current || !holdTimerRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    if (Math.sqrt(dx * dx + dy * dy) > 15) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      touchStartRef.current = null;
    }
  };

  const handleMicPressEnd = () => {
    touchStartRef.current = null;
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (isHoldingRef.current && isRecording) {
      stopRecording();
    }
    isHoldingRef.current = false;
  };

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-[#FF6600] animate-spin" />
      </div>
    );
  }

  if (!identity || identity.role !== 'guest') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <h1 style={{ fontFamily: 'VT323, monospace' }} className="text-3xl text-[#FF6600] mb-4">
            ACCESS DISABLED
          </h1>
          <p className="text-gray-400">
            Your guest access has been disabled or is not configured.
          </p>
        </div>
      </div>
    );
  }

  const rawMessages = activeTab === 'sessions' && activePersonalSession ? personalMessages : messages;
  // Filter out silent "---" responses from Claude in shared view
  const currentMessages = activeTab === 'shared'
    ? rawMessages.filter(msg => !(msg.role === 'assistant' && msg.content.trim() === '---'))
    : rawMessages;
  const isSharedView = activeTab === 'shared';
  const canSend = isSharedView
    ? identity.sharedSession?.alive
    : activePersonalSession && identity.personalSessions?.find(s => s.name === activePersonalSession)?.alive;

  return (
    <div className="h-screen bg-black flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-3 p-4 bg-gray-900 border-b border-gray-800">
        {identity.profilePic ? (
          <img src={identity.profilePic} alt="" className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-[#FF6600]/20 flex items-center justify-center text-[#FF6600] font-bold text-sm">
            {identity.name?.[0]?.toUpperCase() || '?'}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div style={{ fontFamily: 'VT323, monospace' }} className="text-lg text-[#FF6600]">
            HOMESTEAD
          </div>
          <div className="text-xs text-gray-500 truncate">
            Hi {identity.name}
          </div>
        </div>
        {activeTab === 'shared' && identity.sharedSession && (
          <button
            onClick={restartSharedSession}
            disabled={restartingSession}
            className="p-2 text-yellow-400 hover:bg-gray-800 rounded-lg disabled:opacity-50"
            title="Restart shared session"
          >
            <RotateCcw className={`w-5 h-5 ${restartingSession ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {/* Tab Bar */}
      <div className="flex-shrink-0 flex bg-gray-900 border-b border-gray-800">
        <button
          onClick={() => setActiveTab('shared')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            activeTab === 'shared'
              ? 'text-[#FF6600] border-b-2 border-[#FF6600]'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <Users className="w-4 h-4" />
          <span style={{ fontFamily: 'VT323, monospace' }}>SHARED</span>
          {identity.sharedSession?.alive && (
            <span className="w-2 h-2 rounded-full bg-[#00FF66]" />
          )}
        </button>
        <button
          onClick={() => setActiveTab('sessions')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
            activeTab === 'sessions'
              ? 'text-[#FF6600] border-b-2 border-[#FF6600]'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <Folder className="w-4 h-4" />
          <span style={{ fontFamily: 'VT323, monospace' }}>MY SESSIONS</span>
          {(identity.personalSessions || []).some(s => s.alive) && (
            <span className="w-2 h-2 rounded-full bg-[#00FF66]" />
          )}
        </button>
      </div>

      {/* Content Area */}
      {activeTab === 'shared' ? (
        /* Shared Chat */
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!identity.sharedSession?.alive ? (
            <div className="text-center py-20">
              <MessageSquare className="w-12 h-12 text-gray-700 mx-auto mb-4" />
              <p className="text-gray-500">Shared session not started yet</p>
              <p className="text-gray-600 text-sm mt-1">Ask {identity.ownerName || 'the owner'} to start your session</p>
            </div>
          ) : currentMessages.length === 0 ? (
            <div className="text-center py-20">
              <Bot className="w-12 h-12 text-gray-700 mx-auto mb-4" />
              <p className="text-gray-500">No messages yet</p>
              <p className="text-gray-600 text-sm mt-1">
                Chat with {identity.ownerName || 'the owner'} and Claude
              </p>
            </div>
          ) : (
            <>
              {currentMessages.map((msg) => (
                <SharedMessageBubble key={msg.id} msg={msg} guestName={identity.name || ''} />
              ))}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      ) : activePersonalSession ? (
        /* Personal Session Chat */
        <div className="flex-1 overflow-y-auto flex flex-col">
          {/* Back to sessions list */}
          <button
            onClick={() => { setActivePersonalSession(null); setPersonalMessages([]); }}
            className="flex-shrink-0 flex items-center gap-2 px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-900/50"
          >
            <span>&larr;</span>
            <span>{activePersonalSession}</span>
          </button>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {personalMessages.length === 0 ? (
              <div className="text-center py-20">
                <Bot className="w-12 h-12 text-gray-700 mx-auto mb-4" />
                <p className="text-gray-500">No messages yet</p>
                <p className="text-gray-600 text-sm mt-1">Send a message to get started</p>
              </div>
            ) : (
              <>
                {personalMessages.map((msg) => (
                  <SimpleBubble key={msg.id} msg={msg} />
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        </div>
      ) : (
        /* Personal Sessions List */
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Create session form */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newSessionName}
              onChange={(e) => setNewSessionName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createPersonalSession()}
              placeholder="New session name..."
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-[#FF6600]"
            />
            <button
              onClick={createPersonalSession}
              disabled={!newSessionName.trim() || creatingSession}
              className="p-2 rounded-lg bg-[#00FF66]/10 text-[#00FF66] disabled:opacity-40"
            >
              {creatingSession ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
            </button>
          </div>

          {(identity.personalSessions || []).length === 0 ? (
            <div className="text-center py-16">
              <Folder className="w-12 h-12 text-gray-700 mx-auto mb-4" />
              <p className="text-gray-500">No personal sessions</p>
              <p className="text-gray-600 text-sm mt-1">Create one above to get started</p>
            </div>
          ) : (
            (identity.personalSessions || []).map((session) => (
              <div
                key={session.name}
                className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center gap-3"
              >
                <button
                  onClick={() => setActivePersonalSession(session.name)}
                  className="flex-1 flex items-center gap-3 min-w-0"
                >
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${session.alive ? 'bg-[#00FF66]' : 'bg-gray-600'}`} />
                  <span className="text-white text-sm truncate">{session.name}</span>
                </button>
                <button
                  onClick={() => deletePersonalSession(session.name)}
                  className="p-1.5 text-gray-500 hover:text-red-400 flex-shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}

          <p className="text-xs text-gray-600 text-center mt-2">
            {(identity.personalSessions || []).length}/5 sessions
          </p>
        </div>
      )}

      {/* Input Bar — shown when a sendable session is active */}
      {((activeTab === 'shared' && identity.sharedSession?.alive) ||
        (activeTab === 'sessions' && activePersonalSession && canSend)) && (
        <div className="flex-shrink-0 p-3 bg-gray-900 border-t border-gray-800 safe-area-bottom">
          <div className="flex items-end gap-2 max-w-lg mx-auto">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-500 resize-none focus:outline-none focus:border-[#FF6600]"
              style={{ maxHeight: '120px' }}
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || sending}
              className="p-3 rounded-xl bg-[#FF6600] text-black disabled:opacity-40 active:scale-95 transition-all flex-shrink-0"
            >
              {sending ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared session message bubble with three-way attribution */
function SharedMessageBubble({ msg, guestName }: { msg: Message; guestName: string }) {
  if (msg.role === 'assistant') {
    // Claude message — green, left-aligned
    return (
      <div className="flex gap-3 justify-start">
        <div className="w-8 h-8 rounded-full bg-[#00FF66]/20 flex items-center justify-center flex-shrink-0">
          <Bot className="w-4 h-4 text-[#00FF66]" />
        </div>
        <div className="max-w-[80%]">
          <div className="text-xs text-[#00FF66] mb-1">Claude</div>
          <div className="p-3 rounded-2xl bg-gray-800 text-white">
            <p className="text-sm whitespace-pre-wrap break-words">
              {msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // User message — check attribution
  if (msg.sender === 'owner') {
    // Owner message — blue, left-aligned
    return (
      <div className="flex gap-3 justify-start">
        <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
          <User className="w-4 h-4 text-blue-400" />
        </div>
        <div className="max-w-[80%]">
          <div className="text-xs text-blue-400 mb-1">{msg.senderName}</div>
          <div className="p-3 rounded-2xl bg-blue-900/40 text-white">
            <p className="text-sm whitespace-pre-wrap break-words">
              {msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Guest message — orange, right-aligned
  return (
    <div className="flex gap-3 justify-end">
      <div className="max-w-[80%]">
        <div className="text-xs text-[#FF6600] mb-1 text-right">{msg.senderName || guestName}</div>
        <div className="p-3 rounded-2xl bg-[#FF6600] text-black">
          <p className="text-sm whitespace-pre-wrap break-words">
            {msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content}
          </p>
        </div>
      </div>
      <div className="w-8 h-8 rounded-full bg-[#FF6600]/20 flex items-center justify-center flex-shrink-0">
        <User className="w-4 h-4 text-[#FF6600]" />
      </div>
    </div>
  );
}

/** Simple message bubble for personal sessions (no attribution) */
function SimpleBubble({ msg }: { msg: Message }) {
  return (
    <div className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      {msg.role === 'assistant' && (
        <div className="w-8 h-8 rounded-full bg-[#00FF66]/20 flex items-center justify-center flex-shrink-0">
          <Bot className="w-4 h-4 text-[#00FF66]" />
        </div>
      )}
      <div
        className={`max-w-[80%] p-3 rounded-2xl ${
          msg.role === 'user'
            ? 'bg-[#FF6600] text-black'
            : 'bg-gray-800 text-white'
        }`}
      >
        <p className="text-sm whitespace-pre-wrap break-words">
          {msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content}
        </p>
      </div>
      {msg.role === 'user' && (
        <div className="w-8 h-8 rounded-full bg-[#FF6600]/20 flex items-center justify-center flex-shrink-0">
          <User className="w-4 h-4 text-[#FF6600]" />
        </div>
      )}
    </div>
  );
}
