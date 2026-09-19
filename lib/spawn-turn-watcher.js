#!/usr/bin/env node
/**
 * Turn Watcher Spawner
 *
 * Spawns an ephemeral worker to watch/verify what just happened in a Claude session.
 * Called by the stop hook after each Claude response.
 *
 * Usage:
 *   node spawn-turn-watcher.js <tmux-session-name>
 */

const fs = require('fs');
const path = require('path');
const { spawnWorker } = require('./spawn-worker');
const { setWatcherStatus } = require('./update-session-status');

const HOMESTEAD_DIR = path.resolve(__dirname, '..');
const WATCHER_PROMPT = path.join(HOMESTEAD_DIR, 'prompts/turn-watcher.md');
const LOG_FILE = '/tmp/turn-watcher.log';

// Sessions to skip (ephemeral workers, known non-interactive)
const SKIP_PATTERNS = [
  /^ephemeral-/,
  /^watcher-/,
];

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] [TurnWatcher] ${message}`;
  console.log(logLine);
  try {
    fs.appendFileSync(LOG_FILE, logLine + '\n');
  } catch (e) { /* ignore */ }
}

/**
 * Check if we should skip this session
 */
function shouldSkip(sessionName) {
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(sessionName)) {
      return true;
    }
  }
  return false;
}

/**
 * Load the conversation context for a session (last 10 exchanges)
 */
function loadConversationContext(sessionName) {
  const conversationFile = `/tmp/claude-session-${sessionName}-conversation.json`;

  if (!fs.existsSync(conversationFile)) {
    log(`No conversation file found: ${conversationFile}`);
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(conversationFile, 'utf-8'));
    const exchanges = data.exchanges || [];

    if (exchanges.length === 0) {
      log('No exchanges in conversation');
      return null;
    }

    // Get last 10 exchanges for context
    const recentExchanges = exchanges.slice(-10);

    // Format chat history
    const chatHistory = recentExchanges.map((ex, i) => {
      const parts = [];
      if (ex.user) parts.push(`**User:** ${ex.user}`);
      if (ex.assistant) parts.push(`**Claude:** ${ex.assistant}`);
      return parts.join('\n\n');
    }).join('\n\n---\n\n');

    // Get the last exchange specifically
    const lastExchange = exchanges[exchanges.length - 1];

    const context = {
      session: sessionName,
      project: data.project || sessionName.replace('holler-', ''),
      chatHistory,
      exchangeCount: exchanges.length,
      lastUserMessage: lastExchange.user || (exchanges.length > 1 ? exchanges[exchanges.length - 2].user : '(no user message)'),
      lastAssistantResponse: lastExchange.assistant || '(no response)',
      timestamp: lastExchange.timestamp || new Date().toISOString(),
    };

    return context;

  } catch (err) {
    log(`Error loading conversation: ${err.message}`, 'ERROR');
    return null;
  }
}

/**
 * Load PLAN.md and STATE.md from project directory
 */
function loadProjectDocs(projectCwd) {
  const docs = { plan: null, state: null };

  // Try PLAN.md
  const planPath = path.join(projectCwd, 'PLAN.md');
  if (fs.existsSync(planPath)) {
    try {
      docs.plan = fs.readFileSync(planPath, 'utf-8');
    } catch (e) { /* ignore */ }
  }

  // Try STATE.md
  const statePath = path.join(projectCwd, 'STATE.md');
  if (fs.existsSync(statePath)) {
    try {
      docs.state = fs.readFileSync(statePath, 'utf-8');
    } catch (e) { /* ignore */ }
  }

  return docs;
}

/**
 * Load activity summary for a session
 */
function loadActivitySummary(sessionName) {
  const activityFile = `/tmp/claude-session-${sessionName}-activity.json`;

  if (!fs.existsSync(activityFile)) {
    return { summary: 'No activity data available' };
  }

  try {
    const data = JSON.parse(fs.readFileSync(activityFile, 'utf-8'));
    const activities = data.activities || [];

    // Summarize tools used
    const toolsUsed = activities
      .filter(a => a.tool && a.tool !== 'thinking')
      .map(a => a.tool)
      .filter((v, i, arr) => arr.indexOf(v) === i); // unique

    // Count thinking entries
    const thinkingCount = activities.filter(a => a.tool === 'thinking').length;

    return {
      toolsUsed,
      thinkingCount,
      totalActivities: activities.length,
      summary: toolsUsed.length > 0
        ? `Used: ${toolsUsed.join(', ')}`
        : 'No tool calls'
    };

  } catch (err) {
    log(`Error loading activity: ${err.message}`, 'WARN');
    return { summary: 'Could not load activity data' };
  }
}

/**
 * Build the full prompt for the watcher
 */
function buildWatcherPrompt(context, activity, docs) {
  // Read base prompt
  let basePrompt;
  try {
    basePrompt = fs.readFileSync(WATCHER_PROMPT, 'utf-8');
  } catch (err) {
    log(`Error reading watcher prompt: ${err.message}`, 'ERROR');
    basePrompt = 'You are a turn watcher. Verify what just happened and report back.';
  }

  const fullPrompt = `${basePrompt}

