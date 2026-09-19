'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { StewIntProps } from './StewIntLoader';

interface JobLog {
  job_id: string;
  ran_at: string;
  output: string | null;
  error: string | null;
}

interface Job {
  id: string;
  type: string;
  cron: string;
  enabled: boolean;
  last_run: string | null;
  run_count: number;
  config?: Record<string, unknown>;
  last_log: JobLog | null;
  consecutive_failures?: number;
  last_success_at?: string | null;
  last_error_text?: string | null;
  failing_since?: string | null;
}

// ─── Nice names + icons + owner ─────────────────────────────────────

const JOB_META: Record<string, { name: string; icon: string; owner: string; desc: string }> = {
  'location-reminder-check': { name: 'Location Reminders', icon: '📍', owner: 'rooster', desc: 'Checks GPS against pending reminders. Skips if none active.' },
  'memory-harvester': { name: 'Memory Harvester', icon: '🧠', owner: 'rooster', desc: 'Reads Claude sessions, Gmail, Slack. Writes daily memories.' },
  'memory-consolidator': { name: 'Memory Consolidator', icon: '📦', owner: 'rooster', desc: 'Promotes durable facts from daily logs to long-term memory.' },
  'memory-commit': { name: 'Memory Commit', icon: '💾', owner: 'rooster', desc: 'Git commits and pushes uncommitted memory files.' },
  'ephemeral-cleanup': { name: 'Ephemeral Cleanup', icon: '🧹', owner: 'global', desc: 'Kills stale ephemeral worker sessions that ran too long.' },
  'steward-commit': { name: 'Steward Commit', icon: '📸', owner: 'global', desc: 'Git snapshot of all steward config and state, pushed to GitHub.' },
  'session-health-check': { name: 'Session Health', icon: '🩺', owner: 'global', desc: 'Detects stale "working" sessions and corrects their status.' },
  'steward-resurrect': { name: 'Steward Resurrect', icon: '🔄', owner: 'global', desc: 'Restarts dead steward tmux sessions.' },
  'system-health-check': { name: 'System Health', icon: '🔧', owner: 'global', desc: 'Checks phone, Gmail auth, Calendar auth, Homestead server. Auto re-auths if expired.' },
  'notification-check': { name: 'Notification Watcher', icon: '🔔', owner: 'global', desc: 'Checks Gmail + phone for new notifications. Routes to Rooster for triage.' },
  'rooster-calendar-upcoming-check': { name: 'Calendar Upcoming Watcher', icon: '📅', owner: 'rooster', desc: 'Every 5 min: reads both Google Calendars (joshua + jory) via on-disk OAuth tokens. Calendar-event watcher → pings Alfred at 2.5hr-out for leave-time cards. Dedupes per event/instance id; skips all-day; still pings no-location events.' },
  'session-stuck-check': { name: 'Session Stuck Check', icon: '🧊', owner: 'global', desc: 'Hashes tmux screens. If unchanged 2+ checks, alerts Rooster to investigate.' },
  // TOMBSTONE (removed 2026-07-07): 'condense-and-clear', 'ask-auto-compact', and
  // 'compact-chain-timeout-check' JOB_META labels removed. They described the DEAD
  // /clear self-condense token-savers (nightly compactor chain + post-handoff-clear.sh).
  // The underlying scheduled jobs were already decommissioned from recurring-jobs.json;
  // these were orphaned display-only labels. Triggers decommissioned + the self-clear
  // script carried a prefix-match hazard. Do NOT rebuild. See TOMBSTONES.md.
  'watchdog-health': { name: 'Watchdog Health', icon: '🩺', owner: 'global', desc: 'Every 2 min: curls localhost:3007. Non-200 = job failure; SPEC 1 tracker walkies Rooster at 2 consecutive, presenter card at 10 or 6h+.' },
  'rooster-vitals-threshold-check': { name: 'Vitals Threshold Check', icon: '🌡️', owner: 'rooster', desc: 'Every 2 min: reads last 10 samples from vitals.log.jsonl. Cards Rooster on sustained-3 crossings of free RAM, load, swapouts, claude or chrome process counts. Sampler (com.homestead.vitals-sampler launchd, 20s) feeds the JSONL.' },
  'rooster-claude-code-release-watch': { name: 'Claude Code Release Watch', icon: '🛡️', owner: 'rooster', desc: 'Every 2 days: compares installed Claude Code to latest npm release. If newer exists, scans anthropics/claude-code GitHub issues for known regressions and walkies Rooster with a release-notes summary + risk assessment. NEVER auto-upgrades — Rooster reviews and cards Joshua. Created after the 2.1.120 incident (#53085, #53041) bricked the entire fleet.' },
  'rooster-sleep-idle-stewards': { name: 'Sleep Idle Stewards', icon: '💤', owner: 'rooster', desc: 'Every 5 min: finds stewards idle ≥15 min (no work, no pending walkies, activity file stale) and kills their claude PID. Sets watchlist enabled=false so session-stuck-checker doesnt revive them. Dispatcher auto-wakes via claude --continue when a real walkie arrives. Saves ~91 MB per sleeping steward. Excludes holler-rooster and holler-rooster--watchdog.' },
  'rooster-watchdog-classifier': { name: 'Watchdog Classifier (shadow)', icon: '🔍', owner: 'rooster', desc: 'Every 1 min: SHADOW pane-classifier alongside Watchdog Worker + bash watchdog. Two-pass binary perception via local Ollama (qwen3:4b) — Call 1 idle/working, Call 2 broken/healthy+tag. Code reconciles. Sharded 5 panes/tick across watchlist enabled-true sessions; alerts go to state/auditor-inbox.jsonl for Auditor false-positive review. NO repair actions yet — pure observation during shadow run. Architecture locked 2026-05-05; full doctrine in domain.pane_classifier.' },
  'rooster-auditor-inbox-consumer': { name: 'Auditor Inbox Consumer', icon: '📬', owner: 'rooster', desc: 'Every 1 min: tails auditor-inbox.jsonl from last byte offset. For each new alert: claim/pane mismatch + claim=true → reset target activity file (auto-repair, no walkie). corrupted + claim=true → reset AND walkie Rooster. corrupted + claim=false → walkie Rooster only. panic/shell/quota-loop or unknown tag → walkie Rooster, no auto-action. Closes the write-only gap left when the Watchdog Worker was decommissioned 2026-05-06. Idempotent via offset file.' },
};

