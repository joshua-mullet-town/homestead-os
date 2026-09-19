package com.homestead.mobile

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import java.util.concurrent.TimeUnit

/**
 * RemoteFragment - Direct session control without WebView.
 *
 * Features:
 * - Session dropdown to select active tmux session
 * - Shows session status (active/idle)
 * - Allows sending text/voice directly to selected session
 */
class RemoteFragment : Fragment() {

    companion object {
        private const val TAG = "RemoteFragment"
        private const val BASE_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net"
    }

    private val colorAmber = Color.parseColor("#FFBF00")
    private val colorDarkBg = Color.parseColor("#121212")
    private val colorSurface = Color.parseColor("#1E1E1E")
    private val colorBorder = Color.parseColor("#333333")
    private val colorTextPrimary = Color.parseColor("#FFFFFF")
    private val colorTextSecondary = Color.parseColor("#AAAAAA")
    private val colorGreen = Color.parseColor("#4CAF50")
    private val colorRed = Color.parseColor("#F44336")

    private lateinit var rootLayout: LinearLayout
    private lateinit var sessionSpinner: Spinner
    private lateinit var statusText: TextView
    private lateinit var refreshButton: Button
    private lateinit var loadingIndicator: ProgressBar

    private var sessions: List<SessionInfo> = emptyList()
    private var selectedSession: SessionInfo? = null

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    data class SessionInfo(
        val name: String,
        val project: String,
        val branch: String?,
        val isActive: Boolean,
        val hasClaudeRunning: Boolean
    )

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        rootLayout = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(colorDarkBg)
            setPadding(32, 48, 32, 32)
        }

        // Title
        val titleText = TextView(requireContext()).apply {
            text = "Remote Control"
            setTextColor(colorAmber)
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 32)
        }
        rootLayout.addView(titleText)

        // Session selector card
        val sessionCard = createCard()

        val sessionLabel = TextView(requireContext()).apply {
            text = "SELECT SESSION"
            setTextColor(colorTextSecondary)
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, 12)
        }
        sessionCard.addView(sessionLabel)

        // Spinner container with border
        val spinnerContainer = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(colorSurface)
            setPadding(16, 8, 16, 8)
        }

        sessionSpinner = Spinner(requireContext()).apply {
            setBackgroundColor(Color.TRANSPARENT)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        spinnerContainer.addView(sessionSpinner)

        refreshButton = Button(requireContext()).apply {
            text = "↻"
            setTextColor(colorAmber)
            setBackgroundColor(Color.TRANSPARENT)
            textSize = 20f
            setPadding(16, 0, 0, 0)
            setOnClickListener { loadSessions() }
        }
        spinnerContainer.addView(refreshButton)

        sessionCard.addView(spinnerContainer)

        // Loading indicator
        loadingIndicator = ProgressBar(requireContext()).apply {
            visibility = View.GONE
            setPadding(0, 16, 0, 0)
        }
        sessionCard.addView(loadingIndicator)

        rootLayout.addView(sessionCard)

        // Status card
        val statusCard = createCard()

        val statusLabel = TextView(requireContext()).apply {
            text = "SESSION STATUS"
            setTextColor(colorTextSecondary)
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, 12)
        }
        statusCard.addView(statusLabel)

        statusText = TextView(requireContext()).apply {
            text = "No session selected"
            setTextColor(colorTextPrimary)
            textSize = 16f
        }
        statusCard.addView(statusText)

        rootLayout.addView(statusCard)

        // Instructions card
        val instructionsCard = createCard()

        val instructionsText = TextView(requireContext()).apply {
            text = "Use the MIC or TYPE buttons below to send input to the selected session."
            setTextColor(colorTextSecondary)
            textSize = 14f
            gravity = Gravity.CENTER
        }
        instructionsCard.addView(instructionsText)

        rootLayout.addView(instructionsCard)

        // Setup spinner listener
        sessionSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (position < sessions.size) {
                    selectedSession = sessions[position]
                    updateStatusDisplay()
                }
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {
                selectedSession = null
                updateStatusDisplay()
            }
        }

        // Load sessions on create
        loadSessions()

        return rootLayout
    }

    private fun createCard(): LinearLayout {
        return LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(colorSurface)
            setPadding(24, 24, 24, 24)
            val params = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            params.setMargins(0, 0, 0, 24)
            layoutParams = params
        }
    }

    private fun loadSessions() {
        loadingIndicator.visibility = View.VISIBLE
        refreshButton.isEnabled = false

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val fetchedSessions = fetchSessions()
                sessions = fetchedSessions

                withContext(Dispatchers.Main) {
                    loadingIndicator.visibility = View.GONE
                    refreshButton.isEnabled = true
                    updateSpinner()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load sessions: ${e.message}", e)
                withContext(Dispatchers.Main) {
                    loadingIndicator.visibility = View.GONE
                    refreshButton.isEnabled = true
                    Toast.makeText(context, "Failed to load sessions: ${e.message}", Toast.LENGTH_SHORT).show()
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

        // API returns {"sessions": [...]}
        val jsonObject = org.json.JSONObject(body)
        val jsonArray = jsonObject.getJSONArray("sessions")
        val result = mutableListOf<SessionInfo>()

        for (i in 0 until jsonArray.length()) {
            val obj = jsonArray.getJSONObject(i)
            val name = obj.getString("name")
            val project = obj.optString("project", name)
            val branch = if (obj.has("branch") && !obj.isNull("branch")) obj.getString("branch") else null
            val windows = obj.optInt("windows", 0)

            result.add(SessionInfo(
                name = name,
                project = project,
                branch = branch,
                isActive = windows > 0,  // Has windows means it's active
                hasClaudeRunning = false  // Will need separate API call to check this
            ))
        }

        result.sortedByDescending { it.isActive }
    }

    private fun updateSpinner() {
        val displayNames = sessions.map { session ->
            val branchPart = session.branch?.let { " ($it)" } ?: ""
            val statusIcon = when {
                session.hasClaudeRunning -> "🤖"
                session.isActive -> "●"
                else -> "○"
            }
            "$statusIcon ${session.project}$branchPart"
        }

        val adapter = object : ArrayAdapter<String>(
            requireContext(),
            android.R.layout.simple_spinner_item,
            displayNames
        ) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val view = super.getView(position, convertView, parent) as TextView
                view.setTextColor(colorTextPrimary)
                view.textSize = 16f
                return view
            }

            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View {
                val view = super.getDropDownView(position, convertView, parent) as TextView
                view.setTextColor(colorTextPrimary)
                view.setBackgroundColor(colorSurface)
                view.textSize = 16f
                view.setPadding(24, 16, 24, 16)
                return view
            }
        }

        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        sessionSpinner.adapter = adapter

        // Select first active session by default
        val activeIndex = sessions.indexOfFirst { it.isActive || it.hasClaudeRunning }
        if (activeIndex >= 0) {
            sessionSpinner.setSelection(activeIndex)
        }
    }

    private fun updateStatusDisplay() {
        val session = selectedSession
        if (session == null) {
            statusText.text = "No session selected"
            statusText.setTextColor(colorTextSecondary)
            return
        }

        val statusBuilder = StringBuilder()
        statusBuilder.append("Session: ${session.name}\n")

        if (session.hasClaudeRunning) {
            statusBuilder.append("Status: 🤖 Claude running\n")
            statusText.setTextColor(colorGreen)
        } else if (session.isActive) {
            statusBuilder.append("Status: ● Active\n")
            statusText.setTextColor(colorAmber)
        } else {
            statusBuilder.append("Status: ○ Idle\n")
            statusText.setTextColor(colorTextSecondary)
        }

        session.branch?.let {
            statusBuilder.append("Branch: $it")
        }

        statusText.text = statusBuilder.toString()
    }

    /**
     * Get the currently selected session name.
     * Used by MainActivity to know where to send voice/text input.
     */
    fun getSelectedSessionName(): String? {
        return selectedSession?.name
    }

    /**
     * Refresh sessions list.
     */
    fun refresh() {
        loadSessions()
    }
}
