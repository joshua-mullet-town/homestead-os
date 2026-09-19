package com.homestead.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The floating button pair, as a system-wide overlay.
 *
 * Josh 2026-09-05: "I was actually hoping that the recording buttons, or that
 * set of buttons now, would actually follow me everywhere. It would be on top of
 * the screen, no matter where I went in my phone."
 *
 * So this is not just the send circles during a take any more — it is the whole
 * cluster, available over Chrome or the launcher or anything else:
 *
 *   idle      → keyboard + record. Tapping record STARTS a take from anywhere.
 *   recording → the steward-icon and card-number send circles, re-labelled as he
 *               moves between cards so they never aim at a stale one.
 *   always    → a small return button above the pair, which brings him back to
 *               Homestead in whichever mode he left it. It is his way out of
 *               whatever app he is in.
 *
 * Gestures match the in-app cluster exactly, because muscle memory should not
 * change with which screen he happens to be on: hold the RIGHT button and drag
 * to move the pair, hold the LEFT one for the menu.
 *
 * Owned by RecordingService, NOT the Activity: the Activity is destroyed while
 * he is off in another app, which is precisely when this has to stay up.
 *
 * Needs SYSTEM_ALERT_WINDOW, which only the user can grant. Without it we simply
 * never show and the in-app controls remain the whole story.
 */
class QuickSendOverlay(private val context: Context) {

    companion object {
        private const val TAG = "QuickSendOverlay"

        /** Has the user granted "Display over other apps"? */
        fun canDraw(context: Context): Boolean = Settings.canDrawOverlays(context)

        private const val LONG_PRESS_MS = 500L
        private const val DRAG_SLOP_DP = 10f
        private const val KEY_X = "overlay_x"
        private const val KEY_Y = "overlay_y"
        private const val DEFAULT_X_DP = 12f
        private const val DEFAULT_Y_DP = 120f


        /** Diameter of the peeking dot as DRAWN. */
        private const val PEEK_SIZE_DP = 28f

        /**
         * How much of the drawn circle hangs off the right edge.
         *
         * Josh: "a small dot that looks like it's kind of emerging from the right
         * corner, kind of like it's like trying to pop out, but not quite."
         *
         * This is a DRAWING offset only — the circle is pushed right INSIDE its
         * view, and the view itself stays fully on screen. The first cut moved
         * the whole window off the edge instead, which also moved the touch area
         * off the edge: 31px of a 73px target was reachable (~12dp, against
         * Android's 48dp minimum), and the reachable sliver was the dim left rim
         * rather than the part that looks like a button. Josh: "I can see it
         * slightly and I'm trying to hit it, but it's not doing anything."
         */
        private const val PEEK_OFFSCREEN_DP = 16f

        /**
         * Touch target for the dot. Deliberately much larger than the circle —
         * it is a padded, invisible hit area around a small drawing, which is how
         * a tiny control stays reliably tappable. Meets the 48dp guidance with
         * room to spare, because he is aiming at a corner with a thumb.
         */
        private const val PEEK_TOUCH_DP = 64f

        /** How far up from the bottom edge the dot sits. "Very lowest most right." */
        private const val PEEK_BOTTOM_DP = 24f
    }

    /** Tap the record button out here — starts or stops a take. */
    var onRecordTap: (() -> Unit)? = null
    /** Tap the keyboard button — brings Homestead forward to type. */
    var onKeyboardTap: (() -> Unit)? = null
    var onSendSteward: (() -> Unit)? = null
    var onSendCard: (() -> Unit)? = null
    /** Long-press the LEFT button — the menu (cancel, history, mouse, reset). */
    var onLongPress: (() -> Unit)? = null
    /**
     * The menu's rows, supplied by whoever owns the actions (MainActivity).
     *
     * Each entry is a label plus what to run when it is picked. Supplying this
     * is what makes the menu open HERE, in the overlay's own window, instead of
     * bouncing through the Activity — see [showMenu].
     */
    var menuItems: (() -> List<Pair<String, () -> Unit>>)? = null
    /** Tap the return button — back to Homestead, in the mode he left it in. */
    var onReturnTap: (() -> Unit)? = null
    /** Milliseconds into the current take, for the timer. Supplied by the service. */
    var elapsedMs: (() -> Long)? = null
    /**
     * Fired when he taps the dot open. The service uses it to start watching for
     * an app switch, so expanding here does not follow him into the next app.
     */
    var onExpanded: (() -> Unit)? = null
    /** Fired when it folds back to the dot, so that watch can stop. */
    var onCollapsed: (() -> Unit)? = null

