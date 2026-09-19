#!/usr/bin/env node
/**
 * Memory Harvester Trigger
 *
 * Runs periodically to check for new Claude Code session logs.
 * If found, spawns an ephemeral worker to harvest memories.
 *
 * Usage:
 *   node trigger-memory-harvester.js [minutes]
 *
 * Default: Last 15 minutes
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spawnWorker } = require('./spawn-worker');

// Derive HOMESTEAD_DIR from this file's location (lib/ is one level down)
const HOMESTEAD_DIR = path.resolve(__dirname, '..');
const SESSION_SCANNER = path.join(HOMESTEAD_DIR, 'lib/find-recent-sessions.js');
const HARVESTER_PROMPT = path.join(HOMESTEAD_DIR, 'prompts/memory-harvester.md');
const STATE_FILE = '/tmp/memory-harvester-state.json';
const LOG_FILE = '/tmp/memory-harvester.log';

// External source checkpoints (SMS removed - use Android app directly)
const ALL_EXTERNAL_SOURCES = ['gmail', 'slack-mullettown', 'slack-codeworks', 'slack-<<REPLACE: your-employer>>'];
const HEALTH_FILE = '/tmp/mcp-health.json';

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] [MemoryHarvester] ${message}`;
  console.log(logLine);

  // Also write to dedicated log file
  try {
    fs.appendFileSync(LOG_FILE, logLine + '\n');
  } catch (e) { /* ignore */ }
}

/**
 * Load harvester state (tracks last-harvested sessions)
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {
    lastHarvested: {},          // Claude session file paths -> timestamp (per-session unchanged-file dedup only)
    externalSources: {},        // source name -> { lastChecked: ISO timestamp }
    lastFullScanCompleted: null // ISO timestamp of last completed scan-sweep; load-bearing lookback floor
  };
}

/**
 * Save harvester state
 */
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { /* ignore */ }
}

// Hygiene: drop lastHarvested entries for paths that no longer exist on disk
// or whose value is older than this many days. Bounds state-file size and
// doesn't load-bear on the wedge fix (lookback floor is lastFullScanCompleted).
const HARVEST_ENTRY_MAX_AGE_DAYS = 14;

function pruneStaleHarvestEntries(state) {
  if (!state.lastHarvested) return;
  const cutoff = Date.now() - HARVEST_ENTRY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [p, ts] of Object.entries(state.lastHarvested)) {
    if (typeof ts !== 'number' || ts < cutoff || !fs.existsSync(p)) {
      delete state.lastHarvested[p];
      pruned++;
    }
  }
  if (pruned > 0) log(`Pruned ${pruned} stale lastHarvested entries`);
}

/**
 * Load MCP health state
 */
function loadHealth() {
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

/**
 * Save MCP health state
 */
function saveHealth(health) {
  try {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2));
  } catch (e) { /* ignore */ }
}

/**
 * Get healthy external sources based on tracked health state.
 *
 * Health is tracked by the worker itself - after each run, it reports which
 * sources responded vs timed out. Sources that fail get exponential backoff.
 *
 * To mark a source as failed, write to the health file:
 *   node -e "require('./lib/trigger-memory-harvester').markSourceFailed('slack-mullettown')"
 *
 * Or mark healthy:
 *   node -e "require('./lib/trigger-memory-harvester').markSourceHealthy('slack-mullettown')"
 */
function getHealthySources() {
  const health = loadHealth();
  const now = Date.now();
  const healthy = [];

  for (const source of ALL_EXTERNAL_SOURCES) {
    const entry = health[source];

    if (!entry) {
      // Never tracked - assume healthy, let the worker discover if broken
      healthy.push(source);
      continue;
    }

    if (entry.healthy) {
      healthy.push(source);
      continue;
    }

    // Unhealthy - check if it's time to retry
    if (now >= (entry.nextRetry || 0)) {
      log(`Retrying previously failed source: ${source} (failed ${entry.failCount || 1}x)`);
      healthy.push(source); // Give it another chance
    } else {
      const retryIn = Math.round(((entry.nextRetry || 0) - now) / 60000);
      log(`Skipping ${source} (failed ${entry.failCount || 1}x, retry in ${retryIn}m)`);
    }
  }

  log(`Healthy sources: [${healthy.join(', ')}] (of ${ALL_EXTERNAL_SOURCES.length} total)`);
  return healthy;
}

