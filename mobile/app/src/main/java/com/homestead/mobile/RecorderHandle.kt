package com.homestead.mobile

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import java.io.File

/**
 * Keeps recording alive across screens and across leaving the app, without
 * rewriting the nineteen call sites in MainActivity.
 *
 * The mic has to live in a microphone-typed foreground service (Android 14 revokes
 * it from a non-visible app otherwise, and a backgrounded HOME launcher gets killed
 * for memory). But MainActivity talks to `audioRecorder` in a lot of places, and
 * churning all of them is how subtle recording bugs get introduced.
 *
 * So this exposes exactly the AudioRecorder surface MainActivity already calls and
 * forwards to RecordingService once bound. Binding is asynchronous, so there is a
 * fallback: until the service connects — or if the mic FGS is refused outright —
 * calls route to a local recorder, which is precisely the old behavior. Recording
 * therefore always works; the service upgrade only adds survival.
 *
 * Deliberately NOT a drop-in for cancel semantics: cancelRecording() still deletes,
 * because that is a user saying "throw this away". Only teardown salvages.
 */
class RecorderHandle(private val context: Context) {

    companion object {
        private const val TAG = "RecorderHandle"
    }

    private var service: RecordingService? = null
    private var bound = false

    /** Used until the service connects, and if it never does. */
    private val fallback = AudioRecorder(context)

