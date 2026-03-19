# Feishu Remote Control for Claude Code CLI - Implementation Plan

## Context

### Problem Background
Developers want to remotely control Claude Code CLI on their work computers via mobile phones to continue coding when they're not in the office. Traditional command-line interaction is not mobile-friendly, requiring a remote control solution optimized for mobile devices.

### Core Requirements
1. **Local Deployment Mode**: Each developer installs client tools on their own local computer and remotely controls their own computer through a Feishu bot
2. **Mobile-Friendly Interaction**: Simplified command syntax, natural language interaction, rich text message formatting
3. **Reuse Existing Capabilities**: Fully leverage local Claude Code CLI commands, skills, and context information
4. **Security Sandbox**: Only allow operations within specified whitelist directories to prevent accidental operations
5. **Multi-User Isolation**: Team shares one Feishu bot, but each person can only control their own computer

### Design Goals
- Simple Installation: npm global install, one-click startup
- Convenient Usage: Auto-binding, background resident, auto-start on boot
- Secure and Reliable: Directory whitelist, command filtering, device authentication
- Mobile Optimized: Simplified commands, progress indicators, code highlighting

---

## Technical Architecture

### System Architecture Diagram

```
┌─────────────────┐         ┌──────────────────────────────┐
│  Feishu Server  │         │  Developer A's Work PC       │
│                 │         │  (Mac/Linux)                 │
│  Developer A's  │◀───────▶│  ┌─────────────────────────┐ │
│  Phone          │         │  │  remote-cli (local)     │ │
│  Private Chat   │         │  │  - WebSocket Client     │ │
│  with Bot       │         │  │  - Claude Code Executor │ │
└─────────────────┘         │  │  - Security Directory   │ │
        │                   │  │    Guard                │ │
        │                   │  └──────────┬──────────────┘ │
        │                   │             ▼                 │
        │                   │  Local Claude Code CLI        │
        ▼                   │  (Using Agent SDK)            │
┌─────────────────┐         └──────────────────────────────┘
│  Router Server  │
│  (Team Deploy)  │         ┌──────────────────────────────┐
│  ┌───────────┐  │         │  Developer B's Work PC       │
│  │ Webhook   │  │         │  ┌─────────────────────────┐ │
│  │ Handler   │  │◀───────▶│  │  remote-cli (local)     │ │
│  └───────────┘  │         │  └─────────────────────────┘ │
│  ┌───────────┐  │         └──────────────────────────────┘
│  │WebSocket  │  │
│  │   Hub     │  │
│  └───────────┘  │
│  ┌───────────┐  │
│  │  Binding  │  │
│  │  Registry │  │
│  └───────────┘  │
└─────────────────┘
```

### Core Components

#### 1. Router Server
- **Responsibilities**: Message forwarding, user binding management, device connection management
- **Tech Stack**: Node.js + Koa + WebSocket + JSON file storage
- **Deployment**: One cloud server within the team (2 cores 4GB is sufficient)

#### 2. Local Client (remote-cli)
- **Responsibilities**: Receive commands, invoke Claude Code, security control, return results
- **Tech Stack**: TypeScript + Claude Agent SDK + WebSocket Client
- **Installation**: npm global install (`npm install -g @yu_robotics/remote-cli`)

---

## User Binding Mechanism

### Binding Flow

```
Developer's Local PC                  Router Server              Feishu Bot
     │                                      │                            │
     │ 1. remote-cli init                   │                            │
     ├─────────────────────────────────────▶│                            │
     │   Generate binding code: ABC-123-XYZ │                            │
     │   Device ID: dev_mac_xxx             │                            │
     │   Establish WebSocket connection     │                            │
     │                                      │                            │
     │                                      │  2. User sends in Feishu:  │
     │                                      │     /bind ABC-123-XYZ      │
     │                                      │◀───────────────────────────│
     │                                      │                            │
     │                                      │  Verify binding code       │
     │                                      │  Store: open_id → device_id│
     │                                      │                            │
     │ 3. Binding success notification      │                            │
     │◀─────────────────────────────────────│                            │
     │   open_id: ou_xxx                    │  Send confirmation message │
     │   Ready to use                       │───────────────────────────▶│
     │                                      │                            │
```

### Key Data Structures

```typescript
// Binding Code (5 minutes validity)
interface BindingCode {
  code: string;           // "ABC-123-XYZ"
  deviceId: string;       // "dev_mac_xxx"
  createdAt: number;
  expiresAt: number;
}

// Binding Record (stored in JSON file)
interface UserBinding {
  openId: string;         // Feishu user open_id
  deviceId: string;       // Device unique identifier
  deviceName: string;     // "MacBook-Pro-xxx"
  boundAt: number;
  lastActiveAt: number;
}
```

