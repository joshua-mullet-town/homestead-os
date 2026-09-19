'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, MessageCircle, Send, ArrowLeft, WifiOff, RefreshCw, ChevronDown, Pin, EyeOff } from 'lucide-react';

const PHONE_API = 'http://100.84.84.102:8888';

interface SmsMessage {
  id: string;
  address: string;
  body: string;
  date: number;
  read?: boolean;
  type: 'received' | 'sent';
}

interface Contact {
  id: string;
  name: string;
  phone: string;
}

interface Conversation {
  address: string;
  contactName: string;
  messages: SmsMessage[];
  lastMessage: SmsMessage;
  unreadCount: number;
  isPinned?: boolean;
  isHidden?: boolean;
}

export default function SmsModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<Map<string, string>>(new Map());
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [lastSeenIds, setLastSeenIds] = useState<Set<string>>(new Set());
  const [pinnedAddresses, setPinnedAddresses] = useState<Set<string>>(new Set());
  const [hiddenAddresses, setHiddenAddresses] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load pinned/hidden from localStorage
  useEffect(() => {
    const savedPinned = localStorage.getItem('sms-pinned');
    const savedHidden = localStorage.getItem('sms-hidden');
    if (savedPinned) {
      try { setPinnedAddresses(new Set(JSON.parse(savedPinned))); } catch {}
    }
    if (savedHidden) {
      try { setHiddenAddresses(new Set(JSON.parse(savedHidden))); } catch {}
    }
  }, []);

  const togglePin = (address: string) => {
    setPinnedAddresses(prev => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      localStorage.setItem('sms-pinned', JSON.stringify([...next]));
      return next;
    });
  };

  const toggleHide = (address: string) => {
    setHiddenAddresses(prev => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      localStorage.setItem('sms-hidden', JSON.stringify([...next]));
      return next;
    });
  };

  const normalizePhone = (phone: string): string => {
    return phone.replace(/\D/g, '').slice(-10);
  };

  const checkConnection = useCallback(async () => {
    try {
      const response = await fetch(`${PHONE_API}/health`, { signal: AbortSignal.timeout(3000) });
      setConnected(response.ok);
    } catch { setConnected(false); }
    setChecking(false);
  }, []);

  const fetchContacts = useCallback(async () => {
    try {
      const response = await fetch(`${PHONE_API}/contacts?limit=1000`);
      if (response.ok) {
        const data = await response.json();
        const contactMap = new Map<string, string>();
        data.data?.forEach((c: Contact) => {
          const normalized = normalizePhone(c.phone);
          if (normalized.length >= 10 && c.name && !c.name.match(/^[\d\s\-\(\)\+]+$/)) {
            contactMap.set(normalized, c.name);
          }
        });
        setContacts(contactMap);
      }
    } catch (e) { console.error('Failed to fetch contacts:', e); }
  }, []);

  const fetchMessages = useCallback(async () => {
    if (!connected) return;
    try {
      const [inboxRes, sentRes] = await Promise.all([
        fetch(`${PHONE_API}/sms/inbox?limit=200`),
        fetch(`${PHONE_API}/sms/sent?limit=200`)
      ]);
      if (!inboxRes.ok || !sentRes.ok) return;

      const inboxData = await inboxRes.json();
      const sentData = await sentRes.json();
      const inbox: SmsMessage[] = (inboxData.data || []).map((m: any) => ({ ...m, type: 'received' as const }));
      const sent: SmsMessage[] = (sentData.data || []).map((m: any) => ({ ...m, type: 'sent' as const }));
      const allMessages = [...inbox, ...sent].sort((a, b) => a.date - b.date);

      const convMap = new Map<string, SmsMessage[]>();
      allMessages.forEach(msg => {
        const normalized = normalizePhone(msg.address);
        if (!normalized || normalized.length < 7) return;
        if (!convMap.has(normalized)) convMap.set(normalized, []);
        convMap.get(normalized)!.push(msg);
      });

      const convs: Conversation[] = [];
      convMap.forEach((messages, address) => {
        const lastMessage = messages[messages.length - 1];
        const unreadCount = messages.filter(m => m.type === 'received' && !m.read).length;
        convs.push({
          address,
          contactName: contacts.get(address) || formatPhoneNumber(address),
          messages,
          lastMessage,
          unreadCount,
          isPinned: pinnedAddresses.has(address),
          isHidden: hiddenAddresses.has(address)
        });
      });

      convs.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return b.lastMessage.date - a.lastMessage.date;
      });
      setConversations(convs);

      const currentIds = new Set(inbox.map(m => m.id));
      const newUnread = inbox.filter(m => !lastSeenIds.has(m.id) && !m.read).length;
      if (lastSeenIds.size > 0) setUnreadTotal(prev => prev + newUnread);
      setLastSeenIds(currentIds);
    } catch (e) { console.error('Failed to fetch messages:', e); }
  }, [connected, contacts, lastSeenIds, pinnedAddresses, hiddenAddresses]);

  const formatPhoneNumber = (phone: string): string => {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
    if (cleaned.length === 11 && cleaned[0] === '1') return `(${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    return phone;
  };

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const days = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (days === 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (days === 1) return 'Yest';
    if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const sendMessage = async () => {
    if (!newMessage.trim() || !selectedConversation || sending) return;
    setSending(true);
    try {
      const response = await fetch(`${PHONE_API}/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: selectedConversation, message: newMessage.trim() })
      });
      if (response.ok) { setNewMessage(''); await fetchMessages(); }
      else alert('Failed to send');
    } catch (e) { alert('Failed to send'); }
    setSending(false);
  };

  useEffect(() => { checkConnection(); fetchContacts(); }, [checkConnection, fetchContacts]);
  useEffect(() => {
    if (!connected) return;
    fetchMessages();
    const interval = setInterval(fetchMessages, 5000);
    return () => clearInterval(interval);
  }, [connected, fetchMessages]);
  useEffect(() => {
    if (selectedConversation && messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [selectedConversation, conversations]);
  useEffect(() => {
    if (selectedConversation && inputRef.current) inputRef.current.focus();
  }, [selectedConversation]);
  useEffect(() => { if (isOpen) setUnreadTotal(0); }, [isOpen]);

  const selectedConv = conversations.find(c => c.address === selectedConversation);
  const visibleConversations = conversations.filter(c => !c.isHidden);

  return (
    <>
      {/* Badge - top center */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all active:scale-95"
        style={{
          background: 'rgba(10, 10, 10, 0.95)',
          border: `2px solid ${connected ? '#00FF66' : '#FF3333'}`,
          boxShadow: connected ? '0 0 12px rgba(0, 255, 102, 0.3)' : '0 0 12px rgba(255, 51, 51, 0.3)',
        }}
      >
        <MessageCircle size={16} style={{ color: connected ? '#00FF66' : '#FF3333' }} />
        {unreadTotal > 0 && (
          <span
            className="min-w-5 h-5 flex items-center justify-center rounded-full"
            style={{ background: '#FF6600', color: '#000', fontFamily: 'VT323, monospace', fontSize: '14px', fontWeight: 'bold' }}
          >
            {unreadTotal > 9 ? '9+' : unreadTotal}
          </span>
        )}
        <ChevronDown size={14} style={{ color: connected ? '#00FF66' : '#FF3333' }} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => { setIsOpen(false); setSelectedConversation(null); }} />

          {/* Narrow centered panel */}
          <div
            className="fixed left-1/2 -translate-x-1/2 z-50 flex flex-col rounded-xl overflow-hidden"
            style={{
              top: '44px',
              width: 'min(340px, 85vw)',
              height: 'min(70vh, 520px)',
              background: '#0a0a0a',
              border: '2px solid #FF6600',
              boxShadow: '0 0 30px rgba(255, 102, 0, 0.2), inset 0 0 60px rgba(0,0,0,0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-3 py-2"
              style={{ background: 'linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%)', borderBottom: '1px solid #333' }}
            >
              {selectedConversation ? (
                <>
                  <button onClick={() => setSelectedConversation(null)} className="p-1 hover:bg-gray-800 rounded">
                    <ArrowLeft size={20} style={{ color: '#FF6600' }} />
                  </button>
                  <span style={{ fontFamily: 'VT323, monospace', fontSize: '20px', color: '#00FF66', textShadow: '0 0 10px rgba(0,255,102,0.5)' }} className="truncate flex-1 text-center mx-2">
                    {selectedConv?.contactName}
                  </span>
                  <button onClick={() => { setIsOpen(false); setSelectedConversation(null); }} className="p-1 hover:bg-gray-800 rounded">
                    <X size={20} style={{ color: '#FF6600' }} />
                  </button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span style={{ fontFamily: 'VT323, monospace', fontSize: '22px', color: '#FF6600', textShadow: '0 0 10px rgba(255,102,0,0.5)' }}>
                      SMS
                    </span>
                    {hiddenAddresses.size > 0 && (
                      <button
                        onClick={() => { setHiddenAddresses(new Set()); localStorage.removeItem('sms-hidden'); }}
                        className="px-2 py-0.5 rounded"
                        style={{ background: '#1a1a1a', border: '1px solid #555', fontFamily: 'VT323, monospace', fontSize: '12px', color: '#888' }}
                      >
                        {hiddenAddresses.size} HIDDEN
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: connected ? '#00FF66' : '#FF3333' }}>
                      {connected ? '● ONLINE' : '○ OFFLINE'}
                    </span>
                    <button onClick={() => { setIsOpen(false); setSelectedConversation(null); }} className="p-1 hover:bg-gray-800 rounded">
                      <X size={20} style={{ color: '#FF6600' }} />
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden" style={{ background: '#050505', minHeight: 0 }}>
              {!connected ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <WifiOff size={32} style={{ color: '#FF3333' }} />
                  <p style={{ fontFamily: 'VT323, monospace', fontSize: '18px', color: '#FF3333' }}>DISCONNECTED</p>
                  <button onClick={checkConnection} className="flex items-center gap-2 px-4 py-2 rounded" style={{ background: '#1a1a1a', border: '1px solid #FF3333' }}>
                    <RefreshCw size={14} style={{ color: '#FF3333' }} />
                    <span style={{ fontFamily: 'VT323, monospace', color: '#FF3333' }}>RETRY</span>
                  </button>
                </div>
              ) : selectedConversation && selectedConv ? (
                // Chat view - video game style - proper scroll container
                <div className="flex flex-col h-full">
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {selectedConv.messages.slice(-30).map((msg) => (
                      <div key={msg.id} className={`flex ${msg.type === 'sent' ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className="max-w-[85%] px-3 py-2"
                          style={{
                            background: msg.type === 'sent' ? '#FF6600' : '#1a1a1a',
                            border: msg.type === 'sent' ? '2px solid #FF8800' : '2px solid #333',
                            borderRadius: '4px',
                            boxShadow: msg.type === 'sent' ? '0 0 10px rgba(255,102,0,0.3)' : 'none',
                          }}
                        >
                          <p style={{ fontFamily: 'VT323, monospace', fontSize: '17px', color: msg.type === 'sent' ? '#000' : '#fff', lineHeight: '1.3' }}>
                            {msg.body}
                          </p>
                          <p style={{ fontFamily: 'VT323, monospace', fontSize: '12px', color: msg.type === 'sent' ? '#333' : '#666', marginTop: '2px' }}>
                            {formatTime(msg.date)}
                          </p>
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                </div>
              ) : (
                // Conversation list
                <div>
                  {visibleConversations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-2">
                      <MessageCircle size={28} style={{ color: '#333' }} />
                      <p style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: '#444' }}>NO MESSAGES</p>
                    </div>
                  ) : (
                    visibleConversations.slice(0, 25).map((conv) => (
                      <div
                        key={conv.address}
                        className="flex items-center gap-1 px-2 py-2 hover:bg-gray-900/50 transition-colors"
                        style={{ borderBottom: '1px solid #1a1a1a' }}
                      >
                        {/* Pin */}
                        <button onClick={() => togglePin(conv.address)} className="p-1 rounded" style={{ opacity: conv.isPinned ? 1 : 0.3 }}>
                          <Pin size={14} style={{ color: conv.isPinned ? '#FF6600' : '#555' }} />
                        </button>

                        {/* Main */}
                        <button onClick={() => setSelectedConversation(conv.address)} className="flex-1 flex items-center gap-2 text-left min-w-0">
                          <div
                            className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded"
                            style={{ background: conv.isPinned ? '#FF660030' : '#1a1a1a', border: conv.isPinned ? '1px solid #FF6600' : '1px solid #333' }}
                          >
                            <span style={{ fontFamily: 'VT323, monospace', fontSize: '14px', color: conv.isPinned ? '#FF6600' : '#888' }}>
                              {conv.contactName.slice(0, 2).toUpperCase()}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-1">
                              <span style={{ fontFamily: 'VT323, monospace', fontSize: '16px', color: conv.isPinned ? '#FF6600' : '#fff' }} className="truncate">
                                {conv.contactName}
                              </span>
                              <span style={{ fontFamily: 'VT323, monospace', fontSize: '12px', color: '#555' }}>
                                {formatTime(conv.lastMessage.date)}
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              <p style={{ fontFamily: 'VT323, monospace', fontSize: '13px', color: '#666' }} className="truncate flex-1">
                                {conv.lastMessage.type === 'sent' && <span style={{ color: '#555' }}>{'>'} </span>}
                                {conv.lastMessage.body}
                              </p>
                              {conv.unreadCount > 0 && (
                                <span
                                  className="w-5 h-5 flex items-center justify-center rounded"
                                  style={{ background: '#FF6600', color: '#000', fontFamily: 'VT323, monospace', fontSize: '12px', fontWeight: 'bold' }}
                                >
                                  {conv.unreadCount}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>

                        {/* Hide */}
                        <button onClick={() => toggleHide(conv.address)} className="p-1 rounded opacity-30 hover:opacity-100">
                          <EyeOff size={14} style={{ color: '#555' }} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Input */}
            {selectedConversation && connected && (
              <div className="flex items-center gap-2 px-2 py-2" style={{ background: '#0a0a0a', borderTop: '1px solid #333' }}>
                <input
                  ref={inputRef}
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                  placeholder="> ENTER MESSAGE..."
                  className="flex-1 px-3 py-2 rounded focus:outline-none"
                  style={{
                    fontFamily: 'VT323, monospace',
                    fontSize: '17px',
                    background: '#1a1a1a',
                    border: '2px solid #333',
                    color: '#00FF66',
                  }}
                />
                <button
                  onClick={sendMessage}
                  disabled={!newMessage.trim() || sending}
                  className="w-10 h-10 flex items-center justify-center rounded transition-all active:scale-95 disabled:opacity-30"
                  style={{ background: newMessage.trim() ? '#FF6600' : '#1a1a1a', border: '2px solid #FF6600' }}
                >
                  {sending ? <RefreshCw size={18} className="animate-spin" style={{ color: '#000' }} /> : <Send size={18} style={{ color: newMessage.trim() ? '#000' : '#FF6600' }} />}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
