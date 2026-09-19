import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pretrustWorkspace } = require('@/lib/pretrust-workspace');

const HOMESTEAD_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead';

export async function POST(request: NextRequest) {
  try {
    const { prompt } = await request.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Prompt is required' },
        { status: 400 }
      );
    }

    // Generate unique session name
    const timestamp = Date.now();
    const sessionName = `worker-${timestamp}`;

    // Build the worker prompt
    const workerPrompt = `You are an ephemeral worker spawned to perform a specific task on the Homestead codebase.

**Your Task:**
${prompt}

**Important Instructions:**
1. You are running in the Homestead codebase at ${HOMESTEAD_DIR}
2. Make the requested changes directly - edit files as needed
3. After making changes, run \`npm run build\` to verify they work
4. When done, output a brief summary of what you changed
5. Do NOT restart the server - the user will do that manually
6. Keep changes minimal and focused on the task
7. If you encounter issues, document them clearly

Start by understanding what's being asked, then make the changes.`;

    // Write prompt to temp file
    const promptFile = `/tmp/${sessionName}-prompt.txt`;
    fs.writeFileSync(promptFile, workerPrompt);

    // Pre-trust before launching. Claude Code gates a never-before-seen
    // directory behind "Is this a project you trust?" — which
    // --dangerously-skip-permissions does NOT suppress, and whose default is
    // "No, exit". Without this the spawn dies on launch and the prompt below
    // pastes into a dead pane. Non-fatal: on failure we still launch.
    pretrustWorkspace(HOMESTEAD_DIR);

    // Create tmux session in homestead directory
    await execAsync(`tmux new-session -d -s "${sessionName}" -c "${HOMESTEAD_DIR}"`);

    // Start Claude Code with the prompt
    const bootstrapPrompt = `Read ${promptFile} and follow those instructions exactly.`;
    const escapedBootstrap = bootstrapPrompt.replace(/'/g, "'\\''");
    await execAsync(`tmux send-keys -t "${sessionName}" 'CLAUDECODE= claude --dangerously-skip-permissions "${escapedBootstrap}"' Enter`);

    return NextResponse.json({
      success: true,
      sessionName,
      message: `Worker spawned in session ${sessionName}`
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error('[SpawnWorker] Error:', errorMessage);

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
