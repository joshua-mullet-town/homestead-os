package com.homestead.mobile

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.*
import android.widget.GridLayout
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
import java.util.concurrent.TimeUnit
import io.noties.markwon.Markwon
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin

class GuestChatFragment : Fragment() {

    companion object {
        private const val TAG = "GuestChatFragment"
        private const val BASE_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net"
        private const val POLL_INTERVAL_MS = 3000L
    }

    // Theme colors
    private val colorDarkBg = Color.parseColor("#0D0D0D")
    private val colorSurface = Color.parseColor("#1A1A1A")
    private val colorBorder = Color.parseColor("#2A2A2A")
    private val colorTextPrimary = Color.WHITE
    private val colorTextSecondary = Color.parseColor("#888888")
    private val colorGreen = Color.parseColor("#00FF66")
    private val colorBlue = Color.parseColor("#3B82F6")
    private val colorOrange = Color.parseColor("#FF6600")
    private val colorAmber = Color.parseColor("#FFBF00")

    // Bubble backgrounds
    private val colorClaudeBubble = Color.parseColor("#1A2A1A")
    private val colorOwnerBubble = Color.parseColor("#1E3A5F")
    private val colorGuestBubble = Color.parseColor("#2A1A0A")

    // Fonts
    private var fontHeader: Typeface? = null
    private var fontBody: Typeface? = null
    private var fontMono: Typeface? = null

    // Views
    private lateinit var rootLayout: FrameLayout
    private lateinit var mainLayout: LinearLayout
    private lateinit var headerNameText: TextView
    private lateinit var headerStatusDot: View
    private lateinit var headerStatusText: TextView
    private lateinit var messagesContainer: LinearLayout
    private lateinit var scrollView: ScrollView
    private lateinit var messageInput: EditText
    private lateinit var sendButton: TextView
    private lateinit var scrollToBottomButton: Button
    private lateinit var headerInitialCircle: TextView

    // State
    private var guestLogin: String = ""
    private var guestName: String = ""
    private var sessionName: String = ""
    private var sessionAlive: Boolean = false
    private var ownerName: String = "Josh"
    private var viewsInitialized = false
    private var messageCount = 0
    private var isInitialLoad = true

    // Reactions
    private val REACTION_EMOJIS = listOf(
        // Love & flirty
        "❤️", "😍", "🥰", "😘", "💋", "🫦", "🍑", "🍆", "💦", "🥵",
        // Fun & expressive
        "😂", "🤣", "😭", "🥺", "😏", "😈", "👀", "🫣", "🤤", "🤭",
        // Hype & reactions
        "🔥", "💀", "👏", "🙌", "💪", "🎉", "🥳", "⚡", "✨", "💯",
        // Thumbs & gestures
        "👍", "👎", "🤞", "🤙", "👋", "🫶", "🙏", "✌️", "🤟", "💅",
    )
    private var reactions: MutableMap<String, MutableMap<String, MutableList<String>>> = mutableMapOf()

    // Callbacks
    var onBackPressed: (() -> Unit)? = null
    var onWalkieTalkieStart: ((guestLogin: String, sessionName: String) -> Unit)? = null
    var onWalkieTalkieStop: ((guestLogin: String, sessionName: String) -> Unit)? = null

    // Polling
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

    // Data models
    data class GuestChatMessage(val id: String, val role: String, val content: String)
    data class ParsedGuestMessage(
        val id: String,
        val role: String,
        val content: String,
        val sender: String,       // "owner" | "guest" | "claude"
        val senderName: String,
        val displayContent: String
    )

