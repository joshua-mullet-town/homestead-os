package com.homestead.mobile

import android.app.AlertDialog
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
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
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.concurrent.TimeUnit

class SessionsFragment : Fragment() {

    companion object {
        private const val TAG = "SessionsFragment"
        private const val BASE_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net"
    }

    // Homestead theme colors
    private val colorAmber = Color.parseColor("#FFBF00")
    private val colorOrange = Color.parseColor("#FF6600")
    private val colorDarkBg = Color.parseColor("#0D0D0D")
    private val colorSurface = Color.parseColor("#1A1A1A")
    private val colorSurfaceLight = Color.parseColor("#1E1E1E")
    private val colorCardBg = Color.parseColor("#222222")
    private val colorBorder = Color.parseColor("#333333")
    private val colorTextPrimary = Color.parseColor("#FFFFFF")
    private val colorTextSecondary = Color.parseColor("#777777")
    private val colorGreen = Color.parseColor("#4ADE80")
    private val colorCyan = Color.parseColor("#67E8F9")
    private val colorRed = Color.parseColor("#F87171")

    private lateinit var rootLayout: LinearLayout
    private lateinit var sessionsContainer: LinearLayout
    private lateinit var loadingIndicator: ProgressBar
    private lateinit var refreshButton: TextView

    // Fonts
    private var fontHeader: Typeface? = null
    private var fontHeaderMedium: Typeface? = null
    private var fontBody: Typeface? = null
    private var fontBodyMedium: Typeface? = null
    private var fontMono: Typeface? = null

    private var sessions: List<SessionInfo> = emptyList()
    private var allProjects: Map<String, List<WorktreeInfo>> = emptyMap()
    var onSessionClick: ((SessionInfo) -> Unit)? = null
    var onActiveSessionChanged: ((String) -> Unit)? = null
    var onSessionsLoaded: (() -> Unit)? = null
    var onWalkieTalkieStart: ((sessionName: String) -> Unit)? = null
    var onWalkieTalkieStop: ((sessionName: String) -> Unit)? = null
    var currentlyViewingSession: String? = null

    // Walkie-talkie state
    var walkieTalkieSession: String? = null
        set(value) {
            field = value
            if (isAdded && view != null) displayProjects()
        }
    var walkieTalkieSending: String? = null
        set(value) {
            field = value
            if (isAdded && view != null) displayProjects()
        }

    // Which session is currently targeted for input
    var activeSessionName: String? = null
        set(value) {
            field = value
            if (isAdded && view != null) displayProjects()
        }

    // Session status tracking: "working" / "waiting" / "idle"
    private var sessionStatuses: Map<String, String> = emptyMap()

    // Sessions that just became "waiting" and haven't been viewed yet
    private val newlyReadySessions = mutableSetOf<String>()

    // Background polling for session status changes (for notifications)
    private val statusPollHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val statusPollRunnable = object : Runnable {
        override fun run() {
            if (isAdded) {
                pollSessionStatuses()
                statusPollHandler.postDelayed(this, 30_000)
            }
        }
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    data class SessionInfo(
        val name: String,
        val project: String,
        val branch: String?,
        val path: String,
        val isWorktree: Boolean,
        val windows: Int,
        val hasClaudeRunning: Boolean = false,
        val updatedAt: Long = 0L  // epoch millis from claude-sessions API
    )

    data class WorktreeInfo(
        val path: String,
        val branch: String,
        val commit: String,
        val isMain: Boolean,
        val project: String
    )

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        // Load fonts
        val spaceGrotesk = ResourcesCompat.getFont(requireContext(), R.font.space_grotesk_variable)
        fontHeader = Typeface.create(spaceGrotesk, Typeface.BOLD)
        fontHeaderMedium = spaceGrotesk
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
            setPadding(36, 48, 36, 20)
            gravity = Gravity.CENTER_VERTICAL
        }

