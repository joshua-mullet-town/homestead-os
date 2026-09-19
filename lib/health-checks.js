/**
 * health-checks.js — "is something DOWN or MISSING?" detectors for the
 * Presenter's health dot.
 *
 * WHY THIS IS SEPARATE FROM machine-stats.js
 * ------------------------------------------
 * machine-stats answers "how BUSY is the machine" — an informational signal
 * with nothing for Joshua to do about it. This module answers a different
 * question: "is a thing he relies on broken right now, and can he fix it?"
 * Josh, 2026-09-11: "if it's just red throbbing then we know that it's just
 * the CPU is running hot, but otherwise it would just be nice to take action
 * and actually fix whatever's going on."
 *
 * Conflating the two is precisely the confusion this exists to remove, so they
 * stay separate all the way up to two distinct colours on the dot.
 *
 * THE RULE EVERY DETECTOR MUST OBEY
 * ---------------------------------
 * Inherited from msSeverity() in the Presenter renderer, earned from a real
 * bug: "a verdict the reader can't trace back to a visible number is a bug."
 * So a detector never returns a bare boolean. Whatever turns the dot amber
 * MUST come with `detail` — the observed fact, in words, that a human can read
 * in the modal and check for themselves. If you cannot name what you observed,
 * you have not detected anything.
 *
 * THE OTHER RULE: NEVER CRY WOLF
 * ------------------------------
 * A detector that fires when nothing is actually wrong makes the dot useless,
 * and a useless warning light is worse than no warning light. Every detector
 * must be able to say "unknown" — and MUST prefer "unknown" over "down"
 * whenever it cannot distinguish a genuine failure from an absent precondition.
 * Only `state === 'down'` ever lights the dot.
 *
 * ADDING A DETECTOR
 * -----------------
 * Write an async function returning the shape below and add it to CHECKS.
 * Everything upstream — the API, the dot, the modal — is generic over the list.
 *
 *   {
 *     id:       stable slug, used as a key,
 *     title:    plain-English name of the thing ("Phone wireless debugging"),
 *     state:    'ok' | 'down' | 'unknown',
 *     summary:  one plain sentence a non-technical reader understands,
 *     detail:   the OBSERVED FACT behind the verdict (the traceability rule),
 *     fix:      optional { label, kind, target } — how to get close to fixing it,
 *   }
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fsSync = require('fs');
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);

// Detectors shell out to mDNS, which is slow and noisy; cache so the dot's
// 10-second poll doesn't hammer the network.
const CACHE_TTL_MS = 20000;
let cache = null;

/** The phone's advertised mDNS hostname. Resolving it proves it is on the LAN. */
const PHONE_MDNS_HOST = 'Android-2.local';
/** The Homestead app's own listener on the phone — a second presence signal. */
// Where the FCM device tokens live. ⚠️ /tmp is the fragility this check
// exists to catch: it is cleared periodically, nothing re-registers without
// the APK being opened, and all four readers in the codebase point here — so
// there is no durable copy to fall back on.
const FCM_TOKEN_FILE = '/tmp/homestead-fcm-tokens.json';
const PHONE_APP_PORT = 8888;

/**
 * Run a dns-sd command under a pseudo-terminal.
 *
 * ⚠️ dns-sd FULLY BUFFERS ITS OUTPUT WHEN STDOUT IS NOT A TTY. Piped normally
 * it returns ZERO BYTES — not even its own header — which reads exactly like
 * "nothing is advertised". That false negative would make the dot claim the
 * phone is broken 100% of the time. `script -q /dev/null` gives it a tty so it
 * flushes. (Verified 2026-09-11: identical command with and without the tty,
 * one saw the service and one saw nothing.)
 *
 * Related trap, same family: `adb mdns services` is BROKEN on this machine —
 * it prints its header and zero rows while dns-sd sees the service at the same
 * instant. Do not build any detector on it.
 */
async function dnsSd(args, timeoutSec) {
  const cmd = `timeout ${timeoutSec} script -q /dev/null dns-sd ${args} < /dev/null 2>&1`;
  const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 })
    // dns-sd never exits on its own, so `timeout` always kills it → non-zero
    // exit is EXPECTED here, and the output we want is already on stdout.
    .catch((e) => ({ stdout: (e && e.stdout) || '' }));
  return String(stdout || '');
}

