package com.homestead.mobile

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object WedgeDiagLogger {
    private const val TAG = "WedgeDiag"
    private const val FILE_NAME = "wedge_log.txt"
    private const val MAX_BYTES = 200_000L
    private const val TRIM_TO_BYTES = 150_000L

    private val lock = Any()
    private val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    fun log(context: Context?, event: String, detail: String = "") {
        val ctx = context?.applicationContext ?: return
        val line = buildString {
            append('[').append(ts.format(Date())).append("] ")
            append(event)
            if (detail.isNotEmpty()) append(" — ").append(detail)
            append('\n')
        }
        Log.d(TAG, line.trimEnd())
        synchronized(lock) {
            try {
                val f = File(ctx.filesDir, FILE_NAME)
                f.appendText(line)
                if (f.length() > MAX_BYTES) {
                    val text = f.readText()
                    val keep = text.takeLast(TRIM_TO_BYTES.toInt())
                    val firstNewline = keep.indexOf('\n')
                    val trimmed = if (firstNewline >= 0) keep.substring(firstNewline + 1) else keep
                    f.writeText("=== log trimmed ${ts.format(Date())} ===\n" + trimmed)
                }
            } catch (e: Exception) {
                Log.w(TAG, "wedge-log write failed: ${e.message}")
            }
        }
    }
}
