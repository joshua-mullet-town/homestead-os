# APK Side-Panel Favorites Shortcut — Feasibility Discovery

**Worker:** `holler-homestead--foreman--apk-favorites-discovery`
**Date:** 2026-06-02
**Classification:** Discovery report. NO IMPL CODE. Report-only deliverable.

---

## Joshua's ideation ask (verbatim)

> On the side of the Homestead APK I have on the phone, I have the ability to start a recording, to type a response, and then I have three smaller buttons. One is to see all the apps, one is to see my mouse app, another one is to see past recordings, and I'm realizing I actually don't use those specific things a lot. I'm more likely to actually use things like Snapchat or apps... I like seeing all my apps at once, but it'd be nice if I actually just had like a shortcut to my favorites. So when I say favorites, I mean when I click on all apps, that all apps button, it takes like a second to load. That's kind of the bummer. It takes a second to load, and then suddenly I can see all my apps with my favorites pinned to the top. And I'm wondering if there's any way to get my favorites to very quickly show up. If I were to click on a button on the side there that showed favorites or something, and it very quickly showed my favorite apps, that would be super clutch. **Do you think you can go ahead and do that, or is that harder to lift than I think?**

The closer is the load-bearing part — Joshua framed this as ideation and explicitly invited feasibility pushback.

---

## TL;DR

**Verdict: EASY.** Half-day to a day of Worker time, ~120-220 LOC across two files, no architecture changes.

The ~1-second cost is almost entirely the per-app icon rasterization that runs once for every installed app when the All Apps overlay opens. A new Favorites-only button skips that by loading icons for only the ~5-10 favorite packages instead of all ~100. Expected cold-open latency for the new button: **~80-150ms vs current ~600-1100ms** — roughly 6-10× faster, well into "feels instant" territory.

Recommended impl shape: clone the existing `appsButton` in `FloatingControls.kt`, add a new `showFavoritesOverlay()` function in `MainActivity.kt` that reuses the favorites-grid render shape but loads only favorite packages via `LauncherApps.getActivityList(packageName, profile)`.

No need to redesign the favorites system — it already exists. No need to migrate storage, add background services, or touch any Android-API constraints. The hardest part is just writing careful Kotlin in a 3800-line file.

---

## (a) Current state — where favorites live and how the side panel is structured

### The side panel (`FloatingControls.kt`)

File: `mobile/app/src/main/java/com/homestead/mobile/FloatingControls.kt` (1142 lines, fully programmatic UI — no layout XML for this surface).

The right-edge floating cluster contains five buttons in this vertical order (built in `buildRightCluster` at line 173, stacked in `buttonRow` at line 427):

| Position | Button | Size | Wires to | Callback |
|---|---|---|---|---|
| top | **Apps** ⊞ | 36dp | `MainActivity.showAppsOverlay()` (line 2849) | `onAppsTap` (line 97, 306) |
| 2 | **Trackpad** 🖱 (Joshua: "Mouse App") | 36dp | `MainActivity.showTrackpadOverlay()` (line 3261) | `onTrackpadTap` (line 98, 337) |
| 3 | **History** ↺ (Joshua: "Past Recordings") | 36dp | `MainActivity.showRecordingHistoryPanel()` | `onHistoryTap` (line 96, 280) |
| 4 | **Keyboard** ⌨ | 48dp | text input toggle | `onKeyboardTap` (line 95) |
| bottom | **Mic** 🎤 / ⏹ | 56dp | voice recording | `onMicGesture` (line 92) |

Joshua's three "smaller buttons" = Apps + Trackpad + History (the three 36dp ones).

A new "Favorites" button would be a clone of `appsButton` (line 295) inserted into the `buttonRow` (line 427). Same 36dp oval + #555555 stroke + glyph-icon style. Looks visually like a peer to Apps/Trackpad/History.

### Where favorites are stored

File: `MainActivity.kt`, lines 2814-2828.

```kotlin
private fun getFavoritePackages(): List<String> {
    val prefs = getSharedPreferences("homestead_quick_apps", MODE_PRIVATE)
    val raw = prefs.getString("package_names", null) ?: return emptyList()
    return try {
        val arr = org.json.JSONArray(raw)
        (0 until arr.length()).map { arr.getString(it) }
    } catch (_: Exception) { emptyList() }
}
```

Storage: a JSON array of package-name strings in SharedPreferences key `homestead_quick_apps` / `package_names`. Tiny (~bytes), read in <1ms.

Key format (line 2830): `packageName` for personal profile, `${packageName}:work` for work profile.

Mutations happen via the long-press popup in the existing All Apps overlay (line 3200 `showAppContextMenu` → "Add to Favorites" / "Remove from Favorites" → `saveFavoritePackages` at line 3216).

No Firestore, no Room, no network. Pure local SharedPreferences. **The favorites system is already simple and well-isolated.**

