// SDK-URL Demo - Proper WebSocket protocol implementation
// Based on reverse-engineered protocol from The-Vibe-Company/companion

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = 3456;
let sessionId = null;
let browserSocket = null;
let cliSocket = null;

// Create HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Claude SDK-URL Demo</title>
  <style>
    body { background: #1a1a1a; color: #00ff66; font-family: monospace; padding: 20px; }
    #messages { height: 60vh; overflow-y: auto; border: 1px solid #333; padding: 10px; margin-bottom: 10px; }
    .msg { margin: 5px 0; padding: 8px; border-left: 3px solid #333; background: #222; }
    .msg.assistant { border-color: #00ff66; }
    .msg.user { border-color: #ff6600; }
    .msg.system { border-color: #ffcc00; }
    .msg.tool { border-color: #6666ff; background: #1a1a2e; }
    .msg.result { border-color: #ff00ff; }
    input { width: 75%; padding: 10px; background: #333; color: white; border: none; font-size: 16px; }
    button { padding: 10px 20px; background: #ff6600; color: black; border: none; cursor: pointer; margin-left: 5px; }
    button:hover { background: #ffcc00; }
    pre { white-space: pre-wrap; word-wrap: break-word; margin: 5px 0; font-size: 13px; }
    .tool-name { color: #ffcc00; font-weight: bold; }
    h1 { color: #ff6600; }
    #status { padding: 10px; background: #333; margin-bottom: 10px; }
  </style>
</head>
<body>
  <h1>Claude Code WebSocket Demo</h1>
  <div id="status">Waiting for connections...</div>
  <div id="messages"></div>
  <input type="text" id="input" placeholder="Type a message to send to Claude..." />
  <button onclick="send()">Send</button>

  <script>
    const ws = new WebSocket('ws://localhost:${PORT}/browser');
    const messages = document.getElementById('messages');
    const status = document.getElementById('status');
    const input = document.getElementById('input');

    function addMessage(type, content) {
      const div = document.createElement('div');
      div.className = 'msg ' + type;
      if (typeof content === 'object') {
        div.innerHTML = '<pre>' + JSON.stringify(content, null, 2) + '</pre>';
      } else {
        div.innerHTML = content;
      }
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    ws.onopen = () => {
      status.innerHTML = '🟡 Browser connected. Waiting for Claude CLI...';
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('Received:', data);

      if (data.type === 'status') {
        status.innerHTML = data.message;
        return;
      }

      if (data.type === 'system' && data.subtype === 'init') {
        addMessage('system', '<strong>SYSTEM INIT</strong><br>Session: ' + data.session_id + '<br>Model: ' + data.model);
      } else if (data.type === 'assistant') {
        let content = '';
        if (data.message && data.message.content) {
          data.message.content.forEach(block => {
            if (block.type === 'text') {
              content += '<div>' + block.text.replace(/\\n/g, '<br>') + '</div>';
            } else if (block.type === 'tool_use') {
              content += '<div class="tool-name">🔧 Tool: ' + block.name + '</div>';
              content += '<pre>' + JSON.stringify(block.input, null, 2) + '</pre>';
            }
          });
        }
        addMessage('assistant', '<strong>CLAUDE:</strong>' + content);
      } else if (data.type === 'control_request' && data.request?.subtype === 'can_use_tool') {
        addMessage('tool', '<strong>⚠️ PERMISSION REQUEST</strong><br>Tool: <span class="tool-name">' +
          data.request.tool_name + '</span><pre>' + JSON.stringify(data.request.input, null, 2) + '</pre>' +
          '<em>Auto-approved</em>');
      } else if (data.type === 'result') {
        const resultClass = data.is_error ? 'tool' : 'result';
        addMessage(resultClass, '<strong>RESULT (' + data.subtype + ')</strong><pre>' +
          (data.result || JSON.stringify(data, null, 2)) + '</pre>');
      } else if (data.type === 'stream_event') {
        // Streaming events - could show token by token but keeping simple
      } else {
        addMessage('system', data);
      }
    };

    ws.onclose = () => {
      status.innerHTML = '🔴 Disconnected';
    };

    function send() {
      const text = input.value;
      if (!text) return;
      ws.send(JSON.stringify({ action: 'send_message', text }));
      addMessage('user', '<strong>YOU:</strong> ' + text);
      input.value = '';
    }

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') send();
    });
  </script>
</body>
</html>
    `);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const path = req.url;
  console.log('WebSocket connection:', path);

  if (path === '/browser') {
    browserSocket = ws;
    console.log('Browser connected');

    if (cliSocket) {
      ws.send(JSON.stringify({ type: 'status', message: '🟢 Both connected! Claude CLI is ready.' }));
    }

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('From browser:', msg);

      if (msg.action === 'send_message' && cliSocket && sessionId) {
        // Send user message to CLI with proper format
        const userMsg = {
          type: 'user',
          message: { role: 'user', content: msg.text },
          parent_tool_use_id: null,
          session_id: sessionId
        };
        cliSocket.send(JSON.stringify(userMsg) + '\n');
        console.log('Sent to CLI:', userMsg);
      }
    });

    ws.on('close', () => {
      browserSocket = null;
      console.log('Browser disconnected');
    });

  } else if (path.startsWith('/cli')) {
    cliSocket = ws;
    console.log('CLI connected!');

    if (browserSocket) {
      browserSocket.send(JSON.stringify({ type: 'status', message: '🟢 Claude CLI connected! Ready to chat.' }));
    }

    // With -p "" (empty prompt), we need to send the first user message to kick things off
    console.log('CLI connected - sending initial empty message to trigger system/init...');
    setTimeout(() => {
      if (cliSocket === ws) {
        const userMsg = {
          type: 'user',
          message: { role: 'user', content: '' },
          parent_tool_use_id: null,
          session_id: ''
        };
        ws.send(JSON.stringify(userMsg) + '\n');
        console.log('Sent empty user message to trigger init');
      }
    }, 500);

    ws.on('message', (data, isBinary) => {
      console.log('Raw message received, isBinary:', isBinary, 'length:', data.length);
      const text = data.toString();
      console.log('From CLI (raw):', text.substring(0, 500));

      // Parse NDJSON - each line is a JSON object
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          console.log('Parsed message type:', parsed.type, parsed.subtype || '');

          // Handle system/init - capture session_id
          if (parsed.type === 'system' && parsed.subtype === 'init') {
            sessionId = parsed.session_id;
            console.log('Got session_id:', sessionId);
            console.log('Ready for multi-turn conversation!');

            // Notify browser we're ready
            if (browserSocket && browserSocket.readyState === 1) {
              browserSocket.send(JSON.stringify({
                type: 'status',
                message: '🟢 Claude ready! Session: ' + sessionId.substring(0, 8) + '... Type a message below.'
              }));
            }
          }


          // Handle permission requests - auto-approve
          if (parsed.type === 'control_request' && parsed.request?.subtype === 'can_use_tool') {
            const response = {
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: parsed.request_id,
                response: {
                  behavior: 'allow',
                  updatedInput: parsed.request.input
                }
              }
            };
            cliSocket.send(JSON.stringify(response) + '\n');
            console.log('Auto-approved tool:', parsed.request.tool_name);
          }

          // Forward to browser
          if (browserSocket && browserSocket.readyState === 1) {
            browserSocket.send(JSON.stringify(parsed));
          }
        } catch (e) {
          console.log('Failed to parse:', line.substring(0, 100));
        }
      }
    });

    ws.on('close', () => {
      cliSocket = null;
      sessionId = null;
      console.log('CLI disconnected');
      if (browserSocket) {
        browserSocket.send(JSON.stringify({ type: 'status', message: '🔴 Claude CLI disconnected' }));
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`
========================================
SDK-URL Demo Server running!
========================================

1. Open browser: http://localhost:${PORT}

2. In another terminal, run:
   claude --sdk-url ws://localhost:${PORT}/cli \\
          --print \\
          --output-format stream-json \\
          --input-format stream-json \\
          -p "Hello! Introduce yourself briefly."

3. Watch the messages flow in your browser!

========================================
  `);
});
