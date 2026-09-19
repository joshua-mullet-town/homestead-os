package com.homestead.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

/**
 * In-app updates for Homestead.
 *
 * Josh, 2026-09-06: the only way to update was to leave Homestead, open the
 * separate Recovery app, download there and install from there. This app had
 * the install permission and the FileProvider plumbing already declared — it
 * just never had any code that checked for or installed an update. This is
 * that code, so an update is noticed and taken without leaving the app.
 *
 * The flow, deliberately one tap: a toast slides down saying a build is ready →
 * he taps UPDATE → it downloads in the background with progress on the toast →
 * Android's own install screen opens. Android ALWAYS requires that final
 * confirmation; no app can skip it, so one tap is the real floor here.
 *
 * The download/install half is modelled on the Recovery app's working
 * implementation (StatusFragment), including its hard-won details — see the
 * comments on the connection setup below.
 */
class AppUpdater(private val activity: Activity) {

    companion object {
        private const val TAG = "AppUpdater"
        private const val PREFS = "homestead_updater"
        /** Build timestamp of the version he already dismissed a toast for. */
        private const val KEY_DISMISSED = "dismissed_build"

        // Tags so the toast's own views can be found and re-labelled later.
        private const val TAG_TITLE = "u_title"
        private const val TAG_SUB = "u_sub"
        private const val TAG_BUTTON = "u_button"

        /**
         * Reached over Tailscale, not localhost — the phone is not the Mac.
         * Same base the Recovery app uses, so both agree on what "the server" is.
         */
        private const val BASE = "https://joshuas-macbook-air.tail84bb3b.ts.net"

        /**
         * How often to ask while he is looking at the app.
         *
         * Was 15 minutes, which meant sitting in Homestead he would not hear
         * about a build for up to 15 minutes — he had to hit reload to force a
         * fresh check, which is exactly the "dorky" step this feature exists to
         * remove (Josh, 2026-09-07). A tiny JSON GET on the local tailnet is
         * cheap; 45s reads as immediate.
         */
        private const val POLL_INTERVAL_MS = 45L * 1000L

        /**
         * Floor between two actual network checks.
         *
         * MUST stay below POLL_INTERVAL_MS. When these were equal the throttle
         * rejected the very poll that was due, so the periodic check never
         * actually did anything and only a resume could surface a build.
         */
        private const val MIN_CHECK_GAP_MS = 20L * 1000L

        /** First re-check after coming forward — sooner than the steady cadence. */
        private const val FIRST_RETRY_MS = 22L * 1000L
    }

    private val io = Executors.newSingleThreadExecutor()
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    private var toast: FrameLayout? = null
    private var lastCheckedAt = 0L
    private var busy = false

    /** Downloaded and waiting on the install permission. */
    private var pendingInstall: File? = null

