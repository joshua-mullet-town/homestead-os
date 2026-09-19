package com.homestead.mobile

import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log

/**
 * Quick Settings tile that STARTS A RECORDING from anywhere.
 *
 * Josh 2026-09-06, after trying a tile that merely revealed the buttons: "how
 * often do I actually want the buttons to be revealed? Probably not a ton…
 * What I really am going for is a settings tile that if I click it, it would
 * just literally start as if there was actually a recording starting. Period.
 * Like as if I had clicked the recording button."
 *
 * So one tap from the shade begins a take, wherever he is. The floating
 * controls come up as a CONSEQUENCE, not as the goal — a live take already
 * shows the full cluster over every app, so he lands exactly where he wants:
 * recording, with the send buttons in front of him.
 *
 * It is a real toggle, because a recording is a real state: tap to start, tap
 * again to cancel, and the tile reflects which it is. That is the same pairing
 * the floating record button has, so the two cannot disagree.
 *
 * The peek dot stays as the way to reach the controls WITHOUT recording.
 */
class HomesteadTileService : TileService() {

    companion object {
        private const val TAG = "HomesteadTile"
    }

    override fun onStartListening() {
        super.onStartListening()
        refreshTile()
    }

    /**
     * Show whether a take is running, so the shade tells the truth at a glance
     * and a second tap is obviously "stop" rather than a mystery.
     */
    private fun refreshTile() {
        val recording = RecordingService.isRecordingNow()
        qsTile?.apply {
            state = if (recording) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
            label = getString(if (recording) R.string.tile_label_recording else R.string.tile_label)
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()

        // Fire the very same handler the floating record button fires. Normal
        // case, since the service starts with the app.
        if (RecordingService.toggleRecordingFromOutside()) {
            collapseShadeSoHeCanSeeIt()
            // Let the take actually begin before re-reading the state, or the
            // tile would redraw with the old value and look like nothing
            // happened.
            qsTile?.let {
                android.os.Handler(android.os.Looper.getMainLooper())
                    .postDelayed({ refreshTile() }, 400)
            }
            return
        }

        // No service, or no handler installed yet because the Activity has never
        // run in this process. Start it; MainActivity wires the record handler on
        // launch, and the control surface comes up with it. This is rare — the
        // app binds the service with BIND_AUTO_CREATE at launch — so it is a
        // safety net rather than a path he will normally travel.
        Log.d(TAG, "No recording handler available — starting the app's service")
        try {
            val intent = Intent(this, RecordingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            collapseShadeSoHeCanSeeIt()
        } catch (e: Exception) {
            Log.e(TAG, "Could not start RecordingService: ${e.message}", e)
        }
    }

    /**
     * Close the Quick Settings shade.
     *
     * Without this the controls come up UNDERNEATH the shade he just pulled
     * down, so the tap looks like it did nothing until he swipes away — the
     * same "I pressed it and nothing happened" that sent him here in the first
     * place.
     *
     * Deliberately NOT startActivityAndCollapse: that would launch Homestead
     * and yank him out of whatever app he is in, which is the exact opposite of
     * what these floating controls are for. This closes the shade and leaves him
     * where he was, with the controls now on top.
     */
    private fun collapseShadeSoHeCanSeeIt() {
        // The accessibility service can close the shade properly. Android 12+
        // ignores ACTION_CLOSE_SYSTEM_DIALOGS from ordinary apps, so this is the
        // route that actually works on his phone.
        val acc = HomesteadAccessibilityService.instance
        if (acc != null) {
            try {
                acc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                return
            } catch (e: Exception) {
                Log.w(TAG, "Accessibility collapse failed: ${e.message}")
            }
        }
        // No accessibility service: the shade stays up until he swipes it away,
        // and the controls are waiting underneath. Not ideal, but the tap still
        // did its job — better than dragging him into Homestead to tidy up.
        Log.d(TAG, "No accessibility service — shade left for him to dismiss")
    }
}
