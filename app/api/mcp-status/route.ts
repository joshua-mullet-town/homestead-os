import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CACHE_TTL_MS = 2000;
let getCache: { data: any; expiresAt: number } | null = null;

interface ProcessInfo {
  pid: number;
  ppid: number;
  rss: number; // KB
  comm: string;
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

async function getProcessList(): Promise<ProcessInfo[]> {
  // Get all processes with PID, PPID, RSS (KB), and full command
  const { stdout } = await execAsync(
    'ps -eo pid=,ppid=,rss=,comm= 2>/dev/null'
  ).catch(() => ({ stdout: '' }));

  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parseInt(parts[0], 10),
        ppid: parseInt(parts[1], 10),
        rss: parseInt(parts[2], 10),
        comm: parts.slice(3).join(' '),
      };
    })
    .filter((p) => !isNaN(p.pid));
}

/**
 * Basename of the EXECUTABLE a process is running.
 *
 * `cmd` here is a full command line (`ps -eo args=`) or a comm path
 * (`ps -eo comm=`, which is an absolute path on macOS). We take only the FIRST
 * whitespace-delimited token and strip its directory, so what comes back is the
 * program being run — never anything from its arguments.
 *
 * This matters enormously: a real Claude session's argv contains dozens of
 * `--add-dir /Users/.../code/mcp/` style paths. Any predicate that tests the
 * WHOLE command line for "mcp" misclassifies nearly every live Claude session,
 * which in turn makes their healthy MCP children look parentless (see
 * walkToRoot / the orphan cascade).
 */
function execBasename(cmd: string): string {
  const first = cmd.trim().split(/\s+/)[0] || '';
  const parts = first.split('/');
  return parts[parts.length - 1];
}

/** True when the process IS the Claude CLI binary (not an MCP wrapper). */
function isClaudeBinary(cmd: string): boolean {
  const base = execBasename(cmd);
  // Exact binary name only. "claude-mcp", "claude-mcp-server" etc. are wrappers,
  // not the CLI, and are excluded by the equality check itself.
  return base === 'claude';
}

/**
 * PIDs currently supervised by launchd (user agents).
 *
 * A launchd-managed daemon legitimately has ppid 1 — that is what being
 * supervised LOOKS like, not evidence of abandonment. Without this, healthy
 * long-lived agents (e.g. com.homestead.sms-webhook, com.mcp-daemon) get
 * classified as orphans and offered up to the kill button. Anything launchd
 * owns is by definition not an orphan.
 */
async function getLaunchdManagedPids(): Promise<Set<number>> {
  const { stdout } = await execAsync('launchctl list 2>/dev/null').catch(
    () => ({ stdout: '' })
  );
  const pids = new Set<number>();
  for (const line of stdout.split('\n')) {
    const pid = parseInt(line.trim().split(/\s+/)[0], 10);
    if (!isNaN(pid) && pid > 0) pids.add(pid);
  }
  return pids;
}

function isOwnerProcess(proc: ProcessInfo, fullCmd?: string): boolean {
  // A process is a valid "owner" if it's claude (CLI) or mcp-proxy (the daemon).
  // Classification is on the EXECUTABLE only — never on argument text.
  const cmd = fullCmd || proc.comm;
  const base = execBasename(cmd);
  return isClaudeBinary(cmd) || base === 'mcp-proxy';
}

