import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { getCodeDir } from '@/lib/get-code-dir';

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

interface ClaudeSession {
  sessionId: string;
  cwd: string;
  status: 'working' | 'waiting' | 'idle' | 'terminated' | 'interrupted';
  tmuxSession?: string; // The actual tmux session name (e.g., holler-GiveGrove--prod-debug)
  summary?: string;
  userSummary?: string;
  agentSummary?: string;
  updatedAt: string;
  displayName?: string;
  // Derived fields
  projectName: string;
  fileHash: string;
}

interface ProjectSession {
  sessionId: string;
  fullPath: string;
  firstPrompt: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
}

// Generate the same hash that the hooks use
function getCwdHash(cwd: string): string {
  return createHash('md5').update(cwd).digest('hex').substring(0, 12);
}

// Parse the summary field which might be JSON in markdown code block
function parseSummary(summary: string | undefined): { userSummary?: string; agentSummary?: string } {
  if (!summary) return {};

  // Try to extract JSON from markdown code block
  const jsonMatch = summary.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        userSummary: parsed.user_summary,
        agentSummary: parsed.agent_summary,
      };
    } catch {
      // Fall through to return raw summary
    }
  }

  return { userSummary: summary };
}

// Encode project path the way Claude does it (replace / with -)
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
}

// Get sessions from the project's sessions-index.json
async function getProjectSessions(projectPath: string): Promise<ProjectSession[]> {
  const encodedPath = encodeProjectPath(projectPath);
  const indexPath = join(PROJECTS_DIR, encodedPath, 'sessions-index.json');

  if (!existsSync(indexPath)) {
    console.log('[claude-sessions] No sessions-index.json found at:', indexPath);
    return [];
  }

  try {
    const content = await readFile(indexPath, 'utf-8');
    const data = JSON.parse(content);
    // Sort by modified date, most recent first
    const sessions = (data.entries || []).sort((a: ProjectSession, b: ProjectSession) =>
      new Date(b.modified).getTime() - new Date(a.modified).getTime()
    );
    return sessions;
  } catch (err) {
    console.error('[claude-sessions] Error reading sessions-index.json:', err);
    return [];
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectPath = searchParams.get('projectPath');
  const raw = searchParams.get('raw') === 'true'; // Return all sessions without filtering

  // If projectPath is provided, return sessions from that project's sessions-index.json
  if (projectPath) {
    const sessions = await getProjectSessions(projectPath);
    return NextResponse.json({ sessions });
  }

  // Read all sessions from ~/.claude/sessions/ (like Whisper Village does)
  try {
    if (!existsSync(SESSIONS_DIR)) {
      return NextResponse.json({ sessions: [] });
    }

    const files = await readdir(SESSIONS_DIR);
    const allSessions: ClaudeSession[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await readFile(join(SESSIONS_DIR, file), 'utf-8');
        const data = JSON.parse(content);

        // Validate required fields (same as Whisper Village)
        if (!data.cwd || !data.updatedAt) continue;

        // Extract project name from cwd
        const projectName = data.cwd.split('/').pop() || 'unknown';

        // Parse summary
        const { userSummary, agentSummary } = parseSummary(data.summary);

        // Hooks are the source of truth for status
        const status: ClaudeSession['status'] = data.status || 'idle';

        const session: ClaudeSession = {
          sessionId: data.sessionId || '',
          cwd: data.cwd,
          status,
          tmuxSession: data.tmuxSession, // Include tmux session name for matching
          summary: data.summary,
          userSummary: data.userSummary || userSummary,
          agentSummary: data.agentSummary || agentSummary,
          updatedAt: data.updatedAt,
          displayName: data.displayName,
          projectName,
          fileHash: file.replace('.json', ''),
        };

        allSessions.push(session);
      } catch (err) {
        // Skip files that can't be parsed (same as Whisper Village)
        continue;
      }
    }

    // If raw mode, return all sessions (for status matching by cwd like Whisper Village)
    if (raw) {
      return NextResponse.json({ sessions: allSessions });
    }

    // Otherwise, apply filtering (original behavior)
    const CODE_DIR = getCodeDir();
    const sessionsMap = new Map<string, ClaudeSession>();

    for (const session of allSessions) {
      // Only include sessions from our code directory (direct children only)
      if (!session.cwd?.startsWith(CODE_DIR + '/')) continue;

      // Extract project name from cwd - must be a direct child of CODE_DIR
      const relativePath = session.cwd.replace(CODE_DIR + '/', '');
      const projectName = relativePath.split('/')[0];

      // Skip if the cwd is a subdirectory (not directly CODE_DIR/projectName)
      if (relativePath !== projectName) continue;

      // Only show sessions updated in the last 24 hours
      const updatedAt = new Date(session.updatedAt);
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      if (updatedAt < oneDayAgo) continue;

      // Keep the most recent session for each project
      const existing = sessionsMap.get(projectName);
      if (!existing || new Date(session.updatedAt) > new Date(existing.updatedAt)) {
        sessionsMap.set(projectName, { ...session, projectName });
      }
    }

    // Convert map to array and sort by updatedAt (most recent first)
    const sessions = Array.from(sessionsMap.values()).sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return NextResponse.json({ sessions });
  } catch (error) {
    console.error('Failed to read claude sessions:', error);
    return NextResponse.json({ sessions: [], error: 'Failed to read sessions' });
  }
}
