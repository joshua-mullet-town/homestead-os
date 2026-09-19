import { NextRequest } from 'next/server';
import { findSessionFile, readSessionMessages, watchSessionFile } from '@/lib/claude-session';

/**
 * GET /api/claude-messages/[sessionId]?projectPath=/path/to/project
 *
 * Streams Claude Code messages from the .jsonl session file
 * Returns all existing messages, then watches for new ones
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  const params = await context.params;
  const sessionId = params.sessionId;
  const { searchParams } = new URL(request.url);
  const projectPath = searchParams.get('projectPath') || '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead';

  console.log('[ClaudeMessages] Request for session:', sessionId, 'project:', projectPath);

  // Find the .jsonl file for this session
  const filePath = findSessionFile(projectPath, sessionId);

  if (!filePath) {
    return new Response(
      JSON.stringify({ error: 'Session file not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Set up Server-Sent Events
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      console.log('[ClaudeMessages] Starting stream for:', sessionId);

      // Send all existing messages
      const messages = readSessionMessages(filePath);
      console.log('[ClaudeMessages] Found', messages.length, 'existing messages');

      for (const msg of messages) {
        const data = `data: ${JSON.stringify(msg)}\n\n`;
        controller.enqueue(encoder.encode(data));
      }

      // Watch for new messages
      const stopWatching = watchSessionFile(filePath, (newMessage) => {
        console.log('[ClaudeMessages] New message:', newMessage.type);
        const data = `data: ${JSON.stringify(newMessage)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch (err) {
          console.error('[ClaudeMessages] Error sending message:', err);
        }
      });

      // Clean up on disconnect
      request.signal.addEventListener('abort', () => {
        console.log('[ClaudeMessages] Client disconnected');
        stopWatching();
        controller.close();
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
