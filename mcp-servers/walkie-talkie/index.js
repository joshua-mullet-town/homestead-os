#!/usr/bin/env node
/**
 * Walkie-Talkie MCP Server
 *
 * Inter-session communication for Homestead agents.
 * Send messages, broadcast to all stewards, and list active sessions.
 *
 * Messages go through the Homestead queue. Receivers must "roger that"
 * (confirm receipt) or the dispatcher retries delivery.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { messageTool } from './tools/message.js';
import { listSessionsTool } from './tools/list-sessions.js';
import { broadcastTool } from './tools/broadcast.js';
import { pullNextMessageTool } from './tools/pull-next-message.js';
import { setTimerTool } from './tools/set-timer.js';
import { startThreadTool, replyToThreadTool } from './tools/thread.js';

// `messageTool` is the unified "One Tool" entry (branches on recipient: josh=card,
// steward=walkie) and is now the ONLY messaging path — the legacy send_message
// tool was removed once the unified migration was proven non-regressed.
const tools = [messageTool, listSessionsTool, broadcastTool, pullNextMessageTool, setTimerTool, startThreadTool, replyToThreadTool];

const server = new Server(
  {
    name: 'walkie-talkie',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = tools.find(t => t.name === name);
  if (!tool) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: `Unknown tool: ${name}` }),
        },
      ],
    };
  }

  try {
    const result = await tool.execute(args || {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: error.message }),
        },
      ],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Walkie-Talkie MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
