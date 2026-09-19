/**
 * Investigation Scheduler
 *
 * Checks for alerts with status 'pending_investigation' and spawns
 * investigator sessions one at a time.
 *
 * Run via: npx ts-node lib/investigation-scheduler.ts
 * Or integrate into server.js as a periodic job
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

const ALERTS_FILE = join(process.cwd(), 'data', 'alerts.json');
const CODE_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code';
const HOMESTEAD_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead';
const CLAUDE_PATH = '<<REPLACE: your home dir, e.g. /Users/you>>/.nvm/versions/node/v20.19.3/bin/claude';

interface Alert {
  id: string;
  source: string;
  urgency: string;
  title: string;
  context: string;
  details: string;
  suggested_action: string;
  deadline: string | null;
  created_at: string;
  status: string;
  snoozed_until: string | null;
  snooze_count: number;
  session_id: string | null;
  findings: string | null;
  recommendation: string | null;
  investigated_at: string | null;
}

interface AlertsData {
  alerts: Alert[];
}

function loadAlerts(): AlertsData {
  if (existsSync(ALERTS_FILE)) {
    try {
      return JSON.parse(readFileSync(ALERTS_FILE, 'utf-8'));
    } catch {
      return { alerts: [] };
    }
  }
  return { alerts: [] };
}

function saveAlerts(data: AlertsData) {
  writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2));
}

function shortId(id: string): string {
  const clean = id.replace(/[^a-z0-9-]/gi, '');
  if (clean.length <= 12) return clean;
  return clean.slice(0, 12);
}

async function checkForActiveInvestigation(): Promise<boolean> {
  const data = loadAlerts();

  // Find alerts marked as investigating
  const investigatingAlerts = data.alerts.filter(a => a.status === 'investigating');

  if (investigatingAlerts.length === 0) {
    return false;
  }

  // Check if any of them actually have a running session
  for (const alert of investigatingAlerts) {
    if (alert.session_id && await sessionExists(alert.session_id)) {
      return true; // Found a real active investigation
    }
  }

  // All "investigating" alerts have no active session - clean them up
  // Reset them to pending so they can be re-investigated
  let needsSave = false;
  for (const alert of investigatingAlerts) {
    const alertIndex = data.alerts.findIndex(a => a.id === alert.id);
    if (alertIndex >= 0 && !await sessionExists(alert.session_id || '')) {
      console.log(`[Scheduler] Resetting stale investigating alert: ${alert.id}`);
      data.alerts[alertIndex].status = 'pending_investigation';
      data.alerts[alertIndex].session_id = null;
      needsSave = true;
    }
  }

  if (needsSave) {
    saveAlerts(data);
  }

  return false;
}

async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t "${sessionName}"`);
    return true;
  } catch {
    return false;
  }
}

async function spawnInvestigator(alert: Alert): Promise<string | null> {
  const sessionName = `alert-${shortId(alert.id)}`;

  // Check if session already exists
  if (await sessionExists(sessionName)) {
    console.log(`[Scheduler] Session ${sessionName} already exists`);
    return sessionName;
  }

  // Build the investigator prompt
  const investigatorPrompt = buildInvestigatorPrompt(alert);

  // Skip --add-dir flags to keep the command simple - investigator can navigate as needed
  const baseFlags = `--dangerously-skip-permissions --permission-mode bypassPermissions`;

  try {
    // 1. Create empty tmux session
    await execAsync(`tmux new-session -d -s "${sessionName}" -c "${HOMESTEAD_DIR}"`);

    // 2. Start Claude via send-keys
    await execAsync(`tmux send-keys -t "${sessionName}" '${CLAUDE_PATH} ${baseFlags}' Enter`);

    // 3. Wait for Claude to fully load (6 seconds)
    // Note: "bypass permissions on" in footer is just a status indicator, not a blocking prompt
    await new Promise(resolve => setTimeout(resolve, 6000));

    // 4. Send the investigator prompt (escape for double quotes in shell)
    const escapedPrompt = investigatorPrompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
    await execAsync(`tmux send-keys -t "${sessionName}" "${escapedPrompt}"`);

    // 5. Wait for paste to complete, then send Enter separately
    await new Promise(resolve => setTimeout(resolve, 1500));
    await execAsync(`tmux send-keys -t "${sessionName}" Enter`);

    console.log(`[Scheduler] Spawned investigator session: ${sessionName}`);
    return sessionName;
  } catch (error) {
    console.error(`[Scheduler] Failed to spawn session:`, error);
    return null;
  }
}

function buildInvestigatorPrompt(alert: Alert): string {
  const lines = [
    `# Alert Investigator`,
    ``,
    `You are an investigator session. Your job is to research an alert, determine if it's actually urgent, and report your findings.`,
    ``,
    `## Alert Details`,
    ``,
    `**Title:** ${alert.title}`,
    `**Source:** ${alert.source}`,
    `**Harvester Urgency:** ${alert.urgency}`,
  ];

  if (alert.context) {
    lines.push(`**Context:** ${alert.context}`);
  }

  if (alert.deadline) {
    lines.push(`**Deadline:** ${alert.deadline}`);
  }

  if (alert.details) {
    lines.push(``, `**Details:**`, alert.details);
  }

  if (alert.suggested_action) {
    lines.push(``, `**Suggested Action:**`, alert.suggested_action);
  }

  lines.push(
    ``,
    `---`,
    ``,
    `## Your Task`,
    ``,
    `### Step 1: Understand the Problem`,
    ``,
    `Go investigate. You have full access to:`,
    `- **All code repos** in ~/code/ (read files, check git history, etc.)`,
    `- **CLI tools** - firebase, gcloud, npm, git, curl, etc.`,
    `- **MCP tools** - Gmail, Slack, phone/SMS if needed`,
    `- **Web search** - look up docs, error messages, etc.`,
    ``,
    `Do whatever research is needed to understand:`,
    `- Is this actually a problem?`,
    `- How urgent is it really?`,
    `- What's the fix?`,
    ``,
    `### Step 2: Handle Auth if Needed`,
    ``,
    `For Firebase/gcloud, you may need service account credentials:`,
    ``,
    `\`\`\`bash`,
    `# GiveGrove`,
    `export GOOGLE_APPLICATION_CREDENTIALS=~/.config/homestead/service-accounts/givegrove.json`,
    ``,
    `# Mullet Town`,
    `export GOOGLE_APPLICATION_CREDENTIALS=~/.config/homestead/service-accounts/mullet-town.json`,
    ``,
    `# Crowne Vault`,
    `export GOOGLE_APPLICATION_CREDENTIALS=~/.config/homestead/service-accounts/crowne-vault.json`,
    `\`\`\``,
    ``,
    `If auth fails and you can't proceed, note "AUTH_BLOCKED" in your findings.`,
    ``,
    `### Step 3: Write Your Findings`,
    ``,
    `When you've completed your investigation, update the alert:`,
    ``,
    `\`\`\`bash`,
    `curl -X PATCH http://localhost:3005/api/alerts/${alert.id} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "action": "complete_investigation",`,
    `    "findings": "Your detailed findings here",`,
    `    "investigator_urgency": "urgent OR not_urgent",`,
    `    "recommendation": "Brief action recommendation for Josh"`,
    `  }'`,
    `\`\`\``,
    ``,
    `**Urgency assessment:**`,
    `- \`urgent\` = needs attention now, will notify Josh`,
    `- \`not_urgent\` = can wait, informational only`,
    ``,
    `### Step 4: Notify Josh (If Urgent)`,
    ``,
    `If you determined this is urgent OR if you handled something autonomously, send a push notification:`,
    ``,
    `\`\`\`bash`,
    `curl -X POST http://localhost:3005/api/push/send \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "title": "Alert: ${alert.title.replace(/"/g, '\\"')}",`,
    `    "body": "Your brief summary here",`,
    `    "data": {`,
    `      "url": "/alerts/${alert.id}",`,
    `      "alertId": "${alert.id}"`,
    `    }`,
    `  }'`,
    `\`\`\``,
    ``,
    `**When to notify:**`,
    `- You confirmed it's urgent and needs Josh's action`,
    `- You fixed something autonomously (let him know what you did)`,
    `- You're stuck and need help (auth issues, unclear requirements)`,
    ``,
    `**When NOT to notify:**`,
    `- It's a false alarm / not actually urgent`,
    `- It's informational and can wait until Josh checks in`,
    ``,
    `### Step 5: Autonomous Fixes (Use Judgment)`,
    ``,
    `**You CAN fix autonomously:**`,
    `- Rotate exposed API keys/secrets (store old value first)`,
    `- Clear obvious false positives`,
    `- Simple one-liner fixes with clear right answers`,
    ``,
    `**You should NOT fix autonomously:**`,
    `- Firebase/Firestore rules (design decisions)`,
    `- Deployments to production`,
    `- Anything requiring judgment on approach`,
    ``,
    `If you fix something, still notify Josh what you did.`,
    ``,
    `---`,
    ``,
    `## Important Notes`,
    ``,
    `- This is an ephemeral session focused on one issue`,
    `- Be thorough but efficient - don't go down rabbit holes`,
    `- Always update the alert API when done, even if findings are "nothing to do"`,
    `- Push notifications are the ONLY way to reach Josh - no emails, no Slack`,
    ``,
    `---`,
    ``,
    `## Start Now`,
    ``,
    `Begin your investigation. Check the relevant code, services, and context. Report back with findings.`
  );

  return lines.join('\\n');
}

/**
 * Spawn an investigator for a specific alert.
 * Called directly by the alert API when a new alert is created.
 * Returns the session ID if spawned, null if skipped (another investigation running).
 */
