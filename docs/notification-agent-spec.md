# Notification Agent System

## Overview

A system where notifications from the phone become "training events" for an AI agent. The agent learns how to handle notifications by observing user decisions, building up a memory of patterns and preferences, and eventually becoming capable of autonomous action.

## Core Loop

```
1. Notification arrives on phone
         ↓
2. Appears in Homestead UI with [START] button
         ↓
3. User clicks [START] → Ephemeral CC session spins up
         ↓
4. Agent searches memory for:
   - Exact matches (same sender, same notification type)
   - Fuzzy matches (same app, similar content patterns)
   - Related context (conversation history with sender)
         ↓
5. Agent proposes action based on:
   - Previous handling of similar notifications
   - Or hypothesis if no prior history
         ↓
6. User dialogues with agent:
   - Approves, corrects, or refines the approach
   - Explains rationale for future reference
         ↓
7. Action executed via phone API
         ↓
8. Decision logged to memory with full context
```

## Memory System (SQLite)

### Tables

```sql
-- Core notification events
CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  notification_key TEXT,           -- Android notification key
  app_package TEXT,                -- e.g., com.google.android.gm
  app_name TEXT,                   -- e.g., Gmail
  sender TEXT,                     -- Extracted sender (email, phone, name)
  title TEXT,
  body TEXT,
  category TEXT,                   -- msg, email, reminder, etc.
  timestamp INTEGER,
  raw_json TEXT                    -- Full notification data
);

-- Training sessions (the dialogue + decision)
CREATE TABLE training_sessions (
  id TEXT PRIMARY KEY,
  notification_event_id TEXT REFERENCES notification_events(id),
  session_id TEXT,                 -- tmux session name
  started_at INTEGER,
  completed_at INTEGER,
  status TEXT,                     -- in_progress, completed, abandoned
  conversation_log TEXT,           -- Full CC conversation
  final_decision TEXT,             -- What action was taken
  user_rationale TEXT,             -- Why (extracted or explicit)
  FOREIGN KEY (notification_event_id) REFERENCES notification_events(id)
);

-- Learned patterns (generalized rules)
CREATE TABLE patterns (
  id TEXT PRIMARY KEY,
  pattern_type TEXT,               -- sender, app, content, category
  pattern_value TEXT,              -- The pattern itself
  default_action TEXT,             -- What to do
  confidence REAL,                 -- 0.0 to 1.0
  times_applied INTEGER,
  times_overridden INTEGER,
  created_at INTEGER,
  last_used_at INTEGER,
  notes TEXT                       -- User-provided context
);

-- Action history (what was actually done)
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  training_session_id TEXT REFERENCES training_sessions(id),
  action_type TEXT,                -- dismiss, archive, reply, open_app, etc.
  action_params TEXT,              -- JSON of parameters
  executed_at INTEGER,
  success INTEGER,
  error_message TEXT
);

-- Sender profiles (accumulated knowledge about senders)
CREATE TABLE senders (
  id TEXT PRIMARY KEY,
  identifier TEXT UNIQUE,          -- email, phone, or name
  identifier_type TEXT,            -- email, phone, name
  display_name TEXT,
  apps_seen TEXT,                  -- JSON array of apps they appear in
  first_seen INTEGER,
  last_seen INTEGER,
  total_notifications INTEGER,
  notes TEXT                       -- User-provided context about this sender
);
```

### Fuzzy Matching Strategy

When a new notification arrives, the agent searches for relevant history:

1. **Exact sender match**: Same email/phone/name
2. **Same app + category**: e.g., all Gmail emails
3. **Content similarity**: Keywords, patterns (e.g., "PR review", "statement available")
4. **Same conversation thread**: If identifiable from notification data
5. **Same time patterns**: e.g., daily digests at 9am

Each match type contributes to a relevance score. Agent retrieves top N most relevant training sessions.

## Homestead UI Components

### Notification Panel

