import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const HOMESTEAD_DIR = process.cwd();
const TRIAGE_PROMPT = path.join(HOMESTEAD_DIR, 'prompts/notification-triage.md');
const STAKEHOLDERS_DIR = path.join(os.homedir(), '.homestead/notification-agents/stakeholders');
const TRIAGE_REGISTRY_FILE = '/tmp/notification-triage-workers.json';
const LOG_DIR = '/tmp/notification-triage-logs';

interface TriageWorker {
  sessionName: string;
  status: string;
  decision?: string;
  note?: string;
  notification: {
    appName: string;
    title: string | null;
    text: string | null;
    timestamp: number;
  };
  startedAt: number;
}

interface TriageRegistry {
  workers: Record<string, TriageWorker>;
}

interface NotificationData {
  key: string;
  appName: string;
  packageName: string;
  title: string | null;
  text: string | null;
  bigText: string | null;
  timestamp: number;
  isOngoing: boolean;
  category: string | null;
  actions?: string[];
}

function loadTriageRegistry(): TriageRegistry {
  try {
    if (fs.existsSync(TRIAGE_REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(TRIAGE_REGISTRY_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[NotificationTriage] Error loading registry:', err);
  }
  return { workers: {} };
}

function saveTriageRegistry(registry: TriageRegistry): void {
  try {
    fs.writeFileSync(TRIAGE_REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (err) {
    console.error('[NotificationTriage] Error saving registry:', err);
  }
}

function loadStakeholderProfiles(): Array<{ name: string; content: string }> {
  const profiles: Array<{ name: string; content: string }> = [];

  if (!fs.existsSync(STAKEHOLDERS_DIR)) {
    return profiles;
  }

  try {
    const files = fs.readdirSync(STAKEHOLDERS_DIR);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const filePath = path.join(STAKEHOLDERS_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        profiles.push({
          name: file.replace('.md', ''),
          content
        });
      }
    }
  } catch (err) {
    console.error('[NotificationTriage] Error loading stakeholder profiles:', err);
  }

  return profiles;
}

function formatNotification(notification: NotificationData): string {
  return `
**App:** ${notification.appName} (${notification.packageName})
**Title:** ${notification.title || '(no title)'}
**Text:** ${notification.text || notification.bigText || '(no text)'}
**Time:** ${new Date(notification.timestamp).toLocaleString()}
**Is Ongoing:** ${notification.isOngoing ? 'Yes' : 'No'}
**Category:** ${notification.category || 'uncategorized'}
${notification.actions?.length ? `**Actions Available:** ${notification.actions.join(', ')}` : ''}
`.trim();
}

function buildTriagePrompt(notification: NotificationData, stakeholders: Array<{ name: string; content: string }>): string {
  let basePrompt = 'You are a notification triage agent. Assess this notification and decide how to handle it.';

  try {
    if (fs.existsSync(TRIAGE_PROMPT)) {
      basePrompt = fs.readFileSync(TRIAGE_PROMPT, 'utf-8');
    }
  } catch (err) {
    console.error('[NotificationTriage] Error reading triage prompt:', err);
  }

  const stakeholderSection = stakeholders.length > 0
    ? stakeholders.map(s => `### ${s.name}\n\n${s.content}`).join('\n\n---\n\n')
    : '(No stakeholder profiles defined yet)';

  let prompt = basePrompt
    .replace('{{NOTIFICATION}}', formatNotification(notification))
    .replace('{{STAKEHOLDERS}}', stakeholderSection);

  const safeKey = notification.key.replace(/[^a-zA-Z0-9]/g, '-');
  prompt += `

---

## Important

1. After making your decision, update the triage status by writing to: /tmp/notification-triage-${safeKey}.json
   Format: { "decision": "ATTACH|CATEGORIZE|FLAG", "note": "your brief note" }

2. If ATTACH: Continue investigating per the stakeholder instructions, then update status when done.

3. If CATEGORIZE or FLAG: Write the status file and stop working (say "Triage complete").

4. The notification key for this notification is: ${notification.key}
`;

  return prompt;
}

async function spawnTriageWorker(notification: NotificationData): Promise<{ success: boolean; sessionName?: string; error?: string }> {
  const notifKey = notification.key;
  const safeKey = notifKey.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '');
  const sessionName = `triage-${Date.now()}-${safeKey}`;

  const stakeholders = loadStakeholderProfiles();
  const prompt = buildTriagePrompt(notification, stakeholders);

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    // Create tmux session
    await execAsync(`tmux new-session -d -s "${sessionName}" -c "${HOMESTEAD_DIR}"`);

    // Register in triage registry
    const registry = loadTriageRegistry();
    registry.workers[notifKey] = {
      sessionName,
      status: 'triaging',
      notification: {
        appName: notification.appName,
        title: notification.title,
        text: notification.text || notification.bigText,
        timestamp: notification.timestamp
      },
      startedAt: Date.now()
    };
    saveTriageRegistry(registry);

    // Write prompt to file
    const promptFile = `/tmp/${sessionName}-prompt.txt`;
    fs.writeFileSync(promptFile, prompt);

    // Start Claude Code
    const bootstrapPrompt = `Read ${promptFile} and follow those instructions exactly.`;
    const escapedBootstrap = bootstrapPrompt.replace(/'/g, "'\\''");
    await execAsync(`tmux send-keys -t "${sessionName}" 'CLAUDECODE= claude --dangerously-skip-permissions "${escapedBootstrap}"' Enter`);

    return { success: true, sessionName };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error('[NotificationTriage] Spawn error:', errorMessage);

    // Cleanup on failure
    try {
      await execAsync(`tmux kill-session -t "${sessionName}" 2>/dev/null || true`);
      const registry = loadTriageRegistry();
      delete registry.workers[notifKey];
      saveTriageRegistry(registry);
    } catch { /* ignore */ }

    return { success: false, error: errorMessage };
  }
}

function getTriageStatus(notificationKey: string): TriageWorker | null {
  const registry = loadTriageRegistry();
  const worker = registry.workers[notificationKey];

  if (!worker) {
    return null;
  }

  // Check for status file from worker
  const safeKey = notificationKey.replace(/[^a-zA-Z0-9]/g, '-');
  const statusFile = `/tmp/notification-triage-${safeKey}.json`;

  if (fs.existsSync(statusFile)) {
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
      return {
        ...worker,
        decision: status.decision,
        note: status.note,
        status: status.decision === 'ATTACH' ? 'investigating' : 'done'
      };
    } catch { /* ignore */ }
  }

  return worker;
}

async function killTriageWorker(notificationKey: string): Promise<{ success: boolean; error?: string }> {
  const registry = loadTriageRegistry();
  const worker = registry.workers[notificationKey];

  if (!worker) {
    return { success: false, error: 'Worker not found' };
  }

  try {
    await execAsync(`tmux kill-session -t "${worker.sessionName}" 2>/dev/null || true`);
    delete registry.workers[notificationKey];
    saveTriageRegistry(registry);
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

// GET - list all triage workers or get status for specific notification
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const notificationKey = searchParams.get('key');

  if (notificationKey) {
    const status = getTriageStatus(notificationKey);
    return NextResponse.json({ status });
  }

  const registry = loadTriageRegistry();
  return NextResponse.json({ workers: registry.workers });
}

// POST - spawn a triage worker for a notification
export async function POST(request: NextRequest) {
  try {
    const notification = await request.json() as NotificationData;

    if (!notification.key) {
      return NextResponse.json(
        { error: 'Notification must have a key' },
        { status: 400 }
      );
    }

    const existingStatus = getTriageStatus(notification.key);
    if (existingStatus) {
      return NextResponse.json({
        success: false,
        error: 'Triage worker already exists for this notification',
        existing: existingStatus
      });
    }

    const result = await spawnTriageWorker(notification);

    if (result.success) {
      return NextResponse.json({
        success: true,
        sessionName: result.sessionName,
        notificationKey: notification.key
      });
    } else {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }
  } catch (err) {
    console.error('[NotificationTriage] POST error:', err);
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400 }
    );
  }
}

// DELETE - kill a triage worker
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const notificationKey = searchParams.get('key');

  if (!notificationKey) {
    return NextResponse.json(
      { error: 'key parameter is required' },
      { status: 400 }
    );
  }

  const result = await killTriageWorker(notificationKey);

  if (result.success) {
    return NextResponse.json({ success: true });
  } else {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: 404 }
    );
  }
}