    /**
     * Fires once the service is bound, reporting whether a take is already in
     * flight. Binding is async, so an Activity recreated mid-recording (rotation,
     * wallpaper change, returning after a kill) has a window where it does not yet
     * know the mic is live. Without this the controls would render idle over a
     * running take. Set before bind().
     */
    var onConnected: ((Boolean) -> Unit)? = null

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = (binder as? RecordingService.LocalBinder)?.service
            bound = true
            service?.let { wireOverlay(it) }
            val alreadyRecording = service?.isRecording() == true
            Log.d(TAG, "RecordingService bound (recording=$alreadyRecording)")
            onConnected?.invoke(alreadyRecording)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            // The mic is gone with it; fall back so the UI keeps functioning.
            service = null
            bound = false
            Log.w(TAG, "RecordingService disconnected")
        }
    }

    // Hooks handed straight to the service so its overlay can label itself and
    // send. These are assigned LATER in onCreate than bind() is called, so each
    // setter re-pushes to an already-connected service — otherwise a fast bind
    // wires nulls and the overlay silently never appears.
    var overlayTargets: (() -> FloatingControls.QuickSendTargets)? = null
        set(value) { field = value; service?.overlayTargets = value }
    var onOverlaySendSteward: (() -> Unit)? = null
        set(value) { field = value; service?.onOverlaySendSteward = value }
    var onOverlaySendCard: (() -> Unit)? = null
        set(value) { field = value; service?.onOverlaySendCard = value }
    var onOverlayLongPress: (() -> Unit)? = null
        set(value) { field = value; service?.onOverlayLongPress = value }
    var onOverlayRecordTap: (() -> Unit)? = null
        set(value) { field = value; service?.onOverlayRecordTap = value }
    var onOverlayKeyboardTap: (() -> Unit)? = null
        set(value) { field = value; service?.onOverlayKeyboardTap = value }
    var onOverlayReturnTap: (() -> Unit)? = null
        set(value) { field = value; service?.onOverlayReturnTap = value }
    /** Rows for the overlay's long-press menu, owned by the Activity. */
    var overlayMenuItems: (() -> List<Pair<String, () -> Unit>>)? = null
        set(value) { field = value; service?.overlayMenuItems = value }

    private fun wireOverlay(svc: RecordingService) {
        // Re-assert these FIRST: they decide whether the rail is on screen at
        // all, and a late bind would otherwise leave the service on stale values
        // from the last run.
        svc.appInForeground = appInForeground
        svc.homesteadModeShowing = homesteadModeShowing
        svc.keyboardShowing = keyboardShowing
        svc.overlayTargets = overlayTargets
        svc.onOverlaySendSteward = onOverlaySendSteward
        svc.onOverlaySendCard = onOverlaySendCard
        svc.onOverlayLongPress = onOverlayLongPress
        svc.onOverlayRecordTap = onOverlayRecordTap
        svc.onOverlayKeyboardTap = onOverlayKeyboardTap
        svc.onOverlayReturnTap = onOverlayReturnTap
        svc.overlayMenuItems = overlayMenuItems
    }

    /** Close the overlay's long-press menu if it is up. */
    fun overlayDismissMenu() { service?.overlayDismissMenu() }

    /** Put the floating pair back at its default spot. */
    fun overlayResetPosition() { service?.overlayResetPosition() }

    fun overlayHasCustomPosition(): Boolean = service?.overlayHasCustomPosition() ?: false

    /** Screen-space centre of the overlay's return button, for the mode reveal. */
    fun overlayReturnButtonCenter(): Pair<Int, Int>? = service?.overlayReturnButtonCenter()

    fun bind() {
        if (bound) return
        try {
            val intent = Intent(context, RecordingService::class.java)
            context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
        } catch (e: Exception) {
            Log.e(TAG, "bindService failed, using in-process recorder: ${e.message}", e)
        }
    }

    /**
     * Whether Homestead is on screen. Remembered here as well as pushed, because
     * onResume can run BEFORE the service finishes binding — in which case the
     * push lands on a null service and is lost. The service then keeps whatever
     * the previous instance left behind (false, from the last onStop) and shows
     * the collapsed dot inside the app, where Josh wants the full buttons.
     *
     * Same re-push pattern as the overlay hooks above: hold the value, and apply
     * it again the moment a service actually connects.
     */
    private var appInForeground: Boolean = true

    /** Tell the service whether Homestead is on screen, so the floating circles
     *  only appear once he has actually left the app. */
    fun setAppInForeground(inForeground: Boolean) {
        appInForeground = inForeground
        service?.appInForeground = inForeground
    }

    /**
     * Which side of the launcher is showing, and whether the typing box is up.
     *
     * Held here as well as pushed, for the same reason as [appInForeground]: the
     * Activity reports these during startup and mode switches, which can run
     * BEFORE the bind completes, and a push onto a null service is simply lost.
     * [wireOverlay] replays both the moment a service connects.
     *
     * Defaults match a fresh launch — Homestead side up, no keyboard — so the
     * rail is visible during the window before the Activity has reported.
     */
    private var homesteadModeShowing: Boolean = true
    private var keyboardShowing: Boolean = false

    /** Homestead side of the launcher up (true) or the phone side (false). */
    fun setHomesteadModeShowing(showing: Boolean) {
        homesteadModeShowing = showing
        service?.homesteadModeShowing = showing
    }

    /** The native Android keyboard is up (true) or down (false). */
    fun setKeyboardShowing(showing: Boolean) {
        keyboardShowing = showing
        service?.keyboardShowing = showing
    }

    fun unbind() {
        if (!bound) return
        try {
            context.unbindService(connection)
        } catch (e: Exception) {
            Log.w(TAG, "unbindService failed: ${e.message}")
        }
        bound = false
        service = null
    }

    /**
     * Start a take. Starts the service first so the mic is held by a foreground
     * service rather than by the Activity — that is the part that survives Joshua
     * leaving Homestead.
     */
    fun startRecording(): File? {
        val svc = service
        if (svc != null) {
            try {
                context.startForegroundService(
                    Intent(context, RecordingService::class.java)
                        .setAction(RecordingService.ACTION_START)
                )
            } catch (e: Exception) {
                Log.w(TAG, "startForegroundService refused: ${e.message}")
            }
            return svc.startRecording()
        }
        // Not bound yet — record locally and bind for next time.
        bind()
        return fallback.startRecording()
    }

    fun stopRecording(): File? =
        service?.stopRecording() ?: fallback.stopRecording()

    fun cancelRecording() {
        service?.cancelRecording() ?: fallback.cancelRecording()
    }

    fun snapshotForPeek(): File? =
        service?.snapshotForPeek() ?: fallback.snapshotForPeek()

    fun isRecording(): Boolean =
        service?.isRecording() ?: fallback.isRecording()

    fun getAmplitude(): Int =
        service?.getAmplitude() ?: fallback.getAmplitude()

    /**
     * Activity teardown. The service keeps any in-flight take — that is the whole
     * point — so only the fallback recorder needs salvaging here. Returns audio
     * that would otherwise have been deleted, or null.
     */
    fun destroy(): File? {
        val salvaged = if (service == null) fallback.destroy() else null
        unbind()
        return salvaged
    }
}
