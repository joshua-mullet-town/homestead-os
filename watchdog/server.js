const express = require('express');
const { exec, execSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3007;
const HOMESTEAD_PORT = 3005;
const HOMESTEAD_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead';
const EMERGENCY_LOG_DIR = path.join(__dirname, 'emergency-logs');

// Resolve the NEWEST-version claude binary — NOT PATH-order. Under the launchd
// env /opt/homebrew/bin (stale 1.0.65, retired-model opus alias → 404) precedes
// ~/.local/bin (current). This is a self-contained copy of lib/claude-resolver.js;
// watchdog is a separate module tree (own package.json) so it can't import it.
function resolveClaudePath() {
  const home = os.homedir();
  const localBin = path.join(home, '.local', 'bin', 'claude');
  const paths = [localBin, '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  try {
    const w = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (w) paths.push(w);
  } catch {}
  const seen = new Set();
  const candidates = paths.filter(p => {
    if (!p || seen.has(p) || !fs.existsSync(p)) return false;
    seen.add(p);
    return true;
  });
  let best = null, bestVer = null;
  for (const bin of candidates) {
    let ver = null;
    try {
      const out = execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 10000 }).trim();
      const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
      if (m) ver = [Number(m[1]), Number(m[2]), Number(m[3])];
    } catch {}
    if (!ver) continue;
    const gt = !bestVer || ver[0] > bestVer[0] ||
      (ver[0] === bestVer[0] && ver[1] > bestVer[1]) ||
      (ver[0] === bestVer[0] && ver[1] === bestVer[1] && ver[2] > bestVer[2]);
    if (gt) { best = bin; bestVer = ver; }
  }
  if (best) return best;
  if (fs.existsSync(localBin)) return localBin;
  try {
    const w = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (w) return w;
  } catch {}
  return localBin;
}

// Phone API configuration (runs on your Android phone)
const PHONE_API_HOST = '100.84.84.102';
const PHONE_API_PORT = 8888;

// Ensure log directory exists
if (!fs.existsSync(EMERGENCY_LOG_DIR)) {
  fs.mkdirSync(EMERGENCY_LOG_DIR, { recursive: true });
}

// Check if Phone API is responding
function checkPhoneHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://${PHONE_API_HOST}:${PHONE_API_PORT}/health`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ healthy: true, status: json.status || 'ok', data: json });
        } catch {
          resolve({ healthy: res.statusCode === 200, statusCode: res.statusCode });
        }
      });
    });
    req.on('error', () => resolve({ healthy: false, error: 'Connection refused' }));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ healthy: false, error: 'Timeout' });
    });
  });
}

// Track active emergency workers
const emergencyWorkers = new Map(); // sessionName -> { mode, message, startedAt, status, summary }

