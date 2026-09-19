/**
 * Persistent Job Scheduler
 *
 * Stores scheduled jobs in a JSON file and uses node-schedule for execution.
 * Jobs survive server restarts by rehydrating from the JSON file on startup.
 */

const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

// Path to the persistent jobs file
const JOBS_FILE = path.join(process.cwd(), 'scheduled-jobs.json');

// In-memory map of active job instances
const activeJobs = new Map();

/**
 * Load jobs from the JSON file
 */
function loadJobs() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const data = fs.readFileSync(JOBS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Scheduler] Error loading jobs:', err.message);
  }
  return { jobs: [] };
}

/**
 * Save jobs to the JSON file
 */
function saveJobs(data) {
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Scheduler] Error saving jobs:', err.message);
  }
}

/**
 * Execute a job - sends push notification
 * Calls the global pushNotification function directly (injected by server.js)
 */
function executeJob(job) {
  console.log(`[Scheduler] Executing job ${job.id}: ${job.title}`);

  // The server injects the sendPushNotification function
  if (global.sendPushNotification) {
    global.sendPushNotification({
      title: job.title,
      body: job.body,
      data: job.data || {},
    })
      .then((result) => {
        console.log(`[Scheduler] Notification sent for job ${job.id}:`, result);
      })
      .catch((err) => {
        console.error(`[Scheduler] Error sending notification for job ${job.id}:`, err.message);
      });
  } else {
    console.error(`[Scheduler] sendPushNotification not available for job ${job.id}`);
  }

  // Remove the job from persistence (it's completed)
  removeJob(job.id);
}

/**
 * Schedule a job using node-schedule
 */
function scheduleJob(job) {
  const fireAt = new Date(job.fires_at);

  // If the job's fire time has already passed, execute immediately
  if (fireAt <= new Date()) {
    console.log(`[Scheduler] Job ${job.id} fire time has passed, executing now`);
    executeJob(job);
    return null;
  }

  console.log(`[Scheduler] Scheduling job ${job.id} for ${fireAt.toISOString()}`);

  const scheduledJob = schedule.scheduleJob(fireAt, () => {
    executeJob(job);
    activeJobs.delete(job.id);
  });

  return scheduledJob;
}

/**
 * Add a new scheduled job
 */
function addJob({ delaySeconds, title, body, data }) {
  const id = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date();
  const firesAt = new Date(now.getTime() + delaySeconds * 1000);

  const job = {
    id,
    title,
    body,
    data: data || {},
    created_at: now.toISOString(),
    fires_at: firesAt.toISOString(),
  };

  // Save to persistent storage
  const jobsData = loadJobs();
  jobsData.jobs.push(job);
  saveJobs(jobsData);

  // Schedule the job in memory
  const scheduledJob = scheduleJob(job);
  if (scheduledJob) {
    activeJobs.set(id, scheduledJob);
  }

  console.log(`[Scheduler] Added job ${id}, fires at ${firesAt.toISOString()}`);

  return {
    id,
    fires_at: firesAt.toISOString(),
    status: 'scheduled',
  };
}

/**
 * Remove a job (cancel it)
 */
function removeJob(id) {
  // Cancel the in-memory job
  const scheduledJob = activeJobs.get(id);
  if (scheduledJob) {
    scheduledJob.cancel();
    activeJobs.delete(id);
  }

  // Remove from persistent storage
  const jobsData = loadJobs();
  jobsData.jobs = jobsData.jobs.filter(j => j.id !== id);
  saveJobs(jobsData);

  console.log(`[Scheduler] Removed job ${id}`);
  return true;
}

/**
 * Get all scheduled jobs
 */
function listJobs() {
  const jobsData = loadJobs();
  return jobsData.jobs;
}

/**
 * Initialize the scheduler - rehydrate jobs from persistent storage
 */
