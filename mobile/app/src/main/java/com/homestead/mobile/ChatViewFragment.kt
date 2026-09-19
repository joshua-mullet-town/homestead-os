package com.homestead.mobile

import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.core.content.res.ResourcesCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit
import io.noties.markwon.Markwon
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin

/**
 * ChatViewFragment - Shows conversation history for a session.
 *
 * Displays chat messages from the conversation.json log file.
 * Includes a session switcher bar at the bottom.
 */
class ChatViewFragment : Fragment() {

    companion object {
        private const val TAG = "ChatViewFragment"
        private const val BASE_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net"
        private const val POLL_INTERVAL_MS = 3000L
    }

    // Homestead theme colors
    private val colorAmber = Color.parseColor("#FFBF00")
    private val colorOrange = Color.parseColor("#FF6600")
    private val colorDarkBg = Color.parseColor("#0D0D0D")
    private val colorSurface = Color.parseColor("#1A1A1A")
    private val colorUserBubble = Color.parseColor("#1E3A5F")
    private val colorAssistantBubble = Color.parseColor("#2A2A2A")
    private val colorTextPrimary = Color.parseColor("#FFFFFF")
    private val colorTextSecondary = Color.parseColor("#888888")
    private val colorCyan = Color.parseColor("#00CCFF")

    private lateinit var rootLayout: LinearLayout
    private lateinit var headerText: TextView
    private lateinit var messagesContainer: LinearLayout
    private lateinit var scrollView: ScrollView
    private lateinit var sessionSwitcherBar: HorizontalScrollView
    private lateinit var sessionButtonsContainer: LinearLayout
    private lateinit var scrollToBottomButton: Button

    private var currentSessionName: String? = null
    private var pendingSessionName: String? = null
    private var viewsInitialized = false
    private var messages: List<ChatMessage> = emptyList()
    private var allSessions: List<SessionsFragment.SessionInfo> = emptyList()

    // Fonts
    private var fontHeader: Typeface? = null
    private var fontBody: Typeface? = null
    private var fontBodyMedium: Typeface? = null
    private var fontMono: Typeface? = null

    // Font size (persisted)
    private var messageFontSize: Float = 15f
    private val PREFS_NAME = "chat_view_prefs"
    private val KEY_FONT_SIZE = "font_size"

    var onSessionSwitch: ((String) -> Unit)? = null
    var onBackPressed: (() -> Unit)? = null
    var getSessionsProvider: (() -> List<SessionsFragment.SessionInfo>)? = null

    private val pollHandler = Handler(Looper.getMainLooper())
    private val pollRunnable = object : Runnable {
        override fun run() {
            loadMessages()
            pollHandler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private lateinit var markwon: Markwon

    data class ChatMessage(
        val role: String,
        val content: String,
        val timestamp: String?
    )

    data class ToolEntry(
        val name: String,
        val message: String
    )

    data class ExchangeActivity(
        val tools: List<ToolEntry>,
        val toolCount: Int
    )

    // Activity data: per-exchange tool usage
    private var exchangeActivities: List<ExchangeActivity> = emptyList()
    private var isAgentWorking = false
    private var currentAgentTool: String? = null

    // Session status data (from claude-sessions API)
    private var sessionStatuses: Map<String, String> = emptyMap()  // tmuxSession -> status

    // TTS playback
    private var mediaPlayer: MediaPlayer? = null
    private var currentlyPlayingIndex: Int = -1  // index into messages list
    private var ttsAutoPlay: Boolean = false
    private var lastAutoPlayedIndex: Int = -1  // prevent re-autoplay on poll rebuild
    private val TTS_PREFS = "tts_prefs"
    private val KEY_AUTOPLAY = "autoplay"

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        // Load fonts
        val spaceGrotesk = ResourcesCompat.getFont(requireContext(), R.font.space_grotesk_variable)
        fontHeader = Typeface.create(spaceGrotesk, Typeface.BOLD)
        fontBody = ResourcesCompat.getFont(requireContext(), R.font.inter_regular)
        fontBodyMedium = ResourcesCompat.getFont(requireContext(), R.font.inter_medium)
        fontMono = ResourcesCompat.getFont(requireContext(), R.font.jetbrains_mono_regular)

        rootLayout = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(colorDarkBg)
        }

        // Header (extra top padding for edge-to-edge status bar)
        val header = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(colorSurface)
            setPadding(16, 40, 24, 12)
            gravity = Gravity.CENTER_VERTICAL
        }

        // Back button
        val backButton = Button(requireContext()).apply {
            text = "‹"
            setTextColor(colorAmber)
            setBackgroundColor(Color.TRANSPARENT)
            textSize = 28f
            setPadding(16, 0, 16, 0)
            setOnClickListener { onBackPressed?.invoke() }
        }
        header.addView(backButton)

