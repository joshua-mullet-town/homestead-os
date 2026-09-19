import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

// Microsoft Edge TTS voices - these are high quality neural voices
const DEFAULT_VOICE = 'en-US-AndrewNeural'; // Warm, confident, authentic male voice
const AVAILABLE_VOICES = [
  { name: 'en-US-AndrewNeural', description: 'Male - Warm, Confident' },
  { name: 'en-US-BrianNeural', description: 'Male - Approachable, Casual' },
  { name: 'en-US-ChristopherNeural', description: 'Male - Reliable, Authority' },
  { name: 'en-US-AvaNeural', description: 'Female - Expressive, Caring' },
  { name: 'en-US-AriaNeural', description: 'Female - Positive, Confident' },
  { name: 'en-US-EmmaNeural', description: 'Female - Cheerful, Clear' },
];

export async function POST(request: NextRequest) {
  const tempId = randomUUID();
  const mp3Path = `/tmp/tts-${tempId}.mp3`;

  try {
    const { text, voice = DEFAULT_VOICE } = await request.json();

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    // Limit text length to prevent abuse
    const truncatedText = text.slice(0, 5000);

    // Escape text for shell - use base64 encoding to handle all special characters
    const base64Text = Buffer.from(truncatedText).toString('base64');

    // Use edge-tts with the neural voice - decode base64 in the command
    // edge-tts outputs MP3 directly, no conversion needed
    const edgeTtsPath = `${process.env.HOME}/.local/bin/edge-tts`;
    await execAsync(
      `echo "${base64Text}" | base64 -d | ${edgeTtsPath} --voice "${voice}" --write-media "${mp3Path}" -f -`,
      { timeout: 30000 } // 30 second timeout
    );

    // Read the MP3 file
    const audioBuffer = await readFile(mp3Path);

    // Clean up temp file
    await unlink(mp3Path).catch(() => {});

    // Return the audio file
    return new NextResponse(audioBuffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length.toString(),
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      },
    });
  } catch (error) {
    console.error('TTS error:', error);

    // Clean up temp file on error
    await unlink(mp3Path).catch(() => {});

    return NextResponse.json(
      { error: 'Failed to generate speech' },
      { status: 500 }
    );
  }
}

// GET endpoint to list available voices
export async function GET() {
  return NextResponse.json({
    voices: AVAILABLE_VOICES,
    default: DEFAULT_VOICE
  });
}