/**
 * Mark a source as failed with exponential backoff.
 * Called after a harvester run detects a timeout.
 */
function markSourceFailed(source) {
  const health = loadHealth();
  const entry = health[source] || { failCount: 0 };
  const failCount = (entry.failCount || 0) + 1;
  // Backoff: 10m, 20m, 40m, 60m, 60m...
  const backoffMinutes = Math.min(10 * Math.pow(2, failCount - 1), 60);

  health[source] = {
    healthy: false,
    failCount,
    lastFailed: Date.now(),
    nextRetry: Date.now() + backoffMinutes * 60000
  };
  saveHealth(health);
  log(`Marked ${source} as failed (count: ${failCount}, retry in ${backoffMinutes}m)`);
}

/**
 * Mark a source as healthy (reset failure tracking).
 */
function markSourceHealthy(source) {
  const health = loadHealth();
  health[source] = { healthy: true, failCount: 0 };
  saveHealth(health);
  log(`Marked ${source} as healthy`);
}

/**
 * Run the session scanner
 */
function findRecentSessions(minutes) {
  try {
    const output = execSync(`node "${SESSION_SCANNER}" ${minutes}`, {
      encoding: 'utf-8',
      cwd: HOMESTEAD_DIR
    });
    return JSON.parse(output);
  } catch (err) {
    log(`Error running session scanner: ${err.message}`);
    return { count: 0, sessions: [] };
  }
}

/**
 * Build the harvester prompt with session file paths and external source checkpoints
 */
function buildHarvesterPrompt(sessions, state, healthySources) {
  // Read the base prompt template
  let basePrompt;
  try {
    basePrompt = fs.readFileSync(HARVESTER_PROMPT, 'utf-8');
  } catch (err) {
    log(`Error reading harvester prompt: ${err.message}`);
    basePrompt = 'You are a memory harvester. Read the provided JSONL files and extract key memories.';
  }

  // Add the list of files to process
  const fileList = sessions.length > 0
    ? sessions.map(s => `- ${s.project}: ${s.path}`).join('\n')
    : '(No new Claude session files)';

  // Find guest session journal files
  const guestSessionsDir = path.join(process.env.HOME, '.homestead', 'guest-sessions');
  let journalFiles = '';
  try {
    if (fs.existsSync(guestSessionsDir)) {
      const guests = fs.readdirSync(guestSessionsDir);
      const journals = [];
      for (const guest of guests) {
        const journalPath = path.join(guestSessionsDir, guest, 'journal', 'log.md');
        if (fs.existsSync(journalPath)) {
          const stats = fs.statSync(journalPath);
          if (stats.size > 0) {
            journals.push(`- guest-${guest} journal: ${journalPath}`);
          }
        }
      }
      if (journals.length > 0) {
        journalFiles = `\n\n## Guest Session Journals\n\nThese journals are kept by the shared assistant during guest conversations. Read them for family/personal context:\n\n${journals.join('\n')}`;
      }
    }
  } catch (e) { /* ignore */ }

  // Build external source checkpoint info
  const externalSources = state.externalSources || {};
  const now = new Date().toISOString();

  // Gmail section (only if healthy)
  let gmailSection = '';
  if (healthySources.includes('gmail')) {
    const gmailLastChecked = externalSources.gmail?.lastChecked || null;
    const gmailInfo = gmailLastChecked
      ? `Last checked: ${gmailLastChecked}`
      : 'Never checked (fetch last 24 hours)';
    gmailSection = `### Gmail
${gmailInfo}

Use the \`mcp__gmail__search_emails\` tool to fetch emails since the last check.
- If never checked, use query: \`after:YYYY/MM/DD\` for 24 hours ago
- Otherwise use the timestamp to build an appropriate \`after:\` query
`;
  }

  // Slack section (only healthy workspaces)
  const healthySlack = healthySources.filter(s => s.startsWith('slack-'));
  let slackSection = '';
  if (healthySlack.length > 0) {
    const slackInfo = healthySlack.map(s => {
      const lastChecked = externalSources[s]?.lastChecked || null;
      const workspace = s.replace('slack-', '');
      return lastChecked
        ? `- ${workspace}: Last checked ${lastChecked}`
        : `- ${workspace}: Never checked (fetch last 24 hours)`;
    }).join('\n');
    slackSection = `### Slack Workspaces
${slackInfo}

For each workspace, use the appropriate MCP tools:
- \`mcp__slack-{workspace}__conversations_history\` to get recent messages
- Focus on channels with activity, skip empty ones
`;
  }

  // Build external sources section
  const hasAnySources = gmailSection || slackSection;
  const externalSourcesBlock = hasAnySources
    ? `## External Sources to Check

${gmailSection}${slackSection}`
    : `## External Sources

No external sources are currently healthy. Just process Claude session files.`;

  const fullPrompt = `${basePrompt}

---

## Claude Session Files to Process

${fileList}
${journalFiles}

---

${externalSourcesBlock}

---

## Current Timestamp

${now}

Use this as the "checked at" time when you finish processing each source.

---

## IMPORTANT: Timeout Handling

If any MCP tool call (Gmail, Slack) takes more than 15 seconds or returns empty/error, **do not retry it**. Instead:

1. Skip that source
2. Report the failure by running this command:
\`\`\`bash
node -e "require('${HOMESTEAD_DIR}/lib/trigger-memory-harvester').markSourceFailed('<source-name>')"
\`\`\`

Where \`<source-name>\` is one of: gmail, slack-mullettown, slack-codeworks, slack-<<REPLACE: your-employer>>

This tells the scheduler to back off and retry later, preventing you from wasting time on broken sources.

If a source DOES respond successfully, mark it healthy:
\`\`\`bash
node -e "require('${HOMESTEAD_DIR}/lib/trigger-memory-harvester').markSourceHealthy('<source-name>')"
\`\`\`

---

Please process all sources now. Start with Claude sessions, then external sources. Focus on recording memories — do not create alerts or triage notifications.`;

  return fullPrompt;
}

