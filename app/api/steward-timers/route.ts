import { NextResponse } from 'next/server';
import { readdirSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import { loadStewardTimers } from './[stewardId]/route';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { STEWARDS_DIR } = require('@/lib/steward-path');

/**
 * GET /api/steward-timers
 *
 * Aggregated view: walks ~/.homestead/stewards/**\/timers.json and returns
 * every steward's timers in one response. Useful for Rooster's top-level
 * scheduler panel and debugging.
 *
 * Response:
 *   { stewards: [ <same shape as GET /:stewardId>, ... ] }
 */
export async function GET() {
  if (!existsSync(STEWARDS_DIR)) {
    return NextResponse.json({ stewards: [] });
  }

  const stewardIds = findAllStewardIdsWithTimers(STEWARDS_DIR).filter(id => id.length > 0);
  const stewards = stewardIds.map(id => loadStewardTimers(id));
  return NextResponse.json({ stewards });
}

/**
 * Walk ~/.homestead/stewards recursively; for every dir that contains a
 * timers.json, derive its stewardId (the "--"-joined path from STEWARDS_DIR
 * with "substewards" segments elided).
 *
 * e.g. ~/.homestead/stewards/venture/substewards/foreman/timers.json
 *   -> "venture--foreman"
 */
function findAllStewardIdsWithTimers(root: string): string[] {
  const ids: string[] = [];

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    if (entries.includes('timers.json')) {
      ids.push(dirToStewardId(dir, root));
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      }
    }
  }

  walk(root);
  return ids;
}

function dirToStewardId(dir: string, root: string): string {
  const rel = relative(root, dir);
  if (!rel) return '';
  const parts = rel.split('/').filter(p => p !== 'substewards');
  return parts.join('--');
}
