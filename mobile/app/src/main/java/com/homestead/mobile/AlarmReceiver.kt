package com.homestead.mobile

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

class AlarmReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "AlarmReceiver"
        const val ACTION_ALARM_FIRE = "com.homestead.mobile.ALARM_FIRE"
        const val ACTION_ALARM_DISMISS = "com.homestead.mobile.ALARM_DISMISS"
        const val ACTION_TIMER_FIRE = "com.homestead.mobile.TIMER_FIRE"
        const val ACTION_TIMER_DISMISS = "com.homestead.mobile.TIMER_DISMISS"
        private const val NOTIFICATION_ID_BASE = 50000
        private const val AUTO_SILENCE_MS = 60_000L // Stop ringing after 60s

        // Hold refs for cleanup on dismiss
        private val activeRingtones = mutableMapOf<String, Ringtone>()
        private val activeVibrators = mutableMapOf<String, Vibrator>()
        private val autoSilenceHandler = Handler(Looper.getMainLooper())

        // Pickup detection
        private var pickupListener: SensorEventListener? = null
        private var pickupAlarmId: String? = null

        /** Dismiss everything for a given ID — callable from ApiServerService too */
        fun dismissById(context: Context, id: String) {
            Log.d(TAG, "Dismissing: $id")
            activeRingtones.remove(id)?.stop()
            activeVibrators.remove(id)?.cancel()
            val notifId = NOTIFICATION_ID_BASE + (id.hashCode() and 0xFFFF)
            NotificationManagerCompat.from(context).cancel(notifId)
            stopPickupDetection(context)
        }

        private fun startPickupDetection(context: Context, alarmId: String) {
            if (pickupListener != null) return
            val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
            val accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return

            pickupAlarmId = alarmId
            Log.d(TAG, "Starting pickup detection for alarm $alarmId")

            pickupListener = object : SensorEventListener {
                private var baselineZ = 0f
                private var settled = false
                private var settleCount = 0

                override fun onSensorChanged(event: SensorEvent) {
                    val x = event.values[0]
                    val y = event.values[1]
                    val z = event.values[2]

                    if (!settled) {
                        settleCount++
                        if (settleCount > 10) {
                            settled = true
                            baselineZ = z
                            Log.d(TAG, "Pickup baseline Z=$baselineZ")
                        }
                        return
                    }

                    // Phone flat on table: Z ≈ 9.81
                    // Phone picked up and tilted: Z drops, X/Y increase
                    val zDrop = baselineZ - z
                    val lateral = kotlin.math.sqrt((x * x + y * y).toDouble()).toFloat()

                    // Trigger on ~30° tilt (Z drops by 3+) or lateral accel > 4
                    if (zDrop > 3.0f || lateral > 4.0f) {
                        Log.d(TAG, "Pickup detected! zDrop=$zDrop lateral=$lateral — dismissing $alarmId")
                        val id = pickupAlarmId ?: return
                        dismissById(context.applicationContext, id)
                    }
                }

                override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
            }
            sensorManager.registerListener(pickupListener, accel, SensorManager.SENSOR_DELAY_NORMAL)
        }

        private fun stopPickupDetection(context: Context) {
            val listener = pickupListener ?: return
            Log.d(TAG, "Stopping pickup detection")
            val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            sensorManager?.unregisterListener(listener)
            pickupListener = null
            pickupAlarmId = null
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("alarm_id") ?: return
        val label = intent.getStringExtra("alarm_label") ?: "Alarm"

        when (intent.action) {
            ACTION_ALARM_FIRE -> fireAlarm(context, id, label, isTimer = false)
            ACTION_ALARM_DISMISS -> dismissById(context, id)
            ACTION_TIMER_FIRE -> fireAlarm(context, id, label, isTimer = true)
            ACTION_TIMER_DISMISS -> dismissById(context, id)
        }
    }

    private fun fireAlarm(context: Context, id: String, label: String, isTimer: Boolean) {
        val kind = if (isTimer) "Timer" else "Alarm"
        Log.d(TAG, "$kind fired: $id ($label)")

        if (!isTimer) {
            AlarmTimerManager.removeAlarmById(context, id)
        }

        // Wake screen
        val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        val wl = pm.newWakeLock(
            android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "homestead:alarm_wake"
        )
        wl.acquire(AUTO_SILENCE_MS)

        // Play ALARM ringtone (the real loud one)
        try {
            val alarmUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val ringtone = RingtoneManager.getRingtone(context, alarmUri)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ringtone.isLooping = true
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ringtone.audioAttributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            }
            ringtone.play()
            activeRingtones[id] = ringtone
        } catch (e: Exception) {
            Log.e(TAG, "Failed to play alarm sound", e)
        }

        // Vibrate with repeating pattern
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }

            val pattern = longArrayOf(0, 800, 400, 800, 400, 800)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(
                    VibrationEffect.createWaveform(pattern, 0), // 0 = repeat from start
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .build()
                )
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, 0)
            }
            activeVibrators[id] = vibrator
        } catch (e: Exception) {
            Log.e(TAG, "Failed to vibrate", e)
        }

        // Start pickup detection — phone pickup dismisses the alarm
        startPickupDetection(context.applicationContext, id)

        // Auto-silence after 60 seconds
        autoSilenceHandler.postDelayed({ dismissById(context, id) }, AUTO_SILENCE_MS)

        // Heads-up notification — tapping it OR tapping DISMISS both stop everything
        val dismissAction = if (isTimer) ACTION_TIMER_DISMISS else ACTION_ALARM_DISMISS
        val dismissIntent = Intent(context, AlarmReceiver::class.java).apply {
            action = dismissAction
            putExtra("alarm_id", id)
        }
        val dismissPi = PendingIntent.getBroadcast(
            context, id.hashCode() + 1, dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Content tap also dismisses (same PendingIntent)
        val contentPi = PendingIntent.getBroadcast(
            context, id.hashCode() + 2, dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notifId = NOTIFICATION_ID_BASE + (id.hashCode() and 0xFFFF)
        val title = if (isTimer) "Timer done" else "Alarm"
        val notification = NotificationCompat.Builder(context, HomesteadApp.CHANNEL_ALARM)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(label)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(contentPi)
            .setDeleteIntent(dismissPi)
            .setFullScreenIntent(contentPi, true)
            .addAction(R.drawable.ic_launcher, "DISMISS", dismissPi)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(notifId, notification)
        } catch (e: SecurityException) {
            Log.e(TAG, "Notification permission not granted", e)
        }
    }
}