/**
 * Check if external sources need checking (based on time since last check)
 */
function shouldCheckExternalSources(state, thresholdMinutes = 15, healthySources = []) {
  const externalSources = state.externalSources || {};
  const threshold = Date.now() - (thresholdMinutes * 60 * 1000);

  for (const source of healthySources) {
    const lastChecked = externalSources[source]?.lastChecked;
    if (!lastChecked) {
      log(`External source "${source}" never checked - needs check`);
      return true;
    }
    const lastCheckedTime = new Date(lastChecked).getTime();
    if (lastCheckedTime < threshold) {
      log(`External source "${source}" last checked ${lastChecked} - needs check`);
      return true;
    }
  }
  return false;
}

// Defensive ceiling on lookback to prevent runaway floor anchoring from any
// pathology (per-session, external-source, or future) — wedge-fix 2026-06-08.
const MAX_LOOKBACK_MINUTES = 30;

/**
 * Calculate how far back we need to look based on state.
 *
 * Floor source is `state.lastFullScanCompleted` — the ISO timestamp at which
 * the harvester last completed a scan-sweep. Per-session `state.lastHarvested`
 * is NOT used as a floor source (it's per-path dedup only); using min across
 * it caused a 50hr+ wedge when a long-ago-harvested session whose mtime never
 * changed kept anchoring the floor (lookback grew ~30m per scheduler tick
 * forever).
 *
 * External-source checkpoints still factor in so a stale source can extend
 * lookback; the defensive ceiling MAX_LOOKBACK_MINUTES caps any pathology.
 */
function calculateLookbackMinutes(state, defaultMinutes) {
  let oldestCheckpoint = Date.now();

  // Floor source: last full scan completion.
  const lastFullScan = state.lastFullScanCompleted;
  if (lastFullScan) {
    const t = new Date(lastFullScan).getTime();
    if (t < oldestCheckpoint) oldestCheckpoint = t;
  } else {
    // First run after fix (or fresh state): look back defaultMinutes only.
    oldestCheckpoint = Date.now() - defaultMinutes * 60000;
  }

  // External sources can extend lookback if a healthy source is overdue.
  const externalSources = state.externalSources || {};
  for (const source of ALL_EXTERNAL_SOURCES) {
    const lastChecked = externalSources[source]?.lastChecked;
    if (lastChecked) {
      const checkpointTime = new Date(lastChecked).getTime();
      if (checkpointTime < oldestCheckpoint) {
        oldestCheckpoint = checkpointTime;
      }
    } else {
      // Never checked - look back 24 hours for this source
      oldestCheckpoint = Date.now() - (24 * 60 * 60 * 1000);
    }
  }

  const minutesSinceOldest = Math.ceil((Date.now() - oldestCheckpoint) / 60000);

  // Uncapped "want" vs capped "got". `uncapped` is what the floor sources are
  // asking for; `capped` is what we'll actually scan. Both are returned so the
  // caller can distinguish real wedge alarms (uncapped >> max) from routine
  // overshoot (e.g. externalSources slightly older than ceiling).
  const uncapped = Math.max(minutesSinceOldest + 5, defaultMinutes);
  const capped = Math.min(uncapped, MAX_LOOKBACK_MINUTES);

  return { lookback: capped, uncapped };
}