export async function spawnInvestigatorForAlert(alert: Alert): Promise<string | null> {
  // Don't start a new investigation if one is already running
  if (await checkForActiveInvestigation()) {
    console.log('[Investigator] Another investigation is in progress, queuing this one');
    return null;
  }

  console.log(`[Investigator] Spawning investigator for: ${alert.title}`);

  // Spawn the investigator session
  const sessionId = await spawnInvestigator(alert);

  if (sessionId) {
    // Update the alert with session ID and status
    const data = loadAlerts();
    const alertIndex = data.alerts.findIndex(a => a.id === alert.id);
    if (alertIndex >= 0) {
      data.alerts[alertIndex].status = 'investigating';
      data.alerts[alertIndex].session_id = sessionId;
      saveAlerts(data);
    }
    console.log(`[Investigator] Alert ${alert.id} is now being investigated`);
  }

  return sessionId;
}

/**
 * Run the scheduler to pick up any pending investigations.
 * This is a backup - normally investigations are spawned immediately when alerts are created.
 */
export async function runScheduler() {
  console.log('[Scheduler] Checking for pending investigations...');

  // Don't start a new investigation if one is already running
  if (await checkForActiveInvestigation()) {
    console.log('[Scheduler] An investigation is already in progress, skipping');
    return;
  }

  const data = loadAlerts();

  // Find the first alert pending investigation
  const pendingAlert = data.alerts.find(a => a.status === 'pending_investigation');

  if (!pendingAlert) {
    console.log('[Scheduler] No alerts pending investigation');
    return;
  }

  console.log(`[Scheduler] Found pending alert: ${pendingAlert.title}`);

  // Use the shared spawn function
  await spawnInvestigatorForAlert(pendingAlert);
}

// If run directly
import { fileURLToPath } from 'url';
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runScheduler().catch(console.error);
}
