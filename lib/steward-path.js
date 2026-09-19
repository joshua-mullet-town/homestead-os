/**
 * Resolve a steward id (possibly with `--` segments for nested substewards)
 * to its on-disk directory under ~/.homestead/stewards.
 *
 * Convention (matches app/api/sessions/route.ts):
 *   "rooster"                   -> ~/.homestead/stewards/rooster
 *   "venture--foreman"          -> ~/.homestead/stewards/venture/substewards/foreman
 *   "venture--foreman--worker"  -> ~/.homestead/stewards/venture/substewards/foreman/substewards/worker
 *
 * Returns the absolute path regardless of whether it exists on disk.
 */

const path = require('path');
const os = require('os');

const HOMESTEAD_DIR = path.join(os.homedir(), '.homestead');
const STEWARDS_DIR = path.join(HOMESTEAD_DIR, 'stewards');

function stewardIdToPath(stewardId) {
  if (!stewardId || typeof stewardId !== 'string') return null;
  const parts = stewardId.split('--').filter(Boolean);
  if (parts.length === 0) return null;

  let p = path.join(STEWARDS_DIR, parts[0]);
  for (let i = 1; i < parts.length; i++) {
    p = path.join(p, 'substewards', parts[i]);
  }
  return p;
}

module.exports = { stewardIdToPath, STEWARDS_DIR, HOMESTEAD_DIR };
