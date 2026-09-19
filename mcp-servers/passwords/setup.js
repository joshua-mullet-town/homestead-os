#!/usr/bin/env node
/**
 * One-time setup: Store Google SA credentials on the phone.
 *
 * Reads the SA key JSON file and sends it to the phone's /vault/store-credentials
 * endpoint. The phone encrypts it with a hardware-backed key (requires fingerprint).
 *
 * After this, the phone can fetch the password Google Doc directly — no sync needed.
 * The SA key never needs to exist on the Mac again.
 *
 * Usage: GOOGLE_SA_KEY_PATH=~/.homestead/claude-passwords-sa.json node setup.js
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const PHONE_API_URL = process.env.PHONE_API_URL || 'http://<<REPLACE: your Tailscale IP>>:8888';
const SA_KEY_PATH = process.env.GOOGLE_SA_KEY_PATH;

if (!SA_KEY_PATH) {
  console.error('Error: GOOGLE_SA_KEY_PATH environment variable is required.');
  console.error('Usage: GOOGLE_SA_KEY_PATH=~/.homestead/claude-passwords-sa.json node setup.js');
  process.exit(1);
}

async function main() {
  console.log('=== Vault Credential Setup ===\n');

  // Read the SA key file
  const keyPath = SA_KEY_PATH.replace(/^~/, homedir());
  console.log(`1. Reading SA key from ${keyPath}...`);
  const saKeyJson = readFileSync(resolve(keyPath), 'utf-8');

  // Validate it's valid JSON with expected fields
  const parsed = JSON.parse(saKeyJson);
  if (!parsed.client_email || !parsed.private_key) {
    console.error('   Error: SA key JSON missing client_email or private_key');
    process.exit(1);
  }
  console.log(`   Service account: ${parsed.client_email}\n`);

  // Send to phone for encrypted storage
  console.log('2. Sending to phone for hardware-backed encryption...');
  console.log('   (Scan your fingerprint on the phone)\n');

  const res = await fetch(`${PHONE_API_URL}/vault/store-credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ saKeyJson }),
    signal: AbortSignal.timeout(60_000),
  });

  const data = await res.json();
  if (!data.success) {
    console.error(`   FAILED: ${data.error}`);
    process.exit(1);
  }

  console.log('   Credentials stored and encrypted on phone.\n');
  console.log('=== Setup complete ===');
  console.log('The SA key is now encrypted on your phone behind biometric auth.');
  console.log('You can safely delete the SA key file from this machine:');
  console.log(`   rm ${keyPath}`);
  console.log('\nThe phone will fetch passwords directly from Google Docs on each request.');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
