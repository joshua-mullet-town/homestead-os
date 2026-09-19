package com.homestead.mobile

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Uploads audio to the Homestead server for transcription and direct sending to tmux session.
 */
class TranscriptionService {

    companion object {
        private const val TAG = "TranscriptionService"
        // Homestead server URL - using Tailscale hostname
        private const val BASE_URL = "https://joshuas-macbook-air.tail84bb3b.ts.net"
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(300, TimeUnit.SECONDS)
        .readTimeout(300, TimeUnit.SECONDS)
        .build()

    data class TranscriptionResult(
        val success: Boolean,
        val transcript: String? = null,
        val error: String? = null,
        val verified: Boolean? = null
    )

    /**
     * Upload audio file for transcription and direct send to tmux session.
     * The server transcribes the audio and sends it directly to the specified session.
     *
     * @param audioFile The audio file to transcribe
     * @param sessionName The tmux session name to send to (e.g., "holler-homestead")
     * @return TranscriptionResult with success status and transcript or error
     */
    suspend fun transcribeAndSend(audioFile: File, sessionName: String): TranscriptionResult {
        return withContext(Dispatchers.IO) {
            try {
                Log.d(TAG, "Uploading audio: ${audioFile.length()} bytes to session: $sessionName")

                val requestBody = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart(
                        "audio",
                        audioFile.name,
                        audioFile.asRequestBody("audio/mp4".toMediaType())
                    )
                    .addFormDataPart("session", sessionName)
                    .build()

                val request = Request.Builder()
                    .url("$BASE_URL/api/transcribe-and-send")
                    .post(requestBody)
                    .build()

                val response = client.newCall(request).execute()
                val responseBody = response.body?.string()

                Log.d(TAG, "Response: ${response.code} - $responseBody")

                if (responseBody != null) {
                    val json = JSONObject(responseBody)
                    val success = json.optBoolean("success", false)
                    val transcript = if (json.has("transcript") && !json.isNull("transcript"))
                        json.getString("transcript") else null
                    val error = if (json.has("error") && !json.isNull("error"))
                        json.getString("error") else null

                    if (success && transcript != null) {
                        val verified = if (json.has("verified")) json.optBoolean("verified", false) else null
                        Log.d(TAG, "Transcription successful (verified=$verified): $transcript")
                        TranscriptionResult(success = true, transcript = transcript, verified = verified)
                    } else {
                        Log.e(TAG, "Transcription failed: $error")
                        TranscriptionResult(success = false, error = error ?: "Unknown error")
                    }
                } else {
                    TranscriptionResult(success = false, error = "Empty response")
                }

            } catch (e: Exception) {
                Log.e(TAG, "Upload failed: ${e.message}", e)
                TranscriptionResult(success = false, error = e.message ?: "Network error")
            }
        }
    }

    /**
     * Transcribe audio WITHOUT sending it to any session.
     * Used for the "peek" feature to preview what's been recorded.
     */
    suspend fun transcribeOnly(audioFile: File): TranscriptionResult {
        return withContext(Dispatchers.IO) {
            try {
                Log.d(TAG, "Transcribe-only: ${audioFile.length()} bytes")

                val requestBody = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart(
                        "audio",
                        audioFile.name,
                        audioFile.asRequestBody("audio/mp4".toMediaType())
                    )
                    .build()

                val request = Request.Builder()
                    .url("$BASE_URL/api/transcribe")
                    .post(requestBody)
                    .build()

                val response = client.newCall(request).execute()
                val responseBody = response.body?.string()

                Log.d(TAG, "Transcribe-only response: ${response.code} - $responseBody")

                if (responseBody != null) {
                    val json = JSONObject(responseBody)
                    val success = json.optBoolean("success", false)
                    val transcript = if (json.has("transcript") && !json.isNull("transcript"))
                        json.getString("transcript") else null

                    if (success && transcript != null) {
                        TranscriptionResult(success = true, transcript = transcript)
                    } else {
                        val error = if (json.has("error") && !json.isNull("error"))
                            json.getString("error") else "Unknown error"
                        TranscriptionResult(success = false, error = error)
                    }
                } else {
                    TranscriptionResult(success = false, error = "Empty response")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Transcribe-only failed: ${e.message}", e)
                TranscriptionResult(success = false, error = e.message ?: "Network error")
            }
        }
    }

    /**
     * Send raw key sequence to a tmux session (for special keys like Escape, Ctrl+C, etc).
     * Uses the send-key API endpoint which doesn't add Enter.
     *
     * @param key The raw key/escape sequence to send
     * @param sessionName The tmux session name (e.g., "holler-homestead")
     * @return TranscriptionResult with success status
     */
    suspend fun sendRawToSession(key: String, sessionName: String): TranscriptionResult {
        return withContext(Dispatchers.IO) {
            try {
                Log.d(TAG, "Sending raw key to session: $sessionName")

                val json = JSONObject().apply {
                    put("sessionId", sessionName)
                    put("key", key)
                }

                val requestBody = okhttp3.RequestBody.create(
                    "application/json".toMediaType(),
                    json.toString()
                )

                val request = Request.Builder()
                    .url("$BASE_URL/api/sessions/send-key")
                    .post(requestBody)
                    .build()

                val response = client.newCall(request).execute()
                val responseBody = response.body?.string()

                Log.d(TAG, "Response: ${response.code} - $responseBody")

                if (response.isSuccessful && responseBody != null) {
                    val responseJson = JSONObject(responseBody)
                    val success = responseJson.optBoolean("success", false)
                    if (success) {
                        TranscriptionResult(success = true, transcript = key)
                    } else {
                        val error = responseJson.optString("error", "Unknown error")
                        TranscriptionResult(success = false, error = error)
                    }
                } else {
                    val error = if (responseBody != null) {
                        try {
                            JSONObject(responseBody).optString("error", "Request failed")
                        } catch (e: Exception) {
                            "Request failed: ${response.code}"
                        }
                    } else {
                        "Request failed: ${response.code}"
                    }
                    TranscriptionResult(success = false, error = error)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Send raw key failed: ${e.message}", e)
                TranscriptionResult(success = false, error = e.message ?: "Network error")
            }
        }
    }

    /**
     * Inject a text message into a tmux session (types it + presses Enter).
     * Uses the inject-message API endpoint which handles shell escaping via temp files.
     */
    suspend fun injectMessage(message: String, sessionName: String): TranscriptionResult {
        return withContext(Dispatchers.IO) {
            try {
                Log.d(TAG, "Injecting message to session: $sessionName")

                val json = JSONObject().apply {
                    put("sessionId", sessionName)
                    put("message", message)
                }

                val requestBody = okhttp3.RequestBody.create(
                    "application/json".toMediaType(),
                    json.toString()
                )

                val request = Request.Builder()
                    .url("$BASE_URL/api/sessions/inject-message")
                    .post(requestBody)
                    .build()

                val response = client.newCall(request).execute()
                val responseBody = response.body?.string()

                Log.d(TAG, "Inject response: ${response.code} - $responseBody")

                if (response.isSuccessful && responseBody != null) {
                    val responseJson = JSONObject(responseBody)
                    val success = responseJson.optBoolean("success", false)
                    if (success) {
                        val verified = if (responseJson.has("verified")) responseJson.optBoolean("verified", false) else null
                        Log.d(TAG, "Inject success (verified=$verified)")
                        TranscriptionResult(success = true, transcript = message, verified = verified)
                    } else {
                        val error = responseJson.optString("error", "Unknown error")
                        TranscriptionResult(success = false, error = error)
                    }
                } else {
                    val error = if (responseBody != null) {
                        try {
                            JSONObject(responseBody).optString("error", "Request failed")
                        } catch (e: Exception) {
                            "Request failed: ${response.code}"
                        }
                    } else {
                        "Request failed: ${response.code}"
                    }
                    TranscriptionResult(success = false, error = error)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Inject message failed: ${e.message}", e)
                TranscriptionResult(success = false, error = e.message ?: "Network error")
            }
        }
    }

    /**
     * Get the active session name from the Homestead WebView.
     * URL format: https://host/session/holler-project-name/...
     * The session name in the URL already includes "holler-" prefix.
     */
    fun getActiveSessionFromUrl(url: String?): String? {
        if (url == null) return null

        // URL format: /session/holler-project-name/...
        // The path segment already IS the session name (e.g., "holler-homestead--mobile-app")
        val regex = Regex("/session/([^/]+)")
        val match = regex.find(url)
        val sessionName = match?.groupValues?.get(1)

        Log.d(TAG, "Extracted session from URL '$url': $sessionName")
        return sessionName
    }
}
