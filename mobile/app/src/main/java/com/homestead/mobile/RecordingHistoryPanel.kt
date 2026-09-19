package com.homestead.mobile

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RecordingHistoryPanel(
    private val activity: Activity,
    private val recordingHistory: RecordingHistoryManager
) {
    private val dp = activity.resources.displayMetrics.density
    private val colorSurface = Color.parseColor("#1A1A1A")
    private val colorBackground = Color.parseColor("#0D0D0D")
    private val colorBorder = Color.parseColor("#2A2A2A")
    private val colorOrange = Color.parseColor("#FF6600")
    private val colorAmber = Color.parseColor("#FFBF00")
    private val colorGreen = Color.parseColor("#8EC07C")
    private val colorRed = Color.parseColor("#FF3333")
    private val colorTextDim = Color.parseColor("#888888")
    private val colorCyan = Color.parseColor("#00CCFF")

    private var overlay: FrameLayout? = null
    private var panel: LinearLayout? = null
    var isVisible = false
        private set

    var onResend: ((RecordingHistoryManager.Recording) -> Unit)? = null

    fun show(parent: ViewGroup) {
        if (isVisible) return
        isVisible = true

        val recordings = recordingHistory.getRecent(20)

        // Full-screen overlay
        overlay = FrameLayout(activity).apply {
            setBackgroundColor(Color.argb(180, 0, 0, 0))
            setOnClickListener { dismiss() }
        }

        // Panel slides up from bottom
        panel = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val bg = GradientDrawable().apply {
                setColor(colorBackground)
                cornerRadii = floatArrayOf(
                    16 * dp, 16 * dp, 16 * dp, 16 * dp,
                    0f, 0f, 0f, 0f
                )
            }
            background = bg
            elevation = 20 * dp
            setPadding(0, (12 * dp).toInt(), 0, 0)
        }

        // Handle bar
        val handle = View(activity).apply {
            val handleBg = GradientDrawable().apply {
                setColor(colorBorder)
                cornerRadius = 2 * dp
            }
            background = handleBg
        }
        panel!!.addView(handle, LinearLayout.LayoutParams(
            (40 * dp).toInt(), (4 * dp).toInt()
        ).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = (8 * dp).toInt() })

        // Title
        val title = TextView(activity).apply {
            text = "Recording History"
            textSize = 18f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            setPadding((16 * dp).toInt(), (8 * dp).toInt(), (16 * dp).toInt(), (12 * dp).toInt())
        }
        panel!!.addView(title)

        // Scrollable list
        val scrollView = ScrollView(activity).apply {
            isVerticalScrollBarEnabled = true
        }
        val listContainer = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((12 * dp).toInt(), 0, (12 * dp).toInt(), (16 * dp).toInt())
        }

        if (recordings.isEmpty()) {
            val empty = TextView(activity).apply {
                text = "No recordings yet"
                textSize = 14f
                setTextColor(colorTextDim)
                gravity = Gravity.CENTER
                setPadding(0, (32 * dp).toInt(), 0, (32 * dp).toInt())
            }
            listContainer.addView(empty)
        } else {
            val timeFormat = SimpleDateFormat("h:mm a", Locale.US)
            val dateFormat = SimpleDateFormat("MMM d", Locale.US)
            val today = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())

            recordings.forEach { rec ->
                val row = buildRecordingRow(rec, timeFormat, dateFormat, today)
                listContainer.addView(row)
            }
        }

        scrollView.addView(listContainer)
        panel!!.addView(scrollView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ))

        // Add to parent
        val overlayParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        parent.addView(overlay, overlayParams)

        val panelHeight = (activity.resources.displayMetrics.heightPixels * 0.6).toInt()
        val panelParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            panelHeight
        ).apply { gravity = Gravity.BOTTOM }
        parent.addView(panel, panelParams)

        // Animate slide up
        panel!!.translationY = panelHeight.toFloat()
        panel!!.animate()
            .translationY(0f)
            .setDuration(250)
            .setInterpolator(AccelerateDecelerateInterpolator())
            .start()

        overlay!!.alpha = 0f
        overlay!!.animate().alpha(1f).setDuration(200).start()
    }

    fun dismiss() {
        if (!isVisible) return
        isVisible = false

        val panelView = panel ?: return
        val overlayView = overlay ?: return

        panelView.animate()
            .translationY(panelView.height.toFloat())
            .setDuration(200)
            .withEndAction {
                (panelView.parent as? ViewGroup)?.removeView(panelView)
                (overlayView.parent as? ViewGroup)?.removeView(overlayView)
                panel = null
                overlay = null
            }
            .start()

        overlayView.animate().alpha(0f).setDuration(200).start()
    }

    private fun buildRecordingRow(
        rec: RecordingHistoryManager.Recording,
        timeFormat: SimpleDateFormat,
        dateFormat: SimpleDateFormat,
        today: String
    ): LinearLayout {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val bg = GradientDrawable().apply {
                setColor(colorSurface)
                cornerRadius = 8 * dp
                setStroke((1 * dp).toInt(), colorBorder)
            }
            background = bg
            setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = (8 * dp).toInt() }
            layoutParams = lp
        }

        // Top row: time + status badge
        val topRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val recDate = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date(rec.timestamp))
        val timeText = if (recDate == today) {
            timeFormat.format(Date(rec.timestamp))
        } else {
            "${dateFormat.format(Date(rec.timestamp))} ${timeFormat.format(Date(rec.timestamp))}"
        }

        val timeView = TextView(activity).apply {
            text = timeText
            textSize = 12f
            setTextColor(colorTextDim)
        }
        topRow.addView(timeView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        // Status badge
        val (badgeText, badgeColor) = when (rec.sendStatus) {
            RecordingHistoryManager.Recording.SendStatus.SENT -> (rec.destination?.removePrefix("holler-") ?: "sent") to colorGreen
            RecordingHistoryManager.Recording.SendStatus.FAILED -> "failed" to colorRed
            RecordingHistoryManager.Recording.SendStatus.UNSENT -> "unsent" to colorOrange
        }
        val badge = TextView(activity).apply {
            text = badgeText
            textSize = 11f
            setTextColor(badgeColor)
            typeface = Typeface.DEFAULT_BOLD
            val badgeBg = GradientDrawable().apply {
                setColor(Color.argb(40, Color.red(badgeColor), Color.green(badgeColor), Color.blue(badgeColor)))
                cornerRadius = 4 * dp
            }
            background = badgeBg
            setPadding((6 * dp).toInt(), (2 * dp).toInt(), (6 * dp).toInt(), (2 * dp).toInt())
        }
        topRow.addView(badge)
        row.addView(topRow)

        // Transcript preview
        if (!rec.transcript.isNullOrBlank()) {
            val preview = TextView(activity).apply {
                text = rec.transcript.take(120) + if (rec.transcript.length > 120) "..." else ""
                textSize = 13f
                setTextColor(Color.parseColor("#CCCCCC"))
                maxLines = 2
                setPadding(0, (4 * dp).toInt(), 0, 0)
            }
            row.addView(preview)
        }

        // Tap to resend (unsent or failed recordings)
        if (rec.sendStatus != RecordingHistoryManager.Recording.SendStatus.SENT) {
            val resendHint = TextView(activity).apply {
                text = "Tap to send"
                textSize = 11f
                setTextColor(colorCyan)
                setPadding(0, (4 * dp).toInt(), 0, 0)
            }
            row.addView(resendHint)
            row.setOnClickListener {
                dismiss()
                onResend?.invoke(rec)
            }
        } else {
            // Sent recordings can be resent too
            val resendHint = TextView(activity).apply {
                text = "Tap to resend"
                textSize = 11f
                setTextColor(colorTextDim)
                setPadding(0, (4 * dp).toInt(), 0, 0)
            }
            row.addView(resendHint)
            row.setOnClickListener {
                dismiss()
                onResend?.invoke(rec)
            }
        }

        return row
    }
}
