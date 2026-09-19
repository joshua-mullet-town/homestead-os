# Alert Triage - User Stories

## Core Concept

Alerts have two states: **Unresolved** (exists) or **Resolved** (gone). No snooze, no in-progress, no pending. Simple.

---

## The Flow

```
Memory Harvester (every 15 min)
    ↓
Finds alarming item (email, Slack, SMS, session)
    ↓
Creates alert + spawns investigator session (same action)
    ↓
Investigator researches, writes findings, assesses urgency
    ↓
If urgent → push notification
    ↓
I review on home page, tap to see full report
    ↓
Join session OR Resolve (kills session + alert + optionally archives email)
```

---

## User Stories

### US-1: Alarming Email Detected

**As** the Memory Harvester
**When** I find an email that looks alarming
**Then** I create an alert with:
- Deterministic ID based on email message ID (prevents duplicates)
- Title, details, suggested_action
- My urgency assessment (urgent / not urgent)
- Reference to source email (message ID, for later archiving)

**And** I immediately spawn an investigator session for this alert

---

### US-2: Investigator Researches Alert

**As** an Investigator session
**When** I'm spawned for an alert
**Then** I:
- Read the alert context
- Research the actual issue (check code, services, logs)
- Write my findings back to the alert (free-form text field)
- Assess urgency myself (urgent / not urgent)

**If** I determine it's urgent (even if I handled it autonomously)
**Then** I send a push notification

**If** I can fix it myself (e.g., rotate exposed API key)
**Then** I fix it, but still notify that I did

**If** it requires human judgment (e.g., Firebase rules design)
**Then** I document findings and wait for human

---

### US-3: Viewing Alerts on Home Page

**As** Joshua
**When** I open Homestead home page
**Then** I see a compact list of unresolved alerts showing:
- Title
- Harvester urgency badge
- Investigator urgency badge (if investigation complete)
- Brief summary (beginning of harvester's details)

**When** I tap an alert
**Then** I see a detail page with:
- Full harvester description
- Full investigator findings
- Source info (email subject, Slack channel, etc.)
- Actions: Join Session, Resolve, Archive Email (if email source)

---

### US-4: Resolving an Alert

**As** Joshua
**When** I tap "Resolve" on an alert
**Then**:
- The investigator session is killed (if still running)
- The alert is deleted from alerts.json
- The alert won't resurface (ID-based deduplication for emails)

**Optionally** if the alert came from email:
- I can also tap "Archive Email" to archive/label it in Gmail
- This is a separate action (not automatic with Resolve)

---

### US-5: Joining an Alert Session

**As** Joshua
**When** I tap "Join Session" on an alert
**Then** I'm taken to the terminal view for that investigator session
**And** I can work with Claude to handle the issue
**When** done, I go back and tap "Resolve"

---

### US-6: Push Notification from Investigator

**As** Joshua
**When** an investigator determines something is urgent
**Then** I receive a push notification with:
- Alert title
- Brief finding ("Firebase rules expire tomorrow" or "Handled: rotated exposed API key")
- Tap action opens Homestead to that alert's detail page

**When** an investigator is stuck (auth issue, needs clarification)
**Then** I receive a push notification asking for help

**When** an investigator determines it's not urgent / dismissible
**Then** no push notification (I'll see it when I check in)

---

### US-7: Concurrent Investigations

**As** the Memory Harvester
**When** I find 5 alarming items in one run
**Then** I create 5 alerts and spawn 5 investigator sessions in parallel
**Not** queued, not rate-limited (for now)

---

### US-8: Deduplication

**As** the Memory Harvester
**When** I see the same email I already alerted on
**Then** I don't create a duplicate alert

**Implementation:**
- Email alerts use message ID in alert ID (e.g., `email-{messageId}`)
- API returns 409 on duplicate ID
- Harvester handles 409 gracefully (skip, don't error)

**For Slack/SMS:**
- Continue using checkpoint timestamps
- Only process messages newer than last checkpoint

---

## Urgency Scale

Simple binary:
- **Urgent** - needs attention now, will push notify
- **Not urgent** - can wait, no push

Both harvester and investigator assess independently. UI shows both badges.

---

## Investigator Capabilities

**Can do autonomously:**
- Rotate exposed API keys/secrets (store old value safely first)
- Simple fixes with clear right answer

**Should NOT do autonomously:**
- Firebase rules changes (design decisions)
- Deployments
- Anything requiring human judgment on approach

**Always does:**
- Write findings to alert
- Push notify if urgent
- Push notify if stuck/blocked

---

## Alert Data Structure

```typescript
interface Alert {
  id: string;                      // Deterministic: "email-{messageId}" or "slack-{ts}"
  source: 'email' | 'slack' | 'sms' | 'session';
  source_ref: string;              // Email message ID, Slack ts, etc. (for archiving)

  // Harvester fills these
  title: string;
  details: string;
  suggested_action: string;
  harvester_urgency: 'urgent' | 'not_urgent';

  // Investigator fills these
  findings: string | null;         // Free-form investigation report
  investigator_urgency: 'urgent' | 'not_urgent' | null;

  // Metadata
  created_at: string;
  session_id: string | null;       // The investigator session name
}
```

---

## UI Mockup

### Home Page (Compact List)
```
┌─────────────────────────────────────────────┐
│ ALERTS                                      │
├─────────────────────────────────────────────┤
│ 🔴 Firebase rules expiring          [URGENT]│
│    Crowne Vault - expires Feb 10            │
│    Investigator: 🔴 URGENT                  │
├─────────────────────────────────────────────┤
│ 🟡 GiveGrove deploy failed      [NOT URGENT]│
│    Dev environment only                     │
│    Investigator: 🟢 NOT URGENT              │
├─────────────────────────────────────────────┤
│ 🔴 API key exposed               [URGENT]   │
│    GitGuardian alert                        │
│    Investigator: ✅ HANDLED                 │
└─────────────────────────────────────────────┘
```

### Detail Page (Tap to Expand)
```
┌─────────────────────────────────────────────┐
│ ← Back                                      │
├─────────────────────────────────────────────┤
│ Firebase rules expiring                     │
│ 🔴 Harvester: URGENT                        │
│ 🔴 Investigator: URGENT                     │
├─────────────────────────────────────────────┤
│ HARVESTER NOTES                             │
│ Firebase Cloud Storage rules expire Feb 10  │
│ for crowne-vault project. Update before     │
│ then to avoid access denial.                │
├─────────────────────────────────────────────┤
│ INVESTIGATOR FINDINGS                       │
│ Checked firebase console - rules expire in  │
│ 18 hours. Current rules are default test    │
│ rules. Recommend updating to production     │
│ rules at /firebase/storage.rules. Cannot    │
│ auto-fix - requires design decision on      │
│ access patterns.                            │
├─────────────────────────────────────────────┤
│ SOURCE                                      │
│ Email: "Action required: Security rules..." │
│ From: firebase-noreply@google.com           │
├─────────────────────────────────────────────┤
│ [  JOIN SESSION  ]  [ RESOLVE ]             │
│                     [ ARCHIVE EMAIL ]       │
└─────────────────────────────────────────────┘
```

---

## Open Items

- [ ] Research current checkpoint system for deduplication
- [ ] Determine if email message IDs are available via Gmail MCP
- [ ] Update alert schema to match this spec
- [ ] Update harvester prompt to spawn investigator immediately
- [ ] Create investigator prompt with capabilities + constraints
