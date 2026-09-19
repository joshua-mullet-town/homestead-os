'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Terminal, RefreshCw, Folder } from 'lucide-react';

interface Session {
  name: string;
  project: string;
  created: string;
  windows: number;
}

export default function SessionList() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/sessions');
      if (response.ok) {
        const data = await response.json();
        setSessions(data.sessions || []);
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 style={{ fontFamily: 'VT323, monospace' }} className="text-3xl text-[#FFCC00]">
          HOMESTEAD
        </h1>
        <button
          onClick={fetchSessions}
          disabled={loading}
          className="p-2 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
        >
          <RefreshCw size={20} className={`text-[#FF6600] ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Sessions */}
      <div className="space-y-3">
        {sessions.length === 0 ? (
          <div className="bg-gray-900 border-2 border-[#FF6600] rounded-lg p-8 text-center">
            <Terminal size={48} className="text-[#FF6600] mx-auto mb-4 opacity-50" />
            <p style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FF6600]">
              No active sessions
            </p>
            <p style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-500 mt-2">
              Run `holler here --continue` to start a session
            </p>
          </div>
        ) : (
          sessions.map((session) => (
            <button
              key={session.name}
              onClick={() => router.push(`/session/${session.project}`)}
              className="w-full bg-gray-900 border-2 border-[#FF6600] hover:border-[#FFCC00] rounded-lg p-4 text-left transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="bg-[#FF6600] p-2 rounded">
                  <Terminal size={24} className="text-black" />
                </div>
                <div className="flex-1 min-w-0">
                  <div style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FFCC00] truncate">
                    {session.project}
                  </div>
                  <div style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-500">
                    Started {formatTime(session.created)} • {session.windows} window{session.windows !== 1 ? 's' : ''}
                  </div>
                </div>
                <div className="text-[#00FF66] text-2xl">→</div>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Projects hint */}
      <div className="mt-8 p-4 bg-gray-900/50 border border-gray-800 rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <Folder size={16} className="text-gray-500" />
          <span style={{ fontFamily: 'VT323, monospace' }} className="text-sm text-gray-500">
            ~/code
          </span>
        </div>
        <p style={{ fontFamily: 'VT323, monospace' }} className="text-xs text-gray-600">
          Sessions are created with the `holler` command in your project directories
        </p>
      </div>
    </div>
  );
}
