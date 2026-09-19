package com.homestead.mobile

import android.animation.ValueAnimator
import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.constraintlayout.widget.ConstraintLayout

enum class NavButton { HOME, WORKBENCH, PRESENTER, APPS }
enum class MicAction {
    SEND_TO_STEWARD,  // target = steward session name or build session name
    CANCEL
}

class FloatingControls(private val activity: Activity) {

    // Colors
    private val colorOrange = Color.parseColor("#FF6600")
    private val colorAmber = Color.parseColor("#FFBF00")
    private val colorCyan = Color.parseColor("#00CCFF")
    private val colorSurface = Color.parseColor("#1A1A1A")
    private val colorBackground = Color.parseColor("#0D0D0D")
    private val colorBorder = Color.parseColor("#2A2A2A")
    private val colorRed = Color.parseColor("#FF3333")
    private val colorTextDim = Color.parseColor("#888888")

    private val dp = activity.resources.displayMetrics.density

    /** Both buttons are the same size — they are peers, not primary+secondary. */
    private val BUTTON_DP = (BUTTON_SIZE_DP * dp).toInt()
    private val GAP_DP = (12 * dp).toInt()

    // Views
    private lateinit var rightCluster: FrameLayout
    private lateinit var micButton: FrameLayout
    private lateinit var micIcon: TextView
    private lateinit var micGlow: View
    private lateinit var keyboardButton: FrameLayout
    /** The mode switch — a third, smaller button above the pair. */
    private lateinit var appsButton: FrameLayout
    private var appsIcon: TextView? = null
    private var phoneModeActive: Boolean = false
    private lateinit var recordingTimerView: TextView
    private lateinit var quickSendRow: LinearLayout
    private lateinit var quickSendStewardButton: TextView
    private lateinit var quickSendSteadingBadge: TextView
    private lateinit var quickSendCardButton: TextView
    /** Record + keyboard. Swapped out for [quickSendRow] while a take is live. */
    private lateinit var idleRow: LinearLayout
    // Destination picker
    private lateinit var destScroll: ScrollView
    private lateinit var destContainer: LinearLayout
    private var destVisible = false

    // Recording timer
    private var recordingStartTime = 0L
    private val timerHandler = Handler(Looper.getMainLooper())
    private val timerTickRunnable = object : Runnable {
        override fun run() {
            if (recordingStartTime > 0) {
                val elapsed = System.currentTimeMillis() - recordingStartTime
                val secs = (elapsed / 1000).toInt()
                val mins = secs / 60
                val s = secs % 60
                recordingTimerView.text = String.format("%d:%02d", mins, s)
                timerHandler.postDelayed(this, 200)
            }
        }
    }

    // Mic tap state
    private var isMicTapDown = false
    private var micLongPressFired = false
    private val micLongPressHandler = Handler(Looper.getMainLooper())

    // Send-circle tap state — same shape as the mic's, so both share the gesture.
    private var isSendTapDown = false
    private var sendLongPressFired = false
    private val sendLongPressHandler = Handler(Looper.getMainLooper())

    /** True when neither send target resolved, so the left circle is a stop button. */
    private var noSendTarget = false

    // ── MOVE MODE (Josh 2026-09-05) ──
    // "Is there any way we could have a way to move them… with a long hold and
    // then I can move, and then they go into a kind of move mode, and then I
    // also have the opportunity to easily reset it."
    //
    // Split by SIDE, which is how he settled it: "only holding the recording
    // button and moving it, like the right button, that's the one that should be
    // able to drag. And then all the menu item options should be a long hold of
    // the left hand button." So the RIGHT button's hold is the move and nothing
    // else, and the LEFT button's hold is the menu and nothing else — no gesture
    // has to be disambiguated by what happens after it.
    private var moveMode = false
    /** Offset from the resting position, in pixels. (0,0) is the default spot. */
    private var offsetX = 0f
    private var offsetY = 0f
    private var dragStartRawX = 0f
    private var dragStartRawY = 0f
    private var dragOriginX = 0f
    private var dragOriginY = 0f
    /** Set once a hold has lasted long enough that a drag would count as a move. */
    private var dragArmed = false

    private val prefs = activity.getSharedPreferences("homestead_controls", Activity.MODE_PRIVATE)

    // Live re-targeting of the send circles while a take is running.
    private val targetPollHandler = Handler(Looper.getMainLooper())
    private val targetPollRunnable = object : Runnable {
        override fun run() {
            if (!isRecording) return
            refreshQuickSendTargets()
            targetPollHandler.postDelayed(this, TARGET_POLL_MS)
        }
    }

    // Undo-send bar
    private lateinit var undoBarContainer: LinearLayout
    private var undoBarVisible = false
    private var undoTimer: Runnable? = null
    private val undoHandler = Handler(Looper.getMainLooper())
    private val UNDO_DELAY_MS = 3000L

    // Recording animation
    private var recordingAnimator: ValueAnimator? = null
    private var recordingPulseValue = 0f


    // Callbacks
    var onNavClick: ((NavButton) -> Unit)? = null
    var onMicGesture: ((MicAction) -> Unit)? = null
    var onMicGestureWithTarget: ((MicAction, String) -> Unit)? = null
    var onRecordingStart: (() -> Unit)? = null
    var onKeyboardTap: (() -> Unit)? = null
    var onHistoryTap: (() -> Unit)? = null
    var onAppsTap: (() -> Unit)? = null
    var onTrackpadTap: (() -> Unit)? = null
    /** Long-press the LEFT button — opens the menu (cancel, history, mouse, reset). */
    var onSendLongPress: (() -> Unit)? = null
    /** A hold passed the threshold — buzz, so the menu or the drag is not a surprise. */
    var onLongPressArmed: (() -> Unit)? = null
    /** Move mode entered/left, so the Activity can hold off on its swipe handling. */
    var onMoveModeChanged: ((Boolean) -> Unit)? = null
    var onFetchStewards: ((callback: (List<StewardInfo>) -> Unit) -> Unit)? = null
    var onCancelRecording: (() -> Unit)? = null
    var onPeekTranscription: (() -> Unit)? = null
    var onUndoSend: (() -> Unit)? = null
    var onConfirmSend: ((MicAction, String?) -> Unit)? = null
    var onRecordingStateChanged: ((isRecording: Boolean) -> Unit)? = null
    /** Quick-send: fire the in-flight take at the presenter's selected steward. */
    var onQuickSendSteward: (() -> Unit)? = null
    /** Quick-send: fire the in-flight take at the presenter's active card. */
    var onQuickSendCard: (() -> Unit)? = null
    /** Quick-send targets for the two send circles.
     *
     *  On a top-level steward: [stewardGlyph] is that steward's emoji and
     *  [steadingBadge] is empty — the circle renders exactly as it always has.
     *
     *  On a WORKER (Josh 2026-09-10): [stewardGlyph] is the worker's first two
     *  letters (the big element) and [steadingBadge] is the STEADING's emoji,
     *  drawn small and attached at the circle's corner — "that way I can know
     *  which setting I'm in, and then the actual first two letters will tell me
     *  which worker I'm associated to."
     *
     *  Empty [stewardGlyph]/[cardNumber] hide the corresponding circle. */
    data class QuickSendTargets(
        val stewardGlyph: String,
        val stewardColorHex: String,
        val cardNumber: String,
        val steadingBadge: String = ""
    )
    var onFetchQuickSendTargets: (() -> QuickSendTargets)? = null

    data class SubstewardInfo(
        val sessionName: String,
        val name: String,
        val shorthand: String,
        val icon: String?,
        val color: String
    )
    data class StewardInfo(
        val sessionName: String,
        val name: String,
        val project: String,
        val shorthand: String,
        val icon: String?,
        val color: String,
        val substewards: List<SubstewardInfo>
    )

    // Persist which stewards are expanded across picker opens
    private val expandedStewards = mutableSetOf<String>()

