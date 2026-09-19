/**
 * get_password tool — hardware-backed biometric vault
 *
 * All secrets live behind biometric authentication on Josh's phone.
 * The Google SA key is encrypted on the phone — Claude never has access to it.
 *
 * 1. Sends POST /vault/fetch to phone
 * 2. Phone shows fingerprint prompt
 * 3. On biometric success, phone decrypts its SA key, fetches Google Doc, returns content
 * 4. Claude reads the content directly
 *
 * The SA key and password document are NEVER accessible without Josh's fingerprint.
 */

import { execSync } from 'child_process';

const PHONE_API_URL = process.env.PHONE_API_URL || 'http://<<REPLACE: your Tailscale IP>>:8888';
const BIOMETRIC_TIMEOUT_MS = 90_000; // Biometric + Google Docs fetch

function sendMacNotification(message) {
  try {
    execSync(
      `osascript -e 'display notification "${message}" with title "Unlock Vault" sound name "Ping"'`,
      { timeout: 3000 }
    );
  } catch {
    console.error('[Passwords] macOS notification failed');
  }
}

export const getPasswordTool = {
  name: 'get_password',
  description:
    'Fetch passwords from the vault. Requires biometric (fingerprint) authentication on Josh\'s phone. The phone decrypts its stored Google credentials, fetches the password document directly, and returns the content. Neither the credentials nor the passwords are ever accessible without Josh\'s fingerprint.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why you need to access the vault (for logging)',
      },
    },
    required: [],
  },

  async execute(args) {
    const { reason } = args;
    console.error(`[Passwords] Requesting vault read (${reason || 'no reason given'})`);

    sendMacNotification('Scan fingerprint on phone to unlock passwords');

    // Wake the phone screen so the biometric prompt can display
    try {
      await fetch(`${PHONE_API_URL}/screen/wake`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    } catch {
      console.error('[Passwords] Screen wake failed (non-fatal)');
    }

    // Small delay to let screen turn on
    await new Promise(r => setTimeout(r, 1000));

    try {
      const res = await fetch(`${PHONE_API_URL}/vault/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(BIOMETRIC_TIMEOUT_MS),
      });

      // Read the full response text first, then parse
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error(`[Passwords] Response parse error. Status: ${res.status}, Body length: ${text.length}, Preview: ${text.slice(0, 200)}`);
        return { success: false, error: `Invalid response from phone (${res.status}): ${text.slice(0, 100)}` };
      }

      if (!data.success) {
        return { success: false, error: data.error || 'Vault read failed' };
      }

      return { success: true, content: data.data.content };
    } catch (err) {
      if (err.name === 'TimeoutError') {
        return { success: false, error: 'Biometric unlock timed out (60s). Check your phone.' };
      }
      return { success: false, error: `Vault read failed: ${err.message}` };
    }
  },
};
