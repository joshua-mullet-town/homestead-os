import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const HEALTH_FILE = join(process.cwd(), 'data', 'channel-health.json');

interface ChannelHealth {
  status: 'connected' | 'auth_expired' | 'disconnected' | 'error' | 'timeout' | 'unknown';
  last_checked: string | null;
  last_success: string | null;
  error: string | null;
}

interface HealthData {
  channels: Record<string, ChannelHealth>;
  last_full_check: string | null;
}

// Channel metadata for display
const CHANNEL_META: Record<string, { name: string; type: string }> = {
  'gmail': { name: 'Gmail', type: 'email' },
  'sms': { name: 'SMS', type: 'phone' },
  'slack-codeworks': { name: 'Slack (Codeworks)', type: 'slack' },
  'slack-mullettown': { name: 'Slack (Mullettown)', type: 'slack' },
  'slack-<<REPLACE: your-employer>>': { name: 'Slack (<<REPLACE: your employer>>)', type: 'slack' },
  'push': { name: 'Push', type: 'push' }
};

function loadHealth(): HealthData {
  try {
    if (existsSync(HEALTH_FILE)) {
      return JSON.parse(readFileSync(HEALTH_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[ChannelHealth] Error loading health file:', err);
  }
  return { channels: {}, last_full_check: null };
}

export async function GET() {
  const healthData = loadHealth();

  // Enrich with metadata and compute summary
  const channels = Object.entries(CHANNEL_META).map(([id, meta]) => {
    const health = healthData.channels[id] || {
      status: 'unknown',
      last_checked: null,
      last_success: null,
      error: null
    };

    return {
      id,
      name: meta.name,
      type: meta.type,
      ...health
    };
  });

  const connected = channels.filter(c => c.status === 'connected').length;
  const total = channels.length;

  return NextResponse.json({
    channels,
    summary: {
      connected,
      total,
      all_healthy: connected === total
    },
    last_full_check: healthData.last_full_check
  });
}