    fun setGuest(guestLogin: String, guestName: String, sessionName: String, sessionAlive: Boolean) {
        this.guestLogin = guestLogin
        this.guestName = guestName
        this.sessionName = sessionName
        this.sessionAlive = sessionAlive
        this.messageCount = 0
        this.isInitialLoad = true

        if (viewsInitialized) {
            updateHeader()
            messagesContainer.removeAllViews()
            loadMessages()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        markwon = Markwon.builder(requireContext())
            .usePlugin(StrikethroughPlugin.create())
            .usePlugin(TablePlugin.create(requireContext()))
            .build()
    }

    @SuppressLint("SetTextI18n", "ClickableViewAccessibility")
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val ctx = requireContext()
        val dp = resources.displayMetrics.density

        // Load fonts
        val spaceGrotesk = ResourcesCompat.getFont(ctx, R.font.space_grotesk_variable)
        fontHeader = Typeface.create(spaceGrotesk, Typeface.BOLD)
        fontBody = ResourcesCompat.getFont(ctx, R.font.inter_regular)
        fontMono = ResourcesCompat.getFont(ctx, R.font.jetbrains_mono_regular)

        rootLayout = FrameLayout(ctx).apply {
            setBackgroundColor(colorDarkBg)
        }

        mainLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        // === Header (extra top padding for edge-to-edge status bar) ===
        val header = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(colorSurface)
            setPadding((12 * dp).toInt(), (38 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
            gravity = Gravity.CENTER_VERTICAL
        }

        // Back button
        val backButton = TextView(ctx).apply {
            text = "‹"
            setTextColor(colorTextSecondary)
            textSize = 28f
            setPadding((8 * dp).toInt(), 0, (12 * dp).toInt(), 0)
            setOnClickListener { onBackPressed?.invoke() }
        }
        header.addView(backButton)

        // Guest initial circle
        headerInitialCircle = TextView(ctx).apply {
            val size = (32 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(size, size).apply {
                marginEnd = (10 * dp).toInt()
            }
            gravity = Gravity.CENTER
            textSize = 14f
            setTextColor(colorOrange)
            typeface = fontHeader
            text = guestName.firstOrNull()?.uppercase() ?: "?"
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#331A00"))
                cornerRadius = size / 2f
            }
            background = bg
        }
        header.addView(headerInitialCircle)

        // Name + status column
        val nameColumn = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }

        headerNameText = TextView(ctx).apply {
            text = guestName
            setTextColor(colorTextPrimary)
            textSize = 15f
            typeface = fontHeader
            maxLines = 1
        }
        nameColumn.addView(headerNameText)

        val statusRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        headerStatusDot = View(ctx).apply {
            val dotSize = (6 * dp).toInt()
            layoutParams = LinearLayout.LayoutParams(dotSize, dotSize).apply {
                marginEnd = (6 * dp).toInt()
            }
            val dotBg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(if (sessionAlive) colorGreen else Color.parseColor("#666666"))
            }
            background = dotBg
        }
        statusRow.addView(headerStatusDot)

        headerStatusText = TextView(ctx).apply {
            text = if (sessionAlive) "Session active" else "Session offline"
            setTextColor(colorTextSecondary)
            textSize = 11f
            typeface = fontBody
        }
        statusRow.addView(headerStatusText)
        nameColumn.addView(statusRow)
        header.addView(nameColumn)

        // Walkie-talkie button
        val walkieButton = TextView(ctx).apply {
            text = "\uD83C\uDF99"  // 🎙
            textSize = 22f
            setPadding((12 * dp).toInt(), (4 * dp).toInt(), (4 * dp).toInt(), (4 * dp).toInt())

            var holdTimer: Runnable? = null
            var isLongPress = false
            val handler = Handler(Looper.getMainLooper())

            setOnTouchListener { _, event ->
                when (event.action) {
                    android.view.MotionEvent.ACTION_DOWN -> {
                        isLongPress = false
                        holdTimer = Runnable {
                            isLongPress = true
                            onWalkieTalkieStart?.invoke(guestLogin, sessionName)
                        }
                        handler.postDelayed(holdTimer!!, 300)
                        true
                    }
                    android.view.MotionEvent.ACTION_UP -> {
                        if (isLongPress) {
                            onWalkieTalkieStop?.invoke(guestLogin, sessionName)
                        } else {
                            holdTimer?.let { handler.removeCallbacks(it) }
                        }
                        true
                    }
                    android.view.MotionEvent.ACTION_CANCEL -> {
                        holdTimer?.let { handler.removeCallbacks(it) }
                        if (isLongPress) {
                            onWalkieTalkieStop?.invoke(guestLogin, sessionName)
                        }
                        true
                    }
                    else -> false
                }
            }
        }
        header.addView(walkieButton)

        mainLayout.addView(header)

