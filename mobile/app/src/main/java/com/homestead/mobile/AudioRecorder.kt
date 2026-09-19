package com.homestead.mobile

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Records audio to a file for upload to the Homestead transcription server.
 * Supports peek snapshots: stop/restart to get a preview without losing audio.
 * All segments are tracked and concatenated on final stop.
 */
class AudioRecorder(private val context: Context) {

    companion object {
        private const val TAG = "AudioRecorder"
    }

    private var mediaRecorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var isRecording = false

    // Segments from peek snapshots — accumulated pre-peek audio
    private val priorSegments = mutableListOf<File>()

    /**
     * Start recording audio
     * @return The file where audio is being recorded, or null on failure
     */
    fun startRecording(): File? {
        if (isRecording) {
            Log.w(TAG, "Already recording")
            return outputFile
        }

        try {
            // Create output file
            outputFile = File(context.cacheDir, "recording_${System.currentTimeMillis()}.m4a")

            mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }

            mediaRecorder?.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(16000)  // 16kHz is optimal for Whisper
                setAudioEncodingBitRate(64000)
                setOutputFile(outputFile?.absolutePath)

                prepare()
                start()
            }

            isRecording = true
            Log.d(TAG, "Started recording to ${outputFile?.absolutePath}")
            return outputFile

        } catch (e: Exception) {
            Log.e(TAG, "Failed to start recording: ${e.message}", e)
            cleanup()
            return null
        }
    }

    /**
     * Snapshot for peek: stop recording, save current segment, restart immediately.
     * Returns a copy of the current segment for transcription preview.
     * The segment is preserved so final stopRecording() includes ALL audio.
     */
    fun snapshotForPeek(): File? {
        if (!isRecording) {
            Log.w(TAG, "Not recording — can't snapshot")
            return null
        }

        try {
            // Stop the current recorder
            mediaRecorder?.apply {
                stop()
                release()
            }
            mediaRecorder = null
            isRecording = false

            val segmentFile = outputFile
            if (segmentFile == null || !segmentFile.exists() || segmentFile.length() == 0L) {
                Log.w(TAG, "Snapshot segment empty or missing")
                // Restart recording anyway
                startRecording()
                return null
            }

            // Save this segment for later concatenation
            priorSegments.add(segmentFile)
            Log.d(TAG, "Peek snapshot saved: ${segmentFile.absolutePath} (${segmentFile.length()} bytes), total segments: ${priorSegments.size}")

            // Copy for peek transcription (caller can delete this copy)
            val peekCopy = File(context.cacheDir, "peek_${System.currentTimeMillis()}.m4a")
            segmentFile.copyTo(peekCopy, overwrite = true)

            // Restart recording immediately
            startRecording()

            return peekCopy

        } catch (e: Exception) {
            Log.e(TAG, "Snapshot failed: ${e.message}", e)
            // Try to restart recording
            try { startRecording() } catch (_: Exception) {}
            return null
        }
    }

    /**
     * Stop recording and return the complete audio file (all segments concatenated).
     * @return The recorded audio file containing ALL audio including pre-peek segments, or null if not recording
     */
    fun stopRecording(): File? {
        if (!isRecording) {
            Log.w(TAG, "Not recording")
            return null
        }

        try {
            mediaRecorder?.apply {
                stop()
                release()
            }
            mediaRecorder = null
            isRecording = false

            val currentFile = outputFile
            Log.d(TAG, "Stopped recording, file size: ${currentFile?.length()} bytes")

            // If no prior segments, just return the current file (common case — no peeks)
            if (priorSegments.isEmpty()) {
                return currentFile
            }

            // Concatenate all segments + current into one file
            val allSegments = mutableListOf<File>()
            allSegments.addAll(priorSegments)
            if (currentFile != null && currentFile.exists() && currentFile.length() > 0L) {
                allSegments.add(currentFile)
            }

            if (allSegments.size == 1) {
                priorSegments.clear()
                return allSegments[0]
            }

            val merged = concatenateM4AFiles(allSegments)

            // Clean up individual segments
            for (seg in priorSegments) {
                seg.delete()
            }
            priorSegments.clear()
            currentFile?.delete()

            Log.d(TAG, "Merged ${allSegments.size} segments into ${merged?.length()} bytes")
            return merged

        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop recording: ${e.message}", e)
            cleanup()
            return null
        }
    }

    /**
     * Concatenate multiple M4A/AAC files by raw byte append.
     * Since all segments use identical codec settings (AAC, 16kHz, 64kbps, MPEG-4),
     * we re-wrap them using Android's MediaMuxer for a clean container.
     * Fallback: raw concatenation which most server-side decoders (ffmpeg/Whisper) handle fine.
     */
    private fun concatenateM4AFiles(files: List<File>): File? {
        val merged = File(context.cacheDir, "merged_${System.currentTimeMillis()}.m4a")

        try {
            // Use MediaExtractor + MediaMuxer for proper concatenation
            val muxer = android.media.MediaMuxer(
                merged.absolutePath,
                android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
            )

            var trackIndex = -1
            var totalPresentationTimeUs = 0L

            for (file in files) {
                val extractor = android.media.MediaExtractor()
                extractor.setDataSource(file.absolutePath)

                if (extractor.trackCount == 0) {
                    extractor.release()
                    continue
                }

                extractor.selectTrack(0)
                val format = extractor.getTrackFormat(0)

                if (trackIndex == -1) {
                    trackIndex = muxer.addTrack(format)
                    muxer.start()
                }

                val bufferSize = 1024 * 1024
                val buffer = java.nio.ByteBuffer.allocate(bufferSize)
                val bufferInfo = android.media.MediaCodec.BufferInfo()

                while (true) {
                    val sampleSize = extractor.readSampleData(buffer, 0)
                    if (sampleSize < 0) break

                    bufferInfo.offset = 0
                    bufferInfo.size = sampleSize
                    bufferInfo.presentationTimeUs = totalPresentationTimeUs + extractor.sampleTime
                    bufferInfo.flags = extractor.sampleFlags

                    muxer.writeSampleData(trackIndex, buffer, bufferInfo)
                    extractor.advance()
                }

                // Get duration of this segment for offset calculation
                val durationUs = format.getLong(android.media.MediaFormat.KEY_DURATION)
                totalPresentationTimeUs += durationUs

                extractor.release()
            }

            if (trackIndex != -1) {
                muxer.stop()
            }
            muxer.release()

            Log.d(TAG, "Muxer concatenation successful: ${merged.length()} bytes")
            return merged

        } catch (e: Exception) {
            Log.w(TAG, "Muxer concatenation failed, falling back to raw append: ${e.message}")
            merged.delete()

            // Fallback: raw byte concatenation — works for server-side Whisper/ffmpeg
            return try {
                val fallback = File(context.cacheDir, "merged_raw_${System.currentTimeMillis()}.m4a")
                FileOutputStream(fallback).use { out ->
                    for (file in files) {
                        FileInputStream(file).use { input ->
                            input.copyTo(out)
                        }
                    }
                }
                Log.d(TAG, "Raw concatenation fallback: ${fallback.length()} bytes")
                fallback
            } catch (e2: Exception) {
                Log.e(TAG, "Raw concatenation also failed: ${e2.message}")
                // Last resort: return the largest segment
                files.maxByOrNull { it.length() }
            }
        }
    }

    /**
     * Cancel recording and delete the file
     */
    fun cancelRecording() {
        if (isRecording) {
            try {
                mediaRecorder?.apply {
                    stop()
                    release()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error stopping recorder: ${e.message}")
            }
        }
        cleanup()
        Log.d(TAG, "Recording cancelled")
    }

    /**
     * Check if currently recording
     */
    fun isRecording(): Boolean = isRecording

    /**
     * Get the current amplitude (0-32767) for visualization
     */
    fun getAmplitude(): Int {
        return if (isRecording) {
            try {
                mediaRecorder?.maxAmplitude ?: 0
            } catch (e: Exception) {
                0
            }
        } else {
            0
        }
    }

    private fun cleanup() {
        mediaRecorder?.release()
        mediaRecorder = null
        isRecording = false
        outputFile?.delete()
        outputFile = null
        // Clean up any prior segments too
        for (seg in priorSegments) {
            seg.delete()
        }
        priorSegments.clear()
    }

    /**
     * Teardown salvage. The Activity is going away (OS kill, rotation, wallpaper
     * change) while a take is still running.
     *
     * This used to call cancelRecording(), which routes into cleanup() and
     * DELETES outputFile plus every peek segment. That silently destroyed real
     * recordings: Joshua lost a message mid-sentence exactly this way. Stopping
     * a take is the OS's call; throwing the audio away is not.
     *
     * So finalize instead of discard, and hand the file back so the caller can
     * persist it. Returns null when nothing was in flight.
     */
    fun destroy(): File? {
        if (!isRecording) {
            cleanup()
            return null
        }
        val salvaged = try {
            stopRecording()
        } catch (e: Exception) {
            Log.e(TAG, "Salvage on destroy failed: ${e.message}", e)
            null
        }
        if (salvaged == null) {
            // stopRecording() already cleaned up on its failure path.
            Log.w(TAG, "Nothing salvageable on destroy")
        } else {
            Log.d(TAG, "Salvaged ${salvaged.length()} bytes on destroy")
        }
        return salvaged
    }
}
