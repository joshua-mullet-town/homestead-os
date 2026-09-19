# CUI Deep Dive: What We Can Extract

## The Good News

**YES, you can absolutely extract the Claude Code integration part!**

## How CUI Actually Works

### Architecture Breakdown

```
CUI
├── Backend (Node.js/Express)
│   ├── claude-process-manager.ts ⭐ THIS IS THE KEY FILE
│   ├── claude-history-reader.ts (reads ~/.claude/ sessions)
│   ├── stream-manager.ts (handles SSE streaming)
│   └── session-info-service.ts (SQLite storage)
│
└── Frontend (React/Vite)
    ├── Chat UI components
    ├── Markdown rendering
    └── Dictation (Gemini API)
```

### The Magic: `claude-process-manager.ts`

This file spawns and manages Claude Code CLI processes. Here's what it does:

**Key functionality:**
```typescript
// 1. Finds the Claude executable
const claudePath = path.join(packageRoot, 'node_modules', '.bin', 'claude');

// 2. Spawns Claude Code as a child process
const process = spawn(claudePath, args, {
  cwd: workingDirectory,
  env: {...process.env, ...envOverrides}
});

// 3. Parses JSON Lines output from Claude
process.stdout.on('data', (data) => {
  // Parse JSONL stream events
  // Forward to frontend via Server-Sent Events (SSE)
});

// 4. Sends input to Claude
process.stdin.write(JSON.stringify({ message: userInput }));
```

**What this means:**
- CUI literally just wraps the `claude` CLI command
- It's similar to your node-pty approach, but **structured** instead of raw terminal
- Claude Code outputs JSONL (JSON Lines) format when used programmatically
- CUI parses these events and renders them nicely

## What You Can Steal from CUI

### Option 1: Just Use Their Process Manager ⭐ EASIEST

**Copy these files to Homestead:**
```
src/services/claude-process-manager.ts
src/services/json-lines-parser.ts
src/services/claude-history-reader.ts
src/types/index.ts (for TypeScript types)
```

**Then in Homestead:**
```typescript
import { ClaudeProcessManager } from './claude-process-manager';

// Start a Claude session (no terminal needed!)
const manager = new ClaudeProcessManager();
const { streamingId } = await manager.startConversation({
  workingDirectory: '/path/to/repo',
  initialPrompt: 'List files in this directory',
  model: 'claude-sonnet-4.5'
});

// Listen for events
manager.on('stream-event', (event) => {
  // Render event in your custom mobile UI
  console.log(event);
});
```

**Pros:**
- ✅ No terminal UI needed
- ✅ Structured events instead of raw ANSI
- ✅ Can build custom mobile UI for events
- ✅ All Claude Code features work

**Cons:**
- ⚠️ Need to build your own UI for rendering events
- ⚠️ Have to understand JSONL event format

### Option 2: Fork CUI and Make It Fun 🎨

**What you'd do:**
1. Fork CUI repo
2. Keep the backend (process manager, SSE streaming)
3. **Completely redo the frontend** with your retro aesthetic
4. Add your voice dictation (OpenAI instead of Gemini)
5. Integrate with your Homestead GitHub dashboard

**Example: Make it match your vibe:**
```typescript
// Replace their boring chat UI with your retro style
<div className="card-orange shadow-retro-xl p-6">
  <h1 style={{ fontFamily: 'VT323' }}>🤖 CLAUDE CODE</h1>
  {messages.map(msg => (
    <div className="card-white shadow-retro-lg p-4 mb-4">
      <pre className="text-lg font-bold">{msg.content}</pre>
    </div>
  ))}
</div>
```

**Pros:**
- ✅ Keep proven backend
- ✅ Full control over UI/UX
- ✅ Can make it match your aesthetic
- ✅ Easier than building from scratch

**Cons:**
- ⚠️ Still need to understand their codebase
- ⚠️ More work than Option 1

### Option 3: Use Claude Agent SDK Instead 🚀 MOST FLEXIBLE

**Forget CUI entirely, use official SDK:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Same power as Claude Code, full control
for await (const event of query({
  prompt: userInput,
  options: { allowedTools: ["Read", "Write", "Bash"] }
})) {
  // Render in your custom UI
  renderMobileEvent(event);
}
```

**Pros:**
- ✅ Official Anthropic SDK
- ✅ Build UI exactly how you want
- ✅ No dependency on CUI
- ✅ TypeScript first-class support

**Cons:**
- ⚠️ Most work to build UI
- ⚠️ Need Anthropic API key (pay per use, not subscription)

## How Each Would Fit Into Homestead

### Current Homestead Flow:
```
User selects issue
  ↓
Create droplet
  ↓
SSH + run terminal server (node-pty + Socket.IO)
  ↓
xterm.js terminal on mobile
```

### Option 1: Add CUI Process Manager
```
User selects issue
  ↓
Create droplet
  ↓
Run CUI backend (Express + ClaudeProcessManager)
  ↓
Custom mobile UI (chat style, retro themed)
```

**Changes needed:**
- Replace node-pty terminal with CUI's process manager
- Build custom UI to render JSONL events
- Keep Socket.IO or switch to SSE (Server-Sent Events)

### Option 2: Fork CUI
```
User selects issue
  ↓
Create droplet
  ↓
Run YOUR forked CUI (retro styled)
  ↓
Already has mobile UI (but now it's fun!)
```

**Changes needed:**
- Fork CUI repo
- Restyle frontend with VT323 font, retro colors
- Replace Gemini dictation with OpenAI
- Integrate with Homestead session management

### Option 3: Agent SDK
```
User selects issue
  ↓
Create droplet (or skip - run locally!)
  ↓
Next.js API routes + Agent SDK
  ↓
Custom chat UI (like Claude.ai but retro)
```

**Changes needed:**
- Add Agent SDK to Homestead
- Build chat UI from scratch
- Don't need droplets for terminal anymore!

## My Recommendation

**Start with Option 1: Steal the Process Manager**

Why?
1. ✅ **Quickest path** - Just copy 4 files
2. ✅ **Test if structured events are better** - See if JSONL is nicer than raw terminal
3. ✅ **Low commitment** - If it sucks, try Option 3
4. ✅ **Keep your aesthetic** - Build whatever UI you want

**Then decide:**
- If you like it → Build out your custom UI
- If structured events feel limiting → Try Agent SDK (Option 3)
- If you love CUI but hate the look → Fork it (Option 2)

## Next Steps

Want me to:
1. **Extract the key files** from CUI into Homestead?
2. **Create a POC** showing how to use ClaudeProcessManager?
3. **Build a simple chat UI** using JSONL events with your retro style?
4. **Just move on** to Agent SDK approach instead?

Let me know what direction sounds interesting!

## The "Is It Worth It?" Question

**CUI teaches us:**
- ✅ Claude Code can be wrapped programmatically
- ✅ JSONL events are structured (might be easier on mobile than raw terminal)
- ✅ The backend is actually simple (just spawn + parse)

**But:**
- ⚠️ Their UI is sterile (your words!)
- ⚠️ Would need significant restyling
- ⚠️ Agent SDK might be cleaner long-term

**My gut:** Try extracting their process manager for a quick POC, see if structured events feel better than raw terminal. If yes, build your own UI around it. If no, jump to Agent SDK.
