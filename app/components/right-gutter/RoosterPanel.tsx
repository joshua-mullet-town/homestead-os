'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Play, Pause, RefreshCw, PlayCircle, ChevronDown, ChevronUp,
  MapPin, Settings
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────

interface JobLog {
  job_id: string;
  ran_at: string;
  output: string | null;
  error: string | null;
}

interface RecurringJob {
  id: string;
  type: string;
  cron: string;
  config?: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  last_run: string | null;
  run_count: number;
  last_log?: JobLog | null;
}

interface LocationReminder {
  id: string;
  location_name: string;
  reminder_text: string;
  enabled: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const JOB_META: Record<string, { label: string; icon: string }> = {
  'memory-harvester': { label: 'Memory Harvester', icon: '🧠' },
  'memory-consolidator': { label: 'Memory Consolidator', icon: '📦' },
  'ephemeral-cleanup': { label: 'Ephemeral Cleanup', icon: '🧹' },
  'memory-commit': { label: 'Memory Commit', icon: '💾' },
  'steward-commit': { label: 'Steward Commit', icon: '📸' },
  'session-health-check': { label: 'Session Health', icon: '🩺' },
  'steward-resurrect': { label: 'Steward Resurrect', icon: '🔄' },
  'repairman-health-check': { label: 'System Health', icon: '🔧' },
  'location-reminder-check': { label: 'Location Check', icon: '📍' },
  'rooster-calendar-upcoming-check': { label: 'Calendar Upcoming', icon: '📅' },
};

function cronToEnglish(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour] = parts;