### How the existing All Apps button renders

`onAppsTap` (MainActivity.kt:563) → `showAppsOverlay()` (line 2849):

1. **Line 2856** — `val allApps = loadLaunchableApps()` — see (b)
2. **Line 2857** — `val favoriteKeys = getFavoritePackages().toMutableSet()`
3. **Lines 2861-2927** — Build overlay scrim, slide-up panel, drag handle, search EditText
4. **Lines 2930-2962** — ScrollView with inner LinearLayout (`scrollContent`)
5. **Lines 2966-3001** — `buildFavoritesInto(scrollContent)`: filter `allApps` by `favoriteKeys`, render in a 5-column GridLayout under a "FAVORITES" label
6. **Lines 3008-3110** — `rebuildScrollContent("")`: re-render favorites + add the full-apps GridLayout below (with empty-state and search fallback)
7. **Line 3128** — `decorView.addView(overlay)`
8. **Lines 3132-3137** — 180ms slide-up animation, then focus search + show soft keyboard

Note: `SmartAppsFragment.kt` is **NOT** part of this flow. It is the WORKBENCH tab (a WebView-driven home-screen widget surface). Mentioning it for the record because the charter pointed to it as a candidate.

---

## (b) Latency diagnosis — what eats the ~1 second

The dominant cost is `loadLaunchableApps()` (MainActivity.kt:2781-2812) on a cold open. There is an in-memory cache that hits for 30 seconds after a successful load (line 2784), but on a cold call:

```kotlin
val launcherApps = getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps
val userManager = getSystemService(Context.USER_SERVICE) as UserManager
for (profile in userManager.userProfiles) {
    for (info in launcherApps.getActivityList(null, profile)) {     // returns ALL launchable activities
        apps.add(LaunchableApp(
            packageName = info.componentName.packageName,
            appName = info.label.toString(),                         // ~0.5-2ms per app
            icon = info.getBadgedIcon(0),                            // ~5-15ms per app — DOMINANT
            ...
        ))
    }
}
val sorted = apps.sortedWith(compareBy({ it.isWorkProfile }, { it.appName.lowercase() }))
```

### Per-step cost enumeration (cold path)

| # | Step | Cost | Notes |
|---|------|------|-------|
| 1 | `vibrateLight()` | <1ms | fire-and-forget |
| 2 | `getSystemService(LAUNCHER_APPS_SERVICE)` × 2 | ~2ms | once-per-call binder lookup |
| 3 | `launcherApps.getActivityList(null, profile)` binder call | **20-80ms** | returns ~80-150 `LauncherActivityInfo` objects |
| 4 | `info.label.toString()` × N apps | ~0.5-2ms each | AOSP caches the label; can be cold first time |
| 5 | **`info.getBadgedIcon(0)` × N apps** | **5-15ms each** | **DOMINANT** — rasterizes adaptive icon, composes work-profile badge |
| 6 | Sort by name, lowercase, isWorkProfile | ~5-15ms | in-memory sort of ~100 items |
| 7 | `getFavoritePackages()` SharedPreferences read | <1ms | tiny JSON parse |
| 8 | Allocate `FrameLayout` overlay + `LinearLayout` panel + ScrollView + EditText | ~5-15ms | EditText is the heaviest, ~2-5ms alone |
| 9 | `buildFavoritesInto` (5-10 tiles, 5-col GridLayout) | ~10ms | trivial |
| 10 | All-apps loop builds ~100 tiles via `createAppGridTile` | **30-80ms** | per tile = 1 LinearLayout + 1 ImageView + 1 TextView + optional work-profile dot |
| 11 | `decorView.addView(overlay)` triggers first measure + layout for ~100 children | **20-50ms** | Android measure/layout for a 5×20 GridLayout |
| 12 | `panel.animate().translationY(0f).setDuration(180)` | 180ms anim duration | **but favorites render mid-slide** — first frame visible ~30-60ms in |
| 13 | After anim: `searchInput.requestFocus()` + soft keyboard show | async, post-anim | doesn't block first paint |

### Cost summary on a typical phone with ~100 launchable apps

- **Steps 1-7 (data load):** ~600-1100ms — **dominant**
- **Steps 8-11 (UI build + first layout):** ~70-160ms
- **Step 12 (anim):** 180ms total, but favorites visible after ~30-60ms

**Total perceived "tap → favorites visible" ≈ 700-1200ms.** Matches Joshua's "about a second."

### Confidence

- **HIGH** that the icon rasterization (Step 5) is the dominant cost. This is the standard Android launcher footgun; magnitude matches the user-reported "1 second"; only API call in the path with per-app cost in this range.
- **HIGH** that no Firestore/network call is involved (grep confirmed against the `showAppsOverlay` range 2849-3138).
- **HIGH** that no `<queries>` manifest restriction is in play (manifest has the queries element confirmed).
- **HIGH** that the entire load runs on the UI thread (no `Dispatchers.IO`, no coroutine in this path) — hence the "freeze for a second" perception.