    /** Re-checks while he stays in the app, so a build landing mid-session shows up. */
    private val poll = object : Runnable {
        override fun run() {
            checkForUpdate()
            main.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    private val prefs by lazy {
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    /**
     * Resume a download that finished but could not install because the
     * "install unknown apps" grant was missing. Called on every resume, so
     * returning from that settings screen completes the job by itself.
     */
    private fun resumePendingInstall(): Boolean {
        val file = pendingInstall ?: return false
        val granted = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O ||
            activity.packageManager.canRequestPackageInstalls()
        if (!granted) return true          // still waiting on him; keep holding it
        if (!file.exists()) { pendingInstall = null; return false }
        launchInstaller(file)
        return true
    }

    /** Begin periodic checks. Idempotent — safe to call on every resume. */
    fun start() {
        // If he just granted the permission, finish that install rather than
        // starting a fresh check for the same build. Deliberately does NOT
        // return early: if he declined, the poll must still be rescheduled or
        // a held file would silently kill update checking forever.
        resumePendingInstall()
        main.removeCallbacks(poll)
        // Check right now, then again shortly after: a build that lands in the
        // seconds around a resume would otherwise wait a full interval, which
        // reads as "it didn't work" even though it is only slow.
        checkForUpdate()
        main.postDelayed(poll, FIRST_RETRY_MS)
    }

    /** Stop the periodic check (the app went to the background). */
    fun stop() {
        main.removeCallbacks(poll)
    }

    /**
     * Ask the server whether a newer build exists, and show the toast if so.
     *
     * Safe to call any time — it self-throttles, skips while a download is
     * already running, and does nothing at all when up to date.
     */
    fun checkForUpdate() {
        val now = System.currentTimeMillis()
        if (busy) return
        if (now - lastCheckedAt < MIN_CHECK_GAP_MS) return
        lastCheckedAt = now

        io.execute {
            try {
                val json = fetchJson("$BASE/api/mobile-update")
                if (!json.optBoolean("available", false)) return@execute

                val builtAt = parseIso(json.optString("lastModified", "")) ?: return@execute

                // The app's versionCode is hardcoded and never incremented, so
                // comparing versions would say "same" for every build ever made.
                // Compare BUILD time against INSTALL time instead — the same test
                // the Recovery app uses, and the one that actually works.
                val installedAt = try {
                    activity.packageManager
                        .getPackageInfo(activity.packageName, 0).lastUpdateTime
                } catch (e: Exception) {
                    Log.w(TAG, "Could not read own install time", e)
                    return@execute
                }
                if (installedAt >= builtAt) return@execute

                // Josh chose once-per-build: dismissing silences THIS build, and
                // the next build speaks up again.
                if (prefs.getLong(KEY_DISMISSED, 0L) == builtAt) return@execute

                val size = json.optLong("size", 0L)
                main.post { showToast(builtAt, size) }
            } catch (e: Exception) {
                // Off the tailnet is normal and not worth interrupting him over.
                Log.w(TAG, "Update check failed", e)
            }
        }
    }

    /** Tear the toast down — called when the activity goes away. */
    fun dismiss() {
        main.removeCallbacks(poll)
        toast?.let { t ->
            (t.parent as? ViewGroup)?.removeView(t)
        }
        toast = null
    }

    // ─────────────────────────── the toast ───────────────────────────

    private fun showToast(builtAt: Long, size: Long) {
        if (activity.isFinishing || activity.isDestroyed) return
        if (toast != null) return

        val dp = activity.resources.displayMetrics.density
        val root = activity.window.decorView as? ViewGroup ?: return

        val card = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding((14 * dp).toInt(), (12 * dp).toInt(), (12 * dp).toInt(), (12 * dp).toInt())
            background = GradientDrawable().apply {
                setColor(Color.argb(242, 22, 26, 33))
                cornerRadius = 16 * dp
                setStroke((1 * dp).toInt(), Color.argb(40, 255, 255, 255))
            }
            elevation = 12 * dp
        }

        val textCol = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
        }
        val title = TextView(activity).apply {
            tag = TAG_TITLE
            text = "New version ready"
            setTextColor(Color.WHITE)
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        val sub = TextView(activity).apply {
            tag = TAG_SUB
            text = buildString {
                append(relativeAge(builtAt))
                if (size > 0) append(" · ").append(humanSize(size))
            }
            setTextColor(Color.argb(160, 255, 255, 255))
            textSize = 11.5f
        }
        textCol.addView(title)
        textCol.addView(sub)
        card.addView(textCol, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        val button = TextView(activity).apply {
            tag = TAG_BUTTON
            text = "UPDATE"
            setTextColor(Color.parseColor("#0D1015"))
            textSize = 12f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setPadding((16 * dp).toInt(), (8 * dp).toInt(), (16 * dp).toInt(), (8 * dp).toInt())
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#7FC4FF"))
                cornerRadius = 20 * dp
            }
            isClickable = true
        }
        card.addView(button)

        val wrap = FrameLayout(activity).apply {
            // Below the status bar, and inset from both edges so it reads as a
            // floating toast rather than a docked banner.
            setPadding((12 * dp).toInt(), (46 * dp).toInt(), (12 * dp).toInt(), 0)
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.TOP }
        }
        wrap.addView(card)

        button.setOnClickListener {
            if (busy) return@setOnClickListener
            busy = true
            button.text = "…"
            title.text = "Downloading…"
            sub.text = "starting"
            downloadAndInstall(builtAt, size, title, sub)
        }

        // Swipe up / tap the empty area to dismiss. Dismissing records THIS
        // build so it stays quiet until the next one.
        wrap.setOnClickListener {
            if (busy) return@setOnClickListener
            prefs.edit().putLong(KEY_DISMISSED, builtAt).apply()
            slideOut()
        }

        root.addView(wrap)
        toast = wrap

        // Slide down from behind the status bar.
        wrap.translationY = -220 * dp
        wrap.animate().translationY(0f).setDuration(260).start()
    }

    private fun slideOut() {
        val t = toast ?: return
        val dp = activity.resources.displayMetrics.density
        t.animate().translationY(-220 * dp).setDuration(200).withEndAction {
            (t.parent as? ViewGroup)?.removeView(t)
            if (toast === t) toast = null
        }.start()
    }

    // ────────────────────── download + install ──────────────────────

    private fun downloadAndInstall(
        builtAt: Long,
        expectedSize: Long,
        title: TextView,
        sub: TextView
    ) {
        io.execute {
            try {
                val conn = (URL("$BASE/api/mobile-update/download")
                    .openConnection() as HttpURLConnection).apply {
                    connectTimeout = 30_000
                    readTimeout = 60_000
                    setRequestProperty("Connection", "close")
                }
                if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")

                val file = File(activity.getExternalFilesDir(null), "homestead-update.apk")
                var read = 0L
                conn.inputStream.use { input ->
                    file.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            output.write(buf, 0, n)
                            read += n
                            // Progress, throttled to whole percent so the UI
                            // thread isn't posted to thousands of times.
                            if (expectedSize > 0) {
                                val pct = (read * 100 / expectedSize).toInt()
                                main.post { sub.text = "$pct%  ·  ${humanSize(read)}" }
                            }
                        }
                    }
                }
                conn.disconnect()

                // A truncated download installs as a corrupt package, which is a
                // far worse failure than just retrying — so verify before handing
                // it to Android.
                if (expectedSize > 0 && file.length() != expectedSize) {
                    error("size mismatch: got ${file.length()}, expected $expectedSize")
                }

                main.post {
                    title.text = "Ready to install"
                    sub.text = "tap to finish"
                    busy = false
                    // Taking the update means this build is handled either way.
                    prefs.edit().putLong(KEY_DISMISSED, builtAt).apply()
                    install(file)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Update download failed", e)
                main.post {
                    busy = false
                    title.text = "Update failed"
                    sub.text = "tap to dismiss, or try again later"
                }
            }
        }
    }

