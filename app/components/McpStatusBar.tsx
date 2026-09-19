'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Cpu, Skull, X, RefreshCw, Trash2 } from 'lucide-react';

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

function formatGb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function severityColor(totalMb: number): string {
  if (totalMb >= 4096) return '#FF3333'; // red >4GB
  if (totalMb >= 2048) return '#FFCC00'; // yellow 2-4GB
  return '#00FF66'; // green <2GB
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

function formatStartTime(startTimeStr: string): string {
  // Format: "Thu Feb 19 07:54:46 2026" -> "07:54"
  const match = startTimeStr.match(/(\d{2}:\d{2}):\d{2}/);
  return match ? match[1] : startTimeStr;
}

function getAgeColor(ageMinutes: number | null): string {
  if (ageMinutes === null) return '#6B7280'; // gray - unknown
  if (ageMinutes < 5) return '#00FF66'; // green - very recent
  if (ageMinutes < 30) return '#88CC44'; // lime - recent
  if (ageMinutes < 60) return '#FFCC00'; // yellow - getting stale
  if (ageMinutes < 120) return '#FF9900'; // orange - stale
  return '#FF3333'; // red - old
}

function getAgeBadge(ageMinutes: number | null): string | null {
  if (ageMinutes === null) return null;
  if (ageMinutes < 5) return null; // no badge for very recent
  if (ageMinutes < 60) return `${ageMinutes}m`;
  if (ageMinutes < 1440) return `${Math.floor(ageMinutes / 60)}h`;
  return `${Math.floor(ageMinutes / 1440)}d`;
}

export default function McpStatusBar() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [killing, setKilling] = useState(false);
  const [killResult, setKillResult] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showClaudeDetails, setShowClaudeDetails] = useState(false);
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp-status');
      if (res.ok) setStatus(await res.json());
    } catch {
      // silent - will retry on next poll
    }
  }, []);

  const manualRefresh = async () => {
    setRefreshing(true);
    await fetchStatus();
    setRefreshing(false);
  };

  // Poll every 10 seconds
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setKillResult(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const killOrphans = async () => {
    setKilling(true);
    setKillResult(null);
    try {
      const res = await fetch('/api/mcp-status', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        setKillResult(`Killed ${data.killed} orphans`);
        setStatus({
          claude: data.claude,
          mcp: data.mcp,
          orphans: data.orphans,
          totalMb: data.totalMb,
        });
      } else {
        setKillResult('Failed to kill orphans');
      }
    } catch {
      setKillResult('Error killing orphans');
    }
    setKilling(false);
  };

  const killClaudeProcess = async (pid: number, project: string) => {
    setKillingPid(pid);
    setKillResult(null);
    try {
      const res = await fetch(`/api/mcp-status?pid=${pid}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        setKillResult(`Killed ${project}`);
        setStatus({
          claude: data.claude,
          mcp: data.mcp,
          orphans: data.orphans,
          totalMb: data.totalMb,
        });
      } else {
        setKillResult(data.error || 'Failed to kill process');
      }
    } catch {
      setKillResult('Error killing process');
    }
    setKillingPid(null);
  };

  if (!status) return null;

  const color = severityColor(status.totalMb);
  const hasOrphans = status.orphans.count > 0;

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Status pill */}
      <button
        onClick={() => { setOpen(!open); setKillResult(null); }}
        className="flex items-center gap-1.5 px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
        style={{ fontFamily: 'VT323, monospace', fontSize: '14px' }}
        title="MCP Process Monitor"
      >
        <Cpu size={14} style={{ color }} />
        <span style={{ color: '#9CA3AF' }}>
          C:{status.claude.count}
        </span>
        <span style={{ color }}>
          MCP:{status.mcp.count}
        </span>
        {hasOrphans && (
          <span style={{ color: '#FF3333' }}>
            <Skull size={12} className="inline -mt-0.5" />
            {status.orphans.count}
          </span>
        )}
        <span style={{ color }}>
          {formatGb(status.totalMb)}
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute top-full mt-1 right-0 z-50 bg-gray-900 border-2 rounded-lg p-3 min-w-[260px]"
          style={{
            borderColor: color,
            boxShadow: `0 0 16px ${color}33`,
            fontFamily: 'VT323, monospace',
          }}
        >
          {/* Header with refresh and close */}
          <div className="flex items-center justify-between mb-2">
            <div className="text-base text-[#FFCC00]">MCP PROCESSES</div>
            <div className="flex items-center gap-1">
              <button
                onClick={manualRefresh}
                className="p-1 text-gray-500 hover:text-[#FF6600] transition-colors"
                title="Refresh stats"
              >
                <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => { setOpen(false); setKillResult(null); }}
                className="p-1 text-gray-500 hover:text-white transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="space-y-1 text-sm">
            <button
              className="w-full flex justify-between hover:bg-gray-800 rounded px-1 -mx-1 transition-colors"
              onClick={() => setShowClaudeDetails(!showClaudeDetails)}
            >
              <span className="text-gray-400">Claude {showClaudeDetails ? '▼' : '▶'}</span>
              <span className="text-white">{status.claude.count} <span className="text-gray-500">({formatGb(status.claude.memMb)})</span></span>
            </button>

            {/* Claude process details */}
            {showClaudeDetails && status.claude.details && (
              <div className="ml-2 pl-2 border-l border-gray-700 space-y-2 py-1">
                {status.claude.details.map((proc) => {
                  const ageColor = getAgeColor(proc.ageMinutes);
                  const ageBadge = getAgeBadge(proc.ageMinutes);
                  return (
                    <div key={proc.pid} className="text-xs space-y-0.5 group">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-1.5">
                          {/* Age indicator dot */}
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: ageColor }}
                            title={proc.ageMinutes !== null ? `${proc.ageMinutes}m since last activity` : 'Unknown activity'}
                          />
                          <span style={{ color: ageColor }} className="font-bold">{proc.project}</span>
                          {ageBadge && (
                            <span
                              className="text-[9px] px-1 rounded"
                              style={{ backgroundColor: `${ageColor}22`, color: ageColor }}
                            >
                              {ageBadge}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500">{proc.memMb} MB</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              killClaudeProcess(proc.pid, proc.project);
                            }}
                            disabled={killingPid === proc.pid}
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-500 hover:text-[#FF3333] transition-all disabled:opacity-50"
                            title={`Kill ${proc.project} (PID ${proc.pid})`}
                          >
                            <Trash2 size={12} className={killingPid === proc.pid ? 'animate-pulse' : ''} />
                          </button>
                        </div>
                      </div>
                      <div className="flex justify-between text-gray-500">
                        <span>started {formatStartTime(proc.startTime)}</span>
                        <span style={{ color: ageColor }}>active {timeAgo(proc.sessionLastActivity)}</span>
                      </div>
                      <div className="text-gray-600 truncate text-[10px]" title={proc.cwd}>
                        {proc.cwd.replace(/^\/Users\/[^/]+\//, '~/')}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex justify-between">
              <span className="text-gray-400">MCP (live)</span>
              <span className="text-[#00FF66]">{status.mcp.count} <span className="text-gray-500">({formatGb(status.mcp.memMb)})</span></span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Orphans</span>
              <span style={{ color: hasOrphans ? '#FF3333' : '#00FF66' }}>
                {status.orphans.count} <span className="text-gray-500">({formatGb(status.orphans.memMb)})</span>
              </span>
            </div>
            <div className="border-t border-gray-700 pt-1 flex justify-between font-bold">
              <span className="text-gray-400">Total</span>
              <span style={{ color }}>{formatGb(status.totalMb)}</span>
            </div>
          </div>

          {/* Kill Orphans button */}
          {hasOrphans && (
            <button
              onClick={killOrphans}
              disabled={killing}
              className="mt-3 w-full py-1.5 bg-[#FF3333] hover:bg-red-400 text-black font-bold rounded transition-colors disabled:opacity-50 text-sm"
              style={{ fontFamily: 'VT323, monospace' }}
            >
              {killing ? 'KILLING...' : `KILL ${status.orphans.count} ORPHANS`}
            </button>
          )}

          {killResult && (
            <div className="mt-2 text-center text-sm text-[#00FF66]">{killResult}</div>
          )}
        </div>
      )}
    </div>
  );
}