    // State
    var isRecording: Boolean = false
        set(value) {
            val changed = field != value
            field = value
            updateMicVisuals()
            if (value) {
                startRecordingPulse()
                startRecordingTimer()
                keepScreenOn(true)
                showSendButtons(true)
                refreshQuickSendTargets()
                startTargetPolling()
                setActiveOpacity(true)
            } else {
                stopRecordingPulse()
                stopRecordingTimer()
                keepScreenOn(false)
                stopTargetPolling()
                showSendButtons(false)
                if (!destVisible) setActiveOpacity(false)
            }
            if (changed) onRecordingStateChanged?.invoke(value)
        }

    var audioLevel: Float = 0f
        set(value) {
            field = value.coerceIn(0f, 1f)
            updateMicPulse()
        }

    var sessionLabel: String? = null

    var activeNav: NavButton = NavButton.HOME

    private val idleAlpha = 0.5f
    private val activeAlpha = 1.0f

    fun attach(activity: Activity, rootLayout: ConstraintLayout) {
        buildRightCluster()
        rootLayout.addView(rightCluster)
        rightCluster.alpha = idleAlpha
        // Put the pair back wherever Josh last dragged it. Deferred to a post so
        // the cluster has been measured — clamping needs real widths.
        rightCluster.post { restoreOffset() }
    }

    /**
     * Build the views WITHOUT putting the buttons on screen.
     *
     * The in-app button pair is retired (Josh 2026-09-05 — the floating overlay
     * is the single control surface now), but this class is more than its
     * buttons: the destination picker, the undo-send bar and the recording-state
     * plumbing are all still live and still called from MainActivity. Those are
     * `lateinit`, so simply skipping the build would turn every one of those
     * calls into a crash.
     *
     * So the hierarchy is still constructed — only the CLUSTER is left out of the
     * window, and the two overlays that must still be visible are attached on
     * their own. Cheap, and it keeps one code path instead of scattering
     * isInitialized guards through the class.
     */
    fun prepareDetached(rootLayout: ConstraintLayout) {
        buildRightCluster()
        // The picker and the undo bar are built as children of the cluster; pull
        // them out so they can be shown on their own without dragging the
        // retired buttons back on screen with them.
        (destScroll.parent as? android.view.ViewGroup)?.removeView(destScroll)
        (undoBarContainer.parent as? android.view.ViewGroup)?.removeView(undoBarContainer)

        val pickerParams = ConstraintLayout.LayoutParams(
            ConstraintLayout.LayoutParams.WRAP_CONTENT,
            ConstraintLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
            bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
            marginEnd = (16 * dp).toInt()
            bottomMargin = (90 * dp).toInt()
        }
        destScroll.layoutParams = pickerParams
        destScroll.elevation = 12 * dp
        rootLayout.addView(destScroll)

        val undoParams = ConstraintLayout.LayoutParams(
            ConstraintLayout.LayoutParams.WRAP_CONTENT,
            ConstraintLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            startToStart = ConstraintLayout.LayoutParams.PARENT_ID
            endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
            bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
            bottomMargin = (90 * dp).toInt()
        }
        undoBarContainer.layoutParams = undoParams
        undoBarContainer.elevation = 12 * dp
        rootLayout.addView(undoBarContainer)
    }

    private fun setActiveOpacity(active: Boolean) {
        if (!::rightCluster.isInitialized) return
        val target = if (active) activeAlpha else idleAlpha
        rightCluster.animate().alpha(target).setDuration(150).start()
    }

    // ── MOVE MODE ──

    /** Re-apply the saved position. Called once the cluster has been laid out. */
    private fun restoreOffset() {
        offsetX = prefs.getFloat(KEY_OFFSET_X, 0f)
        offsetY = prefs.getFloat(KEY_OFFSET_Y, 0f)
        // Re-clamp on the way in, not just while dragging. A saved offset was
        // valid for the screen it was made on; a rotation or a resized window
        // could otherwise restore the pair somewhere off-screen, where the reset
        // that would fix it is itself unreachable.
        clampOffset()
        applyOffset()
    }

    private fun applyOffset() {
        if (!::rightCluster.isInitialized) return
        rightCluster.translationX = offsetX
        rightCluster.translationY = offsetY
    }

    private fun saveOffset() {
        prefs.edit().putFloat(KEY_OFFSET_X, offsetX).putFloat(KEY_OFFSET_Y, offsetY).apply()
    }

    /** Has Josh moved the pair off its default spot? Drives the reset menu item. */
    fun hasCustomPosition(): Boolean = offsetX != 0f || offsetY != 0f

    /**
     * Put the pair back where it started.
     *
     * Josh asked for the reset to be as easy as the move ("I also have the
     * opportunity to easily reset it… from wherever it's at"), so this is a
     * standing item in the send menu whenever the pair has been moved — he never
     * has to drag it back by hand or hunt for the original spot.
     */
    fun resetPosition() {
        offsetX = 0f
        offsetY = 0f
        saveOffset()
        if (!::rightCluster.isInitialized) return
        rightCluster.animate()
            .translationX(0f).translationY(0f)
            .setDuration(220)
            .setInterpolator(android.view.animation.OvershootInterpolator(1.4f))
            .start()
    }

    private fun enterMoveMode() {
        if (moveMode) return
        moveMode = true
        onMoveModeChanged?.invoke(true)
        // Lift and brighten so it is obvious the pair is now attached to the
        // finger rather than sitting where it lives.
        rightCluster.animate().alpha(1f).scaleX(1.08f).scaleY(1.08f).setDuration(120).start()
    }

    private fun exitMoveMode() {
        if (!moveMode) return
        moveMode = false
        dragArmed = false
        saveOffset()
        onMoveModeChanged?.invoke(false)
        rightCluster.animate()
            .alpha(if (isRecording || destVisible) activeAlpha else idleAlpha)
            .scaleX(1f).scaleY(1f).setDuration(150).start()
    }

    /**
     * Keep the pair on screen.
     *
     * Without this a drag could park it past an edge where it is unreachable —
     * and since the position persists, it would still be gone on next launch.
     * The reset menu item would technically still save him, but only if he can
     * find a button to long-press, so the real fix is never letting it leave.
     */
    private fun clampOffset() {
        val parent = rightCluster.parent as? View ?: return
        val row = if (::idleRow.isInitialized && idleRow.visibility == View.VISIBLE) idleRow
            else quickSendRow
        if (row.width == 0) return

        // Both the row's position AND the bounds must be in the SAME space, so
        // measure the row relative to the parent rather than the screen — screen
        // coordinates include the status bar, which the parent's height does
        // not, and mixing the two skews the vertical clamp by that much.
        val rowLoc = IntArray(2)
        val parentLoc = IntArray(2)
        row.getLocationOnScreen(rowLoc)
        parent.getLocationOnScreen(parentLoc)
        // Where the row sits with the offset already applied — back it out to get
        // the resting position, then work out how far it may travel from there.
        val restLeft = (rowLoc[0] - parentLoc[0]) - offsetX
        val restTop = (rowLoc[1] - parentLoc[1]) - offsetY
        val margin = MIN_ON_SCREEN_DP * dp

        val minX = -restLeft - row.width + margin
        val maxX = parent.width - restLeft - margin
        val minY = -restTop - row.height + margin
        val maxY = parent.height - restTop - margin

        offsetX = offsetX.coerceIn(minX, maxX)
        offsetY = offsetY.coerceIn(minY, maxY)
    }

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun buildRightCluster() {
        val margin = (16 * dp).toInt()

        rightCluster = FrameLayout(activity).apply {
            layoutParams = ConstraintLayout.LayoutParams(
                ConstraintLayout.LayoutParams.MATCH_PARENT,
                ConstraintLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                // BOTTOM-anchored, not vertically centred. The old cluster was a
                // tall column so it was centred on the right edge; the pair has
                // to sit ON the web page's own send-pill line instead (Josh
                // 2026-09-05: "about where the web page's two send buttons are…
                // they're allowed to cover the web ones"). Constraining top AND
                // bottom is what centres it, so top is deliberately not set.
                bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
                startToStart = ConstraintLayout.LayoutParams.PARENT_ID
                endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
                // Measured against the live web pill on Josh's Pixel 9a: its
                // centre sits ~69dp up, so a 56dp button needs ~41dp of margin
                // to land its own centre on the same line.
                bottomMargin = ((PILL_LINE_DP - BUTTON_SIZE_DP / 2f) * dp).toInt()
            }
            elevation = 8 * dp
        }

        val innerLayout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.END
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
        }