// Disable caching for development
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Check if Homestead is responding
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${HOMESTEAD_PORT}`, (res) => {
      resolve({ healthy: res.statusCode === 200, statusCode: res.statusCode });
    });
    req.on('error', () => resolve({ healthy: false, error: 'Connection refused' }));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ healthy: false, error: 'Timeout' });
    });
  });
}

// Kill whatever is on port 3005 and restart
function restartHomestead() {
  return new Promise((resolve) => {
    exec(`pm2 restart homestead`, (err, stdout, stderr) => {
      setTimeout(async () => {
        const health = await checkHealth();
        if (health.healthy) {
          resolve({ success: true, message: 'Homestead restarted successfully' });
        } else {
          resolve({ success: true, message: 'Restart initiated, still starting up...' });
        }
      }, 5000);
    });
  });
}

// Get pm2 status for all services
function getServiceStatus() {
  return new Promise((resolve) => {
    exec('pm2 jlist', (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      try {
        const processes = JSON.parse(stdout);
        resolve(processes.map(p => ({
          name: p.name,
          status: p.pm2_env.status,
          uptime: p.pm2_env.pm_uptime,
          restarts: p.pm2_env.restart_time,
          memory: p.monit?.memory || 0,
          cpu: p.monit?.cpu || 0
        })));
      } catch (e) {
        resolve([]);
      }
    });
  });
}

// API Routes
app.get('/api/status', async (req, res) => {
  const [health, services, phoneHealth] = await Promise.all([
    checkHealth(),
    getServiceStatus(),
    checkPhoneHealth()
  ]);

  res.json({
    homestead: health,
    services,
    phone: {
      ...phoneHealth,
      host: PHONE_API_HOST,
      port: PHONE_API_PORT
    },
    watchdog: { healthy: true, uptime: process.uptime() },
    timestamp: new Date().toISOString()
  });
});

// Test Phone API connection
app.get('/api/phone/test', async (req, res) => {
  const health = await checkPhoneHealth();
  res.json({
    ...health,
    host: PHONE_API_HOST,
    port: PHONE_API_PORT
  });
});

app.post('/api/restart', async (req, res) => {
  console.log(`[${new Date().toISOString()}] Restart requested`);
  const result = await restartHomestead();
  res.json(result);
});

app.post('/api/restart/:service', async (req, res) => {
  const { service } = req.params;
  console.log(`[${new Date().toISOString()}] Restart requested for ${service}`);

  exec(`pm2 restart ${service}`, (err) => {
    if (err) {
      res.json({ success: false, message: `Failed to restart ${service}` });
    } else {
      res.json({ success: true, message: `${service} restart initiated` });
    }
  });
});

// ===== QUICK ACTIONS =====

// REMOVED 2026-09-18 on Josh's explicit instruction: "let's get rid of the button.
// I don't think we actually want it. If the emergency worker line is open, that's all
// we need." The handler did `rm -rf ${HOMESTEAD_DIR}/.next` and then `pm2 restart`
// with NO rebuild. Its comment claimed "Next.js needs time to rebuild" — true only in
// dev. This runs NODE_ENV=production (server.js:260 -> dev=false), where next() serves
// a PREBUILT .next and never regenerates, so the delete was unrecoverable without a
// `next build`. Next's own error path confirms it: "Could not find a production build
// in the '<distDir>' directory" (next/dist/server/lib/router-utils/filesystem.js).
// So the button labelled for a totally-broken server would have finished it off.
// ⚠️ DO NOT CONFUSE WITH phone-alley's /api/nuclear-restart — a DIFFERENT, non-destructive
// endpoint (pm2.restartAll() + PID verification, no .next delete) that is tested and kept.
// Alfred-flagged; scope verified by two independent sweeps (repo + outside-repo, plus
// crontab/LaunchAgents) — no other callers.

// Firebase login via tmux
app.post('/api/firebase-login', (req, res) => {
  console.log(`[${new Date().toISOString()}] Firebase login requested`);

  // Find a tmux session to run firebase login in, or create a temp one
  const script = `
    if tmux has-session -t firebase-login 2>/dev/null; then
      tmux kill-session -t firebase-login
    fi
    tmux new-session -d -s firebase-login "firebase login --interactive 2>&1 | tee /tmp/firebase-login.log; sleep 5; tmux kill-session -t firebase-login"
  `;

  exec(script, { shell: '/bin/bash' }, (err) => {
    if (err) {
      console.error('Firebase login error:', err.message);
      res.json({ success: false, message: `Firebase login failed: ${err.message}` });
      return;
    }
    res.json({ success: true, message: 'Firebase login session started — check browser for auth prompt' });
  });
});

// Dev server management (start/stop/status for any project)
app.get('/api/dev-servers', (req, res) => {
  // Check common dev server ports
  const ports = [
    { port: 3002, name: 'Covered Bridge', project: 'covered-bridge' },
    { port: 3005, name: 'Homestead', project: 'homestead' },
  ];

  const checks = ports.map(p => {
    return new Promise((resolve) => {
      exec(`lsof -i :${p.port} -P | grep LISTEN`, (err, stdout) => {
        resolve({ ...p, running: !err && stdout.trim().length > 0 });
      });
    });
  });

  Promise.all(checks).then(results => {
    res.json({ servers: results });
  });
});

app.post('/api/dev-server/:project/start', (req, res) => {
  const { project } = req.params;
  const CODE_DIR = '<<REPLACE: your home dir, e.g. /Users/you>>/code';
  const projectDir = `${CODE_DIR}/${project}`;

  if (!fs.existsSync(projectDir)) {
    return res.json({ success: false, message: `Project ${project} not found` });
  }

  console.log(`[${new Date().toISOString()}] Starting dev server for ${project}`);

  const child = spawn('npm', ['run', 'dev'], {
    cwd: projectDir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PATH: process.env.PATH },
  });
  child.unref();

  res.json({ success: true, message: `Dev server starting for ${project}` });
});

app.post('/api/dev-server/:project/stop', (req, res) => {
  const { project } = req.params;
  // Map project names to their known ports
  const portMap = { 'covered-bridge': 3002 };
  const port = portMap[project];

  if (!port) {
    return res.json({ success: false, message: `Unknown port for ${project}` });
  }

  exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, (err) => {
    res.json({ success: true, message: `Killed process on port ${port}` });
  });
});

// ===== EMERGENCY WORKER SYSTEM =====

function buildEmergencyPrompt(mode, message) {
  const baseContext = `You are an emergency repair worker for Homestead.

