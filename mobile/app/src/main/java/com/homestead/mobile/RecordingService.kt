package com.homestead.mobile

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * Owns the microphone for the whole app.
 *
 * Why this exists: the AudioRecorder used to be an Activity field. That is fine
 * while Homestead is on screen — navigation here is hide()/show(), so fragments
 * are never destroyed and a take survives moving between screens. It is NOT fine
 * the moment Joshua leaves the app. MainActivity is the HOME launcher; backgrounded,
 * it is a prime low-memory-kill candidate, and Android 14 additionally revokes the
 * mic from any app that is not visible unless a microphone-typed foreground service
 * is holding it. Either way the take died, and cleanup() deleted the audio with it.
 *
 * Hosting the recorder here ties its lifetime to the service instead of the
 * Activity, so a take keeps running across screens, across leaving the app, and
 * across the Activity being recreated (rotation, wallpaper change).
 */
class RecordingService : Service() {

    companion object {
        private const val TAG = "RecordingService"
        private const val NOTIFICATION_ID = 4711

        const val ACTION_START = "com.homestead.mobile.RECORDING_START"
        const val ACTION_STOP = "com.homestead.mobile.RECORDING_STOP"

        /** How often the floating circles re-ask which card is showing. */
        private const val OVERLAY_POLL_MS = 700L

        /**
         * Backstop on the screen-on lock. Not the mechanism — every end-of-take
         * path releases explicitly — just a ceiling so a process killed between
         * acquire and release cannot leave the phone awake forever.
         */
        private const val SCREEN_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000L

        /**
         * How often to check whether he has moved to a different app, while the
         * cluster is expanded out there. Only ever runs for the few seconds
         * before auto-collapse, so it can afford to be responsive.
         */
        private const val APP_SWITCH_POLL_MS = 600L

        /**
         * How often to check what app is on screen while idle. Cheap enough to
         * run continuously and fast enough that the dot appears as he leaves.
         */
        private const val FOREGROUND_WATCH_MS = 1000L

        /**
         * The live service, for callers that cannot practically bind.
         *
         * The Quick Settings tile is the case: it is created and torn down around
         * a single tap, so a bind would still be connecting by the time it is
         * gone. The service is already a long-lived singleton owning the overlay,
         * so a plain reference is both simpler and more honest than a bind that
         * races its own callback.
         *
         * Null whenever the service is not running, which callers must handle —
         * see the tile's fallback to simply starting it.
         */
        @Volatile
        private var instance: RecordingService? = null

        /**
         * Start (or stop) a take from outside — what the tile actually does.
         *
         * Josh 2026-09-06, after using the reveal-only tile: "how often do I
         * actually want the buttons to be revealed? Probably not a ton… What I
         * really am going for is a settings tile that if I click it, it would
         * just literally start as if there was actually a recording starting.
         * Period. Like as if I had clicked the recording button."
         *
         * So it fires the SAME lambda the floating record button fires — the one
         * MainActivity installs — rather than reaching for the recorder directly.
         * That handler does more than start audio (permission prompt, the in-app
         * control state, level polling, haptics), and a second implementation
         * here would drift from it the first time either changed. "That exact
         * action" is only true if it is literally the same call.
         *
         * Revealing the buttons is then automatic: a live take already shows the
         * full cluster everywhere, which is the behaviour he kept.
         *
         * False when the service is not up OR no handler is installed yet (the
         * Activity has never run this process), so the tile can fall back.
         */
        fun toggleRecordingFromOutside(): Boolean {
            val svc = instance ?: return false
            val tap = svc.onOverlayRecordTap ?: return false
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                tap.invoke()
                // The handler may have been wired to a MainActivity that has since
                // been destroyed — this phone keeps several instances around, and
                // a stale reference is not null, so the check above cannot see it.
                // MainActivity's own guard detects that and clears itself, which
                // is what makes the NEXT call fall back. Re-check here so THIS tap
                // still records rather than being the one Josh loses.
                if (svc.onOverlayRecordTap == null && !(svc.recorderReady() && svc.isRecording())) {
                    Log.w(TAG, "Record handler was stale — starting the service to re-wire")
                    svc.startSelfForRewire()
                }
            }
            return true
        }