        // ── BUILD MIC BUTTON ──
        // Josh 2026-09-05: the whole rail collapses to TWO buttons, sized and
        // placed where the web page's own send pill sits, because they have to
        // follow him off this screen (Chrome) and the web ones cannot.
        val micSize = BUTTON_DP
        micButton = FrameLayout(activity).apply {
            layoutParams = LinearLayout.LayoutParams(micSize, micSize)
        }

        micGlow = View(activity).apply {
            val glowBg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.argb(60, 0xFF, 0x66, 0x00))
            }
            background = glowBg
            layoutParams = FrameLayout.LayoutParams(micSize, micSize)
        }
        micButton.addView(micGlow)

        val micFace = View(activity).apply {
            val faceBg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(colorOrange)
            }
            background = faceBg
            tag = faceBg
            layoutParams = FrameLayout.LayoutParams(micSize, micSize)
        }
        micButton.addView(micFace)

        micIcon = TextView(activity).apply {
            text = "\uD83C\uDFA4"  // 🎤
            textSize = 22f
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        micButton.addView(micIcon)

        micButton.setOnTouchListener { _, event ->
            handleMicTouch(event)
            true
        }

        // ── BUILD KEYBOARD BUTTON ──
        // Same size as the mic now — they are peers in a two-button row, not a
        // primary and a secondary in a stack.
        val kbSize = BUTTON_DP
        keyboardButton = FrameLayout(activity).apply {
            layoutParams = LinearLayout.LayoutParams(kbSize, kbSize)
            isClickable = true
            isFocusable = true
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(colorSurface)
                setStroke((2 * dp).toInt(), colorAmber)
            }
            background = bg
            // The LEFT button: tap types, hold opens the menu. It does not drag
            // — that belongs to the record button on the right. This is also
            // where the reset is reached from while idle.
            setOnTouchListener { _, event ->
                handleLeftButtonTouch(event) { onKeyboardTap?.invoke() }
                true
            }
        }
        val kbIcon = TextView(activity).apply {
            text = "⌨"
            textSize = 20f
            setTextColor(colorAmber)
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        keyboardButton.addView(kbIcon)

        // History, Apps (mode switch) and Trackpad buttons are GONE (Josh
        // 2026-09-05). Their jobs moved onto gestures and the send menu:
        //   • mode switch  → vertical swipe (up = Homestead, down = phone)
        //   • trackpad     → long-press the record button
        //   • history      → the send-menu (long-press a send circle)
        // Their callbacks are still declared and still fired from those new
        // entry points, so MainActivity's handlers did not have to move.

        // ── RECORDING TIMER ──
        recordingTimerView = TextView(activity).apply {
            textSize = 14f
            setTextColor(colorRed)
            typeface = Typeface.MONOSPACE
            gravity = Gravity.CENTER
            text = "0:00"
            val timerBg = GradientDrawable().apply {
                setColor(Color.argb(200, 0x1A, 0x1A, 0x1A))
                cornerRadius = 8 * dp
            }
            background = timerBg
            setPadding((10 * dp).toInt(), (4 * dp).toInt(), (10 * dp).toInt(), (4 * dp).toInt())
            visibility = View.GONE
        }

        // ── SEND CIRCLES (Josh 2026-09-04, re-sited 2026-09-05) ──
        // Cancel and Peek are no longer standing buttons either — both are items
        // in the send menu now (long-press a circle). Josh was explicit that
        // cancel is TWO steps: "you hold it and then a menu pops up and one of
        // those menu items is cancel current recording" — never a long-press
        // that cancels outright.
        //
        // These are not an extra row any more. They occupy the SAME two slots as
        // record + keyboard: start a take and the two idle buttons BECOME the
        // steward-icon and card-number send buttons, matching the web pill.
        quickSendStewardButton = TextView(activity).apply {
            textSize = 22f
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = true
            visibility = View.GONE
            // Tap/hold/drag all arrive through one handler so the send circles
            // can be moved by exactly the same gesture as the record button.
            setOnTouchListener { _, event ->
                handleLeftButtonTouch(event) {
                    // In the no-target fallback this circle is a plain stop
                    // button, not a send — sending would have nowhere to go.
                    if (noSendTarget) onMicGesture?.invoke(MicAction.CANCEL)
                    else onQuickSendSteward?.invoke()
                }
                true
            }
        }

        quickSendCardButton = TextView(activity).apply {
            textSize = 20f
            setTextColor(colorAmber)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = true
            visibility = View.GONE
            background = circleBackground(colorAmber)
            // RIGHT-hand circle while recording, so by Josh's rule it is the
            // drag handle: hold-and-drag moves the pair, tap still sends to the
            // card. Its hold opens no menu — that is the left circle's job.
            setOnTouchListener { _, event ->
                handleRightButtonTouch(event) { onQuickSendCard?.invoke() }
                true
            }
        }

        quickSendRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            visibility = View.GONE
        }
        // WORKER corner badge (Josh 2026-09-10). On a worker the steward circle
        // shows the worker's two letters, and the STEADING's emoji rides along
        // as a small badge pinned to the circle's top-right corner. It is a
        // sibling in a FrameLayout rather than part of the button's own text so
        // it can actually sit at the corner — and it takes no touches, so the
        // whole circle stays one send target.
        quickSendSteadingBadge = TextView(activity).apply {
            textSize = 11f
            gravity = Gravity.CENTER
            visibility = View.GONE
            isClickable = false
            isFocusable = false
        }
        val stewardSlot = FrameLayout(activity).apply {
            // The badge overhangs the circle slightly; let it draw outside.
            clipChildren = false
            clipToPadding = false
            // FIXED SIZE, not WRAP_CONTENT. Josh 2026-09-11 saw "this big old
            // gap" open up between the keyboard and record buttons whenever he
            // was not recording — and read it exactly right as "the width of the
            // previous menu". It was neither the menu nor the retired code: a
            // wrap-content slot MEASURES its badge child, so a visible badge made
            // this slot wider than the 56dp circle. That extra width travelled up
            // through quickSendRow into the FrameLayout both rows share, and that
            // parent sizes to its widest child — so the hidden recording row was
            // still inflating the cell the idle pair sits in. It closed up again
            // during a take because the wide row was then the visible one.
            //
            // Pinning the slot to the circle's own size keeps the badge purely
            // decorative: it still draws past the edge (clipChildren=false above)
            // but contributes no measured width to anything.
            layoutParams = FrameLayout.LayoutParams(BUTTON_DP, BUTTON_DP)
            addView(quickSendStewardButton, FrameLayout.LayoutParams(BUTTON_DP, BUTTON_DP))
            addView(quickSendSteadingBadge, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.END or Gravity.TOP
                // Negative margins park the badge ON the circle's corner without
                // asking the parent for room to hold it.
                marginEnd = (-3 * dp).toInt()
                topMargin = (-3 * dp).toInt()
            })
        }

        // Steward first, then card — same left-to-right order as the web pill.
        quickSendRow.clipChildren = false
        quickSendRow.clipToPadding = false
        quickSendRow.addView(stewardSlot, LinearLayout.LayoutParams(BUTTON_DP, BUTTON_DP).apply {
            rightMargin = GAP_DP
        })
        quickSendRow.addView(quickSendCardButton, LinearLayout.LayoutParams(BUTTON_DP, BUTTON_DP))

        // ── DESTINATION PICKER ──
        buildDestinationPicker()
        destScroll.visibility = View.GONE

        // ── UNDO BAR ──
        buildUndoBar()
        undoBarContainer.visibility = View.GONE

        // ── MODE BUTTON (back, Josh 2026-09-05) ──
        // The swipe that replaced this was double-booked: vertical swipes
        // already scroll cards, so the same motion meant two things. His call:
        // "right above the buttons, those two at the bottom, we just have a
        // third little button that does exactly what it was doing today, where
        // it was just transitioning between the two screens really beautifully."
        // Same 36dp size, same glyph flip, same circular reveal as before.
        val modeSize = (36 * dp).toInt()
        appsButton = FrameLayout(activity).apply {
            layoutParams = LinearLayout.LayoutParams(modeSize, modeSize)
            isClickable = true
            isFocusable = true
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#252525"))
                setStroke((2f * dp).toInt(), Color.parseColor("#555555"))
            }
            background = bg
            elevation = 3 * dp
            setOnClickListener { onAppsTap?.invoke() }
        }
        // The glyph reflects the mode you'd switch TO, not the one you're in —
        // a button should advertise its destination. Homestead mode shows the
        // grid (tap for the phone screen); Phone mode shows the house.
        appsIcon = TextView(activity).apply {
            text = if (phoneModeActive) GLYPH_HOMESTEAD else GLYPH_PHONE
            textSize = 18f
            setTextColor(Color.parseColor("#DDDDDD"))
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        appsButton.addView(appsIcon)

        // ── THE TWO BUTTONS: one horizontal row, bottom-right ──
        // Josh 2026-09-05: "two buttons, about where the web page's two send
        // buttons are… they're allowed to cover the web ones, those are
        // redundant anyway." So: horizontal, right-aligned, sitting on the web
        // pill's line rather than a tall column up the right edge.
        idleRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
        }
        // Keyboard on the left, mic on the right — mic keeps the outer/thumb
        // position it has always had.
        idleRow.addView(keyboardButton, LinearLayout.LayoutParams(kbSize, kbSize).apply {
            rightMargin = GAP_DP
        })
        idleRow.addView(micButton, LinearLayout.LayoutParams(micSize, micSize))

        val buttonRow = FrameLayout(activity).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.END
                marginEnd = margin
            }
        }
        // Both rows occupy the same cell; exactly one is visible at a time, so
        // the pair never moves as it changes what it means.
        buttonRow.addView(idleRow, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.END })
        buttonRow.addView(quickSendRow, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.END })

        // Stack order (top to bottom): undo bar → destinations → timer → buttons
        innerLayout.addView(undoBarContainer, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            bottomMargin = (6 * dp).toInt()
        })

        innerLayout.addView(destScroll, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = Gravity.END
            bottomMargin = (6 * dp).toInt()
        })

        innerLayout.addView(recordingTimerView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = Gravity.END
            rightMargin = margin
            bottomMargin = (6 * dp).toInt()
        })

        // ABOVE the pair, aligned over the record button on the right edge, so
        // the three read as one column and it sits under his thumb.
        innerLayout.addView(appsButton, LinearLayout.LayoutParams(modeSize, modeSize).apply {
            gravity = Gravity.END
            marginEnd = margin + (BUTTON_DP - modeSize) / 2
            bottomMargin = (10 * dp).toInt()
        })

        innerLayout.addView(buttonRow)

        rightCluster.addView(innerLayout)
    }

    private fun buildDestinationPicker() {
        destContainer = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.END
            layoutParams = android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
            )
        }

        val maxPickerHeight = (activity.resources.displayMetrics.heightPixels * 0.65f).toInt()
        destScroll = object : ScrollView(activity) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val bounded = MeasureSpec.makeMeasureSpec(maxPickerHeight, MeasureSpec.AT_MOST)
                super.onMeasure(widthMeasureSpec, bounded)
            }
        }.apply {
            val bg = GradientDrawable().apply {
                cornerRadius = 16 * dp
                setColor(Color.argb(245, 0x11, 0x11, 0x11))
                setStroke((1.5f * dp).toInt(), colorBorder)
            }
            background = bg
            setPadding((16 * dp).toInt(), (14 * dp).toInt(), (16 * dp).toInt(), (14 * dp).toInt())
            isVerticalScrollBarEnabled = true
            isFillViewport = false
            clipToPadding = false
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
            addView(destContainer)
        }
        // Content populated dynamically when shown
    }

    /** Create a compact circular steward button — game HUD style */
    private fun createStewardSquare(steward: StewardInfo, onClick: () -> Unit): FrameLayout {
        val size = (46 * dp).toInt()
        val stewardColor = try { Color.parseColor(steward.color) } catch (_: Exception) { colorCyan }
        val r = Color.red(stewardColor)
        val g = Color.green(stewardColor)
        val b = Color.blue(stewardColor)

        return FrameLayout(activity).apply {
            layoutParams = LinearLayout.LayoutParams(size, size).apply {
                bottomMargin = (4 * dp).toInt()
            }
            isClickable = true
            isFocusable = true
            elevation = 4 * dp

            val bg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.argb(230, 0x1A, 0x1A, 0x1A))
                setStroke((2.5f * dp).toInt(), stewardColor)
            }
            background = bg

            // Show emoji if available, otherwise shorthand
            val content = TextView(activity).apply {
                text = if (!steward.icon.isNullOrEmpty()) steward.icon else steward.shorthand
                textSize = if (!steward.icon.isNullOrEmpty()) 20f else if (steward.shorthand.length > 2) 12f else 16f
                if (steward.icon.isNullOrEmpty()) setTextColor(stewardColor)
                gravity = Gravity.CENTER
                setShadowLayer(4f, 0f, 1f, Color.argb(128, 0, 0, 0))
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            }
            addView(content)

            setOnClickListener { onClick() }

            // Bounce on press
            setOnTouchListener { v, event ->
                when (event.action) {
                    android.view.MotionEvent.ACTION_DOWN -> {
                        v.animate().scaleX(0.88f).scaleY(0.88f).setDuration(80).start()
                        false
                    }
                    android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                        v.animate().scaleX(1f).scaleY(1f)
                            .setDuration(200)
                            .setInterpolator(android.view.animation.OvershootInterpolator(2f))
                            .start()
                        false
                    }
                    else -> false
                }
            }
        }
    }

    /** Populate destination picker with stewards + substewards (no presenter cards). */
    private fun populateDestinations() {
        destContainer.removeAllViews()

        val loading = TextView(activity).apply {
            text = "Loading…"
            textSize = 12f
            setTextColor(colorTextDim)
            gravity = Gravity.END
            setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt())
        }
        destContainer.addView(loading)

        onFetchStewards?.invoke { stewards ->
            Handler(Looper.getMainLooper()).post {
                if (!destVisible) return@post
                renderStewardList(stewards)
            }
        } ?: renderStewardList(emptyList())
    }

    /** Render the cleaned-up steward + substeward list (Fire 1 redesign). */
    private fun renderStewardList(stewards: List<StewardInfo>) {
        destContainer.removeAllViews()

        if (stewards.isEmpty()) {
            val empty = TextView(activity).apply {
                text = "No destinations"
                textSize = 12f
                setTextColor(colorTextDim)
                gravity = Gravity.END
                setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt())
            }
            destContainer.addView(empty)
            return
        }

        // Section label
        val sectionLabel = TextView(activity).apply {
            text = "SEND TO"
            textSize = 11f
            setTextColor(colorTextDim)
            gravity = Gravity.END
            letterSpacing = 0.18f
            typeface = Typeface.DEFAULT_BOLD
        }
        destContainer.addView(sectionLabel, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = (8 * dp).toInt() })

        for ((idx, steward) in stewards.withIndex()) {
            val stewardColor = try { Color.parseColor(steward.color) } catch (_: Exception) { colorCyan }
            val hasSubs = steward.substewards.isNotEmpty()
            val isExpanded = expandedStewards.contains(steward.sessionName)

            // ── Parent steward row: icon square + project name pill ──
            val row = createStewardRow(steward, stewardColor, hasSubs, isExpanded)
            destContainer.addView(row, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.END
                bottomMargin = (6 * dp).toInt()
            })

            // ── Substewards (expanded) ──
            if (hasSubs && isExpanded) {
                for (sub in steward.substewards) {
                    val subColor = try { Color.parseColor(sub.color) } catch (_: Exception) { stewardColor }
                    val subRow = createSubstewardRow(sub, subColor)
                    destContainer.addView(subRow, LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    ).apply {
                        gravity = Gravity.END
                        bottomMargin = (4 * dp).toInt()
                    })
                }
                // Extra gap after an expanded block
                val spacer = View(activity)
                destContainer.addView(spacer, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, (6 * dp).toInt()
                ))
            }

            // Gentle separator between stewards (not after last)
            if (idx < stewards.size - 1) {
                val divider = View(activity).apply {
                    setBackgroundColor(Color.argb(40, 0xFF, 0xFF, 0xFF))
                }
                destContainer.addView(divider, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, (1 * dp).toInt()
                ).apply {
                    topMargin = (2 * dp).toInt()
                    bottomMargin = (6 * dp).toInt()
                })
            }
        }
    }

    /** Full-width row for a parent steward: name pill + colored icon square on the right. */
    private fun createStewardRow(
        steward: StewardInfo,
        stewardColor: Int,
        hasSubs: Boolean,
        isExpanded: Boolean
    ): LinearLayout {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL or Gravity.END
        }

        // Name pill (tap = send to parent directly)
        val namePill = TextView(activity).apply {
            text = steward.project
            textSize = 17f
            setTextColor(stewardColor)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            maxLines = 1
            val bg = GradientDrawable().apply {
                cornerRadius = 22 * dp
                setColor(Color.argb(255, 0x1A, 0x1A, 0x1A))
                setStroke((2f * dp).toInt(), stewardColor)
            }
            background = bg
            setPadding((18 * dp).toInt(), (10 * dp).toInt(), (18 * dp).toInt(), (10 * dp).toInt())
            isClickable = true
            isFocusable = true
            setOnClickListener {
                onMicGestureWithTarget?.invoke(MicAction.SEND_TO_STEWARD, steward.sessionName)
                hideDestinations()
            }
        }

        // Expand/collapse chevron (only when steward has substewards)
        if (hasSubs) {
            val chevron = TextView(activity).apply {
                text = if (isExpanded) "▾" else "▸"
                textSize = 14f
                setTextColor(stewardColor)
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                val bg = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.argb(60, Color.red(stewardColor), Color.green(stewardColor), Color.blue(stewardColor)))
                }
                background = bg
                setPadding((8 * dp).toInt(), (4 * dp).toInt(), (8 * dp).toInt(), (4 * dp).toInt())
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    if (expandedStewards.contains(steward.sessionName)) {
                        expandedStewards.remove(steward.sessionName)
                    } else {
                        expandedStewards.add(steward.sessionName)
                    }
                    populateDestinations()
                }
            }
            row.addView(chevron, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = (6 * dp).toInt() })
        }

        row.addView(namePill, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { marginEnd = (6 * dp).toInt() })

        // Icon square on the far right — tap also sends to parent
        val iconSquare = createStewardSquare(steward) {
            onMicGestureWithTarget?.invoke(MicAction.SEND_TO_STEWARD, steward.sessionName)
            hideDestinations()
        }
        row.addView(iconSquare)

        return row
    }

    /** Indented row for a substeward: smaller pill + colored icon chip on the right. */
    private fun createSubstewardRow(sub: SubstewardInfo, subColor: Int): LinearLayout {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL or Gravity.END
        }

        val namePill = TextView(activity).apply {
            text = sub.name
            textSize = 15f
            setTextColor(subColor)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            maxLines = 1
            val bg = GradientDrawable().apply {
                cornerRadius = 18 * dp
                setColor(Color.argb(220, 0x15, 0x15, 0x15))
                setStroke((1.5f * dp).toInt(), subColor)
            }
            background = bg
            setPadding((14 * dp).toInt(), (7 * dp).toInt(), (14 * dp).toInt(), (7 * dp).toInt())
            isClickable = true
            isFocusable = true
            setOnClickListener {
                onMicGestureWithTarget?.invoke(MicAction.SEND_TO_STEWARD, sub.sessionName)
                hideDestinations()
            }
        }

        row.addView(namePill, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { marginEnd = (6 * dp).toInt() })

        // Small icon chip to anchor substeward's color on the right edge
        val chipSize = (36 * dp).toInt()
        val chip = FrameLayout(activity).apply {
            layoutParams = LinearLayout.LayoutParams(chipSize, chipSize)
            isClickable = true
            isFocusable = true
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.argb(230, 0x1A, 0x1A, 0x1A))
                setStroke((2f * dp).toInt(), subColor)
            }
            background = bg

            val content = TextView(activity).apply {
                text = if (!sub.icon.isNullOrEmpty()) sub.icon else sub.shorthand
                textSize = if (!sub.icon.isNullOrEmpty()) 16f else if (sub.shorthand.length > 2) 10f else 13f
                if (sub.icon.isNullOrEmpty()) setTextColor(subColor)
                gravity = Gravity.CENTER
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            }
            addView(content)

            setOnClickListener {
                onMicGestureWithTarget?.invoke(MicAction.SEND_TO_STEWARD, sub.sessionName)
                hideDestinations()
            }
        }
        row.addView(chip)

        return row
    }

    /**
     * Label the quick-send buttons with the presenter's CURRENT targets, and hide
     * whichever one has no target. Called when a take starts — the labels have to
     * say WHERE the audio is going, or he is tapping blind from a screen that is
     * not the presenter.
     */
    /** A filled dark circle with a colored ring — the quick-send button shape. */
    private fun circleBackground(ring: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.argb(255, 0x1A, 0x1A, 0x1A))
        setStroke((2.5f * dp).toInt(), ring)
    }

    /** Disc behind the worker circle's corner badge, so the steading emoji reads
     *  as a distinct little sticker rather than as part of the two letters. */
    private fun badgeBackground(): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.argb(255, 0x0A, 0x0A, 0x0A))
    }

    /**
     * Flip the pair between its two meanings.
     *
     * [sending] true  → the circles: steward icon + card number (the web pill).
     * [sending] false → record + keyboard.
     *
     * The two rows share one FrameLayout cell, so nothing shifts position as
     * the meaning changes — only what the two circles say.
     */
    /**
     * Report the real measured geometry of the button cluster (Josh 2026-09-11).
     *
     * The gap he sees between the keyboard and record buttons is a width coming
     * from somewhere; this says from where, instead of me guessing a view and
     * spending one of his APK taps per guess.
     */
    fun debugMeasureCluster(): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        fun px(v: Int) = "${v}px(${"%.1f".format(v / dp)}dp)"
        fun report(name: String, v: View?) {
            if (v == null) { out[name] = "null"; return }
            val vis = when (v.visibility) {
                View.VISIBLE -> "VISIBLE"; View.GONE -> "GONE"; else -> "INVISIBLE"
            }
            val lp = v.layoutParams
            val margins = (lp as? android.view.ViewGroup.MarginLayoutParams)
                ?.let { " margins[s=${it.marginStart} e=${it.marginEnd}]" } ?: ""
            out[name] = "$vis w=${px(v.width)} h=${px(v.height)}$margins"
        }
        out["isRecording"] = isRecording.toString()
        out["destVisible"] = destVisible.toString()
        if (::idleRow.isInitialized) {
            report("idleRow", idleRow)
            report("idleRow.keyboard", idleRow.getChildAt(0))
            report("idleRow.mic", idleRow.getChildAt(1))
            report("idleRow.parent(sharedCell)", idleRow.parent as? View)
        }
        if (::quickSendRow.isInitialized) {
            report("quickSendRow", quickSendRow)
            report("quickSendRow.stewardSlot", quickSendRow.getChildAt(0))
            report("quickSendRow.cardCircle", quickSendRow.getChildAt(1))
        }
        if (::quickSendStewardButton.isInitialized) report("stewardButton", quickSendStewardButton)
        if (::quickSendSteadingBadge.isInitialized) report("steadingBadge", quickSendSteadingBadge)
        if (::destScroll.isInitialized) report("destScroll", destScroll)
        return out
    }

    private fun showSendButtons(sending: Boolean) {
        if (!::idleRow.isInitialized || !::quickSendRow.isInitialized) return
        idleRow.visibility = if (sending) View.GONE else View.VISIBLE
        quickSendRow.visibility = if (sending) View.VISIBLE else View.GONE
    }

    /**
     * Keep the send circles pointed at whatever card is on screen RIGHT NOW.
     *
     * The bug this fixes (Josh 2026-09-05): the circles were labelled once, when
     * the take started, and then froze. He would start talking, flip to another
     * card, and the buttons still aimed at the card he had left — "those need to
     * update so that when I switch to any card or setting, they update to those
     * so I can use them just like I would the buttons on the web."
     *
     * A poll rather than a push because the truth lives in the presenter WebView's
     * own JS state, which we can only ask; there is no change event to subscribe
     * to from here. The fetch already hops to a worker thread and is cheap.
     */
    private fun startTargetPolling() {
        stopTargetPolling()
        targetPollHandler.postDelayed(targetPollRunnable, TARGET_POLL_MS)
    }

    private fun stopTargetPolling() {
        targetPollHandler.removeCallbacks(targetPollRunnable)
    }

    fun refreshQuickSendTargets() {
        if (!::quickSendRow.isInitialized) return
        val fetch = onFetchQuickSendTargets ?: return
        // Resolve OFF the main thread. The bridge behind this does
        // handler.post{...} + latch.await() — called ON the main thread it
        // deadlocks against itself until the timeout and returns empty, so the
        // circles would never get real labels. Fetch on a worker, apply on main.
        Thread {
            val t = try { fetch() } catch (_: Exception) { QuickSendTargets("", "", "") }
            val glyph = t.stewardGlyph
            val colorHex = t.stewardColorHex
            val cardNum = t.cardNumber
            val steadingBadge = t.steadingBadge
            Handler(Looper.getMainLooper()).post {
                if (!::quickSendRow.isInitialized) return@post
                val stewardColor = try { Color.parseColor(colorHex) } catch (_: Exception) { colorCyan }

                if (glyph.isNotEmpty()) {
                    quickSendStewardButton.text = glyph
                    quickSendStewardButton.background = circleBackground(stewardColor)
                    // Emoji carry their own color; a short text fallback needs the
                    // steward's color so the circle still reads as that steward.
                    quickSendStewardButton.setTextColor(stewardColor)
                    // On a worker the glyph is two LETTERS, not an emoji — make
                    // them read as a label (bold, slightly smaller so both fit
                    // the circle) rather than as an undersized emoji.
                    val isLetters = steadingBadge.isNotEmpty()
                    quickSendStewardButton.textSize = if (isLetters) 18f else 22f
                    quickSendStewardButton.typeface =
                        if (isLetters) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                    quickSendStewardButton.visibility = View.VISIBLE
                } else {
                    quickSendStewardButton.visibility = View.GONE
                }

                // Corner badge — only on a worker. Cleared on every refresh so
                // stepping back out to a top-level steward drops it (a stale
                // badge would claim he is somewhere he is not).
                if (::quickSendSteadingBadge.isInitialized) {
                    if (glyph.isNotEmpty() && steadingBadge.isNotEmpty()) {
                        quickSendSteadingBadge.text = steadingBadge
                        quickSendSteadingBadge.background = badgeBackground()
                        quickSendSteadingBadge.visibility = View.VISIBLE
                    } else {
                        quickSendSteadingBadge.visibility = View.GONE
                    }
                }

                if (cardNum.isNotEmpty()) {
                    quickSendCardButton.text = cardNum
                    quickSendCardButton.visibility = View.VISIBLE
                } else {
                    quickSendCardButton.visibility = View.GONE
                }

                // The row itself is now one of the two states of the permanent
                // button pair, so its visibility belongs to showSendButtons()
                // alone — never to whether a target happens to resolve.
                //
                // With no target at all there would be nothing in the slot and
                // the take would be unstoppable from here (he may be in Chrome,
                // where the web pill is not on screen either). Fall back to a
                // plain stop button so the pair is never empty mid-take.
                noSendTarget = glyph.isEmpty() && cardNum.isEmpty()
                if (noSendTarget) {
                    quickSendStewardButton.text = "⏹"
                    quickSendStewardButton.background = circleBackground(colorRed)
                    quickSendStewardButton.setTextColor(colorRed)
                    quickSendStewardButton.textSize = 22f
                    quickSendStewardButton.typeface = Typeface.DEFAULT
                    quickSendStewardButton.visibility = View.VISIBLE
                    // This circle is a STOP button in this state, not a worker —
                    // a steading badge on it would be a lie.
                    if (::quickSendSteadingBadge.isInitialized) {
                        quickSendSteadingBadge.visibility = View.GONE
                    }
                }
            }
        }.start()
    }

    fun showDestinations() {
        if (destVisible) return
        destVisible = true
        setActiveOpacity(true)
        destScroll.visibility = View.VISIBLE
        destScroll.alpha = 0f
        destScroll.translationY = 20 * dp
        destScroll.scrollTo(0, 0)
        destScroll.animate()
            .alpha(1f)
            .translationY(0f)
            .setDuration(200)
            .start()
        populateDestinations()
    }

    fun hideDestinations() {
        if (!destVisible) return
        destVisible = false
        if (!isRecording) setActiveOpacity(false)
        destScroll.animate()
            .alpha(0f)
            .translationY(20 * dp)
            .setDuration(150)
            .withEndAction { destScroll.visibility = View.GONE }
            .start()
    }


    // ── MIC TOUCH: tap to start, tap again to stop ──

    /**
     * The move gesture, driven only by the RIGHT (record) button.
     *
     * Returns true when the touch has been consumed as a move, so the caller
     * skips its tap handling. A hold arms it and a drag then moves the pair; a
     * plain tap never reaches it, and a hold that never travels does nothing.
     */
    private fun handleDragTouch(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragStartRawX = event.rawX
                dragStartRawY = event.rawY
                dragOriginX = offsetX
                dragOriginY = offsetY
                dragArmed = false
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragArmed) return false
                if (!moveMode) {
                    // Only treat it as a drag once the finger has actually
                    // travelled — a hold with a shaky thumb should still open
                    // the menu, not nudge the buttons across the screen.
                    val slop = kotlin.math.hypot(
                        (event.rawX - dragStartRawX).toDouble(),
                        (event.rawY - dragStartRawY).toDouble()
                    )
                    if (slop < DRAG_SLOP_DP * dp) return false
                    enterMoveMode()
                }
                offsetX = dragOriginX + (event.rawX - dragStartRawX)
                offsetY = dragOriginY + (event.rawY - dragStartRawY)
                clampOffset()
                applyOffset()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (moveMode) {
                    exitMoveMode()
                    return true
                }
                dragArmed = false
            }
        }
        return false
    }

    /**
     * Tap / hold for a LEFT button (the keyboard, or the steward send circle).
     *
     * Tap runs [onTap]; holding opens the menu. This button deliberately does
     * NOT drag — Josh 2026-09-05 split the two gestures by side, so the left
     * button owns every menu option and the right button owns the move. The
     * menu still opens on RELEASE rather than on the timer, so the buzz tells
     * him it is coming before it covers the screen.
     */
    private fun handleLeftButtonTouch(event: MotionEvent, onTap: () -> Unit) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                isSendTapDown = true
                sendLongPressFired = false
                sendLongPressHandler.postDelayed({
                    if (isSendTapDown) {
                        sendLongPressFired = true
                        onLongPressArmed?.invoke()
                    }
                }, LONG_PRESS_MS)
            }
            MotionEvent.ACTION_UP -> {
                sendLongPressHandler.removeCallbacksAndMessages(null)
                if (sendLongPressFired) {
                    sendLongPressFired = false
                    dragArmed = false
                    isSendTapDown = false
                    onSendLongPress?.invoke()
                    return
                }
                if (!isSendTapDown) return
                isSendTapDown = false
                onTap()
            }
            MotionEvent.ACTION_CANCEL -> {
                sendLongPressHandler.removeCallbacksAndMessages(null)
                isSendTapDown = false
                sendLongPressFired = false
            }
        }
    }

    /**
     * Tap / hold-to-drag for a RIGHT button that is not the mic — currently the
     * card send circle, which occupies the right slot while a take is running.
     *
     * Same rule as the mic: tap runs [onTap], hold arms the move, and a hold
     * that never travels does nothing. Kept separate from [handleMicTouch] only
     * because the mic's tap branches on recording/undo/destination state.
     */
    private fun handleRightButtonTouch(event: MotionEvent, onTap: () -> Unit) {
        if (handleDragTouch(event)) {
            sendLongPressHandler.removeCallbacksAndMessages(null)
            isSendTapDown = false
            return
        }
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                isSendTapDown = true
                sendLongPressFired = false
                sendLongPressHandler.postDelayed({
                    if (isSendTapDown) {
                        dragArmed = true
                        sendLongPressFired = true
                        onLongPressArmed?.invoke()
                    }
                }, LONG_PRESS_MS)
            }
            MotionEvent.ACTION_UP -> {
                sendLongPressHandler.removeCallbacksAndMessages(null)
                if (sendLongPressFired) {
                    // Held but never dragged — the move gesture simply did not
                    // happen. No menu here; that belongs to the left button.
                    sendLongPressFired = false
                    dragArmed = false
                    isSendTapDown = false
                    return
                }
                if (!isSendTapDown) return
                isSendTapDown = false
                onTap()
            }
            MotionEvent.ACTION_CANCEL -> {
                sendLongPressHandler.removeCallbacksAndMessages(null)
                isSendTapDown = false
                sendLongPressFired = false
                dragArmed = false
            }
        }
    }

    private fun handleMicTouch(event: MotionEvent) {
        if (handleDragTouch(event)) {
            micLongPressHandler.removeCallbacksAndMessages(null)
            isMicTapDown = false
            return
        }
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                isMicTapDown = true
                // Holding the RIGHT button does one thing only: arm the drag.
                // Josh 2026-09-05: "only holding the recording button and moving
                // it, like the right button, that's the one that should be able
                // to drag. And then all the menu item options should be a long
                // hold of the left hand button." So the trackpad moved off this
                // button and became an item in the left button's menu.
                micLongPressFired = false
                micLongPressHandler.postDelayed({
                    if (isMicTapDown) {
                        dragArmed = true
                        micLongPressFired = true
                        onLongPressArmed?.invoke()
                    }
                }, LONG_PRESS_MS)
            }
            MotionEvent.ACTION_UP -> {
                micLongPressHandler.removeCallbacksAndMessages(null)
                if (micLongPressFired) {
                    // Held but never dragged. Nothing happens — this button's
                    // hold is purely the move gesture now, and a hold that goes
                    // nowhere should not start or stop a recording by surprise.
                    micLongPressFired = false
                    dragArmed = false
                    isMicTapDown = false
                    return
                }
                if (!isMicTapDown) return
                isMicTapDown = false

                if (isRecording) {
                    // Second tap on a live take CANCELS it (Josh 2026-09-11).
                    // This used to stop-and-prepare, raising the destination
                    // picker; that menu is retired and the handler now drops the
                    // take outright. Sending is done from the quick-send circles.
                    onMicGesture?.invoke(MicAction.CANCEL)
                } else if (undoBarVisible) {
                    cancelUndoSend()
                } else if (destVisible) {
                    // Dismiss destinations without sending
                    onMicGesture?.invoke(MicAction.CANCEL)
                    hideDestinations()
                } else {
                    // Start recording
                    onRecordingStart?.invoke()
                }
            }
            MotionEvent.ACTION_CANCEL -> {
                micLongPressHandler.removeCallbacksAndMessages(null)
                isMicTapDown = false
            }
        }
    }

    private fun updateMicVisuals() {
        if (!::micButton.isInitialized) return
        val micFace = micButton.getChildAt(1)
        val faceBg = micFace.tag as? GradientDrawable ?: return

        if (isRecording) {
            faceBg.setColor(colorRed)
            micIcon.text = "⏹"
        } else {
            faceBg.setColor(colorOrange)
            micIcon.text = "\uD83C\uDFA4"  // 🎤
        }
    }

    private fun updateMicPulse() {
        if (!::micGlow.isInitialized) return
        if (!isRecording) return

        val voicePulse = audioLevel * 0.3f
        val pulseScale = 1f + (recordingPulseValue * 0.1f) + voicePulse
        val pulseAlpha = (60 + (recordingPulseValue * 60) + (audioLevel * 135)).toInt().coerceAtMost(255)

        micGlow.scaleX = pulseScale
        micGlow.scaleY = pulseScale
        micGlow.alpha = pulseAlpha / 255f

        val glowBg = micGlow.background as? GradientDrawable
        glowBg?.setColor(Color.argb(pulseAlpha, 0xFF, 0x33, 0x33))
    }


    private fun startRecordingPulse() {
        recordingAnimator?.cancel()
        recordingAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 800
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            interpolator = AccelerateDecelerateInterpolator()
            addUpdateListener {
                recordingPulseValue = it.animatedValue as Float
                updateMicPulse()
            }
            start()
        }
    }

    private fun stopRecordingPulse() {
        recordingAnimator?.cancel()
        recordingPulseValue = 0f
        if (::micGlow.isInitialized) {
            micGlow.scaleX = 1f
            micGlow.scaleY = 1f
            micGlow.alpha = 0.24f
            val glowBg = micGlow.background as? GradientDrawable
            glowBg?.setColor(Color.argb(60, 0xFF, 0x66, 0x00))
        }
    }

    private fun startRecordingTimer() {
        if (!::recordingTimerView.isInitialized) return
        recordingStartTime = System.currentTimeMillis()
        recordingTimerView.text = "0:00"
        recordingTimerView.visibility = View.VISIBLE
        timerHandler.post(timerTickRunnable)
    }

    private fun stopRecordingTimer() {
        if (!::recordingTimerView.isInitialized) return
        recordingStartTime = 0L
        timerHandler.removeCallbacks(timerTickRunnable)
        recordingTimerView.visibility = View.GONE
    }

    private fun keepScreenOn(on: Boolean) {
        if (on) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    // --- Undo-send bar ---

    private lateinit var undoCountdownView: TextView
    private lateinit var undoLabelView: TextView
    private var pendingAction: MicAction? = null
    private var pendingTarget: String? = null

    private fun buildUndoBar() {
        undoBarContainer = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            val bg = GradientDrawable().apply {
                cornerRadius = 16 * dp
                setColor(Color.argb(230, 0x1A, 0x1A, 0x1A))
                setStroke((2 * dp).toInt(), colorAmber)
            }
            background = bg
            setPadding((16 * dp).toInt(), (12 * dp).toInt(), (16 * dp).toInt(), (12 * dp).toInt())
        }

        undoLabelView = TextView(activity).apply {
            textSize = 14f
            setTextColor(colorAmber)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        undoBarContainer.addView(undoLabelView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = (8 * dp).toInt() })

        undoCountdownView = TextView(activity).apply {
            textSize = 22f
            setTextColor(Color.WHITE)
            typeface = Typeface.MONOSPACE
            gravity = Gravity.CENTER
        }
        undoBarContainer.addView(undoCountdownView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { bottomMargin = (10 * dp).toInt() })

        val btnRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }

        val undoBtn = TextView(activity).apply {
            text = "Cancel"
            textSize = 15f
            setTextColor(colorRed)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            val bg = GradientDrawable().apply {
                cornerRadius = 24 * dp
                setColor(colorSurface)
                setStroke((2 * dp).toInt(), colorRed)
            }
            background = bg
            setPadding((20 * dp).toInt(), (10 * dp).toInt(), (20 * dp).toInt(), (10 * dp).toInt())
            isClickable = true
            isFocusable = true
            setOnClickListener { cancelUndoSend() }
        }

        val redirectBtn = TextView(activity).apply {
            text = "Redirect"
            textSize = 15f
            setTextColor(colorCyan)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            val bg = GradientDrawable().apply {
                cornerRadius = 24 * dp
                setColor(colorSurface)
                setStroke((2 * dp).toInt(), colorCyan)
            }
            background = bg
            setPadding((20 * dp).toInt(), (10 * dp).toInt(), (20 * dp).toInt(), (10 * dp).toInt())
            isClickable = true
            isFocusable = true
            setOnClickListener { redirectUndoSend() }
        }

        btnRow.addView(undoBtn, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { marginEnd = (12 * dp).toInt() })
        btnRow.addView(redirectBtn)
        undoBarContainer.addView(btnRow)
    }

    fun showUndoBar(action: MicAction, targetLabel: String, target: String? = null) {
        pendingAction = action
        pendingTarget = target
        undoBarVisible = true
        undoLabelView.text = "Sending to $targetLabel..."
        undoBarContainer.visibility = View.VISIBLE
        undoBarContainer.alpha = 0f
        undoBarContainer.animate().alpha(1f).setDuration(150).start()

        val startTime = System.currentTimeMillis()
        val countdownRunnable = object : Runnable {
            override fun run() {
                val remaining = UNDO_DELAY_MS - (System.currentTimeMillis() - startTime)
                if (remaining <= 0) {
                    confirmUndoSend()
                    return
                }
                val secs = ((remaining + 999) / 1000).toInt()
                undoCountdownView.text = "${secs}s"
                undoHandler.postDelayed(this, 100)
            }
        }
        undoTimer = countdownRunnable
        undoCountdownView.text = "3s"
        undoHandler.post(countdownRunnable)
    }

    private fun confirmUndoSend() {
        val action = pendingAction
        val target = pendingTarget
        hideUndoBar()
        if (action != null) {
            onConfirmSend?.invoke(action, target)
        }
    }

    private fun cancelUndoSend() {
        hideUndoBar()
        onUndoSend?.invoke()
    }

    private fun redirectUndoSend() {
        undoTimer?.let { undoHandler.removeCallbacks(it) }
        undoTimer = null
        undoBarVisible = false
        undoBarContainer.animate()
            .alpha(0f)
            .setDuration(100)
            .withEndAction {
                undoBarContainer.visibility = View.GONE
                showDestinations()
            }
            .start()
    }

    private fun hideUndoBar() {
        undoTimer?.let { undoHandler.removeCallbacks(it) }
        undoTimer = null
        pendingAction = null
        pendingTarget = null
        if (!undoBarVisible) return
        undoBarVisible = false
        undoBarContainer.animate()
            .alpha(0f)
            .setDuration(100)
            .withEndAction { undoBarContainer.visibility = View.GONE }
            .start()
    }


    /** Anchor for the send menu — the pair itself, so the menu opens off it. */
    fun sendMenuAnchor(): View? {
        if (!::quickSendRow.isInitialized) return null
        return if (quickSendRow.visibility == View.VISIBLE) quickSendRow
        else if (::idleRow.isInitialized) idleRow else null
    }

    /**
     * Centre of the mode button in screen coordinates, or null before layout.
     *
     * The reveal grows from the button he just pressed, so the transition
     * appears to originate under his thumb.
     */
    fun modeRevealCenter(goingToPhone: Boolean): Pair<Int, Int>? {
        if (!::appsButton.isInitialized) return null
        if (appsButton.width == 0) return null
        val loc = IntArray(2)
        appsButton.getLocationOnScreen(loc)
        return Pair(loc[0] + appsButton.width / 2, loc[1] + appsButton.height / 2)
    }

    /**
     * Point the mode button at [phoneMode] and flip the glyph to match.
     *
     * Animated as a coin flip on the Y axis, swapping the character at the
     * halfway point where the glyph is edge-on — so the change itself is never
     * seen, only the flip. [animate] is false on first layout, where there is
     * nothing to transition from.
     */
    fun setPhoneMode(phoneMode: Boolean, animate: Boolean = true) {
        if (phoneModeActive == phoneMode) return
        val target = if (phoneMode) GLYPH_HOMESTEAD else GLYPH_PHONE
        val icon = appsIcon
        if (icon == null) {
            // Button not built yet — record the mode WITHOUT marking it applied,
            // so the glyph is picked up when the button is created.
            phoneModeActive = phoneMode
            return
        }
        phoneModeActive = phoneMode

        if (!animate) {
            icon.text = target
            return
        }

        icon.animate().cancel()
        // Push the projection camera back, or a 90-degree flip on a small view
        // looks distorted and clips at the edges.
        icon.cameraDistance = 8000f * activity.resources.displayMetrics.density
        icon.rotationY = 0f
        icon.animate()
            .rotationY(90f)
            .setDuration(ICON_FLIP_MS)
            .setInterpolator(android.view.animation.AccelerateInterpolator())
            .withEndAction {
                icon.text = target
                // Start the second half from -90 so the glyph continues turning
                // the same way instead of snapping back through the front.
                icon.rotationY = -90f
                icon.animate()
                    .rotationY(0f)
                    .setDuration(ICON_FLIP_MS)
                    .setInterpolator(android.view.animation.DecelerateInterpolator())
                    .start()
            }
            .start()
    }

    fun destroy() {
        recordingAnimator?.cancel()
        timerHandler.removeCallbacks(timerTickRunnable)
        undoTimer?.let { undoHandler.removeCallbacks(it) }
        micLongPressHandler.removeCallbacksAndMessages(null)
        sendLongPressHandler.removeCallbacksAndMessages(null)
        stopTargetPolling()
        keepScreenOn(false)
    }

    companion object {
        /**
         * How often the send circles re-ask the presenter which card is showing.
         * Fast enough that flipping a card and tapping send feels instant; slow
         * enough that it is not a busy loop against the WebView bridge.
         */
        private const val TARGET_POLL_MS = 700L
        /** Hold time on the record button before the move gesture arms. */
        private const val LONG_PRESS_MS = 500L

        // Deliberately conservative glyph choices: both are long-standing BMP
        // characters present in Android's default fonts. Obscure symbols (e.g.
        // U+2317 VIEWDATA SQUARE) render as an empty box on some ROMs.
        /** Shown in Homestead mode — tap to go to the phone screen. */
        private const val GLYPH_PHONE = "\u229E"      // grid
        /** Shown in Phone mode — tap to go back to Homestead. */
        private const val GLYPH_HOMESTEAD = "\u2302"  // house
        private const val ICON_FLIP_MS = 110L

        /** Both buttons are this many dp square — peers, not primary+secondary. */
        private const val BUTTON_SIZE_DP = 56f
        /**
         * Height, in dp above the bottom edge, of the web page's own send-pill
         * line. The native pair is centred on it so it lands on top of the web
         * buttons it replaces.
         */
        private const val PILL_LINE_DP = 69f

        // Move mode.
        /** Finger travel before a hold turns into a drag, not a jittery thumb. */
        private const val DRAG_SLOP_DP = 10f
        /** How much of the pair must stay on screen, so it can never be lost. */
        private const val MIN_ON_SCREEN_DP = 28f
        private const val KEY_OFFSET_X = "controls_offset_x"
        private const val KEY_OFFSET_Y = "controls_offset_y"
    }
}
