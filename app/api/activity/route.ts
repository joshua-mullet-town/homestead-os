import { NextRequest, NextResponse } from 'next/server';
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

interface ActivityEntry {
  id: string;
  type: 'thinking' | 'tool' | 'text';
  tool?: string;
  phase: 'start' | 'complete';
  message: string;
  timestamp: string;
}

interface TranscriptLine {
  type: 'user' | 'assistant';
  uuid: string;
  timestamp: string;
  message: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
  };
}

const CLAUDE_PROJECTS_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/.claude/projects';

/**
 * Map cwd to Claude's project directory name format
 * <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead -> -Users-joshuamullet-code-homestead
 * <<REPLACE: your home dir, e.g. /Users/you>>/.worktrees/homestead/branch -> -Users-joshuamullet--worktrees-homestead-branch
 */
function cwdToProjectDir(cwd: string): string {
  // Match Claude's encoding: remove leading /, replace / and . with -, add leading -
  return '-' + cwd.slice(1).replace(/\//g, '-').replace(/\./g, '-');
}

/**
 * Find the most recently modified .jsonl file for a project (excluding agent-* files)
 */
async function findLatestTranscript(projectDir: string): Promise<string | null> {
  const fullPath = path.join(CLAUDE_PROJECTS_DIR, projectDir);

  if (!existsSync(fullPath)) {
    return null;
  }

  try {
    const files = await readdir(fullPath);
    const jsonlFiles = files.filter(f =>
      f.endsWith('.jsonl') &&
      !f.startsWith('agent-') // Skip agent transcripts
    );

    if (jsonlFiles.length === 0) {
      return null;
    }

    // Find most recently modified
    let latest: { file: string; mtime: number } | null = null;
    for (const file of jsonlFiles) {
      const filePath = path.join(fullPath, file);
      const stats = await stat(filePath);
      if (!latest || stats.mtimeMs > latest.mtime) {
        latest = { file: filePath, mtime: stats.mtimeMs };
      }
    }

    return latest?.file || null;
  } catch (err) {
    console.error('[Activity] Error finding transcript:', err);
    return null;
  }
}

/**
 * Format a tool call into a human-readable message
 */
function formatToolMessage(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && input?.description) {
    return `$ ${input.description}`;
  } else if (toolName === 'Bash' && input?.command) {
    const cmd = String(input.command);
    return `$ ${cmd.substring(0, 60)}${cmd.length > 60 ? '...' : ''}`;
  } else if (toolName === 'Read' && input?.file_path) {
    return `Reading ${path.basename(String(input.file_path))}`;
  } else if (toolName === 'Edit' && input?.file_path) {
    return `Editing ${path.basename(String(input.file_path))}`;
  } else if (toolName === 'Write' && input?.file_path) {
    return `Writing ${path.basename(String(input.file_path))}`;
  } else if (toolName === 'Glob' && input?.pattern) {
    return `Finding: ${input.pattern}`;
  } else if (toolName === 'Grep' && input?.pattern) {
    const pattern = String(input.pattern);
    return `Searching: ${pattern.substring(0, 40)}`;
  } else if (toolName === 'Task' && input?.description) {
    return `Agent: ${input.description}`;
  } else if (toolName === 'TodoWrite') {
    return 'Updating todos';
  } else if (toolName?.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) {
      return `${parts[1]}: ${parts[2]}`;
    }
  }
  return toolName;
}

/**
 * Parse transcript and extract activities from only the LAST exchange
 * (from the last user message to the end)
 */
