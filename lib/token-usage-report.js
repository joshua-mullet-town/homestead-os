#!/usr/bin/env node

/**
 * Token Usage Report — scans Claude Code session JSONL files and produces
 * a per-steward token usage report with estimated costs.
 *
 * Usage:
 *   node lib/token-usage-report.js --hours 24        # last 24 hours (default)
 *   node lib/token-usage-report.js --hours 168       # last 7 days
 *   node lib/token-usage-report.js --current         # active sessions only
 *   node lib/token-usage-report.js --hours 24 --json # JSON output
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

// ---------------------------------------------------------------------------
// Pricing per million tokens
// ---------------------------------------------------------------------------
const PRICING = {
  sonnet: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.30 },
  opus:   { input: 15, output: 75, cache_write: 3.75, cache_read: 0.30 },
  haiku:  { input: 0.80, output: 4, cache_write: 1, cache_read: 0.08 },
};

function getTier(model) {
  if (!model) return 'sonnet';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet'; // default / sonnet
}

function cost(tokens, pricePerMillion) {
  return (tokens / 1_000_000) * pricePerMillion;
}

// ---------------------------------------------------------------------------
// Map project directory name to a human-readable steward name
// ---------------------------------------------------------------------------
function dirToSteward(dirName) {
  // Strip the leading user path prefix
  let name = dirName;

  // Steward paths: -Users-joshuamullet--homestead-stewards-venture-substewards-sales
  const stewardMatch = name.match(/--homestead-stewards-(.+)/);
  if (stewardMatch) {
    // Convert: venture-substewards-sales-substewards-sales-rep → venture/sales/sales-rep
    return stewardMatch[1]
      .replace(/-substewards-/g, '/')
      .replace(/^/, 'steward:');
  }

  // Legacy siswapts: -Users-joshuamullet--homestead-siswapts-repairman
  const siswaptMatch = name.match(/--homestead-siswapts-(.+)/);
  if (siswaptMatch) {
    return 'siswapt:' + siswaptMatch[1];
  }

  // Guest sessions: -Users-joshuamullet--homestead-guest-sessions-<<REPLACE: your-secondary-account>>
  const guestMatch = name.match(/--homestead-guest-sessions-(.+)/);
  if (guestMatch) {
    return 'guest:' + guestMatch[1];
  }

  // Homestead misc: -Users-joshuamullet--homestead-alert-worker
  const homesteadMatch = name.match(/--homestead-(.+)/);
  if (homesteadMatch) {
    return 'homestead:' + homesteadMatch[1];
  }

  // Worktrees: -Users-joshuamullet--worktrees-GiveGrove-cicd-debug
  const worktreeMatch = name.match(/--worktrees-(.+)/);
  if (worktreeMatch) {
    return 'worktree:' + worktreeMatch[1];
  }

  // Code projects: -Users-joshuamullet-code-GiveGrove
  const codeMatch = name.match(/-code-(.+)/);
  if (codeMatch) {
    return codeMatch[1];
  }

  // Bare user dir: -Users-joshuamullet
  if (name === '-Users-joshuamullet') {
    return '~user-root';
  }

  return name;
}

// ---------------------------------------------------------------------------
// Load session metadata to correlate session IDs to tmux sessions
// ---------------------------------------------------------------------------
function loadSessionMeta() {
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  const map = {}; // sessionId → { tmuxSession, cwd, status }
  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
        if (data.sessionId) {
          map[data.sessionId] = {
            tmuxSession: data.tmuxSession || null,
            cwd: data.cwd || null,
            status: data.status || null,
          };
        }
      } catch { /* skip corrupt files */ }
    }
  } catch { /* sessions dir missing */ }
  return map;
}