        val titleText = TextView(requireContext()).apply {
            text = "Sessions"
            setTextColor(colorAmber)
            textSize = 22f
            typeface = fontHeader
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        header.addView(titleText)

        val dp = resources.displayMetrics.density

        refreshButton = TextView(requireContext()).apply {
            text = "Refresh"
            setTextColor(colorTextSecondary)
            textSize = 13f
            typeface = fontBodyMedium
            setPadding(20, 10, 20, 10)
            setOnClickListener { loadData() }
        }
        header.addView(refreshButton)

        rootLayout.addView(header)

        // Loading indicator
        loadingIndicator = ProgressBar(requireContext()).apply {
            visibility = View.GONE
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            params.gravity = Gravity.CENTER
            params.setMargins(0, 48, 0, 0)
            layoutParams = params
        }
        rootLayout.addView(loadingIndicator)

        // Scrollable sessions container
        val scrollView = ScrollView(requireContext()).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        sessionsContainer = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 0, 28, 28)
        }
        scrollView.addView(sessionsContainer)
        rootLayout.addView(scrollView)

        loadData()

        // Start background status polling for notifications
        // Poll immediately to seed initial statuses, then every 30s
        pollSessionStatuses()
        statusPollHandler.postDelayed(statusPollRunnable, 30_000)


        return rootLayout
    }

    override fun onResume() {
        super.onResume()
        loadData()
        statusPollHandler.removeCallbacks(statusPollRunnable)
        statusPollHandler.postDelayed(statusPollRunnable, 30_000)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        statusPollHandler.removeCallbacks(statusPollRunnable)
    }

    private fun pollSessionStatuses() {
        if (!isAdded) return
        Log.d(TAG, "Polling session statuses...")
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val claudeData = fetchSessionStatuses()
                Log.d(TAG, "Poll got ${claudeData.statuses.size} statuses: ${claudeData.statuses}")
                detectNewlyReady(claudeData.statuses)
                sessionStatuses = claudeData.statuses
            } catch (e: Exception) {
                Log.w(TAG, "Status poll failed: ${e.message}")
            }
        }
    }

    private fun loadData() {
        loadingIndicator.visibility = View.VISIBLE
        refreshButton.isEnabled = false
        sessionsContainer.removeAllViews()

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                // Fetch sessions, projects, and statuses
                val fetchedSessions = fetchSessions()
                val fetchedProjects = fetchProjects()
                val claudeData = fetchSessionStatuses()
                // Merge updatedAt into sessions (try tmux name first, then project name)
                sessions = fetchedSessions.map { session ->
                    val updatedAt = claudeData.updatedAtByTmux[session.name]
                        ?: claudeData.updatedAtByProject[session.project]
                        ?: 0L
                    session.copy(updatedAt = updatedAt)
                }
                allProjects = fetchedProjects
                detectNewlyReady(claudeData.statuses)
                sessionStatuses = claudeData.statuses

                withContext(Dispatchers.Main) {
                    loadingIndicator.visibility = View.GONE
                    refreshButton.isEnabled = true
                    displayProjects()
                    onSessionsLoaded?.invoke()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load: ${e.message}", e)
                withContext(Dispatchers.Main) {
                    loadingIndicator.visibility = View.GONE
                    refreshButton.isEnabled = true
                    showError("Failed to load: ${e.message}")
                }
            }
        }
    }

    private suspend fun fetchSessions(): List<SessionInfo> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$BASE_URL/api/sessions")
            .get()
            .build()

        val response = client.newCall(request).execute()
        val body = response.body?.string() ?: return@withContext emptyList()

        val jsonObject = JSONObject(body)
        val jsonArray = jsonObject.getJSONArray("sessions")
        val result = mutableListOf<SessionInfo>()

        for (i in 0 until jsonArray.length()) {
            val obj = jsonArray.getJSONObject(i)
            result.add(SessionInfo(
                name = obj.getString("name"),
                project = obj.optString("project", ""),
                branch = if (obj.has("branch") && !obj.isNull("branch")) obj.getString("branch") else null,
                path = obj.optString("path", ""),
                isWorktree = obj.optBoolean("isWorktree", false),
                windows = obj.optInt("windows", 0)
            ))
        }

        result.sortedWith(compareByDescending<SessionInfo> { it.windows > 0 }.thenBy { it.project })
    }

    private suspend fun fetchProjects(): Map<String, List<WorktreeInfo>> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$BASE_URL/api/worktrees")
            .get()
            .build()

        val response = client.newCall(request).execute()
        val body = response.body?.string() ?: return@withContext emptyMap()

        val jsonObject = JSONObject(body)
        val worktreesObj = jsonObject.getJSONObject("worktrees")
        val result = mutableMapOf<String, List<WorktreeInfo>>()

        val keys = worktreesObj.keys()
        while (keys.hasNext()) {
            val project = keys.next()
            val arr = worktreesObj.getJSONArray(project)
            val worktrees = mutableListOf<WorktreeInfo>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                worktrees.add(WorktreeInfo(
                    path = obj.optString("path", ""),
                    branch = obj.optString("branch", "main"),
                    commit = obj.optString("commit", ""),
                    isMain = obj.optBoolean("isMain", false),
                    project = project
                ))
            }
            result[project] = worktrees
        }

        result
    }

    data class ClaudeSessionData(
        val statuses: Map<String, String>,
        val updatedAtByTmux: Map<String, Long>,
        val updatedAtByProject: Map<String, Long>
    )

    private suspend fun fetchSessionStatuses(): ClaudeSessionData = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("$BASE_URL/api/claude-sessions")
                .get()
                .build()

            val response = client.newCall(request).execute()
            val body = response.body?.string() ?: return@withContext ClaudeSessionData(emptyMap(), emptyMap(), emptyMap())
            val json = JSONObject(body)
            val sessionsArray = json.optJSONArray("sessions") ?: return@withContext ClaudeSessionData(emptyMap(), emptyMap(), emptyMap())

            val statuses = mutableMapOf<String, String>()
            val updatedAtByTmux = mutableMapOf<String, Long>()
            val updatedAtByProject = mutableMapOf<String, Long>()
            val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)

            for (i in 0 until sessionsArray.length()) {
                val session = sessionsArray.getJSONObject(i)
                val tmuxSession = session.optString("tmuxSession", session.optString("tmux_session", ""))
                val projectName = session.optString("projectName", "")
                val status = session.optString("status", "idle")
                if (tmuxSession.isNotEmpty()) {
                    statuses[tmuxSession] = status
                }
                val updatedAtStr = session.optString("updatedAt", "")
                if (updatedAtStr.isNotEmpty()) {
                    try {
                        // Strip fractional seconds and Z suffix
                        val cleaned = updatedAtStr.substringBefore(".").substringBefore("Z")
                        val ms = isoFormat.parse(cleaned)?.time ?: 0L
                        if (tmuxSession.isNotEmpty()) {
                            val existing = updatedAtByTmux[tmuxSession] ?: 0L
                            if (ms > existing) updatedAtByTmux[tmuxSession] = ms
                        }
                        if (projectName.isNotEmpty()) {
                            val existing = updatedAtByProject[projectName] ?: 0L
                            if (ms > existing) updatedAtByProject[projectName] = ms
                        }
                    } catch (_: Exception) {}
                }
            }
            ClaudeSessionData(statuses, updatedAtByTmux, updatedAtByProject)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to fetch session statuses: ${e.message}")
            ClaudeSessionData(emptyMap(), emptyMap(), emptyMap())
        }
    }

    /**
     * Detect sessions that transitioned from working → waiting since last check.
     * Mark them as "newly ready" so they get highlighted.
     */
    private fun detectNewlyReady(newStatuses: Map<String, String>) {
        val prefs = requireContext().getSharedPreferences("homestead_session_status", android.content.Context.MODE_PRIVATE)
        val editor = prefs.edit()

        for ((sessionName, newStatus) in newStatuses) {
            val prevStatus = prefs.getString("status_$sessionName", null)
            val lastViewedTime = prefs.getLong("viewed_$sessionName", 0L)
            val statusChangeTime = prefs.getLong("status_change_$sessionName", 0L)

            Log.d(TAG, "detectNewlyReady: $sessionName prev=$prevStatus new=$newStatus viewing=$currentlyViewingSession")

            if (prevStatus == "working" && newStatus == "waiting") {
                // Just became ready! Mark the transition time
                val now = System.currentTimeMillis()
                editor.putLong("status_change_$sessionName", now)
                // If user hasn't viewed since it became ready, flag it
                if (lastViewedTime < now) {
                    newlyReadySessions.add(sessionName)
                    // Send notification if not currently viewing this session
                    if (sessionName != currentlyViewingSession) {
                        sendSessionReadyNotification(sessionName)
                    }
                }
            } else if (newStatus == "waiting" && statusChangeTime > lastViewedTime) {
                // Still waiting and not viewed since it became ready
                newlyReadySessions.add(sessionName)
            } else {
                newlyReadySessions.remove(sessionName)
            }

            editor.putString("status_$sessionName", newStatus)
        }
        editor.apply()
    }

    private fun sendSessionReadyNotification(sessionName: String) {
        if (!isAdded) return

        // Check notification permission (Android 13+)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(requireContext(), android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                return
            }
        }

        // Format the session name nicely: "holler-homestead--mobile-app" -> "homestead (mobile-app)"
        val displayName = formatSessionForNotification(sessionName)

        val intent = Intent(requireContext(), MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("open_session", sessionName)
        }
        val pendingIntent = PendingIntent.getActivity(
            requireContext(), sessionName.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(requireContext(), HomesteadApp.CHANNEL_SESSION_READY)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Session ready")
            .setContentText("$displayName is waiting for input")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        NotificationManagerCompat.from(requireContext())
            .notify(sessionName.hashCode(), notification)
    }

    private fun formatSessionForNotification(sessionName: String): String {
        // "holler-homestead--mobile-app" -> "homestead (mobile-app)"
        val stripped = sessionName.removePrefix("holler-")
        return if (stripped.contains("--")) {
            val parts = stripped.split("--", limit = 2)
            "${parts[0]} (${parts[1]})"
        } else {
            stripped
        }
    }

    /**
     * Call when user taps into a session — clears "newly ready" flag.
     */
    fun markSessionViewed(sessionName: String) {
        newlyReadySessions.remove(sessionName)
        val prefs = requireContext().getSharedPreferences("homestead_session_status", android.content.Context.MODE_PRIVATE)
        prefs.edit().putLong("viewed_$sessionName", System.currentTimeMillis()).apply()
    }

    private fun displayProjects() {
        sessionsContainer.removeAllViews()

        // Build a lookup: project -> branch -> session
        val sessionLookup = mutableMapOf<String, MutableMap<String, SessionInfo>>()
        for (session in sessions) {
            val proj = session.project
            if (!sessionLookup.containsKey(proj)) {
                sessionLookup[proj] = mutableMapOf()
            }
            val branch = session.branch ?: "main"
            sessionLookup[proj]!![branch] = session
        }

        if (allProjects.isEmpty()) {
            val emptyText = TextView(requireContext()).apply {
                text = "No projects found"
                setTextColor(colorTextSecondary)
                textSize = 15f
                typeface = fontBody
                gravity = Gravity.CENTER
                setPadding(0, 64, 0, 0)
            }
            sessionsContainer.addView(emptyText)
            return
        }

        // Separate active vs inactive
        val activeEntries = mutableListOf<Triple<String, List<WorktreeInfo>, Map<String, SessionInfo>>>()
        val inactiveEntries = mutableListOf<Triple<String, List<WorktreeInfo>, Map<String, SessionInfo>>>()

        for (entry in allProjects.entries.sortedBy { it.key }) {
            val project = entry.key
            val worktrees = entry.value
            val projectSessions = sessionLookup[project] ?: emptyMap()

            if (projectSessions.isNotEmpty()) {
                activeEntries.add(Triple(project, worktrees, projectSessions))
            } else {
                inactiveEntries.add(Triple(project, worktrees, projectSessions))
            }
        }

        // === ACTIVE SESSIONS — grouped by project, big cards ===
        // Sort: projects with newly-ready sessions float to top
        if (activeEntries.isNotEmpty()) {
            val sorted = activeEntries.sortedByDescending { (_, _, projectSessions) ->
                projectSessions.values.any { it.name in newlyReadySessions }
            }
            for ((project, worktrees, projectSessions) in sorted) {
                val projectCard = createActiveProjectCard(project, worktrees, projectSessions)
                sessionsContainer.addView(projectCard)
            }
        } else {
            val noActive = TextView(requireContext()).apply {
                text = "No active sessions"
                setTextColor(colorTextSecondary)
                textSize = 15f
                typeface = fontBody
                gravity = Gravity.CENTER
                setPadding(0, 40, 0, 24)
            }
            sessionsContainer.addView(noActive)
        }

        // === INACTIVE PROJECTS — accordion ===
        if (inactiveEntries.isNotEmpty()) {
            val inactiveContainer = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.VERTICAL
                visibility = View.GONE
            }

            // Populate inactive container
            for ((project, worktrees, _) in inactiveEntries) {
                // Project header
                val projectLabel = TextView(requireContext()).apply {
                    text = project
                    setTextColor(colorTextSecondary)
                    textSize = 14f
                    typeface = fontHeaderMedium
                    setPadding(4, 20, 0, 6)
                }
                inactiveContainer.addView(projectLabel)

                for (wt in worktrees) {
                    val card = createInactiveCard(project, wt)
                    inactiveContainer.addView(card)
                }
            }

            // Toggle button
            val toggleBg = GradientDrawable().apply {
                setColor(colorSurface)
                cornerRadius = 10f
                setStroke(1, colorBorder)
            }
            val toggleText = TextView(requireContext()).apply {
                text = "\u25BC  All Projects (${inactiveEntries.size})"
                setTextColor(colorTextSecondary)
                textSize = 13f
                typeface = fontBodyMedium
                background = toggleBg
                gravity = Gravity.CENTER
                setPadding(0, 20, 0, 20)
                val params = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                params.setMargins(0, 32, 0, 8)
                layoutParams = params
                setOnClickListener {
                    if (inactiveContainer.visibility == View.GONE) {
                        inactiveContainer.visibility = View.VISIBLE
                        this.text = "\u25B2  Hide Projects"
                    } else {
                        inactiveContainer.visibility = View.GONE
                        this.text = "\u25BC  All Projects (${inactiveEntries.size})"
                    }
                }
            }

            sessionsContainer.addView(toggleText)
            sessionsContainer.addView(inactiveContainer)
        }
    }

    private fun createActiveProjectCard(
        project: String,
        worktrees: List<WorktreeInfo>,
        projectSessions: Map<String, SessionInfo>
    ): View {
        val cardBg = GradientDrawable().apply {
            setColor(Color.parseColor("#1C1C1C"))
            cornerRadius = 16f
            setStroke(2, Color.parseColor("#2D4A1A"))
        }

        val outerCard = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            background = cardBg
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            params.setMargins(0, 8, 0, 8)
            layoutParams = params
        }

        // Project header
        val projectLabel = TextView(requireContext()).apply {
            text = project
            setTextColor(colorTextPrimary)
            textSize = 16f
            typeface = fontHeader
            setPadding(12, 16, 0, 6)
        }
        outerCard.addView(projectLabel)

        // Each branch — big, chunky session cards
        for (worktree in worktrees) {
            val session = projectSessions[worktree.branch]
            val isActive = session != null

            if (isActive) {
                val isTargeted = session!!.name == activeSessionName
                val isNewlyReady = session.name in newlyReadySessions
                val status = sessionStatuses[session.name] ?: "idle"

                // === ACTIVE: prominent card, highlighted if targeted or newly ready ===
                val sessionBg = GradientDrawable().apply {
                    val bgColor = when {
                        isNewlyReady -> Color.parseColor("#0D2A1A")  // Green tint
                        isTargeted -> Color.parseColor("#1A2A1A")
                        else -> Color.parseColor("#181818")
                    }
                    setColor(bgColor)
                    cornerRadius = 14f
                    val borderColor = when {
                        isNewlyReady -> colorGreen
                        isTargeted -> colorAmber
                        else -> Color.parseColor("#2A2A2A")
                    }
                    setStroke(if (isNewlyReady || isTargeted) 2 else 1, borderColor)
                }

                val sessionCard = LinearLayout(requireContext()).apply {
                    orientation = LinearLayout.VERTICAL
                    background = sessionBg
                    val params = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    )
                    params.setMargins(4, 6, 4, 6)
                    layoutParams = params
                    isClickable = true
                    isFocusable = true
                    setOnClickListener { onSessionClick?.invoke(session) }
                }

                // Top row: branch name + buttons + menu
                val topRow = LinearLayout(requireContext()).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(20, 18, 12, 18)
                }

                val branchDot = TextView(requireContext()).apply {
                    text = if (isNewlyReady) "\u2B24" else "\u25CF"  // Bigger dot for newly ready
                    setTextColor(when {
                        isNewlyReady -> colorGreen
                        isTargeted -> colorAmber
                        else -> colorGreen
                    })
                    textSize = if (isNewlyReady) 12f else 10f
                    setPadding(0, 0, 14, 0)
                }
                topRow.addView(branchDot)

                val branchName = TextView(requireContext()).apply {
                    text = worktree.branch
                    setTextColor(when {
                        isNewlyReady -> colorGreen
                        isTargeted -> colorAmber
                        else -> colorCyan
                    })
                    textSize = 17f
                    typeface = fontHeader
                }
                topRow.addView(branchName)

                // "READY" badge for newly ready sessions
                if (isNewlyReady) {
                    val dp = resources.displayMetrics.density
                    val readyBadge = TextView(requireContext()).apply {
                        text = "READY"
                        textSize = 10f
                        setTextColor(Color.parseColor("#0D0D0D"))
                        typeface = fontHeader
                        letterSpacing = 0.1f
                        val badgeBg = GradientDrawable().apply {
                            setColor(colorGreen)
                            cornerRadius = 8 * dp
                        }
                        background = badgeBg
                        setPadding((10 * dp).toInt(), (3 * dp).toInt(), (10 * dp).toInt(), (3 * dp).toInt())
                        val params = LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.WRAP_CONTENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT
                        )
                        params.marginStart = (10 * dp).toInt()
                        layoutParams = params
                    }
                    topRow.addView(readyBadge)
                }

                // Spacer to push branch name left
                topRow.addView(View(requireContext()).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 0, 1f)
                })

                // Menu button in top-right
                val menuBg = GradientDrawable().apply {
                    setColor(Color.parseColor("#2A2A2A"))
                    cornerRadius = 12f
                }
                val menuBtn = TextView(requireContext()).apply {
                    text = "\u22EE"
                    setTextColor(colorTextSecondary)
                    textSize = 22f
                    background = menuBg
                    setPadding(20, 8, 20, 8)
                    gravity = Gravity.CENTER
                    setOnClickListener { view ->
                        showSessionMenu(view, session, worktree)
                    }
                }
                topRow.addView(menuBtn)

                sessionCard.addView(topRow)

                // "Active" indicator label if targeted
                if (isTargeted) {
                    val activeLabel = TextView(requireContext()).apply {
                        text = "\u25B8 INPUT TARGET"
                        setTextColor(colorAmber)
                        textSize = 9f
                        typeface = fontBodyMedium
                        letterSpacing = 0.15f
                        setPadding(48, 0, 0, 4)
                    }
                    sessionCard.addView(activeLabel)
                }

                // Big action buttons row
                val dp = resources.displayMetrics.density
                val buttonsRow = LinearLayout(requireContext()).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding((12 * dp).toInt(), (4 * dp).toInt(), (12 * dp).toInt(), (14 * dp).toInt())
                }

                // JOIN button — tap to navigate, hold to record walkie-talkie
                val isRecording = walkieTalkieSession == session.name
                val isSending = walkieTalkieSending == session.name
                val joinBg = GradientDrawable().apply {
                    val bgColor = when {
                        isRecording -> Color.parseColor("#FF3300")
                        isSending -> Color.parseColor("#994400")
                        else -> colorAmber
                    }
                    setColor(bgColor)
                    cornerRadius = 14 * dp
                }
                val joinBtn = TextView(requireContext()).apply {
                    text = when {
                        isRecording -> "\uD83C\uDF99  REC"
                        isSending -> "\u23F3  SENDING..."
                        else -> "\u25B6  JOIN"
                    }
                    setTextColor(when {
                        isRecording -> Color.WHITE
                        isSending -> Color.WHITE
                        else -> colorDarkBg
                    })
                    textSize = 16f
                    typeface = fontHeader
                    background = joinBg
                    setPadding((28 * dp).toInt(), (16 * dp).toInt(), (28 * dp).toInt(), (16 * dp).toInt())
                    gravity = Gravity.CENTER
                    letterSpacing = 0.05f
                    val params = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    params.setMargins((4 * dp).toInt(), 0, (4 * dp).toInt(), 0)
                    layoutParams = params
                }

                // Walkie-talkie gesture: tap = navigate, hold = record
                var holdTimer: Runnable? = null
                var isLongPress = false
                val handler = android.os.Handler(android.os.Looper.getMainLooper())

                @Suppress("ClickableViewAccessibility")
                joinBtn.setOnTouchListener { _, event ->
                    when (event.action) {
                        MotionEvent.ACTION_DOWN -> {
                            isLongPress = false
                            holdTimer = Runnable {
                                isLongPress = true
                                onWalkieTalkieStart?.invoke(session.name)
                            }
                            handler.postDelayed(holdTimer!!, 300)
                            true
                        }
                        MotionEvent.ACTION_UP -> {
                            if (isLongPress) {
                                // Was recording — stop and send
                                onWalkieTalkieStop?.invoke(session.name)
                            } else {
                                // Quick tap — navigate
                                holdTimer?.let { handler.removeCallbacks(it) }
                                onSessionClick?.invoke(session)
                            }
                            true
                        }
                        MotionEvent.ACTION_CANCEL -> {
                            holdTimer?.let { handler.removeCallbacks(it) }
                            if (isLongPress) {
                                onWalkieTalkieStop?.invoke(session.name)
                            }
                            true
                        }
                        else -> false
                    }
                }
                buttonsRow.addView(joinBtn)

                // SCREEN button — big, cyan, secondary action
                val screenBg = GradientDrawable().apply {
                    setColor(Color.parseColor("#0D3D4A"))
                    setStroke((2 * dp).toInt(), colorCyan)
                    cornerRadius = 14 * dp
                }
                val screenBtn = TextView(requireContext()).apply {
                    text = "\uD83D\uDCBB  SCREEN"
                    setTextColor(colorCyan)
                    textSize = 16f
                    typeface = fontHeader
                    background = screenBg
                    setPadding((24 * dp).toInt(), (16 * dp).toInt(), (24 * dp).toInt(), (16 * dp).toInt())
                    gravity = Gravity.CENTER
                    letterSpacing = 0.05f
                    val params = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    params.setMargins((4 * dp).toInt(), 0, (4 * dp).toInt(), 0)
                    layoutParams = params
                    setOnClickListener {
                        switchMacScreen(session)
                        activeSessionName = session.name
                        onActiveSessionChanged?.invoke(session.name)
                    }
                }
                buttonsRow.addView(screenBtn)

                sessionCard.addView(buttonsRow)

                outerCard.addView(sessionCard)
            } else {
                // === INACTIVE: small subtle row ===
                val inactiveRow = LinearLayout(requireContext()).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(28, 10, 16, 10)
                }

                val branchLabel = TextView(requireContext()).apply {
                    text = worktree.branch
                    setTextColor(Color.parseColor("#555555"))
                    textSize = 13f
                    typeface = fontBody
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                }
                inactiveRow.addView(branchLabel)

                val startBtn = createActionButton("Start", Color.parseColor("#555555")) {
                    startSession(project, worktree)
                }
                inactiveRow.addView(startBtn)

                outerCard.addView(inactiveRow)
            }
        }

        // Bottom padding
        outerCard.addView(View(requireContext()).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 8
            )
        })

        return outerCard
    }

    private fun createInactiveCard(project: String, worktree: WorktreeInfo): View {
        val cardBg = GradientDrawable().apply {
            setColor(colorSurface)
            cornerRadius = 10f
        }

        val card = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            background = cardBg
            setPadding(20, 14, 16, 14)
            gravity = Gravity.CENTER_VERTICAL
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            params.setMargins(0, 3, 0, 3)
            layoutParams = params
        }

        val branchText = TextView(requireContext()).apply {
            text = worktree.branch
            setTextColor(colorTextSecondary)
            textSize = 14f
            typeface = fontBody
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        card.addView(branchText)

        val startBtn = createActionButton("Start", colorAmber) {
            startSession(project, worktree)
        }
        card.addView(startBtn)

        return card
    }

    private fun createActionButton(label: String, color: Int, onClick: () -> Unit): TextView {
        val bg = GradientDrawable().apply {
            setColor(Color.TRANSPARENT)
            setStroke(1, color)
            cornerRadius = 8f
        }

        return TextView(requireContext()).apply {
            text = label
            setTextColor(color)
            textSize = 12f
            typeface = fontBodyMedium
            background = bg
            setPadding(20, 8, 20, 8)
            gravity = Gravity.CENTER
            setOnClickListener { onClick() }
        }
    }

    private fun switchMacScreen(session: SessionInfo) {
        val urlParam = if (session.isWorktree) session.name else session.project
        val path = "/session/${java.net.URLEncoder.encode(urlParam, "UTF-8")}/terminal"

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val json = JSONObject().apply {
                        put("path", path)
                    }
                    val requestBody = json.toString()
                        .toRequestBody("application/json".toMediaTypeOrNull())
                    val request = Request.Builder()
                        .url("$BASE_URL/api/navigate")
                        .post(requestBody)
                        .build()
                    client.newCall(request).execute()
                }
                Toast.makeText(requireContext(), "Switched screen", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to switch screen: ${e.message}", e)
                Toast.makeText(requireContext(), "Failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showSessionMenu(anchor: View, session: SessionInfo, worktree: WorktreeInfo) {
        val popup = android.widget.PopupMenu(requireContext(), anchor)
        popup.menu.add(0, 1, 0, "Stop Session")
        if (session.isWorktree) {
            popup.menu.add(0, 2, 1, "Destroy (Stop + Delete Worktree)")
        }
        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> {
                    confirmStopSession(session)
                    true
                }
                2 -> {
                    confirmDestroySession(session)
                    true
                }
                else -> false
            }
        }
        popup.show()
    }

    private fun confirmDestroySession(session: SessionInfo) {
        val dialog = AlertDialog.Builder(requireContext(), R.style.Theme_Homestead_Dialog)
            .setTitle("Destroy Session")
            .setMessage("Kill session AND delete worktree for ${session.name}?\n\nThis will remove the worktree directory.")
            .setPositiveButton("Destroy") { d, _ ->
                d.dismiss()
                destroySession(session)
            }
            .setNegativeButton("Cancel") { d, _ -> d.dismiss() }
            .create()

        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(colorRed)
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.setTextColor(colorTextSecondary)
    }

    private fun destroySession(session: SessionInfo) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val request = Request.Builder()
                        .url("$BASE_URL/api/sessions?session=${session.name}&destroyWorktree=true&deleteBranch=false")
                        .delete()
                        .build()
                    client.newCall(request).execute()
                }
                Toast.makeText(requireContext(), "Destroyed ${session.name}", Toast.LENGTH_SHORT).show()
                loadData()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to destroy session: ${e.message}", e)
                Toast.makeText(requireContext(), "Failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun confirmStopSession(session: SessionInfo) {
        val dialog = AlertDialog.Builder(requireContext(), R.style.Theme_Homestead_Dialog)
            .setTitle("Stop Session")
            .setMessage("Kill tmux session ${session.name}?")
            .setPositiveButton("Stop") { d, _ ->
                d.dismiss()
                stopSession(session)
            }
            .setNegativeButton("Cancel") { d, _ -> d.dismiss() }
            .create()

        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(colorRed)
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.setTextColor(colorTextSecondary)
    }

    private fun stopSession(session: SessionInfo) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val request = Request.Builder()
                        .url("$BASE_URL/api/sessions?session=${session.name}")
                        .delete()
                        .build()
                    client.newCall(request).execute()
                }
                Toast.makeText(requireContext(), "Stopped ${session.name}", Toast.LENGTH_SHORT).show()
                loadData()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to stop session: ${e.message}", e)
                Toast.makeText(requireContext(), "Failed to stop: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun startSession(project: String, worktree: WorktreeInfo) {
        Toast.makeText(requireContext(), "Starting ${project}/${worktree.branch}...", Toast.LENGTH_SHORT).show()

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    val json = JSONObject().apply {
                        put("project", project)
                        put("mode", "continue")
                        if (!worktree.isMain) {
                            put("worktreePath", worktree.path)
                            put("branch", worktree.branch)
                        }
                    }

                    val requestBody = json.toString()
                        .toRequestBody("application/json".toMediaTypeOrNull())

                    val request = Request.Builder()
                        .url("$BASE_URL/api/sessions")
                        .post(requestBody)
                        .build()

                    val response = client.newCall(request).execute()
                    val body = response.body?.string() ?: "{}"
                    Pair(response.code, body)
                }

                val (code, body) = result
                if (code in 200..299) {
                    Toast.makeText(requireContext(), "Started!", Toast.LENGTH_SHORT).show()
                    loadData()
                } else if (code == 409) {
                    Toast.makeText(requireContext(), "Session already running", Toast.LENGTH_SHORT).show()
                    loadData()
                } else {
                    val error = try { JSONObject(body).optString("error", "Unknown error") } catch (_: Exception) { body }
                    Toast.makeText(requireContext(), "Error: $error", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start session: ${e.message}", e)
                Toast.makeText(requireContext(), "Failed: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showError(message: String) {
        val errorText = TextView(requireContext()).apply {
            text = message
            setTextColor(colorRed)
            textSize = 13f
            typeface = fontBody
            gravity = Gravity.CENTER
            setPadding(24, 24, 24, 24)
        }
        sessionsContainer.addView(errorText)
    }

    fun getSessions(): List<SessionInfo> = sessions
}