/**
 * Is the phone actually here, on the home network?
 *
 * THIS GATE IS THE WHOLE REASON THE DETECTOR IS TRUSTWORTHY. Joshua is off his
 * home network often; a phone on cell service advertises nothing at all, which
 * is indistinguishable from wireless debugging being switched off unless we
 * check presence separately. Without this gate the dot would be amber every
 * time he left the house, and he would rightly stop believing it.
 *
 * THE VERDICT IS ALWAYS THE SAME ONE FACT: the Homestead app answers on an
 * address that is on THIS MACHINE'S OWN LAN SUBNET. Everything below is only
 * a way of LEARNING that address. Nothing here is ever the verdict by itself.
 *
 * ⚠️ THE BOOTSTRAP DEADLOCK THIS EXISTS TO KILL (Josh, 2026-09-17: "it's
 * currently saying that I'm not on the home network, but I am on the home
 * network"). The previous version had two signals and claimed "either one is
 * enough" — but signal 2 was gated on an address only signal 1 could produce:
 *
 *     const lastIp = cache && cache.data && cache.data.phoneIp;   // mDNS-only
 *     if (lastIp) { ...ask the app... }
 *
 * So the "second opinion" was only available once the first opinion had
 * already worked. When mDNS was the broken thing — which is exactly when a
 * fallback is needed — the fallback could never run, phoneIp stayed null
 * forever, and the dashboard told him he was not home while he was standing
 * in his kitchen. MEASURED on this machine: `dns-sd -G v4 Android-2.local`
 * returned nothing while `dns-sd -B` worked fine (so dns-sd itself was
 * healthy — it is specifically the hostname that stopped resolving), and the
 * phone answered `curl <<REPLACE: your LAN IP>>:8888/health` -> 200 the whole time.
 *
 * Any future edit here must keep the invariant: NO ADDRESS SOURCE MAY DEPEND
 * ON ANOTHER ADDRESS SOURCE HAVING ALREADY SUCCEEDED. They are tried in cost
 * order and each one stands alone.
 *
 *   1. mDNS resolves the phone's hostname (cheapest; the original path).
 *   2. The last address that worked, remembered ACROSS RESTARTS on disk.
 *   3. Ask the phone over Tailscale what its own LAN address is.
 *
 * ⚠️ WHY (3) DOES NOT SECRETLY ANSWER "IS HE HOME" WITH "IS TAILSCALE UP".
 * Tailscale reaches the phone from anywhere — a café, a plane — so treating
 * "Tailscale answered" as presence would be a new and worse lie. It is used
 * ONLY as a question-asking channel: we ask the app for `getLocalIpAddress()`
 * and then throw the Tailscale path away entirely. The answer only counts if
 * that address is inside this Mac's own subnet AND answers directly on the
 * LAN. When he is away the phone truthfully reports some other network's
 * address (or is unreachable), that fails the subnet test, and we correctly
 * say he is not home.
 *
 * ⚠️ AND WHY NOTHING HERE IS HARDCODED. The phone still tells us where it is,
 * which is the property the original comment was protecting; DHCP can move it
 * freely. A LAN sweep was measured as a working alternative (~2.8s for a /24)
 * but is strictly worse: it is 10x slower than asking (0.3s), sprays 254
 * connections across the network, and — measured — finds TWO devices running
 * the app (an old Pixel 6 at .84 as well as the real phone at .127), so it
 * cannot even answer WHICH phone without a tiebreak. Asking the phone we mean
 * by its stable Tailscale name is cheaper and unambiguous.
 */

/**
 * Remembered address, so a restart does not go blind until mDNS recovers.
 * Deliberately NOT in /tmp — see the FCM_TOKEN_FILE note above for why that
 * directory is itself a fragility this module exists to catch.
 */
const PHONE_IP_FILE = path.join(os.homedir(), '.homestead', 'phone-last-ip.json');

/** The phone's stable Tailscale name. Stable across DHCP; NOT an address. */
const PHONE_TS_HOST = process.env.PHONE_TS_HOST || 'pixel-9a-1';

