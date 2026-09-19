package com.homestead.mobile

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.app.WallpaperManager
import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.CountDownTimer
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.ContactsContract
import android.provider.Settings
import android.provider.Telephony
import android.telephony.SmsManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import android.location.LocationManager
import androidx.core.content.ContextCompat
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class ApiServerService : Service() {

    private var server: ApplicationEngine? = null
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Siswapt/worker session names to exclude from "session ready" notifications
    @Volatile
    private var workerSessionNames: Set<String> = setOf()

    // Captures the last swallowed exception from a contact-write op (add/setNotes)
    // so the API can surface the REAL cause instead of a generic "Failed to..." string.
    @Volatile
    private var lastContactWriteError: String? = null

    // ── Timer engine (in-memory) ──
    data class ActiveTimer(
        val id: String,
        val durationSeconds: Int,
        val startedAtMs: Long,
        val endsAtMs: Long,
        var countDownTimer: CountDownTimer? = null
    ) {
        val remainingMs get() = (endsAtMs - System.currentTimeMillis()).coerceAtLeast(0)
        val isFinished get() = System.currentTimeMillis() >= endsAtMs
    }

    private val activeTimers = ConcurrentHashMap<String, ActiveTimer>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val TIMER_NOTIF_ID_BASE = 60000

    companion object {
        private const val TAG = "ApiServerService"
        private const val NOTIFICATION_ID = 1

        // Broadcast actions for service state
        const val ACTION_SERVER_STARTED = "com.homestead.mobile.SERVER_STARTED"
        const val ACTION_SERVER_STOPPED = "com.homestead.mobile.SERVER_STOPPED"

        // Static flag to track running state
        @Volatile
        var isRunning: Boolean = false
            private set
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service created")
    }

    private val pollClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private val homesteadBaseUrl = "https://joshuas-macbook-air.tail84bb3b.ts.net"

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "Service starting...")
        startForeground(NOTIFICATION_ID, createNotification())
        startServer()
        startSessionPolling()
        startSmartAppsPrecomputation()
        return START_STICKY
    }

    /**
     * Polls session statuses every 30s from the foreground service.
     * This runs even when the app UI is in the background.
     */
    private fun startSessionPolling() {
        serviceScope.launch {
            // Initial delay to let things settle
            delay(5_000)
            Log.d(TAG, "Session polling loop started")

            while (isActive) {
                try {
                    val statuses = fetchSessionStatuses()
                    if (statuses.isNotEmpty()) {
                        checkForReadySessions(statuses)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Session poll error: ${e.message}")
                }
                delay(30_000)
            }
        }
    }

    /**
     * Checks every 30 minutes if the smart apps cache needs refresh.
     * Also refreshes the steward names list for notification filtering.
     */
    private fun startSmartAppsPrecomputation() {
        serviceScope.launch {
            delay(10_000) // Initial delay
            Log.d(TAG, "Smart apps precomputation loop started")

            // Fetch steward names immediately on startup
            refreshWorkerSessionNames()

            while (isActive) {
                try {
                    if (SmartAppScoring.cacheNeedsRefresh(this@ApiServerService)) {
                        Log.d(TAG, "Smart apps cache stale, refreshing...")
                        SmartAppScoring.precomputeLaunchCache(this@ApiServerService)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Smart apps precomputation error: ${e.message}")
                }

                // Refresh worker names each cycle too
                refreshWorkerSessionNames()

                delay(30 * 60 * 1000L) // 30 minutes
            }
        }
    }

    /**
     * Fetches steward directory names from the server and builds the set of
     * worker session names (holler-{name}) to exclude from notifications.
     */
    private fun refreshWorkerSessionNames() {
        try {
            val request = Request.Builder()
                .url("$homesteadBaseUrl/api/stewards")
                .get()
                .build()

            val response = pollClient.newCall(request).execute()
            val body = response.body?.string() ?: return
            val json = JSONObject(body)
            val arr = json.optJSONArray("stewards") ?: return

            val names = mutableSetOf<String>()
            for (i in 0 until arr.length()) {
                val name = arr.getJSONObject(i).optString("name", "")
                if (name.isNotEmpty()) {
                    names.add("holler-$name")
                }
            }

            workerSessionNames = names
            Log.d(TAG, "Refreshed worker session names: $names")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to fetch steward names: ${e.message}")
        }
    }

    private suspend fun fetchSessionStatuses(): Map<String, String> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$homesteadBaseUrl/api/claude-sessions")
            .get()
            .build()

        val response = pollClient.newCall(request).execute()
        val body = response.body?.string() ?: return@withContext emptyMap()
        val json = JSONObject(body)
        val sessionsArray = json.optJSONArray("sessions") ?: return@withContext emptyMap()

        val statuses = mutableMapOf<String, String>()
        for (i in 0 until sessionsArray.length()) {
            val session = sessionsArray.getJSONObject(i)
            val tmuxSession = session.optString("tmuxSession", session.optString("tmux_session", ""))
            val status = session.optString("status", "idle")
            if (tmuxSession.isNotEmpty()) {
                statuses[tmuxSession] = status
            }
        }
        statuses
    }

    private fun checkForReadySessions(newStatuses: Map<String, String>) {
        val prefs = getSharedPreferences("homestead_session_status", Context.MODE_PRIVATE)
        val appPrefs = getSharedPreferences("homestead_app_state", Context.MODE_PRIVATE)
        val editor = prefs.edit()

        for ((sessionName, newStatus) in newStatuses) {
            val prevStatus = prefs.getString("status_$sessionName", null)
            Log.d(TAG, "Session poll: $sessionName prev=$prevStatus new=$newStatus")

            if (prevStatus == "working" && newStatus == "waiting") {
                val now = System.currentTimeMillis()
                editor.putLong("status_change_$sessionName", now)

                // Skip notifications for worker/steward sessions
                if (sessionName in workerSessionNames) {
                    Log.d(TAG, "Skipping notification for worker session: $sessionName")
                } else {
                    sendSessionNotification(sessionName)
                }
            }

            editor.putString("status_$sessionName", newStatus)
        }
        editor.apply()
    }

    private fun sendSessionNotification(sessionName: String) {
        // Check notification permission (Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
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

        Log.d(TAG, "Sending session ready notification for $sessionName")
        androidx.core.app.NotificationManagerCompat.from(this)
            .notify(sessionName.hashCode(), notification)
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "Service destroying...")
        isRunning = false
        sendBroadcast(Intent(ACTION_SERVER_STOPPED))
        serviceScope.cancel()
        server?.stop(1000, 2000, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    private fun createNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        val ipAddress = getLocalIpAddress() ?: "localhost"

        return NotificationCompat.Builder(this, HomesteadApp.CHANNEL_ID)
            .setContentTitle("Homestead API Server")
            .setContentText("Running on $ipAddress:${HomesteadApp.SERVER_PORT}")
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun startServer() {
        val exceptionHandler = kotlinx.coroutines.CoroutineExceptionHandler { _, throwable ->
            Log.e(TAG, "Server error: ${throwable.message}", throwable)
            isRunning = false
            sendBroadcast(Intent(ACTION_SERVER_STOPPED))
        }

        serviceScope.launch(exceptionHandler) {
            try {
                server = embeddedServer(CIO, port = HomesteadApp.SERVER_PORT) {
                    install(ContentNegotiation) {
                        json(Json {
                            prettyPrint = true
                            isLenient = true
                            ignoreUnknownKeys = true
                        })
                    }

                    install(CORS) {
                        anyHost()
                        allowMethod(HttpMethod.Get)
                        allowMethod(HttpMethod.Post)
                        allowMethod(HttpMethod.Put)
                        allowMethod(HttpMethod.Delete)
                        allowMethod(HttpMethod.Options)
                        allowHeader(HttpHeaders.ContentType)
                        allowHeader(HttpHeaders.Authorization)
                    }

                    install(StatusPages) {
                        exception<Throwable> { call, cause ->
                            Log.e(TAG, "Error handling request", cause)
                            call.respond(
                                HttpStatusCode.InternalServerError,
                                ApiResponse<String>(success = false, error = cause.message ?: "Unknown error")
                            )
                        }
                    }

                    routing {
                        // Health check
                        get("/") {
                            call.respond(ApiResponse(
                                success = true,
                                data = mapOf(
                                    "name" to "Homestead Mobile API",
                                    "version" to "1.0.0",
                                    "ip" to (getLocalIpAddress() ?: "unknown")
                                )
                            ))
                        }

                        get("/health") {
                            call.respond(ApiResponse(success = true, data = "healthy"))
                        }

                        // FCM receipt log — answers "did the push reach this app?"
                        //
                        // The one question that cannot be answered from the server
                        // side. FCM reporting `sent: 1, failed: 0` is a statement
                        // about Google accepting the message, not about this device
                        // receiving it; when a notification never appears, the
                        // server cannot tell a transport failure from a rendering
                        // failure. HomesteadFCMService writes a line here the
                        // moment onMessageReceived fires, so:
                        //   entries present  -> delivered to the app, lost after
                        //   entries absent   -> never reached the app at all
                        get("/fcm-log") {
                            val f = java.io.File(applicationContext.filesDir, "fcm_receipt_log.txt")
                            val body = org.json.JSONObject().apply {
                                put("success", true)
                                put("exists", f.exists())
                                put("log", if (f.exists()) f.readText() else "")
                                put("lines", if (f.exists()) f.readLines().size else 0)
                            }.toString()
                            call.respondText(body, ContentType.Application.Json)
                        }

                        // Crash log endpoint — returns recent crash reports
                        get("/crash-log") {
                            val crashFile = java.io.File(applicationContext.filesDir, "crash_log.txt")
                            if (crashFile.exists() && crashFile.length() > 0) {
                                val log = crashFile.readText()
                                call.respondText(
                                    org.json.JSONObject().apply {
                                        put("success", true)
                                        put("crashes", log)
                                        put("size", crashFile.length())
                                    }.toString(),
                                    io.ktor.http.ContentType.Application.Json
                                )
                            } else {
                                call.respondText(
                                    org.json.JSONObject().apply {
                                        put("success", true)
                                        put("crashes", "")
                                        put("message", "No crashes recorded")
                                    }.toString(),
                                    io.ktor.http.ContentType.Application.Json
                                )
                            }
                        }

                        // Clear crash log
                        post("/crash-log/clear") {
                            val crashFile = java.io.File(applicationContext.filesDir, "crash_log.txt")
                            if (crashFile.exists()) crashFile.delete()
                            call.respond(ApiResponse(success = true, data = "Crash log cleared"))
                        }

                        // WebView wedge diagnostic log — buffered ring of recent WebView
                        // lifecycle events (page loads, render-process death, console errors).
                        // Written by WedgeDiagLogger from WebViewFragment.
                        get("/wedge-log") {
                            val wedgeFile = java.io.File(applicationContext.filesDir, "wedge_log.txt")
                            if (wedgeFile.exists() && wedgeFile.length() > 0) {
                                call.respondText(
                                    org.json.JSONObject().apply {
                                        put("success", true)
                                        put("log", wedgeFile.readText())
                                        put("size", wedgeFile.length())
                                    }.toString(),
                                    io.ktor.http.ContentType.Application.Json
                                )
                            } else {
                                call.respondText(
                                    org.json.JSONObject().apply {
                                        put("success", true)
                                        put("log", "")
                                        put("message", "No wedge events recorded")
                                    }.toString(),
                                    io.ktor.http.ContentType.Application.Json
                                )
                            }
                        }

                        // Plain-text variant for quick browser viewing
                        get("/wedge-log/raw") {
                            val wedgeFile = java.io.File(applicationContext.filesDir, "wedge_log.txt")
                            val body = if (wedgeFile.exists()) wedgeFile.readText() else "(empty)"
                            call.respondText(body, io.ktor.http.ContentType.Text.Plain)
                        }

                        post("/wedge-log/clear") {
                            val wedgeFile = java.io.File(applicationContext.filesDir, "wedge_log.txt")
                            if (wedgeFile.exists()) wedgeFile.delete()
                            call.respond(ApiResponse(success = true, data = "Wedge log cleared"))
                        }

                        // Open URI on phone (sms:, tel:, mailto:, etc.)
                        post("/open-uri") {
                            val body = call.receiveText()
                            val json = kotlinx.serialization.json.Json.parseToJsonElement(body).jsonObject
                            val uri = json["uri"]?.jsonPrimitive?.content
                                ?: throw IllegalArgumentException("'uri' is required")
                            val parsedUri = android.net.Uri.parse(uri)
                            val intent = Intent(Intent.ACTION_VIEW, parsedUri).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            val scheme = parsedUri.scheme?.lowercase()
                            if (scheme == "http" || scheme == "https") {
                                val chooser = Intent.createChooser(intent, "Open with").apply {
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                }
                                applicationContext.startActivity(chooser)
                            } else {
                                applicationContext.startActivity(intent)
                            }
                            call.respond(ApiResponse(success = true, data = "Opened: $uri"))
                        }

                        // SMS endpoints
                        route("/sms") {
                            get("/inbox") {
                                val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 20
                                val messages = readSmsInbox(limit)
                                call.respond(ApiResponse(success = true, data = messages))
                            }

                            get("/sent") {
                                val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 20
                                val messages = readSmsSent(limit)
                                call.respond(ApiResponse(success = true, data = messages))
                            }

                            post("/send") {
                                val request = call.receive<SendSmsRequest>()
                                val result = sendSms(request.to, request.message)
                                if (result) {
                                    call.respond(ApiResponse<String>(success = true, data = "SMS sent to ${request.to}"))
                                } else {
                                    call.respond(HttpStatusCode.InternalServerError,
                                        ApiResponse<String>(success = false, error = "Failed to send SMS"))
                                }
                            }

                            post("/send-group") {
                                val request = call.receive<SendGroupSmsRequest>()
                                val results = sendGroupSms(request.to, request.message)
                                call.respond(ApiResponse(success = true, data = results))
                            }

                            post("/draft") {
                                val body = call.receiveText()
                                val json = kotlinx.serialization.json.Json.parseToJsonElement(body).jsonObject
                                val message = json["message"]?.jsonPrimitive?.content ?: ""
                                val toElement = json["to"] ?: throw IllegalArgumentException("'to' is required")

                                val recipients = when {
                                    toElement is kotlinx.serialization.json.JsonArray ->
                                        toElement.map { it.jsonPrimitive.content }
                                    toElement is kotlinx.serialization.json.JsonPrimitive ->
                                        listOf(toElement.content)
                                    else -> throw IllegalArgumentException("'to' must be a string or string[]")
                                }

                                val draftIds = mutableListOf<Long>()
                                val uris = mutableListOf<String>()
                                for (recipient in recipients) {
                                    val draftId = createSmsDraft(recipient, message)
                                    draftIds.add(draftId)
                                    uris.add(buildSmsUri(recipient, message))
                                }

                                call.respond(ApiResponse(success = true, data = SmsDraftResult(
                                    draftIds = draftIds,
                                    uris = uris
                                )))
                            }
                        }

                        // Contacts endpoints
                        route("/contacts") {
                            get {
                                val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 100
                                val contacts = readContacts(limit)
                                call.respond(ApiResponse(success = true, data = contacts))
                            }

                            get("/search") {
                                val query = call.request.queryParameters["q"] ?: ""
                                val contacts = searchContacts(query)
                                call.respond(ApiResponse(success = true, data = contacts))
                            }

                            post("/add") {
                                val request = call.receive<AddContactRequest>()
                                val contact = addContact(request.name, request.phone, request.email)
                                if (contact != null) {
                                    call.respond(ApiResponse(success = true, data = contact))
                                } else {
                                    call.respond(HttpStatusCode.InternalServerError,
                                        ApiResponse<String>(success = false, error = "Failed to create contact" +
                                            (lastContactWriteError?.let { " — $it" } ?: "")))
                                }
                            }

                            // Set/update the standard Notes field on an existing contact.
                            post("/notes") {
                                val request = call.receive<SetContactNotesRequest>()
                                val ok = setContactNotes(request.id, request.notes)
                                if (ok) {
                                    call.respond(ApiResponse(success = true, data = mapOf(
                                        "id" to request.id,
                                        "notes" to request.notes
                                    )))
                                } else {
                                    call.respond(HttpStatusCode.InternalServerError,
                                        ApiResponse<String>(success = false, error = "Failed to set contact notes" +
                                            (lastContactWriteError?.let { " — $it" } ?: "")))
                                }
                            }
                        }

                        // Wallpaper diagnostic — added while chasing "Phone mode shows
                        // black instead of the wallpaper". Reports what the system
                        // actually thinks is set, so we stop guessing from the Mac.
                        get("/wallpaper-debug") {
                            val wm = WallpaperManager.getInstance(this@ApiServerService)
                            val info = mutableMapOf<String, String>()
                            info["wallpaperInfo(live)"] = (wm.wallpaperInfo?.packageName ?: "null (static or none)")
                            info["wallpaperId(SYSTEM)"] = try {
                                wm.getWallpaperId(WallpaperManager.FLAG_SYSTEM).toString()
                            } catch (e: Exception) { "err: ${'$'}{e.message}" }
                            info["wallpaperId(LOCK)"] = try {
                                wm.getWallpaperId(WallpaperManager.FLAG_LOCK).toString()
                            } catch (e: Exception) { "err: ${'$'}{e.message}" }
                            info["colors(SYSTEM)"] = try {
                                wm.getWallpaperColors(WallpaperManager.FLAG_SYSTEM)?.toString() ?: "null"
                            } catch (e: Exception) { "err: ${'$'}{e.message}" }
                            info["isSetWallpaperAllowed"] = try {
                                wm.isSetWallpaperAllowed.toString()
                            } catch (e: Exception) { "err: ${'$'}{e.message}" }
                            info["isWallpaperSupported"] = try {
                                wm.isWallpaperSupported.toString()
                            } catch (e: Exception) { "err: ${'$'}{e.message}" }
                            // What the LIVE window actually looks like right now —
                            // this is the half the wallpaper APIs can't tell us.
                            // LIVE readings — read straight off the current window.
                            // These are the ones that can actually catch the bug:
                            // the "last*" fields below are only mirrors of what we
                            // last WROTE, so they still say true after the system
                            // has silently dropped the flag underneath us.
                            info["flagShowWallpaperSet"] = MainActivity.liveShowWallpaperFlag()
                            info["chromeAppliedFor"] = MainActivity.liveChromeMode()
                            // The stale mirrors, kept for comparison. A disagreement
                            // between live* and last* IS the drift.
                            info["lastWroteFlag(mirror)"] = MainActivity.lastChromeFlagState
                            info["lastWroteMode(mirror)"] = MainActivity.lastChromeMode
                            // Self-heal telemetry: how often the chrome had to be
                            // re-armed because the window had drifted.
                            info["chromeHealCount"] = MainActivity.chromeHealCount.toString()
                            info["lastChromeHeal"] = MainActivity.lastChromeHeal
                            info["healDisabled"] = MainActivity.chromeHealDisabled.toString()
                            // Discriminator between the two failure mechanisms:
                            // a CHANGED instance id across a sighting means the
                            // activity was recreated (new window, flags gone);
                            // an UNCHANGED id with the flag reading true means
                            // the window manager simply did not re-pick us as
                            // the wallpaper target.
                            info["activityInstanceId"] = MainActivity.activityInstanceId
                            info["activityCreateCount"] = MainActivity.activityCreateCount.toString()
                            // Build marker — proves which APK is actually running on
                            // the phone, so a fix can never be "verified" against a
                            // stale install. Bump on every behavioural change here.
                            info["wallpaperFixBuild"] = "TILE_STALE_HANDLER_GUARD_v10"
                            // With the Launcher3-style permanent wallpaper window, the
                            // flag must read true in BOTH modes. A false here is a real
                            // regression; it is no longer expected in Homestead mode.
                            info["expectFlagAlwaysTrue"] = "true"
                            // Whether we last asked the platform to STOP keeping a
                            // recents screenshot of this task — the stale frame that
                            // used to get replayed behind Phone mode.
                            info["recentsScreenshotSuppressed"] = MainActivity.lastRecentsScreenshotSuppressed
                            // THE stale-frame discriminator. Orphaned home fragments
                            // restored from a previous activity instance are opaque
                            // WebViews that keep drawing over the wallpaper — this is
                            // the actual cause of the old-image bug. Expect exactly 3
                            // live (presenter/homestead/phonemode); more means orphans.
                            info["homeFragmentsLive"] = MainActivity.liveHomeFragmentCount()
                            info["homeFragmentsExpected"] = "3"
                            info["orphanFragmentsRemoved"] = MainActivity.orphanFragmentsRemoved.toString()
                            // >0 means a mode reveal failed to signal completion and
                            // the watchdog had to un-stick the mode button.
                            info["modeAnimWatchdogTrips"] = MainActivity.modeAnimWatchdogTrips.toString()
                            // "system" is what the mode button trusts; "flag" is the
                            // old unreliable one. A mismatch is the dead-button bug.
                            info["homesteadOnScreen"] = MainActivity.liveOnScreenReport()
                            call.respond(ApiResponse(success = true, data = info))
                        }

                        // Diagnostic controls for the "Phone mode goes black" bug.
                        // Josh cannot reproduce it on demand, so the failure has to
                        // be forced deliberately: drop the wallpaper flag, read the
                        // live state (RED), then heal and read it again (GREEN).
                        // These only poke this app's own window — nothing system-wide.
                        post("/wallpaper-debug/drop-flag") {
                            call.respond(ApiResponse(success = true,
                                data = MainActivity.debugDropWallpaperFlag()))
                        }
                        // Fire the overlay's home button handler for real, and
                        // report the mode before/after — so the in-app mode
                        // switch can be proven from the Mac without driving taps
                        // on Josh's screen while he is using the phone.
                        post("/wallpaper-debug/tap-home") {
                            call.respond(ApiResponse(success = true,
                                data = MainActivity.debugTapOverlayHome()))
                        }
                        post("/wallpaper-debug/heal-now") {
                            call.respond(ApiResponse(success = true,
                                data = MainActivity.debugHealNow()))
                        }
                        // The floating record rail: what it is doing right now,
                        // and a way to drive it through each state from the Mac.
                        // Read-only GET; the POST fires the real mode switch and
                        // the real typing box, so it proves actual behaviour
                        // rather than blind-tapping Josh's screen while he uses it.
                        get("/rail-debug") {
                            call.respond(ApiResponse(success = true,
                                data = RecordingService.overlayVisibilityReport()))
                        }
                        // Every distinct visibility decision the rail has made,
                        // with its inputs. Josh's ordinary use writes this, so the
                        // rules can be proven without holding his screen awake.
                        get("/rail-debug/history") {
                            call.respond(ApiResponse(success = true,
                                data = RecordingService.overlayDecisionHistory()))
                        }
                        // Real measured widths of the button cluster, so a
                        // layout gap can be diagnosed without guessing (Josh
                        // 2026-09-11).
                        get("/layout-debug") {
                            call.respond(ApiResponse(success = true,
                                data = MainActivity.debugLayoutReport()))
                        }
                        post("/rail-debug/set") {
                            val mode = call.request.queryParameters["mode"]
                            val textBox = call.request.queryParameters["textBox"]
                            val record = call.request.queryParameters["record"]
                            call.respond(ApiResponse(success = true,
                                data = MainActivity.debugSetRailState(mode, textBox, record)))
                        }

                        post("/wallpaper-debug/set-heal") {
                            val enabled = call.request.queryParameters["enabled"] != "false"
                            MainActivity.chromeHealDisabled = !enabled
                            call.respond(ApiResponse(success = true,
                                data = "healDisabled=${'$'}{MainActivity.chromeHealDisabled}"))
                        }

                        // Notifications endpoints
                        route("/notifications") {
                            get {
                                val listener = HomesteadNotificationListener.instance
                                if (listener == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Notification listener not enabled. Grant permission in Settings > Apps > Special access > Notification access"))
                                } else {
                                    val notifications = listener.getAllNotifications()
                                    call.respond(ApiResponse(success = true, data = notifications))
                                }
                            }

                            get("/status") {
                                call.respond(ApiResponse(success = true, data = mapOf(
                                    "enabled" to HomesteadNotificationListener.isRunning()
                                )))
                            }

                            post("/dismiss") {
                                val listener = HomesteadNotificationListener.instance
                                if (listener == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Notification listener not enabled"))
                                } else {
                                    val request = call.receive<DismissNotificationRequest>()
                                    val result = listener.dismissNotification(request.key)
                                    if (result) {
                                        call.respond(ApiResponse<String>(success = true, data = "Notification dismissed"))
                                    } else {
                                        call.respond(HttpStatusCode.InternalServerError,
                                            ApiResponse<String>(success = false, error = "Failed to dismiss notification"))
                                    }
                                }
                            }

                            post("/dismiss-all") {
                                val listener = HomesteadNotificationListener.instance
                                if (listener == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Notification listener not enabled"))
                                } else {
                                    val result = listener.dismissAllNotifications()
                                    if (result) {
                                        call.respond(ApiResponse<String>(success = true, data = "All notifications dismissed"))
                                    } else {
                                        call.respond(HttpStatusCode.InternalServerError,
                                            ApiResponse<String>(success = false, error = "Failed to dismiss notifications"))
                                    }
                                }
                            }

                            // Trigger a notification action button (e.g., "Reply", "Mark as Read")
                            post("/action") {
                                val listener = HomesteadNotificationListener.instance
                                if (listener == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Notification listener not enabled"))
                                } else {
                                    val request = call.receive<NotificationActionRequest>()
                                    val result = listener.triggerAction(request.key, request.actionIndex)
                                    if (result) {
                                        call.respond(ApiResponse<String>(success = true, data = "Action triggered"))
                                    } else {
                                        call.respond(HttpStatusCode.InternalServerError,
                                            ApiResponse<String>(success = false, error = "Failed to trigger action"))
                                    }
                                }
                            }

                            // Open/tap on a notification (triggers the main content intent)
                            post("/open") {
                                val listener = HomesteadNotificationListener.instance
                                if (listener == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Notification listener not enabled"))
                                } else {
                                    val request = call.receive<OpenNotificationRequest>()
                                    val result = listener.openNotification(request.key)
                                    if (result) {
                                        call.respond(ApiResponse<String>(success = true, data = "Notification opened"))
                                    } else {
                                        call.respond(HttpStatusCode.InternalServerError,
                                            ApiResponse<String>(success = false, error = "Failed to open notification"))
                                    }
                                }
                            }
                        }

                        // Device info
                        get("/device") {
                            call.respond(ApiResponse(
                                success = true,
                                data = mapOf(
                                    "model" to Build.MODEL,
                                    "manufacturer" to Build.MANUFACTURER,
                                    "sdk" to Build.VERSION.SDK_INT,
                                    "ip" to (getLocalIpAddress() ?: "unknown")
                                )
                            ))
                        }

                        // App launch endpoints
                        route("/app") {
                            post("/launch") {
                                val request = call.receive<AppLaunchRequest>()
                                val result = launchApp(request)
                                if (result.success) {
                                    call.respond(ApiResponse<String>(success = true, data = result.message))
                                } else {
                                    call.respond(HttpStatusCode.BadRequest,
                                        ApiResponse<String>(success = false, error = result.message))
                                }
                            }

                            get("/list") {
                                val apps = getInstalledApps()
                                call.respond(ApiResponse(success = true, data = apps))
                            }
                        }

                        // Alarm endpoints (self-managed via AlarmTimerManager)
                        route("/alarm") {
                            post("/set") {
                                val request = call.receive<SetAlarmRequest>()
                                val entry = AlarmTimerManager.setAlarm(
                                    this@ApiServerService,
                                    request.hour, request.minute,
                                    request.label ?: "Alarm"
                                )
                                val data = JSONObject().apply {
                                    put("id", entry.id)
                                    put("hour", entry.hour)
                                    put("minute", entry.minute)
                                    put("label", entry.label)
                                    put("firesAt", entry.nextFireTimeMs())
                                }
                                call.respondText(
                                    JSONObject().put("success", true).put("data", data).toString(),
                                    ContentType.Application.Json
                                )
                            }

                            get("/list") {
                                val alarms = AlarmTimerManager.listAlarms(this@ApiServerService)
                                val arr = org.json.JSONArray()
                                for (a in alarms) {
                                    arr.put(JSONObject().apply {
                                        put("id", a.id)
                                        put("hour", a.hour)
                                        put("minute", a.minute)
                                        put("label", a.label)
                                        put("firesAt", a.nextFireTimeMs())
                                    })
                                }
                                call.respondText(
                                    JSONObject().put("success", true).put("data", arr).toString(),
                                    ContentType.Application.Json
                                )
                            }

                            post("/delete") {
                                val request = call.receive<DeleteAlarmRequest>()
                                val removed = AlarmTimerManager.deleteAlarm(this@ApiServerService, request.id)
                                if (removed) {
                                    call.respond(ApiResponse<String>(success = true, data = "Alarm deleted"))
                                } else {
                                    call.respond(HttpStatusCode.NotFound,
                                        ApiResponse<String>(success = false, error = "Alarm not found: ${request.id}"))
                                }
                            }
                        }

                        // Timer endpoints (in-memory engine)
                        route("/timer") {
                            post("/start") {
                                val request = call.receive<StartTimerRequest>()
                                val seconds = if (request.presetId != null) {
                                    val presets = AlarmTimerManager.getTimerPresets(this@ApiServerService)
                                    presets.find { it.id == request.presetId }?.seconds
                                        ?: return@post call.respond(HttpStatusCode.NotFound,
                                            ApiResponse<String>(success = false, error = "Preset not found: ${request.presetId}"))
                                } else {
                                    request.durationSeconds
                                        ?: return@post call.respond(HttpStatusCode.BadRequest,
                                            ApiResponse<String>(success = false, error = "Provide durationSeconds or presetId"))
                                }

                                // Kill any existing timers (single-instance)
                                for (existing in activeTimers.values) {
                                    existing.countDownTimer?.cancel()
                                }
                                activeTimers.clear()

                                val id = UUID.randomUUID().toString().take(8)
                                val now = System.currentTimeMillis()
                                val timer = ActiveTimer(
                                    id = id,
                                    durationSeconds = seconds,
                                    startedAtMs = now,
                                    endsAtMs = now + seconds * 1000L
                                )
                                activeTimers[id] = timer
                                startTimerOnMain(timer)

                                val data = JSONObject().apply {
                                    put("id", id)
                                    put("durationSeconds", seconds)
                                    put("endsAt", timer.endsAtMs)
                                }
                                call.respondText(
                                    JSONObject().put("success", true).put("data", data).toString(),
                                    ContentType.Application.Json
                                )
                            }

                            post("/stop") {
                                val request = call.receive<StopTimerRequest>()
                                val timer = activeTimers.remove(request.id)
                                if (timer != null) {
                                    timer.countDownTimer?.cancel()
                                    call.respond(ApiResponse<String>(success = true, data = "Timer stopped"))
                                } else {
                                    call.respond(HttpStatusCode.NotFound,
                                        ApiResponse<String>(success = false, error = "Timer not found: ${request.id}"))
                                }
                            }

                            post("/reset") {
                                val request = call.receive<StopTimerRequest>()
                                val old = activeTimers.remove(request.id)
                                if (old != null) {
                                    old.countDownTimer?.cancel()
                                    val now = System.currentTimeMillis()
                                    val newTimer = ActiveTimer(
                                        id = old.id,
                                        durationSeconds = old.durationSeconds,
                                        startedAtMs = now,
                                        endsAtMs = now + old.durationSeconds * 1000L
                                    )
                                    activeTimers[old.id] = newTimer
                                    startTimerOnMain(newTimer)
                                    call.respond(ApiResponse<String>(success = true, data = "Timer reset"))
                                } else {
                                    call.respond(HttpStatusCode.NotFound,
                                        ApiResponse<String>(success = false, error = "Timer not found: ${request.id}"))
                                }
                            }

                            get("/list") {
                                val arr = org.json.JSONArray()
                                for (t in activeTimers.values) {
                                    arr.put(JSONObject().apply {
                                        put("id", t.id)
                                        put("durationSeconds", t.durationSeconds)
                                        put("remainingMs", t.remainingMs)
                                        put("isFinished", t.isFinished)
                                        put("endsAt", t.endsAtMs)
                                    })
                                }
                                call.respondText(
                                    JSONObject().put("success", true).put("data", arr).toString(),
                                    ContentType.Application.Json
                                )
                            }

                            get("/presets") {
                                val presets = AlarmTimerManager.getTimerPresets(this@ApiServerService)
                                val arr = org.json.JSONArray()
                                for (p in presets) {
                                    arr.put(JSONObject().apply {
                                        put("id", p.id)
                                        put("seconds", p.seconds)
                                    })
                                }
                                call.respondText(
                                    JSONObject().put("success", true).put("data", arr).toString(),
                                    ContentType.Application.Json
                                )
                            }

                            post("/presets/update") {
                                val request = call.receive<UpdatePresetRequest>()
                                val ok = AlarmTimerManager.updateTimerPreset(
                                    this@ApiServerService, request.id, request.seconds
                                )
                                if (ok) {
                                    call.respond(ApiResponse<String>(success = true, data = "Preset updated"))
                                } else {
                                    call.respond(HttpStatusCode.NotFound,
                                        ApiResponse<String>(success = false, error = "Preset not found: ${request.id}"))
                                }
                            }
                        }

                        // Screen control endpoints
                        route("/screen") {
                            post("/wake") {
                                val result = wakeScreen()
                                call.respond(ApiResponse<String>(success = result, data = if (result) "Screen woken" else null, error = if (!result) "Failed to wake screen" else null))
                            }

                            get("/brightness") {
                                val brightness = getScreenBrightness()
                                call.respond(ApiResponse(success = true, data = mapOf("brightness" to brightness)))
                            }

                            // Accessibility-based screen control
                            get("/content") {
                                val a11y = HomesteadAccessibilityService.instance
                                if (a11y == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Accessibility service not running. Enable it in Settings > Accessibility > Homestead"))
                                } else {
                                    val content = a11y.getScreenContent()
                                    call.respond(ApiResponse(success = true, data = content))
                                }
                            }

                            post("/tap") {
                                val request = call.receive<TapRequest>()
                                val a11y = HomesteadAccessibilityService.instance
                                if (a11y == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Accessibility service not running"))
                                } else {
                                    a11y.tap(request.x, request.y)
                                    call.respond(ApiResponse<String>(success = true, data = "Tapped at (${request.x}, ${request.y})"))
                                }
                            }

                            post("/swipe") {
                                val request = call.receive<SwipeRequest>()
                                val a11y = HomesteadAccessibilityService.instance
                                if (a11y == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Accessibility service not running"))
                                } else {
                                    a11y.swipe(request.startX, request.startY, request.endX, request.endY, request.durationMs ?: 300)
                                    call.respond(ApiResponse<String>(success = true, data = "Swiped from (${request.startX}, ${request.startY}) to (${request.endX}, ${request.endY})"))
                                }
                            }

                            post("/click") {
                                val request = call.receive<ClickRequest>()
                                val a11y = HomesteadAccessibilityService.instance
                                if (a11y == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Accessibility service not running"))
                                } else {
                                    val result = if (request.resourceId != null) {
                                        a11y.clickById(request.resourceId)
                                    } else if (request.text != null) {
                                        a11y.clickByText(request.text, request.exact ?: false)
                                    } else {
                                        false
                                    }
                                    if (result) {
                                        call.respond(ApiResponse<String>(success = true, data = "Clicked element"))
                                    } else {
                                        call.respond(HttpStatusCode.NotFound,
                                            ApiResponse<String>(success = false, error = "Element not found"))
                                    }
                                }
                            }

                            post("/back") {
                                val a11y = HomesteadAccessibilityService.instance
                                if (a11y == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Accessibility service not running"))
                                } else {
                                    val result = a11y.pressBack()
                                    call.respond(ApiResponse<String>(success = result, data = if (result) "Back pressed" else null))
                                }
                            }

                            post("/home") {
                                val a11y = HomesteadAccessibilityService.instance
                                if (a11y == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Accessibility service not running"))
                                } else {
                                    val result = a11y.pressHome()
                                    call.respond(ApiResponse<String>(success = result, data = if (result) "Home pressed" else null))
                                }
                            }

                            post("/input") {
                                val request = call.receive<InputTextRequest>()
                                val a11y = HomesteadAccessibilityService.instance
                                if (a11y == null) {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "Accessibility service not running"))
                                } else {
                                    val result = a11y.inputText(request.text)
                                    call.respond(ApiResponse<String>(success = result, data = if (result) "Text input" else null, error = if (!result) "No focused input field" else null))
                                }
                            }

                            get("/status") {
                                val running = HomesteadAccessibilityService.isRunning()
                                call.respond(ApiResponse(success = true, data = mapOf(
                                    "accessibilityServiceRunning" to running
                                )))
                            }
                        }

                        // Vault (biometric-gated password vault — key never leaves phone)
                        route("/vault") {
                            // Sync: receive doc content, encrypt + store on-device
                            post("/sync") {
                                try {
                                    val request = call.receive<VaultSyncRequest>()
                                    if (request.content.isBlank()) {
                                        call.respond(HttpStatusCode.BadRequest,
                                            ApiResponse<String>(success = false, error = "Content is empty"))
                                        return@post
                                    }

                                    val deferred = VaultKeyManager.requestSync(this@ApiServerService, request.content)
                                    val result = withTimeoutOrNull(60_000L) { deferred.await() }

                                    if (result != null) {
                                        call.respond(ApiResponse(success = true, data = mapOf("status" to "synced")))
                                    } else {
                                        call.respond(HttpStatusCode.Forbidden,
                                            ApiResponse<String>(success = false, error = "Biometric authentication denied or encryption failed"))
                                    }
                                } catch (e: Exception) {
                                    Log.e(TAG, "Vault sync error", e)
                                    call.respond(HttpStatusCode.InternalServerError,
                                        ApiResponse<String>(success = false, error = "Vault sync failed: ${e.message}"))
                                }
                            }

                            // Read: decrypt on-device, return full plaintext
                            post("/read") {
                                try {
                                    if (!VaultKeyManager.hasVault(this@ApiServerService)) {
                                        call.respond(HttpStatusCode.NotFound,
                                            ApiResponse<String>(success = false, error = "No vault on device. Run sync first."))
                                        return@post
                                    }

                                    val deferred = VaultKeyManager.requestRead(this@ApiServerService)
                                    val result = withTimeoutOrNull(60_000L) { deferred.await() }

                                    if (result != null) {
                                        call.respond(ApiResponse(success = true, data = mapOf("content" to result)))
                                    } else {
                                        call.respond(HttpStatusCode.Forbidden,
                                            ApiResponse<String>(success = false, error = "Biometric authentication denied or decryption failed"))
                                    }
                                } catch (e: Exception) {
                                    Log.e(TAG, "Vault read error", e)
                                    call.respond(HttpStatusCode.InternalServerError,
                                        ApiResponse<String>(success = false, error = "Vault read failed: ${e.message}"))
                                }
                            }

                            // Status: check if vault exists on device
                            get("/status") {
                                call.respond(ApiResponse(success = true, data = mapOf(
                                    "hasVault" to VaultKeyManager.hasVault(this@ApiServerService),
                                    "hasCredentials" to VaultKeyManager.hasSaKey(this@ApiServerService)
                                )))
                            }

                            // Store credentials: one-time setup to encrypt SA key on phone
                            post("/store-credentials") {
                                try {
                                    val request = call.receive<VaultStoreCredentialsRequest>()
                                    if (request.saKeyJson.isBlank()) {
                                        call.respond(HttpStatusCode.BadRequest,
                                            ApiResponse<String>(success = false, error = "SA key JSON is empty"))
                                        return@post
                                    }

                                    val deferred = VaultKeyManager.requestStoreSaKey(this@ApiServerService, request.saKeyJson)
                                    val result = withTimeoutOrNull(60_000L) { deferred.await() }

                                    if (result != null) {
                                        call.respond(ApiResponse(success = true, data = mapOf("status" to "credentials_stored")))
                                    } else {
                                        call.respond(HttpStatusCode.Forbidden,
                                            ApiResponse<String>(success = false, error = "Biometric auth denied or encryption failed"))
                                    }
                                } catch (e: Exception) {
                                    Log.e(TAG, "Store credentials error", e)
                                    call.respond(HttpStatusCode.InternalServerError,
                                        ApiResponse<String>(success = false, error = "Store credentials failed: ${e.message}"))
                                }
                            }

                            // Fetch: biometric → decrypt SA key → fetch Google Doc → return content
                            // The SA key and Google Doc are NEVER accessible without fingerprint
                            post("/fetch") {
                                try {
                                    if (!VaultKeyManager.hasSaKey(this@ApiServerService)) {
                                        call.respond(HttpStatusCode.NotFound,
                                            ApiResponse<String>(success = false, error = "No credentials on device. Call /vault/store-credentials first."))
                                        return@post
                                    }

                                    // Step 1: Biometric auth to decrypt the SA key
                                    val deferred = VaultKeyManager.requestReadSaKey(this@ApiServerService)
                                    val saKeyJson = withTimeoutOrNull(60_000L) { deferred.await() }

                                    if (saKeyJson == null) {
                                        call.respond(HttpStatusCode.Forbidden,
                                            ApiResponse<String>(success = false, error = "Biometric auth denied or decryption failed"))
                                        return@post
                                    }

                                    // Step 2: Use the SA key to fetch the Google Doc
                                    val content = fetchGoogleDoc(saKeyJson)

                                    if (content != null) {
                                        call.respond(ApiResponse(success = true, data = mapOf("content" to content)))
                                    } else {
                                        call.respond(HttpStatusCode.InternalServerError,
                                            ApiResponse<String>(success = false, error = "Failed to fetch password document from Google"))
                                    }
                                } catch (e: Exception) {
                                    Log.e(TAG, "Vault fetch error", e)
                                    call.respond(HttpStatusCode.InternalServerError,
                                        ApiResponse<String>(success = false, error = "Vault fetch failed: ${e.message}"))
                                }
                            }
                        }

                        // Recordings — expose RecordingHistoryManager state so the laptop
                        // can pull failed/unsent audio when the upload path is broken.
                        // Reads recording_history.json directly to avoid manager coupling.
                        get("/recordings") {
                            try {
                                val historyFile = java.io.File(applicationContext.filesDir, "recording_history.json")
                                val outArr = org.json.JSONArray()
                                if (historyFile.exists()) {
                                    val raw = org.json.JSONArray(historyFile.readText())
                                    for (i in 0 until raw.length()) {
                                        val rec = raw.getJSONObject(i)
                                        val recId = rec.optString("id")
                                        val recPath = rec.optString("filePath", "")
                                        val hasAudio = recPath.isNotEmpty() && java.io.File(recPath).exists()
                                        val audioSize = if (hasAudio) java.io.File(recPath).length() else 0L
                                        val entry = org.json.JSONObject()
                                        entry.put("id", recId)
                                        entry.put("timestamp", rec.optLong("timestamp"))
                                        entry.put("type", rec.optString("type", "AUDIO"))
                                        entry.put("sendStatus", rec.optString("sendStatus", "UNSENT"))
                                        entry.put("transcript", rec.opt("transcript") ?: org.json.JSONObject.NULL)
                                        entry.put("text", rec.opt("text") ?: org.json.JSONObject.NULL)
                                        entry.put("destination", rec.opt("destination") ?: org.json.JSONObject.NULL)
                                        entry.put("hasAudio", hasAudio)
                                        entry.put("audioBytes", audioSize)
                                        entry.put("audioUrl", if (hasAudio) "/recordings/$recId/audio" else org.json.JSONObject.NULL)
                                        outArr.put(entry)
                                    }
                                }
                                val payload = org.json.JSONObject()
                                payload.put("success", true)
                                payload.put("recordings", outArr)
                                payload.put("count", outArr.length())
                                call.respondText(payload.toString(), io.ktor.http.ContentType.Application.Json)
                            } catch (e: Exception) {
                                Log.e(TAG, "Recordings list error", e)
                                call.respond(HttpStatusCode.InternalServerError,
                                    ApiResponse<String>(success = false, error = "Recordings error: ${e.message}"))
                            }
                        }

                        get("/recordings/{id}/audio") {
                            try {
                                val id = call.parameters["id"]
                                if (id.isNullOrBlank()) {
                                    call.respond(HttpStatusCode.BadRequest,
                                        ApiResponse<String>(success = false, error = "id is required"))
                                    return@get
                                }
                                val historyFile = java.io.File(applicationContext.filesDir, "recording_history.json")
                                if (!historyFile.exists()) {
                                    call.respond(HttpStatusCode.NotFound,
                                        ApiResponse<String>(success = false, error = "No recording history"))
                                    return@get
                                }
                                val raw = org.json.JSONArray(historyFile.readText())
                                var filePath: String? = null
                                for (i in 0 until raw.length()) {
                                    val rec = raw.getJSONObject(i)
                                    if (rec.optString("id") == id) {
                                        filePath = rec.optString("filePath", "")
                                        break
                                    }
                                }
                                if (filePath.isNullOrEmpty()) {
                                    call.respond(HttpStatusCode.NotFound,
                                        ApiResponse<String>(success = false, error = "Recording $id not found or has no audio (text-only)"))
                                    return@get
                                }
                                val audioFile = java.io.File(filePath)
                                if (!audioFile.exists()) {
                                    call.respond(HttpStatusCode.NotFound,
                                        ApiResponse<String>(success = false, error = "Audio file missing on disk: $filePath"))
                                    return@get
                                }
                                call.response.header(
                                    HttpHeaders.ContentDisposition,
                                    ContentDisposition.Attachment.withParameter(
                                        ContentDisposition.Parameters.FileName, "rec_${id}.m4a"
                                    ).toString()
                                )
                                call.respondBytes(audioFile.readBytes(), ContentType("audio", "mp4"))
                            } catch (e: Exception) {
                                Log.e(TAG, "Recordings audio error", e)
                                call.respond(HttpStatusCode.InternalServerError,
                                    ApiResponse<String>(success = false, error = "Audio fetch error: ${e.message}"))
                            }
                        }

                        // Mark a recording as sent. Called by the laptop after it
                        // has pulled audio + transcribed it, so the phone-side
                        // history reflects "this one has been processed."
                        post("/recordings/{id}/send") {
                            try {
                                val id = call.parameters["id"]
                                if (id.isNullOrBlank()) {
                                    call.respond(HttpStatusCode.BadRequest,
                                        ApiResponse<String>(success = false, error = "id is required"))
                                    return@post
                                }

                                // Optional body: { "destination": "...", "transcript": "..." }
                                var destination = "laptop-pull"
                                var transcript: String? = null
                                try {
                                    val bodyText = call.receiveText()
                                    if (bodyText.isNotBlank()) {
                                        val body = org.json.JSONObject(bodyText)
                                        if (body.has("destination") && !body.isNull("destination")) {
                                            destination = body.getString("destination")
                                        }
                                        if (body.has("transcript") && !body.isNull("transcript")) {
                                            transcript = body.getString("transcript")
                                        }
                                    }
                                } catch (_: Exception) { /* body optional */ }

                                val historyFile = java.io.File(applicationContext.filesDir, "recording_history.json")
                                if (!historyFile.exists()) {
                                    call.respond(HttpStatusCode.NotFound,
                                        ApiResponse<String>(success = false, error = "No recording history"))
                                    return@post
                                }

                                val raw = org.json.JSONArray(historyFile.readText())
                                var matched = false
                                for (i in 0 until raw.length()) {
                                    val rec = raw.getJSONObject(i)
                                    if (rec.optString("id") == id) {
                                        rec.put("sendStatus", "SENT")
                                        rec.put("destination", destination)
                                        if (transcript != null) {
                                            rec.put("transcript", transcript)
                                        }
                                        matched = true
                                        break
                                    }
                                }
                                if (!matched) {
                                    call.respond(HttpStatusCode.NotFound,
                                        ApiResponse<String>(success = false, error = "Recording $id not found"))
                                    return@post
                                }
                                historyFile.writeText(raw.toString(2))
                                val payload = org.json.JSONObject()
                                payload.put("success", true)
                                payload.put("id", id)
                                payload.put("destination", destination)
                                call.respondText(payload.toString(), io.ktor.http.ContentType.Application.Json)
                            } catch (e: Exception) {
                                Log.e(TAG, "Recordings mark-sent error", e)
                                call.respond(HttpStatusCode.InternalServerError,
                                    ApiResponse<String>(success = false, error = "Mark-sent error: ${e.message}"))
                            }
                        }

                        // Location endpoint
                        get("/location") {
                            try {
                                val locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager

                                // Check permission
                                if (ContextCompat.checkSelfPermission(this@ApiServerService, android.Manifest.permission.ACCESS_FINE_LOCATION)
                                    != PackageManager.PERMISSION_GRANTED &&
                                    ContextCompat.checkSelfPermission(this@ApiServerService, android.Manifest.permission.ACCESS_COARSE_LOCATION)
                                    != PackageManager.PERMISSION_GRANTED) {
                                    call.respond(HttpStatusCode.Forbidden,
                                        ApiResponse<String>(success = false, error = "Location permission not granted. Open the app and grant location permission."))
                                    return@get
                                }

                                // Try to get the last known location from available providers
                                val providers = listOf(
                                    LocationManager.FUSED_PROVIDER,
                                    LocationManager.GPS_PROVIDER,
                                    LocationManager.NETWORK_PROVIDER
                                )

                                var bestLocation: android.location.Location? = null
                                for (provider in providers) {
                                    try {
                                        val loc = locationManager.getLastKnownLocation(provider)
                                        if (loc != null) {
                                            if (bestLocation == null || loc.accuracy < bestLocation.accuracy) {
                                                bestLocation = loc
                                            }
                                        }
                                    } catch (_: Exception) { }
                                }

                                // If no location or stale (>5 min), request a fresh one
                                if (bestLocation == null || (System.currentTimeMillis() - bestLocation.time) > 5 * 60 * 1000) {
                                    try {
                                        val freshLocation = withTimeoutOrNull(10_000L) {
                                            suspendCancellableCoroutine<android.location.Location?> { cont ->
                                                val listener = object : android.location.LocationListener {
                                                    override fun onLocationChanged(location: android.location.Location) {
                                                        cont.resume(location, null)
                                                        locationManager.removeUpdates(this)
                                                    }
                                                    override fun onProviderDisabled(provider: String) {}
                                                    override fun onProviderEnabled(provider: String) {}
                                                    @Deprecated("Deprecated in Java")
                                                    override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
                                                }
                                                try {
                                                    locationManager.requestSingleUpdate(
                                                        android.location.LocationManager.NETWORK_PROVIDER,
                                                        listener,
                                                        android.os.Looper.getMainLooper()
                                                    )
                                                } catch (e: Exception) {
                                                    cont.resume(null, null)
                                                }
                                                cont.invokeOnCancellation {
                                                    locationManager.removeUpdates(listener)
                                                }
                                            }
                                        }
                                        if (freshLocation != null) {
                                            bestLocation = freshLocation
                                        }
                                    } catch (_: Exception) {}
                                }

                                if (bestLocation != null) {
                                    val ageMs = System.currentTimeMillis() - bestLocation.time
                                    call.respondText(
                                        org.json.JSONObject().apply {
                                            put("success", true)
                                            put("data", org.json.JSONObject().apply {
                                                put("latitude", bestLocation.latitude)
                                                put("longitude", bestLocation.longitude)
                                                put("accuracy", bestLocation.accuracy.toDouble())
                                                put("provider", bestLocation.provider ?: "unknown")
                                                put("timestamp", bestLocation.time)
                                                put("age_seconds", ageMs / 1000)
                                            })
                                        }.toString(),
                                        io.ktor.http.ContentType.Application.Json
                                    )
                                } else {
                                    call.respond(HttpStatusCode.ServiceUnavailable,
                                        ApiResponse<String>(success = false, error = "No location available. Ensure GPS is enabled and the device has a recent location fix."))
                                }
                            } catch (e: Exception) {
                                Log.e(TAG, "Location error", e)
                                call.respond(HttpStatusCode.InternalServerError,
                                    ApiResponse<String>(success = false, error = "Location error: ${e.message}"))
                            }
                        }
                    }
                }.start(wait = false)

                Log.d(TAG, "Server started on port ${HomesteadApp.SERVER_PORT}")
                isRunning = true
                sendBroadcast(Intent(ACTION_SERVER_STARTED))
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start server", e)
                isRunning = false
                sendBroadcast(Intent(ACTION_SERVER_STOPPED))
            }
        }
    }

    // Google Docs fetch (using SA key from biometric vault)
    private val DOC_ID = "1mcE_7IGG1s2GOpA_cCW4QETcnuY1HPjk1qipAnpecFQ"

    private suspend fun fetchGoogleDoc(saKeyJson: String): String? = withContext(Dispatchers.IO) {
        try {
            val saKey = JSONObject(saKeyJson)
            val clientEmail = saKey.getString("client_email")
            val privateKeyPem = saKey.getString("private_key")
            val tokenUri = saKey.optString("token_uri", "https://oauth2.googleapis.com/token")

            // Step 1: Create JWT for Google OAuth2
            val now = System.currentTimeMillis() / 1000
            val header = android.util.Base64.encodeToString(
                """{"alg":"RS256","typ":"JWT"}""".toByteArray(), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
            )
            val claim = android.util.Base64.encodeToString(
                JSONObject().apply {
                    put("iss", clientEmail)
                    put("scope", "https://www.googleapis.com/auth/documents.readonly")
                    put("aud", tokenUri)
                    put("iat", now)
                    put("exp", now + 3600)
                }.toString().toByteArray(), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
            )

            val signInput = "$header.$claim"

            // Parse PEM private key
            val keyPem = privateKeyPem
                .replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replace("\\n", "")
                .replace("\n", "")
                .trim()
            val keyBytes = android.util.Base64.decode(keyPem, android.util.Base64.DEFAULT)
            val keySpec = java.security.spec.PKCS8EncodedKeySpec(keyBytes)
            val privateKey = java.security.KeyFactory.getInstance("RSA").generatePrivate(keySpec)

            // Sign the JWT
            val signature = java.security.Signature.getInstance("SHA256withRSA").run {
                initSign(privateKey)
                update(signInput.toByteArray())
                sign()
            }
            val signatureB64 = android.util.Base64.encodeToString(
                signature, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
            )
            val jwt = "$signInput.$signatureB64"

            // Step 2: Exchange JWT for access token
            val tokenBody = okhttp3.FormBody.Builder()
                .add("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
                .add("assertion", jwt)
                .build()

            val tokenRequest = Request.Builder()
                .url(tokenUri)
                .post(tokenBody)
                .build()

            val httpClient = OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build()

            val tokenResponse = httpClient.newCall(tokenRequest).execute()
            if (!tokenResponse.isSuccessful) {
                Log.e(TAG, "Token exchange failed: ${tokenResponse.code}")
                return@withContext null
            }

            val tokenJson = JSONObject(tokenResponse.body?.string() ?: "")
            val accessToken = tokenJson.getString("access_token")

            // Step 3: Fetch the Google Doc
            val docRequest = Request.Builder()
                .url("https://docs.googleapis.com/v1/documents/$DOC_ID")
                .addHeader("Authorization", "Bearer $accessToken")
                .build()

            val docResponse = httpClient.newCall(docRequest).execute()
            if (!docResponse.isSuccessful) {
                Log.e(TAG, "Google Doc fetch failed: ${docResponse.code}")
                return@withContext null
            }

            val docJson = JSONObject(docResponse.body?.string() ?: "")

            // Step 4: Parse document content (paragraphs + tables)
            val body = docJson.optJSONObject("body") ?: return@withContext ""
            val content = body.optJSONArray("content") ?: return@withContext ""

            val text = StringBuilder()
            for (i in 0 until content.length()) {
                val element = content.getJSONObject(i)

                if (element.has("paragraph")) {
                    val paragraph = element.getJSONObject("paragraph")
                    val elements = paragraph.optJSONArray("elements") ?: continue
                    for (j in 0 until elements.length()) {
                        val elem = elements.getJSONObject(j)
                        val textRun = elem.optJSONObject("textRun")
                        if (textRun != null) {
                            text.append(textRun.getString("content"))
                        }
                    }
                }

                if (element.has("table")) {
                    val table = element.getJSONObject("table")
                    val rows = table.optJSONArray("tableRows") ?: continue
                    for (r in 0 until rows.length()) {
                        val row = rows.getJSONObject(r)
                        val cells = row.optJSONArray("tableCells") ?: continue
                        for (c in 0 until cells.length()) {
                            val cell = cells.getJSONObject(c)
                            val cellContent = cell.optJSONArray("content") ?: continue
                            for (cc in 0 until cellContent.length()) {
                                val cellElement = cellContent.getJSONObject(cc)
                                if (cellElement.has("paragraph")) {
                                    val para = cellElement.getJSONObject("paragraph")
                                    val elems = para.optJSONArray("elements") ?: continue
                                    for (e in 0 until elems.length()) {
                                        val elem = elems.getJSONObject(e)
                                        val textRun = elem.optJSONObject("textRun")
                                        if (textRun != null) {
                                            text.append(textRun.getString("content"))
                                            text.append("\t")
                                        }
                                    }
                                }
                            }
                        }
                        text.append("\n")
                    }
                }
            }

            Log.d(TAG, "Fetched Google Doc: ${text.length} chars")
            text.toString()
        } catch (e: Exception) {
            Log.e(TAG, "fetchGoogleDoc failed", e)
            null
        }
    }

    // SMS Functions
    private fun readSmsInbox(limit: Int): List<SmsMessage> {
        val messages = mutableListOf<SmsMessage>()
        try {
            val cursor: Cursor? = contentResolver.query(
                Telephony.Sms.Inbox.CONTENT_URI,
                arrayOf(
                    Telephony.Sms._ID,
                    Telephony.Sms.ADDRESS,
                    Telephony.Sms.BODY,
                    Telephony.Sms.DATE,
                    Telephony.Sms.READ
                ),
                null, null,
                "${Telephony.Sms.DATE} DESC"
            )

            cursor?.use {
                var count = 0
                while (it.moveToNext() && count < limit) {
                    messages.add(SmsMessage(
                        id = it.getLong(0).toString(),
                        address = it.getString(1) ?: "",
                        body = it.getString(2) ?: "",
                        date = it.getLong(3),
                        read = it.getInt(4) == 1
                    ))
                    count++
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error reading SMS inbox", e)
        }
        return messages
    }

    private fun readSmsSent(limit: Int): List<SmsMessage> {
        val messages = mutableListOf<SmsMessage>()
        try {
            val cursor: Cursor? = contentResolver.query(
                Telephony.Sms.Sent.CONTENT_URI,
                arrayOf(
                    Telephony.Sms._ID,
                    Telephony.Sms.ADDRESS,
                    Telephony.Sms.BODY,
                    Telephony.Sms.DATE
                ),
                null, null,
                "${Telephony.Sms.DATE} DESC"
            )

            cursor?.use {
                var count = 0
                while (it.moveToNext() && count < limit) {
                    messages.add(SmsMessage(
                        id = it.getLong(0).toString(),
                        address = it.getString(1) ?: "",
                        body = it.getString(2) ?: "",
                        date = it.getLong(3),
                        read = true
                    ))
                    count++
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error reading sent SMS", e)
        }
        return messages
    }

    private fun sendSms(to: String, message: String): Boolean {
        return try {
            val smsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }

            // Split long messages
            val parts = smsManager.divideMessage(message)
            if (parts.size > 1) {
                smsManager.sendMultipartTextMessage(to, null, parts, null, null)
            } else {
                smsManager.sendTextMessage(to, null, message, null, null)
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error sending SMS", e)
            false
        }
    }

    private fun createSmsDraft(to: String, message: String): Long {
        val values = android.content.ContentValues().apply {
            put("address", to)
            put("body", message)
            put("date", System.currentTimeMillis())
            put("read", 1)
            put("type", 3) // MESSAGE_TYPE_DRAFT
        }
        val uri = contentResolver.insert(android.net.Uri.parse("content://sms/draft"), values)
        return uri?.lastPathSegment?.toLongOrNull() ?: -1
    }

    private fun buildSmsUri(to: String, message: String): String {
        val encoded = java.net.URLEncoder.encode(message, "UTF-8")
        return "sms:$to?body=$encoded"
    }

    // Contacts Functions

    // Read the standard "Notes" field for a contact by its aggregated CONTACT_ID.
    // The Note row lives in the Data table (on the raw contact) but each Data row
    // carries a denormalized CONTACT_ID column, so we can look it up by CONTACT_ID.
    // This keeps read + write consistent: both key on CONTACT_ID (what get_contacts exposes).
    private fun readNoteForContact(contactId: String): String? {
        if (contactId.isBlank()) return null
        return try {
            val cursor: Cursor? = contentResolver.query(
                ContactsContract.Data.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.Note.NOTE),
                "${ContactsContract.Data.CONTACT_ID} = ? AND ${ContactsContract.Data.MIMETYPE} = ?",
                arrayOf(contactId, ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE),
                null
            )
            cursor?.use {
                if (it.moveToFirst()) {
                    val note = it.getString(0)
                    if (note.isNullOrBlank()) null else note
                } else null
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error reading note for contact $contactId", e)
            null
        }
    }

    // Digits-only, last-10 normalization so mixed formats compare equal
    // ("+1 574-...", "574-...", "(888) ..." all reduce to the same key).
    private fun normalizePhone(raw: String?): String {
        if (raw == null) return ""
        val digits = raw.filter { it.isDigit() }
        return if (digits.length > 10) digits.takeLast(10) else digits
    }

    private fun readContacts(limit: Int): List<Contact> {
        val contacts = mutableListOf<Contact>()
        try {
            val cursor: Cursor? = contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                ),
                null, null,
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
            )

            cursor?.use {
                var count = 0
                while (it.moveToNext() && count < limit) {
                    val id = it.getString(0) ?: ""
                    contacts.add(Contact(
                        id = id,
                        name = it.getString(1) ?: "",
                        phone = it.getString(2) ?: "",
                        notes = readNoteForContact(id)
                    ))
                    count++
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error reading contacts", e)
        }
        return contacts
    }

    private fun addContact(name: String, phone: String, email: String?): Contact? {
        return try {
            val ops = ArrayList<android.content.ContentProviderOperation>()

            // Insert raw contact
            ops.add(android.content.ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null)
                .build())

            // Display name
            ops.add(android.content.ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name)
                .build())

            // Phone number
            ops.add(android.content.ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, phone)
                .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                .build())

            // Email (optional)
            if (!email.isNullOrBlank()) {
                ops.add(android.content.ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Email.DATA, email)
                    .withValue(ContactsContract.CommonDataKinds.Email.TYPE, ContactsContract.CommonDataKinds.Email.TYPE_HOME)
                    .build())
            }

            val results = contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
            val rawContactUri = results[0].uri
            val rawContactId = rawContactUri?.lastPathSegment ?: ""

            lastContactWriteError = null
            Contact(id = rawContactId, name = name, phone = phone)
        } catch (e: Exception) {
            Log.e(TAG, "Error adding contact", e)
            lastContactWriteError = "${e.javaClass.simpleName}: ${e.message}"
            null
        }
    }

    // Set/update the standard "Notes" field on an EXISTING contact, keyed by the
    // aggregated CONTACT_ID (the same id get_contacts / search return). The Note row
    // lives on a RAW contact, so we resolve CONTACT_ID → its first RAW_CONTACT_ID and
    // update the existing Note row (or insert one if none exists yet). Only the Note
    // row is touched — name/phone/email are never modified.
    private fun setContactNotes(contactId: String, notes: String): Boolean {
        if (contactId.isBlank()) return false
        return try {
            // Resolve the aggregated contact to a concrete raw contact.
            val rawContactId: String? = contentResolver.query(
                ContactsContract.RawContacts.CONTENT_URI,
                arrayOf(ContactsContract.RawContacts._ID),
                "${ContactsContract.RawContacts.CONTACT_ID} = ?",
                arrayOf(contactId),
                null
            )?.use { if (it.moveToFirst()) it.getString(0) else null }

            if (rawContactId == null) {
                Log.e(TAG, "setContactNotes: no raw contact for CONTACT_ID $contactId")
                return false
            }

            // Does a Note row already exist on this raw contact?
            val existingDataId: String? = contentResolver.query(
                ContactsContract.Data.CONTENT_URI,
                arrayOf(ContactsContract.Data._ID),
                "${ContactsContract.Data.RAW_CONTACT_ID} = ? AND ${ContactsContract.Data.MIMETYPE} = ?",
                arrayOf(rawContactId, ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE),
                null
            )?.use { if (it.moveToFirst()) it.getString(0) else null }

            val ops = ArrayList<android.content.ContentProviderOperation>()
            if (existingDataId != null) {
                ops.add(android.content.ContentProviderOperation.newUpdate(ContactsContract.Data.CONTENT_URI)
                    .withSelection("${ContactsContract.Data._ID} = ?", arrayOf(existingDataId))
                    .withValue(ContactsContract.CommonDataKinds.Note.NOTE, notes)
                    .build())
            } else {
                ops.add(android.content.ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValue(ContactsContract.Data.RAW_CONTACT_ID, rawContactId)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Note.NOTE, notes)
                    .build())
            }

            contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
            lastContactWriteError = null
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error setting contact notes for $contactId", e)
            lastContactWriteError = "${e.javaClass.simpleName}: ${e.message}"
            false
        }
    }

    private fun sendGroupSms(recipients: List<String>, message: String): List<GroupSmsResult> {
        return recipients.map { to ->
            try {
                val success = sendSms(to, message)
                GroupSmsResult(recipient = to, success = success, error = if (!success) "Failed to send" else null)
            } catch (e: Exception) {
                GroupSmsResult(recipient = to, success = false, error = e.message)
            }
        }
    }

    // Matches by DISPLAY_NAME (substring) OR by phone number. Number matching
    // normalizes both the query and every stored number to last-10-digits so
    // mixed formats compare equal (reverse-lookup: bare SMS-sender number → contact).
    private fun searchContacts(query: String): List<Contact> {
        if (query.isBlank()) return emptyList()

        // Dedup by CONTACT_ID; a phone-format query would never LIKE-match a name,
        // and a name query would never number-match, so a single scan covers both.
        val byId = LinkedHashMap<String, Contact>()
        val queryNorm = normalizePhone(query)
        val hasDigits = queryNorm.isNotEmpty()
        try {
            val cursor: Cursor? = contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                ),
                // Name substring pulled provider-side; number match done in-memory
                // (post-normalization) since the DB stores raw formatting.
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?",
                arrayOf("%$query%"),
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
            )
            cursor?.use {
                while (it.moveToNext()) {
                    val id = it.getString(0) ?: ""
                    if (id.isBlank() || byId.containsKey(id)) continue
                    byId[id] = Contact(
                        id = id,
                        name = it.getString(1) ?: "",
                        phone = it.getString(2) ?: "",
                        notes = readNoteForContact(id)
                    )
                }
            }

            // Second pass: number matching. Scan all numbers, keep ones whose
            // normalized form equals the normalized query.
            if (hasDigits) {
                val numCursor: Cursor? = contentResolver.query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    arrayOf(
                        ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                        ContactsContract.CommonDataKinds.Phone.NUMBER
                    ),
                    null, null,
                    "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
                )
                numCursor?.use {
                    while (it.moveToNext()) {
                        val number = it.getString(2) ?: ""
                        if (normalizePhone(number) != queryNorm) continue
                        val id = it.getString(0) ?: ""
                        if (id.isBlank() || byId.containsKey(id)) continue
                        byId[id] = Contact(
                            id = id,
                            name = it.getString(1) ?: "",
                            phone = number,
                            notes = readNoteForContact(id)
                        )
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error searching contacts", e)
        }
        return byId.values.toList()
    }

    private fun getLocalIpAddress(): String? {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val networkInterface = interfaces.nextElement()
                val addresses = networkInterface.inetAddresses
                while (addresses.hasMoreElements()) {
                    val address = addresses.nextElement()
                    if (!address.isLoopbackAddress && address is Inet4Address) {
                        return address.hostAddress
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error getting IP address", e)
        }
        return null
    }

    // App Launch Functions
    private data class LaunchResult(val success: Boolean, val message: String)

    private fun launchApp(request: AppLaunchRequest): LaunchResult {
        return try {
            val intent: Intent = when {
                // Deep link / URI
                request.uri != null -> {
                    Intent(Intent.ACTION_VIEW, Uri.parse(request.uri)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                }
                // Package name with optional activity
                request.packageName != null -> {
                    if (request.activityName != null) {
                        Intent().apply {
                            component = ComponentName(request.packageName, request.activityName)
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                    } else {
                        packageManager.getLaunchIntentForPackage(request.packageName)?.apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        } ?: return LaunchResult(false, "Package not found: ${request.packageName}")
                    }
                }
                else -> return LaunchResult(false, "Must provide either 'uri' or 'packageName'")
            }

            // Add extras if provided (all as strings since JSON doesn't preserve types)
            request.extras?.forEach { (key, value) ->
                intent.putExtra(key, value)
            }

            startActivity(intent)
            LaunchResult(true, "App launched successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Error launching app", e)
            LaunchResult(false, "Error: ${e.message}")
        }
    }

    private fun getInstalledApps(): List<AppInfo> {
        val apps = mutableListOf<AppInfo>()
        try {
            val intent = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PackageManager.MATCH_ALL
            } else {
                0
            }
            val resolveInfoList = packageManager.queryIntentActivities(intent, flags)

            Log.d(TAG, "Found ${resolveInfoList.size} launcher apps")
            resolveInfoList.forEach { resolveInfo ->
                apps.add(AppInfo(
                    packageName = resolveInfo.activityInfo.packageName,
                    appName = resolveInfo.loadLabel(packageManager).toString(),
                    activityName = resolveInfo.activityInfo.name
                ))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error listing apps", e)
        }
        return apps.sortedBy { it.appName.lowercase() }
    }

    // Timer engine helpers
    private fun startTimerOnMain(timer: ActiveTimer) {
        mainHandler.post {
            val cdt = object : CountDownTimer(timer.remainingMs, 1000) {
                override fun onTick(millisUntilFinished: Long) {
                    // CountDownTimer handles the countdown; UI polls via /timer/list
                }

                override fun onFinish() {
                    onTimerFinished(timer)
                }
            }
            timer.countDownTimer = cdt
            cdt.start()
            Log.d(TAG, "Timer ${timer.id} started: ${timer.durationSeconds}s")
        }
    }

    private fun onTimerFinished(timer: ActiveTimer) {
        Log.d(TAG, "Timer ${timer.id} finished")
        activeTimers.remove(timer.id)

        // Fire through AlarmReceiver — real alarm sound, vibration, dismissable notification
        val intent = Intent(this, AlarmReceiver::class.java).apply {
            action = AlarmReceiver.ACTION_TIMER_FIRE
            putExtra("alarm_id", timer.id)
            putExtra("alarm_label", "${timer.durationSeconds}s timer done")
        }
        sendBroadcast(intent)
    }

    // Screen Functions
    private fun wakeScreen(): Boolean {
        return try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            val wakeLock = powerManager.newWakeLock(
                android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "homestead:wake"
            )
            wakeLock.acquire(3000L)
            wakeLock.release()
            true
        } catch (e: Exception) {
            Log.e(TAG, "Error waking screen", e)
            false
        }
    }

    private fun getScreenBrightness(): Int {
        return try {
            Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS)
        } catch (e: Exception) {
            Log.e(TAG, "Error getting brightness", e)
            -1
        }
    }
}

