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
const LOG_FILE = '/tmp/homestead-transcribe-send.log';

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
 * whisper-server requires WAV format
 */
async function convertToWav(audioBuffer: Buffer, inputFormat: string): Promise<Buffer> {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `input-${Date.now()}.${inputFormat}`);
  const outputPath = path.join(tempDir, `output-${Date.now()}.wav`);

  try {
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

    const wavBuffer = fs.readFileSync(outputPath);
    log(`Converted to WAV: ${wavBuffer.length} bytes`);

    return wavBuffer;
  } finally {
    try { fs.unlinkSync(inputPath); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
  }
}

/**
 * Try to transcribe using the local whisper-cpp server
 */
async function tryLocalWhisper(audioBuffer: Buffer, mimeType: string): Promise<string | null> {
  log(`tryLocalWhisper called, buffer size: ${audioBuffer.length}, type: ${mimeType}`);

  try {
    // Check if whisper-server is running
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

    // Convert to WAV
    let wavBuffer: Buffer;
    if (mimeType.includes('wav')) {
      wavBuffer = audioBuffer;
    } else if (mimeType.includes('webm') || mimeType.includes('opus') || mimeType.includes('ogg')) {
      wavBuffer = await convertToWav(audioBuffer, 'webm');
    } else if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac')) {
      wavBuffer = await convertToWav(audioBuffer, 'mp4');
    } else if (mimeType.includes('3gp') || mimeType.includes('amr')) {
      // Android often records in 3gp/amr format
      wavBuffer = await convertToWav(audioBuffer, '3gp');
    } else {
      log(`Unknown audio format: ${mimeType}, attempting generic conversion...`);
      wavBuffer = await convertToWav(audioBuffer, 'webm');
    }

    // Create FormData with WAV
    const wavBlob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });
    const wavFile = new File([wavBlob], 'audio.wav', { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', wavFile, 'audio.wav');
    log(`Posting to ${LOCAL_WHISPER_URL}`);

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

    if (result.error) {
      log(`Local whisper returned error: ${result.error}`);
      return null;
    }

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

/**
 * Verify a message was delivered by checking the tmux pane content.
 * Polls at 1s, 3s, 6s — returns true as soon as the message is found.
 */
async function verifyDelivery(
  sessionId: string,
  message: string
): Promise<boolean> {
  const needle = message.substring(0, 80).trim();
  if (!needle) return true;

  const delays = [1000, 2000, 3000]; // Check at 1s, 3s, 6s cumulative
  for (const delay of delays) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t "${sessionId}" -p -S -50`
      );
      if (stdout.includes(needle)) return true;
    } catch {
      // tmux error, keep trying
    }
  }
  return false;
}

/**
 * Send text to tmux session via tmux send-keys command
 */
async function sendToTmuxSession(sessionName: string, text: string): Promise<boolean> {
  try {
    // Escape single quotes for shell
    const escapedText = text.replace(/'/g, "'\\''");

    // Send text to tmux session
    const sendCmd = `tmux send-keys -t "${sessionName}" '${escapedText}'`;
    log(`Sending to tmux: ${sendCmd}`);
    await execAsync(sendCmd);

    // Wait for text to fully render before sending Enter
    // This prevents the issue where Enter is sent before text appears
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Send Enter key
    const enterCmd = `tmux send-keys -t "${sessionName}" Enter`;
    await execAsync(enterCmd);

    log(`Successfully sent to tmux session: ${sessionName}`);
    return true;
  } catch (error) {
    log(`Failed to send to tmux: ${error instanceof Error ? error.message : 'unknown'}`);
    return false;
  }
}

export async function POST(req: NextRequest) {
  log('=== POST /api/transcribe-and-send called ===');

  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    const sessionName = formData.get('session') as string;

    if (!audioFile) {
      log('ERROR: No audio file provided');
      return NextResponse.json({
        success: false,
        error: 'No audio file provided'
      }, { status: 400 });
    }

    if (!sessionName) {
      log('ERROR: No session name provided');
      return NextResponse.json({
        success: false,
        error: 'No session name provided'
      }, { status: 400 });
    }

    log(`Audio: size=${audioFile.size}, type=${audioFile.type}, session=${sessionName}`);

    const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
    const mimeType = audioFile.type || 'audio/webm';

    const transcript = await tryLocalWhisper(audioBuffer, mimeType);

    if (transcript === null) {
      log('Local whisper failed');
      return NextResponse.json({
        success: false,
        error: 'Transcription failed',
        details: 'Local whisper server unavailable. Is Whisper Village running?'
      }, { status: 503 });
    }

    if (!transcript || transcript.trim() === '') {
      log('Transcription returned empty');
      return NextResponse.json({
        success: false,
        error: 'No speech detected'
      }, { status: 200 });
    }

    // Fire-and-forget: log to Whisper Village history
    fetch('http://localhost:8179/log-transcription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: transcript, duration: 0, source: 'phone' }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => { /* ignore - Whisper Village may not be running */ });

    // Send directly to tmux session
    const sent = await sendToTmuxSession(sessionName, transcript);

    if (!sent) {
      return NextResponse.json({
        success: false,
        error: 'Failed to send to session',
        transcript: transcript
      }, { status: 500 });
    }

    // Verify delivery by checking conversation file
    const verified = await verifyDelivery(sessionName, transcript);
    log(`Verified delivery: ${verified}`);

    log(`Success: transcribed and sent to ${sessionName}: "${transcript}"`);
    return NextResponse.json({
      success: true,
      transcript: transcript,
      session: sessionName,
      verified
    });

  } catch (error) {
    log(`ERROR: ${error instanceof Error ? error.message : 'unknown'}`);
    console.error('Transcribe-and-send error:', error);
    return NextResponse.json({
      success: false,
      error: 'Internal error',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