function initialize() {
  console.log('[Scheduler] Initializing...');

  const jobsData = loadJobs();
  const now = new Date();
  let rehydrated = 0;
  let expired = 0;

  for (const job of jobsData.jobs) {
    const fireAt = new Date(job.fires_at);

    if (fireAt <= now) {
      // Job expired while server was down - execute it now
      console.log(`[Scheduler] Job ${job.id} expired, executing now`);
      executeJob(job);
      expired++;
    } else {
      // Schedule the job
      const scheduledJob = scheduleJob(job);
      if (scheduledJob) {
        activeJobs.set(job.id, scheduledJob);
        rehydrated++;
      }
    }
  }

  console.log(`[Scheduler] Initialized: ${rehydrated} jobs rehydrated, ${expired} expired jobs executed`);

  // Start the investigation scheduler - runs every 2 minutes
  startInvestigationScheduler();
}

/**
 * Investigation scheduler - checks for pending alerts and spawns investigators
 */
let investigationInterval = null;

function startInvestigationScheduler() {
  console.log('[Scheduler] Starting investigation scheduler (every 2 minutes)');

  // Run immediately on startup
  runInvestigationCheck();

  // Then run every 2 minutes
  investigationInterval = setInterval(runInvestigationCheck, 2 * 60 * 1000);
}