// Alarm-worthy ceiling overshoot: only flag when uncapped lookback exceeds the
// ceiling by 2x. Smaller overshoots are routine (externalSources tick aging).
const CEILING_ALARM_FACTOR = 2;

/**
 * Count active ephemeral tmux sessions
 */
function countActiveEphemeralSessions() {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return output.trim().split('\n').filter(name => name.startsWith('ephemeral-')).length;
  } catch (err) {
    return 0;
  }
}

/**
 * Main trigger function
 */
function triggerHarvester(minutes = 15) {
  log(`=== Memory Harvester Run Start ===`);

  // Guard: don't spawn if ephemeral workers are already running
  const activeEphemerals = countActiveEphemeralSessions();
  if (activeEphemerals > 0) {
    log(`${activeEphemerals} ephemeral worker(s) still running. Skipping this run.`);
    return { triggered: false, reason: 'workers_still_running', activeWorkers: activeEphemerals };
  }

  // Load state to track already-harvested sessions
  const state = loadState();

  // Calculate how far back to look based on oldest checkpoint
  const { lookback: lookbackMinutes, uncapped: lookbackUncappedMinutes } = calculateLookbackMinutes(state, minutes);
  // Only flag ceiling-hit when uncapped want >> ceiling; otherwise it's routine
  // overshoot (e.g. externalSources tick aging) and dashboard alarms would be noise.
  const lookbackCeilingHit = lookbackUncappedMinutes >= MAX_LOOKBACK_MINUTES * CEILING_ALARM_FACTOR;
  if (lookbackMinutes > minutes) {
    log(`Extending lookback from ${minutes}m to ${lookbackMinutes}m to catch up on missed sessions`);
  }
  if (lookbackCeilingHit) {
    log(`Lookback wanted ${lookbackUncappedMinutes}m, capped at ceiling (${MAX_LOOKBACK_MINUTES}m) — real backlog suspected; check status.`, 'WARN');
  }
  log(`Checking for sessions modified in last ${lookbackMinutes} minutes...`);

  // Find recent sessions
  const result = findRecentSessions(lookbackMinutes);

  log(`Found ${result.count} total sessions from scanner`);

  // Filter out ephemeral and code-root sessions
  let sessionsToProcess = [];
  if (result.count > 0) {
    const userSessions = result.sessions.filter(s => {
      if (s.path.includes('ephemeral')) {
        log(`  Filtered (ephemeral): ${s.project} - ${path.basename(s.path)}`, 'DEBUG');
        return false;
      }
      if (s.project === 'code-root') {
        log(`  Filtered (code-root): ${path.basename(s.path)}`, 'DEBUG');
        return false;
      }
      return true;
    });

    log(`User sessions after filtering: ${userSessions.length}`);

    // Check if any sessions have actually changed since last harvest
    sessionsToProcess = userSessions.filter(s => {
      const lastHarvested = state.lastHarvested[s.path];
      const modTime = new Date(s.modifiedAt).getTime();
      const isNew = !lastHarvested || modTime > lastHarvested;

      if (!isNew) {
        log(`  Skipping (unchanged): ${s.project} - ${path.basename(s.path)}`, 'DEBUG');
      } else {
        log(`  Will process: ${s.project} - ${path.basename(s.path)} (mod: ${s.modifiedAt})`);
      }
      return isNew;
    });

    log(`Sessions with actual changes: ${sessionsToProcess.length}`);
  }

  // Health check external sources (skip broken ones)
  const healthySources = getHealthySources();

  // Check if we need to run for external sources
  const needsExternalCheck = shouldCheckExternalSources(state, lookbackMinutes, healthySources);
  log(`External sources need check: ${needsExternalCheck}`);

  // Exit early only if NO sessions AND no external sources need checking.
  // Advance the watermark — a "saw the world, nothing to do" run IS a
  // completed scan-sweep; without this, consecutive nothing-to-process ticks
  // would never update the floor and a wedge could re-emerge.
  if (sessionsToProcess.length === 0 && !needsExternalCheck) {
    log('No new Claude sessions and external sources are up to date. Exiting.');
    state.lastFullScanCompleted = new Date().toISOString();
    pruneStaleHarvestEntries(state);
    saveState(state);
    return {
      triggered: false,
      reason: 'nothing_to_process',
      lookbackMinutes,
      lookbackUncappedMinutes,
      lookbackCeilingHit
    };
  }

  // Build the prompt with only healthy external sources
  const prompt = buildHarvesterPrompt(sessionsToProcess, state, healthySources);

  log('Spawning memory harvester worker...');

  // Spawn the worker
  const spawnResult = spawnWorker(prompt, { cwd: HOMESTEAD_DIR });

  if (spawnResult.success) {
    log(`Worker spawned: ${spawnResult.sessionName}`);

    // Update state with harvested timestamps for Claude sessions
    const now = Date.now();
    const nowIso = new Date().toISOString();

    for (const s of sessionsToProcess) {
      state.lastHarvested[s.path] = now;
    }

    // Update external source checkpoints (only for healthy sources)
    if (!state.externalSources) state.externalSources = {};
    for (const source of healthySources) {
      state.externalSources[source] = { lastChecked: nowIso };
    }

    // Advance the load-bearing watermark.
    state.lastFullScanCompleted = nowIso;
    pruneStaleHarvestEntries(state);

    saveState(state);
    log(`Updated state: ${sessionsToProcess.length} sessions + ${healthySources.length} healthy sources`);

    return {
      triggered: true,
      sessionName: spawnResult.sessionName,
      sessionsProcessed: sessionsToProcess.length,
      sessions: sessionsToProcess.map(s => s.project),
      healthySources,
      logFile: spawnResult.logFile,
      lookbackMinutes,
      lookbackUncappedMinutes,
      lookbackCeilingHit
    };
  } else {
    log(`Failed to spawn worker: ${spawnResult.error}`, 'ERROR');
    return {
      triggered: false,
      reason: 'spawn_failed',
      error: spawnResult.error
    };
  }
}

