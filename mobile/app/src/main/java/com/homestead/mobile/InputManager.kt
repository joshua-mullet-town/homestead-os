package com.homestead.mobile

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import java.util.*

/**
 * Manages text and voice input for Homestead.
 * - Text input: Opens keyboard, captures text
 * - Voice input: Uses Android's SpeechRecognizer for on-device transcription
 *
 * Voice input is manual-send: user must explicitly send after recording.
 * Supports pause/resume and accumulates transcription across segments.
 */
class InputManager(private val context: Context) {

    companion object {
        private const val TAG = "InputManager"
        private const val MAX_RECENT_MESSAGES = 10
    }

    // Speech recognition
    private var speechRecognizer: SpeechRecognizer? = null
    private var isListening = false

    // Accumulated transcription (user must manually send)
    private val transcriptionBuilder = StringBuilder()
    private var currentPartial = ""

    // Recent messages storage with timestamps
    data class RecentMessage(val text: String, val timestamp: Long)
    private val recentMessages = mutableListOf<RecentMessage>()

    // Callbacks
    var onTranscriptionStart: (() -> Unit)? = null
    var onTranscriptionResult: ((String) -> Unit)? = null  // Called when user manually sends
    var onTranscriptionError: ((String) -> Unit)? = null
    var onTranscriptionEnd: (() -> Unit)? = null
    var onPartialResult: ((String) -> Unit)? = null
    var onTranscriptionUpdate: ((String) -> Unit)? = null  // Called when accumulated text updates

    init {
        loadRecentMessages()
    }

    /**
     * Check if speech recognition is available on this device
     */
    fun isSpeechRecognitionAvailable(): Boolean {
        return SpeechRecognizer.isRecognitionAvailable(context)
    }

    /**
     * Start voice recognition session.
     * Clears any previous accumulated transcription.
     */
    fun startListening() {
        if (isListening) {
            Log.w(TAG, "Already listening")
            return
        }

        if (!isSpeechRecognitionAvailable()) {
            onTranscriptionError?.invoke("Speech recognition not available")
            return
        }

        // Clear previous transcription when starting fresh
        transcriptionBuilder.clear()
        currentPartial = ""

        startRecognizer()
        onTranscriptionStart?.invoke()
    }

    /**
     * Resume listening after a pause (continues accumulating)
     */
    fun resumeListening() {
        if (isListening) return
        startRecognizer()
    }

    private fun startRecognizer() {
        // Create recognizer
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(createRecognitionListener())
        }

