package com.homestead.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.content.pm.LauncherApps
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.UserManager
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.ScrollView
import android.widget.SeekBar
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.res.ResourcesCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    companion object {
        /** Diagnostic mirrors of the last applyHomeModeChrome() pass. */
        /** Mode-switch reveal: fast enough to feel instant, slow enough to read. */
        private const val MODE_ANIM_IN_MS = 350L
        private const val MODE_ANIM_OUT_MS = 300L

        @JvmStatic var lastChromeMode: String = "(not yet applied)"
        @JvmStatic var lastChromeFlagState: String = "(not yet applied)"

        /**
         * Weak handle on the live activity so /wallpaper-debug can read the window
         * flag AS IT ACTUALLY IS right now.
         *
         * lastChromeFlagState above is only a mirror of what we last *wrote*, so
         * after a recreation it reports the DEAD instance's last write while the
         * live window may carry nothing of the sort. A mirror cannot observe the
         * failure it was built to detect, so the real flag has to be read off
         * the live window.
         */
        @JvmStatic
        var liveActivity: java.lang.ref.WeakReference<MainActivity>? = null

        /** True/false/unknown for FLAG_SHOW_WALLPAPER on the LIVE window right now. */
        @JvmStatic
        fun liveShowWallpaperFlag(): String {
            val a = liveActivity?.get() ?: return "unknown (no live activity)"
            return try {
                ((a.window.attributes.flags and
                    android.view.WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER) != 0).toString()
            } catch (e: Exception) { "err: ${'$'}{e.message}" }
        }

        /**
         * Diagnostic switch: when true, healHomeModeChrome() observes and records
         * drift but does NOT repair it.
         *
         * This exists to make the bug FALSIFIABLE. The whole point of the fix is
         * that it repairs the window automatically, which also means it erases the
         * evidence — so "I toggled it and it looked fine" proves nothing. Turning
         * healing off lets a forced flag-drop actually show up as the real
         * failure (mode=phone with the wallpaper off), and turning it back on
         * shows the same forced drop being repaired. Off by default; only the
         * debug endpoint flips it.
         */
        @JvmStatic var chromeHealDisabled: Boolean = false

        /**
         * Mirror of the last setRecentsScreenshotEnabled() call — "true" means we
         * asked the platform NOT to keep a screenshot of this task (Phone mode).
         * That stored screenshot is the stale frame that used to be replayed
         * behind the transparent window, so the diagnostic reports it.
         */
        @JvmStatic var lastRecentsScreenshotSuppressed: String = "unset"

        /**
         * How many orphaned home fragments were removed at onCreate because the
         * FragmentManager had restored them from a previous activity instance.
         * Anything above 0 means a recreation happened and the old, opaque
         * WebViews that used to draw over the wallpaper were cleaned up.
         */
        @JvmStatic var orphanFragmentsRemoved: Int = 0

        /** Live count of fragments currently sitting in the home container. */
        @JvmStatic
        fun liveHomeFragmentCount(): String {
            val a = liveActivity?.get() ?: return "no live activity"
            return try {
                a.supportFragmentManager.fragments.count {
                    it is PresenterFragment || it is HomesteadFragment || it is PhoneModeFragment
                }.toString()
            } catch (e: Exception) { "err: ${'$'}{e.message}" }
        }

        /**
         * Drop FLAG_SHOW_WALLPAPER while Phone mode is showing, reproducing the
         * recreation case (1) by hand. Josh cannot reproduce this bug on demand,
         * so it has to be induced deliberately to prove both that the diagnostic
         * can see it and that the fix repairs it. Note this only simulates the
         * missing-flag case — it cannot simulate the visibility race (2), where
         * the flag stays set.
         */
        @JvmStatic
        fun debugDropWallpaperFlag(): String {
            val a = liveActivity?.get() ?: return "no live activity"
            return try {
                a.runOnUiThread {
                    a.window.clearFlags(
                        android.view.WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER)
                }
                "dropped"
            } catch (e: Exception) { "err: ${'$'}{e.message}" }
        }

        /** Ask the activity to run its self-heal right now (as onResume would). */
        @JvmStatic
        fun debugHealNow(): String {
            val a = liveActivity?.get() ?: return "no live activity"
            return try {
                a.runOnUiThread { a.healHomeModeChrome("debugHealNow") }
                "healed"
            } catch (e: Exception) { "err: ${'$'}{e.message}" }
        }

        /**
         * Fire the overlay's ⌂ button handler for real — the same lambda the
         * button invokes, not a copy of it. Exists so the in-app mode switch can
         * be verified from the Mac without driving taps on Josh's live screen
         * while he is using the phone. Returns the mode before and after so a
         * no-op is impossible to mistake for a success.
         */
        @JvmStatic
        fun debugTapOverlayHome(): String {
            val a = liveActivity?.get() ?: return "no live activity"
            return try {
                if (!a::audioRecorder.isInitialized) return "recorder not ready"
                val before = a.currentHomeModeName()
                val animBefore = a.isModeAnimating
                val onScreen = a.isAppOnScreen
                a.runOnUiThread { a.audioRecorder.onOverlayReturnTap?.invoke() }
                Thread.sleep(900)
                "before=" + before + " after=" + a.currentHomeModeName() +
                    " animating(before)=" + animBefore + " animating(after)=" + a.isModeAnimating +
                    " appOnScreen=" + onScreen
            } catch (e: Exception) { "err: " + e.message }
        }

        /**
         * Drive the four rail-visibility states from the Mac, and report what the
         * rail actually did.
         *
         * Same reason as [debugTapOverlayHome] right above: Josh uses this phone
         * all day, there is no screenshot endpoint and the accessibility service
         * is off, so the alternative is blind-tapping his live screen and hoping.
         * These fire the REAL handlers — the same mode switch and the same typing
         * box he touches — so what they prove is the real behaviour, not a
         * simulation of it.
         *
         * @param mode "homestead" or "phone"; anything else leaves the mode alone.
         * @param textBox "show"/"hide"; anything else leaves the box alone.
         */
        /**
         * Measure the button cluster as it sits RIGHT NOW.
         *
         * Josh 2026-09-11 reported "this big old gap" between the keyboard and
         * record buttons whenever he is not recording, closing again during a
         * take. Guessing at which view is too wide wastes his time and an APK
         * tap each round, so this reports the real numbers off his phone: the
         * widths of both rows, the cell they share, and every child of the idle
         * row with its margins. Whatever is inflating the cell shows up here.
         */
        @JvmStatic
        fun debugLayoutReport(): Map<String, String> {
            val a = liveActivity?.get() ?: return mapOf("error" to "no live activity")
            return try {
                val out = java.util.concurrent.LinkedBlockingQueue<Map<String, String>>(1)
                a.runOnUiThread {
                    out.offer(try { a.floatingControls.debugMeasureCluster() }
                              catch (e: Exception) { mapOf("error" to (e.message ?: "threw")) })
                }
                out.poll(2, java.util.concurrent.TimeUnit.SECONDS)
                    ?: mapOf("error" to "timed out reading the UI thread")
            } catch (e: Exception) {
                mapOf("error" to (e.message ?: "threw"))
            }
        }

        @JvmStatic
        fun debugSetRailState(mode: String?, textBox: String?, record: String?): Map<String, String> {
            val a = liveActivity?.get()
                ?: return mapOf("error" to "no live activity")
            return try {
                val wantPhone = when (mode) {
                    "phone" -> true
                    "homestead" -> false
                    else -> null
                }
                if (wantPhone != null && a.isPhoneModeShowing() != wantPhone) {
                    a.runOnUiThread { a.toggleHomeMode() }
                    // The mode switch is a circular reveal; let it land before
                    // reading, or the report describes the middle of an animation.
                    Thread.sleep(1200)
                }
                // "textBox" drives the app's box, which also raises the real
                // system keyboard — that is what the rail actually reacts to now.
                when (textBox) {
                    "show" -> { a.runOnUiThread { a.showTextInput() }; Thread.sleep(1200) }
                    "hide" -> { a.runOnUiThread { a.hideTextInput() }; Thread.sleep(1200) }
                }
                // Start/stop a REAL take through the same handler the record
                // button and the Quick Settings tile fire, so the keyboard-up-
                // while-recording case is proven against real behaviour rather
                // than a flag we set ourselves.
                when (record) {
                    "start" -> if (!RecordingService.isRecordingNow()) {
                        RecordingService.toggleRecordingFromOutside(); Thread.sleep(1500)
                    }
                    "stop" -> if (RecordingService.isRecordingNow()) {
                        RecordingService.toggleRecordingFromOutside(); Thread.sleep(1500)
                    }
                }
                // Give the rail's own poll a beat to settle, then report the
                // window as it ACTUALLY is.
                Thread.sleep(400)
                val report = RecordingService.overlayVisibilityReport().toMutableMap()
                report["mode"] = a.currentHomeModeName()
                // Both, so the two can be told apart in a result: the box being
                // open is NOT the same as the keyboard being up, and only the
                // second one hides the rail.
                report["textBoxVisible"] =
                    (a.textInputContainer.visibility == View.VISIBLE).toString()
                report["keyboardVisible"] = a.liveImeVisible()
                report
            } catch (e: Exception) {
                mapOf("error" to (e.message ?: "unknown"))
            }
        }

        /**
         * How many times the mode-reveal watchdog had to release a stuck
         * animation latch. Anything above 0 means a reveal failed to signal
         * completion and the mode button would otherwise have been dead.
         */
        @JvmStatic var modeAnimWatchdogTrips: Int = 0

        /**
         * What the mode button would do if pressed right now — and whether the
         * plain flag agrees with the system. A disagreement here IS the bug that
         * makes the button do nothing, so it is worth seeing directly.
         */
        @JvmStatic
        fun liveOnScreenReport(): String {
            val a = liveActivity?.get() ?: return "no live activity"
            return try {
                "system=" + a.homesteadIsOnScreenNow() + " flag=" + a.isAppOnScreen
            } catch (e: Exception) { "err: " + e.message }
        }

        /** How many times the self-heal had to actually re-arm the chrome. */
        @JvmStatic var chromeHealCount: Int = 0
        @JvmStatic var lastChromeHeal: String = "(never)"

        /**
         * Identity of the activity instance, and how many times a new one has
         * been built.
         *
         * This is the discriminator for the two ways Phone mode can lose its
         * wallpaper, which need different fixes:
         *
         *  - The activity was RECREATED (rotation, dark-mode flip, a low-memory
         *    kill, or — since Android 12 — the wallpaper itself being changed).
         *    A new window is built from the theme, and any flags the old
         *    instance had set programmatically are gone with it. This activity
         *    declares no configChanges at all, so recreation is routine.
         *  - The SAME instance came back and still carries the flag, but the
         *    window manager did not re-pick us as the wallpaper target.
         *
         * If the black background is ever reported again, compare
         * activityInstanceId across the sighting: changed means recreation,
         * unchanged with the flag reading true means the visibility race.
         */
        @JvmStatic var activityInstanceId: String = "(none)"
        @JvmStatic var activityCreateCount: Int = 0

        /** Which home mode the activity believes it is in right now. */
        @JvmStatic
        fun liveChromeMode(): String {
            val a = liveActivity?.get() ?: return "unknown (no live activity)"
            return try { a.currentHomeModeName() } catch (e: Exception) { "err: ${'$'}{e.message}" }
        }

        private const val TAG = "MainActivity"

        // Send-menu item ids (long-press the left button).
        private const val MENU_PEEK = 1
        private const val MENU_CANCEL_RECORDING = 2
        private const val MENU_HISTORY = 3
        private const val MENU_TRACKPAD = 4
        private const val MENU_RESET_POSITION = 5

        private const val PERMISSION_REQUEST_AUDIO = 1002
        // Contacts read+write. Requested at startup so a fresh sideload self-heals the
        // grant — each reinstall resets runtime permissions, and the app's contact-write
        // endpoints (add_contact / set_contact_notes) throw SecurityException without it.
        private const val PERMISSION_REQUEST_CONTACTS = 1003
        // Mirror of recovery APK's StatusFragment.INTENT_EXTRA_FULL_RESTART. Sent by the
        // recovery APK's "FULL APK RESTART" button — we schedule a cold relaunch via AlarmManager
        // and then kill our own process (Jake Wharton ProcessPhoenix pattern).
        private const val INTENT_EXTRA_FULL_RESTART = "recovery_full_restart"
        private const val FULL_RESTART_REQUEST_CODE = 0x7E57
        // Over-the-dialer record button (HomesteadAccessibilityService): the a11y
        // service surfaces a mic button while the phone app is foreground; tapping it
        // launches us with these extras so we start recording immediately and tag the
        // resulting note as originating during a phone call (optionally with WHO).
        const val EXTRA_START_RECORDING_FROM_DIALER = "start_recording_from_dialer"
        const val EXTRA_PHONE_CALL_WHO = "phone_call_who"
    }

    // Set when a recording was started from the over-dialer button. Consumed when the
    // note is queued, so Alfred sees it came from a phone call (Part 2a) + who (Part 2b).
    private var inCallNoteWho: String? = null
    private var inCallNoteActive = false

    // Fonts
    private var fontHeader: Typeface? = null
    private var fontBodyMedium: Typeface? = null

    internal lateinit var floatingControls: FloatingControls
    private lateinit var textInputContainer: LinearLayout
    private lateinit var textInput: EditText
    private lateinit var inputManager: InputManager
    private lateinit var workbenchHeader: LinearLayout
    private lateinit var headerSessionsBtn: TextView
    private lateinit var headerWebBtn: TextView
    private lateinit var headerStatusBtn: TextView

    // Track which workbench sub-view is active
    private enum class WorkbenchTab { SESSIONS, WEB, STATUS }
    private var activeWorkbenchTab = WorkbenchTab.SESSIONS

    // Server-side transcription
    // Façade over RecordingService (mic-typed foreground service) with an
    // in-process fallback until it binds. Keeps the existing call sites intact
    // while letting a take survive leaving the app. See RecorderHandle.
    private lateinit var audioRecorder: RecorderHandle

    /** Set when we bind to a live take before the controls exist; drained in onCreate. */
    private var pendingReattach = false

    /** Last steward list fetched for the destination picker. The quick-send circles
     *  need a steward's icon/color without paying for a network round-trip on every
     *  recording start, so reuse whatever the picker last saw. */
    private var cachedStewards: List<FloatingControls.StewardInfo> = emptyList()
    private lateinit var recordingHistory: RecordingHistoryManager
    private val transcriptionService = TranscriptionService()
    private var useServerTranscription = true  // Use server-side Whisper by default

    // Audio level polling for voice-reactive UI
    private val audioLevelHandler = Handler(Looper.getMainLooper())
    private val audioLevelRunnable = object : Runnable {
        override fun run() {
            if (audioRecorder.isRecording()) {
                val amplitude = audioRecorder.getAmplitude()
                // Convert to 0-1 range using logarithmic scale for natural feel
                val level = if (amplitude > 0) {
                    (kotlin.math.log10(amplitude.toFloat() + 1) / 4.5f).coerceIn(0f, 1f)
                } else 0f
                floatingControls.audioLevel = level
                audioLevelHandler.postDelayed(this, 50) // 20Hz polling
            }
        }
    }

    private val homesteadFragment = HomesteadFragment()
    private val sessionsFragment = SessionsFragment()
    private val chatViewFragment = ChatViewFragment()
    private val phoneModeFragment = PhoneModeFragment()
    private val guestChatFragment = GuestChatFragment()
    private val presenterFragment = PresenterFragment()
    private var activeFragment: Fragment = presenterFragment  // Presenter is default home

    // Home fragment container — holds presenter + homestead-web, swapped via show/hide.
    private lateinit var homePager: FrameLayout
    private lateinit var activeHomeFragment: Fragment
    private var isShowingOverlay = false  // true when chat/sessions/guest fragment is shown
    private var isModeAnimating = false   // true while the mode reveal is running

    /** True while Josh is dragging the floating buttons to a new spot. */
    private var isMovingControls = false
    /** Overlay permission nudge — at most once per launch, never mid-session. */
    private var overlayPermissionAskedThisLaunch = false
    /** True between onResume and onStop — i.e. Homestead is the visible screen. */
    /** In-app update toast + one-tap install. */
    private var appUpdater: AppUpdater? = null

    private var isAppOnScreen = false

    // The mode-switch SWIPE is gone (Josh 2026-09-05). It was double-booked from
    // the start and no amount of tuning could have saved it — vertical swipes
    // already scroll cards, so the same motion had to mean two things at once.
    // His call: "we can't do swiping up and down, we already do swiping up and
    // down to roll a card… right above the buttons we just have a third little
    // button that does exactly what it was doing today, where it was just
    // transitioning between the two screens really beautifully."
    //
    // So the mode button is BACK, as a third button above the pair, driving the
    // same circular reveal it always did.

    private fun switchHomeFragment(target: Fragment) {
        if (!::activeHomeFragment.isInitialized || activeHomeFragment === target) return
        supportFragmentManager.beginTransaction()
            .hide(activeHomeFragment)
            .show(target)
            .commitAllowingStateLoss()
        activeHomeFragment = target
        applyHomeModeChrome()
    }

    /**
     * Is Phone mode the thing currently on screen? Single source of truth — the
     * chrome pass, the self-heal check and the diagnostic endpoint all ask this
     * so they can never disagree about what mode we are in.
     */
    private fun isPhoneModeShowing(): Boolean =
        ::activeHomeFragment.isInitialized &&
            activeHomeFragment === phoneModeFragment && !isShowingOverlay

    /** Mode name for the diagnostic endpoint. */
    fun currentHomeModeName(): String = if (isPhoneModeShowing()) "phone" else "homestead"

    /**
     * Tell the floating rail which side of the launcher is showing.
     *
     * Josh 2026-09-09: "It should only be immediately visible if I'm on the
     * homestead part of the launcher, not the app part."
     *
     * Reads [isPhoneModeShowing] — the single source of truth the chrome pass and
     * the diagnostic already share — rather than taking the caller's word for it,
     * so a caller cannot report a mode we are not actually in.
     *
     * This deliberately does NOT live inside applyHomeModeChrome, which was the
     * first attempt and was WRONG in one direction: the mode reveal calls that
     * pass only when going back TO Homestead, and healHomeModeChrome early-returns
     * whenever the wallpaper flag already agrees — which it now always does, since
     * the flag is permanent. So going INTO Phone mode reported nothing at all and
     * the rail stayed up on the app side. Caught on the real phone, not in review.
     *
     * Cheap and idempotent: the service ignores a value that has not changed.
     */
    private fun reportRailMode() {
        if (!::audioRecorder.isInitialized) return
        audioRecorder.setHomesteadModeShowing(!isPhoneModeShowing())
    }

    /**
     * Re-arm the window chrome if the live window has drifted from what the
     * current mode requires.
     *
     * There are two ways Phone mode ends up drawing its clock and icons over
     * black instead of the wallpaper, and this covers both:
     *
     *  1. The activity was RECREATED and the new window never got the flag.
     *     Flags set with addFlags() live on the PhoneWindow, which is built once
     *     per instance — a recreation builds a fresh one. This activity declares
     *     no configChanges at all, so a rotation, a dark-mode flip, a low-memory
     *     kill of a backgrounded launcher, or (Android 12+) the wallpaper itself
     *     being changed all recreate it. Here the flag genuinely is missing, and
     *     re-arming it is the fix.
     *  2. The same instance came back still carrying the flag, but the window
     *     manager did not re-pick us as the wallpaper target. The flag is
     *     necessary, not sufficient — the window also has to pass the manager's
     *     visibility checks at the instant it recomputes, and returning from
     *     screen-off or the keyguard is where that gets missed. Here the flag
     *     reads true and only a relayout gets the wallpaper back, which is what
     *     nudgeWallpaperRelayout() below is for.
     *
     * Note this does NOT mean flags are lost across an ordinary stop/resume of
     * the same instance — they are not. Case 1 is specifically about a NEW
     * instance. Cheap and idempotent either way, so it is safe to call on every
     * resume and focus gain.
     */
    fun healHomeModeChrome(reason: String) {
        if (!::homePager.isInitialized) return
        // Never heal mid-reveal. Going back to Homestead the opaque container
        // colour is deliberately deferred to the end of the animation, so it
        // cannot paint over the circle while it is still growing. Applying the
        // chrome now would do exactly that. The animation applies the right
        // chrome itself at the end, and a cancel now heals explicitly.
        if (isModeAnimating) return
        // The window ALWAYS wants the wallpaper flag now, in both modes — it is
        // declared in the theme and Homestead mode goes opaque with a view
        // inside the window instead of by clearing it. So "want" is no longer a
        // function of the mode; only a RECREATED window can be missing it.
        val wantWallpaper = true
        val haveWallpaper = (window.attributes.flags and
            android.view.WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER) != 0
        if (wantWallpaper == haveWallpaper) {
            // Window already agrees — refresh the mirrors so the diagnostic
            // reflects a real check, not a stale one.
            lastChromeMode = if (isPhoneModeShowing()) "phone" else "homestead"
            lastChromeFlagState = haveWallpaper.toString()

            // ...but agreeing is NOT the same as the wallpaper being on screen.
            // The flag is necessary, not sufficient: the window manager only
            // picks this window as the wallpaper target if it ALSO passes its
            // visibility checks at the moment it recomputes. Coming back from
            // screen-off or the keyguard is exactly where that can be missed,
            // and the result is a window that still carries the flag while the
            // wallpaper behind it is switched off — black, with the clock and
            // icons drawing fine on top. The flag alone cannot detect that.
            //
            // Re-dispatching the window attributes forces a relayout, which
            // makes the window manager recompute the wallpaper target now, when
            // we are demonstrably visible. Cheap, and only worth it in Phone
            // mode — Homestead mode covers the wallpaper with an opaque view, so
            // whether it is composited behind us is not observable there.
            if (isPhoneModeShowing()) nudgeWallpaperRelayout()
            return
        }
        val stamp = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
            .format(java.util.Date())
        if (chromeHealDisabled) {
            // Observe-only mode: record the drift, leave the window broken so the
            // failure is actually visible to the diagnostic.
            Log.w(TAG, "Home chrome drifted at ${'$'}reason — healing DISABLED, leaving broken")
            lastChromeHeal = "SKIPPED(disabled) ${'$'}reason: wanted=${'$'}wantWallpaper " +
                "had=${'$'}haveWallpaper @ ${'$'}stamp"
            return
        }
        val modeName = if (wantWallpaper) "phone" else "homestead"
        Log.w(TAG, "Home chrome drifted (mode=${'$'}modeName flag=${'$'}haveWallpaper) " +
            "at ${'$'}reason — re-arming")
        chromeHealCount++
        lastChromeHeal = "${'$'}reason: wanted=${'$'}wantWallpaper had=${'$'}haveWallpaper @ ${'$'}stamp"
        applyHomeModeChrome()
    }

    /**
     * Point the window chrome at whichever home fragment is showing.
     *
     * Phone mode needs the real system wallpaper, which means setting
     * FLAG_SHOW_WALLPAPER and letting the window/container be transparent so the
     * wallpaper composites behind us. Everything else stays on the opaque
     * Homestead black. (WallpaperManager.getDrawable() is deliberately NOT used —
     * it throws SecurityException on Android 14 without MANAGE_EXTERNAL_STORAGE;
     * the flag needs no permission at all.)
     */
    /**
     * Make the window manager re-evaluate whether this window is the wallpaper
     * target, without changing what the window asks for.
     *
     * Re-applying the same flags still dispatches a window-attributes change,
     * and that relayout is what re-runs the wallpaper-target search. Used when
     * the flag is already correct but the wallpaper may not actually be
     * composited behind us.
     */
    private fun nudgeWallpaperRelayout() {
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER)
        window.decorView.requestLayout()
    }

    /**
     * Is Homestead the app actually on screen right now, per the SYSTEM?
     *
     * isAppOnScreen is a plain flag written by every MainActivity instance's
     * onResume/onStop. This phone keeps several instances alive across tasks, so
     * a stale instance's onStop can write false while the live one is visible —
     * the flag lies exactly when it matters. Usage events are asked instead, and
     * the flag is only the fallback for when we lack permission to look.
     */
    private fun homesteadIsOnScreenNow(): Boolean {
        return try {
            val usm = getSystemService(Context.USAGE_STATS_SERVICE)
                as? android.app.usage.UsageStatsManager ?: return isAppOnScreen
            val now = System.currentTimeMillis()
            val events = usm.queryEvents(now - 10_000L, now) ?: return isAppOnScreen
            val ev = android.app.usage.UsageEvents.Event()
            var latest: String? = null
            while (events.hasNextEvent()) {
                events.getNextEvent(ev)
                if (ev.eventType == android.app.usage.UsageEvents.Event.MOVE_TO_FOREGROUND) {
                    latest = ev.packageName
                }
            }
            if (latest == null) isAppOnScreen else latest == packageName
        } catch (e: Exception) {
            Log.w(TAG, "foreground read failed, falling back to flag: " + e.message)
            isAppOnScreen
        }
    }

    private fun applyHomeModeChrome() {
        if (!::homePager.isInitialized) return
        val phoneMode = isPhoneModeShowing()

        // The window is ALWAYS a wallpaper window — the flag and a transparent
        // window background live in the theme and are never toggled at runtime.
        // Homestead mode goes opaque with a view INSIDE the window instead.
        //
        // This is how AOSP Launcher3 does it (res/values/styles.xml sets
        // windowShowWallpaper + a transparent windowBackground on the theme and
        // never calls clearFlags), and the reason is the STALE FRAME bug:
        //
        // When the task goes to background the window manager screenshots it
        // into a GraphicBuffer, and replays that snapshot as the starting window
        // on the way back in ("the state you see in Recents always matches the
        // state you'll first see when reopening the app" — AOSP task-snapshots).
        // The snapshot is a TASK-level artifact: it cannot see our per-fragment
        // mode flip. So a snapshot taken while Homestead was showing — including
        // its "could not connect" error page from a boot hours earlier — used to
        // be composited on the way back into Phone mode, behind our transparent
        // window, and it is a genuinely OLD frame rather than the previous one.
        //
        // Toggling the flag and the window background at runtime is what made
        // the snapshot and the resumed window disagree. Keeping the window
        // permanently wallpaper-backed means the snapshot path and the live
        // window always describe the same kind of window.
        // Belt and braces on the same root cause: ask the platform not to keep a
        // screenshot of this task at all. setRecentsScreenshotEnabled(false) is
        // the one app-side control over the snapshot mechanism (API 33+; we
        // compile against 34). Without a stored snapshot there is no old frame
        // to replay behind the transparent window on the way back in.
        //
        // Scoped to Phone mode so Homestead mode keeps a normal recents preview:
        // the snapshot is taken when the task goes to the background, so the
        // mode we are in NOW is the one whose image would be kept.
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            try {
                setRecentsScreenshotEnabled(!phoneMode)
                lastRecentsScreenshotSuppressed = phoneMode.toString()
            } catch (e: Exception) {
                Log.w(TAG, "setRecentsScreenshotEnabled failed: " + e.message)
                lastRecentsScreenshotSuppressed = "err: ${'$'}{e.message}"
            }
        }

        val opaque = Color.parseColor("#0D0D0D")
        val bg = if (phoneMode) Color.TRANSPARENT else opaque
        homePager.setBackgroundColor(bg)
        // home_pager stops at the top of the text-input container, so it does NOT
        // cover the whole screen. The opaque window background used to hide that
        // strip; now that the window stays transparent, the full-screen root has
        // to carry the colour or Homestead mode leaks wallpaper along the bottom.
        (findViewById<View>(android.R.id.content) as? android.view.ViewGroup)
            ?.getChildAt(0)?.setBackgroundColor(bg)

        // Record what we just did so the wallpaper-debug endpoint can report the
        // LIVE window state instead of us guessing from the Mac.
        // Keep the mode button's glyph in step with the mode it switches to.
        if (::floatingControls.isInitialized) {
            floatingControls.setPhoneMode(phoneMode)
        }

        // The rail's side-of-the-launcher report deliberately does NOT live here.
        // applyHomeModeChrome is SKIPPED on the way into Phone mode (see the
        // reveal's onAnimationEnd), so hanging it here made the rail miss exactly
        // the transition it exists to catch. See reportRailMode().
        reportRailMode()

        lastChromeMode = if (phoneMode) "phone" else "homestead"
        lastChromeFlagState = ((window.attributes.flags and
            android.view.WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER) != 0).toString()
    }

    /**
     * Flip between Homestead mode and Phone mode — wired to the small mode
     * button above the floating pair. The app drawer stays on a swipe-up inside
     * Phone mode; only the MODE switch is a button, because a vertical swipe
     * there would collide with scrolling a card (Josh 2026-09-05).
     */
    private fun toggleHomeMode() {
        // Guard re-entry: a second tap mid-animation would leave a fragment stranded.
        if (isModeAnimating) return
        if (!::activeHomeFragment.isInitialized) return

        // Any overlay (chat/sessions/guest) must come down first, or the mode flip
        // happens invisibly behind it.
        hideOverlay()
        val goingToPhone = activeHomeFragment !== phoneModeFragment
        isPhoneMode = goingToPhone
        if (goingToPhone) phoneModeFragment.refreshApps()

        val incoming = if (goingToPhone) phoneModeFragment else presenterFragment
        val outgoing = activeHomeFragment
        if (incoming === outgoing) return

        animateModeSwitch(goingToPhone, incoming, outgoing)
    }

    /**
     * Circular reveal between the two home modes, growing from the screen edge
     * the swipe came from (there is no mode button any more).
     *
     * The sequencing is the whole trick, and getting it wrong is what made the
     * first version look like a flash rather than a transition:
     *
     *   1. SHOW the incoming fragment immediately, underneath the outgoing one.
     *      Both are on screen for the duration — that is what makes the circle
     *      look like it is uncovering something real rather than cutting to it.
     *   2. Animate a circle on the OPAQUE Homestead view only. Phone mode is
     *      transparent (the system wallpaper composites behind it), so clipping
     *      it would reveal nothing and fading it risks compositing black.
     *   3. HIDE the outgoing fragment only in onAnimationEnd. Hiding it up front
     *      is exactly what produced the "next screen flashes into existence"
     *      symptom, because the reveal then had nothing left to uncover.
     *
     * Z-order: phoneModeFragment is added LAST so it naturally sits on top of
     * Homestead. The Homestead view is lifted with bringToFront() for the
     * duration, or the shrink would play out invisibly behind Phone mode.
     */
    private fun animateModeSwitch(goingToPhone: Boolean, incoming: Fragment, outgoing: Fragment) {
        // 1. Make the incoming fragment visible NOW, synchronously, so its view is
        //    laid out before we measure the reveal radius against it.
        supportFragmentManager.beginTransaction()
            .show(incoming)
            .commitNowAllowingStateLoss()
        activeHomeFragment = incoming
        // Undo the synchronous INVISIBLE applied at the end of a previous
        // transition (see onAnimationEnd). show() only clears GONE, so without
        // this the screen would come back permanently blank.
        incoming.view?.visibility = View.VISIBLE

        val opaqueView = presenterFragment.view
        // The in-app mode button is gone, so the reveal grows from the OVERLAY's
        // return button — the one he actually pressed. Falling back to the
        // bottom-right corner keeps a real animation if the overlay is not up
        // (permission declined), rather than degrading to an instant cut: that
        // transition is the part Josh called out as working "really beautifully".
        val center = audioRecorder.overlayReturnButtonCenter()
            ?: floatingControls.modeRevealCenter(goingToPhone)
            ?: Pair(
                resources.displayMetrics.widthPixels,
                resources.displayMetrics.heightPixels
            )

        // Nothing measurable yet -> finish the swap instantly rather than risk a
        // half-run animation stranding a fragment.
        if (opaqueView == null || opaqueView.width == 0) {
            supportFragmentManager.beginTransaction()
                .hide(outgoing)
                .commitAllowingStateLoss()
            applyHomeModeChrome()
            return
        }

        // The anchor is in screen space; the reveal wants view-local.
        val loc = IntArray(2)
        opaqueView.getLocationOnScreen(loc)
        val cx = (center.first - loc[0]).coerceIn(0, opaqueView.width)
        val cy = (center.second - loc[1]).coerceIn(0, opaqueView.height)

        // Must reach the FARTHEST corner — the anchor sits on a screen edge, so
        // too small a radius leaves an unrevealed crescent.
        val maxRadius = kotlin.math.hypot(
            maxOf(cx, opaqueView.width - cx).toDouble(),
            maxOf(cy, opaqueView.height - cy).toDouble()
        ).toFloat()

        isModeAnimating = true
        opaqueView.bringToFront()

        // WATCHDOG — isModeAnimating is a LATCH, and every future mode switch is
        // refused while it is stuck on (toggleHomeMode returns early on it). If
        // any path fails to clear it, the mode button dies permanently and the
        // only cure is restarting the app. That is exactly the "I click the home
        // button and genuinely nothing happens" symptom.
        //
        // The reveal's own callbacks clear it in the normal case, but they are
        // not guaranteed to run: a Choreographer frame callback that never fires
        // because the window is not being drawn, or an animator that is dropped
        // before it starts, both leave the latch set forever. Rather than try to
        // enumerate those paths, guarantee the exit — if the flag is still set
        // well after this reveal could possibly have finished, clear it and
        // reconcile the chrome. Idempotent: a normal run has already cleared it
        // and this does nothing.
        val watchdogFor = if (goingToPhone) MODE_ANIM_OUT_MS else MODE_ANIM_IN_MS
        homePager.postDelayed({
            if (isModeAnimating) {
                Log.w(TAG, "Mode reveal never signalled completion — releasing the latch")
                isModeAnimating = false
                modeAnimWatchdogTrips++
                healHomeModeChrome("modeAnimWatchdog")
            }
        }, watchdogFor + 1200L)

        // Record the mode at the START in both directions. Going back to
        // Homestead the chrome pass is deferred to the end (see below).
        if (::floatingControls.isInitialized) {
            floatingControls.setPhoneMode(goingToPhone)
        }

        // Material 3 emphasized easing: accelerate away, decelerate in.
        val easing = if (goingToPhone) {
            android.view.animation.PathInterpolator(0.3f, 0f, 0.8f, 0.15f)
        } else {
            android.view.animation.PathInterpolator(0.05f, 0.7f, 0.1f, 1f)
        }

        val anim = if (goingToPhone) {
            android.view.ViewAnimationUtils.createCircularReveal(
                opaqueView, cx, cy, maxRadius, 0f)
        } else {
            android.view.ViewAnimationUtils.createCircularReveal(
                opaqueView, cx, cy, 0f, maxRadius)
        }
        anim.duration = if (goingToPhone) MODE_ANIM_OUT_MS else MODE_ANIM_IN_MS
        anim.interpolator = easing

        // No hardware layer on purpose: the reveal is already GPU-driven, and
        // forcing a layer on a full-screen WebView costs megabytes and can
        // corrupt its rendering.

        var cancelled = false
        anim.addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationCancel(animation: android.animation.Animator) {
                cancelled = true
                // A cancel skips the whole onAnimationEnd body below, including
                // the chrome restore for the going-to-Homestead direction — which
                // would strand an opaque Homestead behind a transparent window.
                // The fragment swap has already happened either way, so just make
                // the chrome match the mode we are actually in.
                //
                // Drop the animating flag FIRST: the heal deliberately refuses to
                // run mid-reveal, and this reveal is over.
                isModeAnimating = false
                healHomeModeChrome("modeAnimCancel")
                // healHomeModeChrome early-returns when the flag already agrees,
                // so it cannot be relied on to carry the rail's report.
                reportRailMode()
            }

            override fun onAnimationEnd(animation: android.animation.Animator) {
                // onAnimationEnd fires on cancel too — without this guard a rapid
                // double-tap hides the wrong screen and leaves a blank pager.
                if (!cancelled) {
                    // 3. The outgoing fragment goes away — but the ORDER here is
                    //    load-bearing.
                    //
                    //    createCircularReveal RESTORES the view's full clip when it
                    //    ends, and commitAllowingStateLoss() is asynchronous. That
                    //    leaves a gap of one or more frames where Homestead is
                    //    un-clipped, fully drawn and visible again — which is
                    //    exactly the "Homestead briefly redraws at the end" flash.
                    //
                    //    So drop its visibility synchronously first, then let the
                    //    transaction catch up behind it.
                    if (goingToPhone) {
                        outgoing.view?.visibility = View.INVISIBLE
                    }
                    supportFragmentManager.beginTransaction()
                        .hide(outgoing)
                        .commitAllowingStateLoss()
                    // Going back to Homestead, the opaque container colour lands
                    // at the END so it cannot paint over the reveal while the
                    // circle is still growing. (The wallpaper FLAG is no longer
                    // touched here at all — it stays on permanently now.)
                    if (!goingToPhone) applyHomeModeChrome()
                    // BOTH directions, unlike the chrome pass above: the rail has
                    // to come down going INTO Phone mode just as much as it goes
                    // back up leaving it. Reporting only on the Homestead branch
                    // is precisely the bug this line exists to prevent.
                    reportRailMode()
                }
                isModeAnimating = false
            }
        })

        if (goingToPhone) {
            // Adding FLAG_SHOW_WALLPAPER makes the system attach the wallpaper
            // surface behind our window — a real relayout, not a repaint. Doing it
            // and animating in the same frame meant the surface was still settling
            // partway through the reveal, which showed up as the wallpaper image
            // glitching near the end of the animation.
            //
            // So: arm the chrome, wait for that frame to actually land, and only
            // then start the circle. Homestead is still opaque and on top, so
            // nothing is visible during the wait.
            applyHomeModeChrome()
            // Wait for a real composited frame, not just the next message-queue
            // turn: doFrame fires after the frame carrying the relayout has been
            // drawn, which is when the wallpaper surface is genuinely up.
            android.view.Choreographer.getInstance().postFrameCallback {
                opaqueView.post {
                    if (!isFinishing && !isDestroyed) anim.start() else isModeAnimating = false
                }
            }
        } else {
            anim.start()
        }
    }

    // Track currently selected session for voice/text input — persisted across reinstalls
    private var currentSessionName: String?
        get() = getSharedPreferences("homestead_session", MODE_PRIVATE)
            .getString("active_session", null)
        set(value) {
            getSharedPreferences("homestead_session", MODE_PRIVATE)
                .edit().putString("active_session", value).apply()
        }

    // Which home mode Joshua is in: Homestead (presenter) or Phone (wallpaper + apps).
    // Persisted so it survives screen off/on, pressing Home, and a low-memory kill —
    // the Activity discards savedInstanceState (android:stateNotNeeded), so prefs are
    // the only durable place for this.
    private var isPhoneMode: Boolean
        get() = getSharedPreferences("homestead_home_mode", MODE_PRIVATE)
            .getBoolean("phone_mode", false)
        set(value) {
            getSharedPreferences("homestead_home_mode", MODE_PRIVATE)
                .edit().putBoolean("phone_mode", value).apply()
        }

    // Walkie-talkie: which session/guest is being targeted for press-to-talk
    private var walkieTalkieTargetSession: String? = null
    private var walkieTalkieTargetGuestLogin: String? = null

    // Unified pending message — replaces old resend/undo state fields
    data class PendingMessage(
        val type: RecordingHistoryManager.MessageType,
        val audioFile: java.io.File? = null,
        val text: String? = null,
        val historyId: String? = null
    )
    private var pendingMessage: PendingMessage? = null

    // Native input bridge state: when set, the text input is in "card mode" and submit/cancel
    // routes the value back to the Presenter WebView instead of the destination picker.
    // Also remembers original hint + inputType so we can restore after the card interaction.
    private data class CardInputMode(
        val cardId: String,
        val originalHint: CharSequence?,
        val originalInputType: Int,
        val originalMaxLines: Int
    )
    private var cardInputMode: CardInputMode? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Let /wallpaper-debug read this window's REAL flags instead of a mirror
        // of what we last tried to set. Weak so it can never pin a dead activity.
        liveActivity = java.lang.ref.WeakReference(this)
        activityInstanceId = Integer.toHexString(System.identityHashCode(this))
        activityCreateCount++
        Log.i(TAG, "onCreate instance=$activityInstanceId create#=$activityCreateCount")

        // Edge-to-edge: draw content behind system bars (removes black bar at top of launcher)
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)

        setContentView(R.layout.activity_main)

        // Handle IME (keyboard) insets — push entire layout up when keyboard appears
        val rootConstraint = findViewById<android.view.View>(android.R.id.content)
            .let { (it as? android.view.ViewGroup)?.getChildAt(0) }
        if (rootConstraint != null) {
            androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(rootConstraint) { v, insets ->
                val imeBottom = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime()).bottom
                val navBottom = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.navigationBars()).bottom
                // Use whichever is larger: keyboard or nav bar
                v.setPadding(v.paddingLeft, v.paddingTop, v.paddingRight, maxOf(imeBottom, navBottom))
                // The rail hides for the NATIVE ANDROID KEYBOARD, not for the
                // app's own text box (Josh 2026-09-09: "Only if the native
                // keyboard from android is up, not if I'm in keyboard mode").
                // isVisible(ime()) is the system's own answer, so "keyboard mode"
                // with the box open but no keyboard correctly keeps the rail.
                reportKeyboardVisibility(
                    insets.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()))
                insets
            }
        }

        // Load fonts
        val spaceGrotesk = ResourcesCompat.getFont(this, R.font.space_grotesk_variable)
        fontHeader = Typeface.create(spaceGrotesk, Typeface.BOLD)
        fontBodyMedium = ResourcesCompat.getFont(this, R.font.inter_medium)

        // Initialize input manager and audio recorder
        inputManager = InputManager(this)
        audioRecorder = RecorderHandle(this)
        // If we were recreated mid-take (rotation, wallpaper change, coming back
        // after a background kill), the service still holds the mic. Binding is
        // async, so re-arm the controls the moment we learn a take is live —
        // otherwise the UI would sit idle on top of a running recording.
        audioRecorder.onConnected = { alreadyRecording ->
            if (alreadyRecording) {
                runOnUiThread {
                    // floatingControls is created later in onCreate and is lateinit,
                    // so the bind callback can land before it exists. Touching it
                    // then would throw UninitializedPropertyAccessException.
                    if (::floatingControls.isInitialized) {
                        floatingControls.isRecording = true
                        audioLevelHandler.post(audioLevelRunnable)
                        Log.d(TAG, "Re-attached to a take already in progress")
                    } else {
                        pendingReattach = true
                        Log.d(TAG, "Take in progress; deferring re-attach until UI exists")
                    }
                }
            }
        }
        audioRecorder.bind()
        recordingHistory = RecordingHistoryManager(this)
        setupInputManagerCallbacks()

        // Self-heal contacts grant: every sideload reinstall resets runtime permissions,
        // and the contact-write endpoints (add_contact / set_contact_notes) throw
        // SecurityException without WRITE_CONTACTS. Request at startup so Josh gets a
        // permission dialog instead of having to dig through Settings after each update.
        ensureContactsPermission()

        // Initialize views
        textInputContainer = findViewById(R.id.text_input_container)
        textInput = findViewById(R.id.text_input)

        // Workbench header no longer used — swipe nav replaced it
        // Initialize stubs so field references don't crash
        workbenchHeader = LinearLayout(this).apply { visibility = View.GONE }
        headerSessionsBtn = TextView(this)
        headerWebBtn = TextView(this)
        headerStatusBtn = TextView(this)

        // Home container — presenter and homestead-web fragments swap via show/hide.
        // Swipe nav retired 2026-04-20; status page moved to the standalone recovery APK.
        homePager = findViewById(R.id.home_pager)

        // REMOVE ANY FRAGMENTS LEFT OVER FROM A PREVIOUS ACTIVITY INSTANCE FIRST.
        //
        // This is the stale-frame bug. android:stateNotNeeded="true" means
        // savedInstanceState is always null, so this used to read as "always a
        // clean start" and add() was called unconditionally. But the
        // FragmentManager restores previously-added fragments across a
        // recreation regardless of savedInstanceState — and this activity
        // declares no configChanges, so a rotation, a dark-mode flip, a
        // wallpaper change or a low-memory kill of a backgrounded launcher all
        // recreate it.
        //
        // The three fields below are `val`s rebuilt with the new instance, so
        // add() then stacked a SECOND set of fragments on top of the restored
        // ones. Josh's phone was found with THREE sets live in this one
        // container. The orphans are opaque WebViews nobody hides any more —
        // including a Homestead view still showing "Couldn't reconnect" from a
        // boot when the server was down — so they kept drawing over the
        // wallpaper in Phone mode. That is why the retained image was an OLD
        // frame from an earlier point in time rather than the previous screen.
        listOf("presenter", "homestead", "phonemode").forEach { tag ->
            supportFragmentManager.findFragmentByTag(tag)?.let { stale ->
                Log.w(TAG, "Removing orphaned '" + tag + "' fragment from a previous instance")
                supportFragmentManager.beginTransaction()
                    .remove(stale)
                    .commitNowAllowingStateLoss()
                orphanFragmentsRemoved++
            }
        }

        supportFragmentManager.beginTransaction().apply {
            add(R.id.home_pager, presenterFragment, "presenter")
            add(R.id.home_pager, homesteadFragment, "homestead").hide(homesteadFragment)
            add(R.id.home_pager, phoneModeFragment, "phonemode").hide(phoneModeFragment)
        }.commit()
        activeHomeFragment = presenterFragment

        // Restore the mode Joshua was last in (Homestead vs Phone).
        if (isPhoneMode) {
            supportFragmentManager.beginTransaction()
                .hide(presenterFragment)
                .show(phoneModeFragment)
                .commitAllowingStateLoss()
            activeHomeFragment = phoneModeFragment
        }
        // Both commits above are ASYNC. Without this the hide/show has not been
        // applied yet, so the presenter's opaque WebView is still on screen when
        // the wallpaper chrome is set — which is exactly how Phone mode ended up
        // showing the Homestead background instead of the wallpaper.
        supportFragmentManager.executePendingTransactions()
        applyHomeModeChrome()

        presenterFragment.onSwitchToWebView = { switchHomeFragment(homesteadFragment) }
        homesteadFragment.onSwitchToPresenter = { switchHomeFragment(presenterFragment) }

        // Overlay fragments (chat, sessions, guest chat) use the legacy fragment_container
        val fragmentContainer = findViewById<FrameLayout>(R.id.fragment_container)
        fragmentContainer.setBackgroundColor(Color.parseColor("#0D0D0D"))
        supportFragmentManager.beginTransaction().apply {
            add(R.id.fragment_container, sessionsFragment, "sessions").hide(sessionsFragment)
            add(R.id.fragment_container, chatViewFragment, "chatview").hide(chatViewFragment)
            add(R.id.fragment_container, guestChatFragment, "guestchat").hide(guestChatFragment)
        }.commit()

        // Restore persisted active session
        currentSessionName?.let { sessionName ->
            sessionsFragment.activeSessionName = sessionName
            chatViewFragment.setSession(sessionName)
        }

        // Setup session click handler - navigate to chat view
        sessionsFragment.onSessionClick = { session ->
            currentSessionName = session.name
            sessionsFragment.activeSessionName = session.name
            sessionsFragment.markSessionViewed(session.name)
            recordSessionAccess(session.name)
            chatViewFragment.setSession(session.name)
            chatViewFragment.setSessions(sessionsFragment.getSessions())
            switchFragment(chatViewFragment)
            floatingControls.activeNav = NavButton.WORKBENCH
            // floatingControls.sessionLabel = session.name
        }

        // When "Screen" button changes active session
        sessionsFragment.onActiveSessionChanged = { sessionName ->
            currentSessionName = sessionName
            recordSessionAccess(sessionName)
            chatViewFragment.setSession(sessionName)
            // floatingControls.sessionLabel = sessionName
        }

        // Walkie-talkie: hold JOIN button to record, release to send
        sessionsFragment.onWalkieTalkieStart = { sessionName ->
            walkieTalkieTargetSession = sessionName
            sessionsFragment.walkieTalkieSession = sessionName
            // Check permission
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED) {
                val file = audioRecorder.startRecording()
                if (file != null) {
                    vibrateLight()
                    audioLevelHandler.post(audioLevelRunnable)
                }
            } else {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), PERMISSION_REQUEST_AUDIO)
                sessionsFragment.walkieTalkieSession = null
                walkieTalkieTargetSession = null
            }
        }
        sessionsFragment.onWalkieTalkieStop = { sessionName ->
            audioLevelHandler.removeCallbacks(audioLevelRunnable)
            floatingControls.audioLevel = 0f
            sessionsFragment.walkieTalkieSession = null

            val audioFile = audioRecorder.stopRecording()
            val targetSession = walkieTalkieTargetSession ?: sessionName
            walkieTalkieTargetSession = null

            if (audioFile != null && audioFile.exists() && audioFile.length() > 0L) {
                vibrateLight()
                sessionsFragment.walkieTalkieSending = targetSession

                lifecycleScope.launch {
                    try {
                        val result = transcriptionService.transcribeAndSend(audioFile, targetSession)
                        audioFile.delete()
                        runOnUiThread {
                            sessionsFragment.walkieTalkieSending = null
                            if (result.success) {
                                vibrateLight()
                                val preview = "${result.transcript?.take(50) ?: ""}${if ((result.transcript?.length ?: 0) > 50) "..." else ""}"
                                showDeliveryToast(preview, result.verified)
                            } else {
                                Toast.makeText(this@MainActivity, "Error: ${result.error}", Toast.LENGTH_LONG).show()
                            }
                        }
                    } catch (e: Exception) {
                        runOnUiThread {
                            sessionsFragment.walkieTalkieSending = null
                            Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        }

        // Setup chat view callbacks
        chatViewFragment.onSessionSwitch = { sessionName ->
            currentSessionName = sessionName
            sessionsFragment.activeSessionName = sessionName
            recordSessionAccess(sessionName)
            chatViewFragment.setSession(sessionName)
            // floatingControls.sessionLabel = sessionName
        }
        chatViewFragment.onBackPressed = {
            // Back from chat → go to web page
            hideOverlay()
            switchHomeFragment(homesteadFragment)
        }
        chatViewFragment.getSessionsProvider = {
            sessionsFragment.getSessions()
        }

        // Phone mode: launching an app + the swipe-up handoff to the full drawer.
        phoneModeFragment.onAppClick = { pkg ->
            loadLaunchableApps().firstOrNull { it.packageName == pkg && !it.isWorkProfile }
                ?.let { launchApp(it) }
        }
        phoneModeFragment.onAppInfo = { pkg ->
            try {
                startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.parse("package:${'$'}pkg")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            } catch (_: Exception) {
                Toast.makeText(this, "Can't open app info", Toast.LENGTH_SHORT).show()
            }
        }

        // The phone screen's swipe-up to the app drawer, restored — this one was
        // never in conflict with anything, and Josh asked for it to stay back
        // when the mode swipe was still on the table.
        phoneModeFragment.onSwipeUp = {
            vibrateLight()
            showAppsOverlay()
        }

        // Tap the time -> clock app. ACTION_SHOW_ALARMS is the documented way in;
        // fall back to whatever the device's clock package actually is, since the
        // Pixel clock and OEM clocks don't share a package name.
        phoneModeFragment.onClockClick = {
            vibrateLight()
            val alarms = Intent(android.provider.AlarmClock.ACTION_SHOW_ALARMS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (alarms.resolveActivity(packageManager) != null) {
                startActivity(alarms)
            } else {
                launchByPackages(listOf(
                    "com.google.android.deskclock",
                    "com.android.deskclock",
                ), "clock")
            }
        }

        // Tap the date -> calendar, opened on today.
        phoneModeFragment.onDateClick = {
            vibrateLight()
            val builder = android.provider.CalendarContract.CONTENT_URI.buildUpon()
                .appendPath("time")
            android.content.ContentUris.appendId(builder, System.currentTimeMillis())
            val cal = Intent(Intent.ACTION_VIEW, builder.build())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (cal.resolveActivity(packageManager) != null) {
                startActivity(cal)
            } else {
                launchByPackages(listOf(
                    "com.google.android.calendar",
                    "com.android.calendar",
                ), "calendar")
            }
        }

        // Tap the weather -> the weather app. Same shape as the clock and date
        // handlers: try the generic route first, then fall back to known
        // packages, since there is no ACTION_ constant for weather.
        // In-app updates. Homestead had the install permission and FileProvider
        // declared but never any code that checked for a build — so updating
        // meant leaving for the Recovery app. This closes that (Josh 2026-09-06).
        appUpdater = AppUpdater(this)

        phoneModeFragment.onWeatherClick = {
            vibrateLight()
            launchByPackages(listOf(
                // What is actually installed on Josh's Pixel 9a.
                "com.google.android.apps.weather",
                // Common alternatives, so this still works on another handset.
                "com.google.android.googlequicksearchbox",
                "com.weather.Weather",
                "com.accuweather.android",
            ), "weather")
        }

        // FloatingControls is still CONSTRUCTED but no longer ATTACHED to the
        // view tree (Josh 2026-09-05). He collapsed the two control surfaces into
        // one: "I'd like the version that appears when I have other apps open to
        // be the permanent one that stays around forever. The other one can go
        // away." The floating overlay is that survivor, and it now shows in
        // Homestead too — so attaching this as well would be the literal
        // two-copies-in-two-spots problem he asked to be rid of.
        //
        // The object stays because it is more than its buttons: the destination
        // picker, the undo-send bar and the recording-state plumbing all still
        // live here and are still used. Only attach() is dropped, which is what
        // put the redundant buttons on screen.
        //
        // He explicitly released the reason it existed — per-page placement —
        // saying dragging is easy enough that it no longer matters. So nothing
        // he values is lost.
        floatingControls = FloatingControls(this)
        val rootCL = (findViewById<View>(android.R.id.content) as android.view.ViewGroup).getChildAt(0) as androidx.constraintlayout.widget.ConstraintLayout
        // One control surface — unless there is none. If the overlay permission
        // is missing or gets revoked (Android revokes it from unused apps, and he
        // can toggle it himself), the floating pair cannot draw, and detaching
        // this one too would leave him with NO buttons anywhere. So the in-app
        // pair stays as the fallback for exactly that case.
        if (Settings.canDrawOverlays(this)) {
            floatingControls.prepareDetached(rootCL)
        } else {
            floatingControls.attach(this, rootCL)
        }
        floatingControls.activeNav = NavButton.PRESENTER

        // The service told us a take was already running before these controls
        // existed. Now they do — show it.
        if (pendingReattach) {
            pendingReattach = false
            floatingControls.isRecording = true
            audioLevelHandler.post(audioLevelRunnable)
            Log.d(TAG, "Deferred re-attach applied")
        }

        // Update session label from persisted state
        // floatingControls.sessionLabel = currentSessionName

        // Nav clicks no longer used — swipe navigation replaces buttons
        floatingControls.onNavClick = { _ -> }

        floatingControls.onRecordingStart = {
            startVoiceInput()
        }

        floatingControls.onMicGesture = { action ->
            handleMicGesture(action)
        }

        floatingControls.onMicGestureWithTarget = { action, sessionName ->
            handleMicGestureWithTarget(action, sessionName)
        }

        floatingControls.onKeyboardTap = {
            vibrateLight()
            toggleTextInput()
        }

        floatingControls.onHistoryTap = {
            vibrateLight()
            showRecordingHistoryPanel()
        }

        floatingControls.onAppsTap = {
            vibrateLight()
            toggleHomeMode()
        }

        floatingControls.onTrackpadTap = {
            vibrateLight()
            showTrackpadOverlay()
        }

        floatingControls.onCancelRecording = {
            cancelVoiceInput()
        }

        // Long-press a send circle → menu. Josh 2026-09-05 was explicit that
        // this is TWO steps, never a long-press that cancels on its own: "I
        // don't mean it auto canceling… you hold it and then a menu pops up and
        // one of those menu items is cancel current recording."
        floatingControls.onSendLongPress = {
            vibrateLight()
            showSendMenu()
        }

        // A hold has lasted long enough that dragging would now move the pair.
        // The buzz is the only signal move mode is available — without it he
        // would have to discover it by accident.
        floatingControls.onLongPressArmed = { vibrateLight() }

        // While he is dragging the buttons, the drag must not ALSO read as a
        // mode swipe — a downward move would otherwise drop him onto the phone
        // screen mid-drag.
        floatingControls.onMoveModeChanged = { moving -> isMovingControls = moving }

        floatingControls.onPeekTranscription = {
            peekTranscription()
        }

        floatingControls.onFetchStewards = { callback ->
            lifecycleScope.launch {
                val stewards = withContext(Dispatchers.IO) {
                    try {
                        val url = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/stewards")
                        val conn = url.openConnection() as java.net.HttpURLConnection
                        conn.connectTimeout = 5000
                        conn.readTimeout = 5000
                        val body = conn.inputStream.bufferedReader().readText()
                        val json = org.json.JSONObject(body)
                        val arr = json.optJSONArray("stewards") ?: return@withContext emptyList()
                        val result = mutableListOf<FloatingControls.StewardInfo>()
                        for (i in 0 until arr.length()) {
                            val s = arr.getJSONObject(i)
                            val parentId = s.optString("id", s.optString("name", ""))
                            val parentSession = s.optString("sessionName", "holler-$parentId")

                            val substewards = mutableListOf<FloatingControls.SubstewardInfo>()
                            val subsArr = s.optJSONArray("substewards")
                            if (subsArr != null) {
                                for (j in 0 until subsArr.length()) {
                                    val sub = subsArr.getJSONObject(j)
                                    val subId = sub.optString("id", sub.optString("name", ""))
                                    val subSession = sub.optString("sessionName", "holler-$parentId--$subId")
                                    substewards.add(FloatingControls.SubstewardInfo(
                                        sessionName = subSession,
                                        name = sub.optString("name", subId),
                                        shorthand = sub.optString("shorthand", subId.take(2).uppercase()),
                                        icon = if (sub.isNull("icon")) null else sub.optString("icon", null),
                                        color = sub.optString("color", s.optString("color", "#00CCFF"))
                                    ))
                                }
                            }

                            result.add(FloatingControls.StewardInfo(
                                sessionName = parentSession,
                                name = parentId,
                                project = s.optString("name", parentId),
                                shorthand = s.optString("shorthand", parentId.take(2).uppercase()),
                                icon = if (s.isNull("icon")) null else s.optString("icon", null),
                                color = s.optString("color", "#00CCFF"),
                                substewards = substewards
                            ))
                        }
                        result
                    } catch (e: Exception) {
                        android.util.Log.e(TAG, "Failed to fetch stewards: ${e.message}")
                        emptyList()
                    }
                }
                // Keep the quick-send circles supplied with icons/colors.
                if (stewards.isNotEmpty()) cachedStewards = stewards
                callback(stewards)
            }
        }

        floatingControls.onUndoSend = {
            pendingMessage = null
            Toast.makeText(this, "Cancelled", Toast.LENGTH_SHORT).show()
        }

        // ── Quick send (Josh 2026-09-04) ──
        // Labels come from the presenter WebView's own state via the existing
        // trackpad bridge, so these route exactly where the desktop split-pill
        // would. The WebView is only hidden (never replaced) when he navigates,
        // so this still answers correctly from any screen.
        // ── Floating overlay (Josh 2026-09-04: "Yes — float over everything") ──
        // The service owns the overlay because it outlives this Activity, which
        // is exactly the case that matters: he is in Chrome and we may be dead.
        // Reuse the same suppliers as the in-app circles so there is one source
        // of truth for both the labels and the send path.
        audioRecorder.overlayTargets = {
            floatingControls.onFetchQuickSendTargets?.invoke()
                ?: FloatingControls.QuickSendTargets("", "", "")
        }
        audioRecorder.onOverlaySendSteward = { floatingControls.onQuickSendSteward?.invoke() }
        audioRecorder.onOverlaySendCard = { floatingControls.onQuickSendCard?.invoke() }
        // Long-press out in Chrome. The floating window is NOT_FOCUSABLE (so the
        // app underneath stays usable), and a popup menu cannot anchor to a
        // window that can't take focus — so bring Homestead forward and open the
        // menu here, where it can.
        // Tapping the floating record button starts or stops a take from
        // wherever he is — the reason the overlay had to exist in its idle state
        // and not only during a recording.
        audioRecorder.onOverlayRecordTap = {
            runOnUiThread {
                // GUARD A DEAD INSTANCE. This lambda captures `this`, lives on the
                // shared RecordingService, and onDestroy clears none of the
                // handlers — so between one activity being destroyed and the next
                // one binding, the service still holds a callback pointing at a
                // corpse. Normally harmless (the next onCreate overwrites it, last
                // writer wins), but the Quick Settings tile can fire this from
                // OUTSIDE the app at exactly that moment, and startVoiceInput()
                // touches the window: requestPermissions throws on a destroyed
                // activity, and hideTextInput/maybeRequestOverlayPermission poke
                // views on a dead one. This phone keeps several MainActivity
                // instances alive, so "which instance is this?" is a real question
                // here rather than a theoretical one.
                // Swallowing the tap here would be worse than crashing — the tile
                // would look dead. Clearing the handler instead makes the NEXT
                // toggleRecordingFromOutside() return false, so the tile takes its
                // existing fallback (start the service, which brings up a fresh
                // activity that wires a live handler). One lost tap, self-healing.
                if (isFinishing || isDestroyed) {
                    Log.w(TAG, "Record tap arrived on a destroyed activity — " +
                        "clearing the stale handler so the tile can fall back")
                    audioRecorder.onOverlayRecordTap = null
                    return@runOnUiThread
                }
                // A second tap cancels, wherever it comes from — handleMicGesture
                // now does exactly that, on screen or off (Josh 2026-09-11).
                if (audioRecorder.isRecording()) handleMicGesture(MicAction.CANCEL)
                else startVoiceInput()
            }
        }

        // The keyboard needs a real text field and a real window, so this brings
        // Homestead forward rather than trying to type from the overlay.
        audioRecorder.onOverlayKeyboardTap = {
            runOnUiThread {
                startActivity(Intent(this, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                })
                findViewById<View>(android.R.id.content).postDelayed({ toggleTextInput() }, 250)
            }
        }

        // The return button. Josh 2026-09-05: "if I'm in a different app basically
        // it would take me back to Homestead… back to whatever default Homestead
        // screen is on right at that time. So if it's like on the phone mode then
        // it takes you back to phone… a way to leave that app and get back to
        // where you were."
        //
        // No mode is forced here, deliberately. MainActivity is singleTask, so
        // this RESUMES the existing instance with its fragments exactly as he
        // left them. And if the process was killed while he was away, onCreate
        // restores the mode from prefs (isPhoneMode) — so both the resume path
        // and the cold-start path put him back where he was, which is the whole
        // point of the button.
        audioRecorder.onOverlayReturnTap = {
            runOnUiThread {
                // ONE BUTTON, TWO HALVES OF THE SAME IDEA — and the in-app half
                // has to be here, because the overlay is now the ONLY control
                // surface. When the in-app mode button was retired in favour of
                // the overlay, this handler kept only the "bring Homestead to
                // the front" half. Tapped while Homestead was ALREADY in front,
                // REORDER_TO_FRONT is a no-op — so the button did visibly
                // nothing and the modes could not be switched at all
                // (Josh 2026-09-06: "when I click on the home button to switch
                // between the two modes, genuinely nothing happens now").
                //
                // Outside the app: get me back to Homestead, in whichever mode I
                // left it. Inside the app: there is nothing to return to, so it
                // does what the retired in-app button did — switch modes.
                // Ask the SYSTEM what is on screen rather than trusting
                // isAppOnScreen. That flag is written by every MainActivity
                // instance's onResume/onStop, and this phone keeps several
                // instances alive across tasks — a stale one's onStop writes
                // false milliseconds after the live one wrote true, so the flag
                // can read "not on screen" while Josh is looking straight at the
                // app. The mode button would then take the return branch and do
                // visibly nothing, which is the original symptom all over again.
                // (Same trap the overlay hit from the other side; see
                // RecordingService.homesteadIsOnScreen.) The flag stays as the
                // fallback for when we are not allowed to look.
                if (homesteadIsOnScreenNow()) {
                    toggleHomeMode()
                } else {
                    startActivity(Intent(this, MainActivity::class.java).apply {
                        addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    })
                }
            }
        }

        // What the overlay's long-press menu offers. The overlay draws it in its
        // OWN window, so this is just the content — no anchoring, and no need to
        // bring the Activity forward first.
        //
        // Built fresh on every open so "Peek"/"Cancel" track whether a take is
        // actually running right now, exactly as the old menu did.
        audioRecorder.overlayMenuItems = {
            val items = mutableListOf<Pair<String, () -> Unit>>()
            if (audioRecorder.isRecording()) {
                items += "Peek at transcription" to { runOnUiThread { peekTranscription() } }
                items += "Cancel current recording" to { runOnUiThread { cancelVoiceInput() } }
            }
            // These two open Activity UI, so they still need Homestead forward —
            // that is the action's own requirement, not the menu's.
            items += "Past recordings" to {
                runOnUiThread {
                    bringSelfForward()
                    window.decorView.postDelayed({ showRecordingHistoryPanel() }, 250)
                }
            }
            items += "Control the mouse" to {
                runOnUiThread {
                    bringSelfForward()
                    window.decorView.postDelayed({ showTrackpadOverlay() }, 250)
                }
            }
            if (floatingControls.hasCustomPosition() || audioRecorder.overlayHasCustomPosition()) {
                items += "Reset button position" to {
                    runOnUiThread {
                        floatingControls.resetPosition()
                        audioRecorder.overlayResetPosition()
                    }
                }
            }
            items
        }

        // Fallback only — used if the overlay cannot raise its own menu window.
        audioRecorder.onOverlayLongPress = {
            runOnUiThread {
                bringSelfForward()
                floatingControls.sendMenuAnchor()?.postDelayed({ showSendMenu() }, 250)
            }
        }

        // Prime the steward cache at startup so the very first recording already
        // has an icon for its circle — otherwise the cache is empty until he
        // happens to open the destination picker.
        floatingControls.onFetchStewards?.invoke { }

        floatingControls.onFetchQuickSendTargets = {
            val steward = try { presenterFragment.trackpadGetSelectedSteward() } catch (_: Exception) { "" }
            val card = try { presenterFragment.trackpadGetCurrentCardId() } catch (_: Exception) { "" }

            // Circle 1 identifies WHERE the send is going.
            //
            // On a top-level steward it shows that steward's own ICON (Josh:
            // "the rooster, or whatever the icon would be") — unchanged.
            //
            // On a WORKER (Josh 2026-09-10) it shows the worker's first two
            // LETTERS as the big element, and hands back the STEADING's emoji
            // separately so the circle can pin it to its corner as a small
            // badge: "that way I can know which setting I'm in, and then the
            // actual first two letters will tell me which worker I'm associated
            // to." Same rule the presenter's send pill uses (workerBadgeLetters
            // in the renderer) so the two surfaces cannot drift apart.
            var glyph = ""
            var colorHex = ""
            var steadingBadge = ""
            if (steward.isNotEmpty()) {
                val parentInfo = cachedStewards.firstOrNull { it.sessionName == steward }
                val subPair = cachedStewards.flatMap { p -> p.substewards.map { p to it } }
                    .firstOrNull { it.second.sessionName == steward }
                val info = parentInfo
                    ?: subPair?.let { (_, sub) ->
                            FloatingControls.StewardInfo(
                                sessionName = sub.sessionName, name = sub.name,
                                project = sub.name, shorthand = sub.shorthand,
                                icon = sub.icon, color = sub.color,
                                substewards = emptyList()
                            )
                        }

                // A worker/substeward session is the "holler-<steading>--<rest>"
                // shape. `parentInfo != null` means he is on the steading ITSELF,
                // so that case is deliberately excluded even though the id could
                // in principle contain a dash.
                val isWorker = parentInfo == null && steward.contains("--")

                if (isWorker) {
                    // Prefer the worker's stored NAME (what he reads in the row)
                    // over the raw session suffix, so "Worker Badge And Direct
                    // Send" yields "WO" rather than a slug fragment.
                    val base = info?.name?.takeIf { it.isNotEmpty() }
                        ?: steward.substringAfter("--")
                    glyph = base.filter { it.isLetterOrDigit() }.take(2).uppercase()
                    // The badge is the STEADING's emoji — resolve it off the
                    // parent, never off the worker (workers carry no icon).
                    val parent = subPair?.first
                        ?: cachedStewards.firstOrNull {
                            steward.startsWith(it.sessionName + "--")
                        }
                    steadingBadge = parent?.icon?.takeIf { it.isNotEmpty() } ?: ""
                    colorHex = info?.color ?: parent?.color ?: "#00CCFF"
                } else {
                    glyph = info?.icon?.takeIf { it.isNotEmpty() }
                        ?: info?.shorthand?.takeIf { it.isNotEmpty() }
                        ?: steward.removePrefix("holler-").take(2).uppercase()
                    colorHex = info?.color ?: "#00CCFF"
                }

                // Never let the circle go blank — if the name yielded no usable
                // letters, fall back to the old session-derived pair.
                if (glyph.isEmpty()) {
                    glyph = steward.removePrefix("holler-").take(2).uppercase()
                }
            }

            // Circle 2 shows the card NUMBER he can see on screen ("12"), not the
            // hash id (Josh 2026-09-04). Display-only — the SEND still targets the
            // card ID, since the index shifts as the deck changes and is not a
            // stable address.
            val cardLabel = if (card.isEmpty()) "" else {
                val n = try { presenterFragment.trackpadGetCurrentCardNumber() } catch (_: Exception) { "" }
                if (n.isNotEmpty()) n else card.take(4)
            }
            FloatingControls.QuickSendTargets(glyph, colorHex, cardLabel, steadingBadge)
        }

        // Both resolve the target OFF the main thread — the bridge posts to the
        // main looper and then blocks on a latch, so calling it FROM the main
        // thread deadlocks until its 1s timeout and yields "".
        floatingControls.onQuickSendSteward = {
            Thread {
                val steward = try { presenterFragment.trackpadGetSelectedSteward() } catch (_: Exception) { "" }
                runOnUiThread {
                    if (steward.isEmpty()) {
                        Toast.makeText(this, "No steward selected", Toast.LENGTH_SHORT).show()
                    } else {
                        quickSendTo(steward)
                    }
                }
            }.start()
        }

        floatingControls.onQuickSendCard = {
            Thread {
                val card = try { presenterFragment.trackpadGetCurrentCardId() } catch (_: Exception) { "" }
                runOnUiThread {
                    if (card.isEmpty()) {
                        Toast.makeText(this, "No active card", Toast.LENGTH_SHORT).show()
                    } else {
                        quickSendTo("presenter-card:$card")
                    }
                }
            }.start()
        }

        floatingControls.onConfirmSend = { action, target ->
            dispatchPendingMessage(action, target)
        }

        // Wire up presenter WebView ↔ native recording bridge
        presenterFragment.onGetRecordingStatus = {
            val isRec = audioRecorder.isRecording()
            val hasPending = pendingMessage?.type == RecordingHistoryManager.MessageType.AUDIO
            val hasText = textInput.text.toString().trim().isNotEmpty()
            """{"isRecording":$isRec,"hasRecording":${isRec || hasPending},"hasText":$hasText}"""
        }

        presenterFragment.onGetInputText = {
            textInput.text.toString().trim()
        }

        // Fired by the presenter right after a send actually goes through, so
        // the native box doesn't keep the text Josh just sent. Mirrors what
        // onClaimTextForCard already does below (clear + hide) — the box was
        // opened to compose that one message, so it closes with it.
        presenterFragment.onClearInputText = {
            runOnUiThread {
                textInput.text.clear()
                hideTextInput()
            }
        }

        presenterFragment.onClaimRecordingForCard = { cardId ->
            runOnUiThread { claimRecordingForPresenterCard(cardId) }
        }

        presenterFragment.onClaimTextForCard = { cardId, text ->
            runOnUiThread {
                textInput.text.clear()
                hideTextInput()
                val recording = recordingHistory.saveText(text)
                respondToCard(text, recording.id, cardId)
            }
        }

        presenterFragment.onRequestNativeInput = { id, placeholder, initialValue, type ->
            runOnUiThread { showNativeInputForCard(id, placeholder, initialValue, type) }
        }

        presenterFragment.onBriefOverlayActive = { active ->
            // No-op now that swipe nav is gone — the WebView gets all horizontal gestures.
            // Keeping the callback registered so the JS bridge `setBriefOverlayActive` still fires.
            android.util.Log.d(TAG, "Brief overlay active=$active (swipe nav retired)")
        }

        // Push recording state into the presenter WebView whenever FloatingControls
        // isRecording toggles, so the brief UI lights up instantly without waiting
        // for the next 2s JS poll tick.
        floatingControls.onRecordingStateChanged = { isRec ->
            val hasPending = pendingMessage?.type == RecordingHistoryManager.MessageType.AUDIO
            val hasText = textInput.text.toString().trim().isNotEmpty()
            presenterFragment.pushRecordingState(isRec, isRec || hasPending, hasText)
        }

        // Setup text input
        setupTextInput()

        // Auto-start server if this is the first launch
        if (savedInstanceState == null) {
            startServerIfNeeded()

            // Handle cold start from presenter notification
            if (intent?.getBooleanExtra("open_presenter", false) == true) {
                switchHomeFragment(presenterFragment)
                val cardId = intent.getStringExtra("presenter_item_id")
                if (cardId != null) presenterFragment.navigateToCard(cardId)
            }

            // Handle cold start from recovery APK's "reload webviews" button.
            if (intent?.getBooleanExtra("recovery_reload_webviews", false) == true) {
                homesteadFragment.reload()
                presenterFragment.reload()
            }

            // Handle cold start from recovery APK's "full APK restart" button.
            // (If we're being cold-started by the recovery intent and the process is already
            // fresh, the kill+restart is effectively a no-op cold restart — still safe to honor.)
            if (intent?.getBooleanExtra(INTENT_EXTRA_FULL_RESTART, false) == true) {
                triggerFullRestart()
                return
            }

            // Handle cold start from the over-the-dialer record button.
            if (intent?.getBooleanExtra(EXTRA_START_RECORDING_FROM_DIALER, false) == true) {
                // Defer until the UI (floatingControls) is fully attached.
                window.decorView.post { handleStartRecordingFromDialer(intent) }
            }
        }
    }

    /**
     * Entry point for the over-the-dialer record button. Marks the note as a phone-call
     * note (Part 2a) with an optional WHO (Part 2b), brings the presenter home into view,
     * and kicks off the normal voice-recording flow. Josh taps the mic again to stop,
     * which shows the usual destination picker; queueMessage then tags the note.
     */
    private fun handleStartRecordingFromDialer(intent: Intent) {
        inCallNoteActive = true
        inCallNoteWho = intent.getStringExtra(EXTRA_PHONE_CALL_WHO)?.let { resolveWho(it) }
        hideOverlay()
        switchHomeFragment(presenterFragment)
        hideTextInput()
        // If we're not already recording, start now. If we somehow are, leave it be.
        if (!audioRecorder.isRecording()) {
            startVoiceInput()
        }
        val label = inCallNoteWho?.let { " with $it" } ?: ""
        Toast.makeText(this, "Phone note$label — recording…", Toast.LENGTH_SHORT).show()
    }

    /**
     * Part 2b resolution: the a11y scrape may hand us a bare phone number. If it's a
     * number we know, turn it into the saved contact's name; otherwise pass it through
     * (already a name, or an unknown number — both are still useful context for Alfred).
     */
    private fun resolveWho(who: String): String {
        val digits = who.count { it.isDigit() }
        val looksLikeNumber = digits >= 7 && who.all { it.isDigit() || it in "+()- ." }
        if (!looksLikeNumber) return who
        return try {
            val uri = android.net.Uri.withAppendedPath(
                android.provider.ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                android.net.Uri.encode(who)
            )
            contentResolver.query(
                uri,
                arrayOf(android.provider.ContactsContract.PhoneLookup.DISPLAY_NAME),
                null, null, null
            )?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0)?.takeIf { it.isNotBlank() } else null
            } ?: who
        } catch (e: Exception) {
            android.util.Log.w(TAG, "resolveWho failed: ${e.message}")
            who
        }
    }

    private fun setupInputManagerCallbacks() {
        inputManager.onTranscriptionStart = {
            runOnUiThread {
                floatingControls.isRecording = true
                vibrateLight()
            }
        }

        inputManager.onTranscriptionEnd = {
            runOnUiThread {
                floatingControls.isRecording = false
            }
        }

        inputManager.onTranscriptionResult = { text ->
            runOnUiThread {
                // User manually sent - now actually send to Homestead
                sendToHomestead(text)
            }
        }

        inputManager.onTranscriptionError = { error ->
            runOnUiThread {
                Toast.makeText(this, error, Toast.LENGTH_SHORT).show()
            }
        }

        inputManager.onTranscriptionUpdate = { text ->
            // Accumulated transcription updated - could show indicator
            runOnUiThread {
                // Light vibrate to indicate text captured
                vibrateLight()
            }
        }

        inputManager.onPartialResult = { partial ->
            // Could show partial results in UI if desired
        }
    }

    /**
     * Submit whatever is in the native text box.
     *   - Card-input mode: route text back to the Presenter WebView and exit card mode.
     *   - Normal mode: stash as pending message and show the destination picker.
     *
     * Josh 2026-08-30: this used to be the ➤ ImageButton's onClickListener, and the
     * IME send key reached it via sendButton.performClick(). The button is gone (its
     * pixels went to the text box), so the logic lives here and the IME key — plus any
     * future caller — calls this directly instead of driving a view that no longer exists.
     */
    private fun submitTextInput() {
        val text = textInput.text.toString().trim()
        val mode = cardInputMode
        if (mode != null) {
            // Card mode: allow empty submits through — Presenter decides what to do with them.
            vibrateLight()
            val raw = textInput.text.toString()
            presenterFragment.sendNativeInputResult(mode.cardId, "submit", raw)
            exitCardInputMode()
            textInput.text.clear()
            hideTextInputInternal()
            return
        }
        if (text.isNotEmpty()) {
            vibrateLight()
            pendingMessage = PendingMessage(
                type = RecordingHistoryManager.MessageType.TEXT,
                text = text
            )
            textInput.text.clear()
            hideTextInput()
            floatingControls.showDestinations()
        }
    }

    private fun setupTextInput() {
        // Mirror every keystroke into the Presenter WebView while we're acting as a
        // card's input surface (Josh 2026-08-30). Two things depend on this:
        //   1. Per-card drafts — the Presenter saves what you typed against the card
        //      you typed it on, so navigating away and back brings it back.
        //   2. The Presenter's own send buttons — they read the in-page textarea. Before
        //      this, native-typed text existed ONLY here in Kotlin, so tapping send in
        //      the Homestead interface found an empty box and silently did nothing.
        // Only fires in card mode; normal mode still owns its text locally.
        textInput.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                val mode = cardInputMode ?: return
                presenterFragment.sendNativeInputChanged(mode.cardId, s?.toString() ?: "")
            }
        })

        // Handle keyboard send action — the only submit affordance now that the ➤
        // button is gone.
        textInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                submitTextInput()
                true
            } else {
                false
            }
        }
    }

    /**
     * Enter "card input" mode: reuse the existing textInputContainer/EditText as the native
     * input surface for a Presenter card. Stashes the original hint + inputType so we can
     * restore them on exit. If a card is already in progress when a new request comes in,
     * cancel the prior one first (routes 'cancel' back to Presenter for that card).
     */
    private fun showNativeInputForCard(cardId: String, placeholder: String, initialValue: String, type: String) {
        // Collapse any in-progress card — deliver a 'cancel' to the previous cardId so
        // Presenter can clean up. Then stage the new one.
        cardInputMode?.let { prior ->
            presenterFragment.sendNativeInputResult(prior.cardId, "cancel", "")
        }

        cardInputMode = CardInputMode(
            cardId = cardId,
            originalHint = textInput.hint,
            originalInputType = textInput.inputType,
            originalMaxLines = textInput.maxLines
        )

        val isMultiline = type == "textarea"
        textInput.hint = if (placeholder.isNotEmpty()) placeholder else "Reply…"
        textInput.inputType = if (isMultiline) {
            android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        } else {
            android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }
        textInput.maxLines = if (isMultiline) 8 else 1
        textInput.setText(initialValue)
        textInput.setSelection(initialValue.length)

        textInputContainer.visibility = View.VISIBLE
        textInput.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(textInput, InputMethodManager.SHOW_IMPLICIT)
    }

    /**
     * Restore text input to its normal (non-card) configuration. Does NOT send any bridge
     * message — callers are responsible for routing submit/cancel to Presenter if needed.
     */
    private fun exitCardInputMode() {
        val mode = cardInputMode ?: return
        textInput.hint = mode.originalHint
        textInput.inputType = mode.originalInputType
        textInput.maxLines = mode.originalMaxLines
        cardInputMode = null
    }

    /**
     * Tell the floating rail whether the NATIVE ANDROID KEYBOARD is up.
     *
     * Josh 2026-09-09, correcting a first pass that gated on the app's own text
     * box: "I do not want to hide the recording controls if the apk text box is
     * open. Only if the native keyboard from android is up, not if I'm in
     * 'keyboard mode'. So, if the native android keyboard is open, we hide the
     * controls UNLESS actively recording."
     *
     * The distinction is real and was easy to miss: the app's text box can be on
     * screen in "keyboard mode" with NO system keyboard raised, and the rail must
     * stay in that case. Only the keyboard itself, which physically covers the
     * rail, is a reason to hide.
     *
     * So this is driven by the window's ime() inset — the system's own answer to
     * "is the keyboard showing" — rather than by any view's visibility. That also
     * makes it correct for keyboard raises and dismissals this app never
     * initiated, including the back-gesture and predictive-back dismiss.
     *
     * The "unless actively recording" half is deliberately NOT decided here: the
     * rail owns that rule, so a take always keeps the stop button reachable.
     */
    /**
     * Ask the window, right now, whether the native keyboard is showing.
     *
     * The inset listener is the live driver; this is for the diagnostic, so a
     * report says what the SYSTEM thinks rather than replaying whatever we last
     * pushed. A mirror could not catch the case where the two disagree.
     */
    internal fun liveImeVisible(): String {
        return try {
            val root = window?.decorView?.rootView ?: return "unknown (no window)"
            val insets = androidx.core.view.ViewCompat.getRootWindowInsets(root)
                ?: return "unknown (no insets)"
            insets.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()).toString()
        } catch (e: Exception) { "err: " + e.message }
    }

    private fun reportKeyboardVisibility(imeVisible: Boolean) {
        if (!::audioRecorder.isInitialized) return
        audioRecorder.setKeyboardShowing(imeVisible)
    }

    private fun toggleTextInput() {
        if (textInputContainer.visibility == View.VISIBLE) {
            hideTextInput()
        } else {
            showTextInput()
        }
    }

    private fun showTextInput() {
        // Stay on current screen - don't auto-navigate
        textInputContainer.visibility = View.VISIBLE
        textInput.requestFocus()

        // Show keyboard
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(textInput, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideTextInput() {
        // If we're dismissing a card-input session without an explicit submit, tell Presenter.
        cardInputMode?.let { mode ->
            presenterFragment.sendNativeInputResult(mode.cardId, "cancel", "")
            exitCardInputMode()
        }
        hideTextInputInternal()
    }

    /** Hides the container + keyboard without touching card-input state. */
    private fun hideTextInputInternal() {
        textInputContainer.visibility = View.GONE
        textInput.clearFocus()

        // Hide keyboard
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(textInput.windowToken, 0)
    }

    private fun startVoiceInput() {
        // Check permission first
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                PERMISSION_REQUEST_AUDIO
            )
            return
        }

        // Stay on current screen - don't auto-navigate
        hideTextInput()

        maybeRequestOverlayPermission()

        if (useServerTranscription) {
            // Server-side transcription: record audio and upload to Mac
            val file = audioRecorder.startRecording()
            if (file != null) {
                floatingControls.isRecording = true
                vibrateLight()
                // Start audio level polling for voice-reactive UI
                audioLevelHandler.post(audioLevelRunnable)
            } else {
                Toast.makeText(this, "Failed to start recording", Toast.LENGTH_SHORT).show()
            }
        } else {
            // On-device transcription (Android SpeechRecognizer)
            inputManager.startListening()
        }
    }

    private fun cancelVoiceInput() {
        vibrateMedium()
        // Cancelling drops any pending phone-call context so it can't leak into a later note.
        inCallNoteActive = false
        inCallNoteWho = null
        audioLevelHandler.removeCallbacks(audioLevelRunnable)
        floatingControls.audioLevel = 0f
        if (useServerTranscription) {
            audioRecorder.cancelRecording()
            floatingControls.isRecording = false
        } else {
            inputManager.cancelListening()
        }
        Toast.makeText(this, "Cancelled", Toast.LENGTH_SHORT).show()
    }

    private fun peekTranscription() {
        if (useServerTranscription) {
            if (!audioRecorder.isRecording()) {
                Toast.makeText(this, "Not recording", Toast.LENGTH_SHORT).show()
                return
            }

            // Snapshot current audio without losing it — segment is preserved for final send
            val peekFile = audioRecorder.snapshotForPeek()
            if (peekFile == null || !peekFile.exists() || peekFile.length() == 0L) {
                Toast.makeText(this, "No audio recorded yet", Toast.LENGTH_SHORT).show()
                return
            }

            // Show a "Peeking..." toast
            Toast.makeText(this, "Peeking...", Toast.LENGTH_SHORT).show()

            // Transcribe the copy in the background (transcribe-only, no send)
            lifecycleScope.launch {
                try {
                    val result = transcriptionService.transcribeOnly(peekFile)
                    peekFile.delete()

                    runOnUiThread {
                        if (result.success && !result.transcript.isNullOrBlank()) {
                            showPeekDialog(result.transcript)
                        } else {
                            Toast.makeText(this@MainActivity, "Peek failed: ${result.error ?: "empty"}", Toast.LENGTH_SHORT).show()
                        }
                    }
                } catch (e: Exception) {
                    peekFile.delete()
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Peek error: ${e.message}", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            return
        }

        val text = inputManager.getFullTranscription()
        if (text.isBlank()) {
            Toast.makeText(this, "No transcription yet", Toast.LENGTH_SHORT).show()
            return
        }

        showPeekDialog(text)
    }

    private fun showPeekDialog(transcript: String) {
        val dp = resources.displayMetrics.density

        // Dim background
        val overlay = android.widget.FrameLayout(this).apply {
            setBackgroundColor(android.graphics.Color.argb(160, 0, 0, 0))
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
            elevation = 100 * dp
        }

        // Card
        val card = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            val bg = android.graphics.drawable.GradientDrawable().apply {
                setColor(android.graphics.Color.parseColor("#1A1A1A"))
                cornerRadius = 16 * dp
                setStroke((1.5f * dp).toInt(), android.graphics.Color.parseColor("#333333"))
            }
            background = bg
            setPadding((20 * dp).toInt(), (16 * dp).toInt(), (20 * dp).toInt(), (16 * dp).toInt())
        }

        val cardParams = android.widget.FrameLayout.LayoutParams(
            (resources.displayMetrics.widthPixels * 0.88).toInt(),
            (resources.displayMetrics.heightPixels * 0.5).toInt()
        ).apply { gravity = android.view.Gravity.CENTER }

        // Header row
        val header = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        val title = android.widget.TextView(this).apply {
            this.text = "👁 Peek"
            textSize = 16f
            setTextColor(android.graphics.Color.parseColor("#FFBF00"))
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            layoutParams = android.widget.LinearLayout.LayoutParams(0, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val closeBtn = android.widget.TextView(this).apply {
            this.text = "✕"
            textSize = 18f
            setTextColor(android.graphics.Color.parseColor("#888888"))
            setPadding((8 * dp).toInt(), 0, 0, 0)
            isClickable = true
            isFocusable = true
        }
        header.addView(title)
        header.addView(closeBtn)
        card.addView(header, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
            android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = (12 * dp).toInt() })

        // Divider
        val div = android.view.View(this).apply {
            setBackgroundColor(android.graphics.Color.parseColor("#333333"))
        }
        card.addView(div, android.widget.LinearLayout.LayoutParams(
            android.widget.LinearLayout.LayoutParams.MATCH_PARENT, (1 * dp).toInt()
        ).apply { bottomMargin = (12 * dp).toInt() })

        // Scrollable transcript
        val scroll = android.widget.ScrollView(this).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
        }
        val transcriptView = android.widget.TextView(this).apply {
            this.text = transcript
            textSize = 15f
            setTextColor(android.graphics.Color.WHITE)
            setLineSpacing(4 * dp, 1f)
        }
        scroll.addView(transcriptView)
        card.addView(scroll)

        overlay.addView(card, cardParams)

        val root = window.decorView as android.view.ViewGroup
        root.addView(overlay)

        // Scroll to bottom so latest text is visible
        scroll.post { scroll.fullScroll(android.widget.ScrollView.FOCUS_DOWN) }

        val dismiss = { root.removeView(overlay) }
        closeBtn.setOnClickListener { dismiss() }
        // Tap outside card also dismisses
        overlay.setOnClickListener { dismiss() }
        card.setOnClickListener { /* consume so tap on card doesn't dismiss */ }
    }

    private fun sendVoiceInput() {
        if (useServerTranscription) {
            sendServerTranscription()
        } else {
            sendOnDeviceTranscription()
        }
    }

    private fun sendServerTranscription() {
        android.util.Log.d(TAG, "sendServerTranscription called")

        // Stop audio level polling
        audioLevelHandler.removeCallbacks(audioLevelRunnable)
        floatingControls.audioLevel = 0f

        val audioFile = audioRecorder.stopRecording()
        floatingControls.isRecording = false

        android.util.Log.d(TAG, "Audio file: ${audioFile?.absolutePath}, exists: ${audioFile?.exists()}, size: ${audioFile?.length()}")

        if (audioFile == null || !audioFile.exists() || audioFile.length() == 0L) {
            android.util.Log.e(TAG, "No audio recorded or file is empty")
            Toast.makeText(this, "No audio recorded", Toast.LENGTH_SHORT).show()
            return
        }

        // Save to recording history
        val recording = recordingHistory.save(audioFile)

        vibrateMedium()

        // Get the active session based on current fragment, falling back to currentSessionName
        val sessionName = when (activeFragment) {
            chatViewFragment -> {
                val name = chatViewFragment.getCurrentSessionName()
                android.util.Log.d(TAG, "Chat view session: $name")
                name
            }
            sessionsFragment -> {
                android.util.Log.d(TAG, "On sessions list - using active session: $currentSessionName")
                currentSessionName
            }
            else -> {
                val currentUrl = homesteadFragment.webView?.url
                android.util.Log.d(TAG, "WebView URL: $currentUrl")
                transcriptionService.getActiveSessionFromUrl(currentUrl)
            }
        } ?: currentSessionName  // Ultimate fallback to currentSessionName
        android.util.Log.d(TAG, "Session name: $sessionName")

        if (sessionName == null) {
            android.util.Log.e(TAG, "Could not determine session")
            Toast.makeText(this, "No session selected - select a session first", Toast.LENGTH_LONG).show()
            audioFile.delete()
            return
        }

        // Show uploading toast
        Toast.makeText(this, "Transcribing...", Toast.LENGTH_SHORT).show()
        android.util.Log.d(TAG, "Starting upload: file=${audioFile.length()} bytes, session=$sessionName")

        // Upload in background
        lifecycleScope.launch {
            try {
                android.util.Log.d(TAG, "Calling transcriptionService.transcribeAndSend")
                val result = transcriptionService.transcribeAndSend(audioFile, sessionName)
                android.util.Log.d(TAG, "Transcription result: success=${result.success}, transcript=${result.transcript}, verified=${result.verified}, error=${result.error}")

                audioFile.delete()

                if (result.success) {
                    result.transcript?.let { recordingHistory.updateTranscript(recording.id, it) }
                    recordingHistory.markSent(recording.id, sessionName)
                } else {
                    recordingHistory.markFailed(recording.id)
                }

                runOnUiThread {
                    if (result.success) {
                        vibrateLight()
                        result.transcript?.let { text ->
                            if (text.isNotBlank()) {
                                inputManager.addToRecentMessages(text)
                            }
                        }
                        val preview = "${result.transcript?.take(50) ?: ""}${if ((result.transcript?.length ?: 0) > 50) "..." else ""}"
                        showDeliveryToast(preview, result.verified)
                    } else {
                        android.util.Log.e(TAG, "Transcription failed: ${result.error}")
                        Toast.makeText(
                            this@MainActivity,
                            "Error: ${result.error}",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
            } catch (e: Exception) {
                android.util.Log.e(TAG, "Exception in transcription: ${e.message}", e)
                recordingHistory.markFailed(recording.id)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Exception: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun sendOnDeviceTranscription() {
        val text = inputManager.getFullTranscription()
        if (text.isBlank()) {
            Toast.makeText(this, "Nothing to send", Toast.LENGTH_SHORT).show()
            inputManager.cancelListening()
            return
        }

        vibrateMedium()
        inputManager.sendTranscription()
    }

    private fun sendToHomestead(text: String) {
        // Save to recent messages
        inputManager.addToRecentMessages(text)

        // If on presenter, send as a response to the active card
        if (activeFragment == presenterFragment) {
            sendToPresenterCard(text)
            return
        }

        // Determine the best way to send based on context
        val sessionName = when (activeFragment) {
            chatViewFragment -> chatViewFragment.getCurrentSessionName()
            sessionsFragment -> currentSessionName
            else -> {
                val url = homesteadFragment.getCurrentUrl()
                transcriptionService.getActiveSessionFromUrl(url)
            }
        } ?: currentSessionName

        if (sessionName != null) {
            // Send directly to the session via inject-message API (works from any screen)
            lifecycleScope.launch {
                try {
                    var result = transcriptionService.injectMessage(text, sessionName)

                    // Auto-retry once if unverified
                    if (result.success && result.verified == false) {
                        android.util.Log.w(TAG, "Message unverified, retrying...")
                        result = transcriptionService.injectMessage(text, sessionName)
                    }

                    runOnUiThread {
                        if (result.success) {
                            val preview = "${text.take(50)}${if (text.length > 50) "..." else ""}"
                            showDeliveryToast(preview, result.verified)
                        } else {
                            Toast.makeText(this@MainActivity, "Error: ${result.error}", Toast.LENGTH_LONG).show()
                        }
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Error sending: ${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }
        } else {
            Toast.makeText(this, "No active session - select one first", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Send transcription text as a response to the currently visible presenter card.
     * Calls window.getActiveCardId() in the presenter WebView to get the active card,
     * then POSTs to the presenter respond API.
     */
    private fun sendToPresenterCard(text: String) {
        val webView = presenterFragment.webView
        if (webView == null) {
            Toast.makeText(this, "Presenter not loaded", Toast.LENGTH_SHORT).show()
            return
        }

        webView.evaluateJavascript("window.getActiveCardId()") { cardId ->
            val id = cardId?.trim('"')
            if (id.isNullOrEmpty() || id == "null") {
                runOnUiThread {
                    Toast.makeText(this, "No active presenter card", Toast.LENGTH_SHORT).show()
                }
                return@evaluateJavascript
            }

            // Send response to the presenter API
            lifecycleScope.launch(Dispatchers.IO) {
                try {
                    val baseUrl = "https://joshuas-macbook-air.tail84bb3b.ts.net"
                    val url = java.net.URL("$baseUrl/api/presenter/respond")
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.connectTimeout = 10000
                    conn.readTimeout = 10000

                    val body = org.json.JSONObject().apply {
                        put("id", id)
                        put("text", text)
                    }
                    conn.outputStream.use { it.write(body.toString().toByteArray()) }

                    val responseCode = conn.responseCode
                    runOnUiThread {
                        if (responseCode in 200..299) {
                            val preview = "${text.take(50)}${if (text.length > 50) "..." else ""}"
                            Toast.makeText(this@MainActivity, "\u2705 Sent to card: $preview", Toast.LENGTH_SHORT).show()
                        } else {
                            Toast.makeText(this@MainActivity, "Failed to send to card (HTTP $responseCode)", Toast.LENGTH_LONG).show()
                        }
                    }
                    conn.disconnect()
                } catch (e: Exception) {
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
    }

    private fun showDeliveryToast(preview: String, verified: Boolean?) {
        val msg = when (verified) {
            true -> "\u2705 Sent: $preview"
            false -> "\u26A0\uFE0F Sent (unconfirmed): $preview"
            null -> "Sent: $preview"  // Server doesn't support verification yet
        }
        val duration = if (verified == false) Toast.LENGTH_LONG else Toast.LENGTH_SHORT
        Toast.makeText(this, msg, duration).show()
    }

    private fun recordSessionAccess(sessionName: String) {
        getSharedPreferences("homestead_session_access", MODE_PRIVATE)
            .edit().putLong("access_$sessionName", System.currentTimeMillis()).apply()
    }

    override fun onStop() {
        super.onStop()
        // No point polling for a new build while he can't see the toast.
        appUpdater?.stop()
        // App going to background — clear viewing state so notifications aren't suppressed
        sessionsFragment.currentlyViewingSession = null
        // He has left Homestead — the floating pair takes over from the in-app
        // one so the buttons follow him wherever he goes.
        isAppOnScreen = false
        if (::audioRecorder.isInitialized) audioRecorder.setAppInForeground(false)
    }

    override fun onResume() {
        super.onResume()
        // A destination picker with nothing to send is stranded, not waiting.
        // Josh 2026-09-11 hit exactly this: a take stopped while he was in another
        // app left the list standing with no message behind it, and it greeted him
        // on every return, in both phone mode and Homestead mode, with no way to
        // dismiss it from out there. The cause is fixed above (an off-screen cancel
        // no longer raises it at all) — this is the safety net, so a list that is
        // ALREADY stuck clears itself on the next visit rather than needing an app
        // restart. Gated on pendingMessage == null, so a picker he genuinely opened
        // and has something queued for is left exactly as it is.
        if (::floatingControls.isInitialized && pendingMessage == null) {
            floatingControls.hideDestinations()
        }
        // Back in Homestead — drop the floating pair, the in-app one is live.
        isAppOnScreen = true
        if (::audioRecorder.isInitialized) audioRecorder.setAppInForeground(true)
        // Re-assert both rail inputs on the way back in: coming from a recreation
        // or a long background stint, the service may still hold what the PREVIOUS
        // instance left behind. Cheap, and both are ignored if unchanged.
        reportRailMode()
        // Ask for "display over other apps" here, on the first resume after a
        // launch. It used to wait for a recording, which was right when the
        // floating circles were a nice-to-have — but the buttons following him
        // around the phone IS the feature now (Josh 2026-09-05), and it cannot
        // work at all without the grant. Better he meets it on the way in than
        // discovers the buttons silently missing in Chrome. Guarded to once per
        // launch, and never while he is in another app.
        maybeRequestOverlayPermission()
        // Restore viewing state when app returns to foreground
        if (activeFragment == chatViewFragment) {
            sessionsFragment.currentlyViewingSession = currentSessionName
        }
        // The wallpaper is a window flag, and window flags do not reliably
        // survive being stopped and resumed. Coming forward is the moment to
        // re-arm it — otherwise Phone mode draws its clock and icons over the
        // opaque Homestead black instead of Joshua's wallpaper.
        healHomeModeChrome("onResume")
        // Self-throttled and silent when up to date, so this is safe every resume.
        appUpdater?.start()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Second net under onResume. Some ways of coming back to the foreground
        // (dismissing the keyguard, a dialog or notification shade closing over
        // us) give us focus back WITHOUT another onResume, and the flag can have
        // been dropped across that gap too.
        if (hasFocus) healHomeModeChrome("onWindowFocusChanged")
    }

    private fun switchFragment(fragment: Fragment) {
        val fragmentContainer = findViewById<FrameLayout>(R.id.fragment_container)

        // Home fragments (presenter / homestead-web) swap via show/hide; no overlay involved.
        when (fragment) {
            presenterFragment -> {
                hideOverlay()
                switchHomeFragment(presenterFragment)
                return
            }
            homesteadFragment -> {
                hideOverlay()
                switchHomeFragment(homesteadFragment)
                return
            }
        }

        // Otherwise it's an overlay fragment (chat, sessions, guest chat)
        if (!isShowingOverlay) {
            // Show overlay container on top of pager
            fragmentContainer.visibility = View.VISIBLE
            fragmentContainer.bringToFront()
            isShowingOverlay = true
        }

        // Hide current overlay fragment, show new one
        supportFragmentManager.beginTransaction().apply {
            if (activeFragment == sessionsFragment || activeFragment == chatViewFragment || activeFragment == guestChatFragment) {
                hide(activeFragment)
            }
            show(fragment)
        }.commit()
        activeFragment = fragment

        // Overlay always opaque — even in Phone mode, chat/sessions get a solid backdrop.
        fragmentContainer.setBackgroundColor(Color.parseColor("#0D0D0D"))
        applyHomeModeChrome()

        // Track which session the user is currently viewing (for notification suppression)
        sessionsFragment.currentlyViewingSession = if (fragment == chatViewFragment) currentSessionName else null

        workbenchHeader.visibility = View.GONE
    }

    private fun hideOverlay() {
        if (!isShowingOverlay) return
        val fragmentContainer = findViewById<FrameLayout>(R.id.fragment_container)
        // Hide all overlay fragments
        supportFragmentManager.beginTransaction().apply {
            hide(sessionsFragment)
            hide(chatViewFragment)
            hide(guestChatFragment)
        }.commit()
        fragmentContainer.visibility = View.GONE
        isShowingOverlay = false

        // Restore the chrome the active home mode wants (wallpaper in Phone mode).
        applyHomeModeChrome()
    }

    private fun switchWorkbenchTab(tab: WorkbenchTab) {
        activeWorkbenchTab = tab
        when (tab) {
            WorkbenchTab.SESSIONS -> {
                switchFragment(sessionsFragment)
            }
            WorkbenchTab.WEB -> {
                hideOverlay()
                switchHomeFragment(homesteadFragment)
            }
            WorkbenchTab.STATUS -> {
                // Status page moved to the standalone recovery APK 2026-04-20. Fall through to web.
                hideOverlay()
                switchHomeFragment(homesteadFragment)
            }
        }
    }

    private fun updateWorkbenchHeaderHighlight() {
        val colorAmber = Color.parseColor("#FFBF00")
        val colorDim = Color.parseColor("#888888")
        val colorActiveBg = Color.parseColor("#1A1A1A")
        val colorInactiveBg = Color.TRANSPARENT

        fun highlight(btn: TextView, active: Boolean) {
            btn.setTextColor(if (active) colorAmber else colorDim)
            val bg = btn.background as? android.graphics.drawable.GradientDrawable
            bg?.setColor(if (active) colorActiveBg else colorInactiveBg)
        }

        val isSessions = activeFragment == sessionsFragment || activeFragment == chatViewFragment
        highlight(headerSessionsBtn, isSessions)
        highlight(headerWebBtn, activeFragment == homesteadFragment)
        // Status tab removed 2026-04-20; header button is retained but never highlighted.
        highlight(headerStatusBtn, false)
    }

    @SuppressLint("SetTextI18n")
    private fun buildWorkbenchHeader() {
        val dp = resources.displayMetrics.density
        val colorDarkBg = Color.parseColor("#0D0D0D")
        val colorBorder = Color.parseColor("#2A2A2A")
        val colorDim = Color.parseColor("#888888")

        workbenchHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(colorDarkBg)
            gravity = Gravity.CENTER_VERTICAL
            setPadding((12 * dp).toInt(), (36 * dp).toInt(), (12 * dp).toInt(), (4 * dp).toInt())
            visibility = View.GONE
        }

        // Bottom border on the header
        val headerWrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }

        fun makeHeaderBtn(label: String): TextView {
            val btnBg = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = 10 * dp
                setColor(Color.TRANSPARENT)
            }
            return TextView(this).apply {
                text = label
                textSize = 14f
                setTextColor(colorDim)
                typeface = fontHeader
                gravity = Gravity.CENTER
                background = btnBg
                setPadding((16 * dp).toInt(), (8 * dp).toInt(), (16 * dp).toInt(), (8 * dp).toInt())
                val params = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                params.marginEnd = (8 * dp).toInt()
                layoutParams = params
            }
        }

        headerSessionsBtn = makeHeaderBtn("Sessions")
        headerSessionsBtn.setOnClickListener {
            vibrateLight()
            switchWorkbenchTab(WorkbenchTab.SESSIONS)
        }

        headerWebBtn = makeHeaderBtn("Web")
        headerWebBtn.setOnClickListener {
            vibrateLight()
            switchWorkbenchTab(WorkbenchTab.WEB)
        }

        headerStatusBtn = makeHeaderBtn("Status")
        headerStatusBtn.setOnClickListener {
            vibrateLight()
            switchWorkbenchTab(WorkbenchTab.STATUS)
        }

        workbenchHeader.addView(headerSessionsBtn)
        workbenchHeader.addView(headerWebBtn)
        workbenchHeader.addView(headerStatusBtn)

        // Add divider below header
        val divider = View(this).apply {
            setBackgroundColor(colorBorder)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (1 * dp).toInt())
        }

        // Insert header above the fragment container
        val fragmentContainer = findViewById<FrameLayout>(R.id.fragment_container)
        val parent = fragmentContainer.parent as androidx.constraintlayout.widget.ConstraintLayout

        // We need to use a wrapper: header + fragment. Replace fragment_container constraints.
        // Easier approach: add header to a wrapper LinearLayout
        val wrapperLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            id = View.generateViewId()
            layoutParams = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams(
                0,
                0
            ).apply {
                topToTop = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
                bottomToTop = R.id.text_input_container
                startToStart = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
                endToEnd = androidx.constraintlayout.widget.ConstraintLayout.LayoutParams.PARENT_ID
            }
        }

        parent.removeView(fragmentContainer)
        wrapperLayout.addView(workbenchHeader)
        wrapperLayout.addView(divider)

        fragmentContainer.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f
        )
        wrapperLayout.addView(fragmentContainer)

        parent.addView(wrapperLayout)
    }

    private fun startServerIfNeeded() {
        if (!ApiServerService.isRunning) {
            val serviceIntent = Intent(this, ApiServerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
        }
    }

    private fun vibrateLight() {
        vibrate(50, VibrationEffect.EFFECT_TICK)
    }

    private fun vibrateMedium() {
        vibrate(100, VibrationEffect.EFFECT_CLICK)
    }

    private fun vibrate(durationMs: Long, effectId: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            val vibrator = vibratorManager.defaultVibrator
            vibrator.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            @Suppress("DEPRECATION")
            val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            vibrator.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            vibrator.vibrate(durationMs)
        }
    }

    private fun showUtilities() {
        val colorAmber = Color.parseColor("#FFBF00")
        val colorCyan = Color.parseColor("#67E8F9")
        val colorRed = Color.parseColor("#F87171")
        val colorGreen = Color.parseColor("#4ADE80")
        val colorPurple = Color.parseColor("#C084FC")
        val colorOrange = Color.parseColor("#FB923C")
        val colorDarkBg = Color.parseColor("#111111")
        val colorTileBg = Color.parseColor("#1E1E1E")
        val dp = resources.displayMetrics.density

        data class UtilButton(val icon: String, val label: String, val key: String, val color: Int)

        // 2 rows of 3 buttons
        val rows = listOf(
            listOf(
                UtilButton("\u23CE", "Enter", "enter", colorGreen),
                UtilButton("\u238B", "Escape", "escape", colorRed),
                UtilButton("\u2718", "Ctrl+C", "ctrl-c", colorOrange),
            ),
            listOf(
                UtilButton("\u25B2", "Up", "up", colorCyan),
                UtilButton("\u25BC", "Down", "down", colorCyan),
                UtilButton("\u2630", "Ctrl+B", "ctrl-b", colorPurple),
            ),
        )

        fun createTile(btn: UtilButton): View {
            val tileBg = android.graphics.drawable.GradientDrawable().apply {
                setColor(colorTileBg)
                cornerRadius = 16 * dp
                setStroke((2 * dp).toInt(), Color.argb(60, Color.red(btn.color), Color.green(btn.color), Color.blue(btn.color)))
            }

            val tile = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                background = tileBg
                minimumHeight = (100 * dp).toInt()
                val params = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                params.setMargins((6 * dp).toInt(), (6 * dp).toInt(), (6 * dp).toInt(), (6 * dp).toInt())
                layoutParams = params
                setPadding(0, (20 * dp).toInt(), 0, (16 * dp).toInt())
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    vibrateLight()
                    sendSpecialKey(btn.key)
                    tileBg.setColor(Color.argb(60, Color.red(btn.color), Color.green(btn.color), Color.blue(btn.color)))
                    postDelayed({ tileBg.setColor(colorTileBg) }, 150)
                }
            }

            val iconView = TextView(this).apply {
                text = btn.icon
                setTextColor(btn.color)
                textSize = 32f
                gravity = Gravity.CENTER
            }
            tile.addView(iconView)

            val labelView = TextView(this).apply {
                text = btn.label
                setTextColor(Color.parseColor("#AAAAAA"))
                textSize = 12f
                typeface = fontBodyMedium ?: Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(0, (6 * dp).toInt(), 0, 0)
            }
            tile.addView(labelView)

            return tile
        }

        // Build the grid using LinearLayout rows with weight
        val gridContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((16 * dp).toInt(), (16 * dp).toInt(), (16 * dp).toInt(), (8 * dp).toInt())
        }

        for (row in rows) {
            val rowLayout = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
            }
            for (btn in row) {
                rowLayout.addView(createTile(btn))
            }
            gridContainer.addView(rowLayout)
        }

        // Container with title
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(colorDarkBg)
            setPadding(0, (20 * dp).toInt(), 0, (8 * dp).toInt())
        }

        val title = TextView(this).apply {
            text = "Utilities"
            setTextColor(colorAmber)
            textSize = 22f
            typeface = fontHeader ?: Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, (4 * dp).toInt())
        }
        container.addView(title)
        container.addView(gridContainer)

        val dialog = AlertDialog.Builder(this, R.style.Theme_Homestead_Dialog)
            .setView(container)
            .setNegativeButton("Close") { d, _ -> d.dismiss() }
            .create()

        dialog.show()

        // Style dialog to fill width
        dialog.window?.let { window ->
            window.setBackgroundDrawableResource(android.R.color.transparent)
            window.decorView.let { decorView ->
                val dialogBg = android.graphics.drawable.GradientDrawable().apply {
                    setColor(colorDarkBg)
                    cornerRadius = 20 * dp
                }
                decorView.background = dialogBg
            }
            // Make dialog nearly full-width
            val displayWidth = resources.displayMetrics.widthPixels
            window.setLayout((displayWidth * 0.92).toInt(), android.view.WindowManager.LayoutParams.WRAP_CONTENT)
        }
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.apply {
            setTextColor(Color.parseColor("#777777"))
            textSize = 14f
        }
    }

    private fun sendSpecialKey(key: String) {
        // Get session name based on active fragment, falling back to currentSessionName
        val sessionName = when (activeFragment) {
            chatViewFragment -> chatViewFragment.getCurrentSessionName()
            sessionsFragment -> currentSessionName
            else -> {
                val url = homesteadFragment.getCurrentUrl()
                transcriptionService.getActiveSessionFromUrl(url)
            }
        } ?: currentSessionName

        if (sessionName == null) {
            Toast.makeText(this, "Select a session first", Toast.LENGTH_SHORT).show()
            return
        }

        // Map key names to escape sequences
        val sequence = when (key) {
            "enter" -> "\r"
            "escape" -> "\u001b"
            "ctrl-c" -> "\u0003"
            "ctrl-b" -> "\u0002"
            "up" -> "\u001b[A"
            "down" -> "\u001b[B"
            else -> return
        }

        lifecycleScope.launch {
            try {
                val result = transcriptionService.sendRawToSession(sequence, sessionName)
                runOnUiThread {
                    if (result.success) {
                        Toast.makeText(this@MainActivity, "Sent: $key", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(this@MainActivity, "Error: ${result.error}", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun showRecordingHistoryPanel() {
        val rootView = findViewById<FrameLayout>(android.R.id.content)
        val panel = RecordingHistoryPanel(this, recordingHistory)
        panel.onResend = { recording ->
            panel.dismiss()

            if (recording.type == RecordingHistoryManager.MessageType.TEXT ||
                (!recording.transcript.isNullOrBlank() && (recording.filePath.isEmpty() || !java.io.File(recording.filePath).exists()))) {
                // Text message or transcribed audio without file — pre-fill text box for editing
                val content = recording.text ?: recording.transcript ?: ""
                showTextInput()
                textInput.setText(content)
                textInput.setSelection(content.length)
                Toast.makeText(this, "Edit and send", Toast.LENGTH_SHORT).show()
            } else if (recording.transcript != null && recording.filePath.isNotEmpty() && java.io.File(recording.filePath).exists()) {
                // Has both transcript and audio — pre-fill text for edit option
                val content = recording.transcript
                showTextInput()
                textInput.setText(content)
                textInput.setSelection(content.length)
                Toast.makeText(this, "Edit and send, or re-record", Toast.LENGTH_SHORT).show()
            } else {
                // Audio only — set as pending audio and show destinations
                val audioFile = java.io.File(recording.filePath)
                if (audioFile.exists()) {
                    pendingMessage = PendingMessage(
                        type = RecordingHistoryManager.MessageType.AUDIO,
                        audioFile = audioFile,
                        historyId = recording.id
                    )
                    floatingControls.showDestinations()
                    Toast.makeText(this, "Pick a destination", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "Audio file no longer available", Toast.LENGTH_SHORT).show()
                }
            }
        }
        panel.show(rootView)
    }

    private fun showHistory() {
        val colorAmber = Color.parseColor("#FFBF00")
        val colorDarkBg = Color.parseColor("#1A1A1A")
        val colorCardBg = Color.parseColor("#222222")
        val colorBorder = Color.parseColor("#333333")

        val messages = inputManager.getRecentMessages()

        if (messages.isEmpty()) {
            Toast.makeText(this, "No recent messages", Toast.LENGTH_SHORT).show()
            return
        }

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 16, 24, 16)
        }

        var historyDialog: AlertDialog? = null

        messages.forEach { msg ->
            // Card container
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(24, 20, 24, 20)
                setBackgroundColor(colorCardBg)
                val params = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                params.setMargins(0, 0, 0, 16)
                layoutParams = params
            }

            // Time label
            val timeView = TextView(this).apply {
                text = formatRelativeTime(msg.timestamp)
                setTextColor(colorAmber)
                textSize = 11f
                setPadding(0, 0, 0, 8)
            }
            card.addView(timeView)

            // Message text - show up to 3 lines, expandable
            val textView = TextView(this).apply {
                text = msg.text
                setTextColor(Color.WHITE)
                textSize = 14f
                maxLines = 3
                ellipsize = android.text.TextUtils.TruncateAt.END
                setLineSpacing(4f, 1.1f)
                setPadding(0, 0, 0, 12)
            }
            card.addView(textView)

            // Button row
            val buttonRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.END
            }

            // "Expand" button - only show if text is long
            if (msg.text.length > 120) {
                val expandBtn = TextView(this).apply {
                    text = "VIEW FULL"
                    setTextColor(Color.parseColor("#888888"))
                    textSize = 12f
                    typeface = fontBodyMedium ?: Typeface.DEFAULT_BOLD
                    setPadding(24, 12, 24, 12)
                    setOnClickListener {
                        vibrateLight()
                        // Show full message in a separate dialog
                        val fullDialog = AlertDialog.Builder(this@MainActivity, R.style.Theme_Homestead_Dialog)
                            .setTitle("Full Message")
                            .setMessage(msg.text)
                            .setPositiveButton("SEND") { d, _ ->
                                d.dismiss()
                                historyDialog?.dismiss()
                                vibrateLight()
                                sendToHomestead(msg.text)
                            }
                            .setNegativeButton("Close") { d, _ -> d.dismiss() }
                            .create()
                        fullDialog.show()
                        fullDialog.window?.decorView?.setBackgroundColor(colorDarkBg)
                        fullDialog.findViewById<TextView>(android.R.id.message)?.apply {
                            setTextColor(Color.WHITE)
                            textSize = 14f
                            setLineSpacing(4f, 1.2f)
                        }
                        // Style the SEND button amber
                        fullDialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(colorAmber)
                    }
                }
                buttonRow.addView(expandBtn)
            }

            // Send button
            val sendBtn = TextView(this).apply {
                text = "SEND ▶"
                setTextColor(Color.BLACK)
                setBackgroundColor(colorAmber)
                textSize = 13f
                typeface = fontBodyMedium ?: Typeface.DEFAULT_BOLD
                setPadding(32, 12, 32, 12)
                setOnClickListener {
                    vibrateLight()
                    historyDialog?.dismiss()
                    sendToHomestead(msg.text)
                }
            }
            buttonRow.addView(sendBtn)

            card.addView(buttonRow)
            container.addView(card)
        }

        val scrollView = android.widget.ScrollView(this).apply {
            addView(container)
        }

        historyDialog = AlertDialog.Builder(this, R.style.Theme_Homestead_Dialog)
            .setTitle("Recent Messages")
            .setView(scrollView)
            .setNegativeButton("Close") { d, _ -> d.dismiss() }
            .create()

        historyDialog.show()
        historyDialog.window?.decorView?.setBackgroundColor(colorDarkBg)
    }

    private fun formatRelativeTime(timestamp: Long): String {
        val now = System.currentTimeMillis()
        val diff = now - timestamp
        val seconds = diff / 1000
        val minutes = seconds / 60
        val hours = minutes / 60
        val days = hours / 24

        return when {
            seconds < 60 -> "just now"
            minutes < 60 -> "${minutes}m ago"
            hours < 24 -> "${hours}h ago"
            else -> "${days}d ago"
        }
    }

    // Request READ+WRITE_CONTACTS at startup if not already granted. WRITE is the one
    // that actually matters (add_contact / set_contact_notes fail with SecurityException
    // without it) but a sideload can reset both, so we request the pair. Fires a system
    // permission dialog; if Josh taps Allow the contact-write endpoints work immediately.
    private fun ensureContactsPermission() {
        val needed = arrayOf(
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.WRITE_CONTACTS
        ).filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQUEST_CONTACTS)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST_AUDIO) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                // Permission granted, start listening
                startVoiceInput()
            } else {
                Toast.makeText(this, "Microphone permission required for voice input", Toast.LENGTH_LONG).show()
            }
        } else if (requestCode == PERMISSION_REQUEST_CONTACTS) {
            val writeGranted = permissions.indexOf(Manifest.permission.WRITE_CONTACTS)
                .let { it >= 0 && it < grantResults.size && grantResults[it] == PackageManager.PERMISSION_GRANTED }
            if (!writeGranted) {
                Toast.makeText(this, "Contacts permission needed to save identity notes", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onBackPressed() {
        // Check if apps overlay is showing
        if (appsOverlay != null) {
            dismissAppsOverlay()
            return
        }

        // First check if text input is showing
        if (textInputContainer.visibility == View.VISIBLE) {
            hideTextInput()
            return
        }

        // If showing overlay (chat, sessions, guest), go back to pager
        if (isShowingOverlay) {
            hideOverlay()
            return
        }

        // If the web view is foregrounded, go back to the presenter.
        if (::activeHomeFragment.isInitialized && activeHomeFragment !== presenterFragment) {
            switchHomeFragment(presenterFragment)
            return
        }

        // Already on presenter home — do nothing (we're the launcher)
    }

    // Hard kill + cold relaunch of this APK. Schedules our own launcher Intent via AlarmManager
    // ~500ms in the future, then calls Process.killProcess on ourselves. AlarmManager survives
    // process death and re-launches us cold (fresh JVM, fresh WebViews, fresh services). Used
    // by the recovery APK's "FULL APK RESTART" button when WebView reload isn't enough.
    private fun triggerFullRestart() {
        Log.w(TAG, "Full APK restart triggered by recovery — scheduling cold relaunch + killing self")
        Toast.makeText(this, "Killing presenter — cold restart incoming…", Toast.LENGTH_SHORT).show()

        val relaunchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        } ?: run {
            Log.e(TAG, "Could not resolve our own launcher intent — aborting full restart")
            return
        }

        val flags = PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_UPDATE_CURRENT or
            PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getActivity(
            this, FULL_RESTART_REQUEST_CODE, relaunchIntent, flags
        )

        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // RTC (wall-clock) is fine — we're only delaying ~500ms. Don't need setExact: a few-ms
        // jitter on relaunch is invisible to the user.
        am.set(AlarmManager.RTC, System.currentTimeMillis() + 500, pi)

        // Give the toast a beat to render, then nuke the process. finishAffinity tears down the
        // task stack so the relaunch is genuinely cold (no saved-state restore).
        Handler(Looper.getMainLooper()).postDelayed({
            finishAffinity()
            Process.killProcess(Process.myPid())
            System.exit(0)
        }, 150)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)

        // Handle over-the-dialer record button tap
        if (intent?.getBooleanExtra(EXTRA_START_RECORDING_FROM_DIALER, false) == true) {
            handleStartRecordingFromDialer(intent)
            return
        }

        // Handle presenter notification tap
        val openPresenter = intent?.getBooleanExtra("open_presenter", false) ?: false
        if (openPresenter) {
            hideOverlay()
            switchHomeFragment(presenterFragment)
            hideTextInput()
            val cardId = intent?.getStringExtra("presenter_item_id")
            if (cardId != null) presenterFragment.navigateToCard(cardId)
            return
        }

        // Handle recovery APK's "reload webviews" button.
        if (intent?.getBooleanExtra("recovery_reload_webviews", false) == true) {
            homesteadFragment.reload()
            presenterFragment.reload()
            // Don't short-circuit — also go to presenter so the user lands somewhere visible.
        }

        // Handle recovery APK's "full APK restart" button — hard kill + cold relaunch.
        if (intent?.getBooleanExtra(INTENT_EXTRA_FULL_RESTART, false) == true) {
            triggerFullRestart()
            return
        }

        // Handle notification tap — open specific session
        val openSession = intent?.getStringExtra("open_session")
        if (openSession != null) {
            currentSessionName = openSession
            sessionsFragment.activeSessionName = openSession
            sessionsFragment.markSessionViewed(openSession)
            recordSessionAccess(openSession)
            chatViewFragment.setSession(openSession)
            chatViewFragment.setSessions(sessionsFragment.getSessions())
            switchFragment(chatViewFragment)
            floatingControls.activeNav = NavButton.WORKBENCH
            // floatingControls.sessionLabel = openSession
            return
        }

        // When home button is pressed while already in the app, go to presenter (home)
        if (intent?.action == Intent.ACTION_MAIN &&
            intent.categories?.contains(Intent.CATEGORY_HOME) == true) {
            hideOverlay()
            // Honour the mode Joshua chose — pressing Home must not slam him back
            // to Homestead when he's deliberately in Phone mode.
            if (isPhoneMode) {
                phoneModeFragment.refreshApps()
                switchHomeFragment(phoneModeFragment)
            } else {
                switchHomeFragment(presenterFragment)
            }
            hideTextInput()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // The toast is attached to the decor view; drop it with the activity.
        appUpdater?.dismiss()
        appUpdater = null
        if (liveActivity?.get() === this) liveActivity = null
        inputManager.destroy()
        // If a take is still running when the OS tears us down (leaving the app,
        // rotation, wallpaper change, low-memory kill of a backgrounded HOME
        // launcher), destroy() now FINALIZES it and hands the file back instead
        // of deleting it. Persist it as unsent so it is recoverable from history
        // rather than silently gone.
        audioRecorder.destroy()?.let { salvaged ->
            try {
                if (salvaged.exists() && salvaged.length() > 0L) {
                    recordingHistory.save(salvaged)
                    Log.d(TAG, "Persisted salvaged recording (${salvaged.length()} bytes)")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to persist salvaged recording: ${e.message}", e)
            }
        }
        floatingControls.destroy()
    }

    private fun sendVoiceToSession(sessionName: String) {
        audioLevelHandler.removeCallbacks(audioLevelRunnable)
        floatingControls.audioLevel = 0f
        val audioFile = audioRecorder.stopRecording()
        floatingControls.isRecording = false

        if (audioFile == null || !audioFile.exists() || audioFile.length() == 0L) {
            Toast.makeText(this, "No audio", Toast.LENGTH_SHORT).show()
            return
        }

        // Save to recording history
        val recording = recordingHistory.save(audioFile)

        vibrateMedium()
        val shortName = sessionName.removePrefix("holler-")
        Toast.makeText(this, "Sending to $shortName...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val result = transcriptionService.transcribeAndSend(audioFile, sessionName)
                audioFile.delete()
                if (result.success) {
                    result.transcript?.let { recordingHistory.updateTranscript(recording.id, it) }
                    recordingHistory.markSent(recording.id, sessionName)
                } else {
                    recordingHistory.markFailed(recording.id)
                }
                runOnUiThread {
                    if (result.success) {
                        vibrateLight()
                        val preview = "${result.transcript?.take(50) ?: ""}${if ((result.transcript?.length ?: 0) > 50) "..." else ""}"
                        showDeliveryToast(preview, result.verified)
                    } else {
                        Toast.makeText(this@MainActivity, "Error: ${result.error}", Toast.LENGTH_LONG).show()
                    }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recording.id)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun sendVoiceToPresenter() {
        audioLevelHandler.removeCallbacks(audioLevelRunnable)
        floatingControls.audioLevel = 0f
        val audioFile = audioRecorder.stopRecording()
        floatingControls.isRecording = false

        if (audioFile == null || !audioFile.exists() || audioFile.length() == 0L) {
            Toast.makeText(this, "No audio", Toast.LENGTH_SHORT).show()
            return
        }

        // Save to recording history
        val recording = recordingHistory.save(audioFile)

        vibrateMedium()
        Toast.makeText(this, "Sending to presenter...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val result = transcriptionService.transcribeOnly(audioFile)
                audioFile.delete()
                if (result.success && !result.transcript.isNullOrBlank()) {
                    recordingHistory.updateTranscript(recording.id, result.transcript)
                    // Get the currently viewed item index from the presenter WebView
                    val viewIdx = kotlinx.coroutines.suspendCancellableCoroutine<Int> { cont ->
                        runOnUiThread {
                            val wv = presenterFragment.webView
                            if (wv != null) {
                                wv.evaluateJavascript("(typeof viewIndex !== 'undefined') ? viewIndex : 0") { value ->
                                    cont.resumeWith(Result.success(value?.trim()?.toIntOrNull() ?: 0))
                                }
                            } else {
                                cont.resumeWith(Result.success(0))
                            }
                        }
                    }
                    android.util.Log.d(TAG, "Presenter viewIndex=$viewIdx")

                    // Get the presenter item at that index and respond with transcript
                    val sendResult = withContext(Dispatchers.IO) {
                        try {
                            val queueUrl = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/presenter/queue")
                            val queueConn = queueUrl.openConnection() as java.net.HttpURLConnection
                            queueConn.connectTimeout = 5000
                            queueConn.readTimeout = 5000
                            val queueBody = queueConn.inputStream.bufferedReader().readText()
                            val queueJson = org.json.JSONObject(queueBody)
                            val items = queueJson.getJSONArray("queue")
                            if (items.length() == 0) {
                                android.util.Log.w(TAG, "No presenter items in queue")
                                return@withContext "no_items"
                            }
                            // Use the viewed item, clamped to valid range
                            val idx = viewIdx.coerceIn(0, items.length() - 1)
                            val item = items.getJSONObject(idx)
                            val itemId = item.getString("id")
                            android.util.Log.d(TAG, "Responding to presenter item idx=$idx id=$itemId")

                            // Respond with the transcript as text input
                            val respondUrl = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/presenter/respond")
                            val conn = respondUrl.openConnection() as java.net.HttpURLConnection
                            conn.requestMethod = "POST"
                            conn.setRequestProperty("Content-Type", "application/json")
                            conn.doOutput = true
                            conn.connectTimeout = 10000
                            conn.readTimeout = 30000
                            val body = org.json.JSONObject().apply {
                                put("id", itemId)
                                put("text", result.transcript)
                                // Use first button label as response
                                val buttons = item.optJSONArray("buttons")
                                if (buttons != null && buttons.length() > 0) {
                                    val btn = buttons.get(0)
                                    val label = if (btn is org.json.JSONObject) btn.optString("label", "Voice") else btn.toString()
                                    put("button", label)
                                } else {
                                    put("button", "Voice Response")
                                }
                            }
                            conn.outputStream.write(body.toString().toByteArray())
                            val code = conn.responseCode
                            if (code in 200..299) "ok" else "error:$code"
                        } catch (e: Exception) {
                            android.util.Log.e(TAG, "Presenter send exception", e)
                            "error:${e.message}"
                        }
                    }
                    if (sendResult == "ok") {
                        recordingHistory.markSent(recording.id, "presenter")
                    } else {
                        recordingHistory.markFailed(recording.id)
                    }
                    runOnUiThread {
                        when {
                            sendResult == "ok" -> {
                                vibrateLight()
                                // Show confirmation overlay in presenter WebView(s)
                                val js = "if(typeof showConfirmation==='function')showConfirmation('Voice','presenter');"
                                presenterFragment.webView?.evaluateJavascript(js, null)
                                // miniPresenter removed — apps grid is overlay-only now
                            }
                            sendResult == "no_items" -> {
                                Toast.makeText(this@MainActivity, "No active presenter item", Toast.LENGTH_LONG).show()
                            }
                            else -> {
                                Toast.makeText(this@MainActivity, "Presenter send failed", Toast.LENGTH_LONG).show()
                            }
                        }
                    }
                } else {
                    recordingHistory.markFailed(recording.id)
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Transcription empty", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recording.id)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /**
     * Drop the in-flight take outright — the second tap on the record button,
     * from anywhere (Josh 2026-09-11).
     *
     * This replaced a stop-and-prepare path that left a pending message and
     * raised the destination picker. Josh retired that menu — the
     * quick-send circles on screen during the take are how a destination gets
     * chosen now. Nothing is queued and nothing is saved to history; he asked to
     * cancel, so cancelling is all this does.
     *
     * Also clears any picker already standing, so a list stranded by the old
     * behaviour heals on the next tap instead of lasting until an app restart.
     */
    private fun cancelTake() {
        try { audioRecorder.stopRecording() } catch (e: Exception) {
            Log.w(TAG, "overlay cancel: stopRecording threw: " + e.message)
        }
        floatingControls.isRecording = false
        pendingMessage = null
        floatingControls.hideDestinations()
        vibrateMedium()
        Toast.makeText(this, "Recording cancelled", Toast.LENGTH_SHORT).show()
    }

    private fun handleMicGesture(action: MicAction) {
        if (action == MicAction.CANCEL) {
            if (floatingControls.isRecording) {
                // Josh 2026-09-11: a second tap on the record button CANCELS.
                //
                // It used to stop the take and raise the steward picker — "that's
                // no longer the functionality we want... that whole display menu
                // doesn't need to be around anymore. But when I go up to the
                // settings menu and I click start there and then click it again,
                // it should cancel instead of showing that menu."
                //
                // The picker was the old recording system's way of choosing a
                // target. The modern way is the two quick-send circles, which are
                // already on screen for the whole take: steward on the left, card
                // on the right. Stopping is therefore just stopping.
                cancelTake()
            } else if (pendingMessage != null) {
                pendingMessage = null
                Toast.makeText(this, "Cancelled", Toast.LENGTH_SHORT).show()
            }
            return
        }
        // SEND_TO_STEWARD without target shouldn't happen — destinations call onMicGestureWithTarget
    }

    private fun handleMicGestureWithTarget(action: MicAction, sessionName: String) {
        val pending = pendingMessage
        if (pending == null) {
            Toast.makeText(this, "Nothing to send", Toast.LENGTH_SHORT).show()
            return
        }

        val shortName = if (sessionName.startsWith("presenter-card:")) {
            "card"
        } else {
            sessionName.removePrefix("holler-")
        }
        floatingControls.showUndoBar(MicAction.SEND_TO_STEWARD, shortName, sessionName)
    }

    /** Stop active recording, save to history, set as pending, show destinations */
    /**
     * Stop the in-flight take and send it straight to [target], skipping the
     * destination picker. This is the native stand-in for the presenter's two
     * bottom send buttons, which live in the WebView and disappear the moment
     * Joshua leaves that screen while the mic keeps running.
     */
    /**
     * One-time nudge toward Settings > Display over other apps, so the quick-send
     * circles can follow Joshua into Chrome. Declining is fine and permanent —
     * we never ask twice, and everything else keeps working.
     */
    private fun maybeRequestOverlayPermission() {
        if (Settings.canDrawOverlays(this)) return
        // Only ever prompt while Homestead is actually the screen he is looking
        // at. This is reached from startVoiceInput, which the FLOATING record
        // button also calls — and firing a Settings intent from there would rip
        // him out of Chrome into a settings list for the crime of tapping
        // record. Never interrupt him in someone else's app.
        if (!isAppOnScreen) return
        // Asked at most once per launch rather than once ever. This used to be a
        // one-shot nudge for a nice-to-have; now the buttons following him
        // around the phone is THE feature (Josh 2026-09-05), and it simply does
        // not exist without this grant. Declining still costs him nothing — the
        // in-app buttons keep working, and he is not nagged mid-session.
        if (overlayPermissionAskedThisLaunch) return
        overlayPermissionAskedThisLaunch = true
        try {
            // The package: URI is IGNORED from Android 11 on, so this lands on the
            // full alphabetical list of every app rather than our own toggle. Say
            // so plainly — Joshua hit exactly this and could not tell he was
            // already on the right screen.
            Toast.makeText(
                this,
                "Find \"Homestead\" in this list and turn it on",
                Toast.LENGTH_LONG
            ).show()
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:$packageName")
                )
            )
        } catch (e: Exception) {
            Log.w(TAG, "Could not open overlay settings: ${e.message}")
        }
    }

    private fun quickSendTo(target: String) {
        if (!audioRecorder.isRecording()) {
            Toast.makeText(this, "Not recording", Toast.LENGTH_SHORT).show()
            return
        }
        audioLevelHandler.removeCallbacks(audioLevelRunnable)
        floatingControls.audioLevel = 0f
        val audioFile = audioRecorder.stopRecording()
        floatingControls.isRecording = false

        if (audioFile == null || !audioFile.exists() || audioFile.length() == 0L) {
            Toast.makeText(this, "No audio", Toast.LENGTH_SHORT).show()
            return
        }

        val recording = recordingHistory.save(audioFile)
        pendingMessage = PendingMessage(
            type = RecordingHistoryManager.MessageType.AUDIO,
            audioFile = audioFile,
            historyId = recording.id
        )
        vibrateMedium()
        floatingControls.hideDestinations()
        // Reuse the one dispatch path so transcription, card-respond vs walkie
        // routing, history marking and the undo toast all behave identically.
        dispatchPendingMessage(MicAction.SEND_TO_STEWARD, target)
    }

    /** Dispatch the pending message to the chosen destination */
    private fun dispatchPendingMessage(action: MicAction, target: String?) {
        val pending = pendingMessage ?: return
        pendingMessage = null

        if (action == MicAction.CANCEL || target == null) {
            // Dismissed without sending — drop phone-call context so it can't leak.
            inCallNoteActive = false
            inCallNoteWho = null
            return
        }

        // Presenter card targets use /api/presenter/respond instead of walkie-talkie queue
        if (target.startsWith("presenter-card:")) {
            val cardId = target.removePrefix("presenter-card:")
            when (pending.type) {
                RecordingHistoryManager.MessageType.AUDIO -> {
                    val file = pending.audioFile ?: return
                    val id = pending.historyId ?: return
                    transcribeAndRespondToCard(file, id, cardId)
                }
                RecordingHistoryManager.MessageType.TEXT -> {
                    val text = pending.text ?: return
                    val recording = recordingHistory.saveText(text)
                    respondToCard(text, recording.id, cardId)
                }
            }
            return
        }

        when (pending.type) {
            RecordingHistoryManager.MessageType.AUDIO -> {
                val file = pending.audioFile ?: return
                val id = pending.historyId ?: return
                transcribeAndQueue(file, id, target)
            }
            RecordingHistoryManager.MessageType.TEXT -> {
                val text = pending.text ?: return
                val recording = recordingHistory.saveText(text)
                queueMessage(text, recording.id, target)
            }
        }
    }

    /**
     * Called from presenter JS bridge: stop active recording (or use pending),
     * transcribe, and respond to a presenter card.
     */
    private fun claimRecordingForPresenterCard(cardId: String) {
        // Get audio file: from active recording or from pending message
        val audioFile = if (audioRecorder.isRecording()) {
            // Stop active recording
            audioLevelHandler.removeCallbacks(audioLevelRunnable)
            floatingControls.audioLevel = 0f
            floatingControls.isRecording = false
            audioRecorder.stopRecording()
        } else {
            pendingMessage?.audioFile
        }

        // Clear pending since we're claiming it
        pendingMessage = null
        floatingControls.hideDestinations()

        if (audioFile == null || !audioFile.exists() || audioFile.length() == 0L) {
            Toast.makeText(this, "No recording to send", Toast.LENGTH_SHORT).show()
            return
        }

        val recording = recordingHistory.save(audioFile)
        vibrateMedium()
        transcribeAndRespondToCard(audioFile, recording.id, cardId)
    }

    /** Transcribe audio, then respond to a presenter card */
    private fun transcribeAndRespondToCard(audioFile: java.io.File, recordingId: String, cardId: String) {
        Toast.makeText(this, "Transcribing for card...", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            try {
                val result = transcriptionService.transcribeOnly(audioFile)
                if (result.success && !result.transcript.isNullOrBlank()) {
                    recordingHistory.updateTranscript(recordingId, result.transcript)
                    respondToCard(result.transcript, recordingId, cardId)
                } else {
                    recordingHistory.markFailed(recordingId)
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Transcription failed: ${result.error ?: "empty"}", Toast.LENGTH_LONG).show()
                    }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recordingId)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /** Send text as a response to a presenter card via /api/presenter/respond */
    private fun respondToCard(text: String, recordingId: String, cardId: String) {
        Toast.makeText(this, "Sending to card...", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            try {
                val success = withContext(Dispatchers.IO) {
                    try {
                        val url = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/presenter/respond")
                        val conn = url.openConnection() as java.net.HttpURLConnection
                        conn.requestMethod = "POST"
                        conn.setRequestProperty("Content-Type", "application/json")
                        conn.doOutput = true
                        conn.connectTimeout = 10000
                        conn.readTimeout = 30000
                        val body = org.json.JSONObject().apply {
                            put("id", cardId)
                            put("text", text)
                            put("button", "Voice Response")
                        }
                        conn.outputStream.write(body.toString().toByteArray())
                        val code = conn.responseCode
                        android.util.Log.d(TAG, "Presenter respond POST: HTTP $code")
                        code in 200..299
                    } catch (e: Exception) {
                        android.util.Log.e(TAG, "Presenter respond failed: ${e.message}")
                        false
                    }
                }
                if (success) {
                    recordingHistory.markSent(recordingId, "presenter")
                } else {
                    recordingHistory.markFailed(recordingId)
                }
                runOnUiThread {
                    if (success) {
                        vibrateLight()
                        val preview = "${text.take(50)}${if (text.length > 50) "..." else ""}"
                        Toast.makeText(this@MainActivity, "\u2705 Sent to card: $preview", Toast.LENGTH_SHORT).show()
                        // Refresh presenter UI
                        val js = "if(typeof showConfirmation==='function')showConfirmation('Voice','presenter');"
                        presenterFragment.webView?.evaluateJavascript(js, null)
                    } else {
                        Toast.makeText(this@MainActivity, "Failed to send to card", Toast.LENGTH_LONG).show()
                    }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recordingId)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /** Transcribe audio via Whisper, then queue the transcript via walkie-talkie */
    private fun transcribeAndQueue(audioFile: java.io.File, recordingId: String, sessionName: String) {
        val shortName = sessionName.removePrefix("holler-")
        Toast.makeText(this, "Transcribing for $shortName...", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            try {
                val result = transcriptionService.transcribeOnly(audioFile)
                if (result.success && !result.transcript.isNullOrBlank()) {
                    recordingHistory.updateTranscript(recordingId, result.transcript)
                    queueMessage(result.transcript, recordingId, sessionName)
                } else {
                    recordingHistory.markFailed(recordingId)
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Transcription failed: ${result.error ?: "empty"}", Toast.LENGTH_LONG).show()
                    }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recordingId)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /** Queue a text message to a session via the walkie-talkie queue API */
    private fun queueMessage(text: String, recordingId: String, sessionName: String) {
        val shortName = sessionName.removePrefix("holler-")
        // Part 2a/2b: if this note came from the over-the-dialer button, tag it so
        // Alfred knows it was captured during a phone call (and with whom, if known).
        // Consume the flag here so a later note doesn't inherit the phone-call context.
        val instructionText = if (inCallNoteActive) {
            inCallNoteActive = false
            val who = inCallNoteWho
            inCallNoteWho = null
            val tag = if (!who.isNullOrBlank()) {
                "[Phone note — captured during a phone call with $who]"
            } else {
                "[Phone note — captured during a phone call]"
            }
            "$tag\n\n$text"
        } else {
            text
        }
        Toast.makeText(this, "Queuing for $shortName...", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            try {
                val success = withContext(Dispatchers.IO) {
                    try {
                        val url = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/queue")
                        val conn = url.openConnection() as java.net.HttpURLConnection
                        conn.requestMethod = "POST"
                        conn.setRequestProperty("Content-Type", "application/json")
                        conn.doOutput = true
                        conn.connectTimeout = 10000
                        conn.readTimeout = 10000

                        val envelope = org.json.JSONObject().apply {
                            put("type", "action")
                            put("from", "josh-mobile")
                            put("instruction", instructionText)
                        }
                        val body = org.json.JSONObject().apply {
                            put("target_session", sessionName)
                            put("type", "action")
                            put("message_override", envelope.toString())
                        }
                        conn.outputStream.write(body.toString().toByteArray())
                        val code = conn.responseCode
                        android.util.Log.d(TAG, "Queue POST to $sessionName: HTTP $code")
                        code in 200..299
                    } catch (e: Exception) {
                        android.util.Log.e(TAG, "Queue POST failed: ${e.message}")
                        false
                    }
                }
                if (success) {
                    recordingHistory.markSent(recordingId, sessionName)
                } else {
                    recordingHistory.markFailed(recordingId)
                }
                runOnUiThread {
                    if (success) {
                        vibrateLight()
                        val preview = "${text.take(50)}${if (text.length > 50) "..." else ""}"
                        Toast.makeText(this@MainActivity, "Queued: $preview", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(this@MainActivity, "Failed to queue message", Toast.LENGTH_LONG).show()
                    }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recordingId)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun resolveActiveSession(): String? {
        return when (activeFragment) {
            chatViewFragment -> chatViewFragment.getCurrentSessionName()
            sessionsFragment -> currentSessionName
            else -> {
                val url = homesteadFragment.webView?.url
                transcriptionService.getActiveSessionFromUrl(url)
            }
        } ?: currentSessionName
    }

    private fun resendToSession(audioFile: java.io.File, recordingId: String, sessionName: String? = null) {
        val target = sessionName ?: resolveActiveSession()
        if (target == null) {
            Toast.makeText(this, "No session selected", Toast.LENGTH_LONG).show()
            return
        }
        val shortName = target.removePrefix("holler-")
        Toast.makeText(this, "Sending to $shortName...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val result = transcriptionService.transcribeAndSend(audioFile, target)
                if (result.success) {
                    result.transcript?.let { recordingHistory.updateTranscript(recordingId, it) }
                    recordingHistory.markSent(recordingId, target)
                } else {
                    recordingHistory.markFailed(recordingId)
                }
                runOnUiThread {
                    if (result.success) {
                        vibrateLight()
                        val preview = "${result.transcript?.take(50) ?: ""}${if ((result.transcript?.length ?: 0) > 50) "..." else ""}"
                        showDeliveryToast(preview, result.verified)
                    } else {
                        Toast.makeText(this@MainActivity, "Error: ${result.error}", Toast.LENGTH_LONG).show()
                    }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recordingId)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun resendToPresenter(audioFile: java.io.File, recordingId: String) {
        Toast.makeText(this, "Sending to presenter...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val result = transcriptionService.transcribeOnly(audioFile)
                if (result.success && !result.transcript.isNullOrBlank()) {
                    recordingHistory.updateTranscript(recordingId, result.transcript)
                    val viewIdx = kotlinx.coroutines.suspendCancellableCoroutine<Int> { cont ->
                        runOnUiThread {
                            val wv = presenterFragment.webView
                            if (wv != null) {
                                wv.evaluateJavascript("(typeof viewIndex !== 'undefined') ? viewIndex : 0") { value ->
                                    cont.resumeWith(Result.success(value?.trim()?.toIntOrNull() ?: 0))
                                }
                            } else {
                                cont.resumeWith(Result.success(0))
                            }
                        }
                    }
                    val sendResult = withContext(Dispatchers.IO) {
                        try {
                            val queueUrl = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/presenter/queue")
                            val queueConn = queueUrl.openConnection() as java.net.HttpURLConnection
                            queueConn.connectTimeout = 5000
                            queueConn.readTimeout = 5000
                            val queueBody = queueConn.inputStream.bufferedReader().readText()
                            val queueJson = org.json.JSONObject(queueBody)
                            val items = queueJson.getJSONArray("queue")
                            if (items.length() == 0) return@withContext "no_items"
                            val idx = viewIdx.coerceIn(0, items.length() - 1)
                            val item = items.getJSONObject(idx)
                            val itemId = item.getString("id")

                            val respondUrl = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/presenter/respond")
                            val conn = respondUrl.openConnection() as java.net.HttpURLConnection
                            conn.requestMethod = "POST"
                            conn.setRequestProperty("Content-Type", "application/json")
                            conn.doOutput = true
                            conn.connectTimeout = 10000
                            conn.readTimeout = 30000
                            val body = org.json.JSONObject().apply {
                                put("id", itemId)
                                put("text", result.transcript)
                                val buttons = item.optJSONArray("buttons")
                                if (buttons != null && buttons.length() > 0) {
                                    val btn = buttons.get(0)
                                    val label = if (btn is org.json.JSONObject) btn.optString("label", "Voice") else btn.toString()
                                    put("button", label)
                                } else {
                                    put("button", "Voice Response")
                                }
                            }
                            conn.outputStream.write(body.toString().toByteArray())
                            val code = conn.responseCode
                            if (code in 200..299) "ok" else "error:$code"
                        } catch (e: Exception) { "error:${e.message}" }
                    }
                    if (sendResult == "ok") recordingHistory.markSent(recordingId, "presenter")
                    else recordingHistory.markFailed(recordingId)
                    runOnUiThread {
                        when {
                            sendResult == "ok" -> {
                                vibrateLight()
                                val js = "if(typeof showConfirmation==='function')showConfirmation('Voice','presenter');"
                                presenterFragment.webView?.evaluateJavascript(js, null)
                                // miniPresenter removed — apps grid is overlay-only now
                            }
                            sendResult == "no_items" -> Toast.makeText(this@MainActivity, "No active presenter item", Toast.LENGTH_LONG).show()
                            else -> Toast.makeText(this@MainActivity, "Presenter send failed", Toast.LENGTH_LONG).show()
                        }
                    }
                } else {
                    recordingHistory.markFailed(recordingId)
                    runOnUiThread { Toast.makeText(this@MainActivity, "Transcription empty", Toast.LENGTH_SHORT).show() }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recordingId)
                runOnUiThread { Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show() }
            }
        }
    }

    private fun resendToPA(audioFile: java.io.File, recordingId: String, guest: String?) {
        val targetName = if (guest == "<<REPLACE: a-household-member>>") "<<REPLACE: a household member>>'s PA" else "PA"
        Toast.makeText(this, "Sending to $targetName...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val result = transcriptionService.transcribeOnly(audioFile)
                if (result.success && !result.transcript.isNullOrBlank()) {
                    recordingHistory.updateTranscript(recordingId, result.transcript)
                    val sendResult = withContext(Dispatchers.IO) {
                        try {
                            val url = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/guests/send-shared-message")
                            val conn = url.openConnection() as java.net.HttpURLConnection
                            conn.requestMethod = "POST"
                            conn.setRequestProperty("Content-Type", "application/json")
                            conn.doOutput = true
                            conn.connectTimeout = 10000
                            conn.readTimeout = 30000
                            val guestLogin = if (guest == "<<REPLACE: a-household-member>>") "<<REPLACE: a-household-member>>.mullet13@gmail.com" else "<<REPLACE: your secondary email>>"
                            val body = org.json.JSONObject().apply {
                                put("guestLogin", guestLogin)
                                put("message", result.transcript)
                            }
                            conn.outputStream.write(body.toString().toByteArray())
                            conn.responseCode in 200..299
                        } catch (e: Exception) { false }
                    }
                    if (sendResult) recordingHistory.markSent(recordingId, targetName)
                    else recordingHistory.markFailed(recordingId)
                    runOnUiThread {
                        if (sendResult) {
                            vibrateLight()
                            Toast.makeText(this@MainActivity, "Sent to $targetName", Toast.LENGTH_SHORT).show()
                        } else {
                            Toast.makeText(this@MainActivity, "$targetName send failed", Toast.LENGTH_LONG).show()
                        }
                    }
                } else {
                    recordingHistory.markFailed(recordingId)
                    runOnUiThread { Toast.makeText(this@MainActivity, "Transcription empty", Toast.LENGTH_SHORT).show() }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recordingId)
                runOnUiThread { Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show() }
            }
        }
    }

    private fun sendToPersonalAssistant(guest: String? = null) {
        audioLevelHandler.removeCallbacks(audioLevelRunnable)
        floatingControls.audioLevel = 0f
        val audioFile = audioRecorder.stopRecording()
        floatingControls.isRecording = false

        if (audioFile == null || !audioFile.exists() || audioFile.length() == 0L) {
            Toast.makeText(this, "No audio", Toast.LENGTH_SHORT).show()
            return
        }

        // Save to recording history
        val recording = recordingHistory.save(audioFile)

        val targetName = if (guest == "<<REPLACE: a-household-member>>") "<<REPLACE: a household member>>'s PA" else "PA"
        vibrateMedium()
        Toast.makeText(this, "Sending to $targetName...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val result = transcriptionService.transcribeOnly(audioFile)
                audioFile.delete()
                if (result.success && !result.transcript.isNullOrBlank()) {
                    recordingHistory.updateTranscript(recording.id, result.transcript)
                    val sendResult = withContext(Dispatchers.IO) {
                        try {
                            val url = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/guests/send-shared-message")
                            val conn = url.openConnection() as java.net.HttpURLConnection
                            conn.requestMethod = "POST"
                            conn.setRequestProperty("Content-Type", "application/json")
                            conn.doOutput = true
                            conn.connectTimeout = 10000
                            conn.readTimeout = 30000
                            val guestLogin = if (guest == "<<REPLACE: a-household-member>>") "<<REPLACE: a-household-member>>.mullet13@gmail.com" else "<<REPLACE: your secondary email>>"
                            val body = org.json.JSONObject().apply {
                                put("guestLogin", guestLogin)
                                put("message", result.transcript)
                            }
                            android.util.Log.d(TAG, "PA send body: $body")
                            conn.outputStream.write(body.toString().toByteArray())
                            val code = conn.responseCode
                            val responseBody = try {
                                if (code in 200..299) conn.inputStream.bufferedReader().readText()
                                else conn.errorStream?.bufferedReader()?.readText() ?: "no error body"
                            } catch (e: Exception) { "read error: ${e.message}" }
                            android.util.Log.d(TAG, "PA send response: code=$code body=$responseBody")
                            code in 200..299
                        } catch (e: Exception) {
                            android.util.Log.e(TAG, "PA send exception", e)
                            false
                        }
                    }
                    if (sendResult) {
                        recordingHistory.markSent(recording.id, targetName)
                    } else {
                        recordingHistory.markFailed(recording.id)
                    }
                    runOnUiThread {
                        if (sendResult) {
                            vibrateLight()
                            Toast.makeText(this@MainActivity, "Sent to $targetName", Toast.LENGTH_SHORT).show()
                        } else {
                            Toast.makeText(this@MainActivity, "$targetName send failed", Toast.LENGTH_LONG).show()
                        }
                    }
                } else {
                    recordingHistory.markFailed(recording.id)
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Transcription empty", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                recordingHistory.markFailed(recording.id)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    // ── Trackpad Overlay ──
    // Phone-as-Mac-cursor controller. Joshua's 2026-04-27 spec: native UI
    // (NOT a WebView panel), peer to Apps in the right cluster, opens as a
    // bottom-sheet constrained inside the WebView's safe area so the close
    // affordance isn't buried under the system menu bar. Tap-on-pad = click.

    private var trackpadOverlay: FrameLayout? = null
    private val trackpadClient = TrackpadClient()
    private var trackpadStatusText: TextView? = null
    private val trackpadStatusHandler = Handler(Looper.getMainLooper())
    private val trackpadStatusTicker = object : Runnable {
        override fun run() {
            renderTrackpadStatus()
            // Tick every second so the "live (Xs)" counter advances.
            trackpadStatusHandler.postDelayed(this, 1000L)
        }
    }
    // Recording-state morph (Joshua 2026-04-28): when idle, the bottom row
    // shows only "🎙 Rec". When recording, it shows "→ Card" + "→ Steward"
    // so a tap routes the about-to-finish transcript to either target via
    // Whisper Village's claim path. The state is sourced from the Mac's
    // Whisper Village /status endpoint via a poller — no local toggle. If
    // Joshua starts/stops recording on his laptop directly (right-Option
    // on the keyboard), the phone UI stays in lock-step.
    private var trackpadIsRecording: Boolean = false
    private var trackpadRecordRow: LinearLayout? = null
    private var trackpadRecPoller: java.io.Closeable? = null

    // ── Grandpa Mode (full-screen Mac zoom) ──
    // Joshua 2026-08-13 (clarified): one-tap toggle that makes EVERYTHING on
    // the Mac bigger while the whole desktop still fits — the Mac side does a
    // display-resolution switch ("Larger Text"), NOT a magnifier. Level 1..4
    // = distinct "bigger" steps (Bigger → Biggest); default 2. State lives
    // here so the toggle + −/+ stepper stay in sync. The phone is the source
    // of truth for on/off since the Mac resolution has no state we poll.
    private var grandpaModeOn: Boolean = false
    private var grandpaLevel: Int = 2   // 1..4, default 2 (medium-bigger)
    private var grandpaToggleBtn: TextView? = null
    private var grandpaLevelLabel: TextView? = null
    private val grandpaMaxLevel = 4
    // Human-readable size per level (index by level; 0 unused).
    private val grandpaLevelName = arrayOf("", "BIG", "BIGGER", "HUGE", "MAX")

    // ── Apps Overlay ──

    private var appsOverlay: FrameLayout? = null

    private data class LaunchableApp(
        val packageName: String,
        val appName: String,
        val icon: Drawable,
        val userHandle: android.os.UserHandle,
        val isWorkProfile: Boolean
    )

    private var cachedLaunchableApps: List<LaunchableApp>? = null
    private var cachedLaunchableAppsTime: Long = 0

    private fun loadLaunchableApps(): List<LaunchableApp> {
        // Cache for 30 seconds to avoid re-loading icons on every overlay open
        val cached = cachedLaunchableApps
        if (cached != null && System.currentTimeMillis() - cachedLaunchableAppsTime < 30_000) return cached
        val launcherApps = getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps
        val userManager = getSystemService(Context.USER_SERVICE) as UserManager
        val myUser = Process.myUserHandle()
        val apps = mutableListOf<LaunchableApp>()

        for (profile in userManager.userProfiles) {
            val isWork = profile != myUser
            try {
                for (info in launcherApps.getActivityList(null, profile)) {
                    try {
                        if (info.componentName.packageName == packageName) continue
                        apps.add(LaunchableApp(
                            packageName = info.componentName.packageName,
                            appName = info.label.toString(),
                            icon = info.getBadgedIcon(0),
                            userHandle = profile,
                            isWorkProfile = isWork
                        ))
                    } catch (_: Exception) {}
                }
            } catch (_: Exception) {}
        }

        val sorted = apps.sortedWith(compareBy({ it.isWorkProfile }, { it.appName.lowercase() }))
        cachedLaunchableApps = sorted
        cachedLaunchableAppsTime = System.currentTimeMillis()
        return sorted
    }

    private fun getFavoritePackages(): List<String> {
        val prefs = getSharedPreferences("homestead_quick_apps", MODE_PRIVATE)
        val raw = prefs.getString("package_names", null) ?: return emptyList()
        return try {
            val arr = org.json.JSONArray(raw)
            (0 until arr.length()).map { arr.getString(it) }
        } catch (_: Exception) { emptyList() }
    }

    private fun saveFavoritePackages(packages: List<String>) {
        val arr = org.json.JSONArray()
        packages.forEach { arr.put(it) }
        getSharedPreferences("homestead_quick_apps", MODE_PRIVATE)
            .edit().putString("package_names", arr.toString()).apply()
    }

    private fun appKey(app: LaunchableApp): String =
        if (app.isWorkProfile) "${app.packageName}:work" else app.packageName

    /** Launch the first of [packages] that's actually installed. */
    private fun launchByPackages(packages: List<String>, label: String) {
        for (pkg in packages) {
            val intent = packageManager.getLaunchIntentForPackage(pkg)
            if (intent != null) {
                startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            }
        }
        Toast.makeText(this, "No $label app found", Toast.LENGTH_SHORT).show()
    }

    private fun launchApp(app: LaunchableApp) {
        try {
            val launcherApps = getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps
            val activities = launcherApps.getActivityList(app.packageName, app.userHandle)
            val main = activities.firstOrNull()
            if (main != null) {
                launcherApps.startMainActivity(main.componentName, app.userHandle, null, null)
            } else {
                Toast.makeText(this, "Can't launch ${app.appName}", Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            Toast.makeText(this, "Failed: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun showAppsOverlay() {
        if (appsOverlay != null) {
            dismissAppsOverlay()
            return
        }

        val dp = resources.displayMetrics.density
        val allApps = loadLaunchableApps()
        val favoriteKeys = getFavoritePackages().toMutableSet()
        val numColumns = 5

        // Root overlay
        val overlay = FrameLayout(this).apply {
            setBackgroundColor(Color.argb(200, 0, 0, 0))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            elevation = 50 * dp
            setOnClickListener { dismissAppsOverlay() }
        }

        // Panel — slightly taller than screen for peek-over effect
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#111111"))
                cornerRadii = floatArrayOf(20*dp, 20*dp, 20*dp, 20*dp, 0f, 0f, 0f, 0f)
            }
            background = bg
            setPadding((12 * dp).toInt(), (16 * dp).toInt(), (12 * dp).toInt(), (24 * dp).toInt())
            setOnClickListener { /* absorb click */ }
        }

        val panelParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            (resources.displayMetrics.heightPixels * 1.03).toInt()
        ).apply { gravity = Gravity.BOTTOM }

        // Drag handle at top of panel
        val handleBar = View(this).apply {
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#555555"))
                cornerRadius = 3 * dp
            }
            background = bg
        }
        val handleContainer = FrameLayout(this).apply {
            addView(handleBar, FrameLayout.LayoutParams(
                (40 * dp).toInt(), (5 * dp).toInt()
            ).apply { gravity = Gravity.CENTER })
            setPadding(0, (4 * dp).toInt(), 0, (8 * dp).toInt())
            setOnClickListener { dismissAppsOverlay() }
        }
        panel.addView(handleContainer, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ))

        // Search bar (fixed at top of panel, outside scroll)
        val searchInput = EditText(this).apply {
            hint = "Search apps..."
            setHintTextColor(Color.parseColor("#666666"))
            setTextColor(Color.WHITE)
            textSize = 16f
            typeface = fontBodyMedium
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#1A1A1A"))
                cornerRadius = 12 * dp
                setStroke((1 * dp).toInt(), Color.parseColor("#333333"))
            }
            background = bg
            setPadding((16 * dp).toInt(), (12 * dp).toInt(), (16 * dp).toInt(), (12 * dp).toInt())
            isSingleLine = true
        }
        panel.addView(searchInput, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = (12 * dp).toInt() })

        // Single scrollable area for favorites + all apps
        val gridScroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
            overScrollMode = View.OVER_SCROLL_NEVER
            var pullStartY = 0f
            var pulling = false
            setOnTouchListener { _, event ->
                when (event.action) {
                    android.view.MotionEvent.ACTION_DOWN -> {
                        pullStartY = event.rawY
                        pulling = scrollY == 0
                        false
                    }
                    android.view.MotionEvent.ACTION_MOVE -> {
                        if (pulling && scrollY == 0 && event.rawY - pullStartY > 80 * dp) {
                            dismissAppsOverlay()
                            true
                        } else false
                    }
                    else -> false
                }
            }
        }

        // Inner container holds favorites + all apps in one scrollable column
        val scrollContent = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }

        val cellWidth = (resources.displayMetrics.widthPixels - (24 * dp).toInt()) / numColumns

        // The FAVORITES section used to live here. Removed 2026-08-29 — Josh:
        // "remove the favorites from the slide out as it is redundant". Phone
        // mode's own grid + its bottom tray are where favourites live now; the
        // drawer is purely the full searchable list.

        // All apps grid
        val gridContainer = GridLayout(this).apply {
            columnCount = numColumns
        }

        fun rebuildScrollContent(filter: String) {
            scrollContent.removeAllViews()

            // "ALL APPS" header, only when not filtering.
            if (filter.isBlank()) {
                val allLabel = TextView(this@MainActivity).apply {
                    text = "ALL APPS"
                    textSize = 11f
                    setTextColor(Color.parseColor("#666666"))
                    typeface = Typeface.DEFAULT_BOLD
                    letterSpacing = 0.1f
                }
                scrollContent.addView(allLabel, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = (6 * dp).toInt() })
            }

            // Add all apps grid
            gridContainer.removeAllViews()
            val filtered = if (filter.isBlank()) allApps else {
                allApps.filter { it.appName.contains(filter, ignoreCase = true) }
            }
            for (app in filtered) {
                val tile = createAppGridTile(app, dp, cellWidth)
                gridContainer.addView(tile)
            }
            if (filtered.isEmpty() && filter.isNotBlank()) {
                // Show Google + Ask fallback buttons
                val fallbackRow = LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER
                    setPadding(0, (24 * dp).toInt(), 0, (24 * dp).toInt())
                }
                val googleBtn = Button(this@MainActivity).apply {
                    text = "\uD83C\uDF10  Google"
                    textSize = 18f
                    setTextColor(Color.WHITE)
                    background = GradientDrawable().apply {
                        setColor(Color.parseColor("#1a1a1a"))
                        cornerRadius = 16f * dp
                        setStroke((2 * dp).toInt(), Color.parseColor("#4285F4"))
                    }
                    setPadding((28 * dp).toInt(), (16 * dp).toInt(), (28 * dp).toInt(), (16 * dp).toInt())
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                        setMargins((16 * dp).toInt(), 0, (8 * dp).toInt(), 0)
                    }
                    setOnClickListener {
                        val url = "https://www.google.com/search?q=${java.net.URLEncoder.encode(filter, "UTF-8")}"
                        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
                    }
                }
                fallbackRow.addView(googleBtn)
                val askBtn = Button(this@MainActivity).apply {
                    text = "\uD83E\uDDE0  Ask"
                    textSize = 18f
                    setTextColor(Color.WHITE)
                    background = GradientDrawable().apply {
                        setColor(Color.parseColor("#1a1a1a"))
                        cornerRadius = 16f * dp
                        setStroke((2 * dp).toInt(), Color.parseColor("#FF6600"))
                    }
                    setPadding((28 * dp).toInt(), (16 * dp).toInt(), (28 * dp).toInt(), (16 * dp).toInt())
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                        setMargins((8 * dp).toInt(), 0, (16 * dp).toInt(), 0)
                    }
                    setOnClickListener {
                        Thread {
                            try {
                                val baseUrl = "https://joshuas-macbook-air.tail84bb3b.ts.net"
                                val url = java.net.URL("$baseUrl/api/queue")
                                val conn = url.openConnection() as java.net.HttpURLConnection
                                conn.requestMethod = "POST"
                                conn.setRequestProperty("Content-Type", "application/json")
                                conn.doOutput = true
                                val payload = org.json.JSONObject().apply {
                                    put("target_session", "holler-alfred--ask")
                                    put("type", "action")
                                    put("session", "holler-homestead")
                                    put("message_override", filter)
                                }
                                conn.outputStream.write(payload.toString().toByteArray())
                                conn.responseCode
                                conn.disconnect()
                            } catch (_: Exception) {}
                        }.start()
                    }
                }
                fallbackRow.addView(askBtn)
                val fallbackParams = GridLayout.LayoutParams().apply {
                    columnSpec = GridLayout.spec(0, numColumns)
                    width = ViewGroup.LayoutParams.MATCH_PARENT
                }
                gridContainer.addView(fallbackRow, fallbackParams)
            } else if (filtered.isEmpty()) {
                val empty = TextView(this@MainActivity).apply {
                    text = "No apps found"
                    textSize = 14f
                    setTextColor(Color.parseColor("#666666"))
                    gravity = Gravity.CENTER
                    setPadding(0, (24 * dp).toInt(), 0, 0)
                }
                val emptyParams = GridLayout.LayoutParams().apply {
                    columnSpec = GridLayout.spec(0, numColumns)
                    width = ViewGroup.LayoutParams.MATCH_PARENT
                }
                gridContainer.addView(empty, emptyParams)
            }
            scrollContent.addView(gridContainer, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ))
        }

        rebuildScrollContent("")
        gridScroll.addView(scrollContent)
        panel.addView(gridScroll)

        // Wire search
        searchInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                rebuildScrollContent(s?.toString() ?: "")
            }
        })

        overlay.addView(panel, panelParams)

        val root = window.decorView as ViewGroup
        root.addView(overlay)
        appsOverlay = overlay

        // Fast slide up, then auto-focus search input
        panel.translationY = panelParams.height.toFloat()
        panel.animate().translationY(0f).setDuration(180).withEndAction {
            searchInput.requestFocus()
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
            imm.showSoftInput(searchInput, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        }.start()
    }

    private fun createAppGridTile(app: LaunchableApp, dp: Float, cellWidth: Int): LinearLayout {
        val iconSize = (48 * dp).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            isClickable = true
            isFocusable = true
            layoutParams = GridLayout.LayoutParams().apply {
                width = cellWidth
                height = ViewGroup.LayoutParams.WRAP_CONTENT
            }
            setPadding((4 * dp).toInt(), (12 * dp).toInt(), (4 * dp).toInt(), (8 * dp).toInt())

            setOnClickListener {
                launchApp(app)
                dismissAppsOverlay()
            }

            setOnLongClickListener { view ->
                showAppContextMenu(view, app)
                true
            }

            val iconView = ImageView(this@MainActivity).apply {
                setImageDrawable(app.icon)
                layoutParams = LinearLayout.LayoutParams(iconSize, iconSize)
            }
            addView(iconView)

            val nameView = TextView(this@MainActivity).apply {
                text = app.appName
                textSize = 11f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = (4 * dp).toInt() }
            }
            addView(nameView)

            if (app.isWorkProfile) {
                val badge = View(this@MainActivity).apply {
                    val bg = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL
                        setColor(Color.parseColor("#67E8F9"))
                        setSize((6 * dp).toInt(), (6 * dp).toInt())
                    }
                    background = bg
                    layoutParams = LinearLayout.LayoutParams(
                        (6 * dp).toInt(), (6 * dp).toInt()
                    ).apply { topMargin = (2 * dp).toInt() }
                }
                addView(badge)
            }
        }
    }

    private fun showAppContextMenu(anchor: View, app: LaunchableApp) {
        val key = appKey(app)
        val favoriteKeys = getFavoritePackages().toMutableList()
        val isFavorite = favoriteKeys.contains(key)

        val popup = android.widget.PopupMenu(this, anchor)
        popup.menu.add(0, 1, 0, if (isFavorite) "Remove from Favorites" else "Add to Favorites")
        // Personal-profile apps only — the tray launches without a user handle.
        if (!app.isWorkProfile) popup.menu.add(0, 3, 1, "Add to bottom tray")
        popup.menu.add(0, 2, 2, "App Info")
        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> {
                    if (isFavorite) {
                        favoriteKeys.remove(key)
                    } else {
                        favoriteKeys.add(key)
                    }
                    saveFavoritePackages(favoriteKeys)
                    // Refresh the overlay
                    dismissAppsOverlay()
                    showAppsOverlay()
                    true
                }
                3 -> {
                    phoneModeFragment.addToTray(app.packageName)
                    Toast.makeText(this, "Added to tray", Toast.LENGTH_SHORT).show()
                    dismissAppsOverlay()
                    true
                }
                2 -> {
                    try {
                        val intent = android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = android.net.Uri.parse("package:${app.packageName}")
                        }
                        startActivity(intent)
                    } catch (_: Exception) {
                        Toast.makeText(this, "Can't open app info", Toast.LENGTH_SHORT).show()
                    }
                    dismissAppsOverlay()
                    true
                }
                else -> false
            }
        }
        popup.show()
    }

    private fun dismissAppsOverlay() {
        val overlay = appsOverlay ?: return
        appsOverlay = null
        // Hide keyboard first
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
        imm.hideSoftInputFromWindow(overlay.windowToken, 0)
        // Animate panel sliding down
        val panel = overlay.getChildAt(0)
        if (panel != null) {
            panel.animate().translationY(panel.height.toFloat()).setDuration(150).withEndAction {
                val root = window.decorView as ViewGroup
                root.removeView(overlay)
            }.start()
            overlay.animate().alpha(0f).setDuration(150).start()
        } else {
            val root = window.decorView as ViewGroup
            root.removeView(overlay)
        }
    }

    /**
     * The send-button menu — long-press either circle.
     *
     * This is the home for everything that used to be its own button in the old
     * cluster, now that the rail is down to two: past recordings, the trackpad,
     * and — while a take is live — peek and cancel.
     *
     * Cancel being a MENU ITEM rather than the long-press itself is the point.
     * Josh 2026-09-05: "I don't mean it auto canceling… you hold it and then a
     * menu pops up and one of those menu items is cancel current recording."
     */
    /** Bring Homestead to the front without recreating it. */
    private fun bringSelfForward() {
        startActivity(Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        })
    }

    private fun showSendMenu() {
        // NOT a silent bail. The old `?: return` here is why the broken menu went
        // unnoticed for a day: a long-press produced nothing, with no error to
        // see anywhere. If we cannot show the menu, say so out loud.
        val anchor = floatingControls.sendMenuAnchor()
        if (anchor == null || anchor.windowToken == null) {
            Log.w(TAG, "showSendMenu: no window-attached anchor (detached in-app rail)")
            Toast.makeText(this, "Menu unavailable — long-press the floating button instead", Toast.LENGTH_SHORT).show()
            return
        }
        val popup = android.widget.PopupMenu(this, anchor)
        val recording = audioRecorder.isRecording()

        // Recording-only items go first — they are why he reached for the menu.
        if (recording) {
            popup.menu.add(0, MENU_PEEK, 0, "Peek at transcription")
            popup.menu.add(0, MENU_CANCEL_RECORDING, 1, "Cancel current recording")
        }
        popup.menu.add(0, MENU_HISTORY, 2, "Past recordings")
        // The mouse control lives here now rather than on the record button's
        // hold — Josh 2026-09-05 moved every menu option onto the left button so
        // the right one is free to be the drag handle.
        popup.menu.add(0, MENU_TRACKPAD, 3, "Control the mouse")
        // Only offered once the pair has actually been moved — a reset for
        // something already in its place is just noise. Josh 2026-09-05: "I also
        // have the opportunity to easily reset it… from wherever it's at."
        if (floatingControls.hasCustomPosition() || audioRecorder.overlayHasCustomPosition()) {
            popup.menu.add(0, MENU_RESET_POSITION, 4, "Reset button position")
        }

        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                MENU_PEEK -> { peekTranscription(); true }
                MENU_CANCEL_RECORDING -> { cancelVoiceInput(); true }
                MENU_HISTORY -> { showRecordingHistoryPanel(); true }
                MENU_TRACKPAD -> { showTrackpadOverlay(); true }
                MENU_RESET_POSITION -> {
                    // Both pairs have their own saved spot — the in-app one and
                    // the floating one — so reset means reset them both.
                    floatingControls.resetPosition()
                    audioRecorder.overlayResetPosition()
                    true
                }
                else -> false
            }
        }
        popup.show()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun showTrackpadOverlay() {
        if (trackpadOverlay != null) {
            dismissTrackpadOverlay()
            return
        }

        val dp = resources.displayMetrics.density

        // Wire status listener once. Idempotent — replacing a no-op listener.
        trackpadClient.statusListener = { _, _ -> renderTrackpadStatus() }

        // Auto-connect using saved host. SharedPreferences key parity with the
        // standalone phone-mouse app pref name so users who had it set up
        // before don't have to re-enter.
        val prefs = getSharedPreferences("trackpad", Context.MODE_PRIVATE)
        val savedHost = prefs.getString("host", null)
            ?: getSharedPreferences("phonemouse", Context.MODE_PRIVATE).getString("host", null)
        if (!savedHost.isNullOrBlank()) {
            // Will no-op if already connected; otherwise spins the connect loop.
            trackpadClient.connect(savedHost)
            // Also persist into trackpad prefs so subsequent runs don't fall
            // back to phonemouse prefs.
            prefs.edit().putString("host", savedHost).apply()
        }

        // ── Root scrim ──
        val overlay = FrameLayout(this).apply {
            setBackgroundColor(Color.argb(180, 0, 0, 0))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            elevation = 50 * dp
            setOnClickListener { dismissTrackpadOverlay() }
        }

        // ── Bottom-sheet panel ──
        // Joshua's 2026-04-27 ask: "stay constrained at the same limits that
        // my web view has right now." Solution: leave a 100dp gap at top so
        // the close button + status bar are fully clickable, never pinned
        // under the system menu bar.
        val topInset = (100 * dp).toInt()
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#0E1014"))
                cornerRadii = floatArrayOf(20*dp, 20*dp, 20*dp, 20*dp, 0f, 0f, 0f, 0f)
            }
            background = bg
            setPadding((12*dp).toInt(), (12*dp).toInt(), (12*dp).toInt(), (16*dp).toInt())
            setOnClickListener { /* swallow clicks; only outside dismisses */ }
        }
        val panelParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            resources.displayMetrics.heightPixels - topInset
        ).apply { gravity = Gravity.BOTTOM }

        // ── Header row (status + close) ──
        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val statusTv = TextView(this).apply {
            text = "Trackpad — connecting…"
            textSize = 14f
            setTextColor(Color.parseColor("#E0E0E0"))
            layoutParams = LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
            )
        }
        trackpadStatusText = statusTv
        val closeBtn = TextView(this).apply {
            text = "✕"
            textSize = 22f
            setTextColor(Color.parseColor("#DDDDDD"))
            gravity = Gravity.CENTER
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#252525"))
                setStroke((2f * dp).toInt(), Color.parseColor("#555555"))
            }
            background = bg
            val sz = (44 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(sz, sz)
            isClickable = true
            isFocusable = true
            setOnClickListener { dismissTrackpadOverlay() }
        }
        headerRow.addView(statusTv)
        headerRow.addView(closeBtn)
        panel.addView(headerRow, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = (10 * dp).toInt() })

        // ── Sensitivity slider row ──
        // Joshua's 2026-04-28 ask: "have settings really readily available
        // right out of the beginning, because right now it's still really
        // sensitive and I like it... I wanna hone in that sensitivity."
        // Slider lives directly under the header so he can tune without
        // diving into a settings screen.
        val sensPrefs = getSharedPreferences("trackpad", Context.MODE_PRIVATE)
        val savedSens = sensPrefs.getFloat("sensitivity", 1.6f)
        val sensRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val sensLabel = TextView(this).apply {
            text = "Sensitivity"
            textSize = 13f
            setTextColor(Color.parseColor("#A0A0A0"))
        }
        val sensValue = TextView(this).apply {
            text = String.format("%.1f", savedSens)
            textSize = 13f
            setTextColor(Color.parseColor("#E0E0E0"))
            gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams((40 * dp).toInt(), LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        // SeekBar maps 0..100 → sensitivity 0.4..3.6 (linear).
        val sensSeek = SeekBar(this).apply {
            max = 100
            progress = ((savedSens - 0.4f) / 3.2f * 100f).toInt().coerceIn(0, 100)
        }

        // ── Trackpad surface (smaller — Joshua's 2026-04-28 spec) ──
        val surface = TrackpadSurfaceView(this)
        surface.sensitivity = savedSens
        surface.callbacks = object : TrackpadSurfaceView.Callbacks {
            override fun onMoveDelta(dx: Float, dy: Float) { trackpadClient.sendMove(dx, dy) }
            override fun onTap() { trackpadClient.sendClick() }
            override fun onDoubleTap() { trackpadClient.sendDoubleClick() }
            override fun onScroll(dx: Float, dy: Float) { trackpadClient.sendScroll(dx, dy) }
        }

        sensSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                val s = 0.4f + (progress / 100f) * 3.2f
                surface.sensitivity = s
                sensValue.text = String.format("%.1f", s)
                if (fromUser) sensPrefs.edit().putFloat("sensitivity", s).apply()
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        sensRow.addView(sensLabel, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { marginEnd = (8 * dp).toInt() })
        sensRow.addView(sensSeek, LinearLayout.LayoutParams(
            0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
        ))
        sensRow.addView(sensValue)
        panel.addView(sensRow, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = (8 * dp).toInt() })

        // ── Remote-control cluster ──
        // 2026-07-18 Joshua redesign: the old flat button grid was "just kind
        // of an ugly set of buttons." He wants it to LOOK and FEEL like a
        // physical remote — smaller, rounded, tactile, grouped, "more fun."
        // So the controls now live inside a raised "chassis" (a rounded,
        // gradient-faced panel like a remote's body) and are arranged the way
        // a real media remote is:
        //   • a top pill row: 🎙 Record + ⌨ Keyboard (morphs on record)
        //   • a middle deck split into two clusters:
        //       – left: a Space nav pad  ◀ ` ▶  (like a remote D-pad center)
        //       – right: a vertical VOLUME ROCKER  🔊 / 🔇 / 🔉
        // Buttons are deliberately smaller than before — "remote style."

        // A single tactile remote key. Small, rounded, with a soft top-lit
        // gradient so it reads like a molded rubber button. `heightDp` lets
        // the volume rocker segments be chunkier than the nav keys.
        fun remoteKey(
            label: String,
            textSizeSp: Float = 18f,
            topFill: String = "#2A2F3A",
            bottomFill: String = "#1B1F27",
            stroke: String = "#3A4150",
            corner: Float = 22f,
            onTap: () -> Unit
        ): TextView {
            return TextView(this).apply {
                text = label
                textSize = textSizeSp
                setTextColor(Color.parseColor("#EDEFF3"))
                gravity = Gravity.CENTER
                includeFontPadding = false
                val bg = GradientDrawable(
                    GradientDrawable.Orientation.TOP_BOTTOM,
                    intArrayOf(Color.parseColor(topFill), Color.parseColor(bottomFill))
                ).apply {
                    cornerRadius = corner * dp
                    setStroke((1f * dp).toInt(), Color.parseColor(stroke))
                }
                background = bg
                isClickable = true
                isFocusable = true
                // Press feedback — dim slightly on touch so it feels physical.
                setOnTouchListener { v, ev ->
                    when (ev.actionMasked) {
                        android.view.MotionEvent.ACTION_DOWN -> v.alpha = 0.6f
                        android.view.MotionEvent.ACTION_UP,
                        android.view.MotionEvent.ACTION_CANCEL -> v.alpha = 1f
                    }
                    false
                }
                setOnClickListener { onTap() }
            }
        }

        // The remote chassis: a raised, rounded body that houses the deck.
        val remote = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val body = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.parseColor("#161A21"), Color.parseColor("#0C0E13"))
            ).apply {
                cornerRadius = 26 * dp
                setStroke((1.5f * dp).toInt(), Color.parseColor("#252B36"))
            }
            background = body
            setPadding((12*dp).toInt(), (12*dp).toInt(), (12*dp).toInt(), (12*dp).toInt())
        }

        // Top pill row: 🎙 Record + ⌨ Keyboard (morphs when recording).
        val recordRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        remote.addView(recordRow, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, (50 * dp).toInt()
        ).apply { bottomMargin = (12 * dp).toInt() })
        trackpadRecordRow = recordRow
        renderTrackpadRecordRow()

        // Middle deck: left Space nav pad + right volume rocker, side by side.
        val deck = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        // — Left cluster: Space nav pad  ◀  `  ▶ —
        // Arranged like a remote's directional center: two arrows flanking
        // the backtick, in a slightly recessed sub-panel.
        val navPad = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            val well = GradientDrawable().apply {
                cornerRadius = 20 * dp
                setColor(Color.parseColor("#10131A"))
                setStroke((1f * dp).toInt(), Color.parseColor("#20262F"))
            }
            background = well
            setPadding((8*dp).toInt(), (8*dp).toInt(), (8*dp).toInt(), (8*dp).toInt())
        }
        val navLabel = TextView(this).apply {
            text = "SPACES"
            textSize = 9f
            setTextColor(Color.parseColor("#6B7480"))
            gravity = Gravity.CENTER
            letterSpacing = 0.18f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = (6 * dp).toInt() }
        }
        val navKeys = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        val spLeft = remoteKey("◀", textSizeSp = 16f, corner = 24f) {
            vibrateLight(); trackpadClient.sendKey("spaceLeft")
        }
        val tick = remoteKey("`", textSizeSp = 18f,
            topFill = "#312538", bottomFill = "#231A2B", stroke = "#43324D", corner = 24f) {
            vibrateLight(); trackpadClient.sendKey("backtick")
        }
        val spRight = remoteKey("▶", textSizeSp = 16f, corner = 24f) {
            vibrateLight(); trackpadClient.sendKey("spaceRight")
        }
        val navBtn = LinearLayout.LayoutParams((46*dp).toInt(), (46*dp).toInt()).apply {
            marginStart = (4*dp).toInt(); marginEnd = (4*dp).toInt()
        }
        navKeys.addView(spLeft, navBtn)
        navKeys.addView(tick, LinearLayout.LayoutParams((46*dp).toInt(), (46*dp).toInt()).apply {
            marginStart = (4*dp).toInt(); marginEnd = (4*dp).toInt()
        })
        navKeys.addView(spRight, LinearLayout.LayoutParams((46*dp).toInt(), (46*dp).toInt()).apply {
            marginStart = (4*dp).toInt(); marginEnd = (4*dp).toInt()
        })
        navPad.addView(navLabel)
        navPad.addView(navKeys)

        // — Right cluster: vertical VOLUME ROCKER  🔊 / 🔇 / 🔉 —
        // The iconic remote rocker: volume-up on top, mute in the middle,
        // volume-down on the bottom, stacked in one recessed column.
        val rocker = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            val well = GradientDrawable().apply {
                cornerRadius = 24 * dp
                setColor(Color.parseColor("#10131A"))
                setStroke((1f * dp).toInt(), Color.parseColor("#20262F"))
            }
            background = well
            setPadding((8*dp).toInt(), (8*dp).toInt(), (8*dp).toInt(), (8*dp).toInt())
        }
        val volLabel = TextView(this).apply {
            text = "VOL"
            textSize = 9f
            setTextColor(Color.parseColor("#6B7480"))
            gravity = Gravity.CENTER
            letterSpacing = 0.18f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = (6 * dp).toInt() }
        }
        val volUp = remoteKey("🔊", textSizeSp = 18f,
            topFill = "#20303F", bottomFill = "#16232F", stroke = "#294050", corner = 22f) {
            vibrateLight(); trackpadClient.sendVolumeUp()
        }
        val volMute = remoteKey("🔇", textSizeSp = 16f,
            topFill = "#33222B", bottomFill = "#241820", stroke = "#45303A", corner = 18f) {
            vibrateLight(); trackpadClient.sendMute()
        }
        val volDown = remoteKey("🔉", textSizeSp = 18f,
            topFill = "#20303F", bottomFill = "#16232F", stroke = "#294050", corner = 22f) {
            vibrateLight(); trackpadClient.sendVolumeDown()
        }
        val rockW = (58*dp).toInt()
        rocker.addView(volLabel)
        rocker.addView(volUp, LinearLayout.LayoutParams(rockW, (42*dp).toInt()).apply {
            bottomMargin = (5*dp).toInt()
        })
        rocker.addView(volMute, LinearLayout.LayoutParams(rockW, (36*dp).toInt()).apply {
            bottomMargin = (5*dp).toInt()
        })
        rocker.addView(volDown, LinearLayout.LayoutParams(rockW, (42*dp).toInt()))

        // Assemble the deck: nav pad takes the flexible left space, rocker
        // hugs the right like a real remote's side rocker.
        deck.addView(navPad, LinearLayout.LayoutParams(
            0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
        ).apply { marginEnd = (12*dp).toInt() })
        deck.addView(rocker, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ))
        remote.addView(deck, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ))

        // — EDIT row: ⌫ Backspace + ⌘A Select-All —  (sibling worker's)
        // 2026-08-12 Joshua ask: "I couldn't BACKSPACE very well or SELECT ALL
        // very well in an input" via the trackpad. Two quick-keys fire the key
        // at the Mac's focused input over the same TCP 'key' path the Spaces
        // pad uses. Styled to match the remote's molded keys; sits below the
        // Spaces/Volume deck as its own labeled cluster.
        val editWell = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            val well = GradientDrawable().apply {
                cornerRadius = 20 * dp
                setColor(Color.parseColor("#10131A"))
                setStroke((1f * dp).toInt(), Color.parseColor("#20262F"))
            }
            background = well
            setPadding((8*dp).toInt(), (8*dp).toInt(), (8*dp).toInt(), (8*dp).toInt())
        }
        val editLabel = TextView(this).apply {
            text = "EDIT"
            textSize = 9f
            setTextColor(Color.parseColor("#6B7480"))
            gravity = Gravity.CENTER
            letterSpacing = 0.18f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = (6 * dp).toInt() }
        }
        val editKeys = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        val backspaceKey = remoteKey("⌫", textSizeSp = 20f,
            topFill = "#3A2A2A", bottomFill = "#281C1C", stroke = "#4A3535", corner = 20f) {
            vibrateLight(); trackpadClient.sendKeyBackspace()
        }
        val selectAllKey = remoteKey("⌘A", textSizeSp = 17f,
            topFill = "#20303F", bottomFill = "#16232F", stroke = "#294050", corner = 20f) {
            vibrateLight(); trackpadClient.sendKeySelectAll()
        }
        editKeys.addView(backspaceKey, LinearLayout.LayoutParams(
            0, (44*dp).toInt(), 1f
        ).apply { marginStart = (4*dp).toInt(); marginEnd = (4*dp).toInt() })
        editKeys.addView(selectAllKey, LinearLayout.LayoutParams(
            0, (44*dp).toInt(), 1f
        ).apply { marginStart = (4*dp).toInt(); marginEnd = (4*dp).toInt() })
        editWell.addView(editLabel)
        editWell.addView(editKeys, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ))
        remote.addView(editWell, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = (10 * dp).toInt() })

        // — Grandpa Mode row: 🔍 big toggle + −[250%]+ level stepper —  (mine)
        // Joshua 2026-08-12: one tap zooms the whole Mac screen way in so he
        // can read it from across the room. Level is adjustable (150..400%);
        // the −/+ chips restep it live if it's already on.
        val grandpaRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val well = GradientDrawable().apply {
                cornerRadius = 24 * dp
                setColor(Color.parseColor("#10131A"))
                setStroke((1f * dp).toInt(), Color.parseColor("#20262F"))
            }
            background = well
            setPadding((10*dp).toInt(), (8*dp).toInt(), (10*dp).toInt(), (8*dp).toInt())
        }
        // Big toggle: shows current on/off state, lights amber when ON.
        val grandpaBtn = remoteKey("🔍 GRANDPA  OFF", textSizeSp = 15f,
            topFill = "#2A2F3A", bottomFill = "#1B1F27", stroke = "#3A4150", corner = 20f) {
            vibrateLight()
            grandpaModeOn = !grandpaModeOn
            if (grandpaModeOn) trackpadClient.sendZoomOn(grandpaLevel)
            else trackpadClient.sendZoomOff()
            renderGrandpaMode()
        }
        grandpaToggleBtn = grandpaBtn
        // −/+ level stepper with the live % between them.
        val gpMinus = remoteKey("−", textSizeSp = 22f,
            topFill = "#20303F", bottomFill = "#16232F", stroke = "#294050", corner = 18f) {
            vibrateLight()
            if (grandpaLevel > 1) {
                grandpaLevel--
                if (grandpaModeOn) { trackpadClient.sendZoomOff(); trackpadClient.sendZoomOn(grandpaLevel) }
                renderGrandpaMode()
            }
        }
        val gpLevel = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.parseColor("#EDEFF3"))
            gravity = Gravity.CENTER
            includeFontPadding = false
            letterSpacing = 0.04f
            maxLines = 1
        }
        grandpaLevelLabel = gpLevel
        val gpPlus = remoteKey("+", textSizeSp = 20f,
            topFill = "#20303F", bottomFill = "#16232F", stroke = "#294050", corner = 18f) {
            vibrateLight()
            if (grandpaLevel < grandpaMaxLevel) {
                grandpaLevel++
                if (grandpaModeOn) { trackpadClient.sendZoomOff(); trackpadClient.sendZoomOn(grandpaLevel) }
                renderGrandpaMode()
            }
        }
        val stepH = (40*dp).toInt()
        grandpaRow.addView(grandpaBtn, LinearLayout.LayoutParams(
            0, stepH, 1f
        ).apply { marginEnd = (10*dp).toInt() })
        grandpaRow.addView(gpMinus, LinearLayout.LayoutParams((44*dp).toInt(), stepH))
        grandpaRow.addView(gpLevel, LinearLayout.LayoutParams((70*dp).toInt(), stepH))
        grandpaRow.addView(gpPlus, LinearLayout.LayoutParams((44*dp).toInt(), stepH))
        remote.addView(grandpaRow, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = (12*dp).toInt() })
        renderGrandpaMode()

        panel.addView(remote, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = (10 * dp).toInt() })

        // Bottom: trackpad surface. Joshua's R5 ask: "my mouse button
        // should be much lower at the bottom of the page."
        panel.addView(surface, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, (260 * dp).toInt()
        ))

        overlay.addView(panel, panelParams)
        val root = window.decorView as ViewGroup
        root.addView(overlay)
        trackpadOverlay = overlay

        // Slide-up animation
        panel.translationY = panelParams.height.toFloat()
        panel.animate().translationY(0f).setDuration(180).start()
        overlay.alpha = 0f
        overlay.animate().alpha(1f).setDuration(180).start()

        // Start status ticker
        renderTrackpadStatus()
        trackpadStatusHandler.removeCallbacks(trackpadStatusTicker)
        trackpadStatusHandler.post(trackpadStatusTicker)

        // Start polling Whisper Village recording state on the Mac. Poll
        // every 1.2s — fast enough that Joshua's laptop right-Option taps
        // reflect on the phone within a couple seconds, slow enough to not
        // hammer the Mac. Poller stops in dismissTrackpadOverlay().
        trackpadRecPoller?.close()
        trackpadRecPoller = trackpadClient.pollRecordingStatus(1200L) { rec ->
            trackpadStatusHandler.post {
                if (trackpadIsRecording != rec) {
                    trackpadIsRecording = rec
                    renderTrackpadRecordRow()
                }
            }
        }
    }

    /** Repaint the Grandpa Mode toggle label/color and the level %. When ON
     *  the toggle glows amber and reads "ON"; the level chip always shows the
     *  current magnification so Josh knows what a fresh toggle will apply. */
    private fun renderGrandpaMode() {
        val name = grandpaLevelName.getOrElse(grandpaLevel) { "BIG" }
        grandpaLevelLabel?.text = name
        val btn = grandpaToggleBtn ?: return
        if (grandpaModeOn) {
            btn.text = "🔍 GRANDPA  ON"
            btn.setTextColor(Color.parseColor("#0D0D0D"))
            btn.background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.parseColor("#FFD24A"), Color.parseColor("#FFBF00"))
            ).apply {
                cornerRadius = 20 * resources.displayMetrics.density
                setStroke((1f * resources.displayMetrics.density).toInt(), Color.parseColor("#C79600"))
            }
        } else {
            btn.text = "🔍 GRANDPA  OFF"
            btn.setTextColor(Color.parseColor("#EDEFF3"))
            btn.background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.parseColor("#2A2F3A"), Color.parseColor("#1B1F27"))
            ).apply {
                cornerRadius = 20 * resources.displayMetrics.density
                setStroke((1f * resources.displayMetrics.density).toInt(), Color.parseColor("#3A4150"))
            }
        }
    }

    private fun renderTrackpadRecordRow() {
        val row = trackpadRecordRow ?: return
        val dp = resources.displayMetrics.density
        row.removeAllViews()

        // Remote-style pill: smaller, rounded, soft top-lit gradient +
        // press-dim feedback — matches the redesigned remote chassis.
        // `topFill`/`bottomFill` give the molded-button gradient.
        fun bigButton(label: String, topFill: String, bottomFill: String, strokeColor: String, onTap: () -> Unit): TextView {
            return TextView(this).apply {
                text = label
                textSize = 16f
                setTextColor(Color.parseColor("#EDEFF3"))
                gravity = Gravity.CENTER
                includeFontPadding = false
                val bg = GradientDrawable(
                    GradientDrawable.Orientation.TOP_BOTTOM,
                    intArrayOf(Color.parseColor(topFill), Color.parseColor(bottomFill))
                ).apply {
                    cornerRadius = 22 * dp
                    setStroke((1f * dp).toInt(), Color.parseColor(strokeColor))
                }
                background = bg
                isClickable = true
                isFocusable = true
                setOnTouchListener { v, ev ->
                    when (ev.actionMasked) {
                        android.view.MotionEvent.ACTION_DOWN -> v.alpha = 0.6f
                        android.view.MotionEvent.ACTION_UP,
                        android.view.MotionEvent.ACTION_CANCEL -> v.alpha = 1f
                    }
                    false
                }
                setOnClickListener { onTap() }
            }
        }
        fun add(view: View) {
            row.addView(view, LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.MATCH_PARENT, 1f
            ).apply {
                marginStart = (4 * dp).toInt()
                marginEnd = (4 * dp).toInt()
            })
        }

        if (!trackpadIsRecording) {
            // Idle — fat record button + keyboard button side by side.
            // Joshua's 2026-04-28 layout: Record + Keyboard share the
            // morphing row; when recording fires both go away and three
            // destination buttons take over.
            val rec = bigButton("🎙 Record", "#6E3636", "#4A2525", "#8A4747") {
                vibrateMedium()
                trackpadClient.sendKey("rightOption")
            }
            val kbd = bigButton("⌨ Keyboard", "#213524", "#152118", "#31513C") {
                vibrateLight()
                showTrackpadKeyboardDialog()
            }
            add(rec)
            add(kbd)
        } else {
            // Recording — three destination buttons. Tap = claim transcript
            // for that target. Brokered through the Mac (TCP wire →
            // local POST) to avoid the LAN HTTP race that bit us in R3-R4.
            // We don't fire right-Option to stop — Whisper Village's VAD
            // ends the recording naturally, OR Joshua hits right-Option
            // himself. Trying to script the stop introduced ordering bugs;
            // the desktop pill doesn't auto-stop either.
            // Joshua 2026-04-28: phone is a remote for the desktop. The
            // claim target is whatever the DESKTOP Electron presenter has
            // focused, NOT what the phone WebView shows. Mac brokers the
            // GET /api/presenter/desktop-current → POST claim. Phone just
            // signals "claim my desktop's current card" via TCP.
            val card = bigButton("→ Card", "#33517F", "#22375A", "#3A5D94") {
                vibrateLight()
                trackpadClient.sendClaimCardCurrent()
                Toast.makeText(this@MainActivity, "→ Card (using desktop's current)", Toast.LENGTH_SHORT).show()
                // Auto-stop after the claim has had a moment to land.
                // Mac's claim handler is blocking, so the TCP queue serializes:
                // claimCardCurrent finishes (GET state + POST claim) before
                // the right-Option message is processed.
                trackpadStatusHandler.postDelayed({
                    trackpadClient.sendKey("rightOption")
                }, 250L)
            }
            val steward = bigButton("→ Steward", "#33517F", "#22375A", "#3A5D94") {
                vibrateLight()
                trackpadClient.sendClaimStewardCurrent()
                Toast.makeText(this@MainActivity, "→ Steward (using desktop's selection)", Toast.LENGTH_SHORT).show()
                trackpadStatusHandler.postDelayed({
                    trackpadClient.sendKey("rightOption")
                }, 250L)
            }
            // → Cursor: no claim. Just stop recording — Whisper Village's
            // default behavior is to type the transcript at wherever the
            // Mac cursor is. R5 had this as a no-op which Joshua flagged:
            // "would have the exact same behavior as just hitting right
            // option. That'd be great." So → Cursor = right-Option.
            val cursorBtn = bigButton("→ Cursor", "#33517F", "#22375A", "#3A5D94") {
                vibrateLight()
                trackpadClient.sendKey("rightOption")
                Toast.makeText(this@MainActivity, "→ Cursor: right-Option", Toast.LENGTH_SHORT).show()
            }
            add(card)
            add(steward)
            add(cursorBtn)
        }
    }

    private fun renderTrackpadStatus() {
        val tv = trackpadStatusText ?: return
        runOnUiThread {
            val s = trackpadClient.status
            val host = getSharedPreferences("trackpad", Context.MODE_PRIVATE).getString("host", "?") ?: "?"
            val text = when (s) {
                TrackpadClient.Status.Connected -> {
                    val sec = trackpadClient.secondsSinceLastPong()
                    when {
                        sec < 0 -> "Connected → $host · waiting…"
                        sec <= 6 -> "Connected → $host · live (${sec}s)"
                        else -> "Connected → $host · stale (${sec}s)"
                    }
                }
                TrackpadClient.Status.Connecting -> "Connecting…"
                TrackpadClient.Status.Disconnected -> "Disconnected — Mac unreachable"
                TrackpadClient.Status.Error -> "Error: ${trackpadClient.lastError ?: "?"}"
            }
            tv.text = text
            val color = when (s) {
                TrackpadClient.Status.Connected -> Color.parseColor("#6DDC7E")
                TrackpadClient.Status.Connecting -> Color.parseColor("#E0E0E0")
                else -> Color.parseColor("#D96363")
            }
            tv.setTextColor(color)
        }
    }

    /** Live-keyboard dialog. Phone shows a borderless EditText; Android
     *  system keyboard auto-pops. Every text change is diffed against the
     *  last-sent state and forwarded to the Mac as either a typeText
     *  (chars added) or backspace (chars removed). The Mac types each
     *  chunk at its focused input via CGEventKeyboardSetUnicodeString.
     *
     *  We swallow autocorrect-style mid-string edits by computing the
     *  longest common prefix between old + new. Anything erased gets a
     *  backspace count; anything new gets typed. Imperfect but fine for
     *  the usual case (left-to-right typing + backspaces). Joshua's
     *  2026-04-28 ask: "have a button down there that would invoke an
     *  actual keyboard like on my phone... start typing wherever my
     *  cursor is at on the screen." */
    private fun showTrackpadKeyboardDialog() {
        val dp = resources.displayMetrics.density
        val edit = EditText(this).apply {
            hint = "Type — keys go to Mac cursor"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                        android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                        android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            minLines = 3
        }
        val container = FrameLayout(this).apply {
            setPadding((20 * dp).toInt(), (8 * dp).toInt(), (20 * dp).toInt(), 0)
            addView(edit)
        }

        // Track what the Mac has so far so we know what delta to ship on
        // each text-change. Starts empty.
        var sentSoFar = ""
        edit.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {
                val now = s?.toString() ?: ""
                if (now == sentSoFar) return
                // Find longest common prefix length.
                var lcp = 0
                val limit = minOf(now.length, sentSoFar.length)
                while (lcp < limit && now[lcp] == sentSoFar[lcp]) lcp++
                val erased = sentSoFar.length - lcp
                val added  = if (now.length > lcp) now.substring(lcp) else ""
                if (erased > 0) trackpadClient.sendBackspace(erased)
                if (added.isNotEmpty()) trackpadClient.sendTypeText(added)
                sentSoFar = now
            }
        })

        val dialog = AlertDialog.Builder(this)
            .setTitle("Type to Mac cursor")
            .setView(container)
            .setNegativeButton("Done", null)
            .create()
        dialog.setOnShowListener {
            edit.requestFocus()
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
            imm.showSoftInput(edit, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        }
        dialog.show()
    }

    private fun dismissTrackpadOverlay() {
        val overlay = trackpadOverlay ?: return
        trackpadOverlay = null
        trackpadStatusText = null
        trackpadRecordRow = null
        // Stop the recording-state poller. Reopening the panel will start
        // a fresh one. trackpadIsRecording's value is irrelevant while the
        // panel is closed — next open polls before rendering.
        try { trackpadRecPoller?.close() } catch (_: Exception) {}
        trackpadRecPoller = null
        trackpadStatusHandler.removeCallbacks(trackpadStatusTicker)
        val panel = overlay.getChildAt(0)
        if (panel != null) {
            panel.animate().translationY(panel.height.toFloat()).setDuration(150).withEndAction {
                val root = window.decorView as ViewGroup
                root.removeView(overlay)
            }.start()
            overlay.animate().alpha(0f).setDuration(150).start()
        } else {
            val root = window.decorView as ViewGroup
            root.removeView(overlay)
        }
        // Note: NOT calling trackpadClient.disconnect() — keep the TCP socket
        // alive across panel open/close so the next open is instant.
    }

    private fun createAppOverlayTile(app: LaunchableApp, dp: Float, compact: Boolean): LinearLayout {
        val iconSize = if (compact) (44 * dp).toInt() else (48 * dp).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            isClickable = true
            isFocusable = true
            setPadding((4 * dp).toInt(), (4 * dp).toInt(), (4 * dp).toInt(), (4 * dp).toInt())
            setOnClickListener {
                launchApp(app)
                dismissAppsOverlay()
            }

            val iconView = ImageView(this@MainActivity).apply {
                setImageDrawable(app.icon)
                layoutParams = LinearLayout.LayoutParams(iconSize, iconSize)
            }
            addView(iconView)

            val nameView = TextView(this@MainActivity).apply {
                text = app.appName
                textSize = 11f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                layoutParams = LinearLayout.LayoutParams(
                    (56 * dp).toInt(),
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = (2 * dp).toInt() }
            }
            addView(nameView)
        }
    }

    private fun createAppRow(app: LaunchableApp, dp: Float): LinearLayout {
        val iconSize = (40 * dp).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isClickable = true
            isFocusable = true
            setPadding((8 * dp).toInt(), (10 * dp).toInt(), (8 * dp).toInt(), (10 * dp).toInt())
            setOnClickListener {
                launchApp(app)
                dismissAppsOverlay()
            }

            val iconView = ImageView(this@MainActivity).apply {
                setImageDrawable(app.icon)
                layoutParams = LinearLayout.LayoutParams(iconSize, iconSize).apply {
                    marginEnd = (12 * dp).toInt()
                }
            }
            addView(iconView)

            val nameLayout = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }

            val nameView = TextView(this@MainActivity).apply {
                text = app.appName
                textSize = 15f
                setTextColor(Color.WHITE)
                typeface = fontBodyMedium
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            }
            nameLayout.addView(nameView)

            if (app.isWorkProfile) {
                val badge = TextView(this@MainActivity).apply {
                    text = "WORK"
                    textSize = 9f
                    setTextColor(Color.parseColor("#4A90D9"))
                    typeface = Typeface.DEFAULT_BOLD
                    val bg = GradientDrawable().apply {
                        setColor(Color.parseColor("#1A2A40"))
                        cornerRadius = 4 * dp
                    }
                    background = bg
                    setPadding((4 * dp).toInt(), (1 * dp).toInt(), (4 * dp).toInt(), (1 * dp).toInt())
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    ).apply { marginStart = (8 * dp).toInt() }
                }
                nameLayout.addView(badge)
            }

            addView(nameLayout)
        }
    }
}
