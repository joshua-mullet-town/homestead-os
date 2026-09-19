import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

export const runtime = 'nodejs';

// Local whisper-server configuration (launched by Whisper Village)
const LOCAL_WHISPER_URL = process.env.LOCAL_WHISPER_URL || 'http://localhost:8178/inference';

// Debug log file
const LOG_FILE = '/tmp/homestead-transcribe.log';

function log(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(line.trim());
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // ignore
  }
}

/**
 * Convert audio file to WAV format using ffmpeg
 * whisper-server requires WAV format, but browsers record WebM/Opus
 */
async function convertToWav(audioBuffer: Buffer, inputFormat: string): Promise<Buffer> {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `input-${Date.now()}.${inputFormat}`);
  const outputPath = path.join(tempDir, `output-${Date.now()}.wav`);

  try {
    // Write input file
    fs.writeFileSync(inputPath, audioBuffer);
    log(`Wrote temp input file: ${inputPath} (${audioBuffer.length} bytes)`);

    // Convert with ffmpeg: 16kHz mono WAV (optimal for Whisper)
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}" 2>&1`;
    log(`Running ffmpeg: ${ffmpegCmd}`);

    const { stdout, stderr } = await execAsync(ffmpegCmd);
    if (stderr && !fs.existsSync(outputPath)) {
      log(`ffmpeg error: ${stderr}`);
      throw new Error(`ffmpeg conversion failed: ${stderr}`);
    }

    // Read output file
    const wavBuffer = fs.readFileSync(outputPath);
    log(`Converted to WAV: ${wavBuffer.length} bytes`);

    return wavBuffer;
  } finally {
    // Cleanup temp files
    try { fs.unlinkSync(inputPath); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
  }
}

/**
 * Try to transcribe using the local whisper-cpp server
 * Returns null if the server is not available
 */
async function tryLocalWhisper(audioFile: File): Promise<string | null> {
  log(`tryLocalWhisper called, file size: ${audioFile.size}, name: ${audioFile.name}, type: ${audioFile.type}`);

  try {
    // Check if whisper-server is running first (quick health check)
    try {
      const healthCheck = await fetch(LOCAL_WHISPER_URL.replace('/inference', '/'), {
        method: 'GET',
        signal: AbortSignal.timeout(1000)
      });
      if (!healthCheck.ok) {
        log('Local whisper server health check failed');
        return null;
      }
    } catch (e) {
      log('Local whisper server not reachable');
      return null;
    }

    // Convert WebM/Opus to WAV (whisper-server requires WAV)
    const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
    let wavBuffer: Buffer;

    if (audioFile.type.includes('webm') || audioFile.type.includes('opus')) {
      log('Converting WebM/Opus to WAV...');
      wavBuffer = await convertToWav(audioBuffer, 'webm');
    } else if (audioFile.type.includes('mp4') || audioFile.type.includes('m4a')) {
      log('Converting MP4/M4A to WAV...');
      wavBuffer = await convertToWav(audioBuffer, 'mp4');
    } else if (audioFile.type.includes('wav')) {
      log('Audio is already WAV format');
      wavBuffer = audioBuffer;
    } else {
      log(`Unknown audio format: ${audioFile.type}, attempting conversion...`);
      wavBuffer = await convertToWav(audioBuffer, 'webm');
    }

    // Create a new File with the WAV data (convert Buffer to Uint8Array for Blob compatibility)
    const wavBlob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });
    const wavFile = new File([wavBlob], 'audio.wav', { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', wavFile, 'audio.wav');
    log(`FormData created with WAV file, posting to ${LOCAL_WHISPER_URL}`);

    // Longer timeout for transcription (model inference takes time)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);

    const response = await fetch(LOCAL_WHISPER_URL, {
      method: 'POST',
      body: formData,
      signal: controller.signal
    });

    clearTimeout(timeout);
    log(`Local whisper response status: ${response.status}`);

    if (!response.ok) {
      log(`Local whisper server returned error: ${response.status}`);
      return null;
    }

    const result = await response.json();
    log(`Local whisper result: ${JSON.stringify(result)}`);

    // Check for error in response
    if (result.error) {
      log(`Local whisper returned error: ${result.error}`);
      return null;
    }

    // whisper-server returns { text: "..." }
    if (result.text) {
      log(`Transcribed via local whisper-server: ${result.text.trim()}`);
      return result.text.trim();
    }

    return null;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      log('Local whisper server timeout');
    } else {
      log(`Local whisper server error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    return null;
  }
}

export async function POST(req: NextRequest) {
  log('=== POST /api/transcribe called ===');
  log(`Request URL: ${req.url}`);
  log(`Request method: ${req.method}`);

  try {
    // Get the form data
    log('Parsing formData...');
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    log(`formData parsed, audioFile: ${audioFile ? 'present' : 'missing'}`);

    if (!audioFile) {
      log('ERROR: No audio file provided');
      return NextResponse.json({
        success: false,
        error: 'No audio file provided'
      }, { status: 400 });
    }

    log(`Audio file received: size=${audioFile.size}, name=${audioFile.name}, type=${audioFile.type}`);

    const transcript = await tryLocalWhisper(audioFile);

    if (transcript === null) {
      log('Local whisper failed');
      return NextResponse.json({
        success: false,
        error: 'Transcription failed',
        details: 'Local whisper server unavailable. Is Whisper Village running?'
      }, { status: 503 });
    }

    // Fire-and-forget: log to Whisper Village history
    fetch('http://localhost:8179/log-transcription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: transcript, duration: 0, source: 'phone' }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => { /* ignore - Whisper Village may not be running */ });

    log(`Returning successful transcript: ${transcript}`);
    return NextResponse.json({
      success: true,
      transcript: transcript
    });

  } catch (error) {
    log(`ERROR in transcribe: ${error instanceof Error ? error.message : 'unknown'}`);
    console.error('Transcription error:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal transcription error',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
