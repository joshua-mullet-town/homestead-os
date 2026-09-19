package com.homestead.mobile

import android.app.WallpaperManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.text.format.DateFormat
import android.util.AttributeSet
import android.view.View
import androidx.core.content.res.ResourcesCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The Phone-mode clock — "Stacked Monolith".
 *
 * Hours on one line, minutes stacked directly beneath, both oversized and
 * flush-left, with the date underneath in letter-spaced small caps. Asymmetric
 * on purpose: left-aligned rather than centred is what keeps it from reading as
 * stock Android.
 *
 * Drawn on a Canvas rather than assembled from TextViews so the leading between
 * the two lines can be driven from real glyph bounds — TextView leading at this
 * size leaves a large dead gap that no amount of negative margin fixes cleanly.
 *
 * Two details that matter more than they look:
 *  - Digits are rendered with tabular figures ("tnum"). Without it the clock
 *    visibly jitters sideways as the digits change, because Inter's default
 *    figures are proportional.
 *  - Every glyph gets a stroke halo pass before the fill pass. This sits on top
 *    of Joshua's own wallpaper, which could be anything, and a plain shadow
 *    disappears over a busy mid-tone photo.
 */
class PhoneModeClock @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0
) : View(context, attrs, defStyle) {

    private val dp = resources.displayMetrics.density

    // Sized off the screen so this doesn't blow out on a small phone.
    private val timeSize = (resources.displayMetrics.widthPixels * 0.30f)
    private val dateSize = 13f * dp

    private val fontThin: Typeface? =
        ResourcesCompat.getFont(context, R.font.space_grotesk_variable)
            ?: Typeface.create("sans-serif-thin", Typeface.NORMAL)
    private val fontDate: Typeface? =
        ResourcesCompat.getFont(context, R.font.inter_medium)
            ?: Typeface.create("sans-serif-medium", Typeface.NORMAL)

    /** Fill pass for the two big time lines. */
    private val timePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontThin
        textSize = timeSize
        color = Color.WHITE
        // Tabular figures — stops the clock shifting as digits change.
        fontFeatureSettings = "tnum"
    }

    /** Halo pass — same glyphs, drawn first, so the fill reads on any wallpaper. */
    private val timeHalo = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontThin
        textSize = timeSize
        style = Paint.Style.STROKE
        strokeWidth = 5f * dp
        strokeJoin = Paint.Join.ROUND
        color = Color.argb(90, 0, 0, 0)
        fontFeatureSettings = "tnum"
    }

    private val datePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontDate
        textSize = dateSize
        color = Color.WHITE
        letterSpacing = 0.18f
    }

    /** Secondary date line — same face, dimmed so it reads as supporting detail. */
    private val dateSubPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontDate
        textSize = dateSize * 0.92f
        color = Color.argb(190, 255, 255, 255)
        letterSpacing = 0.14f
    }

    /**
     * Halo for the secondary date line.
     *
     * Must carry the SAME textSize and letterSpacing as dateSubPaint. Reusing the
     * full-size dateHalo here drew a larger glyph outline behind smaller text,
     * which read as a boxy shadow smear rather than an outline.
     */
    private val dateSubHalo = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontDate
        textSize = dateSize * 0.92f
        style = Paint.Style.STROKE
        strokeWidth = 3f * dp
        strokeJoin = Paint.Join.ROUND
        color = Color.argb(90, 0, 0, 0)
        letterSpacing = 0.14f
    }

    private val dateHalo = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontDate
        textSize = dateSize
        style = Paint.Style.STROKE
        strokeWidth = 3f * dp
        strokeJoin = Paint.Join.ROUND
        color = Color.argb(90, 0, 0, 0)
        letterSpacing = 0.18f
    }

    private var hours = ""
    private var minutes = ""
    private var dateLine = ""
    private var dateLine2 = ""

    /** Bottom of the time block / top of the date block — splits the tap areas. */
    private var timeBlockBottom = 0f

    private val bounds = Rect()
    private val leftInset = 4f * dp

    init {
        refresh()
        applyWallpaperContrast()
    }

    /** Re-read the wall clock. Cheap — safe to call on every resume and tick. */
    fun refresh() {
        val now = Date()
        val h = if (DateFormat.is24HourFormat(context)) "HH" else "h"
        hours = SimpleDateFormat(h, Locale.getDefault()).format(now)
        minutes = SimpleDateFormat("mm", Locale.getDefault()).format(now)
        // Josh asked for "the whole bit": weekday, month name AND number, day,
        // year, week of year. Split over two lines so it stays readable rather
        // than becoming one long ribbon of text.
        val cal = java.util.Calendar.getInstance()
        val week = cal.get(java.util.Calendar.WEEK_OF_YEAR)
        dateLine = SimpleDateFormat("EEEE, MMMM d, yyyy", Locale.getDefault())
            .format(now).uppercase(Locale.getDefault())
        val monthNum = SimpleDateFormat("MM", Locale.getDefault()).format(now)
        val dayNum = SimpleDateFormat("dd", Locale.getDefault()).format(now)
        dateLine2 = "$monthNum/$dayNum · WEEK $week"
        invalidate()
    }

    /**
     * Flip to dark glyphs when the wallpaper is light enough to ask for it.
     *
     * getWallpaperColors() only reports colours, so unlike getDrawable() it needs
     * no storage permission and won't throw on Android 14. When the hint is
     * absent (older API, or a wallpaper that doesn't publish one) we stay with
     * the white-on-halo treatment, which is the safe default.
     */
    private fun applyWallpaperContrast() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) return
        val wantsDarkText = try {
            val colors = WallpaperManager.getInstance(context)
                .getWallpaperColors(WallpaperManager.FLAG_SYSTEM)
            val hints = colors?.colorHints ?: 0
            (hints and android.app.WallpaperColors.HINT_SUPPORTS_DARK_TEXT) != 0
        } catch (e: Exception) {
            false
        }

        if (wantsDarkText) {
            val ink = Color.parseColor("#101010")
            timePaint.color = ink
            datePaint.color = ink
            dateSubPaint.color = Color.argb(190, 16, 16, 16)
            // Invert the halo too, or dark glyphs sit on a dark outline and muddy.
            val veil = Color.argb(70, 255, 255, 255)
            timeHalo.color = veil
            dateHalo.color = veil
            dateSubHalo.color = veil
        }
        invalidate()
    }

    /** Re-check wallpaper brightness — the wallpaper can change while we're alive. */
    fun refreshContrast() = applyWallpaperContrast()

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // Two stacked time lines, tightened, plus the date line and its gap.
        val lineH = glyphHeight(timePaint, "8")
        val dateH = glyphHeight(datePaint, "M")
        val total = (lineH * 2f * LINE_TIGHTEN) + (18f * dp) + dateH +
            (8f * dp) + dateH + (10f * dp)
        setMeasuredDimension(
            resolveSize(widthMeasureSpec.let { MeasureSpec.getSize(it) }, widthMeasureSpec),
            resolveSize(total.toInt(), heightMeasureSpec)
        )
    }

    override fun onDraw(canvas: Canvas) {
        val lineH = glyphHeight(timePaint, "8")

        // Baselines derived from real glyph bounds, not font metrics — Space
        // Grotesk's ascent includes accent space we don't want at this size.
        var y = lineH
        drawHaloed(canvas, hours, leftInset, y, timePaint, timeHalo)

        y += lineH * LINE_TIGHTEN
        drawHaloed(canvas, minutes, leftInset, y, timePaint, timeHalo)

        // Everything above this point is the TIME tap target; below is the DATE.
        timeBlockBottom = y + (9f * dp)

        val dateH = glyphHeight(datePaint, "M")
        y += 18f * dp + dateH
        drawHaloed(canvas, dateLine, leftInset + 2f * dp, y, datePaint, dateHalo)

        y += 8f * dp + dateH
        drawHaloed(canvas, dateLine2, leftInset + 2f * dp, y, dateSubPaint, dateSubHalo)
    }

    /** True when [y] (view-local) falls in the time block rather than the date. */
    fun isTimeRegion(y: Float): Boolean = y <= timeBlockBottom

    private fun drawHaloed(c: Canvas, text: String, x: Float, y: Float, fill: Paint, halo: Paint) {
        if (text.isEmpty()) return
        c.drawText(text, x, y, halo)
        c.drawText(text, x, y, fill)
    }

    /** Height of the actual inked glyph, ignoring the font's reserved padding. */
    private fun glyphHeight(paint: Paint, sample: String): Float {
        paint.getTextBounds(sample, 0, sample.length, bounds)
        return bounds.height().toFloat()
    }

    companion object {
        /**
         * Baseline-to-baseline distance for the two time lines, as a multiple of
         * inked glyph height. Must stay above 1.0: glyph height measures only the
         * inked box of "8", so anything below 1.0 drives the second line up INTO
         * the first. 1.12 leaves a tight-but-clean gap — verified against a
         * render rather than eyeballed from the constant.
         */
        private const val LINE_TIGHTEN = 1.12f
    }
}