---

## Message Flow

### Complete Message Processing Flow

```
1. User sends in Feishu: "Fix TypeScript errors in ~/projects/my-app"
   │
   ▼
2. Feishu Webhook → Router Server
   - Extract open_id
   - Find binding relationship: open_id → device_id
   - Check device online status
   │
   ▼
3. Router Server → Local Client (WebSocket)
   {
     type: "command",
     messageId: "msg_xxx",
     content: "Fix TypeScript errors in ~/projects/my-app",
     timestamp: 1234567890
   }
   │
   ▼
4. Local Client Processing
   - DirectoryGuard.resolveWorkingDirectory("~/projects/my-app")
   - Verify directory is in whitelist
   - If valid, continue; if invalid, return error
   │
   ▼
5. Invoke Claude Code Agent SDK
   await query({
     prompt: "Fix TypeScript errors",
     cwd: "/Users/xxx/projects/my-app",
     allowedTools: [...restricted tool list]
   })
   │
   ▼
6. Stream Return Results
   - Local Client → Router Server (WebSocket)
   - Router Server → Feishu API
   - Feishu Push → User's Phone
```

---

## Security Control Design

### 1. Directory Whitelist Mechanism

**Configuration Example** (`~/.remote-cli/config.json`):
```json
{
  "security": {
    "allowedDirectories": [
      "~/projects",
      "~/work",
      "~/code/company-repos"
    ],
    "deniedCommands": [
      "rm -rf /",
      "sudo rm",
      ":(){:|:&};:",
      "dd if=/dev/zero"
    ],
    "maxConcurrentTasks": 1
  }
}
```

**Implementation**: DirectoryGuard class
- Normalize paths (supports `~`, relative paths, absolute paths)
- Prevent path traversal attacks (`../../../etc/passwd`)
- Validate cwd and all file paths before execution

### 2. Command Filtering

```typescript
// Dangerous command patterns
const DENIED_PATTERNS = [
  /rm\s+-rf\s+\/\s*$/,           // rm -rf /
  /sudo\s+(rm|dd|mkfs)/,         // sudo dangerous operations
  />\s*\/dev\/sd[a-z]/,          // Direct disk writes
  /chmod\s+777\s+-R\s+\//,       // Global permission changes
];

function isSafeCommand(cmd: string): boolean {
  return !DENIED_PATTERNS.some(pattern => pattern.test(cmd));
}
```

### 3. Claude Code Tool Restrictions

```typescript
const allowedTools = [
  'Read',      // Read files
  'Glob',      // Find files
  'Grep',      // Search content
  {
    tool: 'Edit',
    filter: (filePath: string) => directoryGuard.isSafePath(filePath, cwd)
  },
  {
    tool: 'Bash',
    filter: (cmd: string) => isSafeCommand(cmd) && !cmd.includes('cd ')
  }
];
```

---

## Mobile Interaction Optimization

### 1. Simplified Command Syntax

| User Input | Maps to Claude Code Command |
|---------|------------------------|
| `/r` or `/resume` | `claude --resume` |
| `/c` or `/continue` | `claude --continue` |
| `/clear` | Clear current session |
| `/status` | View device status and current working directory |
| `/cd ~/projects/app` | Switch working directory (must be in whitelist) |
| `/help` | Show available commands list |

### 2. Rich Text Message Formatting

Feishu supports rich text cards for code highlighting:

```typescript
function formatAsFeishuCard(output: string): FeishuCard {
  return {
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: formatMarkdown(output)  // Supports code highlighting
        }
      }
    ]
  };
}
```

### 3. Progress Indicator Messages

```typescript
// Start processing
await feishuClient.sendMessage(chatId, "🤔 Thinking...");

// Long-running task
await feishuClient.sendMessage(chatId, "⏳ Executing, estimated 1-2 minutes...");

// Completion
await feishuClient.sendMessage(chatId, "✅ Task completed!");
```

### 4. User-Friendly Error Messages

```typescript
if (!directoryGuard.isAllowed(requestedDir)) {
  return `❌ Directory not in whitelist: ${requestedDir}

Allowed directories:
${config.allowedDirectories.map(d => `• ${d}`).join('\n')}

