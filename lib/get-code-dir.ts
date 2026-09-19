/**
 * Get the configured CODE_DIR for API routes
 *
 * Reads from homestead-config.json and returns the user's code directory.
 * Falls back to ~/code if not configured (for development/backwards compat).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_FILE = path.join(process.cwd(), 'homestead-config.json');

interface Config {
  codeDir: string | null;
  setupComplete: boolean;
}

export function getCodeDir(): string {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const config: Config = JSON.parse(content);
      if (config.codeDir) {
        return config.codeDir;
      }
    }
  } catch (err) {
    console.error('[Config] Error reading config:', err);
  }

  // Fallback to ~/code for backwards compatibility
  return path.join(os.homedir(), 'code');
}

export function getWorktreesDir(): string {
  // Worktrees always go in ~/.worktrees
  return path.join(os.homedir(), '.worktrees');
}

export function isSetupComplete(): boolean {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const config: Config = JSON.parse(content);
      return config.setupComplete && config.codeDir !== null;
    }
  } catch (err) {
    console.error('[Config] Error reading config:', err);
  }
  return false;
}
