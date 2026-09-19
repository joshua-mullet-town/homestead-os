# Alfred — a notification-triage steward

Alfred is one agent in a personal multi-agent system. His job: read every
notification that reaches his principal — texts, email, Slack, CI alerts —
and decide what is worth interrupting a human for.

This repository is a **redacted public mirror**. Real names, phone numbers,
addresses and email addresses have been replaced with role labels
(`his wife`, `<phone>`, `<his home address>`). The reasoning is unmodified.

## What's here

| File | What it is |
|---|---|
| `CLAUDE.md` | Alfred's operating creed — his standing instructions |
| `knowledge/rules.md` | The rulebook: what to drop, what to route, what to surface |
| `skills/triage-notification.md` | The core triage procedure |
| `skills/manage-calendar.md` | Calendar handling and leave-time logistics |
| `skills/manage-todos.md` | To-do list management |
| `skills/directions.md` | Place lookup and directions |

## Why it might be interesting

Most of this is **failure-driven**. Nearly every rule exists because
something went wrong once and got written down. The rulebook is less a
specification than an accumulated record of being corrected.
