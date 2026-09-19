// Human/steward-readable timestamps: LOCAL clock plus the UTC offset it was
// taken in, e.g. "2026-09-15 10:08:31 -04:00".
//
// WHY THIS EXISTS. Fleet state files and walkie _queue_ids are UTC, which is
// correct for machine-parsed values. But a bare ...Z reads as local at a glance:
// a steward misread exactly these fields for ~73 entries on 2026-09-14/15, a
// 4-hour error in the values used to judge whether Josh is at his desk, at
// dinner, or asleep. A trailing Z is not a safeguard -- the misread strings
// already had one and it carried no weight.
//
// FLEET DOCTRINE (Steward Manager, 2026-09-15), as amended: the test is WHO
// READS THE VALUE, not which file it lives in. Machine-parsed field -> keep UTC
// (toISOString). Steward- or human-read field -> use this, even when the line
// sits inside a checker.
//
// NEVER HARDCODE THE OFFSET. This machine runs America/Indiana/Indianapolis:
// -4 in summer, -5 after the November DST flip. The offset is derived from the
// date being formatted, so a December timestamp correctly renders -05:00.
// Verified across the ambiguous repeated 1:30am hour on Nov 1, where both
// instants render 01:30:00 but carry -04:00 and -05:00 respectively and so
// stay distinguishable.
function localStamp(d = new Date()) {
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `
       + `${sign}${p(off / 60 | 0)}:${p(off % 60)}`;
}

module.exports = { localStamp };
