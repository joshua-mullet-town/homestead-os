'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal, Mic, Send, ArrowLeft, RefreshCw, User, Bot, MicOff, Square, Circle } from 'lucide-react';

interface Session {
  name: string;
  project: string;
  branch: string;
  path: string;
  isWorktree: boolean;
}

interface Message {
  uuid: string;
  type: 'user' | 'assistant';
  message: string;
  timestamp?: string;
}

export default function RemoteControl() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (e) {
      console.error('Failed to fetch sessions:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch conversation for selected session
  const fetchMessages = useCallback(async (sessionName: string) => {
    setLoadingMessages(true);
    try {
      // Extract project name from session (format: holler-{project})
      const project = sessionName.replace('holler-', '');
      const res = await fetch(`/api/chat-messages/${project}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  // Refresh handler
  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchSessions();
    if (selectedSession) {
      await fetchMessages(selectedSession);
    }
    setRefreshing(false);
  };

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 30000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  useEffect(() => {
    if (selectedSession) {
      fetchMessages(selectedSession);
      // Poll for new messages
      const interval = setInterval(() => fetchMessages(selectedSession), 5000);
      return () => clearInterval(interval);
    }
  }, [selectedSession, fetchMessages]);

  // Voice recording functions
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await transcribeAndSend(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingDuration(0);
      timerRef.current = setInterval(() => {
        setRecordingDuration(d => d + 1);
      }, 1000);
    } catch (e) {
      console.error('Failed to start recording:', e);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  const transcribeAndSend = async (audioBlob: Blob) => {
    if (!selectedSession) return;

    setIsTranscribing(true);
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.webm');
      formData.append('session', selectedSession);

      const res = await fetch('/api/transcribe-and-send', {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          // Refresh messages to show the sent message
          setTimeout(() => fetchMessages(selectedSession), 1000);
        }
      }
    } catch (e) {
      console.error('Failed to transcribe:', e);
    } finally {
      setIsTranscribing(false);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Session List View
  if (!selectedSession) {
    return (
      <div className="min-h-screen bg-black p-4 safe-area-inset">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1
            className="text-3xl text-[#FF6600] font-bold"
            style={{ fontFamily: 'system-ui' }}
          >
            REMOTE
          </h1>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-3 rounded-xl bg-gray-900 text-gray-400 hover:text-white active:scale-95 transition-all"
          >
            <RefreshCw className={`w-6 h-6 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Session List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-8 h-8 text-[#FF6600] animate-spin" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            No active sessions
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => (
              <button
                key={session.name}
                onClick={() => setSelectedSession(session.name)}
                className="w-full p-5 bg-gray-900 rounded-2xl border-2 border-gray-800 hover:border-[#FF6600] active:scale-[0.98] transition-all text-left"
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-[#FF6600]/20 flex items-center justify-center">
                    <Terminal className="w-6 h-6 text-[#FF6600]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xl font-bold text-white truncate">
                      {session.project}
                    </div>
                    <div className="text-sm text-gray-500 truncate">
                      {session.branch}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Conversation View
  const selectedSessionData = sessions.find(s => s.name === selectedSession);

  return (
    <div className="min-h-screen bg-black flex flex-col safe-area-inset">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-3 p-4 bg-gray-900 border-b border-gray-800">
        <button
          onClick={() => setSelectedSession(null)}
          className="p-2 rounded-xl text-[#FF6600] hover:bg-gray-800 active:scale-95 transition-all"
        >
          <ArrowLeft className="w-6 h-6" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold text-[#FFCC00] truncate">
            {selectedSessionData?.project || selectedSession}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {selectedSessionData?.branch}
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-2 rounded-xl text-gray-400 hover:text-white active:scale-95 transition-all"
        >
          <RefreshCw className={`w-5 h-5 ${refreshing || loadingMessages ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loadingMessages && messages.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-8 h-8 text-[#FF6600] animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            No conversation yet
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.uuid}
              className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.type === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-[#00FF66]/20 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-4 h-4 text-[#00FF66]" />
                </div>
              )}
              <div
                className={`max-w-[80%] p-3 rounded-2xl ${
                  msg.type === 'user'
                    ? 'bg-[#FF6600] text-black'
                    : 'bg-gray-800 text-white'
                }`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">
                  {msg.message.length > 500 ? msg.message.slice(0, 500) + '...' : msg.message}
                </p>
              </div>
              {msg.type === 'user' && (
                <div className="w-8 h-8 rounded-full bg-[#FF6600]/20 flex items-center justify-center flex-shrink-0">
                  <User className="w-4 h-4 text-[#FF6600]" />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Voice Input Bar */}
      <div className="flex-shrink-0 p-4 bg-gray-900 border-t border-gray-800">
        {isTranscribing ? (
          <div className="flex items-center justify-center gap-3 py-4">
            <RefreshCw className="w-6 h-6 text-[#FFCC00] animate-spin" />
            <span className="text-[#FFCC00] font-medium">Transcribing...</span>
          </div>
        ) : isRecording ? (
          <button
            onClick={stopRecording}
            className="w-full py-5 rounded-2xl bg-[#FF3333] flex items-center justify-center gap-4 active:scale-[0.98] transition-all"
          >
            <div className="relative">
              <Circle className="w-8 h-8 text-white fill-white animate-pulse" />
            </div>
            <span className="text-white text-xl font-bold">
              {formatDuration(recordingDuration)} - Tap to Send
            </span>
          </button>
        ) : (
          <button
            onClick={startRecording}
            className="w-full py-5 rounded-2xl bg-[#FF6600] flex items-center justify-center gap-3 active:scale-[0.98] transition-all"
          >
            <Mic className="w-8 h-8 text-black" />
            <span className="text-black text-xl font-bold">Hold to Speak</span>
          </button>
        )}
      </div>
    </div>
  );
}