Please contact administrator to add directory, or use \`remote-cli config add-dir <path>\``;
}
```

---

## Project Structure

```
remote-cli/
├── packages/
│   ├── cli/                              # Local client
│   │   ├── src/
│   │   │   ├── index.ts                  # CLI entry point
│   │   │   ├── commands/
│   │   │   │   ├── init.ts               # Initialization and binding
│   │   │   │   ├── start.ts              # Start service
│   │   │   │   ├── stop.ts               # Stop service
│   │   │   │   ├── status.ts             # Service status
│   │   │   │   └── config.ts             # Configuration management
│   │   │   ├── client/
│   │   │   │   ├── WebSocketClient.ts    # WebSocket client
│   │   │   │   └── MessageHandler.ts     # Message handler
│   │   │   ├── executor/
│   │   │   │   ├── index.ts              # Executor factory
│   │   │   │   ├── ClaudeExecutor.ts     # Spawn mode executor
│   │   │   │   └── ClaudePersistentExecutor.ts  # Persistent mode executor
│   │   │   ├── hooks/
│   │   │   │   ├── index.ts              # Hook exports
│   │   │   │   ├── ClaudeCodeHooks.ts    # Claude Code event hooks
│   │   │   │   └── FeishuNotificationAdapter.ts  # Feishu notification adapter
│   │   │   ├── security/
│   │   │   │   └── DirectoryGuard.ts     # Directory security guard
│   │   │   ├── config/
│   │   │   │   └── ConfigManager.ts      # Configuration manager
│   │   │   ├── types/
│   │   │   │   ├── index.ts              # Message type definitions
│   │   │   │   └── config.ts             # Config type definitions
│   │   │   └── utils/
│   │   │       ├── FeishuMessageFormatter.ts  # Feishu message formatting
│   │   │       └── stripAnsi.ts          # ANSI escape code stripping
│   │   ├── bin/
│   │   │   └── remote-cli.js             # CLI executable
│   │   └── package.json
│   │
│   └── router/                            # Router server
│       ├── src/
│       │   ├── cli.ts                     # CLI entry point
│       │   ├── server.ts                  # Server setup
│       │   ├── websocket/
│       │   │   └── ConnectionHub.ts       # WebSocket connection hub
│       │   ├── binding/
│       │   │   └── BindingManager.ts      # Binding manager
│       │   ├── commands/
│       │   │   ├── config.ts              # Router config command
│       │   │   ├── start.ts               # Router start command
│       │   │   ├── stop.ts                # Router stop command
│       │   │   └── status.ts              # Router status command
│       │   ├── config/
│       │   │   └── ConfigManager.ts       # Router config manager
│       │   ├── feishu/
│       │   │   ├── FeishuClient.ts        # Feishu API client
│       │   │   └── FeishuLongConnHandler.ts  # Feishu long connection
│       │   ├── storage/
│       │   │   ├── JsonStore.ts           # Persistent JSON file storage
│       │   │   └── MemoryStore.ts         # In-memory storage with TTL
│       │   ├── types/
│       │   │   ├── index.ts               # Type definitions
│       │   │   └── config.ts              # Config types
│       │   └── utils/
│       │       └── PidManager.ts          # Process ID management
│       ├── bin/
│       │   └── remote-cli-router.js       # Router CLI executable
│       └── package.json
│
└── package.json                           # Monorepo root configuration
```

---

## Key File Checklist

### Local Client Core Files

1. **`packages/cli/src/client/WebSocketClient.ts`**
   - Establish WebSocket long connection with router server
   - Keep-alive heartbeat, auto-reconnect
   - Message send/receive

2. **`packages/cli/src/executor/ClaudeExecutor.ts`** (spawn mode)
   - Spawn new Claude CLI process per command
   - Uses `--print` mode with `--resume`
   - Fallback when running inside Claude Code

3. **`packages/cli/src/executor/ClaudePersistentExecutor.ts`** (persistent mode, default)
   - Maintain long-running Claude process with stream-json I/O
   - Bidirectional JSON streaming via stdin/stdout
   - Faster response times, no process spawn overhead

4. **`packages/cli/src/security/DirectoryGuard.ts`**
   - Path normalization and validation
   - Whitelist checking
   - Prevent path traversal attacks

5. **`packages/cli/src/commands/init.ts`**
   - Generate device ID and binding code
   - Guide user through binding process
   - Initialize configuration file

6. **`packages/cli/src/hooks/ClaudeCodeHooks.ts`**
   - Claude Code event hooks for monitoring execution
   - Integration with Feishu notification system

7. **`packages/cli/src/utils/FeishuMessageFormatter.ts`**
   - Format Claude output for Feishu rich text messages
   - Handle code blocks, markdown, and long message splitting

### Router Server Core Files

8. **`packages/router/src/feishu/FeishuLongConnHandler.ts`**
   - Receive messages from Feishu via long connection
   - Message parsing and routing to WebSocket clients
   - Streaming response handling with interactive cards

9. **`packages/router/src/websocket/ConnectionHub.ts`**
   - Manage all local client WebSocket connections
   - Message forwarding (open_id → device_id → WebSocket)
   - Connection health checking

10. **`packages/router/src/binding/BindingManager.ts`**
    - Binding code generation and verification
    - User binding relationship storage (JSON file)
    - Bind/unbind operations

11. **`packages/router/src/feishu/FeishuClient.ts`**
    - Feishu API wrapper (send messages, token management)
    - Message formatting (text, rich text cards)
    - Error retry

12. **`packages/router/src/storage/JsonStore.ts`**
    - Persistent JSON file storage for bindings
    - Debounced writes to minimize disk I/O
    - Auto-cleanup of expired data on startup

---

## Technical Dependencies

### Local Client (`packages/cli/package.json`)

```json
{
  "name": "@yu_robotics/remote-cli",
  "version": "1.0.0",
  "bin": {
    "remote-cli": "./bin/remote-cli.js"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.0",
    "ws": "^8.18.0",
    "commander": "^12.0.0",
    "conf": "^12.0.0",
    "chalk": "^5.3.0",
    "ora": "^8.0.1",
    "node-machine-id": "^1.1.12",
    "dotenv": "^16.4.1"
  }
}
```

### Router Server (`packages/router/package.json`)

```json
{
  "name": "@yu_robotics/remote-cli-router",
  "version": "1.0.0",
  "dependencies": {
    "koa": "^2.15.0",
    "@koa/router": "^12.0.1",
    "koa-bodyparser": "^4.4.1",
    "ws": "^8.18.0",
    "axios": "^1.6.7",
    "commander": "^12.0.0",
    "uuid": "^13.0.0",
    "dotenv": "^16.4.1"
  }
}
```

---

## Implementation Steps

### Phase 1: Router Server Foundation ✅

1. **Create Monorepo Structure** ✅
   - Initialize `packages/router` and `packages/cli`
   - Configure TypeScript and build tools

2. **Implement Feishu Long Connection Reception** ✅
   - `packages/router/src/feishu/FeishuLongConnHandler.ts`
   - Long connection to Feishu for real-time message receiving
   - Message parsing and routing to WebSocket clients

3. **Implement WebSocket Hub** ✅
   - `packages/router/src/websocket/ConnectionHub.ts`
   - Connection management, heartbeat detection

4. **Implement Binding Management** ✅
   - `packages/router/src/binding/BindingManager.ts`
   - JSON file storage, binding code generation

5. **Implement Feishu API Client** ✅
   - `packages/router/src/feishu/FeishuClient.ts`
   - Token management, message sending

### Phase 2: Local Client Core ✅

6. **Implement WebSocket Client** ✅
   - `packages/cli/src/client/WebSocketClient.ts`
   - Connection, reconnection, heartbeat

7. **Implement Configuration Management** ✅
   - `packages/cli/src/config/ConfigManager.ts`
   - Read/write `~/.remote-cli/config.json`

8. **Implement Directory Security Guard** ✅
   - `packages/cli/src/security/DirectoryGuard.ts`
   - Path validation, whitelist checking

9. **Implement Claude Executor** ✅
   - `packages/cli/src/executor/ClaudeExecutor.ts` (spawn mode)
   - `packages/cli/src/executor/ClaudePersistentExecutor.ts` (persistent mode)
   - Integrate Agent SDK, stream output

10. **Implement Message Handler** ✅
    - `packages/cli/src/client/MessageHandler.ts`
    - Command parsing, result return

### Phase 3: CLI Commands and Background Service (Partial)

11. **Implement CLI Commands** ✅
    - `init`, `start`, `stop`, `status`, `config`

12. **Implement Background Service Management** (not yet implemented)
    - `packages/cli/src/daemon/DaemonManager.ts`
    - PM2 integration, auto-start on boot

13. **Implement Binding Process** ✅
    - `packages/cli/src/commands/init.ts`
    - Interactive guidance

### Phase 4: Mobile Interaction Optimization ✅

14. **Implement Simplified Command Mapping** ✅
    - Slash commands handled via MessageHandler

15. **Implement Rich Text Formatting** ✅
    - `packages/cli/src/utils/FeishuMessageFormatter.ts`
    - Markdown rendering, code highlighting, long message splitting

16. **Implement Progress Indicators** ✅
    - `packages/cli/src/hooks/FeishuNotificationAdapter.ts`
    - Processing, completion, error messages

17. **Implement Multi-session (Threads)** ✅
    - Parallel chat threads support in CLI and Router

18. **Implement Remote Machine Management** ✅
    - SSH and Docker control via CLI

19. **Implement Gemini CLI Backend** ✅
    - Support for Gemini via ACP protocol

20. **Implement Redacted Thinking Handling** ✅
    - Support for safety-filtered reasoning blocks

### Phase 5: Testing and Documentation (In Progress)

21. **Integration Testing** ✅
    - Unit tests and integration tests for both packages

22. **Write Documentation** ✅
    - READMEs, PLAN.md, CLAUDE.md updated to reflect current state

23. **Deploy Router Server** (not yet completed)
    - Docker packaging not yet created

---

## Verification Plan

### Local Client Verification

```bash
# 1. Installation
npm install -g @yu_robotics/remote-cli

