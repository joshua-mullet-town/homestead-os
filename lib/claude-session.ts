/**
 * Helper to find and read Claude Code session .jsonl files
 *
 * Claude stores conversation history in:
 * ~/.claude/projects/{project-path-encoded}/{sessionId}.jsonl
 *
 * Each line is a JSON object representing a message, tool call, or file snapshot.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ClaudeMessage {
  type: 'user' | 'assistant' | string;
  message: {
    role: 'user' | 'assistant';
    content: any;
  };
  sessionId: string;
  uuid: string;
  timestamp: string;
  cwd?: string;
}

/**
 * Get the encoded project directory name that Claude uses
 * Example: /Users/josh/code/homestead → -Users-josh-code-homestead
 */
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
}

/**
 * Find the .jsonl file for a given Claude session
 * Returns the file path if found, null otherwise
 */
export function findSessionFile(projectPath: string, sessionId: string): string | null {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const encodedPath = encodeProjectPath(projectPath);
  const projectDir = path.join(claudeDir, encodedPath);

  if (!fs.existsSync(projectDir)) {
    console.log(`[ClaudeSession] Project directory not found: ${projectDir}`);
    return null;
  }

  // Look for the sessionId in any .jsonl file in the project directory
  const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(projectDir, file);
    try {
      // Read first line to check if this file contains our session
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes(`"sessionId":"${sessionId}"`)) {
        console.log(`[ClaudeSession] Found session file: ${filePath}`);
        return filePath;
      }
    } catch (err) {
      // Skip files we can't read
      continue;
    }
  }

  console.log(`[ClaudeSession] No file found for session: ${sessionId}`);
  return null;
}

/**
 * Read all messages from a Claude session file
 * Filters to show only user and assistant messages (hides tool calls)
 */
export function readSessionMessages(filePath: string): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);

        // Only include user and assistant messages (skip file-history, tool calls, etc.)
        if ((msg.type === 'user' || msg.type === 'assistant') && msg.message) {
          messages.push(msg);
        }
      } catch (err) {
        // Skip malformed lines
        continue;
      }
    }
  } catch (err) {
    console.error('[ClaudeSession] Error reading session file:', err);
  }

  return messages;
}

/**
 * Watch a session file for new messages
 * Calls callback whenever a new message is added
 */
export function watchSessionFile(
  filePath: string,
  callback: (message: ClaudeMessage) => void
): () => void {
  let lastSize = 0;

  try {
    lastSize = fs.statSync(filePath).size;
  } catch (err) {
    console.error('[ClaudeSession] Error getting initial file size:', err);
  }

  const watcher = fs.watch(filePath, (eventType) => {
    if (eventType === 'change') {
      try {
        const currentSize = fs.statSync(filePath).size;

        if (currentSize > lastSize) {
          // File grew, read the new content
          const stream = fs.createReadStream(filePath, {
            start: lastSize,
            end: currentSize
          });

          let buffer = '';
          stream.on('data', (chunk) => {
            buffer += chunk.toString();
          });

          stream.on('end', () => {
            const lines = buffer.split('\n').filter(line => line.trim());

            for (const line of lines) {
              try {
                const msg = JSON.parse(line);

                // Only emit user/assistant messages
                if ((msg.type === 'user' || msg.type === 'assistant') && msg.message) {
                  callback(msg);
                }
              } catch (err) {
                // Skip malformed lines
              }
            }

            lastSize = currentSize;
          });
        }
      } catch (err) {
        console.error('[ClaudeSession] Error reading file changes:', err);
      }
    }
  });

  // Return cleanup function
  return () => watcher.close();
}