## Session: ${context.session}
## Project: ${context.project}
## Timestamp: ${context.timestamp}
## Total Exchanges: ${context.exchangeCount}

---

## Recent Chat History (last 10 exchanges)

${context.chatHistory}

---

## Tools Used This Turn

${activity.summary}
${activity.toolsUsed?.length > 0 ? `Tools: ${activity.toolsUsed.join(', ')}` : ''}

---

${docs.plan ? `## Current PLAN.md

${docs.plan}

---

` : ''}${docs.state ? `## Current STATE.md

${docs.state}

---

` : ''}
Now:
1. Check if anything was completed - if so, update PLAN.md and STATE.md
2. Verify any claims ("fixed", "done", "working") - actually test them
3. If something needs attention, flag it
4. Submit your report to the API
5. Use \`/stop\` when done`;

  return fullPrompt;
}

/**
 * Extract project cwd from session name
 */
function getProjectCwd(sessionName) {
  // holler-homestead -> <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead
  // holler-homestead--branch-name -> <<REPLACE: your home dir, e.g. /Users/you>>/.worktrees/homestead/branch-name

  const match = sessionName.match(/^holler-([^-]+)(?:--(.+))?$/);
  if (!match) {
    return HOMESTEAD_DIR; // fallback
  }

  const [, project, branch] = match;

  if (branch) {
    return `<<REPLACE: your home dir, e.g. /Users/you>>/.worktrees/${project}/${branch}`;
  }

  return `<<REPLACE: your home dir, e.g. /Users/you>>/code/${project}`;
}

/**
 * Main entry point
 */
function spawnTurnWatcher(sessionName) {
  log(`=== Turn Watcher Spawn ===`);
  log(`Session: ${sessionName}`);

  // Check if we should skip this session
  if (shouldSkip(sessionName)) {
    log(`Skipping session (matches skip pattern)`);
    return { spawned: false, reason: 'skip_pattern' };
  }

  // Determine working directory first (needed for docs)
  const cwd = getProjectCwd(sessionName);
  log(`Working directory: ${cwd}`);

  // Load context
  const context = loadConversationContext(sessionName);
  if (!context) {
    log('No context available, skipping');
    return { spawned: false, reason: 'no_context' };
  }

  // Load activity
  const activity = loadActivitySummary(sessionName);

  // Load project docs (PLAN.md, STATE.md)
  const docs = loadProjectDocs(cwd);
  log(`Project docs: PLAN=${!!docs.plan}, STATE=${!!docs.state}`);

  // Build prompt
  const prompt = buildWatcherPrompt(context, activity, docs);
  log(`Prompt length: ${prompt.length} chars`);

  // Set watcher status to "working" before spawning
  setWatcherStatus(sessionName, 'working');
  log(`Set watcherStatus: working for ${sessionName}`);

  // Spawn the watcher
  const result = spawnWorker(prompt, { cwd });

  if (result.success) {
    log(`Watcher spawned: ${result.sessionName}`);
  } else {
    log(`Failed to spawn watcher: ${result.error}`, 'ERROR');
  }

  return {
    spawned: result.success,
    watcherSession: result.sessionName,
    watchedSession: sessionName,
    logFile: result.logFile
  };
}

// CLI usage
if (require.main === module) {
  const sessionName = process.argv[2];

  if (!sessionName) {
    console.log('Usage: node spawn-turn-watcher.js <tmux-session-name>');
    console.log('');
    console.log('Example:');
    console.log('  node spawn-turn-watcher.js holler-homestead');
    process.exit(1);
  }

  const result = spawnTurnWatcher(sessionName);
  console.log('');
  console.log('Result:', JSON.stringify(result, null, 2));
}

module.exports = { spawnTurnWatcher };