    private val windowManager =
        context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val prefs = context.getSharedPreferences("homestead_overlay_pos", Context.MODE_PRIVATE)

    private var root: LinearLayout? = null
    private var params: WindowManager.LayoutParams? = null

    /**
     * The long-press menu, as its OWN window.
     *
     * It cannot be a PopupMenu anchored to a button in [root]: that window is
     * FLAG_NOT_FOCUSABLE (so Chrome underneath stays usable), and a popup
     * inherits that — it would draw but never take a tap. This is a separate,
     * focusable overlay window instead, which is also why the menu no longer
     * needs MainActivity on screen at all.
     */
    private var menuRoot: View? = null

    // Recording state: the send circles.
    private var stewardCircle: TextView? = null
    private var steadingBadgeView: TextView? = null
    /** Wrapper holding the steward circle + its corner badge. THE ROW CHILD —
     *  visibility must be toggled here, not on stewardCircle, or its 56dp slot
     *  keeps its space and wedges a gap between keyboard and record. */
    private var stewardSlot: android.widget.FrameLayout? = null
    private var cardCircle: TextView? = null
    // Idle state: keyboard + record.
    private var keyboardCircle: TextView? = null
    private var recordCircle: TextView? = null
    /** Always-visible return-to-Homestead button, above the pair. */
    private var returnCircle: TextView? = null
    /** Elapsed-time readout while a take runs, matching the in-app one. */
    private var timerView: TextView? = null
    /** The collapsed dot, half off the right edge. Shown INSTEAD of everything else. */
    private var peekDot: View? = null

    private var showingRecordingState = false
    private var noSendTarget = false

    /**
     * Collapsed to the corner dot rather than showing the cluster.
     *
     * Josh 2026-09-06: "if I haven't already started a recording, I'm really not
     * that interested in seeing those buttons… there should be like a small dot
     * that looks like it's kind of emerging from the right corner… If I click
     * that, then I can see my audio controls again, but it should be completely
     * out of the way until then."
     *
     * Only ever true in the IDLE state. A live take always shows the full
     * cluster — that path is untouched, because what he sees while recording is
     * the half he explicitly said he likes.
     */
    private var collapsed = false

    private val density = context.resources.displayMetrics.density
    private fun dp(v: Float) = (v * density).toInt()

    private val amber = Color.parseColor("#FFCC00")
    private val orange = Color.parseColor("#FF6600")
    private val red = Color.parseColor("#FF3333")

    fun isShowing(): Boolean = root != null

    /**
     * Raise the pair in its IDLE state — keyboard + record, nothing recording.
     *
     * This is the state that makes the buttons "follow him everywhere": before
     * this, the overlay only existed during a take, so he could finish a
     * recording from Chrome but never start one.
     */
    fun showIdle() {
        if (!ensureWindow()) return
        showingRecordingState = false
        collapsed = false
        applyState()
    }

    /**
     * Raise the overlay COLLAPSED — just the dot peeking out of the corner.
     *
     * This is what he gets on leaving Homestead with nothing recording. The
     * window and its buttons still exist; they are simply not drawn, so tapping
     * the dot is an instant swap rather than a rebuild.
     *
     * Safe to call repeatedly: once collapsed, further calls are a no-op, so the
     * service can re-assert this state without yanking the cluster out from
     * under him mid-tap.
     */
    fun showPeek() {
        // A live take is never hidden behind the dot — Josh keeps the recording
        // view exactly as it is today. Every caller already checks this; the
        // guard lives here too so the rule cannot be lost at a future call site.
        if (showingRecordingState) return
        if (!ensureWindow()) return
        collapsed = true
        applyState()
    }

    /**
     * Force back to the dot, if idle. Called when he lands in a NEW app.
     *
     * Josh: "every time I go to a new app, this should be the new behavior" —
     * so expanding in one app must not follow him into the next one.
     */
    fun collapseIfIdle() {
        if (showingRecordingState) return
        if (root == null) return
        collapsed = true
        applyState()
        onCollapsed?.invoke()
    }

    /**
     * Raise the pair in its RECORDING state, labelled for the current targets.
     * Safe to call repeatedly — a second call just re-labels, which is how the
     * circles keep up as he moves between cards.
     */
    @SuppressLint("InflateParams")
    fun show(glyph: String, colorHex: String, cardNumber: String, steadingBadge: String = "") {
        if (!ensureWindow()) return
        showingRecordingState = true
        // A live take is never hidden behind the dot. Josh keeps the recording
        // view exactly as it is today — the dot is only for the idle case.
        collapsed = false
        applyState()
        applyLabels(glyph, colorHex, cardNumber, steadingBadge)
    }

