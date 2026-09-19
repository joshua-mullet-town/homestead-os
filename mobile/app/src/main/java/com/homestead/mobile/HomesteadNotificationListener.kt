package com.homestead.mobile

import android.app.Notification
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Base64
import android.util.Log
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

@Serializable
data class NotificationData(
    val id: Int,
    val key: String,
    val packageName: String,
    val appName: String,
    val title: String?,
    val text: String?,
    val bigText: String?,
    val subText: String?,
    val timestamp: Long,
    val isOngoing: Boolean,
    val isClearable: Boolean,
    val category: String?,
    val actions: List<String>,
    // Grouping info - helps identify parent/summary vs child notifications
    val groupKey: String?,
    val isGroupSummary: Boolean
)

class HomesteadNotificationListener : NotificationListenerService() {

    companion object {
        private const val TAG = "NotificationListener"

        // Homestead server URL - same Tailscale hostname the rest of the app uses
        private const val BASE_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net"
        private const val INGEST_URL = "$BASE_URL/api/notification-ingest"

        // Messaging apps that post each message in TWO phases: first an empty shell
        // (fired while the body is still being fetched/decrypted, so title/text/bigText
        // are all null), then a populated update ~seconds later carrying the real
        // sender + body. Both phases share the same sbn.key, so pushing the shell
        // poisons the server's dedupe ledger and the REAL message gets dropped.
        // Mirrors TWO_PHASE_MESSAGING_APPS in app/api/notification-ingest/route.ts.
        private val TWO_PHASE_MESSAGING_PACKAGES = setOf(
            "com.google.android.apps.messaging"
        )

        @Volatile
        var instance: HomesteadNotificationListener? = null
            private set

        fun isRunning(): Boolean = instance != null
    }