// Data classes
@Serializable
data class ApiResponse<T>(
    val success: Boolean,
    val data: T? = null,
    val error: String? = null
)

@Serializable
data class SmsMessage(
    val id: String,
    val address: String,
    val body: String,
    val date: Long,
    val read: Boolean = false
)

@Serializable
data class Contact(
    val id: String,
    val name: String,
    val phone: String,
    val notes: String? = null
)

@Serializable
data class SetContactNotesRequest(
    val id: String,
    val notes: String
)

@Serializable
data class SendSmsRequest(
    val to: String,
    val message: String
)

@Serializable
data class AddContactRequest(
    val name: String,
    val phone: String,
    val email: String? = null
)

@Serializable
data class SendGroupSmsRequest(
    val to: List<String>,
    val message: String
)

@Serializable
data class SmsDraftResult(
    val draftIds: List<Long>,
    val uris: List<String>
)

@Serializable
data class GroupSmsResult(
    val recipient: String,
    val success: Boolean,
    val error: String? = null
)

@Serializable
data class AppLaunchRequest(
    val packageName: String? = null,
    val activityName: String? = null,
    val uri: String? = null,
    val extras: Map<String, String>? = null
)

@Serializable
data class AppInfo(
    val packageName: String,
    val appName: String,
    val activityName: String
)

