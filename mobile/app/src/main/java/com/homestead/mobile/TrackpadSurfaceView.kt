package com.homestead.mobile

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sign

/**
 * Native trackpad surface for the Homestead mobile presenter overlay.
 *
 * Reuses the gesture model from the standalone phone-mouse app, ported to
 * Android Views (instead of WebView Pointer Events):
 *   1-finger drag → onMoveDelta (cursor move with non-linear acceleration)
 *   1-finger tap (no slop, fast) → onTap (the SURFACE itself is the click button)
 *   1-finger fast double-tap → onDoubleTap
 *   2-finger drag → onScroll (accumulate-and-flush at 2.5px)
 *
 * 3-finger swipe was pulled — Joshua's phone doesn't reliably emit 3-pointer
 * events at the count we need.
 *
 * Mode latching: once a multi-finger mode (Scroll) is engaged we hold it
 * until ALL fingers lift — never demote back to Drag mid-gesture, because
 * Android's spiteful-giant-delta on uneven multi-finger lifts will fly the
 * cursor across the screen. (Same defense as PointerSurfaceView in
 * phone-mouse standalone.)
 */
class TrackpadSurfaceView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0
) : View(context, attrs, defStyle) {

    interface Callbacks {
        fun onMoveDelta(dx: Float, dy: Float)
        fun onTap()
        fun onDoubleTap()
        fun onScroll(dx: Float, dy: Float)
    }

    var callbacks: Callbacks? = null
    var sensitivity: Float = 1.6f

    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private val scrollFlushThreshold = 2.5f

    private val tapMaxMs = 220L
    private val doubleTapWindowMs = 320L

    private enum class Mode { Idle, Drag, Scroll }
    private var mode = Mode.Idle

    private var lastX = 0f
    private var lastY = 0f
    private var downX = 0f
    private var downY = 0f
    private var downTime = 0L
    private var movedBeyondSlop = false
    private var activePointerId = -1
    private var lastTapTime = 0L

    private var scrollLastCenterX = 0f
    private var scrollLastCenterY = 0f
    private var scrollAccumX = 0f
    private var scrollAccumY = 0f
    private var scrollSettleCount = 0

    // Visual: subtle gradient + hint text. Avoids hard-coded font-family per
    // Joshua's repeat correction — uses theme default by relying on the
    // platform Paint's default typeface (no explicit setTypeface call).
    private val bgPaint = Paint().apply { color = Color.parseColor("#161A20") }
    private val borderPaint = Paint().apply {
        color = Color.parseColor("#2A2F38")
        style = Paint.Style.STROKE
        strokeWidth = 2f * resources.displayMetrics.density
    }
    private val hintPaint = Paint().apply {
        color = Color.parseColor("#5A5F6A")
        textSize = 13f * resources.displayMetrics.density
        textAlign = Paint.Align.CENTER
        isAntiAlias = true
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val r = (12f * resources.displayMetrics.density)
        canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, bgPaint)
        canvas.drawRoundRect(1f, 1f, width - 1f, height - 1f, r, r, borderPaint)
        // Hint only when idle and there's room
        if (mode == Mode.Idle && width > 200) {
            val hint = "Drag to move • Tap to click • 2-finger drag to scroll"
            canvas.drawText(hint, width / 2f, height / 2f, hintPaint)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                activePointerId = event.getPointerId(0)
                lastX = event.getX(0); lastY = event.getY(0)
                downX = lastX; downY = lastY
                downTime = event.eventTime
                movedBeyondSlop = false
                mode = Mode.Drag
                invalidate()
                return true
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount == 2) enterScroll(event)
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                when (mode) {
                    Mode.Drag -> handleDragMove(event)
                    Mode.Scroll -> handleScrollMove(event)
                    Mode.Idle -> {}
                }
                return true
            }
            MotionEvent.ACTION_POINTER_UP -> {
                // Latched — never demote.
                return true
            }
            MotionEvent.ACTION_UP -> {
                onAllUp(event)
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                resetAll()
                invalidate()
                return true
            }
        }
        return false
    }

    private fun handleDragMove(event: MotionEvent) {
        val idx = event.findPointerIndex(activePointerId)
        if (idx < 0) return
        // Drain history for smooth deltas at high frame rates.
        for (h in 0 until event.historySize) {
            val hx = event.getHistoricalX(idx, h)
            val hy = event.getHistoricalY(idx, h)
            emitDragDelta(hx - lastX, hy - lastY)
            lastX = hx; lastY = hy
        }
        val nx = event.getX(idx); val ny = event.getY(idx)
        emitDragDelta(nx - lastX, ny - lastY)
        lastX = nx; lastY = ny
        if (!movedBeyondSlop) {
            if (abs(lastX - downX) > touchSlop || abs(lastY - downY) > touchSlop) {
                movedBeyondSlop = true
            }
        }
    }

    private fun emitDragDelta(rawDx: Float, rawDy: Float) {
        if (rawDx == 0f && rawDy == 0f) return
        val ax = sign(rawDx) * abs(rawDx).toDouble().pow(1.4).toFloat() * sensitivity
        val ay = sign(rawDy) * abs(rawDy).toDouble().pow(1.4).toFloat() * sensitivity
        callbacks?.onMoveDelta(ax, ay)
    }

    private fun enterScroll(event: MotionEvent) {
        mode = Mode.Scroll
        val (cx, cy) = pointerCenter(event, 2)
        scrollLastCenterX = cx; scrollLastCenterY = cy
        scrollAccumX = 0f; scrollAccumY = 0f
        scrollSettleCount = 2  // drop first 2 deltas (multi-finger transition spike)
    }

    private fun handleScrollMove(event: MotionEvent) {
        if (event.pointerCount < 2) return
        val (cx, cy) = pointerCenter(event, 2)
        val dx = cx - scrollLastCenterX
        val dy = cy - scrollLastCenterY
        scrollLastCenterX = cx; scrollLastCenterY = cy
        if (scrollSettleCount > 0) { scrollSettleCount--; return }
        scrollAccumX += dx; scrollAccumY += dy
        if (abs(scrollAccumX) >= scrollFlushThreshold || abs(scrollAccumY) >= scrollFlushThreshold) {
            callbacks?.onScroll(scrollAccumX, scrollAccumY)
            scrollAccumX = 0f; scrollAccumY = 0f
        }
    }

    private fun onAllUp(event: MotionEvent) {
        val wasDrag = (mode == Mode.Drag)
        val noSlop = !movedBeyondSlop
        val fast = (event.eventTime - downTime) <= tapMaxMs
        if (wasDrag && noSlop && fast) {
            val now = event.eventTime
            if (now - lastTapTime <= doubleTapWindowMs) {
                callbacks?.onDoubleTap()
                lastTapTime = 0L
            } else {
                callbacks?.onTap()
                lastTapTime = now
            }
        }
        resetAll()
        invalidate()
    }

    private fun pointerCenter(event: MotionEvent, maxPointers: Int): Pair<Float, Float> {
        var sx = 0f; var sy = 0f
        val n = minOf(event.pointerCount, maxPointers)
        for (i in 0 until n) { sx += event.getX(i); sy += event.getY(i) }
        return Pair(sx / n, sy / n)
    }

    private fun resetAll() {
        mode = Mode.Idle
        activePointerId = -1
        movedBeyondSlop = false
        scrollAccumX = 0f; scrollAccumY = 0f
        scrollSettleCount = 0
    }
}