async function getClaudeProcessDetails(
  claudeProcs: ProcessInfo[]
): Promise<ClaudeProcessDetail[]> {
  const details: ClaudeProcessDetail[] = [];

  for (const proc of claudeProcs) {
    // Get current working directory via lsof
    let cwd = '';
    try {
      const { stdout } = await execAsync(
        `lsof -a -d cwd -p ${proc.pid} 2>/dev/null | tail -1 | awk '{print $NF}'`
      );
      cwd = stdout.trim();
    } catch {
      cwd = 'unknown';
    }

    // Extract project name from cwd
    let project = 'unknown';
    if (cwd.includes('/.worktrees/')) {
      // Format: ~/.worktrees/project/branch
      const match = cwd.match(/\.worktrees\/([^/]+)\/([^/]+)/);
      if (match) {
        project = `${match[1]}/${match[2]}`;
      }
    } else if (cwd.includes('/code')) {
      // Format: ~/code/project or ~/code (ephemeral workers)
      const match = cwd.match(/\/code\/([^/]+)/);
      if (match) {
        project = match[1];
      } else if (cwd.endsWith('/code')) {
        // Ephemeral worker spawned in ~/code - try to identify from tmux session
        // Claude is a child of the shell, so check parent PID against tmux pane PIDs
        try {
          const { stdout: tmuxOut } = await execAsync(
            `tmux list-panes -a -F "#{pane_pid} #{session_name}" 2>/dev/null | grep "^${proc.ppid} " || true`
          );
          const tmuxMatch = tmuxOut.trim().match(/^\d+\s+(.+)$/);
          if (tmuxMatch) {
            const sessionName = tmuxMatch[1];
            if (sessionName.startsWith('ephemeral-')) {
              project = 'worker';
            } else if (sessionName.startsWith('alert-')) {
              project = `alert/${sessionName.replace('alert-', '')}`;
            } else if (sessionName.startsWith('holler-')) {
              project = sessionName.replace('holler-', '');
            } else {
              project = sessionName;
            }
          } else {
            project = 'ephemeral';
          }
        } catch {
          project = 'ephemeral';
        }
      }
    }

    // Get process start time
    let startTime = '';
    try {
      const { stdout } = await execAsync(
        `ps -p ${proc.pid} -o lstart= 2>/dev/null`
      );
      startTime = stdout.trim();
    } catch {
      startTime = 'unknown';
    }

    // Get session last activity from Claude project directory
    let sessionLastActivity: string | null = null;
    if (cwd && cwd !== 'unknown') {
      // Convert cwd to Claude project directory name (Claude uses - for / and .)
      const projectDirName = cwd.replace(/[/.]/g, '-');
      const projectPath = `${process.env.HOME}/.claude/projects/${projectDirName}`;
      try {
        const { stdout } = await execAsync(
          `stat -f "%m" "${projectPath}" 2>/dev/null || stat -c "%Y" "${projectPath}" 2>/dev/null`
        );
        const timestamp = parseInt(stdout.trim(), 10);
        if (!isNaN(timestamp)) {
          sessionLastActivity = new Date(timestamp * 1000).toISOString();
        }
      } catch {
        // No session directory found
      }
    }

    // Calculate age in minutes for sorting and display
    let ageMinutes: number | null = null;
    if (sessionLastActivity) {
      const activityTime = new Date(sessionLastActivity).getTime();
      ageMinutes = Math.floor((Date.now() - activityTime) / 60000);
    }

    details.push({
      pid: proc.pid,
      memMb: Math.round(proc.rss / 1024),
      cwd,
      project,
      startTime,
      sessionLastActivity,
      ageMinutes,
    });
  }

  // Sort by last activity (most recent first), nulls last
  details.sort((a, b) => {
    if (a.sessionLastActivity === null && b.sessionLastActivity === null) return 0;
    if (a.sessionLastActivity === null) return 1;
    if (b.sessionLastActivity === null) return -1;
    return new Date(b.sessionLastActivity).getTime() - new Date(a.sessionLastActivity).getTime();
  });

  return details;
}

function walkToRoot(
  pid: number,
  processMap: Map<number, ProcessInfo>,
  fullCmdMap: Map<number, string>,
  maxDepth = 10
): boolean {
  let current = pid;
  for (let i = 0; i < maxDepth; i++) {
    const proc = processMap.get(current);
    if (!proc) break;
    const parent = processMap.get(proc.ppid);
    if (!parent) break;
    const parentFullCmd = fullCmdMap.get(parent.pid);
    // Check if parent is an owner (claude or mcp-proxy)
    if (isOwnerProcess(parent, parentFullCmd)) return true;
    // Stop if we've reached init/launchd (PPID 0 or 1)
    if (parent.ppid === 0 || parent.ppid === 1) break;
    current = proc.ppid;
  }
  return false;
}

