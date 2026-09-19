/**
 * Channel Health Check Script
 *
 * Tests connectivity to all communication channels (Gmail, SMS, Slack workspaces)
 * and writes status to data/channel-health.json.
 *
 * Run before harvester to ensure we know which channels are available.
 * If a channel status changes to disconnected, sends a push notification.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HEALTH_FILE = path.join(process.cwd(), 'data', 'channel-health.json');

// Channel definitions
const CHANNELS = [
  {
    id: 'gmail',
    name: 'Gmail',
    type: 'mcp',
    testCommand: 'mcp__gmail__search_emails',
    testArgs: { query: 'in:inbox', maxResults: 1 }
  },
  {
    id: 'phone-api',
    name: 'Phone API',
    type: 'api',
    testEndpoint: 'http://100.84.84.102:8888/health'
  },
  {
    id: 'slack-codeworks',
    name: 'Slack (Codeworks)',
    type: 'mcp',
    testCommand: 'mcp__slack-codeworks__channels_list',
    testArgs: { channel_types: 'public_channel', limit: 1 }
  },
  {
    id: 'slack-mullettown',
    name: 'Slack (Mullettown)',
    type: 'mcp',
    testCommand: 'mcp__slack-mullettown__channels_list',
    testArgs: { channel_types: 'public_channel', limit: 1 }
  },
  {
    id: 'slack-<<REPLACE: your-employer>>',
    name: 'Slack (<<REPLACE: your employer>>)',
    type: 'mcp',
    testCommand: 'mcp__slack-<<REPLACE: your-employer>>__channels_list',
    testArgs: { channel_types: 'public_channel', limit: 1 }
  },
  {
    id: 'push',
    name: 'Push Notifications',
    type: 'api',
    testEndpoint: 'http://localhost:3005/api/push/test'
  }
];

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [ChannelHealth] ${message}`);
}

function loadHealth() {
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8'));
    }
  } catch (err) {
    log(`Error loading health file: ${err.message}`);
  }
  return { channels: {}, last_full_check: null };
}

function saveHealth(data) {
  try {
    const dir = path.dirname(HEALTH_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Error saving health file: ${err.message}`);
  }
}

/**
 * Test an API endpoint channel
 * Returns { status, error? }
 */
async function testApiChannel(channel) {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(channel.testEndpoint, { signal: controller.signal });
    clearTimeout(timeout);
    const elapsed = Date.now() - startTime;

    if (res.ok) {
      const data = await res.json();
      // Push endpoint has specific hasSubscription check
      if (channel.id === 'push') {
        if (data.hasSubscription) {
          log(`${channel.name}: connected (${elapsed}ms)`);
          return { status: 'connected' };
        } else {
          return { status: 'disconnected', error: 'No push subscription' };
        }
      }
      // Generic API endpoint - if response is ok, we're connected
      log(`${channel.name}: connected (${elapsed}ms)`);
      return { status: 'connected' };
    } else {
      return { status: 'error', error: `HTTP ${res.status}` };
    }
  } catch (err) {
    const elapsed = Date.now() - startTime;
    log(`${channel.name}: error after ${elapsed}ms - ${err.message}`);
    return { status: 'error', error: err.message.slice(0, 100) };
  }
}

/**
 * Test a channel using claude CLI with MCP tool
 * Returns { status, error? }
 */
async function testMcpChannel(channel) {
  const startTime = Date.now();

  try {
    // Use claude CLI in print mode to test the MCP tool
    // Use full path since node child processes may not have the same PATH
    const claudePath = process.env.CLAUDE_PATH || '<<REPLACE: your home dir, e.g. /Users/you>>/.nvm/versions/node/v22.22.0/bin/claude';
    const argsJson = JSON.stringify(channel.testArgs);
    const cmd = `${claudePath} -p "Use the ${channel.testCommand} tool with these exact arguments: ${argsJson}. Just call the tool and report success or the error message. Be very brief." --allowedTools "${channel.testCommand}" 2>&1`;

    // Build env without CLAUDECODE to allow nested claude calls
    const cleanEnv = { ...process.env, CLAUDE_HOOK_SKIP: '1' };
    delete cleanEnv.CLAUDECODE;

    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: process.cwd(),
      env: cleanEnv
    });

    const elapsed = Date.now() - startTime;

    // Check for common error patterns
    if (output.includes('invalid_grant')) {
      return { status: 'auth_expired', error: 'invalid_grant' };
    }
    if (output.includes('No device found') || output.includes('USB debugging')) {
      return { status: 'disconnected', error: 'No device connected' };
    }
    if (output.includes('Error:') || output.includes('error:') || output.includes('failed')) {
      // Extract error message
      const errorMatch = output.match(/[Ee]rror:?\s*(.+?)(?:\n|$)/);
      const error = errorMatch ? errorMatch[1].trim() : 'Unknown error';
      return { status: 'error', error };
    }

    // If we got here without errors, consider it connected
    log(`${channel.name}: connected (${elapsed}ms)`);
    return { status: 'connected' };

  } catch (err) {
    const elapsed = Date.now() - startTime;
    log(`${channel.name}: error after ${elapsed}ms - ${err.message}`);

    // Check if it's a timeout
    if (err.message.includes('TIMEOUT') || err.killed) {
      return { status: 'timeout', error: 'Request timed out' };
    }

    return { status: 'error', error: err.message.slice(0, 200) };
  }
}

