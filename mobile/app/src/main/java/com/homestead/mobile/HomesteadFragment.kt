package com.homestead.mobile

import android.util.Log

class HomesteadFragment : WebViewFragment() {

    companion object {
        private const val TAG = "HomesteadFragment"
        private const val HOMESTEAD_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net"
    }

    // Called from the web-view JS bridge when the user taps a "back to presenter" affordance.
    // MainActivity fulfils the fragment show/hide. Greenlit 2026-04-20.
    var onSwitchToPresenter: (() -> Unit)? = null

    override fun getUrl(): String = "$HOMESTEAD_URL?native=true"
    override fun getTabName(): String = "Homestead"

    override fun onViewCreated(view: android.view.View, savedInstanceState: android.os.Bundle?) {
        webView?.addJavascriptInterface(object {
            @android.webkit.JavascriptInterface
            fun switchToPresenter() {
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    onSwitchToPresenter?.invoke()
                }
            }
        }, "Android")
        super.onViewCreated(view, savedInstanceState)
    }

    /**
     * Get the current URL from the WebView.
     * Used to extract the active session name.
     */
    fun getCurrentUrl(): String? = webView?.url

    /**
     * Send text input to the Homestead WebView.
     * Uses the exposed window.Homestead.sendMessage() API which sends
     * via Socket.IO to the active tmux session.
     */
    fun sendTextInput(text: String) {
        val escapedText = text
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")

        // Use the exposed Homestead API to send message via Socket.IO
        val js = """
            (function() {
                try {
                    // Use the Homestead API exposed by VoiceRecorder
                    if (window.Homestead && window.Homestead.sendMessage) {
                        var result = window.Homestead.sendMessage("$escapedText");
                        console.log('Homestead Native: Sent via API, result:', result);
                        return result ? 'sent_api' : 'error_send_failed';
                    }

                    // Fallback: try __voiceRecorder
                    if (window.__voiceRecorder && window.__voiceRecorder.sendMessage) {
                        var result = window.__voiceRecorder.sendMessage("$escapedText");
                        console.log('Homestead Native: Sent via __voiceRecorder, result:', result);
                        return result ? 'sent_voicerecorder' : 'error_send_failed';
                    }

                    console.error('Homestead Native: No API available');
                    return 'error_no_api';
                } catch(e) {
                    console.error('Homestead Native: Error sending message:', e);
                    return 'error_' + e.message;
                }
            })();
        """.trimIndent()

        webView?.evaluateJavascript(js) { result ->
            Log.d(TAG, "sendTextInput result: $result")
        }
    }
}