// ---------------------------------------------------------------------------
// Discover all JSONL files grouped by project directory
// ---------------------------------------------------------------------------
function discoverFiles(cutoffMs, currentOnly, sessionMeta) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const results = []; // { filePath, projectDir, sessionId }

  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    console.error('No projects directory found at', projectsDir);
    process.exit(1);
  }

  // Collect active session IDs if --current
  const activeSessionIds = new Set();
  if (currentOnly) {
    for (const [sid, meta] of Object.entries(sessionMeta)) {
      if (meta.status === 'working' || meta.status === 'waiting') {
        activeSessionIds.add(sid);
      }
    }
  }

  for (const dir of dirs) {
    const dirPath = path.join(projectsDir, dir);
    let stat;
    try { stat = fs.statSync(dirPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f);
      const sessionId = f.replace('.jsonl', '');

      // Skip by mtime if outside time range
      if (cutoffMs) {
        try {
          const fstat = fs.statSync(filePath);
          if (fstat.mtimeMs < cutoffMs) continue;
        } catch { continue; }
      }

      // Skip if --current and session not active
      if (currentOnly && !activeSessionIds.has(sessionId)) continue;

      results.push({ filePath, projectDir: dir, sessionId });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stream a JSONL file and extract usage data
// ---------------------------------------------------------------------------
function processFile(filePath, cutoffMs) {
  return new Promise((resolve, reject) => {
    const usages = []; // { model, input, output, cache_write, cache_read }
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      // Quick pre-filter: skip lines that can't have usage
      if (!line.includes('"usage"')) return;

      try {
        const obj = JSON.parse(line);
        const msg = obj.message;
        if (!msg || msg.role !== 'assistant' || !msg.usage) return;

        // If we have a cutoff, check timestamp if available
        // (JSONL lines don't always have timestamps, so we rely on file mtime for pre-filter)

        const u = msg.usage;
        usages.push({
          model: msg.model || null,
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cache_write: u.cache_creation_input_tokens || 0,
          cache_read: u.cache_read_input_tokens || 0,
        });
      } catch { /* skip malformed lines */ }
    });

    rl.on('close', () => resolve(usages));
    rl.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  let hours = 24;
  let jsonOutput = false;
  let currentOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hours' && args[i + 1]) {
      hours = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (args[i] === '--current') {
      currentOnly = true;
      hours = null;
    }
  }

  const cutoffMs = hours ? Date.now() - hours * 3600 * 1000 : null;
  const sessionMeta = loadSessionMeta();

  const files = discoverFiles(cutoffMs, currentOnly, sessionMeta);

  if (files.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ stewards: [], timeRange: currentOnly ? 'current' : `${hours}h`, totalCost: 0 }));
    } else {
      console.log('No session files found in the specified time range.');
    }
    return;
  }

  // Aggregate by steward
  const stewards = {}; // stewardName → { input, output, cache_write, cache_read, cost, sessions, models }

  // Process files in parallel (batches of 20 to avoid fd exhaustion)
  const BATCH = 20;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async ({ filePath, projectDir, sessionId }) => {
        const usages = await processFile(filePath, cutoffMs);
        return { projectDir, sessionId, usages };
      })
    );

    for (const { projectDir, sessionId, usages } of results) {
      if (usages.length === 0) continue;

      // Determine steward name — prefer tmux session metadata
      let stewardName;
      const meta = sessionMeta[sessionId];
      if (meta && meta.tmuxSession) {
        stewardName = meta.tmuxSession.replace(/^holler-/, '');
      } else {
        stewardName = dirToSteward(projectDir);
      }

      if (!stewards[stewardName]) {
        stewards[stewardName] = {
          input: 0, output: 0, cache_write: 0, cache_read: 0,
          cost: 0, sessions: 0, models: new Set(),
        };
      }

      const s = stewards[stewardName];
      s.sessions++;

      for (const u of usages) {
        const tier = getTier(u.model);
        const p = PRICING[tier];
        s.models.add(tier);
        s.input += u.input;
        s.output += u.output;
        s.cache_write += u.cache_write;
        s.cache_read += u.cache_read;
        s.cost +=
          cost(u.input, p.input) +
          cost(u.output, p.output) +
          cost(u.cache_write, p.cache_write) +
          cost(u.cache_read, p.cache_read);
      }
    }
  }

  // Sort by cost descending
  const sorted = Object.entries(stewards).sort((a, b) => b[1].cost - a[1].cost);

  const timeLabel = currentOnly ? 'active sessions' : `last ${hours}h`;

  if (jsonOutput) {
    const data = {
      timeRange: timeLabel,
      generatedAt: new Date().toISOString(),
      totalCost: sorted.reduce((sum, [, s]) => sum + s.cost, 0),
      totalSessions: files.length,
      stewards: sorted.map(([name, s]) => ({
        name,
        input_tokens: s.input,
        output_tokens: s.output,
        cache_write_tokens: s.cache_write,
        cache_read_tokens: s.cache_read,
        estimated_cost: Math.round(s.cost * 100) / 100,
        sessions: s.sessions,
        models: [...s.models],
      })),
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Table output
  const totalCost = sorted.reduce((sum, [, s]) => sum + s.cost, 0);

  console.log();
  console.log(`  Token Usage Report — ${timeLabel}`);
  console.log(`  Generated: ${new Date().toISOString()}`);
  console.log(`  Files scanned: ${files.length}`);
  console.log();

  // Header
  const cols = {
    name: 30,
    input: 14,
    output: 14,
    cacheW: 14,
    cacheR: 14,
    cost: 10,
    sess: 6,
    models: 12,
  };

  const pad = (s, n) => String(s).padStart(n);
  const padL = (s, n) => String(s).padEnd(n);
  const fmtTokens = (n) => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  };
  const fmtCost = (n) => '$' + n.toFixed(2);

  console.log(
    '  ' +
    padL('Steward', cols.name) +
    pad('Input', cols.input) +
    pad('Output', cols.output) +
    pad('Cache Write', cols.cacheW) +
    pad('Cache Read', cols.cacheR) +
    pad('Cost', cols.cost) +
    pad('Sess', cols.sess) +
    '  Models'
  );
  console.log('  ' + '-'.repeat(cols.name + cols.input + cols.output + cols.cacheW + cols.cacheR + cols.cost + cols.sess + 10));

  for (const [name, s] of sorted) {
    const displayName = name.length > cols.name - 1 ? name.slice(0, cols.name - 2) + '..' : name;
    console.log(
      '  ' +
      padL(displayName, cols.name) +
      pad(fmtTokens(s.input), cols.input) +
      pad(fmtTokens(s.output), cols.output) +
      pad(fmtTokens(s.cache_write), cols.cacheW) +
      pad(fmtTokens(s.cache_read), cols.cacheR) +
      pad(fmtCost(s.cost), cols.cost) +
      pad(s.sessions, cols.sess) +
      '  ' + [...s.models].join(',')
    );
  }

  console.log('  ' + '-'.repeat(cols.name + cols.input + cols.output + cols.cacheW + cols.cacheR + cols.cost + cols.sess + 10));

  const totals = sorted.reduce(
    (acc, [, s]) => {
      acc.input += s.input; acc.output += s.output;
      acc.cache_write += s.cache_write; acc.cache_read += s.cache_read;
      return acc;
    },
    { input: 0, output: 0, cache_write: 0, cache_read: 0 }
  );

  console.log(
    '  ' +
    padL('TOTAL', cols.name) +
    pad(fmtTokens(totals.input), cols.input) +
    pad(fmtTokens(totals.output), cols.output) +
    pad(fmtTokens(totals.cache_write), cols.cacheW) +
    pad(fmtTokens(totals.cache_read), cols.cacheR) +
    pad(fmtCost(totalCost), cols.cost) +
    pad(files.length, cols.sess)
  );
  console.log();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
