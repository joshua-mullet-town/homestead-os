'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Wifi, WifiOff, AlertTriangle, Server,
  Play, Pause, PlayCircle, Trash2, Bell, Cpu, Skull, X, Bot, Zap,
  Activity, Users
} from 'lucide-react';

// Types
interface RecurringJob {
  id: string;
  type: string;
  cron: string;
  config?: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  last_run: string | null;
  run_count: number;
}

interface ChannelHealth {
  id: string;
  name: string;
  type: string;
  status: 'connected' | 'auth_expired' | 'disconnected' | 'error' | 'timeout' | 'unknown';
  last_checked: string | null;
  last_success: string | null;
  error: string | null;
}

interface ChannelHealthData {
  channels: ChannelHealth[];
  summary: { connected: number; total: number; all_healthy: boolean };
  last_full_check: string | null;
}

interface ClaudeProcessDetail {
  pid: number;
  memMb: number;
  cwd: string;
  project: string;
  startTime: string;
  sessionLastActivity: string | null;
  ageMinutes: number | null;
}

interface McpStatus {
  claude: { count: number; memMb: number; details: ClaudeProcessDetail[] };
  mcp: { count: number; memMb: number };
  orphans: { count: number; memMb: number };
  totalMb: number;
}

interface HarvesterStatus {
  lastSuccessfulRun: string | null;
  timeSince: string | null;
  status: 'healthy' | 'warning' | 'stale' | 'never_run' | 'error' | 'unknown';
  lookbackMinutes?: number | null;
  lookbackUncappedMinutes?: number | null;
  lookbackCeilingHit?: boolean;
  maxLookbackMinutes?: number | null;
}

// Helpers
function formatGb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function severityColor(totalMb: number): string {
  if (totalMb >= 4096) return '#FF3333';
  if (totalMb >= 2048) return '#FFCC00';
  return '#00FF66';
}

