package com.homestead.mobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging

class HomesteadApp : Application() {

    companion object {
        private const val TAG = "HomesteadApp"
        const val CHANNEL_ID = "homestead_api_server"
        const val CHANNEL_SESSION_READY = "homestead_session_ready"
        const val CHANNEL_ALARM = "homestead_alarm"
        const val CHANNEL_PRESENTER = "homestead_presenter"
        const val CHANNEL_ALERTS = "homestead_alerts"
        const val CHANNEL_RECORDING = "homestead_recording"
        const val SERVER_PORT = 8888
    }

    override fun onCreate() {
        super.onCreate()
        installCrashHandler()
        createNotificationChannels()
        registerFCMToken()
    }

    private fun installCrashHandler() {
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val crashFile = java.io.File(filesDir, "crash_log.txt")
                val timestamp = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
                    .format(java.util.Date())
                val trace = java.io.StringWriter().also { throwable.printStackTrace(java.io.PrintWriter(it)) }.toString()
                val entry = "=== CRASH $timestamp ===\nThread: ${thread.name}\n$trace\n\n"
                // Keep last 5 crashes max (~50KB)
                val existing = if (crashFile.exists()) crashFile.readText() else ""
                val sections = existing.split("=== CRASH ").filter { it.isNotBlank() }
                val trimmed = sections.takeLast(4).joinToString("") { "=== CRASH $it" }
                crashFile.writeText(trimmed + entry)
            } catch (_: Exception) {
                // Don't crash the crash handler
            }
            // Chain to default handler (shows system crash dialog / kills process)
            defaultHandler?.uncaughtException(thread, throwable)
        }
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val serverChannel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.notification_channel_description)
                setShowBadge(false)
            }

            val sessionChannel = NotificationChannel(
                CHANNEL_SESSION_READY,
                "Session Ready",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Notifies when a Claude session finishes working"
                setShowBadge(true)
            }

            val alarmChannel = NotificationChannel(
                CHANNEL_ALARM,
                "Alarms",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Homestead alarm notifications"
                setShowBadge(true)
                setBypassDnd(true)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            }

            val presenterChannel = NotificationChannel(
                CHANNEL_PRESENTER,
                "Presenter",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Presenter items requiring your attention"
                setShowBadge(true)
            }

            val alertsChannel = NotificationChannel(
                CHANNEL_ALERTS,
                "Homestead Alerts",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Custom alerts from Homestead (navigation, reminders, etc.)"
                setShowBadge(true)
            }

            val notificationManager = getSystemService(NotificationManager::class.java)
            // Silent + low importance: this notification exists to satisfy the
            // Android 14 microphone-FGS requirement and to give Joshua a way back
            // into a running take. It must never buzz mid-recording.
            val recordingChannel = NotificationChannel(
                CHANNEL_RECORDING,
                "Recording",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shown while Homestead is recording audio"
                setShowBadge(false)
                enableVibration(false)
                setSound(null, null)
            }

            notificationManager.createNotificationChannel(recordingChannel)
            notificationManager.createNotificationChannel(serverChannel)
            notificationManager.createNotificationChannel(sessionChannel)
            notificationManager.createNotificationChannel(alarmChannel)
            notificationManager.createNotificationChannel(presenterChannel)
            notificationManager.createNotificationChannel(alertsChannel)
        }
    }

    /**
     * Tell the server which FCM token this device currently holds.
     *
     * ⚠️⚠️ READ THIS BEFORE TOUCHING ANYTHING FCM. It cost five days. ⚠️⚠️
     *
     * THE BUG THIS EXISTS TO PREVENT (2026-09-13..18):
     * Firebase silently reissued this device's token. The app knew the new one;
     * the SERVER never heard about it and kept pushing to the old one. Josh got
     * no notifications for five days and nothing anywhere reported an error.
     *
     * WHY IT WAS SO HARD TO SEE — three separate traps, all of which held:
     *
     *  1. 🚨 FCM TOKENS SHARE AN IDENTICAL PREFIX. The format is
     *     `<instance-id>:<APA91b...payload>`. The instance-id is STABLE across
     *     reissues, so the old and new tokens looked like this:
     *         app: fPx78j_ATcaDiehbxfXkYw:APA91bH...zsyjPZCXc8Go
     *         srv: fPx78j_ATcaDiehbxfXkYw:APA91bH...P6VqwWbbeSyU
     *     Every prefix comparison "matched". **NEVER compare or log a token by
     *     its prefix.** Compare the FULL string; log the TAIL if you must log.
     *
     *  2. 🚨 GOOGLE VALIDATED THE DEAD TOKEN FOR THREE DAYS.
     *     `admin.messaging().send(msg, /*dryRun*/ true)` returned SUCCESS on
     *     Sep 15 and Sep 17, then `registration-token-not-registered` on Sep 18
     *     — same token, same query. A dryRun "valid" is NOT proof a token is
     *     live. Only a real send that the device demonstrably receives is.
     *
     *  3. 🚨 IT LOOKS EXACTLY LIKE A DELIVERY FAILURE FROM OUTSIDE.
     *     FCM returns a real message id for a dead token, so every server-side
     *     signal says "sent, fine". Three wrong diagnoses were published from
     *     that evidence (app notification settings; Google Play Services; the
     *     GMS-to-app handoff) before anyone compared the two token strings.
     *
     * THE FIX, and why it is on EVERY launch rather than only onNewToken():
     * `onNewToken` fires when Firebase rotates the token — but if that call
     * fails (server down, no network, Tailscale not up yet) the new token is
     * NEVER re-offered, and the two sides stay split forever with no retry.
     * Re-announcing unconditionally at every launch makes the split
     * self-healing: any launch repairs it. It is one tiny POST; the cost of
     * sending it redundantly is nothing next to the cost of not sending it.
     *
     * The server side dedupes and prunes — see app/api/fcm/register/route.ts.
     */
    private fun registerFCMToken() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.w(TAG, "FCM token fetch failed", task.exception)
                return@addOnCompleteListener
            }

            val token = task.result
            Log.d(TAG, "FCM token: $token")

            // Store locally
            getSharedPreferences("homestead_fcm", MODE_PRIVATE)
                .edit().putString("fcm_token", token).apply()

            // Register with server
            Thread {
                try {
                    val url = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/fcm/register")
                    val conn = url.openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.outputStream.write("""{"token":"$token"}""".toByteArray())
                    val code = conn.responseCode
                    Log.d(TAG, "FCM token registered with server: $code")
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to register FCM token: ${e.message}")
                }
            }.start()
        }
    }
}
