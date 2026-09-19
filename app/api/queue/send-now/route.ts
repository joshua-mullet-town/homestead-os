import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { join } from 'path';
import { homedir, tmpdir } from 'os';
// @ts-ignore — CommonJS module without type defs
import { resolveTarget } from '@/lib/steward-resolver';

const QUEUE_FILE = join(homedir(), '.homestead', 'queue.json');

interface QueueItem {
  id: string;
  target_session: string;
  type?: string;
  message: string;
  status: string;
  created_at: string;
  dispatched_at?: string;
  dispatched_ready?: boolean;
  manual_dispatch?: string;
  attempts?: number;
}

function readQueue(): QueueItem[] {
  try {
    if (!existsSync(QUEUE_FILE)) return [];
    return JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// ATOMIC (torn-read fix 2026-08-25): temp+rename so a concurrent dispatcher read
// never sees a half-written queue.json.
function writeQueue(queue: QueueItem[]) {
  const tmp = `${QUEUE_FILE}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(queue, null, 2));
  renameSync(tmp, QUEUE_FILE);
}

function resolveSessionName(targetSession: string): string {
  const result = resolveTarget(targetSession);
  if (!result.valid) {
    throw new Error(`Unknown target "${targetSession}": ${result.error}`);
  }
  return result.sessionName as string;
}

async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t "=${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function buildEnrichedMessage(message: string, queueItemId: string): string {
  const confirmCmd = `SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo unknown) && curl -s -X POST http://localhost:3005/api/queue/confirm -H "Content-Type: application/json" -d "{\\"id\\":\\"${queueItemId}\\",\\"confirmed_by\\":\\"$SESSION\\"}"`;
  try {
    const parsed = JSON.parse(message);
    parsed._queue_id = queueItemId;
    parsed._confirm = confirmCmd;
    return JSON.stringify(parsed);
  } catch {
    return JSON.stringify({ _queue_id: queueItemId, _confirm: confirmCmd, _raw: message });
  }
}

async function injectIntoSession(sessionName: string, payload: string) {
  const tempFile = join(tmpdir(), `queue-send-now-${Date.now()}-${process.pid}.txt`);
  const bufferName = `walkie-sendnow-${Date.now()}-${process.pid}`;
  try {
    writeFileSync(tempFile, payload);
    await execAsync(`tmux load-buffer -b "${bufferName}" "${tempFile}"`);
    await execAsync(`tmux paste-buffer -b "${bufferName}" -t "=${sessionName}:" -d`);
    await new Promise(r => setTimeout(r, 500));
    await execAsync(`tmux send-keys -t "=${sessionName}:" Enter`);
  } finally {
    try { unlinkSync(tempFile); } catch {}
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { id, mode } = body as { id?: string; mode?: string };

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }
  if (mode !== 'interrupt' && mode !== 'inject') {
    return NextResponse.json({ error: 'mode must be "interrupt" or "inject"' }, { status: 400 });
  }

  const queue = readQueue();
  const idx = queue.findIndex(item => item.id === id);
  if (idx === -1) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }

  const item = queue[idx];
  if (item.status !== 'pending') {
    return NextResponse.json({
      error: `Item is "${item.status}", not "pending" — only pending items can be sent now`,
    }, { status: 409 });
  }

  let sessionName: string;
  try {
    sessionName = resolveSessionName(item.target_session);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  if (!(await sessionExists(sessionName))) {
    return NextResponse.json({
      error: `Target session "${sessionName}" is not running. Send-now only works on live sessions.`,
    }, { status: 409 });
  }

  // Claim the item before injecting so the regular 10s dispatcher tick can't
  // double-send the same message. If injection fails, we revert below.
  const claimed = readQueue();
  const ci = claimed.findIndex(x => x.id === id);
  if (ci === -1) {
    return NextResponse.json({ error: 'Item disappeared' }, { status: 404 });
  }
  if (claimed[ci].status !== 'pending') {
    return NextResponse.json({
      error: `Item is "${claimed[ci].status}", not "pending" — already dispatched`,
    }, { status: 409 });
  }
  claimed[ci].status = 'dispatched';
  claimed[ci].dispatched_at = new Date().toISOString();
  claimed[ci].dispatched_ready = true;
  claimed[ci].manual_dispatch = mode === 'interrupt' ? 'manual-interrupt' : 'manual-inject';
  claimed[ci].attempts = (claimed[ci].attempts || 0) + 1;
  writeQueue(claimed);

  try {
    if (mode === 'interrupt') {
      await execAsync(`tmux send-keys -t "=${sessionName}:" Escape`);
      await new Promise(r => setTimeout(r, 300));
    }
    const enriched = buildEnrichedMessage(item.message, item.id);
    await injectIntoSession(sessionName, enriched);
  } catch (e) {
    const revert = readQueue();
    const ri = revert.findIndex(x => x.id === id);
    if (ri !== -1) {
      revert[ri].status = 'pending';
      delete revert[ri].dispatched_at;
      delete revert[ri].dispatched_ready;
      delete revert[ri].manual_dispatch;
      writeQueue(revert);
    }
    return NextResponse.json({
      error: `Failed to send: ${(e as Error).message}`,
    }, { status: 500 });
  }

  return NextResponse.json({ success: true, mode, target: sessionName });
}
