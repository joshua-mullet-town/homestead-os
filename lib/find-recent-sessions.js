#!/usr/bin/env node
/**
 * Find Claude Code session logs modified within a time window.
 *
 * Usage:
 *   node find-recent-sessions.js [minutes]
 *
 * Examples:
 *   node find-recent-sessions.js        # Last 15 minutes (default)
 *   node find-recent-sessions.js 60     # Last 60 minutes
 *   node find-recent-sessions.js 1440   # Last 24 hours
 *
 * Output: JSON array of { project, path, modifiedAt }
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects');

function findRecentSessions(minutes = 15) {
  // Find JSONL files modified within the time window
  const cmd = `find "${CLAUDE_PROJECTS_DIR}" -name "*.jsonl" -mmin -${minutes} -type f 2>/dev/null`;

  let output;
  try {
    output = execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch (err) {
    // find returns error if no matches, that's fine
    output = '';
  }

  if (!output) {
    return [];
  }

  const files = output.split('\n').filter(Boolean);

  return files.map(filePath => {
    // Extract project name from path
    // Patterns:
    //   -Users-joshuamullet-code-{project}/  → project
    //   -Users-joshuamullet--worktrees-{project}-{branch}/  → project (worktree)
    //   -Users-joshuamullet-code/  → "code" (root level)
    let project = 'unknown';

    const codeMatch = filePath.match(/-code-([^/]+)\//);
    const worktreeMatch = filePath.match(/--worktrees-([^-/]+)/);
    const rootMatch = filePath.match(/-code\/[^/]+\.jsonl$/);
    // Guest session: --homestead-guest-sessions-{shortName} or with sub-session
    const guestMatch = filePath.match(/--homestead-guest-sessions-([^/]+)\//);

    if (guestMatch) {
      // Extract guest shortName, handle sub-sessions like <<REPLACE: your-secondary-account>>-test-me-dawg
      const parts = guestMatch[1].split('-');
      // The shortName is typically the first segment (<<REPLACE: your-secondary-account>>)
      // Sub-sessions append -sessionname (<<REPLACE: your-secondary-account>>-test-me-dawg)
      project = `guest-${guestMatch[1]}`;
    } else if (codeMatch) {
      project = codeMatch[1];
    } else if (worktreeMatch) {
      project = worktreeMatch[1];
    } else if (rootMatch) {
      project = 'code-root';
    }

    // Get modification time
    const stats = fs.statSync(filePath);

    return {
      project,
      path: filePath,
      modifiedAt: stats.mtime.toISOString(),
    };
  });
}

// CLI usage
if (require.main === module) {
  const minutes = parseInt(process.argv[2]) || 15;
  const sessions = findRecentSessions(minutes);

  console.log(JSON.stringify({
    searchWindow: `${minutes} minutes`,
    count: sessions.length,
    sessions,
  }, null, 2));
}

module.exports = { findRecentSessions };
