package com.homestead.mobile

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

class RecordingHistoryManager(private val context: Context) {

    companion object {
        private const val TAG = "RecordingHistory"
        private const val HISTORY_FILE = "recording_history.json"
        private const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000 // 7 days
    }

    enum class MessageType { AUDIO, TEXT }

    data class Recording(
        val id: String,
        val filePath: String,       // audio file path (empty string for TEXT type)
        val timestamp: Long,
        val type: MessageType = MessageType.AUDIO,
        val text: String? = null,   // original typed text (for TEXT type) or transcript
        val transcript: String? = null,
        val destination: String? = null,
        val sendStatus: SendStatus = SendStatus.UNSENT
    ) {
        enum class SendStatus { UNSENT, SENT, FAILED }
    }

    private val historyFile get() = File(context.filesDir, HISTORY_FILE)

    fun save(audioFile: File, transcript: String? = null): Recording {
        // Copy audio to persistent storage (cache files may be cleaned up)
        val recordingsDir = File(context.filesDir, "recordings").apply { mkdirs() }
        val id = UUID.randomUUID().toString().take(12)
        val persistentFile = File(recordingsDir, "rec_${id}.m4a")
        audioFile.copyTo(persistentFile, overwrite = true)

        val recording = Recording(
            id = id,
            filePath = persistentFile.absolutePath,
            timestamp = System.currentTimeMillis(),
            transcript = transcript
        )

        val history = loadAll().toMutableList()
        history.add(0, recording)
        saveAll(history)
        cleanup()

        Log.d(TAG, "Saved recording $id (transcript=${transcript?.take(30)})")
        return recording
    }

    fun saveText(text: String): Recording {
        val id = UUID.randomUUID().toString().take(12)
        val recording = Recording(
            id = id,
            filePath = "",
            timestamp = System.currentTimeMillis(),
            type = MessageType.TEXT,
            text = text
        )
        val history = loadAll().toMutableList()
        history.add(0, recording)
        saveAll(history)
        cleanup()
        Log.d(TAG, "Saved text message $id (${text.take(30)})")
        return recording
    }

    fun getRecent(limit: Int = 20): List<Recording> {
        return loadAll().take(limit)
    }

    fun getUnsent(): List<Recording> {
        return loadAll().filter { it.sendStatus == Recording.SendStatus.UNSENT }
    }

    fun markSent(id: String, destination: String) {
        val history = loadAll().toMutableList()
        val index = history.indexOfFirst { it.id == id }
        if (index >= 0) {
            history[index] = history[index].copy(
                destination = destination,
                sendStatus = Recording.SendStatus.SENT
            )
            saveAll(history)
            Log.d(TAG, "Marked $id as sent to $destination")
        }
    }

    fun markFailed(id: String) {
        val history = loadAll().toMutableList()
        val index = history.indexOfFirst { it.id == id }
        if (index >= 0) {
            history[index] = history[index].copy(sendStatus = Recording.SendStatus.FAILED)
            saveAll(history)
        }
    }

    fun updateTranscript(id: String, transcript: String) {
        val history = loadAll().toMutableList()
        val index = history.indexOfFirst { it.id == id }
        if (index >= 0) {
            history[index] = history[index].copy(transcript = transcript)
            saveAll(history)
        }
    }

    private fun cleanup() {
        val cutoff = System.currentTimeMillis() - MAX_AGE_MS
        val history = loadAll().toMutableList()
        val removed = history.filter { it.timestamp < cutoff }

        removed.forEach { rec ->
            File(rec.filePath).delete()
            Log.d(TAG, "Cleaned up old recording ${rec.id}")
        }

        if (removed.isNotEmpty()) {
            saveAll(history.filter { it.timestamp >= cutoff })
        }
    }

    private fun loadAll(): List<Recording> {
        if (!historyFile.exists()) return emptyList()
        return try {
            val json = JSONArray(historyFile.readText())
            (0 until json.length()).map { i ->
                val obj = json.getJSONObject(i)
                Recording(
                    id = obj.getString("id"),
                    filePath = obj.optString("filePath", ""),
                    timestamp = obj.getLong("timestamp"),
                    type = try {
                        MessageType.valueOf(obj.optString("type", "AUDIO"))
                    } catch (e: Exception) { MessageType.AUDIO },
                    text = if (obj.isNull("text")) null else obj.optString("text"),
                    transcript = if (obj.isNull("transcript")) null else obj.optString("transcript"),
                    destination = if (obj.isNull("destination")) null else obj.optString("destination"),
                    sendStatus = try {
                        Recording.SendStatus.valueOf(obj.optString("sendStatus", "UNSENT"))
                    } catch (e: Exception) {
                        Recording.SendStatus.UNSENT
                    }
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load history: ${e.message}")
            emptyList()
        }
    }

    private fun saveAll(recordings: List<Recording>) {
        try {
            val json = JSONArray()
            recordings.forEach { rec ->
                json.put(JSONObject().apply {
                    put("id", rec.id)
                    put("filePath", rec.filePath)
                    put("timestamp", rec.timestamp)
                    put("type", rec.type.name)
                    put("text", rec.text ?: JSONObject.NULL)
                    put("transcript", rec.transcript ?: JSONObject.NULL)
                    put("destination", rec.destination ?: JSONObject.NULL)
                    put("sendStatus", rec.sendStatus.name)
                })
            }
            historyFile.writeText(json.toString(2))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save history: ${e.message}")
        }
    }
}
