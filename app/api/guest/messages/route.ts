import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_FILE = join(homedir(), '.homestead', 'guests.json');

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { owner: '', guests: [] };
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

interface SharedSession {
  sessionName: string;
  sessionDir: string;
}

interface PersonalSession {
  name: string;
  sessionName: string;
  sessionDir: string;
}

interface Guest {
  login: string;
  name: string;
  shortName: string;
  sharedSession: SharedSession;
  personalSessions: PersonalSession[];
  enabled: boolean;
  sessionName?: string;
}

interface Exchange {
  user: string;
  assistant: string | null;
}

interface ConversationData {
  exchanges: Exchange[];
  session_id?: string;
  project_name?: string;
}

interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sender?: 'owner' | 'guest' | 'claude';
  senderName?: string;
}

/** Parse [Name]: prefix from user messages in shared sessions */
function parseAttribution(content: string, guestName: string, ownerName: string): { content: string; sender: 'owner' | 'guest'; senderName: string } | null {
  const match = content.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/);
  if (!match) return null;

  const name = match[1];
  const cleanContent = match[2];

  if (name === guestName) {
    return { content: cleanContent, sender: 'guest', senderName: name };
  }
  // Any other name is treated as owner
  return { content: cleanContent, sender: 'owner', senderName: name };
}

/** GET /api/guest/messages — returns chat messages for the guest's session */
export async function GET(request: NextRequest) {
  const tsLogin = request.headers.get('tailscale-user-login');
  if (!tsLogin) {
    return NextResponse.json({ messages: [], error: 'Not authenticated' }, { status: 401 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === tsLogin && g.enabled);
  if (!guest) {
    return NextResponse.json({ messages: [], error: 'Access denied' }, { status: 403 });
  }

  // Determine which session to read
  const { searchParams } = new URL(request.url);
  const sessionParam = searchParams.get('session');

  let targetSessionName: string;
  let isSharedSession: boolean;

  if (sessionParam && sessionParam !== 'shared') {
    const personalSession = (guest.personalSessions || []).find((s: PersonalSession) => s.name === sessionParam);
    if (!personalSession) {
      return NextResponse.json({ messages: [], error: 'Personal session not found' }, { status: 404 });
    }
    targetSessionName = personalSession.sessionName;
    isSharedSession = false;
  } else {
    targetSessionName = guest.sharedSession?.sessionName || guest.sessionName || '';
    isSharedSession = true;
  }

  // Read conversation file
  const conversationFile = `/tmp/claude-session-${targetSessionName}-conversation.json`;

  if (!existsSync(conversationFile)) {
    return NextResponse.json({
      messages: [],
      sessionName: targetSessionName,
    });
  }

  // Derive owner name from config
  const ownerLogin = config.owner || '';
  const ownerLocal = ownerLogin.split('@')[0] || 'Josh';
  const ownerName = ownerLocal.charAt(0).toUpperCase() + ownerLocal.slice(1);

  try {
    const content = await readFile(conversationFile, 'utf-8');
    const data: ConversationData = JSON.parse(content);

    const recentExchanges = data.exchanges.slice(-100);
    const messages: ParsedMessage[] = recentExchanges
      .filter(ex => ex.user || ex.assistant)
      .flatMap((ex, i) => {
        const result: ParsedMessage[] = [];

        if (ex.user) {
          const msg: ParsedMessage = { id: `user-${i}`, role: 'user', content: ex.user };

          if (isSharedSession) {
            // Try to parse [Name]: prefix
            const attribution = parseAttribution(ex.user, guest.name, ownerName);
            if (attribution) {
              msg.content = attribution.content;
              msg.sender = attribution.sender;
              msg.senderName = attribution.senderName;
            } else {
              // No prefix — default to guest (backwards compat for pre-attribution messages)
              msg.sender = 'guest';
              msg.senderName = guest.name;
            }
          }

          result.push(msg);
        }
        if (ex.assistant) {
          const msg: ParsedMessage = { id: `assistant-${i}`, role: 'assistant', content: ex.assistant };
          if (isSharedSession) {
            msg.sender = 'claude';
            msg.senderName = 'Claude';
          }
          result.push(msg);
        }
        return result;
      });

    return NextResponse.json({
      messages,
      sessionName: targetSessionName,
      ownerName,
    });
  } catch (err) {
    console.error('[GuestMessages] Error:', err);
    return NextResponse.json({ messages: [], error: 'Failed to read conversation' }, { status: 500 });
  }
}