async function parseTranscriptTail(filePath: string, maxLines: number = 300): Promise<ActivityEntry[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Get last N lines to search through
    const recentLines = lines.slice(-maxLines);

    // First pass: find the index of the last "real" user message
    // (not a tool_result, but an actual user prompt)
    let lastUserMessageIndex = -1;
    for (let i = recentLines.length - 1; i >= 0; i--) {
      const line = recentLines[i];
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);
        // A "real" user message has role: user and content that's NOT a tool_result
        if (entry.type === 'user' && entry.message?.content) {
          const content = entry.message.content;
          // Check if this is an actual user prompt (has text type) vs tool result
          const isRealUserMessage = Array.isArray(content)
            ? content.some((c: { type: string }) => c.type === 'text')
            : typeof content === 'string';

          if (isRealUserMessage) {
            lastUserMessageIndex = i;
            break;
          }
        }
      } catch {
        continue;
      }
    }

    // If no user message found, return empty
    if (lastUserMessageIndex === -1) {
      return [];
    }

    // Second pass: extract activities from lastUserMessageIndex to end
    const activities: ActivityEntry[] = [];
    const relevantLines = recentLines.slice(lastUserMessageIndex);

    for (const line of relevantLines) {
      if (!line.trim()) continue;

      try {
        const entry: TranscriptLine = JSON.parse(line);

        if (entry.type === 'assistant' && entry.message?.content) {
          for (const contentItem of entry.message.content) {
            if (contentItem.type === 'text' && contentItem.text) {
              // Show full text messages
              activities.push({
                id: `text-${entry.uuid}-${activities.length}`,
                type: 'text',
                phase: 'complete',
                message: contentItem.text,
                timestamp: entry.timestamp,
              });
            } else if (contentItem.type === 'tool_use' && contentItem.name) {
              const input = contentItem.input as Record<string, unknown>;
              activities.push({
                id: contentItem.id || `tool-${entry.uuid}`,
                type: 'tool',
                tool: contentItem.name,
                phase: 'start',
                message: formatToolMessage(contentItem.name, input),
                timestamp: entry.timestamp,
              });
            }
          }
        }
      } catch {
        continue;
      }
    }

    // Remove the final text message - it's the main response shown separately
    // Find the last text activity and remove it
    let lastTextIndex = -1;
    for (let i = activities.length - 1; i >= 0; i--) {
      if (activities[i].type === 'text') {
        lastTextIndex = i;
        break;
      }
    }

    const filteredActivities = lastTextIndex >= 0
      ? activities.filter((_, i) => i !== lastTextIndex)
      : activities;

    // Return all activities from this exchange, mark as complete
    return filteredActivities.map(a => ({ ...a, phase: 'complete' as const }));
  } catch (err) {
    console.error('[Activity] Error parsing transcript:', err);
    return [];
  }
}

/**
 * GET /api/activity?session=holler-homestead
 *
 * Returns live activity data by reading Claude's transcript files directly
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionName = searchParams.get('session');

  if (!sessionName) {
    return NextResponse.json({ error: 'Session name required' }, { status: 400 });
  }

  // First, try the hook-based activity file (for real-time "is_working" status)
  const activityFile = `/tmp/claude-session-${sessionName}-activity.json`;
  let isWorking = false;
  let currentTool: string | null = null;

  if (existsSync(activityFile)) {
    try {
      const hookData = JSON.parse(await readFile(activityFile, 'utf-8'));
      isWorking = hookData.is_working || false;
      currentTool = hookData.current_tool || null;
    } catch {
      // Ignore hook file errors
    }
  }

  // Extract project path from session name
  // Session format: holler-{project} or holler-{project}--{branch}
  const match = sessionName.match(/^holler-(.+?)(?:--(.+))?$/);
  if (!match) {
    return NextResponse.json({
      activities: [],
      is_working: isWorking,
      current_tool: currentTool,
      updated_at: new Date().toISOString(),
    });
  }

  const projectName = match[1];
  const branchName = match[2]; // undefined if no branch (main repo)

  // Determine cwd based on whether this is a worktree or main repo
  const cwd = branchName
    ? `<<REPLACE: your home dir, e.g. /Users/you>>/.worktrees/${projectName}/${branchName}`
    : `<<REPLACE: your home dir, e.g. /Users/you>>/code/${projectName}`;
  const projectDir = cwdToProjectDir(cwd);

  // Find and parse the latest transcript
  const transcriptPath = await findLatestTranscript(projectDir);

  if (!transcriptPath) {
    return NextResponse.json({
      activities: [],
      is_working: isWorking,
      current_tool: currentTool,
      updated_at: new Date().toISOString(),
    });
  }

  const activities = await parseTranscriptTail(transcriptPath, 150);

  return NextResponse.json({
    activities,
    is_working: isWorking,
    current_tool: currentTool,
    updated_at: new Date().toISOString(),
  });
}

/**
 * DELETE /api/activity?session=holler-homestead
 *
 * Clears the hook-based activity file (transcript is not cleared)
 */
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionName = searchParams.get('session');

  if (!sessionName) {
    return NextResponse.json({ error: 'Session name required' }, { status: 400 });
  }

  const activityFile = `/tmp/claude-session-${sessionName}-activity.json`;

  try {
    const { unlink } = await import('fs/promises');
    if (existsSync(activityFile)) {
      await unlink(activityFile);
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[Activity] Error clearing activity:', err);
    return NextResponse.json({ error: 'Failed to clear activity' }, { status: 500 });
  }
}
