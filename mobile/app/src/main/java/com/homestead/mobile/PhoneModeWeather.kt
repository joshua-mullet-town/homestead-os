package com.homestead.mobile

import android.content.Context
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import androidx.core.content.res.ResourcesCompat
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The phone-mode weather corner — "the Ribbon".
 *
 * Two halves, and the split is the point: TODAY IS THE HEADLINE, the week is the
 * supporting row underneath. The big current temperature, the condition, and
 * today's high/low sit on top at a size you read without focusing; the six-day
 * ribbon is the fine print below it.
 *
 * One pill per day. Each pill carries four things at once, and the whole point
 * of the design is that none of them compete for the same pixels:
 *
 *  - HIGH and LOW  — real numbers above and below the pill.
 *  - TEMPERATURE   — a bar whose top is the high and bottom is the low, drawn
 *                    on a FIXED whole-year scale so its position means the same
 *                    thing in January as in July, and coloured blue-to-orange.
 *  - HUMIDITY      — the pill fills like a gauge, 0-100%, with a soft wavy top.
 *  - RAIN          — a thin strip along the floor, lit under whichever quarter
 *                    of the day it actually rains.
 *
 * Drawn on a Canvas rather than assembled from child views: six pills each with
 * a gauge, a bar, a wavy fog edge and a four-segment strip would be ~40 views
 * re-laid-out on every forecast update, and the wavy edge isn't expressible as
 * a background drawable anyway.
 *
 * Nothing here is opaque. Phone mode shows the real system wallpaper through a
 * transparent window (MainActivity's FLAG_SHOW_WALLPAPER), so every fill is
 * semi-transparent and the wallpaper composites straight through the corner.
 */
class PhoneModeWeather @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0
) : View(context, attrs, defStyle) {

    private val dp = resources.displayMetrics.density

    companion object {
        /**
         * The whole-year temperature scale, in Fahrenheit.
         *
         * Elkhart's real recorded span over the last year was -12F to 92F, so
         * this bounds it with a little headroom. Fixed on purpose: a scale that
         * re-fit itself to each week would make a January cold snap and a mild
         * September week fill the track identically, and the bar's height would
         * stop meaning "cold" at all.
         */
        private const val SCALE_MIN = -10f
        private const val SCALE_MAX = 95f

        /** Below this, a quarter's rain chance isn't worth lighting up. */
        private const val RAIN_FLOOR = 8
    }

    private var days: List<WeatherRepository.Day> = emptyList()
    private var now: WeatherRepository.Now? = null

    // ── geometry, all in px ──
    private val pillW = 19f * dp
    private val pillH = 78f * dp
    private val pillGap = 6f * dp
    private val barW = 5f * dp
    private val rainH = 6.5f * dp
    private val rainInset = 2f * dp
    private val labelGap = 3f * dp

    private val fontNum: Typeface? =
        ResourcesCompat.getFont(context, R.font.space_grotesk_variable)
            ?: Typeface.create("sans-serif", Typeface.NORMAL)
    private val fontLabel: Typeface? =
        ResourcesCompat.getFont(context, R.font.inter_medium)
            ?: Typeface.create("sans-serif-medium", Typeface.NORMAL)

    private val dayPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontLabel
        textSize = 8f * dp
        color = Color.argb(150, 255, 255, 255)
        letterSpacing = 0.04f
        textAlign = Paint.Align.CENTER
    }
    /**
     * Today's dot. Brighter than the day letters on purpose — it's the one slot
     * in the row you should find without looking for it, and the ribbon has no
     * other way to say "here" now that the word is gone.
     */
    private val todayDotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.FILL
    }
    /** Same halo the glyphs get, for the same reason: arbitrary wallpaper. */
    private val todayDotHalo = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(105, 0, 0, 0)
        style = Paint.Style.FILL
    }

    private val highPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontNum
        textSize = 10.5f * dp
        color = Color.WHITE
        isFakeBoldText = true
        fontFeatureSettings = "tnum"
        textAlign = Paint.Align.CENTER
    }
    private val lowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontNum
        textSize = 9.5f * dp
        color = Color.argb(155, 255, 255, 255)
        fontFeatureSettings = "tnum"
        textAlign = Paint.Align.CENTER
    }

    /**
     * Halo pass behind every glyph.
     *
     * This sits on top of Joshua's own wallpaper, which could be any photo — a
     * plain drop shadow disappears over a busy mid-tone image, an outline
     * doesn't. Same treatment the clock uses, for the same reason.
     */
    private val textHalo = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f * dp
        strokeJoin = Paint.Join.ROUND
        color = Color.argb(105, 0, 0, 0)
        textAlign = Paint.Align.CENTER
    }

    /** Vertical gaps inside the headline block. The gap under the big number is
     *  larger than the others: at 40sp the condition line otherwise crowds the
     *  degree sign. */
    private val nowGap = 4f * dp
    private val bigGap = 9f * dp
    private val dividerGap = 11f * dp

    // ── the headline: today, big ──
    private val nowTempPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontNum
        textSize = 40f * dp
        color = Color.WHITE
        fontFeatureSettings = "tnum"
        textAlign = Paint.Align.RIGHT
    }
    private val condPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontLabel
        textSize = 11.5f * dp
        color = Color.argb(225, 255, 255, 255)
        textAlign = Paint.Align.RIGHT
    }
    private val todayRangePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = fontNum
        textSize = 11f * dp
        color = Color.argb(175, 255, 255, 255)
        fontFeatureSettings = "tnum"
        textAlign = Paint.Align.RIGHT
    }
    /** Hairline between the headline and the week — a rule, not a box. */
    private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(58, 255, 255, 255)
    }

    private val pillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(38, 255, 255, 255)
    }
    private val fogPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        // Deliberately faint. The fill LEVEL carries the humidity reading (a
        // true 0-100% of the pill), so the ink only has to make that level
        // visible — any heavier and six 65-90% pills read as solid blocks and
        // swamp the temperature bar they sit behind.
        color = Color.argb(44, 255, 255, 255)
    }
    /** Soft crest on the fog so its top edge reads as mist, not a ruled line. */
    private val fogEdgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.4f * dp
        // The crest is what you actually read the level off, so it stays
        // brighter than the body it caps.
        color = Color.argb(165, 255, 255, 255)
        maskFilter = BlurMaskFilter(2.6f * dp, BlurMaskFilter.Blur.NORMAL)
    }
    private val barPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    /** Dark rim so the bar still reads when the fog behind it is bright. */
    private val barRim = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.25f * dp
        color = Color.argb(110, 0, 0, 0)
    }
    private val rainTrack = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(34, 255, 255, 255)
    }
    private val rainPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    private val rect = RectF()
    private val fogPath = Path()
    private val bounds = Rect()

    fun setForecast(forecast: WeatherRepository.Forecast) {
        days = forecast.days
        now = forecast.now
        requestLayout()
        invalidate()
    }

    /** Temperature -> colour. Deep blue when frozen, orange when hot. */
    private fun tempColor(t: Float): Int = when {
        t <= 32f -> Color.rgb(0x6F, 0x9E, 0xD6)
        t <= 45f -> Color.rgb(0x8F, 0xB4, 0xE8)
        t <= 58f -> Color.rgb(0xA9, 0xBC, 0xC4)
        t <= 70f -> Color.rgb(0xD8, 0xB9, 0x8B)
        t <= 82f -> Color.rgb(0xE8, 0xA0, 0x5E)
        else -> Color.rgb(0xE0, 0x7A, 0x3C)
    }

    /** Where a temperature sits on the fixed scale: 0 at the top, 1 at the floor. */
    private fun scalePos(t: Float): Float =
        ((SCALE_MAX - t) / (SCALE_MAX - SCALE_MIN)).coerceIn(0f, 1f)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val n = days.size
        val ribbonW = if (n == 0) 0f else n * pillW + (n - 1) * pillGap
        // The headline can be wider than the ribbon ("Partly cloudy" beats six
        // pills on a narrow screen), and it's right-aligned — so measure both
        // and take the wider, or it gets clipped at the left edge.
        val headW = now?.let { cur ->
            maxOf(
                nowTempPaint.measureText("${cur.temp}°"),
                condPaint.measureText(cur.conditionText),
                days.firstOrNull()?.let {
                    todayRangePaint.measureText("${it.high}° / ${it.low}°")
                } ?: 0f
            )
        } ?: 0f
        val w = maxOf(ribbonW, headW)
        val textH = glyphH(dayPaint) + glyphH(highPaint) + glyphH(lowPaint)
        val h = headlineHeight() + pillH + textH + labelGap * 4
        setMeasuredDimension(
            resolveSize(Math.ceil(w.toDouble()).toInt(), widthMeasureSpec),
            resolveSize(Math.ceil(h.toDouble()).toInt(), heightMeasureSpec)
        )
    }

    /** Total height of the headline block, including its divider. Zero if we
     *  have no current reading yet — the ribbon then sits on its own. */
    private fun headlineHeight(): Float {
        if (now == null) return 0f
        return glyphH(nowTempPaint) + bigGap + glyphH(condPaint) + nowGap +
            glyphH(todayRangePaint) + dividerGap * 2f
    }

    private fun glyphH(p: Paint): Float {
        p.getTextBounds("8", 0, 1, bounds)
        return bounds.height().toFloat()
    }

    override fun onDraw(canvas: Canvas) {
        if (days.isEmpty()) return

        val dayH = glyphH(dayPaint)
        val hiH = glyphH(highPaint)
        val loH = glyphH(lowPaint)

        // ── HEADLINE: today, big, right-aligned to the screen edge ──
        // Josh: the week bars were always "the bottom part of the cake" — today
        // is what he actually looks at, so it gets the size.
        var headBottom = 0f
        now?.let { n ->
            val right = width.toFloat()
            var y = glyphH(nowTempPaint)
            drawRight(canvas, "${n.temp}\u00B0", right, y, nowTempPaint)
            val cond = n.conditionText
            if (cond.isNotEmpty()) {
                y += bigGap + glyphH(condPaint)
                drawRight(canvas, cond, right, y, condPaint)
            }
            days.firstOrNull()?.let { today ->
                y += nowGap + glyphH(todayRangePaint)
                drawRight(canvas, "${today.high}\u00B0 / ${today.low}\u00B0",
                    right, y, todayRangePaint)
            }
            // Hairline rule: says "the week starts here" without drawing a box,
            // which would break the see-through-to-wallpaper rule.
            y += dividerGap
            val ruleW = width * 0.62f
            canvas.drawRect(right - ruleW, y, right, y + 1f * dp, dividerPaint)
            headBottom = y + dividerGap
        }

        // Right-aligned: the corner grows leftward from the screen edge, so the
        // pills stay pinned to the right however many days we have.
        val totalW = days.size * pillW + (days.size - 1) * pillGap
        var x = width - totalW

        val dayBase = headBottom + dayH
        val hiBase = dayBase + labelGap + hiH
        val pillTop = hiBase + labelGap
        val pillBottom = pillTop + pillH
        val loBase = pillBottom + labelGap + loH

        for (day in days) {
            val cx = x + pillW / 2f

            drawDayLabel(canvas, day.label, cx, dayBase, dayH)
            drawText(canvas, day.high.toString(), cx, hiBase, highPaint)

            drawPill(canvas, x, pillTop, day)

            drawText(canvas, day.low.toString(), cx, loBase, lowPaint)

            x += pillW + pillGap
        }
    }

    /** Right-aligned draw for the headline, with the same halo treatment. */
    private fun drawRight(canvas: Canvas, s: String, right: Float, baseline: Float, paint: Paint) {
        textHalo.typeface = paint.typeface
        textHalo.textSize = paint.textSize
        textHalo.letterSpacing = paint.letterSpacing
        textHalo.isFakeBoldText = paint.isFakeBoldText
        textHalo.textAlign = Paint.Align.RIGHT
        canvas.drawText(s, right, baseline, textHalo)
        canvas.drawText(s, right, baseline, paint)
        textHalo.textAlign = Paint.Align.CENTER
    }

    /**
     * The day letter — or, for today, a dot.
     *
     * Today is marked rather than named. The letter it would otherwise take is
     * "T", which already stands for both Tuesday and Thursday in a one-letter
     * row, so a mark is the only thing here that can't be misread as a day.
     *
     * Drawn as a real circle instead of a bullet glyph: at this size a "\u25CF"
     * sits high off the text baseline and renders at whatever weight the font
     * happens to give it, so it wouldn't line up with the letters beside it.
     * A circle centred on the letters' own optical middle does.
     */
    private fun drawDayLabel(
        canvas: Canvas,
        label: String,
        cx: Float,
        baseline: Float,
        dayH: Float
    ) {
        if (label != WeatherRepository.TODAY_LABEL) {
            drawText(canvas, label, cx, baseline, dayPaint)
            return
        }
        // Centre on the letters' own middle, so the dot sits on the same
        // optical line as the rest of the row rather than on the baseline.
        val cy = baseline - dayH / 2f
        val r = 2.6f * dp
        canvas.drawCircle(cx, cy, r + 1.2f * dp, todayDotHalo)
        canvas.drawCircle(cx, cy, r, todayDotPaint)
    }

    private fun drawText(canvas: Canvas, s: String, cx: Float, baseline: Float, paint: Paint) {
        textHalo.typeface = paint.typeface
        textHalo.textSize = paint.textSize
        textHalo.letterSpacing = paint.letterSpacing
        textHalo.isFakeBoldText = paint.isFakeBoldText
        canvas.drawText(s, cx, baseline, textHalo)
        canvas.drawText(s, cx, baseline, paint)
    }

    private fun drawPill(canvas: Canvas, left: Float, top: Float, day: WeatherRepository.Day) {
        val right = left + pillW
        val bottom = top + pillH
        val radius = pillW / 2f

        // ── the pill itself ──
        rect.set(left, top, right, bottom)
        canvas.drawRoundRect(rect, radius, radius, pillPaint)

        // ── HUMIDITY: fill the pill to an honest 0-100% level ──
        // Josh asked for a real gauge rather than an opacity wash: "an actual
        // percentage bar behind it... zero through 100", with a top edge that is
        // "definitely visible but not a hard line". So the fill is a true
        // fraction of the pill's height and the crest is a blurred wave.
        val humidity = day.humidity.coerceIn(0, 100) / 100f
        if (humidity > 0f) {
            val save = canvas.save()
            // Clip to the pill so the wave can never spill past the rounded edge.
            fogPath.reset()
            fogPath.addRoundRect(rect, radius, radius, Path.Direction.CW)
            canvas.clipPath(fogPath)

            val level = bottom - pillH * humidity
            // Wave amplitude stays a fixed few px: it should read as mist moving
            // across the surface, not as a reading in its own right.
            val amp = 1.9f * dp
            buildWave(left, right, level, amp)
            canvas.drawPath(fogPath, fogPaint)

            // The crest, blurred, so the surface is legible without a ruled line.
            buildCrest(left, right, level, amp)
            canvas.drawPath(fogPath, fogEdgePaint)

            canvas.restoreToCount(save)
        }

        // ── TEMPERATURE: the bar, on the fixed whole-year scale ──
        val barTop = top + pillH * scalePos(day.high.toFloat())
        val barBottom = top + pillH * scalePos(day.low.toFloat())
        val barLeft = left + (pillW - barW) / 2f
        val barR = barW / 2f
        // A day with almost no swing still needs to read as a bar rather than a
        // dot. Wed 72/66 is only ~4px on the year scale, and that muggy rainy
        // day is exactly the one worth seeing clearly.
        val minBar = barW * 2.6f
        val drawnBottom = max(barBottom, barTop + minBar)
        rect.set(barLeft, barTop, barLeft + barW, drawnBottom)
        barPaint.color = tempColor((day.high + day.low) / 2f)
        canvas.drawRoundRect(rect, barR, barR, barPaint)
        canvas.drawRoundRect(rect, barR, barR, barRim)

        // ── RAIN: a strip along the floor, lit by time of day ──
        // Left to right is night -> morning -> afternoon -> evening, so WHERE it
        // glows says when the rain arrives. The vertical axis is already spoken
        // for by temperature, which is why time had to run horizontally.
        val stripTop = bottom - rainInset - rainH
        val stripLeft = left + rainInset
        val stripRight = right - rainInset
        val stripR = rainH / 2f
        val anyRain = day.rainByQuarter.any { it >= RAIN_FLOOR }
        if (anyRain) {
            rect.set(stripLeft, stripTop, stripRight, stripTop + rainH)
            canvas.drawRoundRect(rect, stripR, stripR, rainTrack)

            val save = canvas.save()
            fogPath.reset()
            fogPath.addRoundRect(rect, stripR, stripR, Path.Direction.CW)
            canvas.clipPath(fogPath)

            val quarterW = (stripRight - stripLeft) / 4f
            for (q in 0..3) {
                val p = day.rainByQuarter[q]
                if (p < RAIN_FLOOR) continue
                // Brighter = likelier, so a light shower and a downpour don't
                // read the same.
                val alpha = (70 + (p / 100f) * 175f).toInt().coerceIn(0, 255)
                rainPaint.color = Color.argb(alpha, 0x4A, 0xA8, 0xEC)
                canvas.drawRect(
                    stripLeft + q * quarterW, stripTop,
                    stripLeft + (q + 1) * quarterW, stripTop + rainH,
                    rainPaint
                )
            }
            canvas.restoreToCount(save)
        }
    }

    /** The filled fog body: a wavy top edge, then down and around the pill floor. */
    private fun buildWave(left: Float, right: Float, level: Float, amp: Float) {
        fogPath.reset()
        fogPath.moveTo(left, level)
        var px = left
        val step = 1.5f * dp
        while (px <= right) {
            val t = (px - left) / (right - left)
            fogPath.lineTo(px, level + sin(t * Math.PI * 2.0).toFloat() * amp)
            px += step
        }
        fogPath.lineTo(right, level + sin(2.0 * Math.PI).toFloat() * amp)
        fogPath.lineTo(right, level + 4000f)
        fogPath.lineTo(left, level + 4000f)
        fogPath.close()
    }

    /** Just the crest line, for the blurred highlight pass. */
    private fun buildCrest(left: Float, right: Float, level: Float, amp: Float) {
        fogPath.reset()
        fogPath.moveTo(left, level)
        var px = left
        val step = 1.5f * dp
        while (px <= right) {
            val t = (px - left) / (right - left)
            fogPath.lineTo(px, level + sin(t * Math.PI * 2.0).toFloat() * amp)
            px += step
        }
    }
}
