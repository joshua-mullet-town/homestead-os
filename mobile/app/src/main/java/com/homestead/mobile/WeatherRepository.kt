package com.homestead.mobile

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * The forecast behind the phone-mode weather corner.
 *
 * Open-Meteo: no API key, no signup, no billing. That's the whole reason it was
 * chosen — a home screen shouldn't carry a subscription.
 *
 * Cached to SharedPreferences so the corner draws instantly from the last known
 * forecast on every launch and only hits the network when the cache is stale.
 * A phone home screen is opened dozens of times an hour; refetching each time
 * would be pointless traffic and a visible empty gap on every open.
 */
object WeatherRepository {

    private const val TAG = "WeatherRepository"
    private const val PREFS = "homestead_weather"
    private const val KEY_JSON = "forecast_json"
    private const val KEY_AT = "fetched_at"

    /** Elkhart, Indiana. */
    private const val LAT = 41.6820
    private const val LON = -85.9767

    /** Forecasts don't meaningfully move inside an hour. */
    private const val MAX_AGE_MS = 60L * 60L * 1000L

    /** Days drawn in the ribbon. Six fits the corner without crowding the clock. */
    const val DAYS = 6

    /**
     * Sentinel [Day.label] for today's slot.
     *
     * The ribbon draws this one as a filled dot rather than text — see
     * PhoneModeWeather's day-label drawing — so this value is a marker the view
     * matches on, not a glyph anybody renders directly. It only has to be a
     * string no real weekday letter could collide with.
     */
    const val TODAY_LABEL = "\u0000TODAY"

    private val io = Executors.newSingleThreadExecutor()

    /**
     * One day of the ribbon.
     *
     * [rainByQuarter] is the chance of rain in each quarter of the day —
     * night / morning / afternoon / evening — which is what lets the strip show
     * *when* it rains rather than just whether it does.
     */
    data class Day(
        val label: String,
        val high: Int,
        val low: Int,
        val humidity: Int,
        val rainByQuarter: IntArray
    )

    /**
     * Right now — the headline half of the corner.
     *
     * [code] is a WMO weather code; [conditionText] turns it into the one word
     * that actually goes on screen.
     */
    data class Now(
        val temp: Int,
        val feelsLike: Int,
        val code: Int,
        val humidity: Int
    ) {
        /** WMO code -> a short phrase. Grouped, because "Slight drizzle" and
         *  "Moderate drizzle" are the same decision to the person reading it. */
        val conditionText: String
            get() = when (code) {
                0 -> "Clear"
                1 -> "Mostly clear"
                2 -> "Partly cloudy"
                3 -> "Overcast"
                45, 48 -> "Fog"
                51, 53, 55, 56, 57 -> "Drizzle"
                61, 63, 65, 66, 67 -> "Rain"
                71, 73, 75, 77 -> "Snow"
                80, 81, 82 -> "Showers"
                85, 86 -> "Snow showers"
                95, 96, 99 -> "Storms"
                else -> ""
            }
    }

    data class Forecast(val now: Now?, val days: List<Day>)

