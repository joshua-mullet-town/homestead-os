# Scheduling - Alarms, Timers & Notifications

Send push notifications to Josh's phone on a schedule.

## API Endpoint

```
POST https://localhost:3005/api/push/schedule
```

## How to Call It

Use Node.js to make HTTPS requests (curl has issues with the self-signed cert):

```javascript
node -e "
const https = require('https');

const data = JSON.stringify({
  delay_seconds: 60,
  title: 'Your Title Here',
  body: 'Your message here'
});

const options = {
  hostname: 'localhost',
  port: 3005,
  path: '/api/push/schedule',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  },
  rejectUnauthorized: false
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => console.log(body));
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(data);
req.end();
"
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `delay_seconds` | number | Yes | Seconds from now until notification fires |
| `title` | string | Yes | Notification title (keep short) |
| `body` | string | Yes | Notification message |
| `data` | object | No | Extra data to include |

## Response

```json
{
  "id": "job-1706912345-abc123",
  "fires_at": "2026-02-03T17:00:00.000Z",
  "status": "scheduled"
}
```

## Time Conversion Reference

| User Says | delay_seconds |
|-----------|---------------|
| "1 minute" | 60 |
| "5 minutes" | 300 |
| "10 minutes" | 600 |
| "30 minutes" | 1800 |
| "1 hour" | 3600 |
| "2 hours" | 7200 |

For specific times (e.g., "at 5:00 PM"), calculate the difference from now:
```javascript
const now = new Date();
const target = new Date('2026-02-03T17:00:00-05:00'); // 5:00 PM EST
const delaySeconds = Math.floor((target - now) / 1000);
```

## Examples

### Simple alarm in 5 minutes
```javascript
{
  delay_seconds: 300,
  title: "Timer",
  body: "5 minutes is up!"
}
```

### Reminder with context
```javascript
{
  delay_seconds: 1800,
  title: "Reminder",
  body: "Take the laundry out of the dryer"
}
```

### Alarm at specific time
Calculate `delay_seconds` based on current time and target time (remember: Eastern Time).

## Follow-up Questions

If Josh's request is ambiguous, ask:

- **No time specified**: "When would you like to be reminded?"
- **Unclear duration**: "Did you mean 5 minutes or 5 hours?"
- **No message**: "What should the reminder say?"

## Listing Scheduled Jobs

```
GET https://localhost:3005/api/push/schedule
```

Returns all pending scheduled notifications.

## Canceling a Job

```
DELETE https://localhost:3005/api/push/schedule?id=JOB_ID
```

Use if Josh wants to cancel a scheduled notification.
