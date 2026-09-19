import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

export const runtime = 'nodejs';

const PHONE_BASE_URL = process.env.PHONE_API_URL || 'http://<<REPLACE: your Tailscale IP>>:8888';
const LOCAL_WHISPER_URL = process.env.LOCAL_WHISPER_URL || 'http://localhost:8178/inference';
const LOG_FILE = '/tmp/homestead-pull-recordings.log';

function log(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(line.trim());
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) { /* ignore */ }
}

async function m4aToWav(m4aBuffer: Buffer): Promise<Buffer> {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `pull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`);
  const outputPath = path.join(tempDir, `pull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    fs.writeFileSync(inputPath, m4aBuffer);
    await execAsync(`ffmpeg -y -loglevel error -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}"`);
    return fs.readFileSync(outputPath);
  } finally {
    try { fs.unlinkSync(inputPath); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(outputPath); } catch (e) { /* ignore */ }
  }
}

async function transcribeWav(wavBuffer: Buffer): Promise<string | null> {
  const wavBlob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });
  const wavFile = new File([wavBlob], 'audio.wav', { type: 'audio/wav' });
  const formData = new FormData();
  formData.append('file', wavFile, 'audio.wav');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(LOCAL_WHISPER_URL, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    if (!response.ok) {
      log(`whisper error ${response.status}`);
      return null;
    }
    const result = await response.json() as { text?: string; error?: string };
    if (result.error) {
      log(`whisper returned: ${result.error}`);
      return null;
    }
    return (result.text || '').trim() || null;
  } catch (error) {
    log(`whisper failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

type PhoneRecording = {
  id: string;
  timestamp: number;
  type: string;
  sendStatus: string;
  transcript: string | null;
  text: string | null;
  destination: string | null;
  hasAudio: boolean;
  audioBytes: number;
  audioUrl: string | null;
};

async function listPhoneRecordings(): Promise<PhoneRecording[]> {
  const res = await fetch(`${PHONE_BASE_URL}/recordings`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`phone /recordings returned ${res.status}`);
  const json = await res.json() as { success: boolean; recordings?: PhoneRecording[]; error?: string };
  if (!json.success) throw new Error(json.error || 'phone returned success=false');
  return json.recordings || [];
}

async function fetchPhoneAudio(id: string): Promise<Buffer | null> {
  const res = await fetch(`${PHONE_BASE_URL}/recordings/${encodeURIComponent(id)}/audio`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    log(`audio fetch for ${id} returned ${res.status}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function markPhoneSent(id: string, destination: string, transcript: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${PHONE_BASE_URL}/recordings/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination, transcript }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch (e) {
    log(`mark-sent failed for ${id}: ${e instanceof Error ? e.message : 'unknown'}`);
    return false;
  }
}

/**
 * GET /api/pull-recordings
 *   Optional query: ?status=FAILED  (default: FAILED + UNSENT)
 *                   ?dryRun=true    (list only, do not transcribe)
 *
 * Lists candidates without acting.
 */
export async function GET(req: NextRequest) {
  log('=== GET /api/pull-recordings ===');
  try {
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get('status');
    const recordings = await listPhoneRecordings();
    const audioOnly = recordings.filter(r => r.type === 'AUDIO' && r.hasAudio);
    const candidates = statusFilter
      ? audioOnly.filter(r => r.sendStatus === statusFilter)
      : audioOnly.filter(r => r.sendStatus === 'FAILED' || r.sendStatus === 'UNSENT');
    return NextResponse.json({
      success: true,
      total: recordings.length,
      audio: audioOnly.length,
      candidates: candidates.length,
      recordings: candidates.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        sendStatus: r.sendStatus,
        audioBytes: r.audioBytes,
        existingTranscript: r.transcript,
      })),
    });
  } catch (error) {
    log(`GET error: ${error instanceof Error ? error.message : 'unknown'}`);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'unknown',
    }, { status: 500 });
  }
}

/**
 * POST /api/pull-recordings
 *   Body (optional):
 *     { ids?: string[]                 - specific recording IDs to pull
 *     , status?: 'FAILED' | 'UNSENT'   - filter by status (default: FAILED + UNSENT)
 *     , markSent?: boolean             - POST /recordings/:id/send after success (default: true)
 *     , destination?: string           - destination label written to phone history (default: "laptop-pull")
 *     }
 *
 * Pulls each candidate's audio over HTTP, transcribes locally, optionally
 * marks it as sent on the phone. Returns a digest of transcripts.
 */
export async function POST(req: NextRequest) {
  log('=== POST /api/pull-recordings ===');
  try {
    let body: {
      ids?: string[];
      status?: string;
      markSent?: boolean;
      destination?: string;
    } = {};
    try { body = await req.json(); } catch (e) { /* body optional */ }

    const markSent = body.markSent !== false;
    const destination = body.destination || 'laptop-pull';

    // Whisper health check
    try {
      const healthRes = await fetch(LOCAL_WHISPER_URL.replace('/inference', '/'), {
        signal: AbortSignal.timeout(2000),
      });
      if (!healthRes.ok) {
        return NextResponse.json({
          success: false,
          error: 'Local whisper-server health check failed',
          hint: 'Is whisper-server running on :8178? Check lsof -i:8178',
        }, { status: 503 });
      }
    } catch (e) {
      return NextResponse.json({
        success: false,
        error: 'Local whisper-server not reachable',
        hint: 'Is whisper-server running on :8178? Check lsof -i:8178',
      }, { status: 503 });
    }

    const all = await listPhoneRecordings();
    let candidates: PhoneRecording[];
    if (body.ids && body.ids.length > 0) {
      const wanted = new Set(body.ids);
      candidates = all.filter(r => wanted.has(r.id) && r.hasAudio && r.type === 'AUDIO');
    } else {
      const audioOnly = all.filter(r => r.type === 'AUDIO' && r.hasAudio);
      candidates = body.status
        ? audioOnly.filter(r => r.sendStatus === body.status)
        : audioOnly.filter(r => r.sendStatus === 'FAILED' || r.sendStatus === 'UNSENT');
    }

    log(`Pulling ${candidates.length} candidate(s) from phone`);

    const results: Array<{
      id: string;
      timestamp: number;
      ok: boolean;
      transcript?: string;
      error?: string;
      marked?: boolean;
    }> = [];

    for (const rec of candidates) {
      try {
        const m4a = await fetchPhoneAudio(rec.id);
        if (!m4a || m4a.length === 0) {
          results.push({ id: rec.id, timestamp: rec.timestamp, ok: false, error: 'empty or missing audio' });
          continue;
        }
        const wav = await m4aToWav(m4a);
        const transcript = await transcribeWav(wav);
        if (transcript === null) {
          results.push({ id: rec.id, timestamp: rec.timestamp, ok: false, error: 'transcription failed' });
          continue;
        }
        let marked = false;
        if (markSent) {
          marked = await markPhoneSent(rec.id, destination, transcript);
        }
        results.push({ id: rec.id, timestamp: rec.timestamp, ok: true, transcript, marked });
        log(`pulled ${rec.id}: "${transcript.slice(0, 80)}"`);
      } catch (error) {
        results.push({
          id: rec.id,
          timestamp: rec.timestamp,
          ok: false,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    return NextResponse.json({
      success: true,
      attempted: results.length,
      transcribed: okCount,
      results,
    });
  } catch (error) {
    log(`POST error: ${error instanceof Error ? error.message : 'unknown'}`);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'unknown',
    }, { status: 500 });
  }
}