        headerText = TextView(requireContext()).apply {
            text = "Chat"
            setTextColor(colorTextPrimary)
            textSize = 20f
            typeface = fontHeader
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        header.addView(headerText)

        // Hamburger menu button
        val menuButton = Button(requireContext()).apply {
            text = "☰"
            setTextColor(colorAmber)
            setBackgroundColor(Color.TRANSPARENT)
            textSize = 24f
            setPadding(16, 0, 16, 0)
            setOnClickListener { showSettingsMenu() }
        }
        header.addView(menuButton)

        rootLayout.addView(header)

        // Container for scroll view + floating button
        val scrollContainer = android.widget.FrameLayout(requireContext()).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        // Messages scroll view
        scrollView = ScrollView(requireContext()).apply {
            layoutParams = android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        messagesContainer = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(16, 16, 16, 16)
        }
        scrollView.addView(messagesContainer)
        scrollContainer.addView(scrollView)

        // Scroll to bottom button (floating)
        scrollToBottomButton = Button(requireContext()).apply {
            text = "↓"
            setTextColor(colorDarkBg)
            setBackgroundColor(colorAmber)
            textSize = 20f
            val size = 56
            val params = android.widget.FrameLayout.LayoutParams(
                (size * resources.displayMetrics.density).toInt(),
                (size * resources.displayMetrics.density).toInt()
            )
            params.gravity = Gravity.BOTTOM or Gravity.END
            params.setMargins(0, 0, 32, 32)
            layoutParams = params
            visibility = View.GONE  // Hidden by default
            setOnClickListener { scrollToBottom() }
        }
        scrollContainer.addView(scrollToBottomButton)

        // Listen for scroll changes to show/hide the button
        scrollView.viewTreeObserver.addOnScrollChangedListener {
            updateScrollButtonVisibility()
        }

        rootLayout.addView(scrollContainer)

        // Session switcher bar
        sessionSwitcherBar = HorizontalScrollView(requireContext()).apply {
            setBackgroundColor(colorSurface)
            isHorizontalScrollBarEnabled = false
        }

        sessionButtonsContainer = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(8, 8, 8, 8)
        }
        sessionSwitcherBar.addView(sessionButtonsContainer)
        rootLayout.addView(sessionSwitcherBar)

        viewsInitialized = true

        // Apply any session that was set before views were created
        pendingSessionName?.let { name ->
            pendingSessionName = null
            setSession(name)
        }

        return rootLayout
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Load saved font size
        val prefs = requireContext().getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
        messageFontSize = prefs.getFloat(KEY_FONT_SIZE, 15f)

        // Initialize Markwon for markdown rendering
        markwon = Markwon.builder(requireContext())
            .usePlugin(StrikethroughPlugin.create())
            .usePlugin(TablePlugin.create(requireContext()))
            .build()