function rememberPhoneIp(ip) {
  try {
    fsSync.writeFileSync(PHONE_IP_FILE, JSON.stringify({ ip, at: new Date().toISOString() }));
  } catch (e) { /* a failed write costs one slow lookup, never a wrong verdict */ }
}

function recallPhoneIp() {
  try {
    return JSON.parse(fsSync.readFileSync(PHONE_IP_FILE, 'utf8')).ip || null;
  } catch (e) { return null; }
}

/**
 * Every IPv4 subnet this machine is actually on, as { base: '10.0.0', ... }.
 * Tailscale's own 100.x CGNAT range is excluded on purpose: it is reachable
 * from anywhere, so counting it as "the home network" would reintroduce the
 * lie in a new form.
 */
function localSubnets() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^100\./.test(a.address)) continue;          // Tailscale CGNAT
      out.push(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return out;
}

/** Is this address on a subnet this machine is physically attached to? */
function isOnLocalLan(ip) {
  if (!ip) return false;
  const base = String(ip).split('.').slice(0, 3).join('.');
  return localSubnets().includes(base);
}

/**
 * Does the Homestead app answer at this address — and is it really OUR app?
 *
 * `GET /` returns a self-identifying banner rather than the bare "healthy" of
 * /health, so a stranger's device that happens to run something on 8888 can
 * never be mistaken for the phone:
 *
 *   {"name":"Homestead Mobile API","version":"1.0.0","ip":"<<REPLACE: your LAN IP>>"}
 *
 * Returns the address the app says it has, or null.
 */
async function askHomesteadApp(host, timeoutSec) {
  try {
    const { stdout } = await execAsync(
      `curl -s -m ${timeoutSec} http://${host}:${PHONE_APP_PORT}/`
    );
    const j = JSON.parse(String(stdout).trim());
    if (!j || j.success !== true || !j.data) return null;
    if (j.data.name !== 'Homestead Mobile API') return null;
    return j.data.ip || null;
  } catch (e) { return null; }
}

async function detectPhonePresence() {
  // --- 1. mDNS: cheapest, and the phone names its own address ---
  const out = await dnsSd(`-G v4 ${PHONE_MDNS_HOST}`, 4);
  // A resolution line looks like:
  //   17:13:53.558  Add  2  11  Android-2.local.  <<REPLACE: your LAN IP>>  120
  const m = out.match(/Add\s+[0-9a-fA-F]+\s+\d+\s+\S+\s+(\d+\.\d+\.\d+\.\d+)/);
  if (m) {
    rememberPhoneIp(m[1]);
    return { present: true, ip: m[1], via: 'it answered to its own name there' };
  }

  // --- 2. the address that worked last time, from disk ---
  // Survives a restart, and costs one 3s request when the phone has not moved.
  // Independent of (1): it is read from disk, not from anything mDNS produced
  // this run. That independence is the whole fix.
  const remembered = recallPhoneIp();
  if (isOnLocalLan(remembered) && await askHomesteadApp(remembered, 3)) {
    return { present: true, ip: remembered, via: 'the Homestead app on it answered' };
  }

  // --- 3. ask the phone, over Tailscale, where it is on the LAN ---
  // The Tailscale path proves nothing about presence and is discarded; only
  // the LAN address it reports is kept, and only if it passes the subnet test
  // and answers directly. See the long note above.
  const claimed = await askHomesteadApp(PHONE_TS_HOST, 5);
  if (isOnLocalLan(claimed) && await askHomesteadApp(claimed, 3)) {
    rememberPhoneIp(claimed);
    return {
      present: true,
      ip: claimed,
      via: 'the Homestead app on it answered on your home network',
    };
  }

  return { present: false, ip: null, via: null };
}

/**
 * Android wireless debugging.
 *
 * When it is ON, the phone advertises `_adb-tls-connect._tcp` over mDNS. When
 * it is OFF, nothing is advertised at all — that silence IS the signal. The
 * port is random per enable, so it is never hardcoded (and never needed: we
 * only care that an instance exists).
 *
 * Android switches this OFF at every reboot and no app can prevent it, which
 * is exactly why it is worth watching.
 */