# 2. Initialization
remote-cli init
# Should generate binding code and wait for binding

# 3. Configure directory
remote-cli config add-dir ~/test-project

# 4. Start service
remote-cli start

# 5. Check status
remote-cli status
# Should display: Connected, Bound, Current working directory

# 6. View logs
remote-cli logs --follow
```

### End-to-End Verification

```
1. Send binding code in Feishu
   - Should receive "Binding successful" message

2. Send test command
   - "List files in current directory"
   - Should return file list

3. Test directory restrictions
   - "Read passwd file in /etc directory"
   - Should return "Directory not in whitelist" error

4. Test session continuation
   - Send "/c"
   - Should continue previous conversation

5. Test offline recovery
   - Stop remote-cli
   - Send message in Feishu
   - Should show "Device offline"
   - Start remote-cli
   - Resend message
   - Should work normally
```

---

## Deployment Recommendations

### Router Server Deployment

**Recommended Configuration**:
- Cloud Server: 2 cores 4GB (Lowest tier on Alibaba Cloud/Tencent Cloud is sufficient)
- Operating System: Ubuntu 22.04 LTS
- Domain: `router.company.com` (HTTPS required)
- Storage: Built-in JSON file storage (no external database required)

**Docker Compose Quick Deployment** (to be created):

```yaml
version: '3.8'
services:
  router:
    build: ./packages/router
    ports:
      - "3000:3000"
    environment:
      - FEISHU_APP_ID=${FEISHU_APP_ID}
      - FEISHU_APP_SECRET=${FEISHU_APP_SECRET}
      - FEISHU_ENCRYPT_KEY=${FEISHU_ENCRYPT_KEY}
    volumes:
      - router_data:/root/.remote-cli-router
    restart: unless-stopped

