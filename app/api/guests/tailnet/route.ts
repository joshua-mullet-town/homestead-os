import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CONFIG_FILE = join(homedir(), '.homestead', 'guests.json');

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { owner: '', guests: [] };
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
}

interface TailscaleUser {
  login: string;
  displayName: string;
  profilePicUrl: string;
}

/** GET /api/guests/tailnet — list tailnet users not already added as guests */
export async function GET() {
  try {
    const { stdout: output } = await execAsync('tailscale status --json', { timeout: 5000 });
    const status = JSON.parse(output);

    // Extract unique users from peers
    const usersMap = new Map<string, TailscaleUser>();

    // Self
    if (status.Self?.UserID) {
      const userId = String(status.Self.UserID);
      const user = status.User?.[userId];
      if (user) {
        usersMap.set(user.LoginName, {
          login: user.LoginName,
          displayName: user.DisplayName,
          profilePicUrl: user.ProfilePicURL || '',
        });
      }
    }

    // Peers
    if (status.Peer) {
      for (const peer of Object.values(status.Peer) as Array<{ UserID?: number }>) {
        const userId = String(peer.UserID);
        const user = status.User?.[userId];
        if (user && !usersMap.has(user.LoginName)) {
          usersMap.set(user.LoginName, {
            login: user.LoginName,
            displayName: user.DisplayName,
            profilePicUrl: user.ProfilePicURL || '',
          });
        }
      }
    }

    // Filter out owner and existing guests
    const config = loadConfig();
    const existingLogins = new Set([
      config.owner,
      ...config.guests.map((g: { login: string }) => g.login),
    ]);

    const available = Array.from(usersMap.values()).filter(
      (u) => !existingLogins.has(u.login)
    );

    return NextResponse.json({ users: available });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to get tailnet users: ${msg}`, users: [] }, { status: 500 });
  }
}
