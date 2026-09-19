import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

interface Exchange {
  user: string;
  assistant: string | null;
}

interface ConversationData {
  cwd: string;
  session_id: string;
  project_name: string;
  tmux_session?: string;
  exchanges: Exchange[];
}

/**
 * GET /api/chat-messages/[project]?session=holler-homestead
 *
 * Returns chat messages from the hooks-generated conversation file.
 * Accepts optional `session` query param for tmux session name (preferred).
 * Falls back to project-based lookup for backwards compatibility.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ project: string }> }
) {
  const params = await context.params;
  const project = params.project;
  const { searchParams } = new URL(request.url);
  const sessionName = searchParams.get('session'); // e.g., "holler-homestead"

  // Try tmux-session-keyed file first (new format), then legacy project file
  const sessionFile = sessionName ? `/tmp/claude-session-${sessionName}-conversation.json` : null;
  const projectFile = `/tmp/claude-project-${project}-conversation.json`;

  let conversationFile: string | null = null;

  if (sessionFile && existsSync(sessionFile)) {
    conversationFile = sessionFile;
    console.log('[ChatMessages] Using session file:', sessionFile);
  } else if (existsSync(projectFile)) {
    conversationFile = projectFile;
    console.log('[ChatMessages] Using project file:', projectFile);
  }

  if (!conversationFile) {
    console.log('[ChatMessages] No conversation file found for session:', sessionName, 'project:', project);
    return NextResponse.json({
      messages: [],
      error: 'No conversation found. Start chatting with Claude to see messages here.'
    });
  }

  try {
    const content = await readFile(conversationFile, 'utf-8');
    const data: ConversationData = JSON.parse(content);

    // Convert exchanges to a simpler message format (limit to last 100 exchanges)
    const recentExchanges = data.exchanges.slice(-100);
    const messages = recentExchanges
      .filter(ex => ex.user || ex.assistant) // Skip empty exchanges
      .flatMap((ex, i) => {
        const result: Array<{
          id: string;
          role: 'user' | 'assistant';
          content: string;
          timestamp: string;
        }> = [];

        if (ex.user) {
          result.push({
            id: `user-${i}`,
            role: 'user',
            content: ex.user,
            timestamp: new Date().toISOString() // Hooks don't store timestamps, use now
          });
        }

        if (ex.assistant) {
          result.push({
            id: `assistant-${i}`,
            role: 'assistant',
            content: ex.assistant,
            timestamp: new Date().toISOString()
          });
        }

        return result;
      });

    return NextResponse.json({
      messages,
      sessionId: data.session_id,
      projectName: data.project_name,
      cwd: data.cwd
    });

  } catch (err) {
    console.error('[ChatMessages] Error reading conversation file:', err);
    return NextResponse.json({
      messages: [],
      error: 'Failed to read conversation'
    }, { status: 500 });
  }
}