```
┌─────────────────────────────────────┐
│ NOTIFICATIONS              ● ONLINE │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ Gmail - Michael           2m ago│ │
│ │ PR review request #1377         │ │
│ │ [START]              [DISMISS]  │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ Messages - Yoko           15m   │ │
│ │ Thanks love! Let me know...    │ │
│ │ [START]              [DISMISS]  │ │
│ └─────────────────────────────────┘ │
│ ┌─────────────────────────────────┐ │
│ │ Snapchat - Group          30m   │ │
│ │ New reactions from...          │ │
│ │ [START]              [DISMISS]  │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### Training Session View

When [START] is clicked, opens a dedicated chat interface:

```
┌─────────────────────────────────────┐
│ ← Training: Gmail - Michael         │
├─────────────────────────────────────┤
│                                     │
│ [NOTIFICATION CARD]                 │
│ PR review request #1377             │
│ From: Michael                       │
│ App: Gmail                          │
│                                     │
│ ─────────────────────────────────── │
│                                     │
│ AGENT: I found 3 similar events:    │
│ - 2 other PR review requests        │
│ - Both were opened in browser       │
│                                     │
│ Suggested action: Open PR in        │
│ browser and dismiss notification.   │
│                                     │
│ Should I proceed?                   │
│                                     │
│ USER: Yes, but also mark the email  │
│ as read.                            │
│                                     │
│ AGENT: Got it. I'll:                │
│ 1. Open PR in browser               │
│ 2. Mark email as read               │
│ 3. Dismiss notification             │
│                                     │
│ [EXECUTE]  [MODIFY]  [CANCEL]       │
│                                     │
├─────────────────────────────────────┤
│ > Type message...            [SEND] │
└─────────────────────────────────────┘
```

## Session Management

Training sessions are special ephemeral sessions:

- **Naming**: `notif-{timestamp}-{app}` (e.g., `notif-1771189805-gmail`)
- **Storage**: Sessions stored in `/data/notification-sessions/`
- **Context injection**: Session starts with:
  - The notification data
  - Relevant history from SQLite
  - Phone API capabilities
  - SMS/email history for sender (if applicable)

## Agent Capabilities

The agent has access to:

### Phone Control
- Dismiss notification
- Open app
- Tap notification actions (Reply, Archive, Mark read, etc.)
- Screen automation for complex flows

### Data Access
- SMS history (for message senders)
- Contacts (for name resolution)
- Previous notification history
- Training session logs

### Actions Library (grows over time)

Starting actions:
- `dismiss` - Clear the notification
- `open_app` - Open the source app
- `tap_action` - Tap a notification action button
- `archive_email` - Gmail-specific: archive and mark read
- `reply_sms` - Send an SMS reply
- `snooze` - Remind about this later

Complex actions (learned):
- `open_pr_and_dismiss` - Open GitHub PR in browser, dismiss
- `quick_reply` - Standard reply patterns
- `delegate` - Forward to someone else
- etc.

## Autonomy Levels (Future)

### Level 0: Always Ask (Initial)
Agent proposes, waits for user approval on every notification.

### Level 1: Ask If Unsure
Agent acts autonomously when confidence > 0.8, asks otherwise.
Confidence based on:
- Number of similar past events
- Consistency of past decisions
- Recency of training

### Level 2: Full Auto
Agent handles all notifications, logs for async review.
User reviews batched decisions periodically.

## API Endpoints Needed

### Homestead Server (Next.js)

```
GET  /api/notifications          - Get current phone notifications
POST /api/notifications/start    - Start training session for notification
POST /api/notifications/dismiss  - Dismiss without training
GET  /api/notifications/history  - Get notification event history
GET  /api/notifications/patterns - Get learned patterns
```

### Phone API (Already exists)

```
GET  /notifications              - List active notifications ✓
POST /notifications/dismiss      - Dismiss by key ✓
POST /notifications/dismiss-all  - Clear all ✓
```

## File Structure

```
/data/
  notification-agent.db          - SQLite database
  notification-sessions/         - Training session logs
    notif-1771189805-gmail.json
    notif-1771189810-messages.json

/app/
  components/
    NotificationPanel.tsx        - Main notification UI
    NotificationCard.tsx         - Individual notification
    TrainingSession.tsx          - Training dialogue UI
  api/
    notifications/
      route.ts                   - Notification endpoints
      history/route.ts
      patterns/route.ts
      start/route.ts
```

## Implementation Phases

### Phase 1: Foundation
- [ ] SQLite database setup
- [ ] Notification panel UI (like SMS panel)
- [ ] Basic "Start" flow that opens ephemeral session
- [ ] Log all notifications to database

### Phase 2: Memory & Matching
- [ ] Store training sessions
- [ ] Implement fuzzy matching
- [ ] Inject history into session context
- [ ] Basic pattern extraction

### Phase 3: Action Execution
- [ ] Define action types
- [ ] Execute actions via phone API
- [ ] Log action results
- [ ] Handle failures gracefully

### Phase 4: Autonomy
- [ ] Confidence scoring
- [ ] Auto-handling for high-confidence
- [ ] Batch review interface
- [ ] Override tracking

## Open Questions

1. **How long to retain notification history?** Forever? Rolling window?

2. **How to handle notification updates?** Some notifications update in place (e.g., "2 new messages" → "5 new messages")

3. **Should the agent proactively check for notifications?** Or only react when user opens the panel?

4. **How to handle sensitive content?** Some notifications may contain private info that shouldn't be logged.

5. **How to sync patterns across devices?** If you train on phone, should laptop Claude Code also know?