async function checkWirelessDebugging() {
  const base = {
    id: 'adb-wireless',
    title: 'Phone wireless debugging',
    // "it should just help me get there fast ... give me a link that gets me at
    // least close to that app so I can find it" — Josh, 2026-09-11. Close is
    // explicitly good enough, so this deliberately does NOT chase a deep link
    // into the toggle itself: Android exposes no such link, and the phone's
    // open-uri endpoint only fires ACTION_VIEW (an `intent:` URI comes back
    // "No Activity found" — tested 2026-09-11). Opening Settings is the
    // furthest we can reliably get him, and it is verified working.
    fix: {
      label: 'Open Settings on my phone',
      kind: 'phone-app',
      target: 'com.android.settings',
      hint: 'Then: System \u2192 Developer options \u2192 Wireless debugging.',
    },
  };

  const advertised = await dnsSd('-B _adb-tls-connect._tcp local', 5);
  // A real instance row carries an "Add" action. The header alone is not a hit.
  const isAdvertising = /\bAdd\b/.test(advertised);

  if (isAdvertising) {
    return {
      ...base,
      state: 'ok',
      summary: 'Your phone is reachable for debugging.',
      detail: 'The phone is announcing itself for wireless debugging right now.',
    };
  }

  // Nothing advertised. Before calling that "down", prove the phone is even
  // here — otherwise we are just detecting that Joshua left the house.
  const presence = await detectPhonePresence();
  if (!presence.present) {
    return {
      ...base,
      state: 'unknown',
      summary: "Can't tell — your phone isn't on the home network.",
      detail:
        'Your phone is not answering on the home network, so there is no way to '
        + 'tell whether wireless debugging is switched off or the phone is simply '
        + 'somewhere else. Not raising an alert for this.',
      phoneIp: null,
    };
  }

  return {
    ...base,
    state: 'down',
    summary: 'Wireless debugging on your phone is switched off.',
    detail:
      'Your phone is on the home network — ' + presence.via + ' — but it is not '
      + 'announcing itself for debugging. Android switches this off every time '
      + 'the phone restarts, and no app can stop it.',
    phoneIp: presence.ip,
  };
}

/**
 * Phone notifications — a REAL DELIVERY TEST, not a configuration check.
 *
 * Josh, 2026-09-15: "somehow figure out if notifications are going through...
 * Get more creative than this, kind of being a pansy about it. Come up with a
 * better test than that."
 *
 * He was right, and the first version of this check was the exact failure it
 * was built to detect. It verified that the system was ARMED — credential
 * present, a device token on file — and reported 'ok'. Then a live probe was
 * run by hand:
 *
 *     POST /api/fcm/send  ->  {"success":true,"sent":1,"failed":0}
 *     the phone's own tray, polled for 18s  ->  the notification NEVER ARRIVED
 *
 * FCM ACCEPTING A PUSH IS NOT DELIVERY. Google took it and reported success;
 * the phone never showed it. An armed-only check is green through precisely
 * this failure, which is the one Josh has actually been living with. A health
 * check that cannot see the failure it was commissioned for is decoration.
 *
 * HOW THIS PROVES DELIVERY:
 * the Homestead app on the phone runs a NotificationListener and exposes the
 * phone's OWN notification tray at GET :8888/notifications. That is ground
 * truth from the device — not our belief about the device. So:
 *
 *   1. send a push carrying a unique marker
 *   2. poll the phone's real tray for that marker
 *   3. found      -> delivery genuinely works, end to end
 *      not found  -> it is being dropped AFTER Google accepts it, which is
 *                    invisible to every other signal we have
 *   4. dismiss the probe notification so it leaves no litter
 *
 * ⚠️ WHY THIS DOES NOT SPAM HIM — the reason the first version chickened out,
 * solved rather than avoided. getHealthChecks() runs on a ~60s loop, so
 * probing on every call would buzz his phone every minute forever. The probe
 * therefore has its OWN slow clock (PROBE_INTERVAL_MS) and its own cached
 * verdict: at most one probe every 30 minutes, and every other call reports
 * the last real result. The push is sent SILENT (`silent: true` — no sound, no
 * vibration, min priority) and dismissed within seconds of arriving.
 *
 * ⚠️ THIS COMMENT USED TO CLAIM the probe went out "on a LOW-IMPORTANCE channel
 * ... so in practice he never sees it." That was FALSE and cost Josh three days
 * of mystery buzzing. It has always gone out on `homestead_presenter`, which is
 * IMPORTANCE_HIGH (HomesteadApp.kt) — a heads-up banner with sound, every 30
 * minutes. The comment described the intent; nothing implemented it. If you are
 * about to trust a comment here about how quiet this is, verify it against the
 * channel definition and the actual send payload instead.
 *
 * ⚠️ AND IT NEVER CRIES WOLF. A probe can fail to arrive for reasons that are
 * not a notification fault — the phone is off the network, asleep, or the
 * listener permission is off. Each of those returns 'unknown', never 'down'.
 * Only "the phone is here, the listener is on, we sent it, and it did not
 * arrive" is graded as a genuine failure.
 */

