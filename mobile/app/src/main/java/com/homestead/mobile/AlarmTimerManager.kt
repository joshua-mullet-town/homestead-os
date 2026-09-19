package com.homestead.mobile

import android.app.AlarmManager
import android.app.AlarmManager.AlarmClockInfo
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.UUID

/**
 * Stateless helper for alarm persistence + AlarmManager scheduling,
 * and timer preset management via SharedPreferences.
 */
object AlarmTimerManager {

    private const val TAG = "AlarmTimerManager"
    private const val PREFS_ALARMS = "homestead_alarms"
    private const val KEY_ALARMS = "alarms_json"
    private const val PREFS_TIMER_PRESETS = "homestead_timer_presets"
    private const val KEY_PRESETS = "presets_json"

    // ── Alarms ──

    data class AlarmEntry(
        val id: String,
        val hour: Int,
        val minute: Int,
        val label: String,
        val createdAt: Long
    ) {
        /** Next fire time from now (today or tomorrow). */
        fun nextFireTimeMs(): Long {
            val cal = Calendar.getInstance().apply {
                set(Calendar.HOUR_OF_DAY, hour)
                set(Calendar.MINUTE, minute)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }
            if (cal.timeInMillis <= System.currentTimeMillis()) {
                cal.add(Calendar.DAY_OF_YEAR, 1)
            }
            return cal.timeInMillis
        }

        fun toJson(): JSONObject = JSONObject().apply {
            put("id", id)
            put("hour", hour)
            put("minute", minute)
            put("label", label)
            put("createdAt", createdAt)
        }

        companion object {
            fun fromJson(obj: JSONObject) = AlarmEntry(
                id = obj.getString("id"),
                hour = obj.getInt("hour"),
                minute = obj.getInt("minute"),
                label = obj.optString("label", ""),
                createdAt = obj.optLong("createdAt", 0)
            )
        }
    }

    fun setAlarm(ctx: Context, hour: Int, minute: Int, label: String): AlarmEntry {
        val entry = AlarmEntry(
            id = UUID.randomUUID().toString(),
            hour = hour,
            minute = minute,
            label = label,
            createdAt = System.currentTimeMillis()
        )

        // Persist
        val alarms = loadAlarms(ctx).toMutableList()
        alarms.add(entry)
        saveAlarms(ctx, alarms)

        // Schedule
        scheduleAlarm(ctx, entry)
        Log.d(TAG, "Alarm set: $entry, fires at ${entry.nextFireTimeMs()}")
        return entry
    }

    fun listAlarms(ctx: Context): List<AlarmEntry> {
        return loadAlarms(ctx).sortedBy { it.nextFireTimeMs() }
    }

    fun deleteAlarm(ctx: Context, id: String): Boolean {
        val alarms = loadAlarms(ctx).toMutableList()
        val removed = alarms.removeAll { it.id == id }
        if (removed) {
            saveAlarms(ctx, alarms)
            cancelAlarm(ctx, id)
            Log.d(TAG, "Alarm deleted: $id")
        }
        return removed
    }

    fun rescheduleAllAlarms(ctx: Context) {
        val alarms = loadAlarms(ctx)
        Log.d(TAG, "Rescheduling ${alarms.size} alarms after boot")
        for (alarm in alarms) {
            scheduleAlarm(ctx, alarm)
        }
    }

    /** Called by AlarmReceiver after an alarm fires — removes it (one-shot). */
    fun removeAlarmById(ctx: Context, id: String) {
        val alarms = loadAlarms(ctx).toMutableList()
        alarms.removeAll { it.id == id }
        saveAlarms(ctx, alarms)
    }

    fun canScheduleAlarms(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return am.canScheduleExactAlarms()
    }

    private fun scheduleAlarm(ctx: Context, entry: AlarmEntry) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager

        // Check permission on API 31+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            Log.w(TAG, "Cannot schedule exact alarms — opening settings")
            try {
                val settingsIntent = Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                ctx.startActivity(settingsIntent)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to open exact alarm settings", e)
            }
            return
        }

        val fireTime = entry.nextFireTimeMs()

        val intent = Intent(ctx, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_ALARM_FIRE
            putExtra("alarm_id", entry.id)
            putExtra("alarm_label", entry.label)
        }
        val pi = PendingIntent.getBroadcast(
            ctx, entry.id.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Show-intent opens the app when user taps the alarm clock icon in status bar
        val showIntent = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        am.setAlarmClock(AlarmClockInfo(fireTime, showIntent), pi)
    }

    private fun cancelAlarm(ctx: Context, id: String) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(ctx, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_ALARM_FIRE
        }
        val pi = PendingIntent.getBroadcast(
            ctx, id.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        am.cancel(pi)
    }

    private fun loadAlarms(ctx: Context): List<AlarmEntry> {
        val prefs = ctx.getSharedPreferences(PREFS_ALARMS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_ALARMS, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { AlarmEntry.fromJson(arr.getJSONObject(it)) }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse alarms", e)
            emptyList()
        }
    }

    private fun saveAlarms(ctx: Context, alarms: List<AlarmEntry>) {
        val arr = JSONArray()
        alarms.forEach { arr.put(it.toJson()) }
        ctx.getSharedPreferences(PREFS_ALARMS, Context.MODE_PRIVATE)
            .edit().putString(KEY_ALARMS, arr.toString()).apply()
    }

    // ── Timer Presets ──

    data class TimerPreset(val id: String, val seconds: Int) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("id", id)
            put("seconds", seconds)
        }

        companion object {
            fun fromJson(obj: JSONObject) = TimerPreset(
                id = obj.getString("id"),
                seconds = obj.getInt("seconds")
            )
        }
    }

    fun getTimerPresets(ctx: Context): List<TimerPreset> {
        initDefaultPresets(ctx)
        val prefs = ctx.getSharedPreferences(PREFS_TIMER_PRESETS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_PRESETS, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { TimerPreset.fromJson(arr.getJSONObject(it)) }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse presets", e)
            emptyList()
        }
    }

    fun updateTimerPreset(ctx: Context, id: String, newSeconds: Int): Boolean {
        val presets = getTimerPresets(ctx).toMutableList()
        val idx = presets.indexOfFirst { it.id == id }
        if (idx < 0) return false
        presets[idx] = presets[idx].copy(seconds = newSeconds)
        savePresets(ctx, presets)
        return true
    }

    fun initDefaultPresets(ctx: Context) {
        val prefs = ctx.getSharedPreferences(PREFS_TIMER_PRESETS, Context.MODE_PRIVATE)
        if (prefs.contains(KEY_PRESETS)) return

        val defaults = listOf(
            TimerPreset(id = "preset_32", seconds = 32),
            TimerPreset(id = "preset_45", seconds = 45)
        )
        savePresets(ctx, defaults)
    }

    private fun savePresets(ctx: Context, presets: List<TimerPreset>) {
        val arr = JSONArray()
        presets.forEach { arr.put(it.toJson()) }
        ctx.getSharedPreferences(PREFS_TIMER_PRESETS, Context.MODE_PRIVATE)
            .edit().putString(KEY_PRESETS, arr.toString()).apply()
    }
}