    /** Last good forecast, or null if we've never successfully fetched one. */
    fun cached(ctx: Context): Forecast? {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_JSON, null) ?: return null
        return try {
            parse(JSONObject(raw))
        } catch (e: Exception) {
            Log.w(TAG, "Cached forecast unreadable, discarding", e)
            null
        }
    }

    private fun isStale(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = prefs.getLong(KEY_AT, 0L)
        return System.currentTimeMillis() - at > MAX_AGE_MS
    }

    /**
     * Hand back the cache immediately, then refresh in the background if stale.
     *
     * [onUpdate] runs on a background thread and only fires when a NEW forecast
     * actually arrived — callers must post to the main thread to touch views.
     */
    fun load(ctx: Context, onUpdate: (Forecast) -> Unit) {
        if (!isStale(ctx) && cached(ctx) != null) return
        val app = ctx.applicationContext
        io.execute {
            try {
                val json = fetch()
                val parsed = parse(json)
                // Only commit a forecast we could actually parse, so a bad
                // response can never replace a good cache with something broken.
                app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_JSON, json.toString())
                    .putLong(KEY_AT, System.currentTimeMillis())
                    .apply()
                onUpdate(parsed)
            } catch (e: Exception) {
                // Offline is normal and not worth surfacing — the corner keeps
                // drawing the last forecast it had.
                Log.w(TAG, "Forecast fetch failed; keeping cache", e)
            }
        }
    }

    private fun fetch(): JSONObject {
        val url = URL(
            "https://api.open-meteo.com/v1/forecast" +
                "?latitude=$LAT&longitude=$LON" +
                "&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m" +
                "&daily=temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean" +
                "&hourly=precipitation_probability" +
                "&temperature_unit=fahrenheit" +
                "&timezone=America%2FNew_York" +
                "&forecast_days=$DAYS"
        )
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 10_000
            requestMethod = "GET"
        }
        try {
            if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")
            return JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        } finally {
            conn.disconnect()
        }
    }

    private fun parse(json: JSONObject): Forecast {
        // Current conditions are the headline, but a forecast without them is
        // still worth drawing — so this is optional rather than fatal.
        val now = json.optJSONObject("current")?.let {
            Now(
                temp = Math.round(it.optDouble("temperature_2m", 0.0)).toInt(),
                feelsLike = Math.round(it.optDouble("apparent_temperature", 0.0)).toInt(),
                code = it.optInt("weather_code", -1),
                humidity = Math.round(it.optDouble("relative_humidity_2m", 0.0)).toInt()
            )
        }

        val daily = json.getJSONObject("daily")
        val times = daily.getJSONArray("time")
        val highs = daily.getJSONArray("temperature_2m_max")
        val lows = daily.getJSONArray("temperature_2m_min")
        val hums = daily.getJSONArray("relative_humidity_2m_mean")

        val hourly = json.getJSONObject("hourly")
        val hTimes = hourly.getJSONArray("time")
        val hPop = hourly.getJSONArray("precipitation_probability")

        val days = ArrayList<Day>(DAYS)
        val count = minOf(times.length(), DAYS)
        for (i in 0 until count) {
            val date = times.getString(i)

            // Worst case in each quarter of the day — a 60% hour inside an
            // otherwise dry afternoon is the thing worth surfacing, so max
            // rather than mean is the honest summary here.
            val quarters = IntArray(4)
            for (j in 0 until hTimes.length()) {
                val t = hTimes.getString(j)
                if (!t.startsWith(date)) continue
                val hour = t.substring(11, 13).toIntOrNull() ?: continue
                val p = hPop.optInt(j, 0)
                val q = when {
                    hour < 6 -> 0
                    hour < 12 -> 1
                    hour < 18 -> 2
                    else -> 3
                }
                if (p > quarters[q]) quarters[q] = p
            }

            days.add(
                Day(
                    label = dayLabel(date, i),
                    high = Math.round(highs.getDouble(i)).toInt(),
                    low = Math.round(lows.getDouble(i)).toInt(),
                    humidity = Math.round(hums.getDouble(i)).toInt(),
                    rainByQuarter = quarters
                )
            )
        }
        if (days.isEmpty()) error("forecast contained no days")
        return Forecast(now, days)
    }

    /**
     * "S", "M", … — one letter per day, with today's slot reading TODAY_LABEL.
     *
     * The letter is the first character of the localised short name.
     *
     * A pill is 19dp wide; "TODAY" at the label size is nearly half again that,
     * so the word overhung its own column and crowded the day beside it. One
     * letter fits the column with room to spare.
     *
     * Two letters therefore repeat inside a week — T for Tue and Thu, S for Sat
     * and Sun. That ambiguity is inherent to a one-letter row and is resolved by
     * position: the days always run forward from today, so the second T is
     * always the later one. Deliberate, not an oversight.
     *
     * Today is a symbol rather than a letter on purpose: the natural letter for
     * it would be "T", which is exactly the letter already doing double duty for
     * Tuesday and Thursday. A non-letter mark can never be misread as a day.
     */
    private fun dayLabel(isoDate: String, index: Int): String {
        if (index == 0) return TODAY_LABEL
        return try {
            val parts = isoDate.split("-")
            val cal = Calendar.getInstance().apply {
                set(parts[0].toInt(), parts[1].toInt() - 1, parts[2].toInt(), 12, 0, 0)
            }
            // First letter of the short name, NOT SimpleDateFormat's "EEEEE".
            // The narrow-weekday pattern is a java.time/ICU convention; in
            // SimpleDateFormat any count of four or more means the FULL name,
            // so "EEEEE" here yields "THURSDAY" — longer than what it replaced.
            java.text.SimpleDateFormat("EEE", Locale.getDefault())
                .format(Date(cal.timeInMillis))
                .take(1)
                .uppercase(Locale.getDefault())
        } catch (e: Exception) {
            ""
        }
    }
}