function getNextCronTime(cron: string): Date | null {
  const parts = cron.split(' ');
  if (parts.length !== 5) return null;

  const [minutes, hours] = parts;
  const now = new Date();

  let minuteList: number[] = [];
  if (minutes === '*') {
    minuteList = Array.from({ length: 60 }, (_, i) => i);
  } else if (minutes.includes(',')) {
    minuteList = minutes.split(',').map(m => parseInt(m));
  } else if (minutes.includes('/')) {
    const step = parseInt(minutes.split('/')[1]);
    minuteList = Array.from({ length: Math.floor(60 / step) }, (_, i) => i * step);
  } else {
    minuteList = [parseInt(minutes)];
  }

  let hourList: number[] = [];
  if (hours === '*') {
    hourList = Array.from({ length: 24 }, (_, i) => i);
  } else if (hours.includes(',')) {
    hourList = hours.split(',').map(h => parseInt(h));
  } else if (hours.includes('/')) {
    const step = parseInt(hours.split('/')[1]);
    hourList = Array.from({ length: Math.floor(24 / step) }, (_, i) => i * step);
  } else {
    hourList = [parseInt(hours)];
  }

  for (const hour of hourList) {
    for (const minute of minuteList) {
      const next = new Date(now);
      next.setSeconds(0);
      next.setMilliseconds(0);
      next.setHours(hour);
      next.setMinutes(minute);
      if (next > now) return next;
    }
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(hourList[0]);
  tomorrow.setMinutes(minuteList[0]);
  tomorrow.setSeconds(0);
  tomorrow.setMilliseconds(0);
  return tomorrow;
}

function formatCron(cron: string): string {
  if (cron === '0,15,30,45 * * * *') return 'Every 15 min';
  if (cron === '*/5 * * * *') return 'Every 5 min';
  if (cron === '*/30 * * * *') return 'Every 30 min';
  if (cron === '0 * * * *') return 'Hourly';
  if (cron === '0 0 * * *') return 'Daily midnight';
  if (cron === '0 6 * * *') return 'Daily 6am';
  if (cron === '0 */6 * * *') return 'Every 6 hours';
  if (cron === '*/10 * * * *') return 'Every 10 min';
  return cron;
}

function formatTimeUntil(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'Now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (hours < 24) return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function timeAgo(isoString: string | null): string {
  if (!isoString) return 'unknown';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getAgeColor(ageMinutes: number | null): string {
  if (ageMinutes === null) return '#6B7280';
  if (ageMinutes < 5) return '#00FF66';
  if (ageMinutes < 30) return '#88CC44';
  if (ageMinutes < 60) return '#FFCC00';
  if (ageMinutes < 120) return '#FF9900';
  return '#FF3333';
}

export default function StatusPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // MCP Status
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [killingOrphans, setKillingOrphans] = useState(false);
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [killResult, setKillResult] = useState<string | null>(null);

  // Channel Health
  const [channelHealth, setChannelHealth] = useState<ChannelHealthData | null>(null);
  const [harvesterStatus, setHarvesterStatus] = useState<HarvesterStatus | null>(null);

  // Jobs
  const [jobs, setJobs] = useState<RecurringJob[]>([]);
  const [runningJob, setRunningJob] = useState<string | null>(null);

  // Push
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [pushTesting, setPushTesting] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);

  // Server
  const [serverRestarting, setServerRestarting] = useState(false);

  // Ephemeral Worker
  const [workerPrompt, setWorkerPrompt] = useState('');
  const [spawningWorker, setSpawningWorker] = useState(false);
  const [workerResult, setWorkerResult] = useState<{ success: boolean; sessionName?: string; error?: string } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [mcpRes, healthRes, jobsRes, harvesterRes] = await Promise.all([
        fetch('/api/mcp-status'),
        fetch('/api/channels/health'),
        fetch('/api/jobs'),
        fetch('/api/harvester-status'),
      ]);

      if (mcpRes.ok) setMcpStatus(await mcpRes.json());
      if (healthRes.ok) setChannelHealth(await healthRes.json());
      if (jobsRes.ok) {
        const data = await jobsRes.json();
        setJobs(data.jobs || []);
      }
      if (harvesterRes.ok) setHarvesterStatus(await harvesterRes.json());
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  const manualRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  useEffect(() => {
    fetchData();
    checkSubscription();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  async function checkSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      await navigator.serviceWorker.register('/sw.js');
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setIsSubscribed(!!subscription);
    } catch {}
  }

  // MCP Actions
  const killOrphans = async () => {
    setKillingOrphans(true);
    setKillResult(null);
    try {
      const res = await fetch('/api/mcp-status', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        setKillResult(`Killed ${data.killed} orphans`);
        setMcpStatus({
          claude: data.claude,
          mcp: data.mcp,
          orphans: data.orphans,
          totalMb: data.totalMb,
        });
      }
    } catch {}
    setKillingOrphans(false);
  };

  const killClaudeProcess = async (pid: number, project: string) => {
    setKillingPid(pid);
    try {
      const res = await fetch(`/api/mcp-status?pid=${pid}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        setKillResult(`Killed ${project}`);
        setMcpStatus({
          claude: data.claude,
          mcp: data.mcp,
          orphans: data.orphans,
          totalMb: data.totalMb,
        });
      }
    } catch {}
    setKillingPid(null);
  };

  // Job Actions
  const toggleJobEnabled = async (job: RecurringJob) => {
    try {
      const res = await fetch(`/api/jobs?id=${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !job.enabled })
      });
      if (res.ok) fetchData();
    } catch {}
  };

  const runJobNow = async (job: RecurringJob) => {
    setRunningJob(job.id);
    try {
      await fetch(`/api/jobs?id=${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runNow: true })
      });
      setTimeout(fetchData, 2000);
    } catch {}
    setRunningJob(null);
  };

  // Push Test
  const sendTestPush = async () => {
    setPushTesting(true);
    setPushResult(null);
    try {
      const res = await fetch('/api/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test Push',
          body: `Test from Status page at ${new Date().toLocaleTimeString()}`
        })
      });
      if (res.ok) {
        setPushResult('Sent!');
      } else {
        setPushResult('Failed');
      }
    } catch {
      setPushResult('Error');
    }
    setPushTesting(false);
  };

  // Server Restart
  const handleRestartServer = async () => {
    setServerRestarting(true);
    try {
      await fetch('/api/rebuild', { method: 'POST' });
    } catch {}
    setTimeout(() => {
      window.location.reload();
    }, 3000);
  };

  // Spawn Ephemeral Worker
  const spawnWorker = async () => {
    if (!workerPrompt.trim()) return;
    setSpawningWorker(true);
    setWorkerResult(null);
    try {
      const res = await fetch('/api/spawn-worker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workerPrompt.trim() })
      });
      const data = await res.json();
      setWorkerResult(data);
      if (data.success) {
        setWorkerPrompt('');
      }
    } catch (err) {
      setWorkerResult({ success: false, error: 'Network error' });
    }
    setSpawningWorker(false);
  };

  const sortedJobs = [...jobs].sort((a, b) => {
    const aNext = getNextCronTime(a.cron);
    const bNext = getNextCronTime(b.cron);
    if (!aNext) return 1;
    if (!bNext) return -1;
    return aNext.getTime() - bNext.getTime();
  });

  const memColor = mcpStatus ? severityColor(mcpStatus.totalMb) : '#666';
  const hasOrphans = mcpStatus && mcpStatus.orphans.count > 0;

  return (
    <div className="min-h-screen bg-black text-white p-4 pb-24">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => { window.location.href = '/presenter/index.html'; }}
              className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 style={{ fontFamily: 'VT323, monospace' }} className="text-3xl text-[#FFCC00]">
              STATUS
            </h1>
          </div>
          <button
            onClick={manualRefresh}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg"
          >
            <RefreshCw className={`w-5 h-5 ${refreshing || loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Section A: System Resources (MCP) */}
        <div className="bg-gray-900 border-2 rounded-lg p-4 mb-4" style={{ borderColor: memColor }}>
          <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FF6600] mb-3 flex items-center gap-2">
            <Cpu className="w-5 h-5" />
            SYSTEM RESOURCES
          </h2>

          {!mcpStatus ? (
            <p className="text-gray-500 text-center py-4">Loading...</p>
          ) : (
            <>
              {/* Summary row */}
              <div className="grid grid-cols-4 gap-2 mb-3">
                <div className="bg-gray-800 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold" style={{ color: memColor }}>{mcpStatus.claude.count}</div>
                  <div className="text-xs text-gray-500">Claude</div>
                </div>
                <div className="bg-gray-800 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold text-[#00FF66]">{mcpStatus.mcp.count}</div>
                  <div className="text-xs text-gray-500">MCP</div>
                </div>
                <div className="bg-gray-800 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold" style={{ color: hasOrphans ? '#FF3333' : '#00FF66' }}>{mcpStatus.orphans.count}</div>
                  <div className="text-xs text-gray-500">Orphans</div>
                </div>
                <div className="bg-gray-800 rounded-lg p-2 text-center">
                  <div className="text-lg font-bold" style={{ color: memColor }}>{formatGb(mcpStatus.totalMb)}</div>
                  <div className="text-xs text-gray-500">Total</div>
                </div>
              </div>

              {/* Claude process list */}
              {mcpStatus.claude.details && mcpStatus.claude.details.length > 0 && (
                <div className="space-y-2 mb-3">
                  {mcpStatus.claude.details.map((proc) => {
                    const ageColor = getAgeColor(proc.ageMinutes);
                    return (
                      <div key={proc.pid} className="bg-gray-800 rounded-lg p-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: ageColor }} />
                          <span style={{ color: ageColor }} className="font-medium text-sm">{proc.project}</span>
                          <span className="text-xs text-gray-500">{proc.memMb} MB</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">{timeAgo(proc.sessionLastActivity)}</span>
                          <button
                            onClick={() => killClaudeProcess(proc.pid, proc.project)}
                            disabled={killingPid === proc.pid}
                            className="p-1 text-gray-500 hover:text-[#FF3333] transition-colors disabled:opacity-50"
                          >
                            <Trash2 size={14} className={killingPid === proc.pid ? 'animate-pulse' : ''} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Kill orphans button */}
              {hasOrphans && (
                <button
                  onClick={killOrphans}
                  disabled={killingOrphans}
                  className="w-full py-2 bg-[#FF3333] hover:bg-red-400 text-black font-bold rounded transition-colors disabled:opacity-50"
                  style={{ fontFamily: 'VT323, monospace' }}
                >
                  {killingOrphans ? 'KILLING...' : `KILL ${mcpStatus.orphans.count} ORPHANS`}
                </button>
              )}

              {killResult && (
                <div className="mt-2 text-center text-sm text-[#00FF66]">{killResult}</div>
              )}
            </>
          )}
        </div>

        {/* Section B: Channel Health */}
        <div className="bg-gray-900 border-2 border-gray-800 rounded-lg p-4 mb-4">
          <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FF6600] mb-3 flex items-center gap-2">
            <Wifi className="w-5 h-5" />
            CHANNELS ({channelHealth?.summary.connected ?? '?'}/{channelHealth?.summary.total ?? '?'})
            {harvesterStatus && (
              <span className="ml-auto flex items-center gap-1">
                <span
                  className={`text-xs px-2 py-0.5 rounded ${
                    harvesterStatus.status === 'healthy' ? 'bg-green-900 text-green-400' :
                    harvesterStatus.status === 'warning' ? 'bg-yellow-900 text-yellow-400' :
                    'bg-red-900 text-red-400'
                  }`}
                >
                  Harvest: {harvesterStatus.timeSince || 'never'}
                </span>
                {typeof harvesterStatus.lookbackMinutes === 'number' && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      harvesterStatus.lookbackCeilingHit
                        ? 'bg-red-900 text-red-400'
                        : 'bg-gray-800 text-gray-400'
                    }`}
                    title={
                      harvesterStatus.lookbackCeilingHit
                        ? `Wanted ${harvesterStatus.lookbackUncappedMinutes}m lookback; capped at ${harvesterStatus.maxLookbackMinutes}m — real backlog suspected`
                        : `Last scan looked back ${harvesterStatus.lookbackMinutes}m`
                    }
                  >
                    Backlog: {harvesterStatus.lookbackMinutes}m
                    {harvesterStatus.lookbackCeilingHit && ` (wanted ${harvesterStatus.lookbackUncappedMinutes}m)`}
                  </span>
                )}
              </span>
            )}
          </h2>

          {!channelHealth ? (
            <p className="text-gray-500 text-center py-4">Loading...</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {channelHealth.channels.map(channel => {
                const isConnected = channel.status === 'connected';
                const isWarning = channel.status === 'auth_expired';

                return (
                  <div
                    key={channel.id}
                    className={`bg-gray-800 rounded-lg p-2 flex items-center gap-2 ${!isConnected ? 'opacity-75' : ''}`}
                  >
                    {isConnected ? (
                      <Wifi className="w-4 h-4 text-green-500 flex-shrink-0" />
                    ) : isWarning ? (
                      <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                    ) : (
                      <WifiOff className="w-4 h-4 text-red-500 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium truncate ${
                        isConnected ? 'text-white' : isWarning ? 'text-yellow-400' : 'text-red-400'
                      }`}>
                        {channel.name.replace('Slack (', '').replace(')', '')}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Section C: Scheduled Jobs */}
        <div className="bg-gray-900 border-2 border-gray-800 rounded-lg p-4 mb-4">
          <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FF6600] mb-3 flex items-center gap-2">
            <RefreshCw className="w-5 h-5" />
            JOBS ({jobs.length})
          </h2>

          {jobs.length === 0 ? (
            <p className="text-gray-500 text-center py-4">No jobs configured</p>
          ) : (
            <div className="space-y-2">
              {sortedJobs.map(job => {
                const nextRun = getNextCronTime(job.cron);
                const isRunning = runningJob === job.id;

                return (
                  <div key={job.id} className={`bg-gray-800 rounded-lg p-2 ${!job.enabled ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${job.enabled ? 'bg-green-500' : 'bg-gray-500'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-white text-sm font-medium truncate">{job.id}</div>
                        <div className="text-gray-500 text-xs">{formatCron(job.cron)}</div>
                      </div>
                      <div className="text-[#FFCC00] text-sm font-mono">
                        {job.enabled && nextRun ? formatTimeUntil(nextRun) : '--'}
                      </div>
                      <button
                        onClick={() => runJobNow(job)}
                        disabled={isRunning || !job.enabled}
                        className="p-1.5 text-blue-400 hover:bg-gray-700 rounded disabled:opacity-50"
                      >
                        {isRunning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => toggleJobEnabled(job)}
                        className={`p-1.5 rounded hover:bg-gray-700 ${job.enabled ? 'text-yellow-500' : 'text-gray-500'}`}
                      >
                        {job.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Section D: Push Quick Test */}
        <div className="bg-gray-900 border-2 border-gray-800 rounded-lg p-4 mb-4">
          <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FF6600] mb-3 flex items-center gap-2">
            <Bell className="w-5 h-5" />
            PUSH NOTIFICATIONS
          </h2>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <span className={isSubscribed ? 'text-green-500' : 'text-red-500'}>●</span>
              <span className="text-gray-400">{isSubscribed ? 'Subscribed' : 'Not subscribed'}</span>
            </div>
            <button
              onClick={sendTestPush}
              disabled={pushTesting || !isSubscribed}
              className="px-4 py-2 bg-[#FF6600] hover:bg-orange-500 text-black font-bold rounded transition-colors disabled:opacity-50"
              style={{ fontFamily: 'VT323, monospace' }}
            >
              {pushTesting ? 'SENDING...' : 'TEST PUSH'}
            </button>
          </div>

          {pushResult && (
            <div className={`mt-2 text-center text-sm ${pushResult === 'Sent!' ? 'text-[#00FF66]' : 'text-[#FF3333]'}`}>
              {pushResult}
            </div>
          )}
        </div>

        {/* Section E: Ephemeral Worker */}
        <div className="bg-gray-900 border-2 border-gray-800 rounded-lg p-4 mb-4">
          <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FF6600] mb-3 flex items-center gap-2">
            <Bot className="w-5 h-5" />
            SPAWN WORKER
          </h2>
          <p className="text-gray-500 text-xs mb-3">
            Spawn an ephemeral Claude worker to fix/modify Homestead
          </p>

          <textarea
            value={workerPrompt}
            onChange={(e) => setWorkerPrompt(e.target.value)}
            placeholder="What should the worker do? e.g. 'Fix the mobile header layout'"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg p-3 text-white text-sm placeholder-gray-500 resize-none mb-3"
            rows={3}
          />

          <button
            onClick={spawnWorker}
            disabled={spawningWorker || !workerPrompt.trim()}
            className="w-full py-3 bg-[#00FF66] hover:bg-green-400 text-black font-bold rounded transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ fontFamily: 'VT323, monospace' }}
          >
            <Zap className={`w-5 h-5 ${spawningWorker ? 'animate-pulse' : ''}`} />
            {spawningWorker ? 'SPAWNING...' : 'SPAWN WORKER'}
          </button>

          {workerResult && (
            <div className={`mt-3 p-2 rounded text-center text-sm ${
              workerResult.success ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'
            }`}>
              {workerResult.success
                ? `Worker spawned: ${workerResult.sessionName}`
                : `Error: ${workerResult.error}`
              }
            </div>
          )}
        </div>

        {/* Section F: Server Management */}
        <div className="bg-gray-900 border-2 border-gray-800 rounded-lg p-4">
          <h2 style={{ fontFamily: 'VT323, monospace' }} className="text-xl text-[#FF6600] mb-3 flex items-center gap-2">
            <Server className="w-5 h-5" />
            SERVER
          </h2>

          <button
            onClick={handleRestartServer}
            disabled={serverRestarting}
            className="w-full py-3 bg-gray-800 hover:bg-gray-700 text-white font-bold rounded transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ fontFamily: 'VT323, monospace' }}
          >
            <Server className={`w-5 h-5 ${serverRestarting ? 'animate-spin' : ''}`} />
            {serverRestarting ? 'RESTARTING...' : 'REBUILD & RESTART'}
          </button>
        </div>
      </div>

      {/* Bottom Nav */}
      <BottomNav currentPage="status" router={router} />
    </div>
  );
}

// Bottom Navigation Component
function BottomNav({ currentPage, router }: { currentPage: string; router: ReturnType<typeof useRouter> }) {
  const tabs = [
    { id: 'status', label: 'Status', icon: Activity, path: '/status' },
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