volumes:
  router_data:
```

### Feishu Bot Configuration

1. Log in to [Feishu Open Platform](https://open.feishu.cn/)
2. Create enterprise self-built app
3. Enable bot capability
4. Configure permissions:
   - `im:message`
   - `im:message.p2p_msg`
   - `im:message:send_as_bot`
5. Configure event subscription:
   - Webhook URL: `https://router.company.com/webhook/feishu`
   - Subscribe to event: `im.message.receive_v1`
6. Publish app to organization

---

## Future Optimization Directions

### Phase 2 Features
- [ ] Support file upload (send files to working directory through Feishu)
- [x] Support multi-device binding (same account binds multiple computers, switch via `/device` command)
- [ ] Command history (view recently executed commands in Feishu)
- [ ] Scheduled tasks (set scheduled Claude tasks)

### Security Hardening
- [ ] Two-factor authentication (require additional verification during binding)
- [ ] Audit logs (record all executed commands)
- [ ] Sensitive operation confirmation (dangerous operations require secondary confirmation in Feishu)

---

## Summary

Core advantages of this solution:

1. **Clear Architecture**: Lightweight router server + local client with clear responsibilities
2. **Secure and Reliable**: Three-layer protection: directory whitelist, command filtering, device binding
3. **User-Friendly**: One-click installation, auto-binding, mobile optimized
4. **Easy to Maintain**: TypeScript type safety, modular design, comprehensive logging
5. **Low Cost**: Router server uses minimal resources, team shares one server

Implementation priority: First complete core functionality (Phases 1-3) to ensure basic usability; then optimize mobile experience (Phase 4); finally improve testing and documentation (Phase 5).
