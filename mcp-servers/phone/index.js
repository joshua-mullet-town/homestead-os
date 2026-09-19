#!/usr/bin/env node
/**
 * Phone MCP Server
 *
 * Wraps the Android phone's HTTP API (running on the phone at port 8888)
 * and exposes it as MCP tools for Claude Code sessions.
 *
 * Connects over Tailscale — no ADB dependency.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PHONE_BASE_URL = process.env.PHONE_API_URL || 'http://<<REPLACE: your Tailscale IP>>:8888';
// The Homestead server (:3005) hosts the transport-agnostic message-history store,
// which persists RCS + SMS thread bodies from the notification tray. Thread-history
// reads go here, NOT to the phone bridge (whose /sms/inbox is SMS-content-provider
// only and misses RCS entirely).
const HOMESTEAD_BASE_URL = process.env.HOMESTEAD_API_URL || 'http://localhost:3005';

// Helper to make HTTP requests to the phone
async function phoneRequest(path, options = {}) {
  const url = `${PHONE_BASE_URL}${path}`;
  const fetchOptions = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  };

  const response = await fetch(url, fetchOptions);
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: response.status };
  }
}

// Helper to make HTTP requests to the Homestead server (message-history store, etc.)
async function homesteadRequest(path, options = {}) {
  const url = `${HOMESTEAD_BASE_URL}${path}`;
  const fetchOptions = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  };

  const response = await fetch(url, fetchOptions);
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: response.status };
  }
}

// Tool definitions
const tools = [
  {
    name: 'check_device_connection',
    description: 'Check if the Android phone is reachable over Tailscale. Returns health status and device info.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      try {
        const health = await phoneRequest('/health');
        const info = await phoneRequest('/');
        return { connected: true, ...info, health };
      } catch (e) {
        return { connected: false, error: e.message };
      }
    },
  },
  {
    name: 'get_device_info',
    description: 'Get device information including model, Android version, battery level, and IP address.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/device');
    },
  },
  {
    name: 'send_text_message',
    description: 'Send an SMS text message from the phone.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Phone number to send to' },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['to', 'message'],
    },
    async execute({ to, message }) {
      return phoneRequest('/sms/send', {
        method: 'POST',
        body: JSON.stringify({ to, message }),
      });
    },
  },
  {
    name: 'draft_text_message',
    description: 'Save a text message as a draft in the Messages app WITHOUT sending it. Returns draft IDs and an sms: URI for deep linking. Joshua can review and send manually.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Phone number to draft the message to' },
        message: { type: 'string', description: 'Message text to save as draft' },
      },
      required: ['to', 'message'],
    },
    async execute({ to, message }) {
      return phoneRequest('/sms/draft', {
        method: 'POST',
        body: JSON.stringify({ to, message }),
      });
    },
  },
  {
    name: 'receive_text_messages',
    description: 'Get recent received SMS messages from the phone inbox. NOTE: this reads the SMS content provider only — it does NOT include RCS / Google-Messages threads (those are never written to the SMS DB). To read a conversation transport-agnostically (SMS AND RCS), use read_message_thread instead.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default: 10)', default: 10 },
      },
    },
    async execute({ limit = 10 }) {
      return phoneRequest(`/sms/inbox?limit=${limit}`);
    },
  },
  {
    name: 'read_message_thread',
    description: 'Read a text conversation\'s history by contact number OR name, transport-agnostically — returns SMS AND RCS / Google-Messages bodies alike. Use this (not receive_text_messages) whenever you need a thread\'s history, because RCS threads are invisible to the SMS-only readers. Matches by phone number in any format ("(616) 406-8841", "+16164068841", "6164068841") or by display-name substring. History is forward-from-when-capture-went-live (messages that arrived since); it does not retroactively recover already-cleared past messages.',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Phone number (any format) or contact/display-name substring to read the thread for' },
        limit: { type: 'number', description: 'Max messages to return, most recent (default: 50)', default: 50 },
      },
      required: ['contact'],
    },
    async execute({ contact, limit = 50 }) {
      return homesteadRequest(
        `/api/message-history?contact=${encodeURIComponent(contact)}&limit=${limit}`
      );
    },
  },
  {
    name: 'read_contact_history',
    description: 'Read a contact\'s TRUE text HISTORY from the phone\'s REAL Messages store on demand — "read the last N texts from my mom" — regardless of when the messages arrived. This is different from read_message_thread (which only holds messages captured since the forward-buffer went live, so it returns nothing for someone who hasn\'t texted recently). This reads the actual phone: SMS history comes straight from the Android SMS store and is ALWAYS available (even when the phone is locked); RCS / Google-Messages history requires the phone to be AWAKE and UNLOCKED (Android does not let the read cross the lockscreen) — when the phone is locked the tool says so plainly instead of returning a false empty. Already-deleted messages cannot be recovered. Match by phone number in any format ("<<REPLACE: a phone number>>", "+15745369591"). Returns { sms: {...}, rcs: {...}, rails: {...} }.',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Phone number (any format) to read history for' },
        limit: { type: 'number', description: 'Max messages to return, most recent (default: 50)', default: 50 },
        rcs: { type: 'boolean', description: 'Attempt the RCS accessibility scrape when SMS has nothing (needs phone unlocked). Default true. Set false for SMS-only.', default: true },
      },
      required: ['contact'],
    },
    async execute({ contact, limit = 50, rcs = true }) {
      const rcsParam = rcs ? '1' : '0';
      return homesteadRequest(
        `/api/contact-history?contact=${encodeURIComponent(contact)}&limit=${limit}&rcs=${rcsParam}`
      );
    },
  },
  {
    name: 'get_sent_messages',
    description: 'Get recently sent SMS messages from the phone.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default: 5)', default: 5 },
      },
    },
    async execute({ limit = 5 }) {
      return phoneRequest(`/sms/sent?limit=${limit}`);
    },
  },
  {
    name: 'get_contacts',
    description: 'Get contacts from the phone. Each contact includes a "notes" field (the standard Notes box from the phone Contacts app) — this is the authoritative identity record for a person. The search param matches by name OR by phone number in any format ("+1 574-...", "574-...", "(888) ..." all match) — use it for reverse-lookup from a bare SMS-sender number to a contact and their notes.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max contacts to return (default: 20)', default: 20 },
        search: { type: 'string', description: 'Filter contacts by name substring OR by phone number (any format)' },
      },
    },
    async execute({ limit = 20, search }) {
      if (search) {
        return phoneRequest(`/contacts/search?q=${encodeURIComponent(search)}&limit=${limit}`);
      }
      return phoneRequest(`/contacts?limit=${limit}`);
    },
  },
  {
    name: 'set_contact_notes',
    description: 'Set or update the standard Notes field on an EXISTING phone contact (the Notes box in the Contacts app). Use the contact id from get_contacts. Only the Notes field is changed — name, phone, and email are left untouched. This is where identity/context about a person should be recorded so it can be read back authoritatively.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact id (from get_contacts)' },
        notes: { type: 'string', description: 'Notes text to store on the contact' },
      },
      required: ['id', 'notes'],
    },
    async execute({ id, notes }) {
      return phoneRequest('/contacts/notes', {
        method: 'POST',
        body: JSON.stringify({ id, notes }),
      });
    },
  },
  {
    name: 'add_contact',
    description: 'Add a new contact to the phone.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Contact display name' },
        phone: { type: 'string', description: 'Phone number' },
        email: { type: 'string', description: 'Email address (optional)' },
      },
      required: ['name', 'phone'],
    },
    async execute({ name, phone, email }) {
      return phoneRequest('/contacts/add', {
        method: 'POST',
        body: JSON.stringify({ name, phone, email }),
      });
    },
  },
  {
    name: 'send_group_text',
    description: 'Send an SMS text message to multiple recipients (group text).',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of phone numbers to send to',
        },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['to', 'message'],
    },
    async execute({ to, message }) {
      return phoneRequest('/sms/send-group', {
        method: 'POST',
        body: JSON.stringify({ to, message }),
      });
    },
  },
  {
    name: 'get_notifications',
    description: 'Get active notifications on the phone.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/notifications');
    },
  },
  {
    name: 'dismiss_notification',
    description: 'Dismiss a specific notification by its key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Notification key to dismiss' },
      },
      required: ['key'],
    },
    async execute({ key }) {
      return phoneRequest('/notifications/dismiss', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
    },
  },
  {
    name: 'launch_app',
    description: 'Launch an app on the phone by package name.',
    inputSchema: {
      type: 'object',
      properties: {
        packageName: { type: 'string', description: 'Package name (e.g., com.google.android.youtube)' },
      },
      required: ['packageName'],
    },
    async execute({ packageName }) {
      return phoneRequest('/app/launch', {
        method: 'POST',
        body: JSON.stringify({ packageName }),
      });
    },
  },
  {
    name: 'list_installed_apps',
    description: 'List all installed apps on the phone.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/app/list');
    },
  },
  {
    name: 'set_alarm',
    description: 'Set an alarm on the phone. The alarm fires with sound, vibration, and a notification. It is a one-shot alarm (not recurring).',
    inputSchema: {
      type: 'object',
      properties: {
        hour: { type: 'number', description: 'Hour (0-23)' },
        minute: { type: 'number', description: 'Minute (0-59)' },
        message: { type: 'string', description: 'Alarm label/message' },
      },
      required: ['hour', 'minute'],
    },
    async execute({ hour, minute, message }) {
      return phoneRequest('/alarm/set', {
        method: 'POST',
        body: JSON.stringify({ hour, minute, label: message }),
      });
    },
  },
  {
    name: 'list_alarms',
    description: 'List all upcoming alarms set on the phone, sorted by next fire time.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/alarm/list');
    },
  },
  {
    name: 'delete_alarm',
    description: 'Delete a scheduled alarm by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Alarm ID to delete (from list_alarms)' },
      },
      required: ['id'],
    },
    async execute({ id }) {
      return phoneRequest('/alarm/delete', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
    },
  },
  {
    name: 'start_timer',
    description: 'Start a countdown timer on the phone. Specify durationSeconds for a custom timer, or presetId to use a saved preset (e.g., "preset_32" for 32s, "preset_45" for 45s).',
    inputSchema: {
      type: 'object',
      properties: {
        durationSeconds: { type: 'number', description: 'Timer duration in seconds' },
        presetId: { type: 'string', description: 'Preset ID (e.g., "preset_32", "preset_45")' },
      },
    },
    async execute({ durationSeconds, presetId }) {
      const body = {};
      if (presetId) body.presetId = presetId;
      else if (durationSeconds) body.durationSeconds = durationSeconds;
      return phoneRequest('/timer/start', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  },
  {
    name: 'stop_timer',
    description: 'Stop a running timer by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Timer ID to stop (from list_timers)' },
      },
      required: ['id'],
    },
    async execute({ id }) {
      return phoneRequest('/timer/stop', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
    },
  },
  {
    name: 'list_timers',
    description: 'List all active timers on the phone with remaining time.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/timer/list');
    },
  },
  {
    name: 'get_crash_log',
    description: 'Get recent crash reports from the Homestead APK. Check this when the app crashes or behaves unexpectedly.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/crash-log');
    },
  },
  {
    name: 'clear_crash_log',
    description: 'Clear the crash log after reviewing crashes.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/crash-log/clear', { method: 'POST' });
    },
  },
  {
    name: 'get_screen_content',
    description: 'Get the current screen content via accessibility service. Returns the full UI tree as text.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/screen/content');
    },
  },
  {
    name: 'tap_screen',
    description: 'Tap a specific location on the screen by x,y coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
      },
      required: ['x', 'y'],
    },
    async execute({ x, y }) {
      return phoneRequest('/screen/tap', {
        method: 'POST',
        body: JSON.stringify({ x, y }),
      });
    },
  },
  {
    name: 'swipe_screen',
    description: 'Swipe on the screen from one point to another.',
    inputSchema: {
      type: 'object',
      properties: {
        startX: { type: 'number', description: 'Start X coordinate' },
        startY: { type: 'number', description: 'Start Y coordinate' },
        endX: { type: 'number', description: 'End X coordinate' },
        endY: { type: 'number', description: 'End Y coordinate' },
      },
      required: ['startX', 'startY', 'endX', 'endY'],
    },
    async execute({ startX, startY, endX, endY }) {
      return phoneRequest('/screen/swipe', {
        method: 'POST',
        body: JSON.stringify({ startX, startY, endX, endY }),
      });
    },
  },
  {
    name: 'click_element',
    description: 'Click a UI element by text content or resource ID.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text content of the element to click' },
        resourceId: { type: 'string', description: 'Resource ID of the element to click' },
        contentDescription: { type: 'string', description: 'Content description of the element' },
      },
    },
    async execute({ text, resourceId, contentDescription }) {
      return phoneRequest('/screen/click', {
        method: 'POST',
        body: JSON.stringify({ text, resourceId, contentDescription }),
      });
    },
  },
  {
    name: 'press_back',
    description: 'Press the back button on the phone.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/screen/back', { method: 'POST' });
    },
  },
  {
    name: 'press_home',
    description: 'Press the home button on the phone.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/screen/home', { method: 'POST' });
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the currently focused input field on the phone.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['text'],
    },
    async execute({ text }) {
      return phoneRequest('/screen/input', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
    },
  },
  {
    name: 'wake_screen',
    description: 'Wake up the phone screen if it is off.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/screen/wake', { method: 'POST' });
    },
  },
  {
    name: 'get_screen_status',
    description: 'Get accessibility service status and screen state.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/screen/status');
    },
  },
  {
    name: 'get_brightness',
    description: 'Get current screen brightness level.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/screen/brightness');
    },
  },
  {
    name: 'open_uri',
    description: 'Open a URI on the phone using ACTION_VIEW intent. Supports any URI scheme: google.navigation: (Maps directions), tel: (phone calls), sms: (text messages), https: (web links), vnd.youtube: (YouTube), or any app deep link.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'URI to open (e.g., "google.navigation:q=123+Main+St", "tel:+15551234567", "https://example.com")' },
      },
      required: ['uri'],
    },
    async execute({ uri }) {
      return phoneRequest('/app/launch', {
        method: 'POST',
        body: JSON.stringify({ uri }),
      });
    },
  },
  {
    name: 'get_location',
    description: 'Get the phone\'s current GPS location. Returns latitude, longitude, accuracy in meters, provider, and age of the fix in seconds.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return phoneRequest('/location');
    },
  },
];

// Create the server
const server = new Server(
  {
    name: 'phone',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = tools.find(t => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
    };
  }

  try {
    const result = await tool.execute(args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Phone MCP server running on stdio (Tailscale, no ADB)');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