        // Load TTS autoplay preference
        val ttsPrefs = requireContext().getSharedPreferences(TTS_PREFS, android.content.Context.MODE_PRIVATE)
        ttsAutoPlay = ttsPrefs.getBoolean(KEY_AUTOPLAY, false)
    }

    override fun onResume() {
        super.onResume()
        // Start polling for new messages
        pollHandler.post(pollRunnable)
        // Refresh session switcher
        getSessionsProvider?.invoke()?.let { setSessions(it) }
    }

    override fun onPause() {
        super.onPause()
        // Stop polling
        pollHandler.removeCallbacks(pollRunnable)
        // Stop any playing audio
        stopTtsPlayback()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        mediaPlayer?.release()
        mediaPlayer = null
    }

    fun setSession(sessionName: String) {
        if (!viewsInitialized) {
            pendingSessionName = sessionName
            currentSessionName = sessionName
            return
        }
        currentSessionName = sessionName
        headerText.text = formatSessionName(sessionName)
        // Clear existing messages and mark as initial load
        messages = emptyList()
        isInitialLoad = true
        messagesContainer.removeAllViews()
        loadMessages()
        updateSessionSwitcher()  // Update highlight when session changes
    }

    fun setSessions(sessions: List<SessionsFragment.SessionInfo>) {
        allSessions = sessions
        if (viewsInitialized) {
            updateSessionSwitcher()
        }
    }

    private fun formatSessionName(name: String): String {
        // Convert holler-project--branch to "project (branch)"
        val withoutPrefix = name.removePrefix("holler-")
        val parts = withoutPrefix.split("--")
        return if (parts.size > 1) {
            "${parts[0]} (${parts[1]})"
        } else {
            parts[0]
        }
    }

    private fun extractProjectFromSession(sessionName: String): String {
        // Extract project name: "holler-homestead--mobile-app" -> "homestead"
        val withoutPrefix = sessionName.removePrefix("holler-")
        return withoutPrefix.split("--").firstOrNull() ?: withoutPrefix
    }

    private var isInitialLoad = true

    private fun loadMessages() {
        val sessionName = currentSessionName ?: return
        Log.d(TAG, "loadMessages called for session: $sessionName")

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val fetchedMessages = fetchMessages(sessionName)
                val fetchedActivities = fetchActivities(sessionName)
                val fetchedStatuses = fetchSessionStatuses()
                Log.d(TAG, "Fetched ${fetchedMessages.size} messages, ${fetchedActivities.first.size} activities, working=${fetchedActivities.second}")

                fun isSameMessage(a: ChatMessage, b: ChatMessage) = a.role == b.role && a.content == b.content

                val messagesChanged = fetchedMessages.size != messages.size ||
                    (fetchedMessages.isNotEmpty() && messages.isNotEmpty() &&
                     (!isSameMessage(fetchedMessages.first(), messages.first()) ||
                      !isSameMessage(fetchedMessages.last(), messages.last())))

                val activitiesChanged = fetchedActivities.first.size != exchangeActivities.size ||
                    fetchedActivities.second != isAgentWorking ||
                    fetchedActivities.third != currentAgentTool

                val statusesChanged = fetchedStatuses != sessionStatuses

                if (messagesChanged) {
                    Log.d(TAG, "Messages changed - full rebuild")
                    val shouldScrollToBottom = isInitialLoad
                    isInitialLoad = false
                    messages = fetchedMessages
                    exchangeActivities = fetchedActivities.first
                    isAgentWorking = fetchedActivities.second
                    currentAgentTool = fetchedActivities.third
                    if (statusesChanged) sessionStatuses = fetchedStatuses
                    withContext(Dispatchers.Main) {
                        displayMessages(scrollToNewest = shouldScrollToBottom)
                        if (statusesChanged) updateSessionSwitcher()
                    }
                } else if (activitiesChanged || statusesChanged) {
                    Log.d(TAG, "Activities/status changed - lightweight update")
                    exchangeActivities = fetchedActivities.first
                    isAgentWorking = fetchedActivities.second
                    currentAgentTool = fetchedActivities.third
                    if (statusesChanged) sessionStatuses = fetchedStatuses
                    withContext(Dispatchers.Main) {
                        if (statusesChanged) updateSessionSwitcher()
                        // No full rebuild — just note the state for next full rebuild
                    }
                } else {
                    Log.d(TAG, "No changes detected - skipping rebuild")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load messages: ${e.message}", e)
            }
        }
    }

    private suspend fun fetchMessages(sessionName: String): List<ChatMessage> = withContext(Dispatchers.IO) {
        try {
            // Extract project from session name (e.g., "holler-homestead--mobile-app" -> "homestead")
            val project = extractProjectFromSession(sessionName)
            val request = Request.Builder()
                .url("$BASE_URL/api/chat-messages/$project?session=$sessionName")
                .get()
                .build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: return@withContext emptyList()
            Log.d(TAG, "API response: ${body.take(500)}")

            val jsonObject = JSONObject(body)
            val messagesArray = jsonObject.optJSONArray("messages") ?: return@withContext emptyList()
            Log.d(TAG, "Found ${messagesArray.length()} messages in response")

            val result = mutableListOf<ChatMessage>()
            for (i in 0 until messagesArray.length()) {
                val msg = messagesArray.getJSONObject(i)
                result.add(ChatMessage(
                    role = msg.optString("role", "user"),
                    content = msg.optString("content", ""),
                    timestamp = if (msg.has("timestamp")) msg.getString("timestamp") else null
                ))
            }
            result
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching messages: ${e.message}")
            emptyList()
        }
    }

    private data class ActivityResult(
        val first: List<ExchangeActivity>,
        val second: Boolean,  // isWorking
        val third: String?    // currentTool
    )

    private suspend fun fetchActivities(sessionName: String): ActivityResult = withContext(Dispatchers.IO) {
        try {
            val project = extractProjectFromSession(sessionName)
            val request = Request.Builder()
                .url("$BASE_URL/api/chat-messages/$project/activities?session=$sessionName")
                .get()
                .build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: return@withContext ActivityResult(emptyList(), false, null)

            val json = JSONObject(body)
            val working = json.optBoolean("is_working", false)
            val tool = if (json.isNull("current_tool")) null else json.optString("current_tool", null)
            val exchangesArray = json.optJSONArray("exchanges") ?: return@withContext ActivityResult(emptyList(), working, tool)

            val result = mutableListOf<ExchangeActivity>()
            for (i in 0 until exchangesArray.length()) {
                val exchange = exchangesArray.getJSONObject(i)
                val toolsArray = exchange.optJSONArray("tools") ?: JSONArray()
                val tools = mutableListOf<ToolEntry>()
                for (j in 0 until toolsArray.length()) {
                    val t = toolsArray.getJSONObject(j)
                    tools.add(ToolEntry(
                        name = t.optString("name", ""),
                        message = t.optString("message", "")
                    ))
                }
                result.add(ExchangeActivity(
                    tools = tools,
                    toolCount = exchange.optInt("tool_count", 0)
                ))
            }
            ActivityResult(result, working, tool)
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching activities: ${e.message}")
            ActivityResult(emptyList(), false, null)
        }
    }

    private fun getStatusColor(status: String): Int {
        return when (status) {
            "working" -> Color.parseColor("#FFCC00")
            "waiting" -> Color.parseColor("#00FF66")
            "terminated" -> Color.parseColor("#FF3333")
            "interrupted" -> Color.parseColor("#FF6633")
            else -> Color.parseColor("#666666")
        }
    }

    private suspend fun fetchSessionStatuses(): Map<String, String> = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("$BASE_URL/api/claude-sessions?raw=true")
                .get()
                .build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: return@withContext emptyMap()
            val json = JSONObject(body)
            val sessionsArray = json.optJSONArray("sessions") ?: return@withContext emptyMap()

            val result = mutableMapOf<String, String>()
            for (i in 0 until sessionsArray.length()) {
                val session = sessionsArray.getJSONObject(i)
                val tmuxSession = session.optString("tmuxSession", "")
                val status = session.optString("status", "idle")
                if (tmuxSession.isNotEmpty()) {
                    result[tmuxSession] = status
                }
            }
            result
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching session statuses: ${e.message}")
            emptyMap()
        }
    }

    private fun displayMessages(scrollToNewest: Boolean = true) {
        // Check if user was near the bottom before rebuilding
        val savedScrollY = scrollView.scrollY
        val oldMaxScroll = messagesContainer.height - scrollView.height
        val wasNearBottom = oldMaxScroll <= 0 || (oldMaxScroll - savedScrollY) < 300

        messagesContainer.removeAllViews()

        if (messages.isEmpty()) {
            val emptyText = TextView(requireContext()).apply {
                text = "No messages yet"
                setTextColor(colorTextSecondary)
                textSize = 14f
                gravity = Gravity.CENTER
                setPadding(0, 48, 0, 0)
            }
            messagesContainer.addView(emptyText)
            return
        }

        // Messages in chronological order (oldest first, newest at bottom)
        // Insert activity bubbles between user→assistant pairs
        //
        // Alignment: conversation.json may have fewer exchanges than the transcript.
        // The activity API returns the last N exchanges from the transcript.
        // We need to align them so the LAST activity exchange matches the LAST chat exchange.
        val chatExchangeCount = messages.count { it.role == "user" }
        val activityOffset = (exchangeActivities.size - chatExchangeCount).coerceAtLeast(0)

        var exchangeIdx = 0
        for (i in messages.indices) {
            val msg = messages[i]
            messagesContainer.addView(createMessageBubble(msg, i))

            // After a user message, insert the activity bubble for this exchange
            if (msg.role == "user") {
                val activityIdx = exchangeIdx + activityOffset
                val activity = exchangeActivities.getOrNull(activityIdx)
                val isLastExchange = activityIdx == exchangeActivities.size - 1 ||
                    (activityIdx >= exchangeActivities.size)
                val showSpinner = isLastExchange && isAgentWorking

                if (activity != null && activity.toolCount > 0) {
                    messagesContainer.addView(createActivityBubble(activity, showSpinner))
                } else if (showSpinner) {
                    messagesContainer.addView(createActivityBubble(null, true))
                }
                exchangeIdx++
            }
        }

        // If agent is working and last message was assistant (or no messages),
        // show a working indicator at the bottom
        if (isAgentWorking && (messages.isEmpty() || messages.last().role == "assistant")) {
            messagesContainer.addView(createActivityBubble(null, true))
        }

        // Scroll after layout settles. Use postDelayed to ensure all child views
        // (including markdown-rendered TextViews) have fully measured.
        // Double-tap: first attempt after layout, second after images/markdown finish rendering.
        scrollView.postDelayed({
            if (!isAdded) return@postDelayed
            scrollToPosition(scrollToNewest, wasNearBottom, savedScrollY)
        }, 150)
        if (scrollToNewest) {
            scrollView.postDelayed({
                if (!isAdded) return@postDelayed
                scrollToPosition(true, wasNearBottom, savedScrollY)
            }, 500)
        }

        // Autoplay TTS for the last assistant message if enabled
        if (ttsAutoPlay && messages.isNotEmpty()) {
            val lastIndex = messages.size - 1
            val lastMsg = messages[lastIndex]
            if (lastMsg.role == "assistant" && lastIndex > lastAutoPlayedIndex && !isAgentWorking) {
                lastAutoPlayedIndex = lastIndex
                // Small delay so the UI has rendered the button
                scrollView.postDelayed({
                    if (!isAdded) return@postDelayed
                    // Find the listen button in the last message container and trigger it
                    val lastContainer = messagesContainer.getChildAt(messagesContainer.childCount - 1)
                        ?: return@postDelayed
                    // The TTS controls row is inside the message container
                    if (lastContainer is LinearLayout) {
                        for (j in 0 until lastContainer.childCount) {
                            val child = lastContainer.getChildAt(j)
                            if (child is LinearLayout && child.childCount >= 1) {
                                val firstChild = child.getChildAt(0)
                                if (firstChild is TextView && firstChild.text.toString().contains("Listen")) {
                                    firstChild.performClick()
                                    break
                                }
                            }
                        }
                    }
                }, 500)
            }
        }
    }

    /**
     * Scroll to the appropriate position based on context.
     * Uses the last child's bottom to compute the true scroll extent,
     * and smoothScrollBy for butter-smooth animation.
     */
    private fun scrollToPosition(jumpToBottom: Boolean, wasNearBottom: Boolean, savedScrollY: Int) {
        val lastChild = messagesContainer.getChildAt(messagesContainer.childCount - 1) ?: return
        val bottom = lastChild.bottom + messagesContainer.paddingBottom
        val scrollMax = bottom - scrollView.height
        if (scrollMax <= 0) return

        if (jumpToBottom) {
            // Initial load or session switch: jump instantly
            scrollView.scrollTo(0, scrollMax)
        } else if (wasNearBottom) {
            // User was near bottom — smooth glide to new content
            val delta = scrollMax - scrollView.scrollY
            if (delta > 0) {
                scrollView.smoothScrollBy(0, delta)
            }
        } else {
            // User scrolled up — stay put
            scrollView.scrollTo(0, savedScrollY)
        }
    }

    private fun stopTtsPlayback() {
        try {
            mediaPlayer?.apply {
                if (isPlaying) stop()
                reset()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping TTS: ${e.message}")
        }
        currentlyPlayingIndex = -1
    }

    private fun playTtsForMessage(messageIndex: Int, text: String, button: TextView, restartBtn: TextView?) {
        val isCurrentlyPlaying = currentlyPlayingIndex == messageIndex && mediaPlayer?.isPlaying == true
        val isCurrentlyPaused = currentlyPlayingIndex == messageIndex && mediaPlayer != null && mediaPlayer?.isPlaying == false

        if (isCurrentlyPlaying) {
            // Pause
            mediaPlayer?.pause()
            button.text = "\u25B6  Resume"
            return
        }

        if (isCurrentlyPaused) {
            // Resume
            try {
                mediaPlayer?.start()
                button.text = "\u23F8  Pause"
                return
            } catch (e: Exception) {
                // Fall through to fresh play
            }
        }

        // Stop any existing playback
        stopTtsPlayback()

        // Start loading
        button.text = "\u231B  Loading..."
        button.isEnabled = false
        currentlyPlayingIndex = messageIndex

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val audioFile = withContext(Dispatchers.IO) {
                    val bodyJson = JSONObject().apply {
                        put("text", text.take(5000))
                        put("voice", "en-US-AndrewNeural")
                    }
                    val request = Request.Builder()
                        .url("$BASE_URL/api/tts")
                        .post(bodyJson.toString().toRequestBody("application/json".toMediaTypeOrNull()))
                        .build()

                    val response = client.newCall(request).execute()
                    if (!response.isSuccessful) throw Exception("TTS API error: ${response.code}")

                    val bytes = response.body?.bytes() ?: throw Exception("Empty TTS response")
                    val tempFile = File(requireContext().cacheDir, "tts-${messageIndex}.mp3")
                    FileOutputStream(tempFile).use { it.write(bytes) }
                    tempFile
                }

                withContext(Dispatchers.Main) {
                    if (!isAdded || currentlyPlayingIndex != messageIndex) return@withContext

                    mediaPlayer?.release()
                    mediaPlayer = MediaPlayer().apply {
                        setDataSource(audioFile.absolutePath)
                        prepare()
                        setOnCompletionListener {
                            button.text = "\uD83D\uDD0A  Listen"
                            restartBtn?.visibility = View.VISIBLE
                            currentlyPlayingIndex = -1
                        }
                        setOnErrorListener { _, _, _ ->
                            button.text = "\u26A0  Error"
                            button.isEnabled = true
                            currentlyPlayingIndex = -1
                            true
                        }
                        start()
                    }
                    button.text = "\u23F8  Pause"
                    button.isEnabled = true
                    restartBtn?.visibility = View.VISIBLE
                }
            } catch (e: Exception) {
                Log.e(TAG, "TTS playback failed: ${e.message}", e)
                withContext(Dispatchers.Main) {
                    if (!isAdded) return@withContext
                    button.text = "\u26A0  Failed"
                    button.isEnabled = true
                    currentlyPlayingIndex = -1
                }
            }
        }
    }

    private fun createTtsControls(messageIndex: Int, messageText: String): View {
        val dp = resources.displayMetrics.density
        val controlsRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setPadding(20, (6 * dp).toInt(), 20, (4 * dp).toInt())
        }

        val btnBg = GradientDrawable().apply {
            setColor(Color.parseColor("#0D2233"))
            cornerRadius = 6f * dp
        }

        val listenBtn = TextView(requireContext())
        listenBtn.text = "\uD83D\uDD0A  Listen"
        listenBtn.textSize = 12f
        listenBtn.setTextColor(colorCyan)
        listenBtn.typeface = fontMono ?: Typeface.MONOSPACE
        listenBtn.background = btnBg.constantState?.newDrawable()?.mutate()
        listenBtn.setPadding((10 * dp).toInt(), (5 * dp).toInt(), (10 * dp).toInt(), (5 * dp).toInt())
        listenBtn.isClickable = true
        listenBtn.isFocusable = true

        val restartBtnBg = GradientDrawable().apply {
            setColor(Color.parseColor("#0D2233"))
            cornerRadius = 6f * dp
        }
        val restartBtn = TextView(requireContext())
        restartBtn.text = "\u21BB"
        restartBtn.textSize = 12f
        restartBtn.setTextColor(colorCyan)
        restartBtn.typeface = fontMono ?: Typeface.MONOSPACE
        restartBtn.background = restartBtnBg
        restartBtn.setPadding((8 * dp).toInt(), (5 * dp).toInt(), (8 * dp).toInt(), (5 * dp).toInt())
        restartBtn.visibility = View.GONE
        restartBtn.isClickable = true
        restartBtn.isFocusable = true
        val restartParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
        restartParams.marginStart = (6 * dp).toInt()
        restartBtn.layoutParams = restartParams

        listenBtn.setOnClickListener {
            playTtsForMessage(messageIndex, messageText, listenBtn, restartBtn)
        }
        restartBtn.setOnClickListener {
            stopTtsPlayback()
            playTtsForMessage(messageIndex, messageText, listenBtn, restartBtn)
        }

        controlsRow.addView(listenBtn)
        controlsRow.addView(restartBtn)

        return controlsRow
    }

    private fun createMessageBubble(message: ChatMessage, messageIndex: Int): View {
        val isUser = message.role == "user"

        val container = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            params.setMargins(0, 16, 0, 16)  // More vertical spacing between messages
            layoutParams = params
            gravity = if (isUser) Gravity.END else Gravity.START
        }

        // Message bubble with markdown rendering
        val bubble = TextView(requireContext()).apply {
            setTextColor(colorTextPrimary)
            textSize = messageFontSize
            setLineSpacing(4f, 1.2f)  // Add line height within messages
            setBackgroundColor(if (isUser) colorUserBubble else colorAssistantBubble)
            setPadding(20, 16, 20, 16)  // More padding inside bubbles
            // Limit width to 85% of screen
            maxWidth = (resources.displayMetrics.widthPixels * 0.85).toInt()
            val bubbleParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            layoutParams = bubbleParams
            // Enable text selection (must be set before movementMethod)
            setTextIsSelectable(true)
            // Render markdown
            markwon.setMarkdown(this, message.content)
            // Ensure links are styled (re-apply after setTextIsSelectable)
            setLinkTextColor(colorCyan)
            movementMethod = android.text.method.LinkMovementMethod.getInstance()
        }
        container.addView(bubble)

        // TTS listen button for assistant messages
        if (!isUser && message.content.isNotBlank()) {
            container.addView(createTtsControls(messageIndex, message.content))
        }

        // Timestamp
        if (message.timestamp != null) {
            val timeText = TextView(requireContext()).apply {
                text = formatTimestamp(message.timestamp)
                setTextColor(colorTextSecondary)
                textSize = 11f
                val timeParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                timeParams.setMargins(if (isUser) 0 else 8, 4, if (isUser) 8 else 0, 0)
                layoutParams = timeParams
                gravity = if (isUser) Gravity.END else Gravity.START
            }
            container.addView(timeText)
        }

        return container
    }

    private val colorActivityBg = Color.parseColor("#111111")
    private val colorActivityBorder = Color.parseColor("#333333")
    private val colorMagenta = Color.parseColor("#FF00FF")

    private fun createActivityBubble(activity: ExchangeActivity?, isWorking: Boolean): View {
        val container = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(colorActivityBg)
            setPadding(16, 10, 16, 10)
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            params.setMargins(24, 4, 24, 4)
            layoutParams = params
        }

        val tools = activity?.tools ?: emptyList()
        val count = activity?.toolCount ?: 0

        // Header row
        val headerRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        if (isWorking && count == 0) {
            // Pure working spinner - no tools yet
            val spinner = ProgressBar(requireContext(), null, android.R.attr.progressBarStyleSmall).apply {
                val spinnerParams = LinearLayout.LayoutParams(
                    (16 * resources.displayMetrics.density).toInt(),
                    (16 * resources.displayMetrics.density).toInt()
                )
                spinnerParams.setMargins(0, 0, 8, 0)
                layoutParams = spinnerParams
            }
            headerRow.addView(spinner)

            val workingLabel = TextView(requireContext()).apply {
                text = currentAgentTool?.let { "Working... ($it)" } ?: "Working..."
                setTextColor(colorCyan)
                textSize = 12f
            }
            headerRow.addView(workingLabel)
            container.addView(headerRow)
            return container
        }

        if (count == 0) return container  // nothing to show

        // Build summary: "⚡ 5 tools: Read, Edit, Bash..."
        val uniqueTools = tools.map { it.name }.distinct()
        val toolNames = uniqueTools.take(3).joinToString(", ")
        val moreText = if (uniqueTools.size > 3) " +${uniqueTools.size - 3}" else ""
        val summaryText = "$count tools: $toolNames$moreText"

        if (isWorking) {
            val spinner = ProgressBar(requireContext(), null, android.R.attr.progressBarStyleSmall).apply {
                val spinnerParams = LinearLayout.LayoutParams(
                    (16 * resources.displayMetrics.density).toInt(),
                    (16 * resources.displayMetrics.density).toInt()
                )
                spinnerParams.setMargins(0, 0, 8, 0)
                layoutParams = spinnerParams
            }
            headerRow.addView(spinner)
        } else {
            val icon = TextView(requireContext()).apply {
                text = "⚡"
                textSize = 12f
                setPadding(0, 0, 6, 0)
            }
            headerRow.addView(icon)
        }

        val headerLabel = TextView(requireContext()).apply {
            text = summaryText
            setTextColor(if (isWorking) colorCyan else colorTextSecondary)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        headerRow.addView(headerLabel)

        val chevron = TextView(requireContext()).apply {
            text = "▸"
            setTextColor(colorTextSecondary)
            textSize = 12f
            setPadding(8, 0, 0, 0)
        }
        headerRow.addView(chevron)

        container.addView(headerRow)

        // Expanded list (hidden by default)
        val expandedList = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(0, 8, 0, 0)
        }

        tools.forEach { tool ->
            val toolRow = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 3, 0, 3)
            }

            val toolIcon = TextView(requireContext()).apply {
                text = "⚡"
                setTextColor(colorMagenta)
                textSize = 11f
                setPadding(0, 0, 8, 0)
            }
            toolRow.addView(toolIcon)

            val toolText = TextView(requireContext()).apply {
                text = tool.message
                setTextColor(colorTextSecondary)
                textSize = 11f
                typeface = fontMono ?: Typeface.MONOSPACE
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            toolRow.addView(toolText)

            expandedList.addView(toolRow)
        }

        container.addView(expandedList)

        // Toggle on tap
        var expanded = false
        container.isClickable = true
        container.isFocusable = true
        container.setOnClickListener {
            expanded = !expanded
            expandedList.visibility = if (expanded) View.VISIBLE else View.GONE
            chevron.text = if (expanded) "▾" else "▸"
        }

        return container
    }

    private fun formatTimestamp(timestamp: String): String {
        return try {
            // Parse ISO timestamp - server sends UTC timestamps
            val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
            parser.timeZone = TimeZone.getTimeZone("UTC")  // Server timestamps are UTC
            val date = parser.parse(timestamp.substringBefore(".")) ?: return timestamp
            // Format in local timezone
            val formatter = SimpleDateFormat("h:mm a", Locale.US)
            formatter.timeZone = TimeZone.getDefault()  // Display in local time
            formatter.format(date)
        } catch (e: Exception) {
            timestamp.substringAfter("T").substringBefore(".")
        }
    }

    // Project accent colors for the session switcher
    private val projectColors = listOf(
        Color.parseColor("#FF6600"),  // orange
        Color.parseColor("#00BFA5"),  // teal
        Color.parseColor("#7C4DFF"),  // purple
        Color.parseColor("#FF4081"),  // pink
        Color.parseColor("#64DD17"),  // lime
        Color.parseColor("#00B0FF"),  // light blue
        Color.parseColor("#FFD600"),  // yellow
    )

    private fun updateSessionSwitcher() {
        sessionButtonsContainer.removeAllViews()

        // Group sessions by project
        val grouped = allSessions.groupBy { it.project }
        val dp = resources.displayMetrics.density

        grouped.entries.forEachIndexed { index, (project, projectSessions) ->
            val accentColor = projectColors[index % projectColors.size]
            val accentFaded = Color.argb(40, Color.red(accentColor), Color.green(accentColor), Color.blue(accentColor))

            // Vertical container: project header on top, branch pills below
            val groupLayout = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.VERTICAL
                val params = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                params.setMargins((4 * dp).toInt(), 0, (8 * dp).toInt(), 0)
                layoutParams = params
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(accentFaded)
                    cornerRadius = 6 * dp
                }
                setPadding((6 * dp).toInt(), (4 * dp).toInt(), (6 * dp).toInt(), (4 * dp).toInt())
            }

            // Project name header
            val projectLabel = TextView(requireContext()).apply {
                text = project.uppercase()
                setTextColor(accentColor)
                textSize = 9f
                typeface = fontHeader ?: Typeface.DEFAULT_BOLD
                letterSpacing = 0.08f
                setPadding(0, 0, 0, (3 * dp).toInt())
            }
            groupLayout.addView(projectLabel)

            // Branch pills row
            val pillsRow = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            projectSessions.forEach { session ->
                val isSelected = session.name == currentSessionName
                val status = sessionStatuses[session.name] ?: "idle"
                val statusColor = getStatusColor(status)

                val wrapper = android.widget.FrameLayout(requireContext()).apply {
                    val params = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    )
                    params.setMargins((2 * dp).toInt(), 0, (2 * dp).toInt(), 0)
                    layoutParams = params
                }

                val pillBg = android.graphics.drawable.GradientDrawable().apply {
                    cornerRadius = 4 * dp
                    if (isSelected) {
                        setColor(colorAmber)
                    } else {
                        setColor(colorDarkBg)
                        setStroke((1 * dp).toInt(), Color.argb(60, Color.red(accentColor), Color.green(accentColor), Color.blue(accentColor)))
                    }
                }

                val pill = TextView(requireContext()).apply {
                    text = session.branch ?: "main"
                    setTextColor(if (isSelected) colorDarkBg else Color.WHITE)
                    background = pillBg
                    textSize = 11f
                    typeface = fontBodyMedium ?: Typeface.DEFAULT_BOLD
                    setPadding((10 * dp).toInt(), (5 * dp).toInt(), (10 * dp).toInt(), (5 * dp).toInt())
                    isClickable = true
                    isFocusable = true
                    setOnClickListener {
                        if (!isSelected) {
                            onSessionSwitch?.invoke(session.name)
                        }
                    }
                }
                wrapper.addView(pill)

                // Status dot
                val dotSize = (7 * dp).toInt()
                val statusDot = View(requireContext()).apply {
                    val dotParams = android.widget.FrameLayout.LayoutParams(dotSize, dotSize)
                    dotParams.gravity = Gravity.TOP or Gravity.END
                    dotParams.setMargins(0, 0, (1 * dp).toInt(), 0)
                    layoutParams = dotParams
                    background = android.graphics.drawable.GradientDrawable().apply {
                        shape = android.graphics.drawable.GradientDrawable.OVAL
                        setColor(statusColor)
                    }
                }
                wrapper.addView(statusDot)

                pillsRow.addView(wrapper)
            }

            groupLayout.addView(pillsRow)
            sessionButtonsContainer.addView(groupLayout)
        }
    }

    /**
     * Get the current session name (for sending voice/text input)
     */
    fun getCurrentSessionName(): String? = currentSessionName

    private fun updateScrollButtonVisibility() {
        val maxScroll = messagesContainer.height - scrollView.height
        val currentScroll = scrollView.scrollY
        // Show button if we're more than 200px from the bottom
        val isNearBottom = maxScroll - currentScroll < 200
        scrollToBottomButton.visibility = if (isNearBottom) View.GONE else View.VISIBLE
    }

    private fun scrollToBottom() {
        val maxScroll = messagesContainer.height - scrollView.height
        if (maxScroll > 0) {
            scrollView.smoothScrollTo(0, maxScroll)
        }
    }

    private fun showSettingsMenu() {
        val menuLayout = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(colorSurface)
            setPadding(32, 32, 32, 32)
        }

        // Title — show session name + status
        val sessionName = currentSessionName ?: "unknown"
        val status = sessionStatuses[sessionName] ?: "idle"
        val statusColor = getStatusColor(status)

        val titleRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, 16)
        }

        val title = TextView(requireContext()).apply {
            text = formatSessionName(sessionName)
            setTextColor(colorAmber)
            textSize = 18f
            typeface = fontHeader ?: Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        titleRow.addView(title)

        // Status dot next to title
        val dotSize = (10 * resources.displayMetrics.density).toInt()
        val statusDot = View(requireContext()).apply {
            val dotParams = LinearLayout.LayoutParams(dotSize, dotSize)
            dotParams.setMargins(12, 0, 0, 0)
            layoutParams = dotParams
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(statusColor)
            }
        }
        titleRow.addView(statusDot)

        val statusLabel = TextView(requireContext()).apply {
            text = status
            setTextColor(statusColor)
            textSize = 12f
            setPadding(8, 0, 0, 0)
        }
        titleRow.addView(statusLabel)

        menuLayout.addView(titleRow)

        // Divider
        menuLayout.addView(View(requireContext()).apply {
            setBackgroundColor(Color.parseColor("#333333"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 1
            ).apply { setMargins(0, 8, 0, 16) }
        })

        // Font size section
        val fontLabel = TextView(requireContext()).apply {
            text = "Font Size"
            setTextColor(colorTextPrimary)
            textSize = 14f
            setPadding(0, 0, 0, 12)
        }
        menuLayout.addView(fontLabel)

        val fontRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val sizeLabel = TextView(requireContext()).apply {
            text = "${messageFontSize.toInt()}sp"
            setTextColor(colorTextPrimary)
            textSize = 18f
            setPadding(32, 0, 32, 0)
            gravity = Gravity.CENTER
        }

        val decreaseBtn = Button(requireContext()).apply {
            text = "−"
            setTextColor(colorDarkBg)
            setBackgroundColor(colorAmber)
            textSize = 20f
            setPadding(24, 8, 24, 8)
            setOnClickListener {
                if (messageFontSize > 10f) {
                    messageFontSize -= 1f
                    saveFontSize()
                    displayMessages()
                    sizeLabel.text = "${messageFontSize.toInt()}sp"
                }
            }
        }
        fontRow.addView(decreaseBtn)
        fontRow.addView(sizeLabel)

        val increaseBtn = Button(requireContext()).apply {
            text = "+"
            setTextColor(colorDarkBg)
            setBackgroundColor(colorAmber)
            textSize = 20f
            setPadding(24, 8, 24, 8)
            setOnClickListener {
                if (messageFontSize < 24f) {
                    messageFontSize += 1f
                    saveFontSize()
                    displayMessages()
                    sizeLabel.text = "${messageFontSize.toInt()}sp"
                }
            }
        }
        fontRow.addView(increaseBtn)
        menuLayout.addView(fontRow)

        // Divider
        menuLayout.addView(View(requireContext()).apply {
            setBackgroundColor(Color.parseColor("#333333"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 1
            ).apply { setMargins(0, 16, 0, 16) }
        })

        // TTS Autoplay toggle
        val ttsRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, 12)
        }

        val ttsLabel = TextView(requireContext()).apply {
            text = "Auto-play responses"
            setTextColor(colorTextPrimary)
            textSize = 14f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        ttsRow.addView(ttsLabel)

        val ttsSwitch = Switch(requireContext()).apply {
            isChecked = ttsAutoPlay
            setOnCheckedChangeListener { _, isChecked ->
                ttsAutoPlay = isChecked
                requireContext().getSharedPreferences(TTS_PREFS, android.content.Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_AUTOPLAY, isChecked).apply()
            }
        }
        ttsRow.addView(ttsSwitch)
        menuLayout.addView(ttsRow)

        // Divider
        menuLayout.addView(View(requireContext()).apply {
            setBackgroundColor(Color.parseColor("#333333"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 1
            ).apply { setMargins(0, 16, 0, 16) }
        })

        // Session controls section
        val controlsLabel = TextView(requireContext()).apply {
            text = "Session Controls"
            setTextColor(colorTextPrimary)
            textSize = 14f
            setPadding(0, 0, 0, 12)
        }
        menuLayout.addView(controlsLabel)

        // Create dialog first so buttons can dismiss it
        val dialog = android.app.AlertDialog.Builder(requireContext(), android.R.style.Theme_Material_Dialog_NoActionBar)
            .setView(menuLayout)
            .create()

        // Restart button
        val restartBtn = Button(requireContext()).apply {
            text = "RESTART SESSION"
            setTextColor(colorDarkBg)
            setBackgroundColor(Color.parseColor("#FFCC00"))
            textSize = 14f
            setPadding(24, 16, 24, 16)
            val btnParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            btnParams.setMargins(0, 0, 0, 12)
            layoutParams = btnParams
            setOnClickListener {
                dialog.dismiss()
                confirmRestartSession()
            }
        }
        menuLayout.addView(restartBtn)

        // Kill button
        val killBtn = Button(requireContext()).apply {
            text = "KILL SESSION"
            setTextColor(colorTextPrimary)
            setBackgroundColor(Color.parseColor("#FF3333"))
            textSize = 14f
            setPadding(24, 16, 24, 16)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            setOnClickListener {
                dialog.dismiss()
                confirmKillSession()
            }
        }
        menuLayout.addView(killBtn)

        dialog.window?.apply {
            setGravity(Gravity.TOP or Gravity.END)
            setBackgroundDrawableResource(android.R.color.transparent)
            val params = attributes
            params.x = 16
            params.y = 120
            attributes = params
        }

        dialog.show()
    }

    private fun confirmRestartSession() {
        val sessionName = currentSessionName ?: return
        android.app.AlertDialog.Builder(requireContext())
            .setTitle("Restart Session?")
            .setMessage("This will kill and restart: $sessionName\n\nThe session will reconnect with --continue.")
            .setPositiveButton("RESTART") { _, _ -> restartSession(sessionName) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun confirmKillSession() {
        val sessionName = currentSessionName ?: return
        android.app.AlertDialog.Builder(requireContext())
            .setTitle("Kill Session?")
            .setMessage("This will permanently kill: $sessionName")
            .setPositiveButton("KILL") { _, _ -> killSession(sessionName) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun restartSession(sessionName: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    // Step 1: Kill existing session
                    val deleteRequest = Request.Builder()
                        .url("$BASE_URL/api/sessions?session=${java.net.URLEncoder.encode(sessionName, "UTF-8")}")
                        .delete()
                        .build()
                    client.newCall(deleteRequest).execute()

                    // Wait for tmux cleanup
                    kotlinx.coroutines.delay(500)

                    // Step 2: Create new session with continue mode
                    val session = allSessions.find { it.name == sessionName }
                    val bodyJson = JSONObject().apply {
                        put("project", session?.project ?: extractProjectFromSession(sessionName))
                        put("mode", "continue")
                        if (session?.branch != null && session.branch != "main") {
                            put("branch", session.branch)
                            put("worktreePath", session.path)
                        }
                    }
                    val postRequest = Request.Builder()
                        .url("$BASE_URL/api/sessions")
                        .post(bodyJson.toString().toRequestBody("application/json".toMediaTypeOrNull()))
                        .build()
                    client.newCall(postRequest).execute()
                }

                withContext(Dispatchers.Main) {
                    android.widget.Toast.makeText(requireContext(), "Session restarted", android.widget.Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error restarting session: ${e.message}", e)
                withContext(Dispatchers.Main) {
                    android.widget.Toast.makeText(requireContext(), "Restart failed: ${e.message}", android.widget.Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun killSession(sessionName: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val deleteRequest = Request.Builder()
                        .url("$BASE_URL/api/sessions?session=${java.net.URLEncoder.encode(sessionName, "UTF-8")}")
                        .delete()
                        .build()
                    client.newCall(deleteRequest).execute()
                }

                withContext(Dispatchers.Main) {
                    android.widget.Toast.makeText(requireContext(), "Session killed", android.widget.Toast.LENGTH_SHORT).show()
                    // Navigate back to sessions list
                    onBackPressed?.invoke()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error killing session: ${e.message}", e)
                withContext(Dispatchers.Main) {
                    android.widget.Toast.makeText(requireContext(), "Kill failed: ${e.message}", android.widget.Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun saveFontSize() {
        val prefs = requireContext().getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE)
        prefs.edit().putFloat(KEY_FONT_SIZE, messageFontSize).apply()
    }
}