/** At most one real push every 30 minutes. See the spam note above. */
const PROBE_INTERVAL_MS = 30 * 60 * 1000;
/** How long to wait for a push to show up in the phone's tray. */
const PROBE_WAIT_MS = 20000;
const PROBE_POLL_MS = 2500;
/** Last real probe result, reused between probes so the lamp is never blank. */
let probeCache = null;   // { at, verdict }
/** Guard so the 60s poll cannot stack up overlapping probes. */
let probeInFlight = false;

async function phoneGet(ip, route, timeoutSec) {
  const { stdout } = await execAsync(
    `curl -s -m ${timeoutSec} http://${ip}:${PHONE_APP_PORT}${route}`
  );
  return JSON.parse(String(stdout).trim());
}

/**
 * Dismiss one notification on the phone, LAN first then Tailscale.
 *
 * ⚠️ WHY THE FALLBACK EXISTS — a MEASURED failure, 2026-09-18. The probe's
 * cleanup used the LAN address from presence detection and nothing else. But
 * the push itself is delivered by Google over the internet, so the probe still
 * ARRIVES when Josh is off the LAN (phone on cellular, or the DHCP lease moved)
 * while the dismissal cannot reach him. Result: the self-test STRANDS in his
 * tray instead of vanishing. Found live — a probe sent 18:02 was still sitting
 * there 29 minutes later, after he'd already been told these clean themselves
 * up. Delivery and cleanup do NOT share a transport, so cleanup needs its own.
 *
 * ⚠️ This deliberately does NOT touch presence/isOnLocalLan. That code excludes
 * the 100.x range ON PURPOSE so "is he home" stays honest — reachable-anywhere
 * is exactly what must not count as being home. Reaching him to CLEAN UP is a
 * different question from whether he is home, and only the former may use it.
 */
async function dismissOnPhone(lanIp, key) {
  const body = `-H 'Content-Type: application/json' -d '${JSON.stringify({ key })}'`;
  const hosts = [lanIp, PHONE_TS_HOST].filter(Boolean);
  for (const host of hosts) {
    try {
      const { stdout } = await execAsync(
        `curl -s -m 6 -X POST http://${host}:${PHONE_APP_PORT}/notifications/dismiss ${body}`
      );
      if (JSON.parse(String(stdout).trim()).success === true) return true;
    } catch (e) { /* try the next transport */ }
  }
  return false;   // litter is better than a false alarm
}

/**
 * Send one marked push and watch the phone's real tray for it.
 * Returns { delivered: bool, marker, key|null, waitedMs }.
 */