Context:
- Homestead is a Next.js app at <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead
- It normally runs on port 3005 via pm2 (process name: "homestead")
- You have full access to the codebase and system
- You have Chrome DevTools MCP available - USE IT to verify fixes by navigating to http://localhost:3005
- Write a summary of what you did to <<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/watchdog/emergency-logs/SUMMARY.md when done
- When completely finished, run this command to exit: bash -c "sleep 2 && tmux kill-session"

IMPORTANT: To verify Homestead is working, you MUST use Chrome DevTools MCP:
1. Use mcp__chrome-devtools__navigate_page to go to http://localhost:3005
2. Use mcp__chrome-devtools__take_screenshot to see if the page loads
3. If you see an error, diagnose and fix it

`;

  const missions = {
    simple: `Situation: Homestead is down and needs to be restarted.

Your mission:
1. Check pm2 logs: pm2 logs homestead --lines 50
2. Try a simple restart: pm2 restart homestead
3. Wait 5 seconds for startup
4. Use Chrome DevTools MCP to navigate to http://localhost:3005 and take a screenshot
5. If page shows error or doesn't load, check logs again and diagnose
6. If still broken, look for code issues and fix them
7. Keep iterating until the page loads successfully in Chrome

Write a brief summary to the log file when done.`,

    bug: `Situation: Homestead is down due to a code bug.

Error/Issue reported:
${message || 'No details provided'}

Your mission:
1. Check pm2 logs: pm2 logs homestead --lines 100
2. Look for the error in the logs
3. If it's a syntax/build error, run: cd ${HOMESTEAD_DIR} && npm run build
4. Find and fix the bug in the code
5. Restart: pm2 restart homestead
6. Use Chrome DevTools MCP to navigate to http://localhost:3005 and take a screenshot
7. If page still shows error, continue debugging until it works

Be aggressive but careful. Fix the issue and get Homestead back online.
Use Chrome DevTools to VISUALLY VERIFY the fix works.
Write a detailed summary to the log file when done.`,

    other: `Situation: System issue affecting Homestead.

Issue reported:
${message || 'No details provided'}

Your mission:
1. Investigate the reported issue
2. Check system resources: df -h, free -m, top -l 1
3. Check pm2 status: pm2 status
4. Check logs: pm2 logs homestead --lines 100
5. Diagnose and fix the root cause
6. Restart Homestead if needed: pm2 restart homestead
7. Use Chrome DevTools MCP to navigate to http://localhost:3005 and take a screenshot
8. Verify the page loads correctly

