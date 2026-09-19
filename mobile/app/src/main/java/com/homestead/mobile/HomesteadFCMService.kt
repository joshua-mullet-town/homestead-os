package com.homestead.mobile

import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Handles incoming FCM push notifications.
 * The server sends these when a session transitions from working → waiting.
 */
class HomesteadFCMService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "HomesteadFCM"
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "New FCM token: $token")
        // Store locally so the ApiServerService can register it with the Homestead server
        getSharedPreferences("homestead_fcm", MODE_PRIVATE)
            .edit().putString("fcm_token", token).apply()
        // Send to server
        registerTokenWithServer(token)
    }

    /**
     * Append one line to the FCM receipt log.
     *
     * WHY THIS EXISTS (Josh, 2026-09-17): "is there an APK you can upload to
     * figure out at which step it's actually failing, or like, let's get more
     * creative here. This is a very frustrating thing where you're like, yup,
     * I'm going to fucking shoot into the dark and tell you what I think it is
     * each time without fucking looking into it."
     *
     * He was right. Notifications have been accepted by FCM and never shown,
     * and every diagnosis so far was made from OUTSIDE the phone — which can
     * only ever show that something did not arrive, never WHERE it stopped.
     * The decisive question is whether onMessageReceived fires at all:
     *
     *   line appears  -> FCM delivered to the app; the loss is AFTER this,
     *                    in how the app posts the notification (channel,
     *                    permission, or the posting call itself)
     *   NO line       -> the message never reached the app; the loss is in
     *                    Google Play Services / the FCM transport, and no
     *                    amount of app-side change can fix it
     *
     * Those two conclusions demand opposite fixes, which is exactly why
     * guessing between them was useless. Logcat already had this evidence via
     * Log.d, but logcat is not reachable without a USB cable — so it is
     * persisted to a file the phone's own HTTP bridge can serve.
     *
     * Deliberately tiny: last 100 lines, appended, best-effort. Instrumentation
     * must never be able to break message handling, so every failure here is
     * swallowed.
     */
    private fun recordFcmReceipt(line: String) {
        try {
            val f = java.io.File(applicationContext.filesDir, "fcm_receipt_log.txt")
            val stamp = java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US)
                .format(java.util.Date())
            val existing = if (f.exists()) f.readLines() else emptyList()
            val kept = (existing + "$stamp  $line").takeLast(100)
            f.writeText(kept.joinToString("\n"))
        } catch (e: Exception) {
            // Never let the log break delivery.
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        Log.d(TAG, "FCM message from: ${remoteMessage.from}")

        val data = remoteMessage.data
        val type = data["type"]

        // FIRST STATEMENT AFTER PARSING, ON PURPOSE: this line is written before
        // any branch can return, so its presence proves the message ARRIVED even
        // if every later step fails. Records what the payload carried, so a
        // wrong-shaped push is distinguishable from a missing one.
        recordFcmReceipt(
            "RECEIVED type=" + (type ?: "<none>")
                + " notifBlock=" + (remoteMessage.notification != null)
                + " title=" + (data["title"] ?: remoteMessage.notification?.title ?: "<none>")
                + " body=" + (data["body"] ?: remoteMessage.notification?.body ?: "<none>")
        )

        if (type == "presenter") {
            val itemId = data["presenter_item_id"] ?: ""
            // Presenter pushes are now DATA-ONLY (no notification block) so this
            // handler always fires, even when the app is backgrounded. Title/body
            // are the short fallback the server puts in `data`; the full body +
            // buttons + image are fetched from the server by presenter_item_id.
            val title = data["title"] ?: remoteMessage.notification?.title ?: "Presenter"
            val body = data["body"] ?: remoteMessage.notification?.body ?: ""
            sendPresenterNotification(itemId, title, body)
            return
        }

        if (type == "dismiss_presenter") {
            val itemId = data["presenter_item_id"] ?: ""
            if (itemId.isNotEmpty()) {
                val notifId = "presenter_$itemId".hashCode()
                Log.d(TAG, "Dismissing presenter notification: $itemId (notifId=$notifId)")
                NotificationManagerCompat.from(this).cancel(notifId)
            }
            return
        }

        // Navigate Home action
        val action = data["action"]
        if (action == "navigate_home") {
            val uri = data["uri"] ?: return
            sendNavigateHomeNotification(uri)
            return
        }

        // Generic custom notification
        if (type == "custom") {
            recordFcmReceipt("  -> branch=custom (will post notification)")
            val title = data["title"] ?: "Homestead"
            val body = data["body"] ?: ""
            val url = data["url"]
            sendCustomNotification(title, body, url)
            return
        }

        val sessionName = data["sessionName"] ?: return
        val status = data["status"] ?: "waiting"

        Log.d(TAG, "Session $sessionName is now $status")

        if (status == "waiting") {
            sendSessionNotification(sessionName)
        }
    }

    private fun sendSessionNotification(sessionName: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                Log.w(TAG, "POST_NOTIFICATIONS permission not granted")
                return
            }
        }

        val displayName = sessionName.removePrefix("holler-").let { stripped ->
            if (stripped.contains("--")) {
                val parts = stripped.split("--", limit = 2)
                "${parts[0]} (${parts[1]})"
            } else {
                stripped
            }
        }

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("open_session", sessionName)
        }
        val pendingIntent = PendingIntent.getActivity(
            this, sessionName.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, HomesteadApp.CHANNEL_SESSION_READY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Session ready")
            .setContentText("$displayName is waiting for input")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        Log.d(TAG, "Showing notification for $sessionName")
        NotificationManagerCompat.from(this)
            .notify(sessionName.hashCode(), notification)
    }

    /**
     * Entry point for a presenter push. The push itself carries only the item id
     * (+ a short fallback body) — the FULL card content, its own bottom buttons,
     * and any image URL are FETCHED from /api/presenter/queue on receipt. This is
     * cap-immune: real card bodies routinely exceed the ~4KB FCM data limit, so we
     * never try to cram them into the push. If the fetch fails (offline, server
     * bounce), we fall back to rendering the short push body with no actions.
     */
    private fun sendPresenterNotification(itemId: String, title: String, body: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                Log.w(TAG, "POST_NOTIFICATIONS permission not granted")
                return
            }
        }

        // Fetch the full item off the main thread, then render the rich notification.
        Thread {
            var fullBody = body
            var buttons: org.json.JSONArray? = null
            try {
                val url = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/presenter/queue")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                val text = conn.inputStream.bufferedReader().readText()
                val items = org.json.JSONObject(text).getJSONArray("queue")
                for (i in 0 until items.length()) {
                    val it = items.getJSONObject(i)
                    if (it.getString("id") == itemId) {
                        fullBody = it.optString("message", body)
                        buttons = it.optJSONArray("buttons")
                        break
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Presenter item fetch failed, falling back to push body: ${e.message}")
            }

            // (1) Strip markdown for the tray body — newlines PRESERVED so line
            //     breaks render as real line breaks (the card keeps raw markdown).
            val displayBody = stripMarkdownKeepNewlines(fullBody)

            // (3) First URL-reachable image in the body → BigPictureStyle.
            val imageUrl = firstImageUrl(fullBody)
            val bitmap = imageUrl?.let { loadBitmap(it) }

            renderPresenterNotification(itemId, title, displayBody, buttons, bitmap)
        }.start()
    }

    private fun renderPresenterNotification(
        itemId: String,
        title: String,
        body: String,
        buttons: org.json.JSONArray?,
        image: android.graphics.Bitmap?,
    ) {
        // (5) Tap → deep-link the presenter to THIS card (steading + card front/active).
        //     MainActivity already consumes these extras (cold + onNewIntent).
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("open_presenter", true)
            putExtra("presenter_item_id", itemId)
        }
        // Per-item request code so each card's tap targets its OWN card, not a
        // shared "presenter" PendingIntent that FLAG_UPDATE_CURRENT would collapse.
        val pendingIntent = PendingIntent.getActivity(
            this, ("presenter_tap_$itemId").hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, HomesteadApp.CHANNEL_PRESENTER)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)

        // (2) No truncation + (3) image. BigPictureStyle when an image loaded,
        //     otherwise BigTextStyle so the FULL body shows when expanded.
        if (image != null) {
            builder.setStyle(
                NotificationCompat.BigPictureStyle()
                    .bigPicture(image)
                    .setBigContentTitle(title)
                    .setSummaryText(body)
            )
            builder.setLargeIcon(image)
        } else {
            builder.setStyle(
                NotificationCompat.BigTextStyle()
                    .setBigContentTitle(title)
                    .bigText(body)
            )
        }

        // (4a) Dismiss action — EXACT same dismiss as the card (POST /api/presenter/dismiss).
        val dismissIntent = Intent(this, PresenterActionReceiver::class.java).apply {
            action = PresenterActionReceiver.ACTION_DISMISS
            putExtra(PresenterActionReceiver.EXTRA_ITEM_ID, itemId)
        }
        val dismissPi = PendingIntent.getBroadcast(
            this, ("presenter_dismiss_$itemId").hashCode(), dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        builder.addAction(R.drawable.ic_launcher, "Dismiss", dismissPi)

        // (4b) The card's OWN bottom buttons as notification actions. Only PLAIN
        //      quick-reply buttons (a bare label, or {label} without `run`) become
        //      actions — they POST to /api/presenter/respond with the button label,
        //      identical to the in-app card button. A {label, run} button is a
        //      LOCAL command (deep-link / shell) that can't run from a broadcast
        //      action, so it's skipped (it stays available in-app on tap-through).
        //      Android caps a notification at ~3 actions; dismiss takes one slot,
        //      so we render up to the first 2 quick-replies.
        if (buttons != null) {
            var added = 0
            for (i in 0 until buttons.length()) {
                if (added >= 2) break
                val b = buttons.get(i)
                val label: String
                if (b is org.json.JSONObject) {
                    if (!b.isNull("run") && b.optString("run").isNotEmpty()) continue
                    label = b.optString("label", "")
                } else {
                    label = b.toString()
                }
                if (label.isEmpty()) continue
                val replyIntent = Intent(this, PresenterActionReceiver::class.java).apply {
                    action = PresenterActionReceiver.ACTION_QUICK_REPLY
                    putExtra(PresenterActionReceiver.EXTRA_ITEM_ID, itemId)
                    putExtra(PresenterActionReceiver.EXTRA_BUTTON_LABEL, label)
                }
                val replyPi = PendingIntent.getBroadcast(
                    this, ("presenter_reply_${itemId}_$i").hashCode(), replyIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                builder.addAction(R.drawable.ic_launcher, label, replyPi)
                added++
            }
        }

        Log.d(TAG, "Showing presenter notification: $title")
        NotificationManagerCompat.from(this)
            .notify("presenter_$itemId".hashCode(), builder.build())
    }

    /**
     * Preview-grade markdown stripper ported from the presenter renderer
     * (public/presenter/app.js stripMarkdownForPreview) with ONE deliberate
     * difference: newlines are PRESERVED (the web version collapses them to
     * spaces). Enhancement #1 requires line breaks to survive into the tray.
     */
    private fun stripMarkdownKeepNewlines(input: String?): String {
        if (input.isNullOrEmpty()) return ""
        var out = input
        // Images ![alt](url) → alt (before links)
        out = Regex("!\\[([^\\]]*)\\]\\([^)]*\\)").replace(out) { it.groupValues[1] }
        // Links [text](url) → text
        out = Regex("\\[([^\\]]+)\\]\\([^)]*\\)").replace(out) { it.groupValues[1] }
        // Bold / italic / strikethrough — unwrap delimiters
        out = Regex("\\*\\*([^*]+)\\*\\*").replace(out) { it.groupValues[1] }
        out = Regex("__([^_]+)__").replace(out) { it.groupValues[1] }
        out = Regex("(^|[^*])\\*([^*\\n]+)\\*").replace(out) { it.groupValues[1] + it.groupValues[2] }
        out = Regex("(^|[^_])_([^_\\n]+)_").replace(out) { it.groupValues[1] + it.groupValues[2] }
        out = Regex("~~([^~]+)~~").replace(out) { it.groupValues[1] }
        // Fenced code ``` … ``` → drop fences (keep inner text + newlines)
        out = Regex("```[\\s\\S]*?```").replace(out) { m -> m.value.replace("```", "") }
        // Inline code `x` → x
        out = Regex("`([^`]+)`").replace(out) { it.groupValues[1] }
        // Leading heading / blockquote / bullet markers, per line
        out = Regex("(?m)^\\s{0,3}#{1,6}\\s+").replace(out, "")
        out = Regex("(?m)^\\s{0,3}>\\s?").replace(out, "")
        out = Regex("(?m)^\\s{0,3}[-*+]\\s+").replace(out, "• ")
        out = Regex("(?m)^\\s{0,3}\\d+\\.\\s+").replace(out) { it.value.trimStart() }
        // Collapse runs of spaces/tabs WITHIN a line, but keep newlines intact.
        out = Regex("[ \\t]+").replace(out, " ")
        // Collapse 3+ blank lines to at most two.
        out = Regex("\\n{3,}").replace(out, "\n\n")
        return out.trim()
    }

    /** First http(s) image URL in the body: markdown ![](url) first, else a bare image-extension URL. */
    private fun firstImageUrl(body: String?): String? {
        if (body.isNullOrEmpty()) return null
        Regex("!\\[[^\\]]*\\]\\((https?://[^)\\s]+)\\)").find(body)?.let { return it.groupValues[1] }
        Regex("https?://[^\\s)\"']+\\.(?:png|jpe?g|gif|webp)(?:\\?[^\\s)\"']*)?", RegexOption.IGNORE_CASE)
            .find(body)?.let { return it.value }
        return null
    }

    /** Load a bitmap from a URL for BigPictureStyle. Best-effort; null on any failure. */
    private fun loadBitmap(url: String): android.graphics.Bitmap? {
        return try {
            val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.doInput = true
            conn.inputStream.use { android.graphics.BitmapFactory.decodeStream(it) }
        } catch (e: Exception) {
            Log.w(TAG, "Image load failed ($url): ${e.message}")
            null
        }
    }

    private fun sendNavigateHomeNotification(uri: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                Log.w(TAG, "POST_NOTIFICATIONS permission not granted")
                return
            }
        }

        val navIntent = Intent(Intent.ACTION_VIEW, Uri.parse(uri))
        val pendingIntent = PendingIntent.getActivity(
            this, "navigate_home".hashCode(), navIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, HomesteadApp.CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Navigate Home")
            .setContentText("Tap to open navigation")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        Log.d(TAG, "Showing navigate home notification: $uri")
        NotificationManagerCompat.from(this)
            .notify("navigate_home".hashCode(), notification)
    }

    private fun sendCustomNotification(title: String, body: String, url: String?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                Log.w(TAG, "POST_NOTIFICATIONS permission not granted")
                return
            }
        }

        val intent = if (url != null) {
            Intent(Intent.ACTION_VIEW, Uri.parse(url))
        } else {
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
        }
        val pendingIntent = PendingIntent.getActivity(
            this, "custom_$title".hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, HomesteadApp.CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        Log.d(TAG, "Showing custom notification: $title")
        NotificationManagerCompat.from(this)
            .notify("custom_$title".hashCode(), notification)
    }

    private fun registerTokenWithServer(token: String) {
        // Fire and forget — register FCM token with the Homestead server
        Thread {
            try {
                val url = java.net.URL("https://joshuas-macbook-air.tail84bb3b.ts.net/api/fcm/register")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.outputStream.write("""{"token":"$token"}""".toByteArray())
                val code = conn.responseCode
                Log.d(TAG, "Token registration response: $code")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to register token: ${e.message}")
            }
        }.start()
    }
}
