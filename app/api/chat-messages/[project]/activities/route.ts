import { NextRequest, NextResponse } from 'next/server';
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

interface ToolEntry {
  name: string;
  message: string;
  timestamp: string;
}

interface ExchangeActivity {
  exchange_index: number;
  tools: ToolEntry[];
  tool_count: number;
}

const CLAUDE_PROJECTS_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/.claude/projects';

function cwdToProjectDir(cwd: string): string {
  return '-' + cwd.slice(1).replace(/\//g, '-').replace(/\./g, '-');
}

async function findLatestTranscript(projectDir: string): Promise<string | null> {
  const fullPath = path.join(CLAUDE_PROJECTS_DIR, projectDir);
  if (!existsSync(fullPath)) return null;

  try {
    const files = await readdir(fullPath);
    const jsonlFiles = files.filter(f =>
      f.endsWith('.jsonl') && !f.startsWith('agent-')
    );
    if (jsonlFiles.length === 0) return null;

    let latest: { file: string; mtime: number } | null = null;
    for (const file of jsonlFiles) {
      const filePath = path.join(fullPath, file);
      const stats = await stat(filePath);
      if (!latest || stats.mtimeMs > latest.mtime) {
        latest = { file: filePath, mtime: stats.mtimeMs };
      }
    }
    return latest?.file || null;
  } catch {
    return null;
  }
}

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
    return `Searching: ${String(input.pattern).substring(0, 40)}`;
  } else if (toolName === 'Task' && input?.description) {
    return `Agent: ${input.description}`;
  } else if (toolName === 'TodoWrite') {
    return 'Updating todos';
  } else if (toolName?.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) return `${parts[1]}: ${parts[2]}`;
  }
  return toolName;
}

/**
 * Parse full transcript and group tool activities by exchange.
 * Each "exchange" starts at a real user message and ends before the next one.
 */
async function parseAllExchangeActivities(filePath: string): Promise<ExchangeActivity[]> {
  const content = await readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  // Pass 1: find indices of all real user messages
  const realUserIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const c = entry.message.content;
        const isReal = typeof c === 'string' ||
          (Array.isArray(c) && c.some((item: { type: string }) => item.type === 'text'));
        if (isReal) realUserIndices.push(i);
      }
    } catch { continue; }
  }

  // Pass 2: for each exchange segment, collect tool_use entries
  const result: ExchangeActivity[] = [];
  for (let e = 0; e < realUserIndices.length; e++) {
    const segStart = realUserIndices[e];
    const segEnd = e + 1 < realUserIndices.length ? realUserIndices[e + 1] : lines.length;

    const tools: ToolEntry[] = [];
    for (let i = segStart + 1; i < segEnd; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant' && entry.message?.content) {
          for (const item of entry.message.content) {
            if (item.type === 'tool_use' && item.name) {
              tools.push({
                name: item.name,
                message: formatToolMessage(item.name, item.input || {}),
                timestamp: entry.timestamp || '',
              });
            }
          }
        }
      } catch { continue; }
    }

    result.push({
      exchange_index: e,
      tools,
      tool_count: tools.length,
    });
  }

  return result;
}

/**
 * GET /api/chat-messages/[project]/activities?session=holler-homestead--mobile-app
 *
 * Returns per-exchange tool activity for the full conversation.
 * Each exchange_index aligns with the exchanges array from the chat-messages endpoint.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ project: string }> }
) {
  await context.params; // consume params
  const { searchParams } = new URL(request.url);
  const sessionName = searchParams.get('session');

  if (!sessionName) {
    return NextResponse.json({ error: 'Session name required' }, { status: 400 });
  }

  // Read is_working from hook activity file
  const activityFile = `/tmp/claude-session-${sessionName}-activity.json`;
  let isWorking = false;
  let currentTool: string | null = null;

  if (existsSync(activityFile)) {
    try {
      const hookData = JSON.parse(await readFile(activityFile, 'utf-8'));
      isWorking = hookData.is_working || false;
      currentTool = hookData.current_tool || null;
    } catch { /* ignore */ }
  }

  // Extract project path from session name
  const match = sessionName.match(/^holler-(.+?)(?:--(.+))?$/);
  if (!match) {
    return NextResponse.json({
      exchanges: [],
      is_working: isWorking,
      current_tool: currentTool,
    });
  }

  const projectName = match[1];
  const branchName = match[2];
  const cwd = branchName
    ? `<<REPLACE: your home dir, e.g. /Users/you>>/.worktrees/${projectName}/${branchName}`
    : `<<REPLACE: your home dir, e.g. /Users/you>>/code/${projectName}`;
  const projectDir = cwdToProjectDir(cwd);

  const transcriptPath = await findLatestTranscript(projectDir);
  if (!transcriptPath) {
    return NextResponse.json({
      exchanges: [],
      is_working: isWorking,
      current_tool: currentTool,
    });
  }

  try {
    const allActivities = await parseAllExchangeActivities(transcriptPath);

    // The chat-messages API returns the last 100 exchanges from conversation.json.
    // The transcript may have more exchanges if the conversation file was reset.
    // Return the last 100 to match.
    const recent = allActivities.slice(-100);

    return NextResponse.json({
      exchanges: recent,
      is_working: isWorking,
      current_tool: currentTool,
    });
  } catch (err) {
    console.error('[Activities] Error parsing transcript:', err);
    return NextResponse.json({
      exchanges: [],
      is_working: isWorking,
      current_tool: currentTool,
    }, { status: 500 });
  }
}
