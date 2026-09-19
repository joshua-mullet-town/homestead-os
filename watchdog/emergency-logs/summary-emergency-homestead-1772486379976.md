# Emergency Repair Summary

**Date:** 2026-03-02 ~16:20 UTC
**Trigger:** User report: "the apk that i just downloaded is corrupted and now I can't use my mobile"
**Result:** NOT A HOMESTEAD SERVER ISSUE — Server and download pipeline verified healthy

## Investigation

### 1. System Health — All OK
| Resource | Status | Details |
|----------|--------|---------|
| Homestead pm2 | Online | PID 25895, 24h uptime, 348.5MB mem |
| Watchdog pm2 | Online | PID 36841, 46h uptime, 49.5MB mem |
| CPU | OK | 72.8% idle |
| Memory | Tight | 15G used, 332M free |
| Disk (Data) | 95% | 24Gi free of 460Gi |

### 2. Homestead Web UI — Verified Working
- Navigated to http://localhost:3005 via Chrome DevTools MCP
- Screenshot confirms full dashboard rendering (3 active projects visible)
- No errors in logs (only Next.js metadata deprecation warnings)

### 3. APK Download Pipeline — Verified Intact
- Source APK on disk: **valid** (12,418,419 bytes, `unzip -t` passes, proper APK structure)
- `GET /api/mobile-update` returns correct metadata
- `GET /api/mobile-update/download` serves file correctly (Content-Type, Content-Length, Content-Disposition all correct)
- **MD5 checksum match**: downloaded APK is byte-identical to source APK
- Downloaded APK passes `unzip -t` integrity check

### 4. Phone Connectivity — Unreachable
- Phone not reachable via Tailscale (`curl http://<<REPLACE: your phone Tailscale IP (tailscale ip -4 on the device)>>:8888/health` — connection refused)
- ADB not connected (no devices listed)
- Cannot diagnose or fix the phone-side issue remotely

## Diagnosis

The APK corruption likely occurred during the OTA download **on the phone side**, not the server side. Possible causes:
1. **Network interruption** during download over Tailscale (phone went to sleep, network switch, etc.)
2. **Incomplete download** — the app uses `input.copyTo(output)` which could be truncated on network timeout (60s read timeout)
3. **Storage issue** on phone — disk full or write error to `getExternalFilesDir()`

The server download pipeline is provably correct (MD5 match, integrity verified).

## Actions Taken

1. Verified all system resources healthy
2. Verified Homestead UI loads correctly via Chrome DevTools
3. Verified APK source file integrity
4. Verified download endpoint serves identical bytes
5. Attempted phone connectivity (unreachable)
6. Gradle build confirmed up-to-date — APK ready for re-download

## Resolution

**No server-side fix needed.** When the phone is back online, the user should:
1. Re-download the APK via the update banner (it will get a fresh, clean copy)
2. If ADB is available: `adb install -r mobile/app/build/outputs/apk/debug/app-debug.apk`

## Previous Entry

**Date:** 2026-03-01 ~20:30 UTC — Stale `.next/dev/lock` crash loop — RESOLVED (lock file removed, server restarted)