@Serializable
data class SetAlarmRequest(
    val hour: Int,
    val minute: Int,
    val label: String? = null
)

@Serializable
data class DeleteAlarmRequest(
    val id: String
)

@Serializable
data class StartTimerRequest(
    val durationSeconds: Int? = null,
    val presetId: String? = null
)

@Serializable
data class StopTimerRequest(
    val id: String
)

@Serializable
data class UpdatePresetRequest(
    val id: String,
    val seconds: Int
)

@Serializable
data class TapRequest(
    val x: Float,
    val y: Float
)

@Serializable
data class SwipeRequest(
    val startX: Float,
    val startY: Float,
    val endX: Float,
    val endY: Float,
    val durationMs: Long? = 300
)

@Serializable
data class ClickRequest(
    val text: String? = null,
    val resourceId: String? = null,
    val exact: Boolean? = false
)

@Serializable
data class InputTextRequest(
    val text: String
)

@Serializable
data class DismissNotificationRequest(
    val key: String
)

@Serializable
data class NotificationActionRequest(
    val key: String,
    val actionIndex: Int
)

@Serializable
data class OpenNotificationRequest(
    val key: String
)

@Serializable
data class VaultSyncRequest(
    val content: String
)

@Serializable
data class VaultStoreCredentialsRequest(
    val saKeyJson: String
)

