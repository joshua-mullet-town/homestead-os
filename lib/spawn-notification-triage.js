#!/usr/bin/env node
/**
 * Notification Triage Worker Spawner
 *
 * Spawns an ephemeral worker to triage a notification.
 * The worker reads stakeholder profiles, decides how to handle the notification,
 * and either attaches for investigation or categorizes and exits.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { resolveClaudePath } = require('./claude-resolver');
const { emitSessionCreated, emitSessionDeleted } = require('./emit-session-event');
const { cleanupSessionFiles } = require('./cleanup-session-files');

const HOMESTEAD_DIR = path.resolve(__dirname, '..');
const TRIAGE_PROMPT = path.join(HOMESTEAD_DIR, 'prompts/notification-triage.md');
const STAKEHOLDERS_DIR = path.join(require('os').homedir(), '.homestead/notification-agents/stakeholders');
const TRIAGE_REGISTRY_FILE = '/tmp/notification-triage-workers.json';
const LOG_DIR = '/tmp/notification-triage-logs';

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] [NotifTriage] ${message}`;
  console.log(logLine);
  try {
    fs.appendFileSync('/tmp/notification-triage.log', logLine + '\n');
  } catch (e) { /* ignore */ }
}

/**
 * Load all stakeholder profiles
 */
function loadStakeholderProfiles() {
  const profiles = [];

  if (!fs.existsSync(STAKEHOLDERS_DIR)) {
    log(`Stakeholders directory not found: ${STAKEHOLDERS_DIR}`);
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
    log(`Loaded ${profiles.length} stakeholder profiles`);
  } catch (err) {
    log(`Error loading stakeholder profiles: ${err.message}`, 'ERROR');
  }

  return profiles;
}

/**
 * Load the triage workers registry
 */
function loadTriageRegistry() {
  try {
    if (fs.existsSync(TRIAGE_REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(TRIAGE_REGISTRY_FILE, 'utf-8'));
    }
  } catch (err) {
    log(`Error loading triage registry: ${err.message}`, 'ERROR');
  }
  return { workers: {} }; // notificationKey -> { sessionName, status, note, decision }
}

/**
 * Save the triage workers registry
 */
