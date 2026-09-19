package com.homestead.mobile

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.content.Intent
import android.net.Uri
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

abstract class WebViewFragment : Fragment() {

    /**
     * Background painted by this fragment's root and by its WebView.
     *
     * Overridable so a screen that must let the system wallpaper through can opt
     * out of the opaque default. A WebView paints its own page background, so
     * BOTH the container and the WebView have to honour this or the wallpaper
     * stays hidden behind whichever one was missed.
     */
    protected open val rootBackgroundColor: Int = 0xFF121212.toInt()

    companion object {
        private const val TAG = "WebViewPerf"

        // Enable Chrome DevTools remote debugging for WebViews
        init {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                WebView.setWebContentsDebuggingEnabled(true)
            }
        }
    }

    var webView: WebView? = null
        protected set
    protected var swipeRefresh: SwipeRefreshLayout? = null
    private var progressBar: ProgressBar? = null
    protected var errorText: TextView? = null
    private var perfText: TextView? = null

    // Performance tracking
    private var loadStartTime: Long = 0
    private var firstContentfulPaint: Long = 0
    private var domContentLoaded: Long = 0
    private var pageFinishedTime: Long = 0

    abstract fun getUrl(): String
    abstract fun getTabName(): String

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val layout = FrameLayout(requireContext()).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(rootBackgroundColor)
        }

        // Thin progress bar overlay at the very top — 8px, no background, drawn over the WebView.
        // Native reload button removed (non-functional per user feedback 2026-04-20).
        progressBar = ProgressBar(requireContext(), null, android.R.attr.progressBarStyleHorizontal).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                8
            )
            isIndeterminate = false
            max = 100
            progressDrawable.setColorFilter(
                0xFFFFCC00.toInt(),
                android.graphics.PorterDuff.Mode.SRC_IN
            )
        }

        // Performance text kept for diagnostics but never surfaced (visibility GONE).
        perfText = TextView(requireContext()).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
            visibility = View.GONE
        }

        // Error text (hidden by default, tap to retry)
        errorText = TextView(requireContext()).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ).apply {
                setMargins(48, 48, 48, 48)
            }
            setTextColor(0xFF888888.toInt())
            textSize = 16f
            gravity = android.view.Gravity.CENTER
            visibility = View.GONE
            setOnClickListener { loadUrl() }
        }
        layout.addView(errorText)

        // Edge-to-edge: WebView fills the fragment. The presenter HTML owns the status-bar-height spacer.
        swipeRefresh = SwipeRefreshLayout(requireContext()).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setColorSchemeColors(0xFFFFCC00.toInt())
            setProgressBackgroundColorSchemeColor(0xFF1A1A1A.toInt())
            setOnRefreshListener { loadUrl() }
        }

        // WebView with aggressive performance settings
        webView = WebView(requireContext()).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(rootBackgroundColor)
        }
        applyWebViewSetup(webView!!)
        configureWebView(webView!!)
        swipeRefresh!!.addView(webView)
        layout.addView(swipeRefresh)

        // Progress bar drawn on top of the WebView at y=0 so it's visible while loading
        // without reserving layout space.
        layout.addView(progressBar)

        return layout
    }

    /**
     * Wire settings + WebViewClient + WebChromeClient onto a freshly-instantiated WebView.
     * Called from onCreateView for the initial WebView AND from onRenderProcessGone for
     * the recovery replacement WebView. Idempotent on a given WebView (don't call twice
     * on the same instance — subclass configureWebView() may not be idempotent).
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun applyWebViewSetup(target: WebView) {
        target.apply {
            settings.apply {
                // Essential settings
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true

                // Performance optimizations
                cacheMode = WebSettings.LOAD_DEFAULT // Use cache when possible
                setRenderPriority(WebSettings.RenderPriority.HIGH)

                // Enable hardware acceleration
                setLayerType(View.LAYER_TYPE_HARDWARE, null)

                // Reduce memory footprint
                loadsImagesAutomatically = true
                blockNetworkImage = false // Load images after page loads? Set true to test

                // Viewport settings
                loadWithOverviewMode = true
                useWideViewPort = true

                // Disable zoom for faster rendering
                builtInZoomControls = false
                displayZoomControls = false
                setSupportZoom(false)

                // Text settings
                minimumFontSize = 1
                minimumLogicalFontSize = 1

                // Mixed content (needed for some resources)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                }

                // Media settings
                mediaPlaybackRequiresUserGesture = false

                // Allow file access for local resources
                allowFileAccess = true
                allowContentAccess = true

                // Required for WebChromeClient.onCreateWindow to fire — otherwise
                // target=_blank / window.open() links silently no-op (or open in-place
                // depending on engine version), bypassing our external-link intercept.
                setSupportMultipleWindows(true)
                javaScriptCanOpenWindowsAutomatically = true
            }

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url ?: return false
                    if (openLinksExternally()) {
                        // User-gestured navigation (tap on a link) → external for any scheme
                        // the system can route (http/https/mailto/tel/sms/intent/etc.). Use a
                        // BLOCKLIST so future link types route correctly by default.
                        // SPA pushState/replaceState routing doesn't fire this callback (pure JS
                        // history API), so this won't break in-page presenter navigation.
                        val scheme = url.scheme?.lowercase()
                        val inWebViewSchemes = setOf("about", "data", "javascript", "blob", "file")
                        // Reload / pull-to-refresh / cache-bust reload fires
                        // shouldOverrideUrlLoading with hasGesture=true and the same
                        // origin+path as the current URL — possibly with a different
                        // query string (e.g. presenter's hard-reload button appends
                        // ?cachebust=<ts>) or fragment. Treat same origin+path as
                        // in-page navigation so reload preserves scroll + presenter
                        // state instead of bouncing to Chrome.
                        val currentUrl = view?.url
                        val isReload = currentUrl != null && stripQueryAndFragment(url.toString()) == stripQueryAndFragment(currentUrl)
                        if (request.hasGesture() && scheme != null && scheme !in inWebViewSchemes && !isReload) {
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, url))
                            } catch (e: Exception) {
                                Log.e(TAG, "Failed to open external link (gesture): $url", e)
                            }
                            return true
                        }
                        // Non-gesture cross-host nav (e.g. JS-triggered location change to
                        // another origin) → still external. Keeps the original intent symmetry.
                        // Same blocklist applies.
                        val pageHost = Uri.parse(getUrl()).host
                        if (url.host != null && url.host != pageHost && scheme != null && scheme !in inWebViewSchemes) {
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, url))
                            } catch (e: Exception) {
                                Log.e(TAG, "Failed to open external link (host-mismatch): $url", e)
                            }
                            return true
                        }
                    }
                    return super.shouldOverrideUrlLoading(view, request)
                }

                override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    loadStartTime = System.currentTimeMillis()
                    firstContentfulPaint = 0
                    domContentLoaded = 0
                    Log.d(TAG, "[${getTabName()}] Page load started: $url")
                    WedgeDiagLogger.log(context, "pageStarted", "${getTabName()} url=$url")
                    updatePerfText("Loading...")
                }

                override fun onPageCommitVisible(view: WebView?, url: String?) {
                    super.onPageCommitVisible(view, url)
                    firstContentfulPaint = System.currentTimeMillis()
                    val fcpTime = firstContentfulPaint - loadStartTime
                    Log.d(TAG, "[${getTabName()}] First Contentful Paint: ${fcpTime}ms")
                    updatePerfText("FCP: ${fcpTime}ms")
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    pageFinishedTime = System.currentTimeMillis()
                    val totalTime = pageFinishedTime - loadStartTime
                    val fcpTime = if (firstContentfulPaint > 0) firstContentfulPaint - loadStartTime else 0

                    Log.d(TAG, "[${getTabName()}] Page finished: ${totalTime}ms (FCP: ${fcpTime}ms)")
                    WedgeDiagLogger.log(context, "pageFinished", "${getTabName()} totalMs=$totalTime fcpMs=$fcpTime url=$url")
                    updatePerfText("Load: ${totalTime}ms | FCP: ${fcpTime}ms")

                    progressBar?.visibility = View.GONE
                    swipeRefresh?.isRefreshing = false

                    // Inject JS to get more performance metrics
                    injectPerformanceMonitoring(view)
                }

                override fun onReceivedError(
                    view: WebView?,
                    errorCode: Int,
                    description: String?,
                    failingUrl: String?
                ) {
                    Log.e(TAG, "[${getTabName()}] Error: $errorCode - $description")
                    WedgeDiagLogger.log(context, "receivedError", "${getTabName()} code=$errorCode desc=$description url=$failingUrl")
                    if (!onWebViewLoadError(errorCode, description, failingUrl)) {
                        val tailscaleHint = "\n\n⚠️ Check that Tailscale is on"
                        showError("Could not connect to ${getTabName()}\n\n$description$tailscaleHint")
                    }
                }

                override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                    val didCrash = detail?.didCrash() ?: false
                    val priority = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        detail?.rendererPriorityAtExit() ?: -1
                    } else -1
                    val tab = getTabName()
                    Log.e(TAG, "[$tab] RENDER PROCESS GONE — didCrash=$didCrash priority=$priority")
                    WedgeDiagLogger.log(
                        context,
                        "renderProcessGone",
                        "$tab didCrash=$didCrash priorityAtExit=$priority — attempting in-place recovery"
                    )

                    // Without this override, Android kills the entire host process when
                    // a WebView's render process dies. That's the wedge — nothing in-app
                    // recovers, only Settings → Force Stop. Detach the dead WebView from
                    // its parent, destroy it, build a fresh one, swap it in, reload.
                    return try {
                        val dead = view
                        val parent = dead?.parent as? ViewGroup
                        if (parent != null && dead != null) {
                            parent.removeView(dead)
                            dead.destroy()
                            val fresh = WebView(requireContext()).apply {
                                layoutParams = FrameLayout.LayoutParams(
                                    FrameLayout.LayoutParams.MATCH_PARENT,
                                    FrameLayout.LayoutParams.MATCH_PARENT
                                )
                                setBackgroundColor(rootBackgroundColor)
                            }
                            this@WebViewFragment.webView = fresh
                            applyWebViewSetup(fresh)
                            configureWebView(fresh)
                            parent.addView(fresh)
                            fresh.loadUrl(this@WebViewFragment.getUrl())
                            WedgeDiagLogger.log(context, "renderProcessGone.recovered", "$tab fresh WebView attached + loadUrl fired")
                        } else {
                            WedgeDiagLogger.log(context, "renderProcessGone.skipRecover", "$tab parent or view null")
                        }
                        true
                    } catch (e: Exception) {
                        Log.e(TAG, "[$tab] recovery failed", e)
                        WedgeDiagLogger.log(context, "renderProcessGone.recoverFailed", "$tab ${e.javaClass.simpleName}: ${e.message}")
                        // Returning true still prevents host-process kill; user will see
                        // a blank/error state and can swipe to refresh.
                        true
                    }
                }

                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    // Log resource requests for debugging
                    request?.url?.let { url ->
                        Log.v(TAG, "[${getTabName()}] Resource: ${url.host}${url.path}")
                    }
                    return super.shouldInterceptRequest(view, request)
                }
            }

            webChromeClient = object : WebChromeClient() {
                /**
                 * Intercept target=_blank links and window.open() calls. Without this override,
                 * such links bypass shouldOverrideUrlLoading entirely and either no-op or hijack
                 * the host WebView. We extract the destination via a throwaway WebView attached
                 * to the resulting Message's WebViewTransport, then fire an external Intent.
                 *
                 * Only intercepts when the host fragment opts into external linking.
                 */
                override fun onCreateWindow(
                    view: WebView?,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: android.os.Message?
                ): Boolean {
                    if (!openLinksExternally() || resultMsg == null || view == null) {
                        return super.onCreateWindow(view, isDialog, isUserGesture, resultMsg)
                    }
                    // Spin up a throwaway WebView purely to capture the target URL — its
                    // WebViewClient.shouldOverrideUrlLoading fires with the link that
                    // would have populated the new window. We never attach it to the view tree.
                    val href = WebView(view.context).apply {
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(
                                v: WebView?,
                                request: WebResourceRequest?
                            ): Boolean {
                                val url = request?.url ?: return true
                                try {
                                    startActivity(Intent(Intent.ACTION_VIEW, url))
                                } catch (e: Exception) {
                                    Log.e(TAG, "Failed to open external link (onCreateWindow): $url", e)
                                }
                                v?.destroy()
                                return true
                            }
                        }
                    }
                    (resultMsg.obj as? WebView.WebViewTransport)?.webView = href
                    resultMsg.sendToTarget()
                    return true
                }

                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    progressBar?.apply {
                        visibility = if (newProgress < 100) View.VISIBLE else View.GONE
                        progress = newProgress
                    }
                    if (newProgress > 0 && loadStartTime > 0) {
                        val elapsed = System.currentTimeMillis() - loadStartTime
                        Log.v(TAG, "[${getTabName()}] Progress: $newProgress% (${elapsed}ms)")
                    }
                }

                override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage?): Boolean {
                    consoleMessage?.let {
                        Log.d(TAG, "[${getTabName()}] Console: ${it.message()} (${it.sourceId()}:${it.lineNumber()})")
                        if (it.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) {
                            WedgeDiagLogger.log(context, "consoleError", "${getTabName()} ${it.message()} @ ${it.sourceId()}:${it.lineNumber()}")
                        }
                    }
                    return super.onConsoleMessage(consoleMessage)
                }
            }
        }
    }

    /** Override to customize WebView settings for specific fragments */
    protected open fun configureWebView(webView: WebView) {}

    /** Override to open clicked links in the system browser instead of in-app */
    protected open fun openLinksExternally(): Boolean = false

    private fun stripQueryAndFragment(url: String): String {
        val q = url.indexOf('?')
        val h = url.indexOf('#')
        val cut = when {
            q >= 0 && h >= 0 -> minOf(q, h)
            q >= 0 -> q
            h >= 0 -> h
            else -> -1
        }
        return if (cut >= 0) url.substring(0, cut) else url
    }

    private fun updatePerfText(text: String) {
        activity?.runOnUiThread {
            perfText?.apply {
                this.text = text
                visibility = View.VISIBLE
            }
        }
    }

    private fun injectPerformanceMonitoring(view: WebView?) {
        // Inject JS to extract browser performance metrics
        val js = """
            (function() {
                try {
                    var perf = window.performance;
                    if (perf && perf.timing) {
                        var t = perf.timing;
                        var metrics = {
                            dns: t.domainLookupEnd - t.domainLookupStart,
                            tcp: t.connectEnd - t.connectStart,
                            ttfb: t.responseStart - t.requestStart,
                            download: t.responseEnd - t.responseStart,
                            domParse: t.domInteractive - t.domLoading,
                            domReady: t.domContentLoadedEventEnd - t.navigationStart,
                            load: t.loadEventEnd - t.navigationStart
                        };
                        console.log('PERF_METRICS:' + JSON.stringify(metrics));
                        return JSON.stringify(metrics);
                    }
                } catch(e) {
                    console.log('Perf error: ' + e);
                }
                return null;
            })();
        """.trimIndent()

        view?.evaluateJavascript(js) { result ->
            if (result != null && result != "null") {
                Log.d(TAG, "[${getTabName()}] JS Performance: $result")
            }
        }
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        loadUrl()
    }

    fun loadUrl() {
        errorText?.visibility = View.GONE
        webView?.visibility = View.VISIBLE
        loadStartTime = System.currentTimeMillis()
        WedgeDiagLogger.log(context, "loadUrl", "${getTabName()} → ${getUrl()}")
        webView?.loadUrl(getUrl())
    }

    fun reload() {
        loadUrl()
    }

    protected fun showError(message: String) {
        swipeRefresh?.isRefreshing = false
        errorText?.apply {
            text = "$message\n\nTap to retry"
            visibility = View.VISIBLE
        }
        webView?.visibility = View.GONE
    }

    /**
     * Hook for subclasses to handle load errors with custom recovery UI.
     * Return true to suppress the default "Tap to retry" error text.
     * Default: false (use default error text).
     */
    protected open fun onWebViewLoadError(errorCode: Int, description: String?, failingUrl: String?): Boolean = false

    /**
     * Hide the error overlay and show the WebView (e.g. after a successful reconnect).
     */
    protected fun hideError() {
        errorText?.visibility = View.GONE
        webView?.visibility = View.VISIBLE
    }

    override fun onDestroyView() {
        WedgeDiagLogger.log(context, "fragmentDestroyView", getTabName())
        webView?.destroy()
        webView = null
        super.onDestroyView()
    }

    override fun onPause() {
        super.onPause()
        WedgeDiagLogger.log(context, "fragmentPause", getTabName())
    }

    override fun onResume() {
        super.onResume()
        WedgeDiagLogger.log(context, "fragmentResume", getTabName())
    }
}