export async function GET() {
  const now = Date.now();
  if (getCache && getCache.expiresAt > now) {
    return NextResponse.json(getCache.data);
  }

  try {
    const processes = await getProcessList();
    const processMap = new Map(processes.map((p) => [p.pid, p]));

    // Also get full command lines for better MCP detection
    const { stdout: fullCmds } = await execAsync(
      'ps -eo pid=,args= 2>/dev/null'
    ).catch(() => ({ stdout: '' }));

    const fullCmdMap = new Map<number, string>();
    fullCmds
      .trim()
      .split('\n')
      .filter(Boolean)
      .forEach((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (match) {
          fullCmdMap.set(parseInt(match[1], 10), match[2]);
        }
      });

    // Categorize using full command lines.
    //
    // Matching note: `ps -eo args` and `ps -eo comm` BOTH return the absolute
    // path of the executable on macOS (e.g. /Users/.../.local/bin/claude), so
    // classification takes the first token and compares its BASENAME. It must
    // never inspect the argument text: a live Claude session passes dozens of
    // `--add-dir .../code/mcp/` paths, and the old `!/mcp/.test(fullCmd)` guard
    // therefore disqualified 18 of 20 real sessions — which cascaded into their
    // healthy MCP children being counted (and offered up for killing) as orphans.
    const claudeProcs: ProcessInfo[] = [];
    const mcpProcs: ProcessInfo[] = [];

    for (const proc of processes) {
      const fullCmd = fullCmdMap.get(proc.pid) || proc.comm;

      // Claude parent processes: the CLI binary itself, by executable name.
      if (isClaudeBinary(fullCmd)) {
        claudeProcs.push(proc);
        continue;
      }

      // MCP processes: node/uv/python running MCP-related stuff
      if (
        /node.*mcp|mcp-server\.js|chrome-devtools-mcp/.test(fullCmd) ||
        /uv.*tool|uv.*uvx|uv.*mcp/.test(fullCmd) ||
        /python.*mcp|mcp_stdio/.test(fullCmd)
      ) {
        mcpProcs.push(proc);
      }
    }

    // Find orphans: MCP processes with no living claude/mcp-proxy ancestor AND
    // reparented to launchd (ppid <= 1). Both conditions are required — the
    // ppid check is what keeps a live server under a running session from ever
    // being counted (or killed) as an orphan. DELETE applies the identical rule,
    // so the "Kill N orphans" button can only ever target what is shown here.
    const launchdPids = await getLaunchdManagedPids();
    const orphanProcs = mcpProcs.filter(
      (proc) =>
        !walkToRoot(proc.pid, processMap, fullCmdMap) &&
        proc.ppid <= 1 &&
        !launchdPids.has(proc.pid)
    );
    const orphanPids = new Set(orphanProcs.map((p) => p.pid));

    const liveProcs = mcpProcs.filter((p) => !orphanPids.has(p.pid));

    const claudeMemKb = claudeProcs.reduce((sum, p) => sum + p.rss, 0);
    const mcpMemKb = liveProcs.reduce((sum, p) => sum + p.rss, 0);
    const orphanMemKb = orphanProcs.reduce((sum, p) => sum + p.rss, 0);

    // Get detailed Claude process info
    const claudeDetails = await getClaudeProcessDetails(claudeProcs);

    const payload = {
      claude: { count: claudeProcs.length, memMb: Math.round(claudeMemKb / 1024), details: claudeDetails },
      mcp: { count: liveProcs.length, memMb: Math.round(mcpMemKb / 1024) },
      orphans: { count: orphanProcs.length, memMb: Math.round(orphanMemKb / 1024) },
      totalMb: Math.round((claudeMemKb + mcpMemKb + orphanMemKb) / 1024),
    };
    getCache = { data: payload, expiresAt: Date.now() + CACHE_TTL_MS };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to get MCP status', detail: String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const pidParam = url.searchParams.get('pid');

    // If a specific PID is provided, kill that Claude process
    if (pidParam) {
      const pid = parseInt(pidParam, 10);
      if (isNaN(pid)) {
        return NextResponse.json(
          { error: 'Invalid PID' },
          { status: 400 }
        );
      }

      // Verify it's actually a Claude process before killing
      const { stdout } = await execAsync(
        `ps -p ${pid} -o comm= 2>/dev/null`
      ).catch(() => ({ stdout: '' }));

      if (!stdout.trim().includes('claude')) {
        return NextResponse.json(
          { error: 'PID is not a Claude process' },
          { status: 400 }
        );
      }

      // Kill the process (SIGTERM first, then SIGKILL)
      await execAsync(`kill ${pid} 2>/dev/null`).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      await execAsync(`kill -0 ${pid} 2>/dev/null && kill -9 ${pid} 2>/dev/null`).catch(() => {});

      // Return fresh stats — invalidate cache so caller sees post-kill state
      getCache = null;
      const response = await GET();
      const freshStats = await response.json();

      return NextResponse.json({
        killed: 1,
        killedPid: pid,
        ...freshStats,
      });
    }

    // Default behavior: kill orphan MCP processes
    const processes = await getProcessList();
    const processMap = new Map(processes.map((p) => [p.pid, p]));

    const { stdout: fullCmds } = await execAsync(
      'ps -eo pid=,args= 2>/dev/null'
    ).catch(() => ({ stdout: '' }));

    const fullCmdMap = new Map<number, string>();
    fullCmds
      .trim()
      .split('\n')
      .filter(Boolean)
      .forEach((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (match) {
          fullCmdMap.set(parseInt(match[1], 10), match[2]);
        }
      });

    // Find MCP processes
    const mcpPids: number[] = [];
    for (const proc of processes) {
      const fullCmd = fullCmdMap.get(proc.pid) || proc.comm;
      if (
        /node.*mcp|mcp-server\.js|chrome-devtools-mcp/.test(fullCmd) ||
        /uv.*tool|uv.*uvx|uv.*mcp/.test(fullCmd) ||
        /python.*mcp|mcp_stdio/.test(fullCmd)
      ) {
        mcpPids.push(proc.pid);
      }
    }

    // Find orphans — same rule the GET readout uses, so the button can never
    // target more than what the popover displayed.
    const candidatePids = mcpPids.filter(
      (pid) => !walkToRoot(pid, processMap, fullCmdMap)
    );

    // SAFETY GATE (defense in depth). Classification alone must never be the
    // sole authority for killing: this endpoint previously offered to kill 104
    // "orphans" that were in fact healthy MCP servers under live Claude
    // sessions. A genuinely orphaned process has been reparented to launchd,
    // so we additionally require ppid <= 1 and a parent that no longer exists.
    // Anything still owned by a living parent is spared no matter how it was
    // classified upstream.
    const launchdPids = await getLaunchdManagedPids();
    const orphanPids = candidatePids.filter((pid) => {
      const proc = processMap.get(pid);
      if (!proc) return false;
      if (proc.ppid > 1) return false; // still has a real parent — not an orphan
      if (launchdPids.has(pid)) return false; // launchd supervises it — not an orphan
      return true;
    });

    const spared = candidatePids.length - orphanPids.length;

    if (orphanPids.length > 0) {
      // Graceful kill first
      await execAsync(`kill ${orphanPids.join(' ')} 2>/dev/null`).catch(() => {});
      // Wait briefly
      await new Promise((r) => setTimeout(r, 500));
      // Force kill stragglers
      for (const pid of orphanPids) {
        await execAsync(`kill -0 ${pid} 2>/dev/null && kill -9 ${pid} 2>/dev/null`).catch(() => {});
      }
    }

    // Return fresh stats — invalidate cache so caller sees post-kill state
    getCache = null;
    const response = await GET();
    const freshStats = await response.json();

    return NextResponse.json({
      killed: orphanPids.length,
      // How many classified-orphan candidates the safety gate refused to kill
      // because they still had a living parent.
      spared,
      ...freshStats,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to kill process', detail: String(err) },
      { status: 500 }
    );
  }
}