const STEWARD_TABS: Record<string, { label: string; icon: string }> = {
  global: { label: 'Global', icon: '🌐' },
  rooster: { label: 'Rooster', icon: '🐓' },
  venture: { label: 'Venture', icon: '🏢' },
  alfred: { label: 'Alfred', icon: '🎩' },
};

const STEWARD_ORDER = ['global', 'rooster', 'venture', 'alfred'];

// ─── Helpers ─────────────────────────────────────────────────────────

function cronToHuman(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [min, hour] = parts;

  if (min === '*' && hour === '*') return 'Every minute';
  if (min.startsWith('*/') && hour === '*') {
    const n = parseInt(min.slice(2));
    return n === 1 ? 'Every minute' : `Every ${n} min`;
  }
  if (hour.startsWith('*/') && /^\d+$/.test(min)) {
    const n = parseInt(hour.slice(2));
    return n === 1 ? 'Hourly' : `Every ${n}h`;
  }
  if (/^\d+$/.test(hour) && /^\d+$/.test(min)) {
    const h = parseInt(hour);
    const m = parseInt(min);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const mStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
    return `Daily ${h12}${mStr} ${ampm}`;
  }
  return cron;
}

function getNextRunMs(cron: string): number | null {
  const parts = cron.split(' ');
  if (parts.length !== 5) return null;
  const [minutes, hours] = parts;
  const now = new Date();

  let minuteList: number[] = [];
  if (minutes === '*') minuteList = Array.from({ length: 60 }, (_, i) => i);
  else if (minutes.includes('/')) {
    const step = parseInt(minutes.split('/')[1]);
    minuteList = Array.from({ length: Math.floor(60 / step) }, (_, i) => i * step);
  } else if (/^\d+$/.test(minutes)) minuteList = [parseInt(minutes)];
  else return null;

  let hourList: number[] = [];
  if (hours === '*') hourList = Array.from({ length: 24 }, (_, i) => i);
  else if (hours.includes('/')) {
    const step = parseInt(hours.split('/')[1]);
    hourList = Array.from({ length: Math.floor(24 / step) }, (_, i) => i * step);
  } else if (/^\d+$/.test(hours)) hourList = [parseInt(hours)];
  else return null;

  for (const hour of hourList) {
    for (const minute of minuteList) {
      const next = new Date(now);
      next.setSeconds(0); next.setMilliseconds(0);
      next.setHours(hour); next.setMinutes(minute);
      if (next.getTime() > now.getTime()) return next.getTime() - now.getTime();
    }
  }
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(hourList[0]); next.setMinutes(minuteList[0]);
  next.setSeconds(0); next.setMilliseconds(0);
  return next.getTime() - now.getTime();
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  if (hr < 24) return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ─── Monitor Types ───────────────────────────────────────────────────

interface Monitor {
  id: string;
  display_name: string;
  icon: string;
  status: 'up' | 'down' | 'unknown';
  uptime_seconds: number | null;
  last_heartbeat: string | null;
  stale: boolean;
  stats: Record<string, unknown>;
  owner: string;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  if (hr < 24) return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

// ─── Component ───────────────────────────────────────────────────────

export default function SchedulerInt({ stewardId, color }: StewIntProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [globalToggling, setGlobalToggling] = useState(false);
  const [tick, setTick] = useState(0);
  const accentColor = color || '#E8820C';

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs');
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs || []);
        setGlobalEnabled(data.globalEnabled !== false);
      }
    } catch {}
  }, []);

  const fetchMonitors = useCallback(async () => {
    try {
      const res = await fetch('/api/monitors');
      if (res.ok) {
        const data = await res.json();
        setMonitors(data.monitors || []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchJobs();
    fetchMonitors();
    const dataInterval = setInterval(() => { fetchJobs(); fetchMonitors(); }, 15000);
    return () => clearInterval(dataInterval);
  }, [fetchJobs, fetchMonitors]);

  // Tick every second for live countdowns
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Group jobs and monitors by owner
  const { jobsByOwner, monitorsByOwner, availableTabs } = useMemo(() => {
    const jbo: Record<string, Job[]> = {};
    const mbo: Record<string, Monitor[]> = {};

    for (const job of jobs) {
      const meta = JOB_META[job.id];
      const owner = meta?.owner || 'global';
      if (!jbo[owner]) jbo[owner] = [];
      jbo[owner].push(job);
    }

    for (const mon of monitors) {
      const owner = mon.owner || 'global';
      if (!mbo[owner]) mbo[owner] = [];
      mbo[owner].push(mon);
    }

    const tabs = STEWARD_ORDER.filter(s => (jbo[s] && jbo[s].length > 0) || (mbo[s] && mbo[s].length > 0));

    return { jobsByOwner: jbo, monitorsByOwner: mbo, availableTabs: tabs };
  }, [jobs, monitors]);

  // Default to first available tab
  useEffect(() => {
    if (availableTabs.length > 0 && activeTab === null) {
      setActiveTab(availableTabs[0]);
    } else if (activeTab !== null && !availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0] || null);
    }
  }, [availableTabs, activeTab]);

  const toggleJob = async (jobId: string, enabled: boolean) => {
    setToggling(jobId);
    try {
      await fetch(`/api/jobs?id=${encodeURIComponent(jobId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      await fetchJobs();
    } catch {}
    setToggling(null);
  };

  const runNow = async (jobId: string) => {
    try {
      await fetch(`/api/jobs?id=${encodeURIComponent(jobId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runNow: true }),
      });
      setTimeout(fetchJobs, 2000);
    } catch {}
  };

  const currentTab = activeTab || availableTabs[0] || 'global';
  const tabJobs = jobsByOwner[currentTab] || [];
  const tabMonitors = monitorsByOwner[currentTab] || [];
  const enabledJobs = tabJobs.filter(j => j.enabled);
  const disabledJobs = tabJobs.filter(j => !j.enabled);

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ fontFamily: 'VT323, monospace' }}>
      {/* Header with global kill switch */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-800 flex items-center gap-3">
        <span style={{ fontSize: '22px' }}>🐓</span>
        <span style={{ color: accentColor, fontSize: '22px', fontWeight: 'bold', flex: 1 }}>SCHEDULER</span>
        <button
          onClick={async () => {
            setGlobalToggling(true);
            const newState = !globalEnabled;
            // Optimistic update
            setGlobalEnabled(newState);
            await fetch('/api/jobs', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ globalEnabled: newState }),
            });
            await fetchJobs();
            setGlobalToggling(false);
          }}
          disabled={globalToggling}
          style={{
            fontSize: '16px',
            padding: '6px 16px',
            borderRadius: '8px',
            background: globalEnabled ? '#330000' : '#003300',
            color: globalEnabled ? '#FF6666' : '#66FF66',
            border: `1px solid ${globalEnabled ? '#FF666640' : '#66FF6640'}`,
            opacity: globalToggling ? 0.5 : 1,
          }}
        >
          {globalToggling ? '...' : globalEnabled ? '⏸ ALL OFF' : '▶ ALL ON'}
        </button>
      </div>

      {/* Global gate banner when off */}
      {!globalEnabled && (
        <div className="flex-shrink-0 px-4 py-2 text-center" style={{ background: '#330000', color: '#FF9999', fontSize: '14px', borderBottom: '1px solid #FF666640' }}>
          GLOBAL GATE IS OFF — no scheduled jobs are running
        </div>
      )}

      {/* Steward tabs */}
      <div className="flex-shrink-0 flex border-b border-gray-800">
        {availableTabs.map(tab => {
          const tabInfo = STEWARD_TABS[tab] || { label: tab, icon: '⚙️' };
          const isActive = currentTab === tab;
          const tabJobCount = (jobsByOwner[tab] || []).length;
          const tabMonCount = (monitorsByOwner[tab] || []).length;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="flex-1 py-2 text-center transition-colors"
              style={{
                fontSize: '16px',
                background: isActive ? accentColor : '#111',
                color: isActive ? '#000' : accentColor + '99',
              }}
            >
              {tabInfo.icon} {tabInfo.label}
              <span style={{
                fontSize: '14px',
                marginLeft: '6px',
                opacity: 0.7,
              }}>
                {tabJobCount + tabMonCount}
              </span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {/* ─── TIMERS SECTION ─────────────────────────────────── */}
        {tabJobs.length > 0 && (
          <>
            <div className="px-4 py-2 border-b border-gray-800/50 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div>
                <span style={{ fontSize: '16px', color: accentColor, letterSpacing: '1px' }}>TIMERS</span>
                <span style={{ fontSize: '14px', color: '#555', marginLeft: '8px' }}>
                  {enabledJobs.length} active{disabledJobs.length > 0 ? ` · ${disabledJobs.length} paused` : ''}
                </span>
              </div>
            </div>

            {/* Active jobs */}
            {enabledJobs.map(job => {
              const meta = JOB_META[job.id] || { name: job.id, icon: '⚙️', owner: 'global', desc: '' };
              const isExpanded = expandedJob === job.id;
              const hasError = job.last_log?.error;
              const nextMs = getNextRunMs(job.cron);

              return (
                <div key={job.id} className="border-b border-gray-800/50">
                  <button
                    onClick={() => setExpandedJob(isExpanded ? null : job.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800/30 transition-colors text-left"
                    title={meta.desc}
                  >
                    <span style={{ fontSize: '24px', lineHeight: 1 }}>{meta.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2" style={{ lineHeight: 1.2 }}>
                        <span style={{ fontSize: '20px', color: 'var(--iowa-text, #fff)' }}>
                          {meta.name}
                        </span>
                        {(job.consecutive_failures || 0) > 0 && (
                          <span
                            title={`Failing for ${job.consecutive_failures} consecutive run${job.consecutive_failures === 1 ? '' : 's'}${job.last_error_text ? `: ${job.last_error_text}` : ''}`}
                            style={{
                              fontSize: '13px',
                              padding: '1px 7px',
                              borderRadius: '999px',
                              background: '#330000',
                              color: '#FF4444',
                              border: '1px solid #FF444480',
                              fontWeight: 'bold',
                            }}
                          >
                            ✗ {job.consecutive_failures}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span style={{ fontSize: '16px', color: accentColor }}>
                          {cronToHuman(job.cron)}
                        </span>
                        {job.last_run && (
                          <>
                            <span style={{ fontSize: '14px', color: '#444' }}>·</span>
                            <span style={{ fontSize: '14px', color: hasError ? '#FF4444' : '#666' }}>
                              {hasError ? 'failed ' : ''}{timeSince(job.last_run)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex-shrink-0 text-right">
                      {nextMs != null && (
                        <>
                          <div style={{ fontSize: '22px', color: '#FFCC00', lineHeight: 1 }}>
                            {formatCountdown(nextMs)}
                          </div>
                          <div style={{ fontSize: '12px', color: '#555', marginTop: '2px' }}>
                            next run
                          </div>
                        </>
                      )}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-4 py-3 border-t border-gray-800/30" style={{ background: 'rgba(255,255,255,0.02)' }}>
                      {meta.desc && (
                        <div style={{ fontSize: '14px', color: '#999', marginBottom: '8px', lineHeight: 1.4 }}>
                          {meta.desc}
                        </div>
                      )}
                      <div className="flex items-center gap-3 mb-3">
                        <code style={{ fontSize: '14px', padding: '2px 6px', borderRadius: '4px', background: '#111', color: accentColor }}>{job.cron}</code>
                        <span style={{ fontSize: '14px', color: '#555' }}>{job.run_count.toLocaleString()} runs</span>
                      </div>

                      {job.last_log && (
                        <div className="mb-3">
                          {job.last_log.error && (
                            <div style={{ fontSize: '14px', padding: '8px', borderRadius: '6px', background: '#1a0000', color: '#FF6666', maxHeight: '80px', overflow: 'auto' }}>
                              {job.last_log.error}
                            </div>
                          )}
                          {job.last_log.output && !job.last_log.error && (
                            <div style={{ fontSize: '13px', padding: '8px', borderRadius: '6px', background: '#0a0a0a', color: '#888', maxHeight: '120px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                              {job.last_log.output.split('\n').slice(-4).join('\n')}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); runNow(job.id); }}
                          style={{
                            fontSize: '16px', padding: '6px 14px', borderRadius: '8px',
                            background: `${accentColor}20`, color: accentColor,
                            border: `1px solid ${accentColor}50`,
                          }}
                        >
                          Run Now
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleJob(job.id, false); }}
                          disabled={toggling === job.id}
                          style={{
                            fontSize: '16px', padding: '6px 14px', borderRadius: '8px',
                            background: '#1a0000', color: '#FF6666',
                            border: '1px solid #FF666640',
                            opacity: toggling === job.id ? 0.5 : 1,
                          }}
                        >
                          {toggling === job.id ? '...' : 'Pause'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Paused jobs */}
            {disabledJobs.length > 0 && (
              <div className="px-4 py-2 border-b border-gray-800/50" style={{ background: 'rgba(255,255,255,0.01)' }}>
                <span style={{ fontSize: '16px', color: '#444' }}>PAUSED</span>
              </div>
            )}
            {disabledJobs.map(job => {
              const meta = JOB_META[job.id] || { name: job.id, icon: '⚙️', owner: 'global' };
              return (
                <div key={job.id} className="border-b border-gray-800/30" style={{ opacity: 0.5 }}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span style={{ fontSize: '20px', lineHeight: 1 }}>{meta.icon}</span>
                    <div className="flex-1 min-w-0">
                      <span style={{ fontSize: '18px', color: '#666' }}>{meta.name}</span>
                      <div style={{ fontSize: '14px', color: '#444' }}>{cronToHuman(job.cron)} · {job.run_count.toLocaleString()} runs</div>
                    </div>
                    <button
                      onClick={() => toggleJob(job.id, true)}
                      disabled={toggling === job.id}
                      style={{
                        fontSize: '16px', padding: '6px 14px', borderRadius: '8px',
                        background: '#001a00', color: '#66FF66',
                        border: '1px solid #66FF6640',
                        opacity: toggling === job.id ? 0.5 : 1,
                      }}
                    >
                      {toggling === job.id ? '...' : 'Resume'}
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* ─── MONITORS SECTION ───────────────────────────────── */}
        {tabMonitors.length > 0 && (
          <>
            <div className="px-4 py-2 border-b border-gray-800/50" style={{ background: 'rgba(255,255,255,0.02)' }}>
              <span style={{ fontSize: '16px', color: accentColor, letterSpacing: '1px' }}>MONITORS</span>
              <span style={{ fontSize: '14px', color: '#555', marginLeft: '8px' }}>
                {tabMonitors.filter(m => m.status === 'up').length}/{tabMonitors.length} up
              </span>
            </div>

            {tabMonitors.map(mon => {
              const statusColor = mon.status === 'up' ? '#00FF66' : mon.status === 'down' ? '#FF4444' : '#555';
              return (
                <div key={mon.id} className="border-b border-gray-800/50">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span style={{ fontSize: '24px', lineHeight: 1 }}>{mon.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div style={{ fontSize: '20px', color: 'var(--iowa-text, #fff)', lineHeight: 1.2 }}>
                        {mon.display_name}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <div
                          className="w-2.5 h-2.5 rounded-full"
                          style={{
                            background: statusColor,
                            boxShadow: mon.status === 'up' ? `0 0 6px ${statusColor}` : 'none',
                          }}
                        />
                        <span style={{ fontSize: '16px', color: statusColor }}>
                          {mon.status.toUpperCase()}
                        </span>
                        {mon.uptime_seconds != null && mon.status === 'up' && (
                          <>
                            <span style={{ fontSize: '14px', color: '#444' }}>·</span>
                            <span style={{ fontSize: '14px', color: '#666' }}>
                              up {formatUptime(mon.uptime_seconds)}
                            </span>
                          </>
                        )}
                        {mon.last_heartbeat && (
                          <>
                            <span style={{ fontSize: '14px', color: '#444' }}>·</span>
                            <span style={{ fontSize: '14px', color: mon.stale ? '#FF4444' : '#666' }}>
                              {timeSince(mon.last_heartbeat)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {Object.keys(mon.stats).length > 0 && (
                      <div className="flex-shrink-0 text-right">
                        {Object.entries(mon.stats).slice(0, 2).map(([key, val]) => (
                          <div key={key} style={{ fontSize: '13px', color: '#555' }}>
                            {key}: {String(val)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* Empty state */}
        {tabJobs.length === 0 && tabMonitors.length === 0 && (
          <div className="p-8 text-center" style={{ fontSize: '18px', color: '#555' }}>No items for this steward</div>
        )}
      </div>
    </div>
  );
}
