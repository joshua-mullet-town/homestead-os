# Secrets Management for Homestead

## Overview

Homestead automatically injects project-specific environment variables (API keys, Firebase config, etc.) into droplets during provisioning. This means **you never have to manually configure environment variables on the droplet** - it all happens automatically.

## How It Works

### 1. Store Secrets Locally (`.env.secrets`)

All project secrets are stored in `<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/.env.secrets` on your Mac. This file is **gitignored** and never committed.

**Format:**
```bash
# REPO_NAME__ENV_VAR_NAME=value
CROWNE_VAULT__SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CROWNE_VAULT__NEXT_PUBLIC_FIREBASE_API_KEY=<<REPLACE: your Firebase web API key — Firebase console > Project settings > General>>
CROWNE_VAULT__SERVICE_ACCOUNT_JSON_BASE64=ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIsCi...
```

**Naming Convention:**
- Repo name in uppercase, dashes → underscores: `crowne-vault` → `CROWNE_VAULT`
- Double underscore separator: `__`
- Environment variable name: `SENDGRID_API_KEY`
- Full key: `CROWNE_VAULT__SENDGRID_API_KEY`

### 2. Secrets Are Loaded Automatically

When you create a droplet from the Homestead UI:

1. You click on an issue (e.g., crowne-vault issue #7)
2. Homestead reads `.env.secrets`
3. Extracts all vars starting with `CROWNE_VAULT__`
4. Injects them into the cloud-init script
5. Droplet provisions with all environment variables ready

### 3. Files Created on Droplet

The cloud-init script creates these files in `/root/project/`:

**`.env.local`** (private variables):
```bash
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
UPS_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
UPS_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GOOGLE_APPLICATION_CREDENTIALS=./service-account-dev.json
```

**`.env.development`** (public variables):
```bash
# Firebase - Development
NEXT_PUBLIC_FIREBASE_API_KEY=<<REPLACE: your Firebase web API key — Firebase console > Project settings > General>>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project
# ... etc
```

**`service-account-dev.json`** (Firebase admin credentials):
```json
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...",
  "client_email": "firebase-adminsdk@your-project.iam.gserviceaccount.com"
}
```

## Adding Secrets for a New Project

### Example: Adding secrets for "my-app"

1. Open `<<REPLACE: your home dir, e.g. /Users/you>>/code/homestead/.env.secrets`

2. Add your secrets with the `MY_APP__` prefix:
```bash
# my-app secrets
MY_APP__DATABASE_URL=postgresql://user:pass@host/db
MY_APP__STRIPE_SECRET_KEY=sk_test_...
MY_APP__NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...

# If you have a Firebase service account JSON:
# 1. Base64 encode it: cat service-account.json | base64
# 2. Add it:
MY_APP__SERVICE_ACCOUNT_JSON_BASE64=ewogICJ0eXBlIjog...
```

3. Save the file - you're done! Next time you provision "my-app", all these variables will be automatically injected.

## Variable Categorization

The secrets loader automatically categorizes variables:

| Variable Type | Goes To | Example |
|--------------|---------|---------|
| `NEXT_PUBLIC_*` | `.env.development` | `NEXT_PUBLIC_FIREBASE_API_KEY` |
| `SERVICE_ACCOUNT_JSON_BASE64` | `service-account-dev.json` (decoded) | Firebase admin credentials |
| Everything else | `.env.local` | `SENDGRID_API_KEY`, `DATABASE_URL` |

## Security

- ✅ `.env.secrets` is **gitignored** - never committed to Git
- ✅ Secrets are only transmitted during droplet creation (over HTTPS)
- ✅ Secrets are stored on the droplet (which is ephemeral and destroyed after use)
- ✅ Only your Mac and your droplets have access to the secrets

## Firebase Service Account

To add a Firebase service account for a project:

1. Download the JSON file from Firebase Console
2. Base64 encode it:
   ```bash
   cat service-account-dev.json | base64
   ```
3. Add to `.env.secrets`:
   ```bash
   MY_PROJECT__SERVICE_ACCOUNT_JSON_BASE64=<paste base64 output>
   ```

The cloud-init script will automatically:
- Decode the base64
- Write it to `service-account-dev.json`
- Add `GOOGLE_APPLICATION_CREDENTIALS=./service-account-dev.json` to `.env.local`

## Troubleshooting

### Dev server not starting?

1. Check the provision log on the droplet:
   ```bash
   ssh -i ~/.ssh/homestead_droplet root@<droplet-ip> cat /root/provision.log
   ```

2. Look for these lines:
   ```
   [2026-01-29T14:00:00+00:00] Creating .env.local file...
   [2026-01-29T14:00:00+00:00] .env.local created successfully
   [2026-01-29T14:00:00+00:00] Creating service-account-dev.json file...
   [2026-01-29T14:00:00+00:00] service-account-dev.json created successfully
   ```

3. Verify files exist on droplet:
   ```bash
   ssh -i ~/.ssh/homestead_droplet root@<droplet-ip> ls -la /root/project/.env*
   ssh -i ~/.ssh/homestead_droplet root@<droplet-ip> ls -la /root/project/service-account*
   ```

### No secrets for my project?

Check that your repo name matches the prefix:
- Repo: `my-cool-app`
- Prefix: `MY_COOL_APP__` (uppercase, dashes → underscores)

## Current Projects with Secrets

| Project | Secrets Configured |
|---------|-------------------|
| crowne-vault | ✅ SendGrid, UPS, Firebase (7 vars), Service Account |
| *(add more as needed)* | |