    private fun install(file: File) {
        // Android 8+ requires a PER-APP "install unknown apps" grant on top of
        // the REQUEST_INSTALL_PACKAGES manifest permission. Without it the
        // install Intent is SILENTLY DISCARDED — no dialog, no error, no crash.
        // That is exactly what Josh saw on 2026-09-07: the toast said it was
        // downloading, then slid away and nothing ever appeared. The manifest
        // permission alone is NOT enough, and nothing in the failure tells you
        // that, which is why this check has to be explicit.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            promptForInstallPermission(file)
            return
        }
        launchInstaller(file)
    }

    /**
     * Send him to the one settings screen that grants this app the right to
     * install, and hold the downloaded file so the next tap finishes the job.
     */
    private fun promptForInstallPermission(file: File) {
        pendingInstall = file
        val t = toast
        if (t != null) {
            val title = t.findViewWithTag<TextView>(TAG_TITLE)
            val sub = t.findViewWithTag<TextView>(TAG_SUB)
            val button = t.findViewWithTag<TextView>(TAG_BUTTON)
            title?.text = "One-time permission"
            sub?.text = "Allow Homestead to install updates"
            button?.text = "ALLOW"
            button?.visibility = android.view.View.VISIBLE
            button?.setOnClickListener {
                try {
                    activity.startActivity(
                        Intent(
                            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            android.net.Uri.parse("package:${activity.packageName}")
                        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Could not open unknown-sources settings", e)
                    sub?.text = "Settings > Apps > Homestead > Install unknown apps"
                }
            }
        }
    }

    private fun launchInstaller(file: File) {
        try {
            val uri = FileProvider.getUriForFile(
                activity, "${activity.packageName}.fileprovider", file
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            pendingInstall = null
            slideOut()
        } catch (e: Exception) {
            Log.w(TAG, "Install intent failed", e)
            toast?.findViewWithTag<TextView>(TAG_TITLE)?.text = "Install failed"
            toast?.findViewWithTag<TextView>(TAG_SUB)?.text = e.message ?: "unknown error"
        }
    }

    // ─────────────────────────── helpers ───────────────────────────

    private fun fetchJson(url: String): JSONObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8_000
            readTimeout = 8_000
            // A pooled keep-alive socket cached while the phone was off-network
            // throws EOF on read even once the network is back. Forcing a fresh
            // connection is what made this reliable in the Recovery app.
            setRequestProperty("Connection", "close")
        }
        try {
            if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")
            // HttpURLConnection silently FOLLOWS redirects, so the access gate
            // 302-ing a non-owner lands here as a 200 carrying an HTML page.
            // Compare where we asked to go against where we landed.
            if (conn.url.path != URL(url).path) error("redirected to ${conn.url.path}")
            return JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        } finally {
            conn.disconnect()
        }
    }

    private fun parseIso(s: String): Long? {
        if (s.isEmpty()) return null
        return try {
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("UTC")
            }.parse(s)?.time
        } catch (e: Exception) {
            try {
                SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
                    timeZone = TimeZone.getTimeZone("UTC")
                }.parse(s)?.time
            } catch (e2: Exception) {
                null
            }
        }
    }

    private fun relativeAge(then: Long): String {
        val mins = ((System.currentTimeMillis() - then) / 60_000L).coerceAtLeast(0)
        return when {
            mins < 1 -> "just built"
            mins < 60 -> "built ${mins}m ago"
            mins < 60 * 24 -> "built ${mins / 60}h ago"
            else -> "built ${mins / (60 * 24)}d ago"
        }
    }

    private fun humanSize(bytes: Long): String =
        if (bytes >= 1024 * 1024) String.format(Locale.US, "%.1f MB", bytes / 1048576.0)
        else String.format(Locale.US, "%d KB", bytes / 1024)
}