async function runDeliveryProbe(ip) {
  const marker = 'hs-probe-' + Date.now().toString(36);

  const payload = JSON.stringify({
    title: 'Homestead self-test',
    body: marker,
    // ⚠️ Probe the channel Josh's CARDS actually use, not a quiet one.
    // Testing a different channel would pass while the channel he depends on
    // is blocked — measured 2026-09-15: presenter, alerts and recording ALL
    // failed to arrive, so the block is app-wide rather than per-channel, but
    // a future per-channel block must be caught on the channel that matters.
    channelId: 'homestead_presenter',
    // 🚨 SILENT. This is a self-test, not a message for him. Without this it
    // arrives with a full banner AND sound every 30 minutes — which is exactly
    // what happened: Josh, 2026-09-18, "I keep on getting these notifications
    // ... some automated process is fucking going on. What the hell is that?"
    // He chose to keep the test and silence it. The channel stays 'presenter'
    // on purpose (see above), so do not silence this by switching channels.
    silent: true,
    data: { probe: '1' },
  });
  const { stdout } = await execAsync(
    `curl -s -m 10 -X POST http://localhost:3005/api/fcm/send `
    + `-H 'Content-Type: application/json' -d '${payload}'`
  );
  const sendResult = JSON.parse(String(stdout).trim());
  if (!sendResult || sendResult.success !== true || !sendResult.sent) {
    // Could not even hand it to Google. Distinct from "sent but not delivered".
    return { delivered: false, marker, key: null, waitedMs: 0, sendFailed: true,
             sendError: (sendResult && sendResult.error) || 'send reported no recipients' };
  }

  const deadline = Date.now() + PROBE_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PROBE_POLL_MS));
    let tray;
    try {
      tray = await phoneGet(ip, '/notifications', 6);
    } catch (e) {
      continue;   // a flaky read is not a verdict; keep watching
    }
    const items = (tray && (tray.data || tray.notifications)) || [];
    const hit = items.find((n) => JSON.stringify(n).includes(marker));
    if (hit) {
      // Clean up after ourselves so the probe leaves no trace in his tray.
      if (hit.key) await dismissOnPhone(ip, hit.key);
      return { delivered: true, marker, key: hit.key || null,
               waitedMs: PROBE_WAIT_MS - (deadline - Date.now()) };
    }
  }
  return { delivered: false, marker, key: null, waitedMs: PROBE_WAIT_MS };
}