        // Create intent for speech recognition
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // Prefer offline recognition if available
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }

        isListening = true
        speechRecognizer?.startListening(intent)
    }

    /**
     * Pause listening but keep accumulated transcription
     */
    fun pauseListening() {
        if (!isListening) return

        isListening = false
        speechRecognizer?.stopListening()
        speechRecognizer?.destroy()
        speechRecognizer = null
        // Don't clear transcription - user can resume or send
    }

    /**
     * Stop listening completely and clear transcription
     */
    fun stopListening() {
        pauseListening()
        transcriptionBuilder.clear()
        currentPartial = ""
        onTranscriptionEnd?.invoke()
    }

    /**
     * Cancel voice recognition and clear all accumulated text
     */
    fun cancelListening() {
        if (isListening) {
            speechRecognizer?.cancel()
            speechRecognizer?.destroy()
            speechRecognizer = null
            isListening = false
        }
        transcriptionBuilder.clear()
        currentPartial = ""
        onTranscriptionEnd?.invoke()
    }

    /**
     * Send the accumulated transcription (user manually triggers this)
     */
    fun sendTranscription() {
        pauseListening()

        val text = getFullTranscription()
        if (text.isNotBlank()) {
            addToRecentMessages(text)
            onTranscriptionResult?.invoke(text)
        }

        transcriptionBuilder.clear()
        currentPartial = ""
        onTranscriptionEnd?.invoke()
    }

    /**
     * Get the current accumulated transcription (for peek feature)
     */
    fun getFullTranscription(): String {
        val accumulated = transcriptionBuilder.toString().trim()
        val partial = currentPartial.trim()

        return if (accumulated.isNotEmpty() && partial.isNotEmpty()) {
            "$accumulated $partial"
        } else {
            accumulated + partial
        }
    }

    /**
     * Check if there's any transcription accumulated
     */
    fun hasTranscription(): Boolean = transcriptionBuilder.isNotEmpty() || currentPartial.isNotEmpty()

    fun isCurrentlyListening(): Boolean = isListening

    private fun createRecognitionListener(): RecognitionListener {
        return object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                Log.d(TAG, "Ready for speech")
            }

            override fun onBeginningOfSpeech() {
                Log.d(TAG, "Beginning of speech")
            }

            override fun onRmsChanged(rmsdB: Float) {
                // Could use this for visual feedback (volume indicator)
            }

            override fun onBufferReceived(buffer: ByteArray?) {
                // Raw audio buffer
            }

            override fun onEndOfSpeech() {
                Log.d(TAG, "End of speech")
            }

            override fun onError(error: Int) {
                val errorMessage = when (error) {
                    SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
                    SpeechRecognizer.ERROR_CLIENT -> "Client error"
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Insufficient permissions"
                    SpeechRecognizer.ERROR_NETWORK -> "Network error"
                    SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
                    SpeechRecognizer.ERROR_NO_MATCH -> "No speech detected"
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
                    SpeechRecognizer.ERROR_SERVER -> "Server error"
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech input"
                    else -> "Unknown error ($error)"
                }
                Log.e(TAG, "Speech recognition error: $errorMessage")

                isListening = false
                speechRecognizer?.destroy()
                speechRecognizer = null
                currentPartial = ""

                // On timeout/no-match, just pause - don't clear accumulated text
                // User can resume or send what they have
                if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    // Silently pause, user can resume
                    Log.d(TAG, "Speech paused (silence detected), accumulated: ${transcriptionBuilder.length} chars")
                } else {
                    onTranscriptionError?.invoke(errorMessage)
                }
            }

            override fun onResults(results: Bundle?) {
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val result = matches?.firstOrNull()

                isListening = false
                speechRecognizer?.destroy()
                speechRecognizer = null

                if (!result.isNullOrBlank()) {
                    Log.d(TAG, "Segment result: $result")

                    // Append to accumulated transcription
                    if (transcriptionBuilder.isNotEmpty()) {
                        transcriptionBuilder.append(" ")
                    }
                    transcriptionBuilder.append(result)
                    currentPartial = ""

                    // Notify of update (for UI)
                    onTranscriptionUpdate?.invoke(getFullTranscription())
                }

                // Don't auto-send! User must manually trigger sendTranscription()
                // Don't call onTranscriptionEnd either - session is still active
            }

            override fun onPartialResults(partialResults: Bundle?) {
                val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val partial = matches?.firstOrNull()
                if (!partial.isNullOrBlank()) {
                    currentPartial = partial
                    onPartialResult?.invoke(getFullTranscription())
                }
            }

            override fun onEvent(eventType: Int, params: Bundle?) {
                Log.d(TAG, "Recognition event: $eventType")
            }
        }
    }

    /**
     * Add a message to recent messages history
     */
    fun addToRecentMessages(message: String) {
        // Remove if same text already exists (to move to top with new timestamp)
        recentMessages.removeAll { it.text == message }
        // Add to beginning with current timestamp
        recentMessages.add(0, RecentMessage(message, System.currentTimeMillis()))
        // Trim to max size
        while (recentMessages.size > MAX_RECENT_MESSAGES) {
            recentMessages.removeAt(recentMessages.lastIndex)
        }
        saveRecentMessages()
    }

    /**
     * Get list of recent messages with timestamps
     */
    fun getRecentMessages(): List<RecentMessage> = recentMessages.toList()

    /**
     * Clear recent messages
     */
    fun clearRecentMessages() {
        recentMessages.clear()
        saveRecentMessages()
    }

    private fun loadRecentMessages() {
        val prefs = context.getSharedPreferences("homestead_input", Context.MODE_PRIVATE)
        val json = prefs.getString("recent_messages_json", null)
        recentMessages.clear()
        if (json != null) {
            try {
                val jsonArray = org.json.JSONArray(json)
                for (i in 0 until jsonArray.length()) {
                    val obj = jsonArray.getJSONObject(i)
                    recentMessages.add(RecentMessage(
                        text = obj.getString("text"),
                        timestamp = obj.getLong("timestamp")
                    ))
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load recent messages: ${e.message}")
            }
        }
    }

    private fun saveRecentMessages() {
        val prefs = context.getSharedPreferences("homestead_input", Context.MODE_PRIVATE)
        try {
            val jsonArray = org.json.JSONArray()
            recentMessages.forEach { msg ->
                val obj = org.json.JSONObject()
                obj.put("text", msg.text)
                obj.put("timestamp", msg.timestamp)
                jsonArray.put(obj)
            }
            prefs.edit().putString("recent_messages_json", jsonArray.toString()).apply()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save recent messages: ${e.message}")
        }
    }

    /**
     * Clean up resources
     */
    fun destroy() {
        cancelListening()
    }
}
