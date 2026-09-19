module.exports = {
  apps: [{
    name: 'homestead',
    script: 'server.js',
    env: {
      USE_HTTPS: 'false',
      NODE_ENV: 'production',
      // Josh's phone is the pixel-9a-1 (<<REPLACE: your Tailscale IP>>). The pixel-6
      // (<<REPLACE: your phone Tailscale IP (tailscale ip -4 on the device)>>) is retired but STILL POWERED ON and still answers 200 on
      // the tailnet — so code defaulting to it fails silently against a device
      // Josh isn't holding, rather than erroring. Set once here so every
      // `process.env.PHONE_API_URL || <pixel-6 default>` resolves to the real phone.
      PHONE_API_URL: 'http://<<REPLACE: your Tailscale IP>>:8888',
      // WAVE 1 of the always-off session rollout (Rooster, 2026-09-06).
      // Josh approved the FEATURE; the STAGED shape is Rooster's call because the
      // failure mode is silent and fires many times a day. BOTH vars are required —
      // ALWAYS_OFF_SESSIONS alone is a silent no-op.
      // ROLLBACK — EITHER of these is now safe, and neither can widen scope:
      //   unset ALWAYS_OFF_SHUTDOWN  -> everyone back to the 4h dwell
      //   empty ALWAYS_OFF_SESSIONS  -> wave of 0, NOTHING eligible
      // No revert, no redeploy; the cron re-reads on its next tick.
      // Protection beats eligibility: naming a PROTECTED session here does NOT
      // un-protect it (rooster, watchdog, alfred, steward-manager, homestead).
      //
      // ⚠️ HISTORICAL, NOW FIXED — do not re-derive the old behaviour from this:
      // an EMPTY ALWAYS_OFF_SESSIONS used to mean "no restriction", so shrinking
      // the wave to zero WIDENED it to fleet-wide and suspended four sessions on
      // 2026-09-06. That footgun is gone: the list can only ever NARROW, and an
      // empty list under an armed trigger is an EMPTY WAVE. The job log says
      // "STAGED (wave of 0 — NOTHING eligible)" in that state.
      ALWAYS_OFF_SHUTDOWN: '1',
      // ROLLED BACK 2026-09-06 ~18:55: a cold resume of an aged session hits Claude
      // Code's own 'Resume from summary' menu (4h20m / 103k tokens), which
      // resumeComputeSuspend does NOT handle — the session strands on the menu,
      // the marker persists and the dot stays gray. Nearly every live session is
      // old enough to hit it, so this blocks the rollout, not just one session.
      // The picker is now HANDLED (queue-dispatcher.js: isResumeSummaryPicker) —
      // detected by text, answered with "Resume full session as-is", and left
      // alone if the expected text is absent. Re-enabling is Rooster's call.
      // Empty list = wave of 0 = inert, and safe on its own.
      // WIDENED FLEET-WIDE 2026-09-11 on Josh's explicit call ("try to turn it on
      // for everything if you can"). Was a 3-session staged wave; two of those
      // three had since been torn down, so the rollout was governing 2 of 31
      // sessions and had quietly stopped rolling.
      //
      // 'ALL' = every session the trigger reaches, i.e. everything NOT in
      // SKIP_SESSIONS (rooster, watchdog, alfred, steward-manager, homestead).
      // An enumerated list was rejected: it is a SNAPSHOT, and every worker
      // spawned afterwards would silently revert to the 4h dwell.
      //
      // TO HALT: unset ALWAYS_OFF_SHUTDOWN (restores the 4h dwell for everyone),
      // or set ALWAYS_OFF_SESSIONS='' (empty = EMPTY WAVE, nothing eligible).
      // Both are safe; neither can widen anything.
      ALWAYS_OFF_SESSIONS: 'ALL'
    },
    max_memory_restart: '3G',
    cron_restart: '0 */6 * * *',
    // pm2's treekill default (true) walks the process tree and kills every
    // descendant on restart — which killed whisper-server on :8178 even after
    // it was correctly spawned with detached:true + unref() (verified: whisper
    // sits in its OWN process group, and still died). Dictation went dead on
    // every restart, including the 6-hourly cron_restart above. false = pm2
    // signals only the Node process; whisper survives and the server's
    // already-running guard adopts it instead of spawning a duplicate.
    treekill: false,
  }, {
    name: 'presenter',
    script: 'electron-presenter/start.sh',
    interpreter: 'bash',
  }, {
    name: 'phone-alley',
    cwd: './phone-alley',
    script: 'server.js',
    env: {
      NODE_ENV: 'production',
      PORT: '3009'
    },
    max_memory_restart: '256M',
  }]
};
