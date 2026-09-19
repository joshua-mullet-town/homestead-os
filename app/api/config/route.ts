import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Config file location - relative to the project root
const CONFIG_FILE = path.join(process.cwd(), 'homestead-config.json');

interface Config {
  codeDir: string | null;
  setupComplete: boolean;
}

const DEFAULT_CONFIG: Config = {
  codeDir: null,
  setupComplete: false
};

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    }
  } catch (err) {
    console.error('[Config] Error loading config:', err);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: Config): boolean {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.error('[Config] Error saving config:', err);
    return false;
  }
}

function getCodeDirSuggestions(): string[] {
  const home = os.homedir();
  const suggestions: string[] = [];

  const possibleDirs = [
    path.join(home, 'code'),
    path.join(home, 'Code'),
    path.join(home, 'projects'),
    path.join(home, 'Projects'),
    path.join(home, 'dev'),
    path.join(home, 'Development'),
    path.join(home, 'src'),
    path.join(home, 'repos'),
    path.join(home, 'github'),
    path.join(home, 'workspace'),
    path.join(home, 'Documents', 'code'),
    path.join(home, 'Documents', 'projects'),
  ];

  for (const dir of possibleDirs) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        suggestions.push(dir);
      }
    } catch {
      // Ignore permission errors
    }
  }

  return suggestions;
}

// GET - get current config
export async function GET() {
  const config = loadConfig();
  const suggestions = getCodeDirSuggestions();

  return NextResponse.json({
    ...config,
    suggestions,
    needsSetup: !config.setupComplete || !config.codeDir,
    _shipSmokeTest: 'prod-mode-flip-w2'
  });
}

// POST - update config
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { codeDir } = body;

    if (!codeDir) {
      return NextResponse.json({ error: 'codeDir is required' }, { status: 400 });
    }

    // Validate the directory exists
    if (!fs.existsSync(codeDir)) {
      return NextResponse.json({ error: 'Directory does not exist' }, { status: 400 });
    }

    if (!fs.statSync(codeDir).isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    const config = loadConfig();
    config.codeDir = codeDir;
    config.setupComplete = true;

    if (saveConfig(config)) {
      return NextResponse.json({ success: true, config });
    } else {
      return NextResponse.json({ error: 'Failed to save config' }, { status: 500 });
    }
  } catch (err) {
    console.error('[Config] POST error:', err);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
