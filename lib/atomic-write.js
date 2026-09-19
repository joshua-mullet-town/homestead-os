/**
 * Shared ATOMIC file-write helper (queue.json torn-read fix, 2026-08-25).
 *
 * WHY THIS EXISTS
 * ~/.homestead/queue.json is written by ~15 independent processes (the
 * dispatcher, presenter-queue, the trigger and check cron scripts, several
 * app/api routes, and a few shell scripts via `node -e`). Historically every
 * one of them did a plain `writeFileSync(QUEUE_FILE, JSON.stringify(...))`.
 * A plain writeFileSync is NOT atomic: it truncates the file to length 0 and
 * then streams the new bytes in. Any OTHER process that `readFileSync`s the
 * file during that window sees a HALF-WRITTEN file → JSON.parse throws
 * "Unexpected end of JSON input" / "Unexpected non-whitespace after JSON".
 * The dispatcher treats that as a corrupt queue and retry-storms, which
 * saturated the :3005 event loop (the outage Rooster hotfixed on the highest-
 * frequency writer). This helper is the DURABLE fix: route EVERY writer
 * through it so a reader can never observe a torn file.
 *
 * HOW IT'S ATOMIC
 * Write the full new contents to a UNIQUE temp file in the SAME directory,
 * then `rename()` it over the destination. POSIX `rename(2)` within one
 * filesystem is atomic: a concurrent reader opening the destination path sees
 * EITHER the complete old file OR the complete new file — never a mix, never a
 * zero-length truncation. The temp file MUST be on the same filesystem as the
 * destination (same dir guarantees this) or rename() falls back to a
 * non-atomic copy. Unique temp name (pid + hrtime) so two concurrent writers
 * never collide on the temp path.
 */
const fs = require('fs');
const path = require('path');

function tmpNameFor(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  // pid + high-res counter keeps two concurrent writers of the same target
  // from ever choosing the same temp path.
  const uniq = `${process.pid}-${process.hrtime.bigint().toString(36)}`;
  return path.join(dir, `.${base}.tmp-${uniq}`);
}

/**
 * Atomically write `data` (a string) to `filePath`. Synchronous.
 * Throws on failure (caller decides whether to swallow) — but always cleans up
 * the temp file if the rename never happened.
 */
function writeFileAtomicSync(filePath, data) {
  const tmp = tmpNameFor(filePath);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Rename failed (or the write did) — make sure we don't leak a temp file
    // that a directory-scan or `.tmp` racer could later trip over.
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * Convenience: atomically write a value as pretty-printed JSON.
 */
function writeJsonAtomicSync(filePath, value) {
  writeFileAtomicSync(filePath, JSON.stringify(value, null, 2));
}

module.exports = { writeFileAtomicSync, writeJsonAtomicSync, tmpNameFor };
