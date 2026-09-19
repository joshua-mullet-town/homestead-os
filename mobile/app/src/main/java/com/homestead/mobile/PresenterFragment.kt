package com.homestead.mobile

import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import java.net.HttpURLConnection
import java.net.URL
import java.net.UnknownHostException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class PresenterFragment : WebViewFragment() {

    companion object {
        private const val HOMESTEAD_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net"
        private const val WATCHDOG_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net:8443"
        private const val REFRESH_CHECK_INTERVAL = 30_000L // 30s
        // Require N consecutive failed polls before treating the connection as down. With a 30s
        // poll, this is ~90s of sustained failure before we even consider firing the reconnect
        // ladder. Mobile cell handoffs / momentary WiFi blips lose 1 poll, not 3.
        private const val FAILURE_THRESHOLD = 3
        private const val FAILED_PHASE_PING_INTERVAL = 30_000L // Native keep-checking ping when FAILED hides WebView
        private const val WALKIE_THROTTLE_MS = 60_000L // Max 1 routine walkie/min; FAILED bypasses
        private const val WALKIE_TARGET = "holler-homestead"
        private const val RECOVERY_PACKAGE = "com.homestead.recovery"
    }

    private val handler = Handler(Looper.getMainLooper())
    private var lastSuccessfulRefresh: Long = 0
    private var connectionOk = true
    // Count of consecutive failed polls. Bar gradient escalates with this number; only at
    // FAILURE_THRESHOLD do we actually consider the connection "down" for any downstream action.
    private var consecutiveFailures = 0
    private var lastWalkieSentAt: Long = 0
    // Forensic trail — each entry is one ladder step. Cleared when we land back at IDLE/RECONNECTED.
    // Walkie payload on FAILED includes the full trail so holler-homestead sees every contributing event.
    private val forensicTrail = mutableListOf<String>()

    // Native keep-checking Runnable while in FAILED phase. WebView is hidden then, so the JS-side
    // connectionChecker can't run. This Kotlin-native ping picks up where it left off and
    // auto-dismisses the overlay the moment the server comes back.
    private var failedPhasePinger: Runnable? = null

    // FAILED-phase action buttons. Created lazily, parented to the same FrameLayout as errorText,
    // and only shown when reconnectPhase == FAILED. Primary = inline Retry; secondary = open Recovery.
    private var failedActionContainer: android.widget.LinearLayout? = null
    private var retryButton: android.widget.TextView? = null
    private var recoveryButton: android.widget.TextView? = null

    // Native gradient status bar — lives at the BOTTOM of the fragment, OUTSIDE the WebView.
    // Survives webView.visibility = GONE (that's the whole point). Joshua sees the gradient
    // escalating BEFORE the destructive full-screen overlay fires, giving him agency to ignore
    // a momentary hiccup.
    private var nativeStatusBar: android.widget.TextView? = null
    private val statusBarHeightPx = 36 // tiny — meant to be peripheral, not attention-grabbing

    // Trackpad client — drives the Mac cursor when the trackpad panel is open.
    // Lives on the fragment so its TCP connection survives panel open/close
    // (otherwise reconnect cost on every panel toggle would feel laggy).
    private val trackpad = TrackpadClient()

    // Reconnect flow state — drives both the native error overlay text and the JS footer bar.
    // "idle" is the baseline (connected). The flow advances through phases so the button text
    // tells Joshua exactly what's happening without him tapping the recovery app.
    private enum class ReconnectPhase { IDLE, RELOADING, RESTARTING, RETRYING, FAILED, RECONNECTED }
    private var reconnectPhase = ReconnectPhase.IDLE
    private var reconnectInFlight = false

    // Callbacks set by MainActivity to bridge JS ↔ native recording state.
    // These run on the MAIN THREAD via handler.post — @JavascriptInterface runs on a WebView thread.
    var onGetRecordingStatus: (() -> String)? = null
    var onClaimRecordingForCard: ((cardId: String) -> Unit)? = null
    var onGetInputText: (() -> String)? = null
    var onClaimTextForCard: ((cardId: String, text: String) -> Unit)? = null
    var onClearInputText: (() -> Unit)? = null
    var onBriefOverlayActive: ((active: Boolean) -> Unit)? = null
    // Native input bridge: Presenter JS calls requestNativeInput → this fires → MainActivity shows native EditText.
    // MainActivity calls sendNativeInputResult() when user submits or cancels.
    var onRequestNativeInput: ((id: String, placeholder: String, initialValue: String, type: String) -> Unit)? = null
    // Presenter menu tile (Switch to Web View) calls Android.switchToWebView() — MainActivity
    // fulfils the fragment show/hide. Greenlit 2026-04-20; wiring lands with the Q1/Q2 cutover.
    var onSwitchToWebView: (() -> Unit)? = null

    /** Run a JS expression in the presenter and return its string result.
     *  Used by the trackpad overlay (in MainActivity) to read the active
     *  card ID + selected steward at the moment of a button tap, so the
     *  same Whisper Village claim path the desktop pill uses applies on
     *  phone too. Blocks for up to 1 second; falls back to "" on timeout
     *  or eval error so caller can degrade silently.
     *  evaluateJavascript wraps strings in JSON quotes — strip them. */
    fun evalJsForString(expr: String, timeoutMs: Long = 1000L): String {
        val wv = webView ?: return ""
        val latch = java.util.concurrent.CountDownLatch(1)
        var result = ""
        handler.post {
            wv.evaluateJavascript(expr) { raw ->
                if (raw != null && raw != "null") {
                    val unq = if (raw.length >= 2 && raw.first() == '"' && raw.last() == '"') {
                        raw.substring(1, raw.length - 1).replace("\\\"", "\"").replace("\\\\", "\\")
                    } else raw
                    result = unq
                }
                latch.countDown()
            }
        }
        latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        return result
    }

    fun trackpadGetCurrentCardId(): String =
        evalJsForString("(typeof window.__trackpadGetCurrentCardId === 'function') ? window.__trackpadGetCurrentCardId() : ''")

    /** The card NUMBER as shown on screen ("12" of "12 of 12"), or "" when no card.
     *  Josh 2026-09-04: he wants the index he can SEE, not the card's hash id.
     *  Mirrors the desktop split-pill, which renders String(currentIndex + 1)
     *  off the same mobileDeckGetState() deck state. */
    fun trackpadGetCurrentCardNumber(): String =
        evalJsForString(
            "(function(){try{" +
            "if(typeof window.mobileDeckGetState!=='function')return '';" +
            "var s=window.mobileDeckGetState();" +
            "if(!s||!s.count)return '';" +
            "var i=(typeof s.currentIndex==='number'&&s.currentIndex>=0)?s.currentIndex:0;" +
            "return String(i+1);" +
            "}catch(e){return '';}})()"
        )

    fun trackpadGetSelectedSteward(): String =
        evalJsForString("(typeof window.__trackpadGetSelectedSteward === 'function') ? window.__trackpadGetSelectedSteward() : ''")

    override fun getUrl(): String = "$HOMESTEAD_URL/presenter/index.html?embedded=true"
    override fun getTabName(): String = "Presenter"

    override fun configureWebView(webView: WebView) {
        // Use device width so mobile CSS media query triggers
        webView.settings.useWideViewPort = false
        webView.settings.loadWithOverviewMode = false

        // Always fetch from network — stale cache caused broken presenter views
        webView.settings.cacheMode = WebSettings.LOAD_DEFAULT
    }

    override fun openLinksExternally(): Boolean = true

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) {
            // Don't do a full reload — just refresh data in background
            backgroundRefresh()
        }
    }

    override fun onResume() {
        super.onResume()
        // Start periodic connection checks
        handler.post(connectionChecker)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(connectionChecker)
        failedPhasePinger?.let { handler.removeCallbacks(it) }
        failedPhasePinger = null
    }

    /**
     * Refresh content in the background without blowing away the current view.
     * Injects JS to re-fetch the queue instead of reloading the whole page.
     */
    private fun backgroundRefresh() {
        val js = """
            (function() {
                try {
                    if (window.presenter && window.presenter.getQueue) {
                        window.presenter.getQueue().then(function(q) {
                            // The onQueueUpdate callbacks handle rendering
                        });
                    }
                } catch(e) {
                    console.error('Background refresh failed:', e);
                }
            })();
        """.trimIndent()
        webView?.evaluateJavascript(js, null)
    }

    /**
     * Inject a status bar into the presenter showing connection state and last refresh time.
     * When offline, the bar becomes tappable — firing the reconnect flow through HomesteadBridge.
     */
    private fun injectStatusIndicator() {
        val refreshTime = if (lastSuccessfulRefresh > 0) {
            val fmt = SimpleDateFormat("h:mm a", Locale.US)
            fmt.format(Date(lastSuccessfulRefresh))
        } else {
            "never"
        }

        val (_, leftHtml, tappable) = footerState(refreshTime)
        val cursorCss = if (tappable) "cursor:pointer;" else ""
        val tappableJs = if (tappable) "true" else "false"

        val js = """
            (function() {
                var bar = document.getElementById('connection-status');
                if (!bar) {
                    bar = document.createElement('div');
                    bar.id = 'connection-status';
                    document.body.appendChild(bar);
                    document.body.style.paddingBottom = '28px';
                }
                bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;min-height:20px;background:#0a0a0a;border-top:1px solid #222;display:flex;align-items:center;justify-content:space-between;padding:6px 10px;font-family:VT323,monospace;font-size:13px;z-index:9999;$cursorCss';
                bar.onclick = null;
                if ($tappableJs) {
                    bar.onclick = function() {
                        if (window.HomesteadBridge && window.HomesteadBridge.startReconnect) window.HomesteadBridge.startReconnect();
                    };
                }
                bar.innerHTML = '$leftHtml<span style="color:#555">Last: $refreshTime</span>';
            })();
        """.trimIndent()
        webView?.evaluateJavascript(js, null)
    }

    /** Returns (statusColor, leftSideHtml, tappable). Single source of truth for bar rendering. */
    private fun footerState(refreshTime: String): Triple<String, String, Boolean> {
        val (color, icon, text, tappable) = currentBarState()
        val html = "<span style=\\\"color:$color\\\">$icon $text</span>"
        return Triple(color, html, tappable)
    }

    /** Single source of truth for both the JS-injected footer AND the native Kotlin bar.
     *  Encodes the gradient: connected → N missed checks (escalating) → ladder phases → FAILED. */
    private data class BarState(val color: String, val icon: String, val text: String, val tappable: Boolean)

    private fun currentBarState(): BarState {
        // Active ladder phases trump the count display.
        when (reconnectPhase) {
            ReconnectPhase.RELOADING -> return BarState("#FFCC00", "\\u21BB", "Reconnecting\\u2026", false)
            ReconnectPhase.RESTARTING -> return BarState("#FFCC00", "\\u21BB", "Restarting server\\u2026", false)
            ReconnectPhase.RETRYING -> return BarState("#FFCC00", "\\u21BB", "Retrying\\u2026", false)
            ReconnectPhase.RECONNECTED -> return BarState("#00FF66", "\\u25CF", "Reconnected", false)
            ReconnectPhase.FAILED -> return BarState("#FF3333", "\\u26A0", "Couldn't reconnect \\u2014 tap to retry", true)
            ReconnectPhase.IDLE -> { /* fall through to count-based display */ }
        }
        // IDLE — show gradient escalation by consecutive failure count.
        if (consecutiveFailures == 0) {
            return BarState("#00FF66", "\\u25CF", "Connected", false)
        }
        // 1..(threshold-1) — yellow, escalating count. Joshua sees the system is watching
        // without losing the WebView underneath.
        val word = if (consecutiveFailures == 1) "miss" else "misses"
        return BarState("#FFCC00", "\\u26A0", "Network unstable \\u2014 $consecutiveFailures $word", false)
    }

    /**
     * The reconnect flow Joshua triggers from the footer (or from the native error overlay).
     * 1) Reload WebView. If it loads → done.
     * 2) On failure: POST watchdog /api/restart → wait 8s → reload.
     * 3) If still failing → surface "Open Recovery" button.
     *
     * Runs on main thread for UI updates; network work on IO.
     */
    fun startReconnect() {
        if (reconnectInFlight) return
        reconnectInFlight = true
        reconnectPhase = ReconnectPhase.RELOADING
        forensicTrail.add("reconnect_started: connOk=$connectionOk, fails=$consecutiveFailures, net=${networkSummary()}, lastOk=${msSinceLastSuccessfulRefresh()}ms ago @ ${System.currentTimeMillis()}")
        logState("reconnect_started", "Auto/manual reconnect ladder firing")
        // Force the native overlay visible (and hide the WebView) for the duration of the cycle.
        // Realistic "homestead down" returns a 502 body the WebView happily renders as a page —
        // onWebViewLoadError never fires — so this is the only place we make the overlay appear
        // during a reconnect cycle initiated from connectionOk=false (vs. a load error).
        errorText?.visibility = android.view.View.VISIBLE
        webView?.visibility = android.view.View.GONE
        refreshOfflineUI()
        // Step 1: reload WebView
        handler.post { loadUrl() }
        // Give the reload up to 6s to call onPageFinished (which flips connectionOk=true via
        // the native ping). If still failing, advance to the watchdog restart step.
        handler.postDelayed({
            if (!reconnectInFlight) return@postDelayed
            if (connectionOk) {
                forensicTrail.add("reload_succeeded")
                finishReconnect(success = true)
            } else {
                forensicTrail.add("reload_failed_advancing_to_watchdog")
                runWatchdogRestart()
            }
        }, 6000)
    }

    private fun runWatchdogRestart() {
        if (!reconnectInFlight) return
        reconnectPhase = ReconnectPhase.RESTARTING
        forensicTrail.add("watchdog_restart_attempt @ ${System.currentTimeMillis()}")
        refreshOfflineUI()
        CoroutineScope(Dispatchers.IO).launch {
            // One retry with 3s backoff — single failed watchdog POST is too thin to declare
            // the box dead, especially on flaky cellular.
            suspend fun attempt(label: String): Pair<Boolean, String> {
                return withContext(Dispatchers.IO) {
                    var conn: HttpURLConnection? = null
                    try {
                        val url = URL("$WATCHDOG_URL/api/restart")
                        conn = (url.openConnection() as HttpURLConnection).apply {
                            requestMethod = "POST"
                            connectTimeout = 8000
                            readTimeout = 8000
                            doOutput = true
                        }
                        conn.outputStream.use { it.write("{}".toByteArray()) }
                        val code = conn.responseCode
                        Pair(code in 200..299, "$label:http_$code")
                    } catch (e: Exception) {
                        Pair(false, "$label:${e.javaClass.simpleName}:${e.message}")
                    } finally {
                        conn?.disconnect()
                    }
                }
            }
            val first = attempt("attempt1")
            val (ok, reason) = if (first.first) first else {
                delay(3000)
                val second = attempt("attempt2")
                Pair(second.first, "${first.second}|${second.second}")
            }
            forensicTrail.add("watchdog_result: $reason")
            withContext(Dispatchers.Main) {
                if (!reconnectInFlight) return@withContext
                if (!ok) {
                    logState("watchdog_unreachable", "Watchdog POST failed both attempts: $reason")
                    finishReconnect(success = false)
                    return@withContext
                }
                reconnectPhase = ReconnectPhase.RETRYING
                refreshOfflineUI()
                handler.postDelayed({
                    if (!reconnectInFlight) return@postDelayed
                    handler.post { loadUrl() }
                    handler.postDelayed({
                        if (!reconnectInFlight) return@postDelayed
                        finishReconnect(success = connectionOk)
                    }, 6000)
                }, 8000)
            }
        }
    }

    private fun finishReconnect(success: Boolean) {
        reconnectInFlight = false
        reconnectPhase = if (success) ReconnectPhase.RECONNECTED else ReconnectPhase.FAILED
        if (success) {
            forensicTrail.add("reconnect_succeeded")
            logState("reconnect_succeeded", "Ladder recovered the connection")
            forensicTrail.clear()
            consecutiveFailures = 0
            stopFailedPhasePinger()
            refreshOfflineUI()
            hideError()
            // Snap the footer back to "Connected" after the "Reconnected" flash
            handler.postDelayed({
                if (reconnectPhase == ReconnectPhase.RECONNECTED) {
                    reconnectPhase = ReconnectPhase.IDLE
                    refreshOfflineUI()
                }
            }, 2500)
        } else {
            forensicTrail.add("reconnect_gave_up_landed_in_FAILED")
            // logState before bar refresh so the FAILED-phase walkie ships the full trail.
            logState("reconnect_gave_up", "Reconnect ladder exhausted — showing FAILED overlay + starting native keep-checking ping")
            refreshOfflineUI()
            // Critical: WebView is now hidden, JS-side connectionChecker silently dies.
            // Native-side ping keeps watching so we auto-recover when homestead comes back.
            startFailedPhasePinger()
        }
    }

    /** Called when the reconnect button is tapped in the FAILED phase — deep-links to recovery APK. */
    private fun openRecoveryApp() {
        val ctx = context ?: return
        val intent = ctx.packageManager.getLaunchIntentForPackage(RECOVERY_PACKAGE)
        if (intent != null) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(intent)
        } else {
            // Fallback to Play-style market intent or a toast
            android.widget.Toast.makeText(ctx, "Recovery app not installed", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    /** Push current state to the JS footer AND the native error overlay (whichever is visible)
     *  AND the native Kotlin bottom bar (which survives webView.visibility = GONE). */
    private fun refreshOfflineUI() {
        handler.post {
            injectStatusIndicator()
            updateNativeErrorOverlay()
            updateNativeStatusBar()
        }
    }

    /** Build the native Kotlin status bar (TextView) pinned to the bottom of the fragment root.
     *  Parented to the fragment's root FrameLayout — NOT to the WebView — so it stays visible
     *  even when the WebView is hidden by the FAILED overlay. */
    private fun ensureNativeStatusBarBuilt() {
        if (nativeStatusBar != null) return
        val root = view as? android.widget.FrameLayout ?: return
        val ctx = root.context
        val bar = android.widget.TextView(ctx).apply {
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(24, 6, 24, 6)
            textSize = 11f
            setTextColor(0xFFCCCCCC.toInt())
            setBackgroundColor(0xFF0A0A0A.toInt())
            // Bottom-pinned, full-width, fixed height.
            val lp = android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                statusBarHeightPx
            )
            lp.gravity = android.view.Gravity.BOTTOM
            layoutParams = lp
            // Make tappable only when state says so (handled in update method).
            isClickable = false
        }
        root.addView(bar)
        // Push the WebView container up so the bar doesn't cover content. swipeRefresh is the
        // parent of webView and lives at MATCH_PARENT — bumping its bottomMargin reclaims the
        // bar's height.
        swipeRefresh?.let { sr ->
            val lp = sr.layoutParams as? android.widget.FrameLayout.LayoutParams
            if (lp != null && lp.bottomMargin != statusBarHeightPx) {
                lp.bottomMargin = statusBarHeightPx
                sr.layoutParams = lp
            }
        }
        // Same for the errorText overlay, so the bar is always visible underneath it.
        errorText?.let { et ->
            val lp = et.layoutParams as? android.widget.FrameLayout.LayoutParams
            if (lp != null && lp.bottomMargin < statusBarHeightPx) {
                lp.bottomMargin = statusBarHeightPx
                et.layoutParams = lp
            }
        }
        nativeStatusBar = bar
    }

    /** Paint the current state onto the native bar. Strips HTML entities from currentBarState
     *  (they're for the JS footer); the native bar uses plain text + native color. */
    private fun updateNativeStatusBar() {
        val bar = nativeStatusBar ?: return
        val state = currentBarState()
        val color = try { android.graphics.Color.parseColor(state.color) } catch (_: Exception) { 0xFFCCCCCC.toInt() }
        // Decode the few \\uXXXX escapes we use (\\u25CF dot, \\u26A0 warning, \\u21BB reload).
        val displayText = "${decodeIcon(state.icon)} ${decodeIcon(state.text)}"
        bar.setTextColor(color)
        bar.text = displayText
        if (state.tappable) {
            bar.isClickable = true
            bar.setOnClickListener {
                reconnectInFlight = false
                reconnectPhase = ReconnectPhase.IDLE
                startReconnect()
            }
        } else {
            bar.isClickable = false
            bar.setOnClickListener(null)
        }
    }

    private fun decodeIcon(s: String): String {
        // Cheap unescaper for the \\uXXXX literals our state strings carry (footer JS-string-escaped).
        val sb = StringBuilder()
        var i = 0
        while (i < s.length) {
            if (i + 5 < s.length && s[i] == '\\' && s[i + 1] == 'u') {
                try {
                    val code = s.substring(i + 2, i + 6).toInt(16)
                    sb.append(code.toChar())
                    i += 6
                    continue
                } catch (_: Exception) { /* fall through */ }
            }
            sb.append(s[i]); i++
        }
        return sb.toString()
    }

    private fun updateNativeErrorOverlay() {
        val overlay = errorText ?: return
        // FAILED phase always paints, even if something else hid the overlay — the action
        // container is the only entry point for Retry/Open-Recovery in this state.
        if (reconnectPhase == ReconnectPhase.FAILED) {
            overlay.visibility = android.view.View.VISIBLE
            webView?.visibility = android.view.View.GONE
        } else if (overlay.visibility != android.view.View.VISIBLE) {
            failedActionContainer?.visibility = android.view.View.GONE
            return
        }
        val msg: String
        val tapAction: (() -> Unit)?
        when (reconnectPhase) {
            ReconnectPhase.IDLE -> { msg = "Offline — tap to reconnect"; tapAction = { startReconnect() } }
            ReconnectPhase.RELOADING -> { msg = "Reconnecting…"; tapAction = null }
            ReconnectPhase.RESTARTING -> { msg = "Restarting server…"; tapAction = null }
            ReconnectPhase.RETRYING -> { msg = "Retrying after restart…"; tapAction = null }
            ReconnectPhase.RECONNECTED -> { msg = "Reconnected"; tapAction = null }
            ReconnectPhase.FAILED -> { msg = "Couldn't reconnect."; tapAction = null }
        }
        overlay.text = msg
        overlay.setOnClickListener(if (tapAction == null) null else android.view.View.OnClickListener { tapAction.invoke() })

        if (reconnectPhase == ReconnectPhase.FAILED) {
            ensureFailedActionsBuilt()
            failedActionContainer?.visibility = android.view.View.VISIBLE
            failedActionContainer?.bringToFront()
        } else {
            failedActionContainer?.visibility = android.view.View.GONE
        }
    }

    /** Build the FAILED-phase action panel once and attach it to errorText's parent. */
    private fun ensureFailedActionsBuilt() {
        if (failedActionContainer != null) return
        val overlay = errorText ?: return
        val parent = overlay.parent as? android.widget.FrameLayout ?: return
        val ctx = parent.context

        val container = android.widget.LinearLayout(ctx).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            visibility = android.view.View.GONE
            val lp = android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
            )
            lp.gravity = android.view.Gravity.CENTER
            // Push below the message text — overlay is full-screen centered, so offset down a bit.
            lp.topMargin = 96
            layoutParams = lp
            setPadding(48, 32, 48, 32)
        }

        val primary = android.widget.TextView(ctx).apply {
            text = "Retry"
            textSize = 18f
            setTextColor(0xFF121212.toInt())
            setBackgroundColor(0xFFFFCC00.toInt())
            gravity = android.view.Gravity.CENTER
            setPadding(48, 32, 48, 32)
            val lp = android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.bottomMargin = 24
            layoutParams = lp
            isClickable = true
            isFocusable = true
            setOnClickListener {
                // Reset phase so startReconnect's in-flight guard releases the next pass through finishReconnect.
                reconnectInFlight = false
                reconnectPhase = ReconnectPhase.IDLE
                startReconnect()
            }
        }

        val secondary = android.widget.TextView(ctx).apply {
            text = "Open Recovery app"
            textSize = 14f
            setTextColor(0xFF888888.toInt())
            gravity = android.view.Gravity.CENTER
            setPadding(24, 16, 24, 16)
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
            )
            isClickable = true
            isFocusable = true
            paintFlags = paintFlags or android.graphics.Paint.UNDERLINE_TEXT_FLAG
            setOnClickListener { openRecoveryApp() }
        }

        container.addView(primary)
        container.addView(secondary)
        parent.addView(container)

        failedActionContainer = container
        retryButton = primary
        recoveryButton = secondary
    }

    override fun onWebViewLoadError(errorCode: Int, description: String?, failingUrl: String?): Boolean {
        // Show our own overlay with state-aware text + click.
        errorText?.apply {
            visibility = android.view.View.VISIBLE
            text = "Offline — tap to reconnect"
            setOnClickListener { startReconnect() }
        }
        webView?.visibility = android.view.View.GONE
        return true  // suppress default
    }

    private val connectionChecker = object : Runnable {
        override fun run() {
            // Kotlin-native ping with DNS-aware retry (Tailscale MagicDNS frequently blips on
            // network changes — 1 retry after 2s before declaring failure). Runs from native,
            // NOT from JS inside the WebView, so it survives webView.visibility = GONE — which
            // matters in the FAILED phase where JS-side polling would otherwise stall.
            CoroutineScope(Dispatchers.IO).launch {
                val result = nativePingHomestead()
                withContext(Dispatchers.Main) {
                    onConnectionStatus(if (result.ok) "ok" else "fail", result.reason)
                }
            }

            // Background data refresh still runs through the WebView when visible.
            if (webView?.visibility == android.view.View.VISIBLE) {
                backgroundRefresh()
            }

            handler.postDelayed(this, REFRESH_CHECK_INTERVAL)
        }
    }

    /** Native ping result — ok plus a short reason string used for forensic trail entries. */
    private data class PingResult(val ok: Boolean, val reason: String)

    /**
     * Native HTTPS ping to homestead. 15s timeout (was 5s — too aggressive for mobile after
     * cell handoff). On DNS-class failure (UnknownHostException), retries ONCE after 2s.
     */
    private suspend fun nativePingHomestead(): PingResult {
        suspend fun attempt(): PingResult {
            return withContext(Dispatchers.IO) {
                var conn: HttpURLConnection? = null
                try {
                    val url = URL("$HOMESTEAD_URL/api/presenter/queue")
                    conn = (url.openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 15_000
                        readTimeout = 15_000
                    }
                    val code = conn.responseCode
                    PingResult(code in 200..299, "http_$code")
                } catch (e: UnknownHostException) {
                    PingResult(false, "dns:${e.message}")
                } catch (e: Exception) {
                    PingResult(false, "${e.javaClass.simpleName}:${e.message}")
                } finally {
                    conn?.disconnect()
                }
            }
        }
        val first = attempt()
        if (first.ok) return first
        // DNS-class retry: one more shot after 2s. Tailscale MagicDNS commonly blips during
        // network-type changes — this absorbs the single-resolve-fail case before it counts
        // against the consecutive-failures budget.
        if (first.reason.startsWith("dns:")) {
            delay(2000)
            val second = attempt()
            return if (second.ok) second else PingResult(false, "${first.reason}|retry:${second.reason}")
        }
        return first
    }

    /** Native pinger used during the FAILED phase. WebView is hidden then, so the regular
     *  JS-injected refresh path is dead. This Kotlin-native poll auto-dismisses the overlay
     *  the moment homestead comes back, even without Joshua tapping Retry. */
    private fun startFailedPhasePinger() {
        if (failedPhasePinger != null) return
        val self = object : Runnable {
            override fun run() {
                if (reconnectPhase != ReconnectPhase.FAILED) {
                    failedPhasePinger = null
                    return
                }
                val outer = this
                CoroutineScope(Dispatchers.IO).launch {
                    val res = nativePingHomestead()
                    withContext(Dispatchers.Main) {
                        if (reconnectPhase != ReconnectPhase.FAILED) {
                            failedPhasePinger = null
                            return@withContext
                        }
                        if (res.ok) {
                            logState("failed_phase_auto_recovery", "Native ping succeeded — dismissing overlay")
                            consecutiveFailures = 0
                            connectionOk = true
                            lastSuccessfulRefresh = System.currentTimeMillis()
                            reconnectPhase = ReconnectPhase.RECONNECTED
                            failedActionContainer?.visibility = android.view.View.GONE
                            hideError()
                            loadUrl()
                            refreshOfflineUI()
                            handler.postDelayed({
                                if (reconnectPhase == ReconnectPhase.RECONNECTED) {
                                    reconnectPhase = ReconnectPhase.IDLE
                                    refreshOfflineUI()
                                }
                            }, 2500)
                            failedPhasePinger = null
                            return@withContext
                        }
                        // still down — schedule another ping
                        handler.postDelayed(outer, FAILED_PHASE_PING_INTERVAL)
                    }
                }
            }
        }
        failedPhasePinger = self
        handler.postDelayed(self, FAILED_PHASE_PING_INTERVAL)
    }

    private fun stopFailedPhasePinger() {
        failedPhasePinger?.let { handler.removeCallbacks(it) }
        failedPhasePinger = null
    }

    /**
     * Push recording state into the WebView immediately so the JS recording poll
     * picks it up on the next tick without waiting for the next native bridge pull.
     * Called from MainActivity on every transition of audioRecorder.isRecording().
     */
    fun pushRecordingState(isRecording: Boolean, hasRecording: Boolean, hasText: Boolean) {
        val js = "window.__nativeRecordingState = " +
            "{isRecording:$isRecording,hasRecording:$hasRecording,hasText:$hasText,ts:${System.currentTimeMillis()}};" +
            "if (typeof window.__onNativeRecordingState === 'function') { try { window.__onNativeRecordingState(window.__nativeRecordingState); } catch(e){} }"
        handler.post { webView?.evaluateJavascript(js, null) }
    }

    /**
     * Called from JS bridge with connection status (legacy path — kept for the JS-side
     * connectionChecker that still fires when the WebView is visible).
     */
    fun onConnectionStatus(status: String) {
        onConnectionStatus(status, if (status == "ok") "js_ok" else "js_fail")
    }

    /**
     * Process a connection-check result. Tracks consecutive failures rather than firing
     * the reconnect ladder on a single bad poll. The native bar shows the gradient
     * escalation ("Connected" → "1 missed check" → ... → "Reconnecting…") long before
     * the destructive full-screen overlay can possibly appear.
     */
    fun onConnectionStatus(status: String, reason: String) {
        val wasOk = connectionOk
        val nowOk = (status == "ok")

        if (nowOk) {
            // Any successful poll resets the failure counter and confirms we're connected.
            if (consecutiveFailures > 0) {
                logState("recovered_before_threshold",
                    "Connection recovered after $consecutiveFailures consecutive failure(s) — never crossed threshold")
            }
            consecutiveFailures = 0
            connectionOk = true
            lastSuccessfulRefresh = System.currentTimeMillis()
            // If we WERE down and just recovered, tear down the overlay + restore the WebView.
            if (!wasOk) {
                logState("connection_recovered", "Connection back: $reason")
                handler.post {
                    failedActionContainer?.visibility = android.view.View.GONE
                    if (webView?.visibility != android.view.View.VISIBLE) {
                        hideError()
                        loadUrl()
                    }
                    refreshOfflineUI()
                }
                return
            }
            // Routine successful poll — just update the bar.
            handler.post { refreshOfflineUI() }
            return
        }

        // Failed poll. Increment, but DON'T flip connectionOk until we cross threshold.
        consecutiveFailures++
        forensicTrail.add("poll_fail#$consecutiveFailures: $reason @ ${System.currentTimeMillis()}")
        logState("poll_failed",
            "Failed poll $consecutiveFailures/$FAILURE_THRESHOLD: $reason " +
            "(net=${networkSummary()}, lastOk=${msSinceLastSuccessfulRefresh()}ms ago)")

        if (consecutiveFailures < FAILURE_THRESHOLD) {
            // Below threshold — show degraded state on the bar but don't fire reconnect.
            // Joshua sees "1 missed check" / "2 missed checks" and knows the system is
            // watching without losing the WebView underneath.
            handler.post { refreshOfflineUI() }
            return
        }

        // Crossed threshold. Now we treat the connection as actually down.
        if (wasOk) {
            connectionOk = false
            logState("threshold_crossed",
                "Hit $FAILURE_THRESHOLD consecutive failures — firing reconnect ladder")
            handler.post {
                refreshOfflineUI()
                startReconnect()
            }
            return
        }
        // Already down, just update the bar.
        handler.post { refreshOfflineUI() }
    }

    /** ms since last good poll, or -1 if we've never had one. */
    private fun msSinceLastSuccessfulRefresh(): Long {
        return if (lastSuccessfulRefresh == 0L) -1
        else System.currentTimeMillis() - lastSuccessfulRefresh
    }

    /** "wifi" / "cell" / "other" / "none" — best-effort from ConnectivityManager. */
    private fun networkSummary(): String {
        val ctx = context ?: return "no_ctx"
        val cm = ctx.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return "no_cm"
        val active = cm.activeNetwork ?: return "none"
        val caps = cm.getNetworkCapabilities(active) ?: return "unknown"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cell"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    /** Log a state event to logcat AND walkie holler-homestead (throttled). FAILED-phase
     *  events bypass the throttle and include the full forensic trail. */
    private fun logState(event: String, detail: String) {
        val tag = "PresenterReconnect"
        Log.i(tag, "$event | phase=$reconnectPhase | connOk=$connectionOk | fails=$consecutiveFailures | $detail")
        val isFailedEscalation = reconnectPhase == ReconnectPhase.FAILED || event == "threshold_crossed" ||
            event == "watchdog_unreachable" || event == "reconnect_gave_up"
        val now = System.currentTimeMillis()
        if (!isFailedEscalation && (now - lastWalkieSentAt) < WALKIE_THROTTLE_MS) {
            return
        }
        lastWalkieSentAt = now
        val payload = buildString {
            append("APK reconnect event [$event]: $detail. ")
            append("phase=$reconnectPhase, connOk=$connectionOk, fails=$consecutiveFailures, ")
            append("net=${networkSummary()}, lastOk=${msSinceLastSuccessfulRefresh()}ms ago.")
            if (isFailedEscalation && forensicTrail.isNotEmpty()) {
                append(" Forensic trail (${forensicTrail.size} steps): ")
                append(forensicTrail.joinToString(" | "))
            }
        }
        sendWalkie(payload)
    }

    /** Raw-HTTP walkie via the dispatcher. Endpoint is `POST /api/queue`, body field is
     *  `message:` (per Library lessons #108 + #109). Best-effort: if homestead itself is
     *  down, this will also fail — that's expected and we just log it. */
    private fun sendWalkie(message: String) {
        CoroutineScope(Dispatchers.IO).launch {
            var conn: HttpURLConnection? = null
            try {
                val url = URL("$HOMESTEAD_URL/api/queue")
                conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 5_000
                    readTimeout = 5_000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
                val body = org.json.JSONObject().apply {
                    put("target_session", WALKIE_TARGET)
                    put("type", "feedback")
                    put("message", message)
                }.toString()
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                if (code !in 200..299) {
                    Log.w("PresenterReconnect", "Walkie send returned HTTP $code")
                }
            } catch (e: Exception) {
                Log.w("PresenterReconnect", "Walkie send failed (expected if homestead is the thing that's down): ${e.message}")
            } finally {
                conn?.disconnect()
            }
        }
    }

    /**
     * Push a native-input result back to the Presenter JS.
     * Action is "submit" or "cancel". Value is the final text (empty string on cancel).
     * Escapes strings as JSON literals so quotes/newlines/backslashes survive.
     */
    fun sendNativeInputResult(id: String, action: String, value: String) {
        val idJson = org.json.JSONObject.quote(id)
        val actionJson = org.json.JSONObject.quote(action)
        val valueJson = org.json.JSONObject.quote(value)
        val js = "if (typeof window.onNativeInputResult === 'function') { " +
            "try { window.onNativeInputResult($idJson, $actionJson, $valueJson); } catch(e) { console.error('onNativeInputResult failed:', e); } }"
        handler.post { webView?.evaluateJavascript(js, null) }
    }

    /**
     * Push the native EditText's CURRENT text to the Presenter JS on every keystroke
     * (Josh 2026-08-30). Without this, text typed in the native box lives only in
     * Kotlin: per-card drafts never saved it, and the Presenter's own send buttons
     * read an empty web textarea and silently did nothing.
     *
     * Fire-and-forget and deliberately cheap — the JS side debounces its own server
     * writes, so this only has to keep the in-page textarea mirrored.
     */
    fun sendNativeInputChanged(id: String, value: String) {
        val idJson = org.json.JSONObject.quote(id)
        val valueJson = org.json.JSONObject.quote(value)
        val js = "if (typeof window.onNativeInputChanged === 'function') { " +
            "try { window.onNativeInputChanged($idJson, $valueJson); } catch(e) { console.error('onNativeInputChanged failed:', e); } }"
        handler.post { webView?.evaluateJavascript(js, null) }
    }

    /**
     * Navigate the presenter WebView to a specific card by ID.
     * Called when the user taps a presenter notification.
     * Retries a few times since the page may still be loading.
     */
    fun navigateToCard(cardId: String) {
        val escaped = cardId.replace("'", "\\'")
        fun tryNavigate(attemptsLeft: Int) {
            webView?.evaluateJavascript("window.navigateToCard && window.navigateToCard('$escaped')") { result ->
                if (result == "true" || attemptsLeft <= 0) return@evaluateJavascript
                // Page might not be loaded yet — retry after a delay
                handler.postDelayed({ tryNavigate(attemptsLeft - 1) }, 1000)
            }
        }
        tryNavigate(5)
    }

    override fun onViewCreated(view: android.view.View, savedInstanceState: android.os.Bundle?) {
        // Disable pull-to-refresh — interferes with scrolling presenter cards.
        swipeRefresh?.isEnabled = false

        // Register JS interfaces BEFORE super.onViewCreated() which triggers loadUrl().
        // If registered after, window.Android is not visible to already-executing JS
        // (race condition — the page's startRecordingPoll() runs immediately on load).
        webView?.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun onConnectionStatus(status: String) {
                this@PresenterFragment.onConnectionStatus(status)
            }

            @android.webkit.JavascriptInterface
            fun startReconnect() {
                handler.post { this@PresenterFragment.startReconnect() }
            }
        }, "HomesteadBridge")

        webView?.addJavascriptInterface(object {

            private fun <T> runOnMainSync(block: () -> T, fallback: T): T {
                if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
                    return block()
                }
                val latch = java.util.concurrent.CountDownLatch(1)
                var result: T = fallback
                handler.post {
                    result = block()
                    latch.countDown()
                }
                latch.await(2, java.util.concurrent.TimeUnit.SECONDS)
                return result
            }

            @android.webkit.JavascriptInterface
            fun getRecordingStatus(): String {
                return runOnMainSync({
                    onGetRecordingStatus?.invoke() ?: """{"isRecording":false,"hasRecording":false,"hasText":false}"""
                }, """{"isRecording":false,"hasRecording":false,"hasText":false}""")
            }

            @android.webkit.JavascriptInterface
            fun claimRecordingForCard(cardId: String) {
                handler.post { onClaimRecordingForCard?.invoke(cardId) }
            }

            @android.webkit.JavascriptInterface
            fun getInputText(): String {
                return runOnMainSync({
                    onGetInputText?.invoke() ?: ""
                }, "")
            }

            /**
             * Empty the native text box after the presenter has actually SENT
             * whatever was in it. `getInputText` only reads — without this the
             * box kept its text and Josh had to clear it by hand every send.
             * Only called on a send that really went through; an aborted send
             * must leave the text alone.
             */
            @android.webkit.JavascriptInterface
            fun clearInputText() {
                handler.post { onClearInputText?.invoke() }
            }

            @android.webkit.JavascriptInterface
            fun claimTextForCard(cardId: String) {
                handler.post {
                    val text = onGetInputText?.invoke() ?: ""
                    if (text.isNotBlank()) {
                        onClaimTextForCard?.invoke(cardId, text)
                    }
                }
            }

            /**
             * Dismiss the Android notification for a presenter card.
             * Called after respond/dismiss so the notification clears automatically.
             */
            /**
             * Called from Presenter JS when the bridge-brief full-screen overlay
             * opens or closes. When active, the parent ViewPager2 swipe navigation
             * must be disabled so horizontal swipes reach the WebView instead of
             * switching tabs.
             */
            @android.webkit.JavascriptInterface
            fun setBriefOverlayActive(active: Boolean) {
                handler.post { onBriefOverlayActive?.invoke(active) }
            }

            @android.webkit.JavascriptInterface
            fun dismissNotification(cardId: String) {
                val ctx = context ?: return
                val notifId = "presenter_$cardId".hashCode()
                android.app.NotificationManager::class.java.cast(
                    ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE)
                )?.cancel(notifId)
            }

            @android.webkit.JavascriptInterface
            fun requestNativeInput(id: String, placeholder: String, initialValue: String, type: String) {
                handler.post {
                    onRequestNativeInput?.invoke(id, placeholder, initialValue, type)
                }
            }

            @android.webkit.JavascriptInterface
            fun switchToWebView() {
                handler.post { onSwitchToWebView?.invoke() }
            }

            @android.webkit.JavascriptInterface
            fun openUri(uri: String) {
                val ctx = context ?: return
                handler.post {
                    try {
                        val parsedUri = android.net.Uri.parse(uri)
                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, parsedUri)
                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                        val scheme = parsedUri.scheme?.lowercase()
                        if (scheme == "http" || scheme == "https") {
                            // Use chooser to avoid resolving to our own launcher app
                            val chooser = android.content.Intent.createChooser(intent, "Open with")
                            chooser.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                            ctx.startActivity(chooser)
                        } else {
                            ctx.startActivity(intent)
                        }
                    } catch (e: Exception) {
                        android.util.Log.e("PresenterFragment", "openUri failed: ${e.message}")
                    }
                }
            }

            // Hard kill + cold relaunch of the whole APK — same mechanism the recovery
            // app's "FULL APK RESTART" button uses. The presenter's bottom 🔄 Reload
            // button calls this so a real cold start happens and Homestead APK updates
            // actually show (a WebView soft-reload never re-runs MainActivity.onCreate).
            // We re-fire our OWN launch intent with the recovery_full_restart extra;
            // MainActivity.onNewIntent routes it to triggerFullRestart() — reusing the
            // fully-tested recovery path with zero new coupling.
            @android.webkit.JavascriptInterface
            fun fullRestart() {
                val ctx = context ?: return
                handler.post {
                    try {
                        val launchIntent = ctx.packageManager
                            .getLaunchIntentForPackage(ctx.packageName)
                        if (launchIntent == null) {
                            android.util.Log.e("PresenterFragment", "fullRestart: no launch intent for ${ctx.packageName}")
                            return@post
                        }
                        launchIntent.putExtra("recovery_full_restart", true)
                        launchIntent.addFlags(
                            android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                                android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP
                        )
                        ctx.startActivity(launchIntent)
                    } catch (e: Exception) {
                        android.util.Log.e("PresenterFragment", "fullRestart failed: ${e.message}")
                    }
                }
            }
        }, "Android")

        webView?.addJavascriptInterface(object {
            // Mac cursor controller bridge. JS in the trackpad panel calls these
            // methods. The native TrackpadClient owns the TCP socket + keepalive.
            // Status changes are pushed back to JS via window.onTrackpadStatus(json).

            @android.webkit.JavascriptInterface
            fun connect(host: String) {
                handler.post {
                    val ctx = context ?: return@post
                    ctx.getSharedPreferences("trackpad", android.content.Context.MODE_PRIVATE)
                        .edit().putString("host", host).apply()
                    trackpad.statusListener = { _, _ -> pushTrackpadStatusToJS() }
                    trackpad.disconnect()
                    trackpad.connect(host)
                }
            }

            @android.webkit.JavascriptInterface
            fun reconnectIfNeeded() {
                handler.post { trackpad.reconnectIfNeeded() }
            }

            @android.webkit.JavascriptInterface
            fun disconnect() {
                handler.post { trackpad.disconnect() }
            }

            @android.webkit.JavascriptInterface
            fun savedHost(): String {
                val ctx = context ?: return ""
                return ctx.getSharedPreferences("trackpad", android.content.Context.MODE_PRIVATE)
                    .getString("host", "") ?: ""
            }

            @android.webkit.JavascriptInterface
            fun status(): String {
                return JSONObjectStr(
                    "status" to trackpad.status.name,
                    "host" to (context?.getSharedPreferences("trackpad", android.content.Context.MODE_PRIVATE)?.getString("host", "") ?: ""),
                    "secondsSincePong" to trackpad.secondsSinceLastPong(),
                    "lastError" to (trackpad.lastError ?: "")
                )
            }

            @android.webkit.JavascriptInterface
            fun move(dx: Float, dy: Float) { trackpad.sendMove(dx, dy) }

            @android.webkit.JavascriptInterface
            fun click() { trackpad.sendClick() }

            @android.webkit.JavascriptInterface
            fun doubleClick() { trackpad.sendDoubleClick() }

            @android.webkit.JavascriptInterface
            fun scroll(dx: Float, dy: Float) { trackpad.sendScroll(dx, dy) }

            @android.webkit.JavascriptInterface
            fun key(name: String) { trackpad.sendKey(name) }
        }, "Trackpad")

        // NOW load the page — interfaces are registered and ready
        super.onViewCreated(view, savedInstanceState)

        // Build the native bottom status bar AFTER super (so `view` is the populated root
        // FrameLayout). The bar lives OUTSIDE the WebView so it stays visible even when the
        // WebView is hidden by the FAILED overlay — that's the whole point.
        ensureNativeStatusBarBuilt()
        updateNativeStatusBar()
    }

    /** Build a tiny JSON string from key→value pairs. Avoids dragging
     *  org.json into PresenterFragment for one-off bridge replies. */
    private fun JSONObjectStr(vararg pairs: Pair<String, Any?>): String {
        val sb = StringBuilder("{")
        pairs.forEachIndexed { i, (k, v) ->
            if (i > 0) sb.append(",")
            sb.append("\"").append(k).append("\":")
            when (v) {
                is Number -> sb.append(v.toString())
                is Boolean -> sb.append(v.toString())
                null -> sb.append("null")
                else -> sb.append("\"").append(v.toString().replace("\"", "\\\"")).append("\"")
            }
        }
        sb.append("}")
        return sb.toString()
    }

    private fun pushTrackpadStatusToJS() {
        handler.post {
            val js = "if (window.onTrackpadStatus) window.onTrackpadStatus(${JSONObjectStr(
                "status" to trackpad.status.name,
                "secondsSincePong" to trackpad.secondsSinceLastPong(),
                "lastError" to (trackpad.lastError ?: "")
            )});"
            webView?.evaluateJavascript(js, null)
        }
    }

    override fun onDestroyView() {
        handler.removeCallbacks(connectionChecker)
        failedPhasePinger?.let { handler.removeCallbacks(it) }
        failedPhasePinger = null
        nativeStatusBar = null
        super.onDestroyView()
    }
}