    /** Build and add the window if it is not already up. False if we may not. */
    private fun ensureWindow(): Boolean {
        if (!canDraw(context)) {
            Log.d(TAG, "No overlay permission — staying hidden")
            return false
        }
        if (root != null) return true

        build()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            // NOT_FOCUSABLE keeps the app underneath fully interactive — he must
            // be able to keep using Chrome normally with these up. Without it the
            // overlay would swallow the keyboard from whatever is beneath.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.END or Gravity.BOTTOM
            x = prefs.getInt(KEY_X, dp(DEFAULT_X_DP))
            // Sit above the nav bar rather than under the gesture strip.
            y = prefs.getInt(KEY_Y, dp(DEFAULT_Y_DP))
        }
        params = lp
        return try {
            windowManager.addView(root, lp)
            true
        } catch (e: Exception) {
            // Permission can be revoked between the check and the add.
            Log.e(TAG, "addView failed: ${e.message}", e)
            root = null
            params = null
            false
        }
    }

    fun hide() {
        // Before the early return below — the menu is its own window and would
        // otherwise be orphaned on screen after the buttons went away.
        dismissMenu()
        val v = root ?: return
        try {
            windowManager.removeView(v)
        } catch (e: Exception) {
            Log.w(TAG, "removeView failed: ${e.message}")
        }
        root = null
        params = null
        stewardCircle = null
        steadingBadgeView = null
        stewardSlot = null
        cardCircle = null
        keyboardCircle = null
        recordCircle = null
        returnCircle = null
        timerView = null
        peekDot = null
        collapsed = false
        stopTimer()
    }

    /** Put the pair back at its default spot. */
    fun resetPosition() {
        val lp = params ?: return
        lp.x = dp(DEFAULT_X_DP)
        lp.y = dp(DEFAULT_Y_DP)
        savePosition(lp)
        try {
            windowManager.updateViewLayout(root, lp)
        } catch (e: Exception) {
            Log.w(TAG, "reset updateViewLayout failed: ${e.message}")
        }
    }

    /**
     * Centre of the return button in screen coordinates, or null before layout.
     *
     * The in-app mode button is retired, so the mode-switch reveal now grows
     * from THIS button — the one he actually pressed. Without it the reveal has
     * no origin and the transition degrades to an instant cut, which is the part
     * Josh singled out as working "really beautifully".
     */
    fun returnButtonCenter(): Pair<Int, Int>? {
        val v = returnCircle ?: return null
        if (v.width == 0) return null
        val loc = IntArray(2)
        v.getLocationOnScreen(loc)
        return Pair(loc[0] + v.width / 2, loc[1] + v.height / 2)
    }

    /**
     * Open the long-press menu in its own focusable overlay window.
     *
     * Returns false if it could not be shown, so the caller can say so rather
     * than leaving the hold looking dead — the silent `?: return` in the old
     * Activity-side path is exactly why this shipped broken and unnoticed.
     */
    fun showMenu(): Boolean {
        val items = menuItems?.invoke().orEmpty()
        if (items.isEmpty()) {
            Log.w(TAG, "showMenu: no items supplied")
            return false
        }
        if (!canDraw(context)) {
            Log.w(TAG, "showMenu: no overlay permission")
            return false
        }
        dismissMenu()

        val pad = dp(8f)
        val card = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, pad, 0, pad)
            background = GradientDrawable().apply {
                cornerRadius = dp(14f).toFloat()
                setColor(Color.parseColor("#F2222222"))
            }
            elevation = dp(12f).toFloat()
        }
        items.forEach { (label, action) ->
            card.addView(TextView(context).apply {
                text = label
                setTextColor(Color.WHITE)
                textSize = 16f
                setPadding(dp(20f), dp(14f), dp(20f), dp(14f))
                isClickable = true
                setOnClickListener {
                    // Close FIRST: the action may foreground the Activity, and a
                    // menu window left up would sit on top of what it opened.
                    dismissMenu()
                    action()
                }
            }, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ))
        }

        // A full-screen scrim so a tap anywhere off the menu closes it — the
        // dismiss affordance a PopupMenu would have given us for free.
        val scrim = FrameLayout(context).apply {
            setBackgroundColor(Color.parseColor("#66000000"))
            isClickable = true
            setOnClickListener { dismissMenu() }
            addView(card, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.END or Gravity.BOTTOM
                marginEnd = dp(16f)
                // Sit just above the buttons, measured from where they ACTUALLY
                // are (they are draggable) rather than from the default spot.
                // The scrim now spans the true screen including the nav bar, so
                // this offset is from the real bottom edge, not the inset one.
                bottomMargin = (params?.y ?: dp(DEFAULT_Y_DP)) + dp(72f)
            })
        }

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        // FOCUSABLE (no NOT_FOCUSABLE flag) — this window must take the taps,
        // and taking focus is also what lets BACK dismiss it.
        //
        // The dim must reach the TRUE screen edges. MATCH_PARENT sizes to the
        // content area, which stops short of the status bar and the nav bar —
        // Josh 2026-09-06 saw exactly that: "it kind of shows like it's hiding
        // the background, but it doesn't actually cover the whole background…
        // everything but the very bottom and the very top… it looks very dorky."
        // So take an explicit full-screen size and draw into the cutout too.
        // Real display size, bars included — displayMetrics is the CONTENT size
        // on some versions, which is the very thing that left the strips showing.
        val screen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            windowManager.maximumWindowMetrics.bounds.let { it.width() to it.height() }
        } else {
            val p = android.graphics.Point()
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.getRealSize(p)
            p.x to p.y
        }
        val lp = WindowManager.LayoutParams(
            screen.first,
            screen.second,
            type,
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_INSET_DECOR,
            PixelFormat.TRANSLUCENT
        ).apply {
            // Anchor at the true top-left; without this the explicit size is
            // still positioned relative to the inset content area.
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 0
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }
        scrim.setOnKeyListener { _, keyCode, event ->
            if (keyCode == android.view.KeyEvent.KEYCODE_BACK &&
                event.action == android.view.KeyEvent.ACTION_UP
            ) { dismissMenu(); true } else false
        }
        scrim.isFocusableInTouchMode = true

        return try {
            windowManager.addView(scrim, lp)
            menuRoot = scrim
            scrim.requestFocus()
            true
        } catch (e: Exception) {
            Log.e(TAG, "showMenu addView failed: ${e.message}", e)
            menuRoot = null
            false
        }
    }

    /** Take the menu window down. Safe to call when it is not up. */
    fun dismissMenu() {
        val v = menuRoot ?: return
        menuRoot = null
        try { windowManager.removeView(v) } catch (e: Exception) {
            Log.w(TAG, "dismissMenu removeView: ${e.message}")
        }
    }

    fun hasCustomPosition(): Boolean =
        prefs.contains(KEY_X) || prefs.contains(KEY_Y)

    private fun savePosition(lp: WindowManager.LayoutParams) {
        prefs.edit().putInt(KEY_X, lp.x).putInt(KEY_Y, lp.y).apply()
    }

    /** Show whichever pair the current state calls for. */
    private fun applyState() {
        // COLLAPSED: nothing but the dot. Everything else goes away, including
        // the return button — the dot is the way back to all of it now.
        if (collapsed) {
            peekDot?.visibility = View.VISIBLE
            keyboardCircle?.visibility = View.GONE
            recordCircle?.visibility = View.GONE
            stewardCircle?.visibility = View.GONE
            stewardSlot?.visibility = View.GONE
            steadingBadgeView?.visibility = View.GONE
            cardCircle?.visibility = View.GONE
            returnCircle?.visibility = View.GONE
            stopTimer()
            applyWindowPosition()
            return
        }

        peekDot?.visibility = View.GONE
        returnCircle?.visibility = View.VISIBLE
        keyboardCircle?.visibility = if (showingRecordingState) View.GONE else View.VISIBLE
        recordCircle?.visibility = if (showingRecordingState) View.GONE else View.VISIBLE
        stewardCircle?.visibility = if (showingRecordingState) View.VISIBLE else View.GONE
        // THE GAP FIX (Josh 2026-09-11). Every other circle is a direct child of
        // the row, so hiding it gives up its width. The steward circle is now
        // nested in a slot so its corner badge can overhang — and hiding only the
        // circle left that 56dp slot (plus its 10dp margin) standing between the
        // keyboard and record buttons. That is the "big old gap" he saw when not
        // recording, and why it closed during a take: the slot is meant to be
        // there then. Toggle the SLOT, which is the row's actual child.
        stewardSlot?.visibility = if (showingRecordingState) View.VISIBLE else View.GONE
        // The badge only ever rides ALONG with the steward circle, and only when
        // applyLabels put a worker there — so leaving the recording state hides
        // it, but re-entering does NOT resurrect it on its own.
        if (!showingRecordingState) steadingBadgeView?.visibility = View.GONE
        cardCircle?.visibility = if (showingRecordingState) View.VISIBLE else View.GONE
        if (showingRecordingState) startTimer() else stopTimer()
        applyWindowPosition()
    }

    /**
     * Move the window to suit the current state.
     *
     * The cluster sits where he last dragged it. The dot ignores that entirely
     * and pins itself to the bottom-right corner with a negative x, which pushes
     * it past the screen edge — that overhang is the "trying to pop out, but not
     * quite" look, and it only works because FLAG_LAYOUT_NO_LIMITS lets a window
     * lie outside the display bounds.
     *
     * His dragged position is never overwritten; expanding restores it.
     */
    private fun applyWindowPosition() {
        val lp = params ?: return
        if (collapsed) {
            // Flush to the right edge and fully ON screen — the overhang is done
            // by offsetting the drawn circle inside this window, not by pushing
            // the window itself off the display. A window that hangs off the edge
            // takes its touch area with it, which is what made the dot unhittable.
            lp.x = 0
            lp.y = dp(PEEK_BOTTOM_DP)
        } else {
            lp.x = prefs.getInt(KEY_X, dp(DEFAULT_X_DP))
            lp.y = prefs.getInt(KEY_Y, dp(DEFAULT_Y_DP))
        }
        try {
            windowManager.updateViewLayout(root, lp)
        } catch (_: Exception) {
        }
    }

    // ── No auto-collapse ──
    // Josh 2026-09-06: "the eight seconds thing should be totally gone now. The
    // only things that should exist are the recording stuff being permanently on
    // when I'm on the launcher, or they get reappeared when I hit the settings
    // button. Those are the only two times."
    //
    // So expanded is no longer a temporary state that times out. Once the
    // controls are up they stay up until something MEANINGFUL changes them:
    // landing in a different app (collapseIfIdle) or coming back to Homestead
    // (showIdle). A timer was the wrong instrument — it made the controls
    // vanish from under him while he was still looking at them.

    // ── Recording timer ──
    // Driven off the service's own elapsedMs rather than a local start time, so
    // it stays correct no matter when the overlay appeared — he can start a take
    // in the app, walk into Chrome, and the floating timer picks up mid-count
    // instead of restarting from zero.

    private val timerHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val timerTick = object : Runnable {
        override fun run() {
            val tv = timerView ?: return
            val ms = elapsedMs?.invoke() ?: 0L
            val secs = (ms / 1000).toInt()
            tv.text = String.format("%d:%02d", secs / 60, secs % 60)
            timerHandler.postDelayed(this, 200)
        }
    }

    private fun startTimer() {
        val tv = timerView ?: return
        tv.visibility = View.VISIBLE
        timerHandler.removeCallbacks(timerTick)
        timerHandler.post(timerTick)
    }

    private fun stopTimer() {
        timerHandler.removeCallbacks(timerTick)
        timerView?.visibility = View.GONE
    }

    private fun applyLabels(
        glyph: String,
        colorHex: String,
        cardNumber: String,
        steadingBadge: String = ""
    ) {
        val stewardColor = try { Color.parseColor(colorHex) } catch (_: Exception) { Color.parseColor("#00CCFF") }
        noSendTarget = glyph.isEmpty() && cardNumber.isEmpty()
        // A non-empty badge is the signal that the glyph is a WORKER's two
        // letters rather than a steading emoji (Josh 2026-09-10).
        val isWorker = glyph.isNotEmpty() && steadingBadge.isNotEmpty()

        stewardCircle?.apply {
            when {
                glyph.isNotEmpty() -> {
                    text = glyph
                    setTextColor(stewardColor)
                    background = circle(stewardColor)
                    // Two letters need a label treatment; an emoji does not.
                    textSize = if (isWorker) 18f else 22f
                    typeface = if (isWorker) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                    visibility = View.VISIBLE
                }
                // No target at all → keep a stop button in the slot, or the take
                // would be unstoppable from out here.
                noSendTarget -> {
                    text = "⏹"
                    setTextColor(red)
                    background = circle(red)
                    textSize = 22f
                    typeface = Typeface.DEFAULT
                    visibility = View.VISIBLE
                }
                else -> visibility = View.GONE
            }
        }
        // Corner badge — the steading emoji, only while on a worker. Recomputed
        // on every re-label so stepping back out to a top-level steward (or into
        // the stop-button state) drops it rather than leaving a stale claim.
        steadingBadgeView?.apply {
            if (isWorker && !noSendTarget) {
                text = steadingBadge
                visibility = View.VISIBLE
            } else {
                visibility = View.GONE
            }
        }
        cardCircle?.apply {
            if (cardNumber.isEmpty()) {
                visibility = View.GONE
            } else {
                text = cardNumber
                visibility = View.VISIBLE
            }
        }
    }

    private fun circle(ring: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.argb(235, 0x1A, 0x1A, 0x1A))
        setStroke(dp(2.5f), ring)
    }

    private fun solidCircle(fill: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(fill)
    }

    // ── Gestures ──
    // Same split as in the app (Josh 2026-09-05): the RIGHT button holds to drag
    // the pair, the LEFT button holds for the menu. Hand-rolled rather than using
    // setOnLongClickListener because the drag needs the raw stream anyway, and
    // both halves must agree on when a hold has turned into a move.

    private var downRawX = 0f
    private var downRawY = 0f
    private var downWinX = 0
    private var downWinY = 0
    private var holdArmed = false
    private var dragging = false
    private var tapDown = false
    private val holdHandler = android.os.Handler(android.os.Looper.getMainLooper())

    @SuppressLint("ClickableViewAccessibility")
    private fun wireRightButton(v: View, onTap: () -> Unit) {
        v.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    // He is using it — push the auto-collapse deadline out so the
                    // cluster cannot fold up under his thumb.
                    val lp = params
                    downRawX = e.rawX
                    downRawY = e.rawY
                    downWinX = lp?.x ?: 0
                    downWinY = lp?.y ?: 0
                    tapDown = true
                    holdArmed = false
                    dragging = false
                    holdHandler.postDelayed({
                        if (tapDown) {
                            holdArmed = true
                            vibrate()
                        }
                    }, LONG_PRESS_MS)
                }
                MotionEvent.ACTION_MOVE -> {
                    if (holdArmed) {
                        val dx = e.rawX - downRawX
                        val dy = e.rawY - downRawY
                        if (!dragging &&
                            kotlin.math.hypot(dx.toDouble(), dy.toDouble()) < DRAG_SLOP_DP * density
                        ) {
                            // Not far enough yet — a shaky thumb is not a drag.
                        } else {
                            dragging = true
                            val lp = params
                            if (lp != null) {
                                // Gravity is END|BOTTOM, so x grows LEFTWARD and y
                                // grows UPWARD — both are inverted against the raw
                                // finger delta.
                                lp.x = (downWinX - dx).toInt().coerceAtLeast(0)
                                lp.y = (downWinY - dy).toInt().coerceAtLeast(0)
                                try {
                                    windowManager.updateViewLayout(root, lp)
                                } catch (_: Exception) {
                                }
                            }
                        }
                    }
                }
                MotionEvent.ACTION_UP -> {
                    holdHandler.removeCallbacksAndMessages(null)
                    val wasDragging = dragging
                    val wasArmed = holdArmed
                    tapDown = false
                    holdArmed = false
                    dragging = false
                    if (wasDragging) {
                        params?.let { savePosition(it) }
                    } else if (!wasArmed) {
                        onTap()
                    }
                    // Held but never dragged → nothing. The move simply did not
                    // happen; this button has no menu.
                }
                MotionEvent.ACTION_CANCEL -> {
                    holdHandler.removeCallbacksAndMessages(null)
                    tapDown = false
                    holdArmed = false
                    dragging = false
                }
            }
            true
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun wireLeftButton(v: View, onTap: () -> Unit) {
        v.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    tapDown = true
                    holdArmed = false
                    holdHandler.postDelayed({
                        if (tapDown) {
                            holdArmed = true
                            vibrate()
                        }
                    }, LONG_PRESS_MS)
                }
                MotionEvent.ACTION_UP -> {
                    holdHandler.removeCallbacksAndMessages(null)
                    val wasArmed = holdArmed
                    tapDown = false
                    holdArmed = false
                    // The menu opens on RELEASE, not on the timer, so the buzz
                    // warns him before anything covers the screen.
                    if (wasArmed) onLongPress?.invoke() else onTap()
                }
                MotionEvent.ACTION_CANCEL -> {
                    holdHandler.removeCallbacksAndMessages(null)
                    tapDown = false
                    holdArmed = false
                }
            }
            true
        }
    }

    private fun vibrate(durationMs: Long = 20L, amplitude: Int = 80) {
        try {
            val vib = context.getSystemService(Context.VIBRATOR_SERVICE) as? android.os.Vibrator
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib?.vibrate(android.os.VibrationEffect.createOneShot(durationMs, amplitude))
            } else {
                @Suppress("DEPRECATION")
                vib?.vibrate(durationMs)
            }
        } catch (_: Exception) {
        }
    }

    /**
     * A firm, unmistakable buzz for the mode button.
     *
     * The 20ms/80 default is a "you are holding this" whisper. Josh asked for
     * this one to be FELT and reported 40ms/160 as still too weak, so it now
     * matches the app's own vibrateMedium — 100ms at full amplitude, the same
     * weight MainActivity already uses for confirmed actions. That is a known
     * reference point on this phone rather than another guess at a number.
     */
    private fun vibrateModeSwitch() =
        vibrate(100L, android.os.VibrationEffect.DEFAULT_AMPLITUDE)

    private fun build() {
        val size = dp(56f)

        // ── Recording state: steward + card send circles ──
        stewardCircle = TextView(context).apply {
            textSize = 22f
            gravity = Gravity.CENTER
            visibility = View.GONE
        }
        // WORKER corner badge (Josh 2026-09-10) — the steading's emoji, pinned to
        // the steward circle's top-right corner while he is on a worker. Takes no
        // touches, so the circle underneath stays one whole send target.
        steadingBadgeView = TextView(context).apply {
            textSize = 11f
            gravity = Gravity.CENTER
            visibility = View.GONE
            isClickable = false
            isFocusable = false
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.argb(255, 0x0A, 0x0A, 0x0A))
            }
        }
        cardCircle = TextView(context).apply {
            textSize = 20f
            gravity = Gravity.CENTER
            setTextColor(amber)
            typeface = Typeface.DEFAULT_BOLD
            background = circle(amber)
            visibility = View.GONE
        }

        // ── Idle state: keyboard + record ──
        keyboardCircle = TextView(context).apply {
            text = "⌨"
            textSize = 20f
            gravity = Gravity.CENTER
            setTextColor(amber)
            background = circle(amber)
        }
        recordCircle = TextView(context).apply {
            text = "🎤"  // 🎤
            textSize = 22f
            gravity = Gravity.CENTER
            background = solidCircle(orange)
        }

        // LEFT buttons hold for the menu; RIGHT buttons hold to drag.
        wireLeftButton(keyboardCircle!!) { onKeyboardTap?.invoke() }
        wireRightButton(recordCircle!!) { onRecordTap?.invoke() }
        wireLeftButton(stewardCircle!!) {
            if (noSendTarget) onRecordTap?.invoke() else onSendSteward?.invoke()
        }
        wireRightButton(cardCircle!!) { onSendCard?.invoke() }

        // ── RECORDING TIMER ──
        // Josh 2026-09-05: "the timer is gone from the version where the app is
        // showing… if we could actually have the timer up here as well, that'd be
        // perfecto." Same look as the in-app one, so the two read as one thing.
        timerView = TextView(context).apply {
            textSize = 14f
            setTextColor(red)
            typeface = Typeface.MONOSPACE
            gravity = Gravity.CENTER
            text = "0:00"
            background = GradientDrawable().apply {
                setColor(Color.argb(200, 0x1A, 0x1A, 0x1A))
                cornerRadius = 8f * density
            }
            setPadding(dp(10f), dp(4f), dp(10f), dp(4f))
            visibility = View.GONE
        }

        // ── RETURN BUTTON (Josh 2026-09-05) ──
        // "I would like the little third button that shows up above them to also
        // be visible at all times. And if I'm in a different app basically it
        // would take me back to Homestead… back to whatever default Homestead
        // screen is on right at that time. So if it's like on the phone mode
        // then it takes you back to phone… a way to leave that app and get back
        // to where you were."
        //
        // In the app this same small button switches modes; out here there is no
        // mode to switch, so it does the other half of the same idea — it takes
        // him to Homestead, in whichever mode he left it. One button, one
        // meaning: "get me to Homestead."
        val returnSize = dp(36f)
        returnCircle = TextView(context).apply {
            text = "⌂"  // house
            textSize = 18f
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#DDDDDD"))
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#252525"))
                setStroke(dp(2f), Color.parseColor("#555555"))
            }
        }
        // A left-button wiring so a hold still reaches the menu, keeping the
        // gesture rule intact: only the RIGHT button drags.
        wireLeftButton(returnCircle!!) {
            // Josh 2026-09-06: "the button that changes the mode from phone mode
            // to homestead mode, it doesn't vibrate the phone anymore. I liked
            // that sensation earlier. Can we return that?"
            //
            // Buzz on the press itself rather than inside the mode switch, so it
            // fires the same way whichever half of the button's job runs — mode
            // toggle in the app, return-to-Homestead outside it — and so it is
            // felt immediately rather than after the screen has changed.
            vibrateModeSwitch()
            onReturnTap?.invoke()
        }

        // ── PEEK DOT (Josh 2026-09-06) ──
        // "in the very lower right, like very lowest most right as of the screen,
        // like in the corner there should be like a small, there's like a small
        // dot that looks like it's kind of emerging from the right corner, kind
        // of like it's like trying to pop out, but not quite."
        //
        // Deliberately quiet: the same charcoal as the return button, a dim ring,
        // no glyph. Half of it hangs off the screen (see applyWindowPosition), so
        // what he actually sees is a slim crescent — present enough to find when
        // he wants it, dead enough to forget when he does not.
        // The circle itself is just a drawing. It is offset to the RIGHT inside a
        // much larger transparent parent, so the visible part is a crescent
        // hugging the screen edge while the TOUCHABLE area is the whole parent —
        // comfortably thumb-sized and entirely on screen.
        val peekCircle = View(context).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#252525"))
                setStroke(dp(1.5f), Color.parseColor("#666666"))
            }
        }
        peekDot = FrameLayout(context).apply {
            addView(peekCircle, FrameLayout.LayoutParams(
                dp(PEEK_SIZE_DP), dp(PEEK_SIZE_DP)
            ).apply {
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
                // Push the circle past the parent's right edge. The parent does
                // not clip, so the overhang is simply not drawn once it leaves
                // the screen — which is the "not quite popped out" look.
                rightMargin = -dp(PEEK_OFFSCREEN_DP)
            })
            clipChildren = false
            visibility = View.GONE
        }
        // Plain tap to expand — no hold, no drag. The dot has exactly one job.
        peekDot?.setOnClickListener {
            collapsed = false
            applyState()
            onExpanded?.invoke()
        }

        val pairRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            // The worker corner badge overhangs its circle — do not clip it off.
            clipChildren = false
            clipToPadding = false
            // Both states live in the same row; applyState shows one pair at a
            // time, so the buttons never move as the meaning changes.
            addView(keyboardCircle, LinearLayout.LayoutParams(size, size).apply {
                rightMargin = dp(10f)
            })
            addView(android.widget.FrameLayout(context).apply {
                // The badge overhangs the circle a touch; let it draw outside.
                clipChildren = false
                clipToPadding = false
                addView(stewardCircle, android.widget.FrameLayout.LayoutParams(size, size))
                addView(steadingBadgeView, android.widget.FrameLayout.LayoutParams(
                    android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                    android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    gravity = Gravity.END or Gravity.TOP
                    // Negative margins park the badge on the corner without
                    // asking the row for room to hold it.
                    marginEnd = dp(-3f)
                    topMargin = dp(-3f)
                })
                stewardSlot = this
            }, LinearLayout.LayoutParams(size, size).apply {
                rightMargin = dp(10f)
            })
            addView(recordCircle, LinearLayout.LayoutParams(size, size))
            addView(cardCircle, LinearLayout.LayoutParams(size, size))
        }

        root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.END
            // Timer on top, same as in the app.
            addView(timerView, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.END
                bottomMargin = dp(6f)
            })
            // Return button ABOVE the pair, centred over the right-hand (record)
            // button so the three read as one column — same shape as in the app.
            addView(returnCircle, LinearLayout.LayoutParams(returnSize, returnSize).apply {
                gravity = Gravity.END
                rightMargin = (size - returnSize) / 2
                bottomMargin = dp(10f)
            })
            addView(pairRow, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.END })
            // The collapsed dot lives in the same window as everything else, so
            // switching between them never tears the window down and rebuilds
            // it — it is only a visibility swap plus a move.
            addView(peekDot, LinearLayout.LayoutParams(
                dp(PEEK_TOUCH_DP), dp(PEEK_TOUCH_DP)
            ).apply { gravity = Gravity.END })
        }
    }
}