/**
 * Record successful harvest run.
 * `extras` carries the backlog metric + ceiling-hit flag for dashboard surfacing.
 */
function recordSuccessfulRun(result, extras = {}) {
  const statusFile = path.join(HOMESTEAD_DIR, 'data/harvester-status.json');
  try {
    const status = {
      lastSuccessfulRun: new Date().toISOString(),
      sessionsProcessed: result.sessionsProcessed || 0,
      sessions: result.sessions || [],
      healthySources: result.healthySources || [],
      lookbackMinutes: extras.lookbackMinutes ?? null,
      lookbackUncappedMinutes: extras.lookbackUncappedMinutes ?? null,
      lookbackCeilingHit: extras.lookbackCeilingHit ?? false,
      maxLookbackMinutes: MAX_LOOKBACK_MINUTES
    };
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
    log(`Recorded successful run to ${statusFile}`);
  } catch (err) {
    log(`Failed to record status: ${err.message}`, 'WARN');
  }
}

// CLI usage
if (require.main === module) {
  (async () => {
    // Skip channel health check during harvest - it uses execSync which blocks
    // and can't be interrupted. Run it separately via cron if needed.
    log('Skipping channel health check (run separately to avoid blocking)');

    // Run the harvester
    const minutes = parseInt(process.argv[2]) || 15;
    const result = triggerHarvester(minutes);

    // Record successful run on triggered=true OR nothing_to_process — both are
    // valid sweep completions for dashboard liveness + backlog surfacing.
    if (result.triggered || result.reason === 'nothing_to_process') {
      recordSuccessfulRun(result, {
        lookbackMinutes: result.lookbackMinutes,
        lookbackUncappedMinutes: result.lookbackUncappedMinutes,
        lookbackCeilingHit: result.lookbackCeilingHit
      });
    }

    console.log('');
    console.log('Result:', JSON.stringify(result, null, 2));
  })();
}

module.exports = { triggerHarvester, markSourceFailed, markSourceHealthy };