function saveTriageRegistry(registry) {
  try {
    fs.writeFileSync(TRIAGE_REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (err) {
    log(`Error saving triage registry: ${err.message}`, 'ERROR');
  }
}

/**
 * Format notification for the prompt
 */
function formatNotification(notification) {
  return `
**App:** ${notification.appName} (${notification.packageName})
**Title:** ${notification.title || '(no title)'}
**Text:** ${notification.text || notification.bigText || '(no text)'}
**Time:** ${new Date(notification.timestamp).toLocaleString()}
**Is Ongoing:** ${notification.isOngoing ? 'Yes' : 'No'}
**Category:** ${notification.category || 'uncategorized'}
${notification.actions?.length > 0 ? `**Actions Available:** ${notification.actions.join(', ')}` : ''}
`.trim();
}

/**
 * Build the full triage prompt
 */
function buildTriagePrompt(notification, stakeholders) {
  let basePrompt;
  try {
    basePrompt = fs.readFileSync(TRIAGE_PROMPT, 'utf-8');
  } catch (err) {
    log(`Error reading triage prompt: ${err.message}`, 'ERROR');
    basePrompt = 'You are a notification triage agent. Assess this notification and decide how to handle it.';
  }

  // Format stakeholder profiles
  const stakeholderSection = stakeholders.length > 0
    ? stakeholders.map(s => `### ${s.name}\n\n${s.content}`).join('\n\n---\n\n')
    : '(No stakeholder profiles defined yet)';

  // Replace placeholders
  let prompt = basePrompt
    .replace('{{NOTIFICATION}}', formatNotification(notification))
    .replace('{{STAKEHOLDERS}}', stakeholderSection);

  // Add final instructions
  prompt += `

---

## Important

1. After making your decision, update the triage status by writing to: /tmp/notification-triage-${notification.key.replace(/[^a-zA-Z0-9]/g, '-')}.json
   Format: { "decision": "ATTACH|CATEGORIZE|FLAG", "note": "your brief note" }

2. If ATTACH: Continue investigating per the stakeholder instructions, then update status when done.

3. If CATEGORIZE or FLAG: Write the status file and use /stop to exit.

4. The notification key for this notification is: ${notification.key}
`;

  return prompt;
}

/**
 * Spawn a triage worker for a notification
 */
function spawnTriageWorker(notification) {
  const notifKey = notification.key;
  const sessionName = `triage-${Date.now()}-${notifKey.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '')}`;

  log(`=== Spawning Triage Worker ===`);
  log(`Notification: ${notification.appName} - ${notification.title || '(no title)'}`);
  log(`Key: ${notifKey}`);
  log(`Session: ${sessionName}`);

  // Load stakeholders
  const stakeholders = loadStakeholderProfiles();

  // Build prompt
  const prompt = buildTriagePrompt(notification, stakeholders);
  log(`Prompt length: ${prompt.length} chars`);

  // Determine working directory (default to homestead)
  const cwd = HOMESTEAD_DIR;

  try {
    // Ensure log directory exists
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    // 1. Create tmux session
    log('Creating tmux session...');
    execSync(`tmux new-session -d -s "${sessionName}" -c "${cwd}"`, { stdio: 'pipe' });
    emitSessionCreated(sessionName);

    // 2. Register in triage registry
    log('Registering in triage registry...');
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

    // 3. Write prompt to file
    log('Writing prompt file...');
    const promptFile = `/tmp/${sessionName}-prompt.txt`;
    fs.writeFileSync(promptFile, prompt);

    // 4. Start Claude Code
    log('Starting Claude Code...');
    const bootstrapPrompt = `Read ${promptFile} and follow those instructions exactly.`;
    const escapedBootstrap = bootstrapPrompt.replace(/'/g, "'\\''");
    // Interpolate the ABSOLUTE resolved claude path — a bare `claude` token here
    // is re-resolved by the spawned shell via PATH, which grabs the stale
    // /opt/homebrew build under the launchd env → 404. See lib/claude-resolver.js.
    const claudeBin = resolveClaudePath();
    execSync(`tmux send-keys -t "${sessionName}" 'CLAUDECODE= ${claudeBin} --dangerously-skip-permissions "${escapedBootstrap}"' Enter`, { stdio: 'pipe' });

    log('Triage worker spawned successfully');

    return {
      success: true,
      sessionName,
      notificationKey: notifKey,
      logFile: path.join(LOG_DIR, `${sessionName}.log`)
    };

  } catch (err) {
    log(`ERROR: ${err.message}`, 'ERROR');

    // Cleanup on failure
    try {
      execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null || true`, { stdio: 'pipe' });
      emitSessionDeleted(sessionName);
      cleanupSessionFiles(sessionName);
      const registry = loadTriageRegistry();
      delete registry.workers[notifKey];
      saveTriageRegistry(registry);
    } catch (e) { /* ignore */ }

    return {
      success: false,
      error: err.message,
      notificationKey: notifKey
    };
  }
}

/**
 * Get triage status for a notification
 */
function getTriageStatus(notificationKey) {
  const registry = loadTriageRegistry();
  const worker = registry.workers[notificationKey];

  if (!worker) {
    return null;
  }

  // Check for status file from worker
  const statusFile = `/tmp/notification-triage-${notificationKey.replace(/[^a-zA-Z0-9]/g, '-')}.json`;
  if (fs.existsSync(statusFile)) {
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
      return {
        ...worker,
        decision: status.decision,
        note: status.note,
        status: status.decision === 'ATTACH' ? 'investigating' : 'done'
      };
    } catch (e) { /* ignore */ }
  }

  return worker;
}

/**
 * List all active triage workers
 */
function listTriageWorkers() {
  const registry = loadTriageRegistry();
  return registry.workers;
}

/**
 * Kill a triage worker
 */
function killTriageWorker(notificationKey) {
  const registry = loadTriageRegistry();
  const worker = registry.workers[notificationKey];

  if (!worker) {
    return { success: false, error: 'Worker not found' };
  }

  try {
    execSync(`tmux kill-session -t "${worker.sessionName}" 2>/dev/null || true`, { stdio: 'pipe' });
    emitSessionDeleted(worker.sessionName);
    cleanupSessionFiles(worker.sessionName);
    delete registry.workers[notificationKey];
    saveTriageRegistry(registry);
    log(`Killed triage worker for: ${notificationKey}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'list') {
    console.log(JSON.stringify(listTriageWorkers(), null, 2));
  } else if (cmd === 'status' && args[1]) {
    console.log(JSON.stringify(getTriageStatus(args[1]), null, 2));
  } else if (cmd === 'kill' && args[1]) {
    console.log(JSON.stringify(killTriageWorker(args[1]), null, 2));
  } else {
    console.log('Usage:');
    console.log('  node spawn-notification-triage.js list');
    console.log('  node spawn-notification-triage.js status <notification-key>');
    console.log('  node spawn-notification-triage.js kill <notification-key>');
    console.log('');
    console.log('This module is meant to be called from the API, not directly.');
  }
}

module.exports = {
  spawnTriageWorker,
  getTriageStatus,
  listTriageWorkers,
  killTriageWorker,
  loadTriageRegistry,
  TRIAGE_REGISTRY_FILE
};