### Why I did not add logcat timing instrumentation

The charter allowed logcat probes for measurement. I chose NOT to because:
1. No USB-attached device (`adb devices` empty). Probes would require building, OTA-pushing, and asking Joshua to install — heavy lift for a discovery report.
2. The diagnosis is unambiguous from code + standard Android knowledge.
3. Empirical confirmation is the natural Step 1 of any impl phase, where it's cheap (one logcat read after Joshua installs the new APK).

Worktree is clean of probes. Confirmation can come during impl.

---

## (c) Fast-path feasibility — mapping each cost to bypass/pre-cache/expensive

| Latency contributor | Verdict | How a favorites-only path handles it |
|---|---|---|
| `loadLaunchableApps()` full enumeration (600-1100ms) | **CHEAP TO BYPASS** | Call `launcherApps.getActivityList(packageName, profile)` once per favorite (~5-10 calls instead of ~100). |
| Per-app `getBadgedIcon(0)` × N (8-15ms × N) | **CHEAP TO BYPASS** | Rasterize only ~5-10 favorite icons (40-150ms total). |
| `getFavoritePackages()` SharedPreferences read | already <1ms | No change needed. |
| Sort by name | **CHEAP TO BYPASS** | Sort only favorites (~5 items) — sub-ms. |
| Overlay/panel/ScrollView allocation | already <15ms | Favorites overlay can be SMALLER — no search bar, no scrollable all-apps grid. Slight further savings. |
| Tile creation for ~100 all-apps | **CHEAP TO BYPASS** | Only build tiles for favorites. |
| First layout pass for ~100 children | **CHEAP TO BYPASS** (corollary) | Layout pass shrinks to 5-10 children — trivial. |
| Search EditText init | **CHEAP TO BYPASS** | No search needed; favorites are small. |
| Slide-up animation (180ms) | **EXPENSIVE FOR REAL REASONS** | This is UX, not load latency. Joshua likely WANTS the slide-up — it's a sheet pattern. Could be tightened to 120ms if needed. |
| Show soft keyboard after anim | **CHEAP TO BYPASS** | No input field → no IME. |

**Bottom line:** every meaningful contributor to the ~1-second cold open is bypassable for favorites. Nothing in the path requires Room, background sync, FCM, or any Android-API constraint to dodge.

### Expected latency for a favorites-only fast path

- Per-package `getActivityList(packageName, profile)`: ~3-8ms per favorite
- Per-favorite `getBadgedIcon(0)`: ~5-15ms per favorite
- Tile build + layout for ~5-10 tiles: ~5-15ms total
- Overlay allocation + animation: same as before (~10-15ms allocation, 180ms anim with content visible mid-slide)

**Cold open ≈ 80-150ms.** Warm open (within Activity lifetime, simple in-memory cache): <10ms. Both well under the ~100ms "feels instant" threshold.

### Could pre-warming fix the existing All Apps button instead?

Possible: kick off `loadLaunchableApps()` on a background coroutine at app start, periodically refresh. But:
- It doesn't address Joshua's specific ask (he wants a NEW side button, not a faster existing one).
- Adds architecture (lifecycle observer, periodic re-warm, race with first user tap).
- The 30-second cache would still re-stale during long idle periods.

Flagging for completeness; not the recommended path.

---

## (d) Verdict — EASY, with reasons

**EASY: implementable in <8 hours by a Worker, no architecture changes.**

### Why EASY (and not MEDIUM)

- No new persistence layer (favorites already in SharedPreferences).
- No background service, no pre-caching infrastructure, no lifecycle observer.
- No Android-API constraints in play (`<queries>` element already present in manifest).
- The shape of the new code (overlay, slide-up, grid, long-press to unfavorite) clones cleanly from existing code at `MainActivity.showAppsOverlay` (line 2849) and `FloatingControls.appsButton` (line 295).
- No cross-Worker file collision risk per Foreman's siblings briefing.
- Failure modes are well-understood and trivially handled (stale favorite package → empty `getActivityList` result → silently skip, matching current behavior).

### Why not "trivially 5-line EASY"

- New button must be added to `FloatingControls.kt` in a specific spot in `buildRightCluster` (line 173) AND in the `buttonRow` vertical stack (line 427).
- New `showFavoritesOverlay()` is ~80-150 LOC by the time you account for slide-up, dismiss, long-press unfavorite, empty-state ("no favorites yet"), and the per-package loader.
- Wiring `onFavoritesTap` + new private state field + `dismissFavoritesOverlay` adds ~15 LOC.

### LOC estimate