    // Fire-and-forget client: short timeouts so we never block the listener.
    private val pushClient = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .writeTimeout(3, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .build()

    private val json = Json { encodeDefaults = true }

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "NotificationListenerService created")
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        instance = this
        Log.d(TAG, "NotificationListenerService connected")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        instance = null
        Log.d(TAG, "NotificationListenerService disconnected")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        Log.d(TAG, "Notification posted: ${sbn.packageName}")
        pushNotification(sbn)
    }

    /**
     * Fire-and-forget push of a single notification to the Homestead ingest endpoint.
     * The server owns all filtering — we send everything parseNotification produces.
     * Failures are swallowed silently; a 5-min backstop poll catches any dropped push.
     */
    private fun pushNotification(sbn: StatusBarNotification) {
        try {
            val data = parseNotification(sbn) ?: return

            // Two-phase messaging apps fire an empty shell before the body lands.
            // Drop it here so only the populated update ever leaves the phone.
            if (isEmptyMessagingShell(data)) {
                Log.d(TAG, "Skipping empty messaging shell from ${data.packageName} (key ${data.key.take(24)}) - awaiting populated update")
                return
            }

            // Serialize the whole NotificationData, then tack on the source marker.
            val base = json.encodeToJsonElement(data).jsonObject
            val payload = JsonObject(base + ("source" to JsonPrimitive("phone-push")))

            val requestBody = RequestBody.create(
                "application/json".toMediaType(),
                payload.toString()
            )

            val request = Request.Builder()
                .url(INGEST_URL)
                .post(requestBody)
                .build()

            // Async, one attempt, no retry — never block the listener on the response.
            pushClient.newCall(request).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                    Log.d(TAG, "Push failed (non-fatal): ${e.message}")
                }

                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                    response.use { Log.d(TAG, "Push response: ${it.code}") }
                }
            })
        } catch (e: Exception) {
            Log.d(TAG, "Push error (non-fatal): ${e.message}")
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        Log.d(TAG, "Notification removed: ${sbn.packageName}")
    }

    fun getAllNotifications(): List<NotificationData> {
        return try {
            activeNotifications?.mapNotNull { sbn ->
                parseNotification(sbn)
            } ?: emptyList()
        } catch (e: Exception) {
            Log.e(TAG, "Error getting notifications", e)
            emptyList()
        }
    }

    /**
     * True when this is the hollow first phase of a two-phase messaging notification:
     * from a known two-phase messaging package AND carrying no title, no text and no
     * bigText. bigText matters — a message can arrive with `text` null but `bigText`
     * populated, and dropping that would lose a real message.
     *
     * Scoped deliberately to the messaging package set: plenty of other apps post
     * legitimately title-less notifications, and a blanket "drop anything blank" rule
     * would silently swallow them.
     */
    private fun isEmptyMessagingShell(data: NotificationData): Boolean {
        if (data.packageName !in TWO_PHASE_MESSAGING_PACKAGES) return false
        val hasTitle = !data.title.isNullOrBlank()
        val hasText = !data.text.isNullOrBlank()
        val hasBigText = !data.bigText.isNullOrBlank()
        return !hasTitle && !hasText && !hasBigText
    }

    private fun parseNotification(sbn: StatusBarNotification): NotificationData? {
        return try {
            val notification = sbn.notification
            val extras = notification.extras

            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            val subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()

            // Get app name
            val appName = try {
                val pm = packageManager
                val appInfo = pm.getApplicationInfo(sbn.packageName, 0)
                pm.getApplicationLabel(appInfo).toString()
            } catch (e: PackageManager.NameNotFoundException) {
                sbn.packageName
            }

            // Get action labels
            val actions = notification.actions?.map { it.title.toString() } ?: emptyList()

            // Check if this is a group summary notification
            val isGroupSummary = notification.flags and Notification.FLAG_GROUP_SUMMARY != 0
            val groupKey = notification.group

            NotificationData(
                id = sbn.id,
                key = sbn.key,
                packageName = sbn.packageName,
                appName = appName,
                title = title,
                text = text,
                bigText = bigText,
                subText = subText,
                timestamp = sbn.postTime,
                isOngoing = notification.flags and Notification.FLAG_ONGOING_EVENT != 0,
                isClearable = sbn.isClearable,
                category = notification.category,
                actions = actions,
                groupKey = groupKey,
                isGroupSummary = isGroupSummary
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error parsing notification", e)
            null
        }
    }

    fun dismissNotification(key: String): Boolean {
        return try {
            cancelNotification(key)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error dismissing notification", e)
            false
        }
    }

    fun dismissAllNotifications(): Boolean {
        return try {
            cancelAllNotifications()
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error dismissing all notifications", e)
            false
        }
    }

    /**
     * Trigger an action button on a notification.
     * @param key The notification key
     * @param actionIndex The index of the action to trigger (0-based)
     * @return true if action was triggered successfully
     */
    fun triggerAction(key: String, actionIndex: Int): Boolean {
        return try {
            val notification = activeNotifications?.find { it.key == key }
            if (notification == null) {
                Log.e(TAG, "Notification not found for key: $key")
                return false
            }

            val actions = notification.notification.actions
            if (actions == null || actionIndex >= actions.size) {
                Log.e(TAG, "Action index $actionIndex out of bounds (${actions?.size ?: 0} actions)")
                return false
            }

            val action = actions[actionIndex]
            Log.d(TAG, "Triggering action: ${action.title} on notification $key")

            // Send the PendingIntent
            action.actionIntent.send()
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error triggering notification action", e)
            false
        }
    }

    /**
     * Get the content intent (main tap action) for a notification and trigger it.
     * @param key The notification key
     * @return true if content intent was triggered successfully
     */
    fun openNotification(key: String): Boolean {
        return try {
            val sbn = activeNotifications?.find { it.key == key }
            if (sbn == null) {
                Log.e(TAG, "Notification not found for key: $key")
                return false
            }

            val contentIntent = sbn.notification.contentIntent
            if (contentIntent == null) {
                Log.e(TAG, "No content intent for notification: $key")
                return false
            }

            Log.d(TAG, "Opening notification: $key")
            contentIntent.send()
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error opening notification", e)
            false
        }
    }
}
