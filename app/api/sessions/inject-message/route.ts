import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";

const execAsync = promisify(exec);

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

// CORS headers for browser requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * POST /api/sessions/inject-message
 *
 * Injects a message into a tmux session (types it into the terminal).
 * Used by external tools (like test overlays) to send feedback to Claude Code.
 *
 * Body: { sessionId: string, message: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { sessionId, message } = await request.json();

    if (!sessionId || typeof sessionId !== "string") {
      return NextResponse.json(
        { error: "sessionId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "message is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Validate session name format (holler-* pattern)
    if (!sessionId.startsWith("holler-")) {
      return NextResponse.json(
        { error: "Invalid session ID format" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Check if session exists
    try {
      await execAsync(`tmux has-session -t "${sessionId}"`);
    } catch {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // Write message to a temp file to avoid shell escaping issues
    const tempFile = join(tmpdir(), `tmux-msg-${randomUUID()}.txt`);
    await writeFile(tempFile, message, "utf-8");

    try {
      // Use tmux load-buffer to load the message, then paste it
      await execAsync(`tmux load-buffer "${tempFile}"`);
      await execAsync(`tmux paste-buffer -t "${sessionId}"`);

      // Wait for paste to fully render before sending Enter
      // This prevents the issue where Enter is sent before paste completes
      await new Promise((resolve) => setTimeout(resolve, 500));

      await execAsync(`tmux send-keys -t "${sessionId}" Enter`);
    } finally {
      // Clean up temp file
      await unlink(tempFile).catch(() => {});
    }

    console.log(`[inject-message] Sent to ${sessionId}: ${message.substring(0, 50)}...`);

    // Verify delivery by checking conversation file
    const verified = await verifyDelivery(sessionId, message);
    console.log(`[inject-message] Verified: ${verified}`);

    return NextResponse.json({ success: true, verified }, { headers: corsHeaders });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[inject-message] Error:", errorMessage);
    return NextResponse.json(
      { error: "Internal server error", details: errorMessage },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders });
}

// Also support GET for health check / testing
export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      endpoint: "/api/sessions/inject-message",
      usage: "POST with { sessionId, message }",
    },
    { headers: corsHeaders }
  );
}