        // Thin border under header
        val headerBorder = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                (1 * dp).toInt()
            )
            setBackgroundColor(colorBorder)
        }
        mainLayout.addView(headerBorder)

        // === Messages area ===
        val scrollContainer = FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0, 1f
            )
        }

        scrollView = ScrollView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        messagesContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((12 * dp).toInt(), (12 * dp).toInt(), (12 * dp).toInt(), (12 * dp).toInt())
        }
        scrollView.addView(messagesContainer)
        scrollContainer.addView(scrollView)

        // Scroll to bottom button
        scrollToBottomButton = Button(ctx).apply {
            text = "↓"
            setTextColor(colorDarkBg)
            setBackgroundColor(colorAmber)
            textSize = 18f
            val size = (48 * dp).toInt()
            val params = FrameLayout.LayoutParams(size, size)
            params.gravity = Gravity.BOTTOM or Gravity.END
            params.setMargins(0, 0, (16 * dp).toInt(), (16 * dp).toInt())
            layoutParams = params
            visibility = View.GONE
            setOnClickListener { scrollToBottom() }
        }
        scrollContainer.addView(scrollToBottomButton)

        scrollView.viewTreeObserver.addOnScrollChangedListener {
            updateScrollButtonVisibility()
        }

        mainLayout.addView(scrollContainer)

        // === Input bar ===
        val inputBorder = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                (1 * dp).toInt()
            )
            setBackgroundColor(colorBorder)
        }
        mainLayout.addView(inputBorder)

        val inputBar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(colorSurface)
            setPadding((12 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt())
            gravity = Gravity.CENTER_VERTICAL
        }

        messageInput = EditText(ctx).apply {
            hint = "Type a message..."
            setHintTextColor(Color.parseColor("#555555"))
            setTextColor(colorTextPrimary)
            textSize = 15f
            typeface = fontBody
            setBackgroundColor(Color.TRANSPARENT)
            isSingleLine = false
            maxLines = 4
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            setPadding((12 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt())

            val inputBg = GradientDrawable().apply {
                setColor(Color.parseColor("#222222"))
                cornerRadius = 20f * dp
            }
            background = inputBg
        }
        inputBar.addView(messageInput)

        sendButton = TextView(ctx).apply {
            text = "→"
            textSize = 22f
            setTextColor(colorAmber)
            setPadding((14 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt())
            setOnClickListener { sendMessage() }
        }
        inputBar.addView(sendButton)

        mainLayout.addView(inputBar)

        rootLayout.addView(mainLayout)

        viewsInitialized = true

        // If guest was already set before view creation, apply now
        if (guestLogin.isNotEmpty()) {
            updateHeader()
            loadMessages()
        }

        return rootLayout
    }

    override fun onResume() {
        super.onResume()
        if (guestLogin.isNotEmpty()) {
            pollHandler.post(pollRunnable)
        }
    }

    override fun onPause() {
        super.onPause()
        pollHandler.removeCallbacks(pollRunnable)
    }

    private fun updateHeader() {
        if (!viewsInitialized) return
        headerNameText.text = guestName
        headerInitialCircle.text = guestName.firstOrNull()?.uppercase() ?: "?"
        val dotBg = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(if (sessionAlive) colorGreen else Color.parseColor("#666666"))
        }
        headerStatusDot.background = dotBg
        headerStatusText.text = if (sessionAlive) "Session active" else "Session offline"
    }

    private fun parseAttribution(msg: GuestChatMessage): ParsedGuestMessage {
        if (msg.role == "assistant") {
            return ParsedGuestMessage(
                id = msg.id, role = msg.role, content = msg.content,
                sender = "claude", senderName = "Claude", displayContent = msg.content
            )
        }
        val match = Regex("^\\[([^\\]]+)]:\\s*([\\s\\S]*)$").find(msg.content)
        if (match != null) {
            val name = match.groupValues[1]
            val content = match.groupValues[2]
            val sender = if (name == guestName) "guest" else "owner"
            return ParsedGuestMessage(
                id = msg.id, role = msg.role, content = msg.content,
                sender = sender, senderName = name, displayContent = content
            )
        }
        return ParsedGuestMessage(
            id = msg.id, role = msg.role, content = msg.content,
            sender = "guest", senderName = guestName, displayContent = msg.content
        )
    }

    private fun loadMessages() {
        if (sessionName.isEmpty()) return

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val messages = fetchMessages()
                val newReactions = fetchReactions()
                reactions = newReactions
                if (messages.size != messageCount) {
                    messageCount = messages.size
                    val parsed = messages
                        .filter { !(it.role == "assistant" && it.content.trim() == "---") }
                        .map { parseAttribution(it) }
                    withContext(Dispatchers.Main) {
                        displayMessages(parsed)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load messages: ${e.message}")
            }
        }
    }

    private suspend fun fetchMessages(): List<GuestChatMessage> = withContext(Dispatchers.IO) {
        try {
            val url = "$BASE_URL/api/chat-messages/guest?session=${java.net.URLEncoder.encode(sessionName, "UTF-8")}"
            val request = Request.Builder().url(url).build()
            val response = client.newCall(request).execute()
            if (response.isSuccessful) {
                val body = response.body?.string() ?: return@withContext emptyList()
                val json = JSONObject(body)
                val arr = json.optJSONArray("messages") ?: return@withContext emptyList()
                val result = mutableListOf<GuestChatMessage>()
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    result.add(GuestChatMessage(
                        id = obj.optString("id", "$i"),
                        role = obj.optString("role", "user"),
                        content = obj.optString("content", "")
                    ))
                }
                result
            } else {
                emptyList()
            }
        } catch (e: Exception) {
            Log.e(TAG, "fetchMessages error: ${e.message}")
            emptyList()
        }
    }

    private suspend fun fetchReactions(): MutableMap<String, MutableMap<String, MutableList<String>>> = withContext(Dispatchers.IO) {
        try {
            val url = "$BASE_URL/api/guests/reactions?session=${java.net.URLEncoder.encode(sessionName, "UTF-8")}"
            val request = Request.Builder().url(url).build()
            val response = client.newCall(request).execute()
            if (response.isSuccessful) {
                val body = response.body?.string() ?: return@withContext mutableMapOf()
                val json = JSONObject(body)
                val reactionsObj = json.optJSONObject("reactions") ?: return@withContext mutableMapOf()
                val result = mutableMapOf<String, MutableMap<String, MutableList<String>>>()
                for (msgId in reactionsObj.keys()) {
                    val emojisObj = reactionsObj.getJSONObject(msgId)
                    val emojiMap = mutableMapOf<String, MutableList<String>>()
                    for (emoji in emojisObj.keys()) {
                        val usersArr = emojisObj.getJSONArray(emoji)
                        val users = mutableListOf<String>()
                        for (i in 0 until usersArr.length()) {
                            users.add(usersArr.getString(i))
                        }
                        emojiMap[emoji] = users
                    }
                    result[msgId] = emojiMap
                }
                result
            } else {
                mutableMapOf()
            }
        } catch (e: Exception) {
            Log.e(TAG, "fetchReactions error: ${e.message}")
            mutableMapOf()
        }
    }

    private fun toggleReaction(messageId: String, emoji: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val url = "$BASE_URL/api/guests/reactions"
                    val jsonBody = JSONObject().apply {
                        put("session", sessionName)
                        put("messageId", messageId)
                        put("emoji", emoji)
                        put("userName", ownerName)
                    }
                    val body = jsonBody.toString()
                        .toRequestBody("application/json".toMediaTypeOrNull())
                    val request = Request.Builder()
                        .url(url)
                        .post(body)
                        .build()
                    val response = client.newCall(request).execute()
                    if (response.isSuccessful) {
                        val respBody = response.body?.string()
                        if (respBody != null) {
                            val json = JSONObject(respBody)
                            val reactionsObj = json.optJSONObject("reactions")
                            if (reactionsObj != null) {
                                val updated = mutableMapOf<String, MutableMap<String, MutableList<String>>>()
                                for (msgId in reactionsObj.keys()) {
                                    val emojisObj = reactionsObj.getJSONObject(msgId)
                                    val emojiMap = mutableMapOf<String, MutableList<String>>()
                                    for (em in emojisObj.keys()) {
                                        val usersArr = emojisObj.getJSONArray(em)
                                        val users = mutableListOf<String>()
                                        for (i in 0 until usersArr.length()) {
                                            users.add(usersArr.getString(i))
                                        }
                                        emojiMap[em] = users
                                    }
                                    updated[msgId] = emojiMap
                                }
                                reactions = updated
                            }
                        }
                    }
                }
                // Force redisplay
                messageCount = 0
                loadMessages()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to toggle reaction: ${e.message}")
            }
        }
    }

    @SuppressLint("SetTextI18n")
    private fun displayMessages(parsed: List<ParsedGuestMessage>) {
        if (!isAdded || !viewsInitialized) return

        val ctx = requireContext()
        val dp = resources.displayMetrics.density
        val screenWidth = resources.displayMetrics.widthPixels
        val maxBubbleWidth = (screenWidth * 0.85).toInt()

        val wasNearBottom = isNearBottom()

        messagesContainer.removeAllViews()

        if (parsed.isEmpty()) {
            val empty = TextView(ctx).apply {
                text = if (sessionAlive) "No messages yet. Say hello!" else "Session is offline."
                setTextColor(colorTextSecondary)
                textSize = 14f
                typeface = fontBody
                gravity = Gravity.CENTER
                setPadding(0, (60 * dp).toInt(), 0, 0)
            }
            messagesContainer.addView(empty)
            return
        }

        for (msg in parsed) {
            val isRight = msg.sender == "owner"
            val accentColor = when (msg.sender) {
                "claude" -> colorGreen
                "owner" -> colorBlue
                else -> colorOrange
            }
            val bubbleBgColor = when (msg.sender) {
                "claude" -> colorClaudeBubble
                "owner" -> colorOwnerBubble
                else -> colorGuestBubble
            }

            // Outer wrapper for alignment
            val wrapper = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                val wrapperParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                wrapperParams.bottomMargin = (8 * dp).toInt()
                layoutParams = wrapperParams
                gravity = if (isRight) Gravity.END else Gravity.START
            }

            // Sender label (skip for owner — right side is self-evident)
            if (!isRight) {
                val senderLabel = TextView(ctx).apply {
                    text = when (msg.sender) {
                        "claude" -> "🤖 Claude"
                        else -> msg.senderName
                    }
                    setTextColor(accentColor)
                    textSize = 11f
                    typeface = fontHeader
                    setPadding((4 * dp).toInt(), 0, 0, (3 * dp).toInt())
                }
                wrapper.addView(senderLabel)
            }

            // Bubble
            val bubbleBg = GradientDrawable().apply {
                setColor(bubbleBgColor)
                cornerRadius = 12f * dp
                setStroke((1 * dp).toInt(), Color.argb(40, Color.red(accentColor), Color.green(accentColor), Color.blue(accentColor)))
            }

            val bubbleText = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                maxWidth = maxBubbleWidth
                background = bubbleBg
                setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
                setTextColor(colorTextPrimary)
                textSize = 14f
                typeface = fontBody
                setLineSpacing(0f, 1.3f)
            }

            // Render markdown for Claude, plain text for others
            if (msg.sender == "claude") {
                markwon.setMarkdown(bubbleText, msg.displayContent)
            } else {
                bubbleText.text = msg.displayContent
            }

            // Long-press to open emoji picker
            bubbleText.setOnLongClickListener { view ->
                view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                showEmojiPicker(view, msg.id)
                true
            }

            wrapper.addView(bubbleText)

            // Reaction pills
            val msgReactions = reactions[msg.id]
            if (msgReactions != null && msgReactions.isNotEmpty()) {
                val pillContainer = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    val pillParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    )
                    pillParams.topMargin = (4 * dp).toInt()
                    layoutParams = pillParams
                    gravity = if (isRight) Gravity.END else Gravity.START
                }

                for ((emoji, users) in msgReactions) {
                    val iReacted = users.contains(ownerName)
                    val pill = TextView(ctx).apply {
                        text = "$emoji ${users.size}"
                        textSize = 12f
                        typeface = fontBody
                        setTextColor(colorTextSecondary)
                        setPadding((8 * dp).toInt(), (3 * dp).toInt(), (8 * dp).toInt(), (3 * dp).toInt())
                        val pillBg = GradientDrawable().apply {
                            cornerRadius = 12f * dp
                            if (iReacted) {
                                setColor(Color.parseColor("#1E3A6F"))
                                setStroke((1 * dp).toInt(), Color.parseColor("#3B82F680"))
                            } else {
                                setColor(Color.parseColor("#1A1A1A"))
                                setStroke((1 * dp).toInt(), colorBorder)
                            }
                        }
                        background = pillBg
                        val lp = LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.WRAP_CONTENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT
                        )
                        lp.marginEnd = (4 * dp).toInt()
                        layoutParams = lp
                        setOnClickListener { toggleReaction(msg.id, emoji) }
                    }
                    pillContainer.addView(pill)
                }

                wrapper.addView(pillContainer)
            }

            messagesContainer.addView(wrapper)
        }

        // Auto-scroll
        if (isInitialLoad || wasNearBottom) {
            isInitialLoad = false
            scrollToBottom()
        }
    }

    private fun sendMessage() {
        val text = messageInput.text.toString().trim()
        if (text.isEmpty() || guestLogin.isEmpty()) return

        messageInput.text.clear()

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val url = "$BASE_URL/api/guests/send-shared-message"
                    val jsonBody = JSONObject().apply {
                        put("guestLogin", guestLogin)
                        put("message", text)
                    }
                    val body = jsonBody.toString()
                        .toRequestBody("application/json".toMediaTypeOrNull())
                    val request = Request.Builder()
                        .url(url)
                        .post(body)
                        .build()
                    client.newCall(request).execute()
                }
                // Delay then refresh
                Handler(Looper.getMainLooper()).postDelayed({
                    messageCount = 0  // Force refresh
                    loadMessages()
                }, 1000)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to send message: ${e.message}")
            }
        }
    }

    @SuppressLint("SetTextI18n")
    private fun showEmojiPicker(anchorView: View, messageId: String) {
        val ctx = requireContext()
        val dp = resources.displayMetrics.density
        val screenWidth = resources.displayMetrics.widthPixels

        val scrollContainer = ScrollView(ctx).apply {
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#1A1A1A"))
                cornerRadius = 16f * dp
                setStroke((1 * dp).toInt(), colorBorder)
            }
            background = bg
            setPadding((8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt())
        }

        val gridLayout = GridLayout(ctx).apply {
            columnCount = 8
        }

        scrollContainer.addView(gridLayout)

        val popupWidth = (screenWidth * 0.85).toInt()
        val popupHeight = (200 * dp).toInt()

        val popup = PopupWindow(
            scrollContainer,
            popupWidth,
            popupHeight,
            true
        ).apply {
            elevation = 8f * dp
            setBackgroundDrawable(null)
        }

        val msgReactions = reactions[messageId] ?: emptyMap()

        for (emoji in REACTION_EMOJIS) {
            val alreadyReacted = msgReactions[emoji]?.contains(ownerName) == true
            val emojiBtn = TextView(ctx).apply {
                text = emoji
                textSize = 22f
                gravity = Gravity.CENTER
                val btnSize = ((popupWidth - (16 * dp).toInt()) / 8)
                layoutParams = GridLayout.LayoutParams().apply {
                    width = btnSize
                    height = (44 * dp).toInt()
                }
                setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt())
                if (alreadyReacted) {
                    val highlightBg = GradientDrawable().apply {
                        setColor(Color.parseColor("#1E3A6F"))
                        cornerRadius = 8f * dp
                    }
                    background = highlightBg
                }
                setOnClickListener {
                    popup.dismiss()
                    toggleReaction(messageId, emoji)
                }
            }
            gridLayout.addView(emojiBtn)
        }

        popup.showAsDropDown(anchorView, 0, -(anchorView.height + popupHeight))
    }

    private fun isNearBottom(): Boolean {
        if (!::scrollView.isInitialized) return true
        val scrollY = scrollView.scrollY
        val maxScroll = scrollView.getChildAt(0)?.height?.minus(scrollView.height) ?: 0
        return maxScroll <= 0 || scrollY >= maxScroll - 200
    }

    private fun scrollToBottom() {
        scrollView.post {
            scrollView.fullScroll(View.FOCUS_DOWN)
        }
    }

    private fun updateScrollButtonVisibility() {
        if (!::scrollToBottomButton.isInitialized) return
        scrollToBottomButton.visibility = if (isNearBottom()) View.GONE else View.VISIBLE
    }
}