/**
 * Test a channel - routes to appropriate test function based on type
 */
async function testChannel(channel) {
  if (channel.type === 'api') {
    return testApiChannel(channel);
  }
  return testMcpChannel(channel);
}

/**
 * Send push notification about channel status change
 */
async function notifyStatusChange(channel, oldStatus, newStatus, error) {
  // Only notify on degradation (connected -> anything else)
  if (oldStatus === 'connected' && newStatus !== 'connected') {
    log(`Status change: ${channel.name} ${oldStatus} -> ${newStatus}`);

    try {
      // Build notification based on channel type
      let title, body, url;

      if (channel.id === 'gmail' && newStatus === 'auth_expired') {
        title = '📧 Gmail Auth Expired';
        body = 'Tap to re-authenticate Gmail';
        url = '/reauth/gmail';
      } else if (channel.id === 'phone-api' && newStatus === 'disconnected') {
        title = '📱 Phone API Disconnected';
        body = 'Check Homestead app is running on your phone';
        url = '/reauth/phone';
      } else {
        title = `${channel.name} Disconnected`;
        body = error || `Status: ${newStatus}`;
        url = null;
      }

      await fetch('http://localhost:3005/api/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body,
          data: {
            type: 'channel_health',
            channel: channel.id,
            status: newStatus,
            url
          }
        })
      });
      log(`Sent disconnect notification for ${channel.name}`);
    } catch (err) {
      log(`Failed to send notification: ${err.message}`);
    }
  }
}

/**
 * Main health check function
 */
async function checkAllChannels() {
  log('Starting channel health check...');

  const healthData = loadHealth();
  const now = new Date().toISOString();

  // Run all channel tests in parallel for speed
  const testPromises = CHANNELS.map(async (channel) => {
    const oldStatus = healthData.channels[channel.id]?.status;
    const result = await testChannel(channel);

    return {
      channel,
      oldStatus,
      result
    };
  });

  const testResults = await Promise.all(testPromises);

  // Process results
  const results = [];
  for (const { channel, oldStatus, result } of testResults) {
    // Update health data
    healthData.channels[channel.id] = {
      status: result.status,
      last_checked: now,
      last_success: result.status === 'connected' ? now : (healthData.channels[channel.id]?.last_success || null),
      error: result.error || null
    };

    // Check for status change
    if (oldStatus && oldStatus !== result.status) {
      await notifyStatusChange(channel, oldStatus, result.status, result.error);
    }

    results.push({
      id: channel.id,
      name: channel.name,
      status: result.status,
      error: result.error
    });
  }

  healthData.last_full_check = now;
  saveHealth(healthData);

  // Summary
  const connected = results.filter(r => r.status === 'connected').length;
  const total = results.length;
  log(`Health check complete: ${connected}/${total} channels connected`);

  // Print summary table
  console.log('\nChannel Health Summary:');
  console.log('─'.repeat(50));
  for (const r of results) {
    const statusIcon = r.status === 'connected' ? '✓' : '✗';
    const errorStr = r.error ? ` (${r.error})` : '';
    console.log(`  ${statusIcon} ${r.name.padEnd(20)} ${r.status}${errorStr}`);
  }
  console.log('─'.repeat(50));

  return {
    success: true,
    connected,
    total,
    channels: results
  };
}

// Run if called directly
if (require.main === module) {
  checkAllChannels()
    .then(result => {
      console.log('\nResult:', JSON.stringify(result, null, 2));
      process.exit(result.connected === result.total ? 0 : 1);
    })
    .catch(err => {
      console.error('Health check failed:', err);
      process.exit(1);
    });
}

module.exports = { checkAllChannels, loadHealth, CHANNELS };