async function checkPhoneNotifications() {
  const base = {
    id: 'phone-notifications',
    title: 'Phone notifications',
    fix: {
      label: 'Open Homestead on my phone',
      // 'phone-app' is the ONLY kind the POST handler supports.
      kind: 'phone-app',
      target: 'com.homestead.mobile',
      hint: 'Opening the app re-registers it and refreshes its notification settings.',
    },
  };

  // --- the one precondition that makes everything else moot ---
  const CREDENTIAL = path.join(os.homedir(), '.homestead', 'firebase-service-account.json');
  if (!fsSync.existsSync(CREDENTIAL)) {
    return {
      ...base,
      state: 'down',
      summary: 'Notifications are switched off at the source.',
      detail:
        'The Google credential Homestead needs in order to send anything to '
        + 'your phone is missing from this machine, so every notification is '
        + 'dropped before it leaves. Opening the app will not fix this one.',
      fix: null,
      phoneIp: null,
    };
  }

  // --- is the phone even here? off-network is never a fault ---
  const presence = await detectPhonePresence();
  if (!presence.present) {
    return {
      ...base,
      state: 'unknown',
      summary: "Can't tell — your phone isn't on the home network.",
      detail:
        'A real delivery test needs to read your phone\'s own notification tray, '
        + 'and the phone is not answering here, so there is no way to tell '
        + 'whether notifications are arriving. Not raising an alert for this.',
      phoneIp: null,
    };
  }

  // --- can we read the tray at all? the listener permission gates everything ---
  let listenerOn = false;
  try {
    const st = await phoneGet(presence.ip, '/notifications/status', 6);
    listenerOn = !!(st && st.data && st.data.enabled);
  } catch (e) {
    listenerOn = false;
  }
  if (!listenerOn) {
    return {
      ...base,
      state: 'unknown',
      summary: "Can't tell — the app can't read your notifications.",
      detail:
        'Homestead needs notification-access permission on your phone to check '
        + 'whether its own alerts are arriving, and that permission is currently '
        + 'off. That is a separate setting from notifications themselves, so this '
        + 'is not being treated as a failure.',
      phoneIp: presence.ip,
    };
  }

  // --- the probe itself, on its own slow clock ---
  //
  // ⚠️ THE PROBE IS NEVER AWAITED BY THE REQUEST THAT TRIGGERS IT.
  // A full probe takes ~25s (send, then poll the tray for 20s), and
  // getHealthChecks() is what the panel's 60s poll and the modal both call. If
  // a caller awaited it, the whole health endpoint would block for half a
  // minute and the panel would sit blank — instrumentation taking the surface
  // down with it. So a stale probe is kicked off in the BACKGROUND and the
  // caller immediately returns the previous verdict; the fresh one lands a few
  // seconds later and the next poll picks it up. Measured: with this, the check
  // returns in well under a second.
  const stale = !probeCache || (Date.now() - probeCache.at) > PROBE_INTERVAL_MS;
  if (stale && !probeInFlight) {
    probeInFlight = true;
    runDeliveryProbe(presence.ip)
      .then((verdict) => { probeCache = { at: Date.now(), verdict }; })
      .catch(() => { /* a failed probe leaves the last real verdict standing */ })
      .finally(() => { probeInFlight = false; });
  }

  // No verdict yet at all — first run since boot. Say so rather than guessing.
  if (!probeCache) {
    return {
      ...base,
      state: 'unknown',
      summary: 'Checking whether notifications are arriving\u2026',
      detail:
        'A real test notification has just been sent to your phone and Homestead '
        + 'is watching your phone\'s own notification list to see whether it '
        + 'shows up. The answer lands within about half a minute.',
      phoneIp: presence.ip,
    };
  }

  const v = probeCache.verdict;
  const agoMin = Math.round((Date.now() - probeCache.at) / 60000);
  const when = agoMin < 1 ? 'just now' : agoMin + ' min ago';

  if (v.sendFailed) {
    return {
      ...base,
      state: 'down',
      summary: 'Notifications are not going out at all.',
      detail:
        'Homestead tried to send a test notification to your phone ' + when
        + ' and could not even hand it to Google: ' + v.sendError + '. Nothing '
        + 'is reaching you.',
      phoneIp: presence.ip,
    };
  }

  if (!v.delivered) {
    return {
      ...base,
      state: 'down',
      summary: 'Notifications are being silently dropped.',
      detail:
        'Homestead sent a real test notification to your phone ' + when
        + ' and Google accepted it — then watched your phone\'s own notification '
        + 'list for ' + Math.round(PROBE_WAIT_MS / 1000) + ' seconds and it never '
        + 'appeared. So it is being thrown away after it leaves here. The usual '
        + 'cause is that Homestead\'s notifications have been switched off or '
        + 'silenced in your phone\'s own settings for the app.',
      phoneIp: presence.ip,
    };
  }

  return {
    ...base,
    state: 'ok',
    summary: 'Notifications are actually arriving on your phone.',
    detail:
      'Homestead sent a real test notification ' + when + ' and then confirmed '
      + 'it appeared in your phone\'s own notification list, so delivery is '
      + 'genuinely working end to end. The test notification was dismissed '
      + 'automatically.',
    phoneIp: presence.ip,
  };
}

/** The detector registry. Add new checks here; everything upstream is generic. */
const CHECKS = [checkWirelessDebugging, checkPhoneNotifications];

/**
 * Run every detector and summarise.
 *
 * Detectors are independent, so one throwing must never take down the rest —
 * a failed check degrades to 'unknown' (silent), never to a false alarm.
 */
async function getHealthChecks() {
  if (cache && cache.expiresAt > Date.now()) return cache.data;

  const results = await Promise.all(
    CHECKS.map((fn) =>
      fn().catch((err) => ({
        id: 'unknown',
        title: 'A check failed to run',
        state: 'unknown',
        summary: 'One of the health checks could not run.',
        detail: String((err && err.message) || err),
      }))
    )
  );

  const down = results.filter((r) => r.state === 'down');
  const data = {
    at: new Date().toISOString(),
    checks: results,
    downCount: down.length,
    // Convenience for the dot: is there anything actionable at all?
    anyDown: down.length > 0,
    // Carried forward so the presence fallback has an address to try.
    phoneIp: results.map((r) => r.phoneIp).find(Boolean) || (cache && cache.data && cache.data.phoneIp) || null,
  };

  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

module.exports = { getHealthChecks };
