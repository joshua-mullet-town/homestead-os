import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';

const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

const CONTEXT_MAX = 1_000_000;

type SessionMeta = {
  sessionId: string;
  cwd: string | null;
  tmuxSession: string | null;
  status: string | null;
  updatedAt: string | null;
};

async function loadSessionMetaByTmux(): Promise<Map<string, SessionMeta[]>> {
  const byTmux = new Map<string, SessionMeta[]>();
  let files: string[] = [];
  try { files = await readdir(SESSIONS_DIR); } catch { return byTmux; }

  await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => {
    try {
      const raw = await readFile(join(SESSIONS_DIR, f), 'utf8');
      const data = JSON.parse(raw);
      if (!data.sessionId || !data.tmuxSession) return;
      const m: SessionMeta = {
        sessionId: data.sessionId,
        cwd: data.cwd || null,
        tmuxSession: data.tmuxSession,
        status: data.status || null,
        updatedAt: data.updatedAt || null,
      };
      const existing = byTmux.get(m.tmuxSession!) || [];
      existing.push(m);
      byTmux.set(m.tmuxSession!, existing);
    } catch { /* skip */ }
  }));

  // Sort each bucket most-recent first
  for (const [, arr] of byTmux) {
    arr.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  return byTmux;
}

function cwdToProjectSlug(cwd: string): string {
  // <<REPLACE: your home dir, e.g. /Users/you>>/.homestead/stewards/rooster
  //   → -Users-joshuamullet--homestead-stewards-rooster
  // <<REPLACE: your home dir, e.g. /Users/you>>/code/GiveGrove
  //   → -Users-joshuamullet-code-GiveGrove
  // Claude CLI's rule: replace '/' with '-' and '.' with '-'.
  return cwd.replace(/\//g, '-').replace(/\./g, '-');
}

async function findLiveJsonl(meta: SessionMeta): Promise<string | null> {
  if (!meta.cwd) return null;
  const slug = cwdToProjectSlug(meta.cwd);
  const candidate = join(PROJECTS_DIR, slug, `${meta.sessionId}.jsonl`);
  try {
    await stat(candidate);
    return candidate;
  } catch {
    return null;
  }
}

type ContextStat = {
  session: string;
  sessionId: string | null;
  status: string | null;
  tokens: number;
  pct: number;
  updatedAt: string | null;
};

async function scanJsonl(filePath: string): Promise<{ tokens: number }> {
  return new Promise((resolve) => {
    let tokens = 0;

    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line) return;
      let obj: any;
      try { obj = JSON.parse(line); } catch { return; }

      // Claude Code caches: each turn's "input_tokens" can be huge because the
      // whole context is passed in. Use the MAX running value as context size,
      // not the sum — tokens shouldn't grow past 1M in a single session.
      const usage = obj.message?.usage;
      if (usage && typeof usage === 'object') {
        const n =
          (usage.input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.output_tokens || 0);
        if (n > tokens) tokens = n;
      }
    });

    rl.on('close', () => resolve({ tokens }));
    rl.on('error', () => resolve({ tokens }));
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get('sessions');
  if (!raw) {
    return NextResponse.json({ error: 'sessions query param required (comma-separated)' }, { status: 400 });
  }
  const requested = raw.split(',').map(s => s.trim()).filter(Boolean);

  const byTmux = await loadSessionMetaByTmux();
  const results: ContextStat[] = [];

  await Promise.all(requested.map(async sessionName => {
    const candidates = byTmux.get(sessionName) || [];
    // Prefer the most recent non-terminated session for this tmux name.
    const live = candidates.find(c => c.status && c.status !== 'terminated') || candidates[0];

    if (!live) {
      results.push({
        session: sessionName,
        sessionId: null,
        status: null,
        tokens: 0,
        pct: 0,
        updatedAt: null,
      });
      return;
    }

    const jsonl = await findLiveJsonl(live);
    if (!jsonl) {
      results.push({
        session: sessionName,
        sessionId: live.sessionId,
        status: live.status,
        tokens: 0,
        pct: 0,
        updatedAt: live.updatedAt,
      });
      return;
    }

    const { tokens } = await scanJsonl(jsonl);
    const pct = Math.min(100, Math.max(0, (tokens / CONTEXT_MAX) * 100));

    results.push({
      session: sessionName,
      sessionId: live.sessionId,
      status: live.status,
      tokens,
      pct,
      updatedAt: live.updatedAt,
    });
  }));

  return NextResponse.json({ contextMax: CONTEXT_MAX, sessions: results });
}
