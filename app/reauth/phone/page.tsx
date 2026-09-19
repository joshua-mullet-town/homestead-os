'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Smartphone, RefreshCw, CheckCircle, XCircle, ArrowLeft } from 'lucide-react';

const PHONE_API = 'http://100.84.84.102:8888';

type Status = 'idle' | 'checking' | 'connected' | 'disconnected';

export default function PhoneReconnectPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('idle');
  const [phoneIp, setPhoneIp] = useState<string | null>(null);

  const checkConnection = async () => {
    setStatus('checking');
    try {
      const res = await fetch(`${PHONE_API}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const data = await res.json();
        setStatus('connected');
        // Try to get the IP from device endpoint
        try {
          const deviceRes = await fetch(`${PHONE_API}/device`);
          if (deviceRes.ok) {
            const deviceData = await deviceRes.json();
            setPhoneIp(deviceData.data?.ip || null);
          }
        } catch {}
      } else {
        setStatus('disconnected');
      }
    } catch {
      setStatus('disconnected');
    }
  };

  useEffect(() => {
    checkConnection();
  }, []);

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={() => router.push('/')}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg"
          >
            <ArrowLeft size={20} />
          </button>
          <h1 style={{ fontFamily: 'VT323, monospace' }} className="text-2xl text-[#FFCC00]">
            PHONE API STATUS
          </h1>
        </div>

        {/* Status Card */}
        <div className="bg-gray-900 border-2 border-gray-800 rounded-lg p-6 mb-6">
          <div className="flex items-center gap-4 mb-6">
            <div className={`p-4 rounded-full ${
              status === 'connected' ? 'bg-green-900/50' :
              status === 'disconnected' ? 'bg-red-900/50' :
              status === 'checking' ? 'bg-blue-900/50' :
              'bg-gray-800'
            }`}>
              {status === 'connected' ? (
                <CheckCircle size={32} className="text-green-500" />
              ) : status === 'disconnected' ? (
                <XCircle size={32} className="text-red-500" />
              ) : status === 'checking' ? (
                <RefreshCw size={32} className="text-blue-500 animate-spin" />
              ) : (
                <Smartphone size={32} className="text-[#FF6600]" />
              )}
            </div>
            <div>
              <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-white">
                {status === 'connected' ? 'Phone API Online' :
                 status === 'disconnected' ? 'Phone API Offline' :
                 status === 'checking' ? 'Checking...' :
                 'Phone API Status'}
              </h2>
              <p className="text-gray-400 text-sm mt-1">
                {status === 'connected' ? (
                  <>Homestead app running at {phoneIp || PHONE_API.replace('http://', '')}</>
                ) : status === 'checking' ? (
                  'Connecting to phone API...'
                ) : (
                  'Cannot reach Homestead app on phone'
                )}
              </p>
            </div>
          </div>

          {status === 'connected' ? (
            <button
              onClick={() => router.push('/')}
              className="w-full py-3 px-4 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg transition-colors"
              style={{ fontFamily: 'VT323, monospace' }}
            >
              BACK TO HOME
            </button>
          ) : (
            <button
              onClick={checkConnection}
              disabled={status === 'checking'}
              className="w-full py-3 px-4 bg-[#FF6600] hover:bg-[#FF8833] text-black font-bold rounded-lg transition-colors disabled:opacity-50"
              style={{ fontFamily: 'VT323, monospace' }}
            >
              {status === 'checking' ? 'CHECKING...' : 'RETRY CONNECTION'}
            </button>
          )}
        </div>

        {/* Reconnect Instructions */}
        {status !== 'connected' && (
          <div className="bg-gray-900 border-2 border-gray-800 rounded-lg p-6 space-y-6">
            <h3 style={{ fontFamily: 'VT323, monospace' }} className="text-lg text-[#FFCC00]">
              TROUBLESHOOTING
            </h3>

            {/* Step 1 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-[#FF6600] text-black flex items-center justify-center text-sm font-bold">1</span>
                <span className="text-white font-medium">Open Homestead App</span>
              </div>
              <p className="text-gray-400 text-sm ml-8">
                Make sure the Homestead app is open on your Android phone.
                The API server runs as a foreground service when the app is active.
              </p>
            </div>

            {/* Step 2 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-[#FF6600] text-black flex items-center justify-center text-sm font-bold">2</span>
                <span className="text-white font-medium">Check Server Status</span>
              </div>
              <p className="text-gray-400 text-sm ml-8">
                In the Homestead app, you should see a notification saying
                <span className="text-[#00CCFF]"> "API Server running on [IP]:8888"</span>.
                If not, tap "Start Server" in the app.
              </p>
            </div>

            {/* Step 3 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-[#FF6600] text-black flex items-center justify-center text-sm font-bold">3</span>
                <span className="text-white font-medium">Verify Network</span>
              </div>
              <p className="text-gray-400 text-sm ml-8">
                Your phone and Mac must be on the same network or both connected
                to Tailscale. The current expected IP is:
                <br />
                <code className="text-[#00FF66] bg-black px-2 py-1 rounded mt-1 inline-block">
                  {PHONE_API}
                </code>
              </p>
            </div>

            {/* Step 4 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-[#FF6600] text-black flex items-center justify-center text-sm font-bold">4</span>
                <span className="text-white font-medium">IP Changed?</span>
              </div>
              <p className="text-gray-400 text-sm ml-8">
                If your phone's IP changed, you'll need to update the PHONE_API
                constant in the codebase. Check the Homestead app notification
                for the current IP address.
              </p>
            </div>

            {/* Tips */}
            <div className="border-t border-gray-800 pt-4">
              <p className="text-gray-500 text-xs">
                <strong className="text-gray-400">Tips:</strong><br />
                • The Homestead app provides SMS, notifications, contacts, and screen control<br />
                • Server persists while app is in foreground or recent apps<br />
                • Force-stopping the app will stop the server
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