  if (minute === '*' && hour === '*') return 'Every min';
  const everyN = minute.match(/^\*\/(\d+)$/);
  if (everyN && hour === '*') {
    const n = parseInt(everyN[1]);
    return n === 1 ? 'Every min' : `Every ${n}m`;
  }
  const everyH = hour.match(/^\*\/(\d+)$/);
  if (everyH && /^\d+$/.test(minute)) {
    const n = parseInt(everyH[1]);
    return n === 1 ? 'Hourly' : `Every ${n}h`;
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const h = parseInt(hour);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Daily ${h12}${ampm}`;
  }
  return cron;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return 'now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function getNextCronTime(cron: string): Date | null {
  const parts = cron.split(' ');
  if (parts.length !== 5) return null;
  const [minutes, hours] = parts;
  const now = new Date();

  let minuteList: number[] = [];
  if (minutes === '*') minuteList = Array.from({ length: 60 }, (_, i) => i);
  else if (minutes.includes('/')) {
    const step = parseInt(minutes.split('/')[1]);
    minuteList = Array.from({ length: Math.floor(60 / step) }, (_, i) => i * step);
  } else minuteList = [parseInt(minutes)];

  let hourList: number[] = [];
  if (hours === '*') hourList = Array.from({ length: 24 }, (_, i) => i);
  else if (hours.includes('/')) {
    const step = parseInt(hours.split('/')[1]);
    hourList = Array.from({ length: Math.floor(24 / step) }, (_, i) => i * step);
  } else hourList = [parseInt(hours)];

  for (const hour of hourList) {
    for (const minute of minuteList) {
      const next = new Date(now);
      next.setSeconds(0); next.setMilliseconds(0);
      next.setHours(hour); next.setMinutes(minute);
      if (next > now) return next;
    }
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(hourList[0]); tomorrow.setMinutes(minuteList[0]);
  tomorrow.setSeconds(0);
  return tomorrow;
}

function timeUntil(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ─── Component ───────────────────────────────────────────────────────

interface RoosterPanelProps {
  onOpenSettings: () => void;
  color: string;
}

export default function RoosterPanel({ onOpenSettings, color }: RoosterPanelProps) {
  const [jobs, setJobs] = useState<RecurringJob[]>([]);
  const [reminders, setReminders] = useState<LocationReminder[]>([]);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [jobsRes, remindersRes] = await Promise.all([
        fetch('/api/jobs'),
        fetch('/api/location-reminders').catch(() => null),
      ]);
      if (jobsRes.ok) {
        const data = await jobsRes.json();
        setJobs(data.jobs || []);
      }
      if (remindersRes?.ok) {
        const data = await remindersRes.json();
        setReminders(data.reminders || []);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Tick for countdown updates
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  async function toggleJob(job: RecurringJob) {
    await fetch(`/api/jobs?id=${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !job.enabled }),
    });
    fetchData();
  }

  async function runNow(job: RecurringJob) {
    setRunningJob(job.id);
    await fetch(`/api/jobs?id=${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runNow: true }),
    });
    setTimeout(() => { fetchData(); setRunningJob(null); }, 2000);
  }

  const activeJobs = jobs.filter(j => j.enabled).sort((a, b) => {
    const aNext = getNextCronTime(a.cron);
    const bNext = getNextCronTime(b.cron);
    if (!aNext) return 1;
    if (!bNext) return -1;
    return aNext.getTime() - bNext.getTime();
  });
  const pausedJobs = jobs.filter(j => !j.enabled);
  const activeReminders = reminders.filter(r => r.enabled);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="w-5 h-5 animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🐓</span>
          <span style={{ fontFamily: 'VT323, monospace', color }} className="text-lg">SCHEDULE</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={fetchData}
            className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onOpenSettings}
            className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-colors"
            title="Steward Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Active Jobs */}
      <div>
        <div className="text-xs text-gray-600 mb-1.5 px-0.5" style={{ fontFamily: 'VT323, monospace' }}>
          ACTIVE ({activeJobs.length})
        </div>
        <div className="space-y-1">
          {activeJobs.map(job => {
            const meta = JOB_META[job.id] || { label: job.id, icon: '⚙️' };
            const isExpanded = expandedJob === job.id;
            const nextRun = getNextCronTime(job.cron);
            const hasError = job.last_log?.error;

            return (
              <div key={job.id} className="rounded-lg bg-gray-900/80 border border-gray-800/50">
                <button
                  onClick={() => setExpandedJob(isExpanded ? null : job.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-2 text-left"
                >
                  <span className="text-sm flex-shrink-0">{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-white truncate">{meta.label}</span>
                      {hasError && <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color, fontFamily: 'VT323, monospace' }}>
                      {cronToEnglish(job.cron)}
                      {job.last_run && (
                        <span className="text-gray-600 ml-1">· {timeAgo(job.last_run)} ago</span>
                      )}
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    {nextRun && (
                      <div className="text-[11px] font-mono text-[#FFCC00]">{timeUntil(nextRun)}</div>
                    )}
                  </div>
                  <ChevronDown className={`w-3 h-3 text-gray-600 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                </button>

                {isExpanded && (
                  <div className="px-2.5 pb-2 border-t border-gray-800/50">
                    <div className="text-[10px] text-gray-500 mt-1.5 mb-2">
                      {job.run_count.toLocaleString()} runs · cron: {job.cron}
                    </div>
                    {job.last_log && (
                      <div className="text-[10px] font-mono bg-black/40 rounded p-1.5 mb-2 max-h-16 overflow-auto whitespace-pre-wrap" style={{ color: hasError ? '#ef4444' : '#666' }}>
                        {(hasError ? job.last_log.error : job.last_log.output?.split('\n').slice(-2).join('\n')) || 'No output'}
                      </div>
                    )}
                    <div className="flex gap-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); runNow(job); }}
                        disabled={runningJob === job.id}
                        className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 disabled:opacity-40"
                      >
                        {runningJob === job.id ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <PlayCircle className="w-2.5 h-2.5" />}
                        Run
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleJob(job); }}
                        className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20"
                      >
                        <Pause className="w-2.5 h-2.5" /> Pause
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Location Reminders */}
      {activeReminders.length > 0 && (
        <div>
          <div className="text-xs text-gray-600 mb-1.5 px-0.5 flex items-center gap-1" style={{ fontFamily: 'VT323, monospace' }}>
            <MapPin className="w-3 h-3" />
            REMINDERS ({activeReminders.length})
          </div>
          <div className="space-y-1">
            {activeReminders.map(r => (
              <div key={r.id} className="rounded-lg bg-gray-900/80 border border-gray-800/50 px-2.5 py-2 flex items-center gap-2">
                <span className="text-sm">📍</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-white truncate">{r.reminder_text}</div>
                  <div className="text-[10px]" style={{ color, fontFamily: 'VT323, monospace' }}>
                    At {r.location_name}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Paused Jobs */}
      {pausedJobs.length > 0 && (
        <div>
          <div className="text-xs text-gray-600 mb-1.5 px-0.5" style={{ fontFamily: 'VT323, monospace' }}>
            PAUSED ({pausedJobs.length})
          </div>
          <div className="space-y-1">
            {pausedJobs.map(job => {
              const meta = JOB_META[job.id] || { label: job.id, icon: '⚙️' };
              return (
                <div key={job.id} className="rounded-lg bg-gray-900/30 border border-gray-800/30 px-2.5 py-2 flex items-center gap-2 opacity-50">
                  <span className="text-sm">{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-gray-400 truncate">{meta.label}</span>
                  </div>
                  <button
                    onClick={() => toggleJob(job)}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-green-500/10 text-green-400 hover:bg-green-500/20"
                  >
                    <Play className="w-2.5 h-2.5" /> Resume
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