Write a detailed summary to the log file when done.`
  };

  return baseContext + (missions[mode] || missions.simple);
}

function launchEmergencyWorker(mode, message) {
  const timestamp = Date.now();
  const sessionName = `emergency-homestead-${timestamp}`;
  const prompt = buildEmergencyPrompt(mode, message);

  // Find claude path — newest-version, not PATH-order (see resolveClaudePath above).
  const claudePath = resolveClaudePath();

  try {
    // 1. Create tmux session
    console.log(`[${new Date().toISOString()}] Creating tmux session: ${sessionName}`);
    execSync(`tmux new-session -d -s "${sessionName}" -c "${HOMESTEAD_DIR}"`, { stdio: 'pipe' });

    // 2. Start Claude Code in the session (interactive mode, not -p)
    // Must unset CLAUDECODE env var to avoid "nested session" detection
    // Must set EPHEMERAL_WORKER=1 so hooks know not to write to conversation files
    console.log(`[${new Date().toISOString()}] Starting Claude Code...`);
    execSync(`tmux send-keys -t "${sessionName}" 'CLAUDECODE= EPHEMERAL_WORKER=1 ${claudePath} --dangerously-skip-permissions' Enter`, { stdio: 'pipe' });

    // 3. Register the worker
    emergencyWorkers.set(sessionName, {
      mode,
      message: message || null,
      startedAt: new Date().toISOString(),
      status: 'running',
      summary: null
    });

    // 4. Wait for Claude to initialize, then send the prompt
    // Do this in background so we don't block the HTTP response
    setTimeout(() => {
      try {
        console.log(`[${new Date().toISOString()}] Sending prompt to Claude...`);
        // Write prompt to a temp file, then use tmux load-buffer + paste-buffer
        // This properly handles multi-line prompts with special characters
        const promptFile = path.join(EMERGENCY_LOG_DIR, `prompt-${sessionName}.txt`);
        fs.writeFileSync(promptFile, prompt);
        execSync(`tmux load-buffer "${promptFile}"`, { stdio: 'pipe' });
        execSync(`tmux paste-buffer -t "${sessionName}"`, { stdio: 'pipe' });
        // Brief pause then send Enter
        setTimeout(() => {
          try {
            execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: 'pipe' });
            console.log(`[${new Date().toISOString()}] Prompt sent to ${sessionName}`);
            // Clean up prompt file
            fs.unlinkSync(promptFile);
          } catch (e) {
            console.error(`[${new Date().toISOString()}] Failed to send Enter:`, e.message);
          }
        }, 500);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Failed to send prompt:`, e.message);
      }
    }, 15000); // Wait 15 seconds for Claude to initialize

    console.log(`[${new Date().toISOString()}] Emergency worker launched: ${sessionName}`);

    // Start polling for completion
    pollWorkerCompletion(sessionName);

    return { success: true, sessionName };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to launch emergency worker:`, err.message);
    return { success: false, error: err.message };
  }
}

function pollWorkerCompletion(sessionName) {
  const checkInterval = setInterval(() => {
    // Check if tmux session still exists
    try {
      execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
      // Session still running
    } catch {
      // Session ended - mark as complete
      clearInterval(checkInterval);

      const worker = emergencyWorkers.get(sessionName);
      if (worker) {
        worker.status = 'complete';
        worker.completedAt = new Date().toISOString();

        // Try to read summary from log file
        try {
          const summaryPath = path.join(EMERGENCY_LOG_DIR, 'SUMMARY.md');
          if (fs.existsSync(summaryPath)) {
            worker.summary = fs.readFileSync(summaryPath, 'utf-8');
            // Archive the summary with timestamp
            const archivePath = path.join(EMERGENCY_LOG_DIR, `summary-${sessionName}.md`);
            fs.copyFileSync(summaryPath, archivePath);
          }
        } catch (e) {
          console.error('Failed to read summary:', e.message);
        }

        console.log(`[${new Date().toISOString()}] Emergency worker complete: ${sessionName}`);
      }
    }
  }, 5000); // Check every 5 seconds

  // Safety timeout - stop polling after 30 minutes
  setTimeout(() => {
    clearInterval(checkInterval);
    const worker = emergencyWorkers.get(sessionName);
    if (worker && worker.status === 'running') {
      worker.status = 'timeout';
      console.log(`[${new Date().toISOString()}] Emergency worker timed out: ${sessionName}`);
    }
  }, 30 * 60 * 1000);
}

// API: Launch emergency worker
app.post('/api/emergency-worker', (req, res) => {
  const { mode = 'simple', message = '' } = req.body;

  if (!['simple', 'bug', 'other'].includes(mode)) {
    return res.status(400).json({ success: false, error: 'Invalid mode' });
  }

  console.log(`[${new Date().toISOString()}] Emergency worker requested: mode=${mode}`);
  const result = launchEmergencyWorker(mode, message);
  res.json(result);
});

// API: Get emergency worker status
app.get('/api/emergency-workers', (req, res) => {
  const workers = [];
  emergencyWorkers.forEach((data, sessionName) => {
    workers.push({ sessionName, ...data });
  });

  // Sort by startedAt descending (newest first)
  workers.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

  res.json({ workers });
});

// API: Get specific worker summary
app.get('/api/emergency-worker/:sessionName', (req, res) => {
  const { sessionName } = req.params;
  const worker = emergencyWorkers.get(sessionName);

  if (!worker) {
    return res.status(404).json({ error: 'Worker not found' });
  }

  res.json({ sessionName, ...worker });
});

// API: Kill an emergency worker
app.delete('/api/emergency-worker/:sessionName', (req, res) => {
  const { sessionName } = req.params;

  try {
    execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
  } catch {
    // Session may already be dead
  }

  const worker = emergencyWorkers.get(sessionName);
  if (worker) {
    worker.status = 'killed';
    worker.completedAt = new Date().toISOString();
  }

  res.json({ success: true });
});

// API: Clear completed workers from tracking
app.post('/api/emergency-workers/cleanup', (req, res) => {
  let cleaned = 0;
  emergencyWorkers.forEach((data, sessionName) => {
    if (data.status !== 'running') {
      emergencyWorkers.delete(sessionName);
      cleaned++;
    }
  });

  res.json({ success: true, cleaned });
});

// Serve the PWA
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] Watchdog running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Emergency log dir: ${EMERGENCY_LOG_DIR}`);
});
