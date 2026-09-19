import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const HOMESTEAD_DIR = join(homedir(), '.homestead');
const CONFIG_FILE = join(HOMESTEAD_DIR, 'guests.json');

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { owner: '', guests: [] as Guest[] };
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

interface SharedSession {
  sessionName: string;
  sessionDir: string;
}

interface Project {
  name: string;
  path: string;
  description?: string;
}

interface Guest {
  login: string;
  name: string;
  shortName: string;
  sharedSession: SharedSession;
  projects?: Project[];
  [key: string]: unknown;
}

function getOwnerName(config: ReturnType<typeof loadConfig>): string {
  const ownerLogin = config.owner || '';
  const local = ownerLogin.split('@')[0] || 'Josh';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** POST /api/guest/restart-session — guest restarts their own shared session */
export async function POST(request: NextRequest) {
  const tsLogin = request.headers.get('tailscale-user-login');
  if (!tsLogin) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const config = loadConfig();
  const guest = config.guests.find((g: Guest) => g.login === tsLogin && g.enabled);
  if (!guest) {
    return NextResponse.json({ error: 'Guest not found or disabled' }, { status: 403 });
  }

  const sharedSession = guest.sharedSession;
  if (!sharedSession) {
    return NextResponse.json({ error: 'No shared session configured' }, { status: 400 });
  }

  // Kill existing session
  try {
    await execAsync(`tmux kill-session -t "${sharedSession.sessionName}" 2>/dev/null`);
  } catch {
    // Session might not be running
  }

  // Small delay for tmux cleanup
  await new Promise(resolve => setTimeout(resolve, 500));

  // Ensure session directory exists
  if (!existsSync(sharedSession.sessionDir)) {
    mkdirSync(sharedSession.sessionDir, { recursive: true });
  }

  // Rewrite CLAUDE.md
  const ownerName = getOwnerName(config);
  const projects: Project[] = guest.projects || [];

  let projectsSection = '';
  if (projects.length > 0) {
    projectsSection = `\n## ${guest.name}'s Projects\n\nYou have access to the following projects on behalf of ${guest.name}:\n\n`;
    for (const p of projects) {
      projectsSection += `### ${p.name}\n- **Path:** \`${p.path}\`\n`;
      if (p.description) {
        projectsSection += `- ${p.description}\n`;
      }
      const projectClaudeMd = join(p.path, 'CLAUDE.md');
      if (existsSync(projectClaudeMd)) {
        const content = readFileSync(projectClaudeMd, 'utf-8');
        projectsSection += `\n<details>\n<summary>Project Instructions (from ${p.name}/CLAUDE.md)</summary>\n\n${content}\n</details>\n`;
      }
      projectsSection += '\n';
    }
  }

  const journalDir = join(sharedSession.sessionDir, 'journal');
  if (!existsSync(journalDir)) {
    mkdirSync(journalDir, { recursive: true });
  }

  const claudeMd = `# Shared Assistant: ${guest.name} + ${ownerName}

You are a shared family assistant sitting in a conversation between two people. You can see everything they say to each other.

## The People
- **${ownerName}** (owner) — Messages prefixed with [${ownerName}]:
- **${guest.name}** (guest) — Messages prefixed with [${guest.name}]:

## Your Role

You are a **quiet assistant**. Most of the time, these two are just chatting with each other and you should stay out of the way. But when they need you, you jump in and help.

### When to stay silent
If neither person is directly asking you a question, requesting help, or mentioning you by name — respond with EXACTLY:
\`\`\`
---
\`\`\`
Nothing else. Just \`---\`. This tells the system you're listening but have nothing to add. The humans won't see this response.

### When to respond
Respond normally when:
- Someone asks a question directed at you (e.g., "Claude, what do you think?", "Hey Claude...", "Can you look up...")
- Someone asks you to do something (set an alarm, edit a file, look something up)
- Someone explicitly mentions you by name
- Both people seem stuck and you can genuinely help

When you DO respond, be concise, warm, and helpful. You know both of these people — address them by name.

## Journal

Keep a running journal at \`journal/log.md\` in this directory. Update it when interesting things come up:
- Important dates, preferences, or facts about either person
- Things they ask you to remember
- Context that might be useful later (e.g., "they're planning a trip to X")
- Decisions they've made together

Format:
\`\`\`markdown
## YYYY-MM-DD

- [${ownerName}] mentioned wanting to try that new Italian place
- [${guest.name}] has a dentist appointment next Tuesday
- They decided on pizza for dinner Friday
\`\`\`

## Background Work

When you're silent (\`---\`), you can still think about the conversation. If the discussion touches on something you could research or prepare for, make a note in your journal. For example:
- If they discuss dates → note them in the journal
- If they mention a restaurant → you could look it up next time you're asked
- If they talk about a project → review relevant files so you're ready to help

But do NOT respond with your findings unless asked. Just log them.
${projectsSection}`;
  writeFileSync(join(sharedSession.sessionDir, 'CLAUDE.md'), claudeMd);

  // Build --add-dir flags
  const addDirs = projects.map(p => `--add-dir "${p.path}"`).join(' ');

  // Spawn tmux session with Claude using --continue — shared sessions always start in guest session dir
  const claudeCommand = `claude --dangerously-skip-permissions ${addDirs} --continue; zsh`;
  try {
    await execAsync(`tmux new-session -d -s "${sharedSession.sessionName}" -c "${sharedSession.sessionDir}" "${claudeCommand}"`);
    return NextResponse.json({ success: true, sessionName: sharedSession.sessionName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to restart session: ${msg}` }, { status: 500 });
  }
}