async function runInvestigationCheck() {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  const ALERTS_FILE = path.join(process.cwd(), 'data', 'alerts.json');
  const CODE_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code';
  const HOMESTEAD_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead';
  const CLAUDE_PATH = '<<REPLACE: your home dir, e.g. /Users/you>>/.nvm/versions/node/v20.19.3/bin/claude';

  function loadAlerts() {
    if (fs.existsSync(ALERTS_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8'));
      } catch {
        return { alerts: [] };
      }
    }
    return { alerts: [] };
  }

  function saveAlerts(data) {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(data, null, 2));
  }

  function shortId(id) {
    const clean = id.replace(/[^a-z0-9-]/gi, '');
    if (clean.length <= 12) return clean;
    return clean.slice(0, 12);
  }

  async function sessionExists(sessionName) {
    try {
      await execAsync(`tmux has-session -t "${sessionName}"`);
      return true;
    } catch {
      return false;
    }
  }

  console.log('[Investigation] Checking for pending investigations...');

  const data = loadAlerts();

  // Don't start a new investigation if one is already running
  const activeInvestigation = data.alerts.find(a => a.status === 'investigating');
  if (activeInvestigation) {
    // Verify the session still exists
    if (activeInvestigation.session_id && !(await sessionExists(activeInvestigation.session_id))) {
      console.log(`[Investigation] Session ${activeInvestigation.session_id} no longer exists, marking alert for re-investigation`);
      const idx = data.alerts.findIndex(a => a.id === activeInvestigation.id);
      data.alerts[idx].status = 'pending_investigation';
      data.alerts[idx].session_id = null;
      saveAlerts(data);
    } else {
      console.log('[Investigation] An investigation is already in progress, skipping');
      return;
    }
  }

  // Find the first alert pending investigation
  const pendingAlert = data.alerts.find(a => a.status === 'pending_investigation');

  if (!pendingAlert) {
    console.log('[Investigation] No alerts pending investigation');
    return;
  }

  console.log(`[Investigation] Found pending alert: ${pendingAlert.title}`);

  // Build the investigator prompt
  const lines = [
    `You are investigating an alert. Research it and determine what action is needed.`,
    ``,
    `## Alert: ${pendingAlert.title}`,
    `**Urgency:** ${pendingAlert.urgency}`,
    `**Source:** ${pendingAlert.source}`,
  ];

  if (pendingAlert.context) lines.push(`**Context:** ${pendingAlert.context}`);
  if (pendingAlert.deadline) lines.push(`**Deadline:** ${pendingAlert.deadline}`);
  if (pendingAlert.details) lines.push(``, `**Details:**`, pendingAlert.details);
  if (pendingAlert.suggested_action) lines.push(``, `**Suggested Action:**`, pendingAlert.suggested_action);

  lines.push(
    ``,
    `## Service Account Authentication`,
    `You have access to service account credentials for headless authentication.`,
    `Before using Firebase or gcloud commands, set the credentials:`,
    ``,
    `For GiveGrove (bidbyte-vue-e290f):`,
    `  export GOOGLE_APPLICATION_CREDENTIALS=~/.config/homestead/service-accounts/givegrove.json`,
    ``,
    `For Mullet Town:`,
    `  export GOOGLE_APPLICATION_CREDENTIALS=~/.config/homestead/service-accounts/mullet-town.json`,
    ``,
    `Then use Firebase Admin SDK or gcloud with --impersonate-service-account flag.`,
    ``,
    `If auth still fails after setting credentials:`,
    `- Complete your investigation with what you CAN find (local files, configs, etc)`,
    `- Include "AUTH_NEEDED" in your findings so Josh can investigate`,
    ``,
    `## Your Task`,
    `1. Research this alert using LOCAL resources first (files, configs, git history)`,
    `2. Only try external services if needed, and fail gracefully if auth is broken`,
    `3. When done, update the alert with your findings:`,
    ``,
    `curl -X PATCH http://localhost:3005/api/alerts/${pendingAlert.id} -H "Content-Type: application/json" -d '{"action":"complete_investigation","findings":"Your findings here","recommendation":"What Josh should do"}'`,
    ``,
    `4. Then notify Josh:`,
    ``,
    `curl -X POST http://localhost:3005/api/push/send -H "Content-Type: application/json" -d '{"title":"${pendingAlert.title.replace(/"/g, '\\"')}","body":"Brief recommendation","requireInteraction":true}'`,
    ``,
    `Start investigating now. Be efficient - complete within 2-3 minutes.`
  );

  const investigatorPrompt = lines.join('\n');
  const sessionName = `alert-${shortId(pendingAlert.id)}`;

  // Check if session already exists
  if (await sessionExists(sessionName)) {
    console.log(`[Investigation] Session ${sessionName} already exists`);
    const idx = data.alerts.findIndex(a => a.id === pendingAlert.id);
    data.alerts[idx].status = 'investigating';
    data.alerts[idx].session_id = sessionName;
    saveAlerts(data);
    return;
  }

  try {
    // Build --add-dir flags
    const { stdout: dirList } = await execAsync(`ls -d ${CODE_DIR}/*/`).catch(() => ({ stdout: '' }));
    const addDirFlags = dirList
      .trim()
      .split('\n')
      .filter(d => d && !d.includes('node_modules'))
      .map(d => `--add-dir "${d.replace(/\/$/, '')}"`)
      .join(' ');

    // Use permission flags that don't require interactive confirmation
    const baseFlags = `--dangerously-skip-permissions --permission-mode bypassPermissions ${addDirFlags}`;

    // Create tmux session with proper escaping - use single quotes for the command
    // and escape any single quotes in the path
    const claudeCommand = `${CLAUDE_PATH} ${baseFlags}`;
    await execAsync(`tmux new-session -d -s "${sessionName}" -c "${HOMESTEAD_DIR}" 'bash -c "${claudeCommand}; exec zsh"'`);

    // Wait for Claude to start and show permission prompt
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Accept the permissions prompt (sends Enter)
    await execAsync(`tmux send-keys -t "${sessionName}" Enter`);

    // Wait for Claude to fully initialize after accepting permissions
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Send the investigator prompt
    const escapedMessage = investigatorPrompt
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');

    await execAsync(`tmux send-keys -t "${sessionName}" "${escapedMessage}" Enter`);

    // Update alert status
    const idx = data.alerts.findIndex(a => a.id === pendingAlert.id);
    data.alerts[idx].status = 'investigating';
    data.alerts[idx].session_id = sessionName;
    saveAlerts(data);

    console.log(`[Investigation] Spawned investigator session: ${sessionName}`);
  } catch (error) {
    console.error(`[Investigation] Failed to spawn session:`, error.message);
  }
}

/**
 * Shutdown the scheduler - cancel all jobs
 */
function shutdown() {
  console.log('[Scheduler] Shutting down...');
  for (const [id, job] of activeJobs) {
    job.cancel();
  }
  activeJobs.clear();
}

module.exports = {
  initialize,
  shutdown,
  addJob,
  removeJob,
  listJobs,
};
