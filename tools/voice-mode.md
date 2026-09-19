# Steward Voice Mode (Future)

## Concept

Call Steward's Twilio number → live voice conversation with Claude.

## How It Would Work

1. **Incoming call** hits Twilio webhook
2. Twilio streams audio to a websocket endpoint
3. Speech-to-text (Whisper) transcribes in real-time
4. Transcription fed to ephemeral Steward worker
5. Worker response sent to text-to-speech (Edge TTS)
6. Audio streamed back to caller

## Architecture

```
Phone Call
    ↓
Twilio Voice Webhook
    ↓
WebSocket Audio Stream
    ↓
┌─────────────────────────────────────┐
│  Homestead Voice Handler            │
│  - Whisper STT                      │
│  - Claude (ephemeral Steward)       │
│  - Edge TTS                         │
└─────────────────────────────────────┘
    ↓
Audio Response Stream
    ↓
Back to Caller
```

## Key Components Needed

1. **Twilio Voice webhook** - `/api/voice-webhook`
2. **WebSocket handler** - for bidirectional audio
3. **Whisper integration** - real-time transcription
4. **Claude worker** - with voice-mode prompt (knows it's on a call)
5. **TTS streaming** - low-latency audio generation

## Prompt for Voice Steward

```
You are Steward on a phone call with Joshua.

- Speak naturally, conversationally
- Keep responses brief (this is a call, not a text wall)
- You can pause to look things up, just say "let me check..."
- If you need to run commands or read files, do it
- Respond verbally - no markdown, no code blocks in speech
```

## MCP Tools Available

- `mcp__voicemode__converse` - Already configured, may handle some of this
- `mcp__voicemode__service` - Service management

## Notes

- Latency is critical for natural conversation
- May need to buffer/chunk responses
- Consider "thinking" sounds while processing
- Twilio bidirectional streaming docs: https://www.twilio.com/docs/voice/media-streams
