package com.homestead.mobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.TextView
import kotlinx.serialization.Serializable

class HomesteadAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "HomesteadA11y"

        @Volatile
        var instance: HomesteadAccessibilityService? = null
            private set

        fun isRunning(): Boolean = instance != null

        // Known dialer / phone-app packages whose foreground should surface the
        // record button. Google Phone + AOSP dialer cover Pixel (Josh's device)
        // and stock Android; the Samsung entry is a cheap safety net.
        private val DIALER_PACKAGES = setOf(
            "com.google.android.dialer",
            "com.android.dialer",
            "com.samsung.android.dialer",
            "com.android.incallui",
            "com.google.android.incallui"
        )
    }

    private val dp: Float
        get() = resources.displayMetrics.density

    // Overlay window state (record button shown over the dialer)
    private var overlayView: View? = null
    private var overlayShownForPackage: String? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.d(TAG, "Accessibility service connected")
    }

    override fun onDestroy() {
        super.onDestroy()
        removeRecordOverlay()
        instance = null
        Log.d(TAG, "Accessibility service destroyed")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Surface / hide the over-dialer record button as the foreground app changes.
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return

        // The raw event.packageName reflects whatever window just changed state —
        // during a call that's a firehose of TRANSIENT windows (heads-up notification
        // chips, system sub-windows, IME peeks, gesture-nav overlays). Reacting to the
        // raw package tore the button down on every blip, then re-added it on the next
        // real dialer event → the up/down/up/down flicker Josh saw.
        //
        // Instead, resolve the GENUINE foreground: the package of the actual active
        // window. Transient chips/toasts don't become the active window, so this is
        // stable across the mid-call event storm.
        val activePkg = rootInActiveWindow?.packageName?.toString()

        // A transient/unknown active window (null) is NOT a confident app switch —
        // leave the overlay exactly as it is rather than tearing it down.
        if (activePkg == null) return

        // Never react to system-ui window changes — the status bar / shade / nav
        // overlays are not a real foreground-app switch.
        if (activePkg == "com.android.systemui") return

        if (DIALER_PACKAGES.contains(activePkg)) {
            showRecordOverlay(activePkg)
        } else {
            // The genuinely-active window is a real, non-dialer app (including our own
            // app once we launch to record) → hide the button so it never floats over
            // the wrong screen. Because activePkg is the true active window and not a
            // transient blip, this fires only on a real switch away from the dialer.
            removeRecordOverlay()
        }
    }

    override fun onInterrupt() {
        Log.d(TAG, "Accessibility service interrupted")
    }

    // ── Over-the-dialer record button ─────────────────────────────────────────
    // Josh's ask: the record mic button (only that, not the other side buttons)
    // visible while the phone/dialer is up, so he can speaker-up a few seconds,
    // capture, and fire the note to Alfred. We host it on the accessibility
    // service's own overlay window (TYPE_ACCESSIBILITY_OVERLAY) so no separate
    // "draw over other apps" permission is needed — the a11y grant covers it.

    private fun showRecordOverlay(pkg: String) {
        if (overlayView != null) {
            overlayShownForPackage = pkg
            return
        }
        try {
            val wm = getSystemService(WINDOW_SERVICE) as WindowManager
            val size = (60 * dp).toInt()

            val button = FrameLayout(this).apply {
                val bg = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.parseColor("#FF6600"))
                    setStroke((2 * dp).toInt(), Color.parseColor("#1A1A1A"))
                }
                background = bg
                elevation = 10 * dp
            }
            val icon = TextView(this).apply {
                text = "🎤"  // 🎤
                textSize = 24f
                gravity = Gravity.CENTER
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            }
            button.addView(icon)
            button.setOnClickListener { onRecordOverlayTapped() }

            val params = WindowManager.LayoutParams(
                size, size,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
                x = (16 * dp).toInt()
            }

            wm.addView(button, params)
            overlayView = button
            overlayShownForPackage = pkg
            Log.d(TAG, "Record overlay shown over $pkg")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to show record overlay: ${e.message}", e)
        }
    }

    private fun removeRecordOverlay() {
        val view = overlayView ?: return
        try {
            val wm = getSystemService(WINDOW_SERVICE) as WindowManager
            wm.removeView(view)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to remove record overlay: ${e.message}")
        }
        overlayView = null
        overlayShownForPackage = null
    }

    /**
     * Overlay button tapped: capture WHO the call is with (from the still-foreground
     * dialer), then hand off to MainActivity which owns the record → pick → send
     * pipeline. Capturing WHO here (dialer in front) is more reliable than after
     * we've switched to our own activity.
     */
    private fun onRecordOverlayTapped() {
        val who = try { detectCallContact() } catch (e: Exception) {
            Log.w(TAG, "WHO detection failed: ${e.message}"); null
        }
        Log.d(TAG, "Record overlay tapped — who=$who")

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_START_RECORDING_FROM_DIALER, true)
            if (!who.isNullOrBlank()) putExtra(MainActivity.EXTRA_PHONE_CALL_WHO, who)
        }
        startActivity(intent)
    }

    /**
     * Part 2b — WHO the call is with. Scrapes the foreground dialer's in-call UI
     * accessibility tree for a contact name or phone number. Vendor UIs differ, so
     * we take the best candidate: prefer a non-numeric contact-name node, fall back
     * to a phone-number node, and (in MainActivity) a number can be resolved to a
     * saved contact name via ContactsContract. Returns null if nothing usable —
     * the phone-note tag then degrades gracefully to the plain Part-2a form.
     */
    fun detectCallContact(): String? {
        val root = rootInActiveWindow ?: return null
        val pkg = root.packageName?.toString()
        if (pkg == null || !DIALER_PACKAGES.contains(pkg)) return null

        val texts = mutableListOf<String>()
        collectTexts(root, texts)

        // In-call screens show status words we never want as the "who".
        val junk = setOf(
            "mobile", "home", "work", "speaker", "mute", "keypad", "hold",
            "add call", "video", "bluetooth", "end", "end call", "answer",
            "decline", "dialpad", "contacts", "recents", "voicemail",
            "calling", "ringing", "on hold", "call ended", "incoming call",
            "outgoing call", "00:00"
        )

        // Prefer a real contact name: has letters, not a duration, not junk.
        val nameCandidate = texts.firstOrNull { t ->
            val low = t.trim().lowercase()
            t.length in 2..40 &&
                t.any { it.isLetter() } &&
                !junk.contains(low) &&
                !low.matches(Regex("^\\d{1,2}:\\d{2}(:\\d{2})?$")) &&   // call timer
                !low.startsWith("calling") &&
                !low.contains("swipe")
        }
        if (nameCandidate != null) return nameCandidate.trim()

        // Fall back to a phone-number-looking node.
        val numberCandidate = texts.firstOrNull { t ->
            val digits = t.count { it.isDigit() }
            digits >= 7 && t.all { it.isDigit() || it in "+()- ." }
        }
        return numberCandidate?.trim()
    }

    private fun collectTexts(node: AccessibilityNodeInfo, out: MutableList<String>) {
        node.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                collectTexts(child, out)
                child.recycle()
            }
        }
    }

    // Tap at specific coordinates
    fun tap(x: Float, y: Float, callback: ((Boolean) -> Unit)? = null) {
        Log.d(TAG, "Tapping at ($x, $y)")

        val path = Path().apply {
            moveTo(x, y)
        }

        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 100))
            .build()

        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                Log.d(TAG, "Tap completed")
                callback?.invoke(true)
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
                Log.d(TAG, "Tap cancelled")
                callback?.invoke(false)
            }
        }, null)
    }

    // Swipe from one point to another
    fun swipe(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long = 300, callback: ((Boolean) -> Unit)? = null) {
        Log.d(TAG, "Swiping from ($startX, $startY) to ($endX, $endY)")

        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }

        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()

        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                Log.d(TAG, "Swipe completed")
                callback?.invoke(true)
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
                Log.d(TAG, "Swipe cancelled")
                callback?.invoke(false)
            }
        }, null)
    }

    // Long press at coordinates
    fun longPress(x: Float, y: Float, durationMs: Long = 1000, callback: ((Boolean) -> Unit)? = null) {
        Log.d(TAG, "Long pressing at ($x, $y) for ${durationMs}ms")

        val path = Path().apply {
            moveTo(x, y)
        }

        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()

        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                callback?.invoke(true)
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
                callback?.invoke(false)
            }
        }, null)
    }

    // Get screen content as a tree structure
    fun getScreenContent(): ScreenContent {
        val root = rootInActiveWindow ?: return ScreenContent(nodes = emptyList(), packageName = null)

        val nodes = mutableListOf<ScreenNode>()
        traverseNode(root, nodes, 0)

        return ScreenContent(
            nodes = nodes,
            packageName = root.packageName?.toString()
        )
    }

    private fun traverseNode(node: AccessibilityNodeInfo, nodes: MutableList<ScreenNode>, depth: Int) {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)

        val screenNode = ScreenNode(
            className = node.className?.toString() ?: "",
            text = node.text?.toString(),
            contentDescription = node.contentDescription?.toString(),
            resourceId = node.viewIdResourceName,
            bounds = BoundsInfo(bounds.left, bounds.top, bounds.right, bounds.bottom),
            isClickable = node.isClickable,
            isScrollable = node.isScrollable,
            isEditable = node.isEditable,
            isChecked = node.isChecked,
            isEnabled = node.isEnabled,
            depth = depth
        )

        // Only add nodes that have some useful info
        if (screenNode.text != null ||
            screenNode.contentDescription != null ||
            screenNode.isClickable ||
            screenNode.isScrollable ||
            screenNode.resourceId != null) {
            nodes.add(screenNode)
        }

        // Traverse children
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                traverseNode(child, nodes, depth + 1)
                child.recycle()
            }
        }
    }

    // Find and click element by text
    fun clickByText(text: String, exact: Boolean = false): Boolean {
        val root = rootInActiveWindow ?: return false

        val nodes = if (exact) {
            root.findAccessibilityNodeInfosByText(text)
        } else {
            root.findAccessibilityNodeInfosByText(text)
        }

        for (node in nodes) {
            val nodeText = node.text?.toString() ?: node.contentDescription?.toString() ?: ""
            val matches = if (exact) {
                nodeText.equals(text, ignoreCase = true)
            } else {
                nodeText.contains(text, ignoreCase = true)
            }

            if (matches) {
                // Try to click this node or its clickable parent
                var current: AccessibilityNodeInfo? = node
                while (current != null) {
                    if (current.isClickable) {
                        val result = current.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                        Log.d(TAG, "Clicked on '$text': $result")
                        return result
                    }
                    current = current.parent
                }

                // If no clickable parent, try tapping the center of the node
                val bounds = Rect()
                node.getBoundsInScreen(bounds)
                val centerX = (bounds.left + bounds.right) / 2f
                val centerY = (bounds.top + bounds.bottom) / 2f

                tap(centerX, centerY)
                return true
            }
        }

        Log.d(TAG, "No element found with text: $text")
        return false
    }

    // Find and click element by resource ID
    fun clickById(resourceId: String): Boolean {
        val root = rootInActiveWindow ?: return false

        val nodes = root.findAccessibilityNodeInfosByViewId(resourceId)
        if (nodes.isNotEmpty()) {
            val node = nodes[0]

            // Try direct click
            if (node.isClickable) {
                return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }

            // Try tapping center
            val bounds = Rect()
            node.getBoundsInScreen(bounds)
            tap((bounds.left + bounds.right) / 2f, (bounds.top + bounds.bottom) / 2f)
            return true
        }

        return false
    }

    // Press back button
    fun pressBack(): Boolean {
        return performGlobalAction(GLOBAL_ACTION_BACK)
    }

    // Press home button
    fun pressHome(): Boolean {
        return performGlobalAction(GLOBAL_ACTION_HOME)
    }

    // Open recents/app switcher
    fun pressRecents(): Boolean {
        return performGlobalAction(GLOBAL_ACTION_RECENTS)
    }

    // Open notifications
    fun openNotifications(): Boolean {
        return performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
    }

    // Open quick settings
    fun openQuickSettings(): Boolean {
        return performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
    }

    // Take screenshot (Android 9+)
    fun takeScreenshot(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            performGlobalAction(GLOBAL_ACTION_TAKE_SCREENSHOT)
        } else {
            false
        }
    }

    // Input text into focused field
    fun inputText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false

        val arguments = android.os.Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }

        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
    }
}

// Data classes for screen content
@Serializable
data class ScreenContent(
    val nodes: List<ScreenNode>,
    val packageName: String?
)

@Serializable
data class ScreenNode(
    val className: String,
    val text: String?,
    val contentDescription: String?,
    val resourceId: String?,
    val bounds: BoundsInfo,
    val isClickable: Boolean,
    val isScrollable: Boolean,
    val isEditable: Boolean,
    val isChecked: Boolean,
    val isEnabled: Boolean,
    val depth: Int
)

@Serializable
data class BoundsInfo(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int
)
