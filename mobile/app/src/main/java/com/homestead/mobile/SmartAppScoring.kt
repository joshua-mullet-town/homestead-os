package com.homestead.mobile

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Process
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

object SmartAppScoring {

    private const val TAG = "SmartAppScoring"
    const val LAMBDA = 0.0495          // 14-day half-life: ln(2)/14
    const val SIGMA = 30.0             // Gaussian sigma in minutes
    const val LOOKBACK_DAYS = 30
    const val PREFS_NAME = "homestead_smart_apps"
    const val CACHE_KEY = "smart_apps_cache"

    private val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    fun hasUsagePermission(context: Context): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = appOps.checkOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            context.packageName
        )
        return mode == AppOpsManager.MODE_ALLOWED
    }

    fun cacheNeedsRefresh(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cached = prefs.getString(CACHE_KEY, null) ?: return true
        return try {
            val json = JSONObject(cached)
            val cachedDate = json.optString("computedDate", "")
            cachedDate != dateFormat.format(System.currentTimeMillis())
        } catch (e: Exception) {
            true
        }
    }

    fun getCache(context: Context): JSONObject? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val cached = prefs.getString(CACHE_KEY, null) ?: return null
        return try {
            JSONObject(cached)
        } catch (e: Exception) {
            null
        }
    }

    fun precomputeLaunchCache(context: Context) {
        if (!hasUsagePermission(context)) {
            Log.w(TAG, "No usage permission, skipping precomputation")
            return
        }

        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
        if (usm == null) {
            Log.w(TAG, "UsageStatsManager unavailable")
            return
        }

        val now = System.currentTimeMillis()
        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_YEAR, -LOOKBACK_DAYS)
        val startTime = cal.timeInMillis

        val events = usm.queryEvents(startTime, now) ?: return

        val launches = mutableMapOf<String, MutableList<JSONObject>>()
        var totalEvents = 0

        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType != UsageEvents.Event.MOVE_TO_FOREGROUND) continue

            val pkg = event.packageName ?: continue
            val ts = event.timeStamp

            val eventCal = Calendar.getInstance().apply { timeInMillis = ts }
            val minuteOfDay = eventCal.get(Calendar.HOUR_OF_DAY) * 60 + eventCal.get(Calendar.MINUTE)
            val dayOfWeek = eventCal.get(Calendar.DAY_OF_WEEK)
            val isWeekend = dayOfWeek == Calendar.SATURDAY || dayOfWeek == Calendar.SUNDAY
            val daysAgo = (now - ts).toDouble() / (24 * 60 * 60 * 1000)

            val entry = JSONObject().apply {
                put("m", minuteOfDay)
                put("d", Math.round(daysAgo * 100.0) / 100.0) // 2 decimal places
                put("w", isWeekend)
            }

            launches.getOrPut(pkg) { mutableListOf() }.add(entry)
            totalEvents++
        }

        val launchesJson = JSONObject()
        for ((pkg, entries) in launches) {
            val arr = JSONArray()
            for (e in entries) arr.put(e)
            launchesJson.put(pkg, arr)
        }

        val cache = JSONObject().apply {
            put("computedAt", now)
            put("computedDate", dateFormat.format(now))
            put("launches", launchesJson)
        }

        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(CACHE_KEY, cache.toString()).apply()

        Log.i(TAG, "Precomputed $totalEvents launch events for ${launches.size} apps")
    }

    /**
     * Rank packages by likelihood of being launched right now.
     *
     * Lifted verbatim (math-wise) out of the old SmartAppsFragment when Phone mode
     * replaced it — recency decay (14-day half-life) x Gaussian time-of-day
     * smoothing, split by weekday/weekend. Returns package names best-first.
     *
     * @param candidates packages eligible to be ranked (already filtered to real,
     *                   launchable, non-work-profile apps by the caller)
     * @param limit      max packages to return
     * @return ranked package names, or empty if there is nothing to score
     */
    fun rankPackages(context: Context, candidates: Set<String>, limit: Int): List<String> {
        val cache = getCache(context) ?: return emptyList()
        val launches = cache.optJSONObject("launches") ?: return emptyList()
        val computedAt = cache.optLong("computedAt", System.currentTimeMillis())
        val extraDays = (System.currentTimeMillis() - computedAt).toDouble() / (24 * 60 * 60 * 1000)

        val cal = Calendar.getInstance()
        val currentMinute = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
        val dayOfWeek = cal.get(Calendar.DAY_OF_WEEK)
        val isWeekend = dayOfWeek == Calendar.SATURDAY || dayOfWeek == Calendar.SUNDAY

        val excludePackages = setOf(
            context.packageName,
            "com.android.systemui",
            "com.android.settings",
            "com.android.launcher3",
            "com.teslacoilsw.launcher",
        )

        val scores = mutableMapOf<String, Double>()
        val keys = launches.keys()
        while (keys.hasNext()) {
            val pkg = keys.next()
            if (pkg in excludePackages || pkg !in candidates) continue

            val events = launches.optJSONArray(pkg) ?: continue
            var score = 0.0

            for (i in 0 until events.length()) {
                val ev = events.getJSONObject(i)
                if (ev.optBoolean("w", false) != isWeekend) continue

                val minuteOfDay = ev.optInt("m", 0)
                val daysAgo = ev.optDouble("d", 30.0) + extraDays

                // Recency weight: exponential decay with 14-day half-life
                val recency = Math.exp(-LAMBDA * daysAgo)

                // Gaussian time weight with circular (midnight-aware) distance
                val dt = Math.abs(currentMinute - minuteOfDay).toDouble()
                val circularDist = Math.min(dt, 1440.0 - dt)
                val gaussian = Math.exp(-0.5 * (circularDist / SIGMA) * (circularDist / SIGMA))

                score += recency * gaussian
            }

            if (score > 0.0) scores[pkg] = score
        }

        return scores.entries
            .sortedByDescending { it.value }
            .take(limit)
            .map { it.key }
    }

}