| File | Change | LOC |
|---|---|---|
| `mobile/app/src/main/java/com/homestead/mobile/FloatingControls.kt` | Clone `appsButton` block (lines 294-318) into a new `favoritesButton` block; add `var onFavoritesTap: (() -> Unit)? = null`; add `favoritesButton` to `buttonRow` between Apps and Trackpad | ~30 |
| `mobile/app/src/main/java/com/homestead/mobile/MainActivity.kt` | Add `private var favoritesOverlay: FrameLayout? = null`; wire `floatingControls.onFavoritesTap = { vibrateLight(); showFavoritesOverlay() }`; add private `loadFavoriteApps()` per-package loader; add private `showFavoritesOverlay()` (cloned shape from `showAppsOverlay`, search-less, smaller); add private `dismissFavoritesOverlay()` | ~120-180 |
| **Total** | | **~150-210 LOC** |

### Files Joshua would have to test before declaring success

- Tap new Favorites button cold (first time since process start) → favorites grid visible in <250ms.
- Tap a favorite app → it launches.
- Long-press a favorite → "Remove from Favorites" popup → unfavorite → favorite drops from grid.
- Tap Apps button (existing) → All Apps still works as before (regression check).
- Add a new favorite via the existing All Apps long-press → re-open Favorites button → new fave shows.
- Stale favorite scenario: favorite a package, uninstall it, re-open Favorites → silently skipped (matches existing All Apps behavior).

### Suggested impl button placement

In the `buttonRow` (FloatingControls.kt:427-455) vertical order, current is:
```
Apps → Trackpad → History → Keyboard → Mic
```

Suggested:
```
Favorites → Apps → Trackpad → History → Keyboard → Mic
```

Putting Favorites ABOVE Apps so Joshua's most-tapped button is the topmost small button. (Joshua to decide — could also go between Apps and Trackpad.)

### Suggested icon glyph

Apps uses `⊞`. Favorites could use `★` (filled star) to visually distinguish "your starred shortcuts" from "all apps." Or `♥`. Or a different color stroke. Joshua to pick.

### Suggested cache strategy

**Option C from scratch notes is the cleanest:** check existing 30-second `cachedLaunchableApps` first — if warm, filter to favorites and render instantly. If cold, fall through to per-favorite-package load. ~5 extra LOC vs the independent fast-path. Inherits cache improvements if All Apps slow path is ever fixed elsewhere.

### Risk surface

LOW. Two-file change, both files already heavily Worker-touched without instability. No external systems. Reversible: deleting the button + overlay function gets back to current state cleanly. Worst-case stale-favorite handling mirrors existing all-apps behavior. No interaction with the in-flight `bookmarks-realtime-impl` Worker (different surface entirely — server.js + presenter renderer + web /admin).

---

## (e) What this report does NOT say

- It does NOT recommend shipping anything. Joshua's "or is that harder to lift than I think?" closer means EASY is a recommendation, not a decision.
- It does NOT claim to have measured the latency empirically. The diagnosis is from code + Android API behavior; logcat probes weren't installed (see explanation under §b).
- It does NOT propose pre-warming the existing All Apps button. Possible but doesn't match Joshua's ask shape.
- It does NOT pick the button glyph, position, or color. Those are Joshua-decisions for any impl Worker.

---

## Appendix — File:line reference index

| Symbol | File | Line |
|---|---|---|
| `FloatingControls.buildRightCluster` | FloatingControls.kt | 173 |
| `FloatingControls.appsButton` | FloatingControls.kt | 295 |
| `FloatingControls.onAppsTap` | FloatingControls.kt | 97, 306 |
| `FloatingControls.buttonRow` vertical stack | FloatingControls.kt | 427-455 |
| `MainActivity.onAppsTap` wiring | MainActivity.kt | 563 |
| `MainActivity.LaunchableApp` data class | MainActivity.kt | 2770 |
| `MainActivity.cachedLaunchableApps` (30s cache) | MainActivity.kt | 2778-2779 |
| `MainActivity.loadLaunchableApps()` | MainActivity.kt | 2781-2812 |
| `MainActivity.getFavoritePackages()` | MainActivity.kt | 2814-2821 |
| `MainActivity.saveFavoritePackages()` | MainActivity.kt | 2823-2828 |
| `MainActivity.appKey()` (work-profile key fmt) | MainActivity.kt | 2830 |
| `MainActivity.launchApp()` | MainActivity.kt | 2833 |
| `MainActivity.showAppsOverlay()` | MainActivity.kt | 2849-3138 |
| `MainActivity.createAppGridTile()` | MainActivity.kt | 3140 |
| `MainActivity.showAppContextMenu()` (long-press) | MainActivity.kt | 3200 |
| `MainActivity.dismissAppsOverlay()` | MainActivity.kt | 3240 |
| `AndroidManifest.xml` `<queries>` element | mobile/app/src/main/AndroidManifest.xml | confirmed present |

End of report.
