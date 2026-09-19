package com.homestead.mobile

import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * Plain TCP client for the Mac PhoneMouse companion (port 47921).
 *
 * Ported from the standalone phone-mouse app. Lives inside Homestead's mobile
 * APK so the trackpad panel in the presenter WebView can drive the Mac cursor
 * without a separate app launch.
 *
 * Wire protocol: newline-delimited JSON. Mac listens, phone connects.
 * Keepalive: app-level ping every 5s, expects pong; if no reply in 10s the
 * socket is torn down so the connect-loop reconnects. This is the only way
 * to detect dead Wi-Fi or a Mac app restart fast enough — OS TCP keepalive
 * defaults to ~hours.
 */
class TrackpadClient {

    enum class Status { Disconnected, Connecting, Connected, Error }

    private val socketRef = AtomicReference<Socket?>(null)
    private val outRef = AtomicReference<OutputStream?>(null)
    private val sendExec = Executors.newSingleThreadExecutor { r ->
        Thread(r, "trackpad-send").apply { isDaemon = true }
    }
    private val keepaliveExec: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "trackpad-keepalive").apply { isDaemon = true }
        }
    private val lastPongAt = AtomicLong(0L)

    @Volatile private var host: String = ""
    @Volatile private var port: Int = 0
    @Volatile private var shouldRun = false
    @Volatile var status: Status = Status.Disconnected
        private set
    @Volatile var lastError: String? = null
        private set

    fun secondsSinceLastPong(): Long {
        val last = lastPongAt.get()
        if (last == 0L) return -1L
        return (SystemClock.elapsedRealtime() - last) / 1000L
    }

    /** Listener for status changes. Called on the keepalive/connect threads,
     *  caller is responsible for marshaling to UI thread. */
    var statusListener: ((Status, String?) -> Unit)? = null

    fun connect(host: String, port: Int = 47921) {
        this.host = host
        this.port = port
        shouldRun = true
        thread(name = "trackpad-net", isDaemon = true) {
            connectLoop()
        }
        startKeepaliveOnce()
    }

    fun reconnectIfNeeded() {
        if (!shouldRun) return
        if (status == Status.Connected && (SystemClock.elapsedRealtime() - lastPongAt.get()) < PONG_TIMEOUT_MS) {
            return
        }
        try { socketRef.getAndSet(null)?.close() } catch (_: Exception) {}
        outRef.set(null)
    }

    fun disconnect() {
        shouldRun = false
        try { socketRef.getAndSet(null)?.close() } catch (_: Exception) {}
        outRef.set(null)
        setStatus(Status.Disconnected, null)
    }

    fun sendMove(dx: Float, dy: Float) {
        send(JSONObject().apply {
            put("type", "move"); put("dx", dx); put("dy", dy)
        })
    }
    fun sendClick() = send(JSONObject().apply { put("type", "click") })
    fun sendDoubleClick() = send(JSONObject().apply { put("type", "doubleClick") })
    fun sendScroll(dx: Float, dy: Float) {
        send(JSONObject().apply {
            put("type", "scroll"); put("dx", dx); put("dy", dy)
        })
    }
    fun sendKey(name: String) {
        send(JSONObject().apply { put("type", "key"); put("key", name) })
    }

    /** Quick-key: one Backspace (Delete) at the Mac's focused input.
     *  2026-08-12 Joshua ask — a dedicated trackpad button so he doesn't
     *  fumble backspacing an input via the cursor. Mac maps to kVK_Delete. */
    fun sendKeyBackspace() = sendKey("backspace")

    /** Quick-key: Select-All (⌘A) at the Mac's focused input.
     *  2026-08-12 Joshua ask. Mac posts kVK_ANSI_A + Command. */
    fun sendKeySelectAll() = sendKey("selectAll")

    /** Nudge the Mac's system output volume up/down or toggle mute.
     *  2026-07-18 Joshua ask: control laptop volume from the phone trackpad
     *  panel. Mac side steps the 0-100 output volume and shows the HUD. */
    fun sendVolumeUp() = send(JSONObject().apply { put("type", "volumeUp") })
    fun sendVolumeDown() = send(JSONObject().apply { put("type", "volumeDown") })
    fun sendMute() = send(JSONObject().apply { put("type", "mute") })

    /** Grandpa Mode — one-tap full-screen zoom on the Mac so Josh can read
     *  the laptop from across the room. 2026-08-12 ask. `level` (1..5) maps
     *  to how far in: level 1 ≈ 150% up to level 5 ≈ 400%. Mac side toggles
     *  macOS Accessibility full-screen Zoom on and steps in `level` times. */
    fun sendZoomOn(level: Int) {
        send(JSONObject().apply { put("type", "zoom"); put("level", level) })
    }
    /** Toggle Grandpa Mode off — Mac screen returns to 100%. */
    fun sendZoomOff() = send(JSONObject().apply { put("type", "zoomOff") })

    /** Inject text into whatever input has focus on the Mac. Mac side writes
     *  to NSPasteboard then posts Cmd+V, so this works in any app. */
    fun sendPaste(text: String) {
        send(JSONObject().apply { put("type", "paste"); put("text", text) })
    }

    /** Stream-type a chunk of text at the Mac focused input. Used by the
     *  live-keyboard mode — the phone has the system Android keyboard up
     *  and forwards each typed char (or word, post-IME) to the Mac. */
    fun sendTypeText(text: String) {
        if (text.isEmpty()) return
        send(JSONObject().apply { put("type", "typeText"); put("text", text) })
    }

    /** Send N backspaces. Used when the phone user erases chars in the
     *  live-keyboard EditText. */
    fun sendBackspace(count: Int) {
        if (count <= 0) return
        send(JSONObject().apply { put("type", "backspace"); put("count", count) })
    }

    /** Poll the Mac's Whisper Village /status endpoint every `intervalMs`
     *  ms and call `onChange` with the recording boolean whenever it
     *  flips. Returns a Closeable; call `close()` to stop the poller.
     *
     *  Joshua's 2026-04-28 ask: "if I would start a recording on my laptop,
     *  I would expect that the APK would also adjust." Local toggle-based
     *  state was wrong — Mac's Whisper Village is the source of truth.
     *
     *  Polls on the keepalive executor (already a single-threaded
     *  scheduler we own). Errors are silent — if the Mac is unreachable
     *  we just keep reporting false. */
    fun pollRecordingStatus(intervalMs: Long, onChange: (Boolean) -> Unit): java.io.Closeable {
        val handle = keepaliveExec.scheduleAtFixedRate({
            if (host.isBlank()) return@scheduleAtFixedRate
            try {
                val url = java.net.URL("http://$host:8179/status")
                val conn = (url.openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 1200
                    readTimeout = 1200
                }
                val code = conn.responseCode
                if (code == 200) {
                    val body = conn.inputStream.bufferedReader().use { it.readText() }
                    val rec = JSONObject(body).optBoolean("recording", false)
                    val prev = lastReportedRecording
                    if (prev == null || prev != rec) {
                        lastReportedRecording = rec
                        try { onChange(rec) } catch (_: Exception) {}
                    }
                } else {
                    if (lastReportedRecording != false) {
                        lastReportedRecording = false
                        try { onChange(false) } catch (_: Exception) {}
                    }
                }
                conn.disconnect()
            } catch (e: Exception) {
                if (lastReportedRecording != false) {
                    lastReportedRecording = false
                    try { onChange(false) } catch (_: Exception) {}
                }
            }
        }, 0L, intervalMs, TimeUnit.MILLISECONDS)
        return java.io.Closeable {
            handle.cancel(false)
            lastReportedRecording = null
        }
    }
    @Volatile private var lastReportedRecording: Boolean? = null

    /** Send a Whisper Village claim through the existing TCP socket so the
     *  Mac can broker the local POST. Originally the phone did this HTTP
     *  POST directly to *:8179 over LAN, but Joshua hit a race: a slow
     *  Wi-Fi roundtrip arriving AFTER Whisper Village finished routed
     *  the transcript to the cursor instead of the requested card.
     *  Brokering through the same TCP that drives the cursor keeps
     *  things ordered AND keeps the Whisper Village hop in-process on
     *  the Mac (sub-millisecond). */
    fun sendClaimCard(targetId: String) {
        if (targetId.isBlank()) return
        send(JSONObject().apply { put("type", "claimCard"); put("id", targetId) })
    }

    /** Tell the Mac to read the desktop Electron presenter's currently-
     *  focused card from the Homestead server and claim that. Joshua's
     *  2026-04-28: phone is a remote control for desktop, not its own
     *  presenter — phone tap "→ Card" should target whatever desktop
     *  has up. */
    fun sendClaimCardCurrent() {
        send(JSONObject().apply { put("type", "claimCardCurrent") })
    }

    /** Same idea — claim the desktop's currently-selected steward's
     *  walkie. */
    fun sendClaimStewardCurrent() {
        send(JSONObject().apply { put("type", "claimStewardCurrent") })
    }

    private fun send(obj: JSONObject) {
        val line = (obj.toString() + "\n").toByteArray(Charsets.UTF_8)
        sendExec.execute {
            val out = outRef.get()
            if (out == null) {
                if (status == Status.Connected) {
                    setStatus(Status.Disconnected, "send while not connected")
                }
                return@execute
            }
            try {
                out.write(line); out.flush()
            } catch (e: Exception) {
                try { socketRef.getAndSet(null)?.close() } catch (_: Exception) {}
                outRef.set(null)
                setStatus(Status.Error, e.message)
            }
        }
    }

    @Volatile private var keepaliveStarted = false
    private fun startKeepaliveOnce() {
        if (keepaliveStarted) return
        keepaliveStarted = true
        var tick = 0L
        keepaliveExec.scheduleAtFixedRate({
            if (!shouldRun) return@scheduleAtFixedRate
            tick++
            if (tick % 5L == 0L) {
                val out = outRef.get()
                if (out != null) {
                    send(JSONObject().apply { put("type", "ping") })
                    val last = lastPongAt.get()
                    if (last > 0 && (SystemClock.elapsedRealtime() - last) > PONG_TIMEOUT_MS) {
                        try { socketRef.getAndSet(null)?.close() } catch (_: Exception) {}
                        outRef.set(null)
                        setStatus(Status.Error, "no pong in ${PONG_TIMEOUT_MS}ms")
                    }
                }
            }
        }, 1_000L, 1_000L, TimeUnit.MILLISECONDS)
    }

    private fun connectLoop() {
        while (shouldRun) {
            try {
                Log.i("TrackpadClient", "connect attempt → $host:$port")
                setStatus(Status.Connecting, null)
                val s = Socket()
                s.tcpNoDelay = true
                s.connect(InetSocketAddress(host, port), 4000)
                Log.i("TrackpadClient", "TCP connected → $host:$port")
                socketRef.set(s)
                outRef.set(s.getOutputStream())
                lastPongAt.set(SystemClock.elapsedRealtime())
                setStatus(Status.Connected, null)
                val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
                while (shouldRun) {
                    val line = reader.readLine() ?: break
                    if (line.isNotEmpty()) {
                        lastPongAt.set(SystemClock.elapsedRealtime())
                    }
                }
            } catch (e: Exception) {
                Log.w("TrackpadClient", "connect/read failed: ${e.message}")
                setStatus(Status.Error, e.message)
            }
            try { socketRef.getAndSet(null)?.close() } catch (_: Exception) {}
            outRef.set(null)
            if (!shouldRun) break
            setStatus(Status.Disconnected, null)
            try { Thread.sleep(1500) } catch (_: InterruptedException) {}
        }
    }

    private fun setStatus(s: Status, err: String?) {
        status = s
        lastError = err
        statusListener?.invoke(s, err)
    }

    companion object {
        private const val PONG_TIMEOUT_MS = 10_000L
    }
}
