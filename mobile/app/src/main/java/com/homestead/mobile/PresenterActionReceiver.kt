package com.homestead.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat

/**
 * Handles taps on presenter-notification ACTION buttons (the quick-replies + the
 * dismiss action rendered on the expanded tray notification by
 * HomesteadFCMService.sendPresenterNotification).
 *
 * Each action fires the EXACT same server path the in-app presenter card uses —
 * no reimplementation. A quick-reply POSTs to /api/presenter/respond with the
 * card's own button label; the dismiss action POSTs to /api/presenter/dismiss.
 * Both are idempotent server-side (respondToItem carries a per-send ledger, and a
 * dismiss of an already-gone card is a harmless 404 we swallow). After the POST we
 * cancel the tray notification locally so it disappears immediately.
 */
class PresenterActionReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PresenterAction"
        const val ACTION_QUICK_REPLY = "com.homestead.mobile.PRESENTER_QUICK_REPLY"
        const val ACTION_DISMISS = "com.homestead.mobile.PRESENTER_DISMISS"
        const val EXTRA_ITEM_ID = "presenter_item_id"
        const val EXTRA_BUTTON_LABEL = "presenter_button_label"
        private const val BASE_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val itemId = intent.getStringExtra(EXTRA_ITEM_ID) ?: return
        val notifId = "presenter_$itemId".hashCode()

        when (intent.action) {
            ACTION_QUICK_REPLY -> {
                val label = intent.getStringExtra(EXTRA_BUTTON_LABEL) ?: return
                Log.d(TAG, "Quick-reply on $itemId: \"$label\"")
                // Cancel the notification optimistically — the reply is committing.
                NotificationManagerCompat.from(context).cancel(notifId)
                postRespond(itemId, label)
            }
            ACTION_DISMISS -> {
                Log.d(TAG, "Dismiss on $itemId")
                NotificationManagerCompat.from(context).cancel(notifId)
                postDismiss(itemId)
            }
        }
    }

    /** POST /api/presenter/respond {id, button} — identical to the card's own quick-reply button. */
    private fun postRespond(itemId: String, buttonLabel: String) {
        Thread {
            try {
                val url = java.net.URL("$BASE_URL/api/presenter/respond")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.connectTimeout = 10000
                conn.readTimeout = 30000
                val body = org.json.JSONObject().apply {
                    put("id", itemId)
                    put("button", buttonLabel)
                }
                conn.outputStream.write(body.toString().toByteArray())
                val code = conn.responseCode
                Log.d(TAG, "respond POST for $itemId: $code")
            } catch (e: Exception) {
                Log.w(TAG, "respond POST failed for $itemId: ${e.message}")
            }
        }.start()
    }

    /** POST /api/presenter/dismiss {id} — identical to the card's own dismiss. */
    private fun postDismiss(itemId: String) {
        Thread {
            try {
                val url = java.net.URL("$BASE_URL/api/presenter/dismiss")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.connectTimeout = 10000
                conn.readTimeout = 15000
                conn.outputStream.write(org.json.JSONObject().put("id", itemId).toString().toByteArray())
                val code = conn.responseCode
                Log.d(TAG, "dismiss POST for $itemId: $code")
            } catch (e: Exception) {
                Log.w(TAG, "dismiss POST failed for $itemId: ${e.message}")
            }
        }.start()
    }
}