        /** Is a take running right now? Drives the tile's on/off state. */
        fun isRecordingNow(): Boolean {
            val svc = instance ?: return false
            return svc.recorderReady() && svc.isRecording()
        }

        /**
         * What the floating rail is doing right now, and why — read live.
         *
         * Proving the visibility rules on Josh's actual phone is otherwise
         * impossible: there is no screenshot endpoint and the accessibility
         * service is off, so "is the window up?" cannot be observed from the
         * Mac. The KEY field is windowUp, which reports whether the window
         * genuinely exists — not what we last decided it should be. The inputs
         * beside it say WHICH rule produced that, so a wrong answer names its
         * own cause instead of needing a guess.
         *
         * Same reason /wallpaper-debug reads the live window rather than its
         * mirrors: a mirror cannot observe the failure it exists to detect.
         */
        /** The recent visibility decisions, for /rail-debug/history. */
        fun overlayDecisionHistory(): List<String> =
            instance?.decisionHistory() ?: listOf("recording service not running")

        fun overlayVisibilityReport(): Map<String, String> {
            val svc = instance
                ?: return mapOf("error" to "recording service not running")
            return try {
                mapOf(
                    // THE observation: does the window actually exist right now?
                    "windowUp" to (svc.overlay?.isShowing() == true).toString(),
                    "shouldBeVisible" to svc.overlayShouldBeVisible().toString(),
                    // The three inputs, so a mismatch is self-diagnosing.
                    "recording" to (svc.recorderReady() && svc.isRecording()).toString(),
                    "homesteadOnScreen" to svc.homesteadIsOnScreen().toString(),
                    "homesteadModeShowing" to svc.homesteadModeShowing.toString(),
                    "keyboardShowing" to svc.keyboardShowing.toString(),
                    // THE observation for the screen-on fix: is the wake lock
                    // genuinely held right now? Read off the lock itself, not
                    // off a flag we set — a mirror cannot observe the failure it
                    // exists to detect. During a take this must be true whether
                    // or not Homestead is the app on screen.
                    "screenLockHeld" to (svc.screenLock?.isHeld == true).toString(),
                    "screenOnBuild" to "RECORDING_SCREEN_LOCK_v1",
                    // Which build of the rail logic is answering. Bump on every
                    // behavioural change here, so a fix can never be "verified"
                    // against an install that predates it — the exact trap the
                    // phone-side bug fell into on the first pass.
                    "railBuild" to "RAIL_DECISION_LOG_v5"
                )
            } catch (e: Exception) {
                mapOf("error" to (e.message ?: "unknown"))
            }
        }
    }

    inner class LocalBinder : Binder() {
        val service: RecordingService get() = this@RecordingService
    }

    private val binder = LocalBinder()
    private lateinit var recorder: AudioRecorder
    private var startedAtMs: Long = 0L

    /**
     * Holds the screen on for the whole of a take.
     *
     * Why here and not FloatingControls: that class already does
     * keepScreenOn(true/false) around its isRecording setter, but it sets
     * FLAG_KEEP_SCREEN_ON on the ACTIVITY WINDOW, and a window flag only holds
     * while that window is foregrounded. The overlay and the Quick Settings tile
     * exist precisely so Josh can record from other apps — and the moment he is
     * not looking at Homestead the flag stops counting and the screen dims out
     * from under a live take. The service is the only thing that spans every
     * start/stop path, on screen or off, so the lock belongs here.
     *
     * SCREEN_BRIGHT (not PARTIAL) because the ask is the display staying lit,
     * not merely the CPU running.
     */
    private var screenLock: android.os.PowerManager.WakeLock? = null

    /** The floating circles that follow Joshua out of the app while a take runs. */
    private var overlay: QuickSendOverlay? = null

    /**
     * True while Homestead itself is on screen.
     *
     * No longer gates the overlay. Josh 2026-09-05 collapsed the two control
     * surfaces into one: "I'd like the version that appears when I have other
     * apps open to be the permanent one that stays around forever. The other one
     * can go away." Hiding here is what produced the two-copies-in-two-spots
     * feel — and, when an app-switch event was missed, the rare both-at-once.
     *
     * Kept as a field because the Activity still reports it and it is useful
     * context, but the overlay now persists either way.
     */
    @Volatile
    var appInForeground: Boolean = true
        set(value) {
            field = value
            // Guard the lateinit: binding implies onCreate ran, but a crash here
            // would take the whole recording down for a cosmetic decision.
            if (!::recorder.isInitialized) return
            // Refresh rather than tear down — the surface is the same one on
            // every screen now, so crossing in or out of Homestead changes
            // nothing about whether it is up.
            showOverlay()
        }

    /**
     * Is the HOMESTEAD side of the launcher showing, rather than the phone side?
     *
     * Josh 2026-09-09: "It should only be immediately visible if I'm on the
     * homestead part of the launcher, not the app part."
     *
     * Reported by the Activity, because only it knows which home fragment is up —
     * both modes are the SAME package, so the usage-stats read that answers
     * [homesteadIsOnScreen] cannot tell them apart. Defaults true so a take
     * started before the Activity has ever reported still shows its controls.
     *
     * Assigning re-evaluates immediately: he swipes between the two modes with
     * the rail already up, so a check made once at construction would be wrong
     * in his hand the moment he moved.
     */
    @Volatile
    var homesteadModeShowing: Boolean = true
        set(value) {
            val changed = field != value
            field = value
            if (!changed || !::recorder.isInitialized) return
            showOverlay()
        }

    /**
     * Is the NATIVE ANDROID KEYBOARD up?
     *
     * Josh 2026-09-09, correcting a first pass that gated on the app's own text
     * box: "I do not want to hide the recording controls if the apk text box is
     * open. Only if the native keyboard from android is up, not if I'm in
     * 'keyboard mode'."
     *
     * The keyboard is what physically covers the rail; the app's box being on
     * screen is not, so "keyboard mode" with no keyboard raised keeps the rail.
     *
     * The "unless actively recording" half is load-bearing and lives in
     * [overlayShouldBeVisible] — mid-take the rail stays, because stopping the
     * take is what he needs it for.
     *
     * Same push-and-re-evaluate contract as [homesteadModeShowing]: the keyboard
     * comes up and down under a rail that is already on screen.
     */
    @Volatile
    var keyboardShowing: Boolean = false
        set(value) {
            val changed = field != value
            field = value
            if (!changed || !::recorder.isInitialized) return
            showOverlay()
        }

    /**
     * The ONE answer to "should the rail be on screen right now?"
     *
     * Every visibility decision routes through here so the conditions cannot
     * drift apart between the poll, the show path and the take-ended path — the
     * three places that used to each ask [homesteadIsOnScreen] on their own.
     *
     * A LIVE TAKE OVERRIDES EVERYTHING except leaving the app, which is the
     * pre-existing rule. That is what keeps the stop button reachable with the
     * keyboard up, and it is the case Josh would notice first if it regressed.
     */
    internal fun overlayShouldBeVisible(): Boolean {
        val rec = ::recorder.isInitialized && recorder.isRecording()
        val onScreen = homesteadIsOnScreen()
        val answer = when {
            !onScreen -> false
            // Recording: stay up regardless of mode or keyboard — he has to be
            // able to stop the take he can hear running.
            rec -> true
            !homesteadModeShowing -> false
            keyboardShowing -> false
            else -> true
        }
        recordDecision(onScreen, rec, answer)
        return answer
    }

    /**
     * Remember the last few DISTINCT visibility decisions, with their inputs.
     *
     * Driving the phone from the Mac to prove these rules kept losing a race
     * with the screen timeout: holding Homestead in the foreground long enough
     * to switch modes and raise a keyboard is not something a remote caller can
     * count on. This inverts it — Joshua's ORDINARY use produces the evidence,
     * and the Mac just reads it afterwards. No screen time required, and what
     * gets recorded is real behaviour rather than a driven simulation.
     *
     * Deduplicated on the input tuple so sitting idle cannot flood it; capped so
     * it can never grow. Diagnostic only — nothing reads this to make a decision.
     */
    private val decisionLog = java.util.ArrayDeque<String>()
    private var lastDecisionKey: String? = null

    private fun recordDecision(onScreen: Boolean, rec: Boolean, answer: Boolean) {
        val key = "$onScreen|$rec|$homesteadModeShowing|$keyboardShowing|$answer"
        if (key == lastDecisionKey) return
        lastDecisionKey = key
        val stamp = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
            .format(java.util.Date())
        synchronized(decisionLog) {
            decisionLog.addLast(
                "$stamp onScreen=$onScreen recording=$rec " +
                    "homesteadSide=$homesteadModeShowing keyboard=$keyboardShowing " +
                    "-> visible=$answer"
            )
            while (decisionLog.size > 40) decisionLog.removeFirst()
        }
    }

    /** The recent decisions, oldest first. */
    internal fun decisionHistory(): List<String> =
        synchronized(decisionLog) { decisionLog.toList() }

    /** Supplied by MainActivity — see FloatingControls.QuickSendTargets. Carries
     *  the steading badge for the worker case (Josh 2026-09-10). */
    var overlayTargets: (() -> FloatingControls.QuickSendTargets)? = null
    var onOverlaySendSteward: (() -> Unit)? = null
    var onOverlaySendCard: (() -> Unit)? = null
    /** Long-press the left floating circle — same menu as in-app, cancel included. */
    var onOverlayLongPress: (() -> Unit)? = null
    /** Tap the floating record button — start or stop a take from anywhere. */
    var onOverlayRecordTap: (() -> Unit)? = null
    /** Tap the floating keyboard button — bring Homestead forward to type. */
    var onOverlayKeyboardTap: (() -> Unit)? = null
    /** Tap the floating return button — back to Homestead, in its current mode. */
    var onOverlayReturnTap: (() -> Unit)? = null

    /**
     * Re-collapse the overlay when he moves to a DIFFERENT app.
     *
     * Josh 2026-09-06: "every time I go to a new app, this should be the new
     * behavior" — so expanding the controls in Chrome must not leave them
     * expanded when he lands in Gmail. Homestead's own foreground flag cannot
     * see that: it only fires when Homestead itself starts or stops.
     *
     * Deliberately cheap. This runs ONLY while the cluster is expanded outside
     * the app, which the auto-collapse caps at a few seconds — not a standing
     * background poll. It reads the most recent app-to-foreground event and
     * collapses the moment the package differs from the one he expanded over.
     */
    private val switchPollHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var expandedOverPackage: String? = null

    private val switchPollRunnable = object : Runnable {
        override fun run() {
            if (homesteadIsOnScreen()) return
            val current = currentForegroundPackage()
            if (current != null && expandedOverPackage != null && current != expandedOverPackage) {
                overlay?.collapseIfIdle()
                expandedOverPackage = null
                return
            }
            if (current != null && expandedOverPackage == null) expandedOverPackage = current
            switchPollHandler.postDelayed(this, APP_SWITCH_POLL_MS)
        }
    }

    /**
     * Is Homestead itself the app on screen right now?
     *
     * Asked of the system rather than trusting the appInForeground flag. That
     * flag is pushed by MainActivity.onStop/onResume, and this phone routinely
     * has SEVERAL MainActivity instances alive across different tasks (an
     * activity-recreation artifact). A stale instance's onStop then pushes
     * "false" milliseconds after the live one pushed "true", and the overlay
     * collapses to the dot while he is looking straight at Homestead.
     *
     * The usage-stats read cannot be raced that way: it reports whatever is
     * actually in front of him. Falls back to the flag if the read is
     * unavailable, so nothing gets worse when the permission is missing.
     */
    internal fun homesteadIsOnScreen(): Boolean {
        val fg = currentForegroundPackage() ?: return appInForeground
        return fg == packageName
    }

    /** Package name of whatever is on screen now, or null if we may not look. */
    private fun currentForegroundPackage(): String? {
        return try {
            val usm = getSystemService(Context.USAGE_STATS_SERVICE)
                as? android.app.usage.UsageStatsManager ?: return null
            val now = System.currentTimeMillis()
            // A short window: we only care what came forward most recently.
            val events = usm.queryEvents(now - 10_000L, now) ?: return null
            val ev = android.app.usage.UsageEvents.Event()
            var latest: String? = null
            while (events.hasNextEvent()) {
                events.getNextEvent(ev)
                if (ev.eventType == android.app.usage.UsageEvents.Event.MOVE_TO_FOREGROUND) {
                    latest = ev.packageName
                }
            }
            latest
        } catch (e: Exception) {
            Log.w(TAG, "foreground package read failed: ${e.message}")
            null
        }
    }

    /**
     * Watch what is actually on screen and keep the overlay's state honest.
     *
     * MainActivity's onStop/onResume cannot be trusted as the trigger here. This
     * phone keeps several MainActivity instances alive across tasks, so a stale
     * one pushes "false" at launch; the live one's later onStop then writes
     * false-over-false, the setter sees no change, and nothing re-evaluates —
     * which left the full cluster up after leaving the app.
     *
     * So the overlay owns its own signal. This poll compares the foreground
     * package against Homestead and applies the right state on every change:
     * NOTHING AT ALL when he is out with nothing recording, the cluster when he
     * is back. A live take is never touched.
     *
     * Runs only while idle — startRecording stops it, and it costs one cheap
     * usage-stats read a second.
     */
    private val foregroundWatchHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var lastSeenHomesteadOnScreen: Boolean? = null

    private val foregroundWatchRunnable = object : Runnable {
        override fun run() {
            if (::recorder.isInitialized) {
                // Compare against the FULL visibility answer, not just "is
                // Homestead on screen". The mode and the typing box can change
                // without an app switch, and this poll is the backstop that
                // catches any push from the Activity that went missing (it is
                // not bound yet, or a stale instance pushed over the live one).
                val visible = overlayShouldBeVisible()
                if (recorder.isRecording()) {
                    // A take owns the overlay: never collapse it, whatever app he
                    // is in. Still track where he is, so that when the take ends
                    // the next comparison is against the truth rather than
                    // against wherever he happened to be when it started.
                    lastSeenHomesteadOnScreen = visible
                } else if (lastSeenHomesteadOnScreen != visible) {
                    lastSeenHomesteadOnScreen = visible
                    if (visible) ensureOverlay().showIdle() else hideOverlay()
                }
            }
            foregroundWatchHandler.postDelayed(this, FOREGROUND_WATCH_MS)
        }
    }

    private fun startForegroundWatch() {
        foregroundWatchHandler.removeCallbacks(foregroundWatchRunnable)
        foregroundWatchHandler.postDelayed(foregroundWatchRunnable, FOREGROUND_WATCH_MS)
    }

    /** Begin watching for an app switch, having just expanded outside the app. */
    fun overlayExpandedOutsideApp() {
        switchPollHandler.removeCallbacks(switchPollRunnable)
        if (homesteadIsOnScreen()) return
        expandedOverPackage = currentForegroundPackage()
        switchPollHandler.postDelayed(switchPollRunnable, APP_SWITCH_POLL_MS)
    }

    /** Stop watching — collapsed again, or back inside Homestead. */
    private fun stopSwitchPolling() {
        switchPollHandler.removeCallbacks(switchPollRunnable)
        expandedOverPackage = null
    }

    private val overlayPollHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val overlayPollRunnable = object : Runnable {
        override fun run() {
            if (!::recorder.isInitialized || !recorder.isRecording()) return
            val targets = overlayTargets ?: return
            Thread {
                val t = try { targets() } catch (_: Exception) {
                    FloatingControls.QuickSendTargets("", "", "")
                }
                overlayPollHandler.post {
                    if (!recorder.isRecording()) return@post
                    // Re-label rather than rebuild — this is what keeps the send
                    // circles pointed at the card he is actually looking at.
                    overlay?.show(t.stewardGlyph, t.stewardColorHex, t.cardNumber, t.steadingBadge)
                    overlayPollHandler.postDelayed(this, OVERLAY_POLL_MS)
                }
            }.start()
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        recorder = AudioRecorder(this)
        // Raise the control surface as soon as the service exists. It is the one
        // and only set of buttons now, so it must not wait for him to leave the
        // app the way the old floating copy did.
        android.os.Handler(android.os.Looper.getMainLooper()).post { showOverlay() }
        // The overlay keeps its own eye on which app is in front — see
        // foregroundWatchRunnable for why the Activity's flag is not enough.
        startForegroundWatch()
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // Finalize rather than discard — same rule as teardown salvage.
                stopAndPersist()
                stopSelf()
            }
            else -> promoteToForeground()
        }
        // Do NOT restart with a null intent: a recreated service has no mic stream
        // and would just sit in the tray claiming to record.
        return START_NOT_STICKY
    }

    /** Has onCreate finished wiring the recorder? Guards the lateinit. */
    internal fun recorderReady(): Boolean = ::recorder.isInitialized

    /** True while audio is actually being captured. */
    fun isRecording(): Boolean = recorder.isRecording()

    /** Milliseconds since the current take started, or 0 when idle. */
    fun elapsedMs(): Long =
        if (recorder.isRecording() && startedAtMs > 0L) System.currentTimeMillis() - startedAtMs else 0L

    fun getAmplitude(): Int = recorder.getAmplitude()

    fun snapshotForPeek(): File? = recorder.snapshotForPeek()

    /**
     * Begin a take and pin the mic with a foreground notification. Returns the
     * file being written, or null if the recorder could not start.
     */
    fun startRecording(): File? {
        val file = recorder.startRecording()
        if (file != null) {
            startedAtMs = System.currentTimeMillis()
            acquireScreenLock()
            promoteToForeground()
            showOverlay()
        }
        return file
    }

    /**
     * Keep the display lit for this take.
     *
     * Idempotent: a second start without a stop reuses the existing lock rather
     * than stacking a second one. The lock is non-reference-counted for the same
     * reason — one take, one lock, and release() always fully releases.
     *
     * The timeout is a backstop, not the mechanism. Every exit path below
     * releases explicitly; this only bounds the damage if the process is killed
     * in a way that skips them, so a lost release can never become a phone that
     * never sleeps. Two hours is far longer than any real take.
     */
    private fun acquireScreenLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            val lock = screenLock ?: pm.newWakeLock(
                android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK,
                "homestead:recording"
            ).also {
                it.setReferenceCounted(false)
                screenLock = it
            }
            if (!lock.isHeld) {
                lock.acquire(SCREEN_LOCK_TIMEOUT_MS)
                Log.d(TAG, "Screen held on for the take")
            }
        } catch (e: Exception) {
            // A missing wake lock must never cost Josh the recording itself.
            Log.e(TAG, "Could not hold the screen on: ${e.message}", e)
        }
    }

    /**
     * Let the screen time out normally again.
     *
     * Called from EVERY path a take can end by — stop, cancel, the service dying
     * mid-take — because a wake lock that outlives its recording is a battery
     * bug, and the release path matters as much as the acquire.
     */
    private fun releaseScreenLock() {
        try {
            screenLock?.let {
                if (it.isHeld) {
                    it.release()
                    Log.d(TAG, "Screen released — normal timeout resumes")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not release the screen lock: ${e.message}", e)
        }
    }

    /** Finish a take and hand back the concatenated audio. */
    fun stopRecording(): File? {
        val file = recorder.stopRecording()
        startedAtMs = 0L
        releaseScreenLock()
        // Don't tear the overlay down — it drops back to keyboard+record, ready
        // for the next take. It is the permanent control surface now, so it is
        // never removed for being on one screen rather than another.
        overlayBackToIdle()
        demoteFromForeground()
        return file
    }

    /** Discard a take deliberately — this is the one path where deleting is correct. */
    fun cancelRecording() {
        recorder.cancelRecording()
        startedAtMs = 0L
        releaseScreenLock()
        overlayBackToIdle()
        demoteFromForeground()
    }

    /** A take ended: show the idle pair in-app, or leave a clean screen outside it. */
    private fun overlayBackToIdle() {
        overlayPollHandler.removeCallbacks(overlayPollRunnable)
        // Out of the app the window comes down entirely, which also stops the
        // app-switch poll. Called directly rather than from the post below:
        // hideOverlay marshals its own removeView to the main thread, and the
        // two removeCallbacks it does first are themselves thread-safe.
        if (!overlayShouldBeVisible()) {
            hideOverlay()
            return
        }
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            // A take just ended and he is looking at Homestead: the ordinary
            // idle pair, exactly as before.
            overlay?.showIdle()
        }
    }

    private fun stopAndPersist() {
        hideOverlay()
        // Before the early return: the lock must come down even when there was
        // no live take to salvage, or a stale lock outlives the service.
        releaseScreenLock()
        if (!recorder.isRecording()) return
        val salvaged = try {
            recorder.stopRecording()
        } catch (e: Exception) {
            Log.e(TAG, "Stop-and-persist failed: ${e.message}", e)
            null
        }
        startedAtMs = 0L
        if (salvaged != null && salvaged.exists() && salvaged.length() > 0L) {
            try {
                RecordingHistoryManager(this).save(salvaged)
                Log.d(TAG, "Persisted ${salvaged.length()} bytes from service stop")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to persist: ${e.message}", e)
            }
        }
    }

    private fun promoteToForeground() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    buildNotification(),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                )
            } else {
                startForeground(NOTIFICATION_ID, buildNotification())
            }
        } catch (e: Exception) {
            // A mic FGS can be refused (permission revoked, background-start limits).
            // Log it and keep going: in-app recording still works, only the
            // leave-the-app case is lost, and that is better than a crash.
            Log.e(TAG, "Could not start foreground: ${e.message}", e)
        }
    }

    private fun demoteFromForeground() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (e: Exception) {
            Log.w(TAG, "stopForeground failed: ${e.message}")
        }
    }

    private fun buildNotification(): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, RecordingService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, HomesteadApp.CHANNEL_RECORDING)
            .setContentTitle("Homestead is recording")
            .setContentText("Tap to come back — your take keeps running.")
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(openApp)
            .addAction(0, "Stop & save", stopIntent)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    /**
     * Raise the floating circles. Labels are resolved on a worker thread — the
     * supplier reaches into the presenter WebView, whose bridge deadlocks if
     * called from the main thread — then the window is added on the main thread,
     * which WindowManager requires.
     */
    /** Build the overlay on first use and keep the one instance wired. */
    private fun ensureOverlay(): QuickSendOverlay {
        overlay?.let { return it }
        val ov = QuickSendOverlay(this)
        ov.onSendSteward = { onOverlaySendSteward?.invoke() }
        ov.onSendCard = { onOverlaySendCard?.invoke() }
        ov.menuItems = overlayMenuItems
        // The menu opens HERE, in the overlay's own window. It used to call back
        // into the Activity, which anchored a PopupMenu on the retired in-app
        // rail — a view that prepareDetached never puts in a window, so the menu
        // could never appear and failed silently. Opening locally also means the
        // Activity no longer has to be foregrounded for the menu to work.
        ov.onLongPress = {
            if (!ov.showMenu()) {
                // Never let a hold produce nothing: fall back to the Activity
                // path so there is always SOMETHING, and say so in the log.
                Log.w(TAG, "overlay menu could not open — falling back to Activity")
                onOverlayLongPress?.invoke()
            }
        }
        ov.onRecordTap = { onOverlayRecordTap?.invoke() }
        ov.onKeyboardTap = { onOverlayKeyboardTap?.invoke() }
        ov.onReturnTap = { onOverlayReturnTap?.invoke() }
        // The service owns the take, so the timer reads straight off it — no
        // round trip to the Activity, which may not even exist out here.
        ov.elapsedMs = { elapsedMs() }
        // Watch for an app switch only while the controls are actually open out
        // there — see overlayExpandedOutsideApp.
        ov.onExpanded = { overlayExpandedOutsideApp() }
        ov.onCollapsed = { stopSwitchPolling() }
        overlay = ov
        return ov
    }

    /**
     * Bring the app up so it re-installs the overlay handlers.
     *
     * Only reached when the record handler turned out to be wired to a destroyed
     * MainActivity. Starting the service is enough: the app's normal startup
     * binds it and assigns fresh handlers. Deliberately NOT startActivity — that
     * would yank him out of the app he is in, and it is also what tore an
     * activity down during testing today.
     */
    internal fun startSelfForRewire() {
        try {
            val intent = Intent(this, RecordingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        } catch (e: Exception) {
            Log.w(TAG, "re-wire start failed: ${e.message}")
        }
    }

    /** Expose the overlay so the Activity can reset its position from the menu. */
    fun overlayResetPosition() {
        android.os.Handler(android.os.Looper.getMainLooper()).post { overlay?.resetPosition() }
    }

    fun overlayHasCustomPosition(): Boolean = overlay?.hasCustomPosition() ?: false

    /**
     * What the long-press menu should offer, supplied by the Activity.
     *
     * Held here rather than pushed straight at the overlay because the overlay
     * is built lazily — [ensureOverlay] re-applies this to whichever instance
     * exists, the same way the tap callbacks are wired.
     */
    var overlayMenuItems: (() -> List<Pair<String, () -> Unit>>)? = null
        set(value) { field = value; overlay?.menuItems = value }

    /** Close the long-press menu if it is up. */
    fun overlayDismissMenu() {
        android.os.Handler(android.os.Looper.getMainLooper()).post { overlay?.dismissMenu() }
    }

    /** Screen-space centre of the overlay's return button, for the mode reveal. */
    fun overlayReturnButtonCenter(): Pair<Int, Int>? = overlay?.returnButtonCenter()

    private fun showOverlay() {
        // IDLE: nothing recording. Whether the rail belongs on screen at all is
        // [overlayShouldBeVisible]'s single answer — see there for the three
        // conditions and why a take overrides them.
        if (!recorder.isRecording()) {
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                if (recorder.isRecording()) return@post
                // Josh 2026-09-06, after living with the peeking dot for a day:
                // "I need all things on the screen to be gone. A lot of websites
                // don't work if you have something on the screen." So when it is
                // not wanted there is NO window at all — not a collapsed one. He
                // starts the next take from the Quick Settings tile, which does
                // not need the overlay to exist.
                if (overlayShouldBeVisible()) ensureOverlay().showIdle()
                else hideOverlay()
            }
            return
        }

        // RECORDING: label the send circles for the current targets. Resolved on
        // a worker because the supplier reaches into the presenter WebView, whose
        // bridge deadlocks if called from the main thread.
        val targets = overlayTargets ?: return
        Thread {
            val t = try { targets() } catch (_: Exception) {
                FloatingControls.QuickSendTargets("", "", "")
            }
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                if (!recorder.isRecording()) {
                    // Take ended while we resolved — fall back rather than
                    // leaving stale send circles up. Same in/out-of-app split:
                    // the idle pair in the app, a clean screen outside it.
                    if (overlayShouldBeVisible()) ensureOverlay().showIdle()
                    else hideOverlay()
                    return@post
                }
                ensureOverlay().show(t.stewardGlyph, t.stewardColorHex, t.cardNumber, t.steadingBadge)
                startOverlayPolling()
            }
        }.start()
    }

    /**
     * Keep the floating circles pointed at the card that is showing NOW.
     *
     * Same fix as the in-app pair (Josh 2026-09-05): the labels used to be
     * resolved once at take-start and then freeze, so flipping to another card
     * mid-recording left the buttons aimed at the one he had left. show() is
     * safe to call repeatedly — it just re-labels an existing window.
     */
    private fun startOverlayPolling() {
        overlayPollHandler.removeCallbacks(overlayPollRunnable)
        overlayPollHandler.postDelayed(overlayPollRunnable, OVERLAY_POLL_MS)
    }

    private fun hideOverlay() {
        overlayPollHandler.removeCallbacks(overlayPollRunnable)
        stopSwitchPolling()
        val ov = overlay ?: return
        android.os.Handler(android.os.Looper.getMainLooper()).post { ov.hide() }
    }

    override fun onDestroy() {
        // Never let the service die holding un-saved audio, or leave a floating
        // window behind with nothing running underneath it.
        if (instance === this) instance = null
        foregroundWatchHandler.removeCallbacks(foregroundWatchRunnable)
        hideOverlay()
        stopAndPersist()
        super.onDestroy()
    }
}
