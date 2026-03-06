# Gemini CLI Integration Plan

> **Status: PLANNING COMPLETE — Ready to implement**
> Last updated: 2026-03-06
> Context: This document is self-contained. A new session can read this and immediately start coding.

---

## Background & Research Summary

### What We Investigated

We explored whether the remote-cli project architecture could support both Claude Code and
Gemini CLI simultaneously, with the constraint of only making changes on the CLI side.

### ACP Protocol Discovery

Gemini CLI exposes a bidirectional **Agent Client Protocol (ACP)** via `--experimental-acp`.
ACP is JSON-RPC 2.0 over stdio (newline-delimited). This is **not** the same as stream-json.

Key difference:
- Claude: `--output-format=stream-json` → **one-way** NDJSON on stdout
- Gemini: `--experimental-acp` → **bidirectional** JSON-RPC 2.0 on stdin/stdout

### How vibe-kanban Does It (Reference Implementation)

We studied the open-source [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) project
(Rust) which wraps both Claude Code and Gemini CLI via a shared `AcpAgentHarness`.

Critical finding: **vibe-kanban does NOT implement the `fs/read_text_file` and `terminal/create`
ACP callbacks**. They return `method_not_found`, which causes Gemini CLI to fall back to
operating directly on the local filesystem — exactly like running it without ACP. This massively
simplifies the implementation: we only need to handle:
1. `session/update` notifications (streaming text, tool calls, plan mode)
2. `session/request_permission` (auto-approve for now)

Session continuity: ACP's `session/fork` and `session/resume` are experimental. vibe-kanban
instead persists conversation history as JSONL and replays it as context in new sessions.
We adopt the same approach.

### Current Architecture Analysis

```
packages/cli/src/
  executor/
    ClaudeExecutor.ts           # Spawn mode: one-shot `claude --print` per command
    ClaudePersistentExecutor.ts # Persistent mode: long-running process via stream-json (1471 lines)
    index.ts                    # Factory: createClaudeExecutor(), returns union type
  client/
    MessageHandler.ts           # Wires WebSocket messages to executor (679 lines)
  commands/
    start.ts                    # Entry point: creates executor + websocket client
  types/
    config.ts                   # Config interface (no executor type field currently)
    index.ts                    # Protocol types (IncomingMessage, OutgoingMessage, etc.)
```

**No formal `IExecutor` interface exists.** `MessageHandler.ts` uses the union type:
```typescript
constructor(private executor: ClaudeExecutor | ClaudePersistentExecutor, ...)
```
and runtime duck-typing for optional features:
```typescript
if ('compactWhenFull' in this.executor) { ... }
if ('isWaitingInput' in this.executor) { ... }
```

**Executor selection** is hardcoded in `start.ts`:
```typescript
const executor = createClaudeExecutor(directoryGuard, 'auto', lastWorkingDirectory);
// 'auto' = persistent mode unless running nested inside claude code
```

### Key Design Decision: What "Not Modifying Claude Code" Means

**Files we MUST NOT touch (preserve functional logic):**
- `executor/ClaudeExecutor.ts`
- `executor/ClaudePersistentExecutor.ts`
- `packages/router/**` (entire router)

**Files we MAY touch with type-only / additive changes:**
- `client/MessageHandler.ts` — **1 line**: change type annotation from union to `IExecutor`
  (zero logic change, just accepts a third type)
- `executor/index.ts` — add gemini branch to factory, keep existing function unchanged
- `commands/start.ts` — read executor type from config instead of hardcoding 'auto'
- `types/config.ts` — add optional `executor` config field

**Why no `implements IExecutor` needed on Claude executors:**
TypeScript uses structural typing. `ClaudePersistentExecutor` automatically satisfies `IExecutor`
without any modification to its file, as long as the interface is shaped to match.

---

## Implementation Plan

### Constraints

| Constraint | Reason |
|------------|--------|
| No changes to `ClaudeExecutor.ts` | Preserve existing behavior, avoid regression |
| No changes to `ClaudePersistentExecutor.ts` | Same; it's complex (1471 lines) |
| No changes to `packages/router/` | Router speaks WebSocket protocol only; AI backend is transparent |
| `MessageHandler.ts` — 1 line max | Type annotation only, zero logic change |

---

### New Files to Create (6 files)

```
packages/cli/src/
  executor/
    IExecutor.ts                     # Shared interface
    GeminiExecutor.ts                # ACP-based Gemini CLI executor
    acp/
      AcpClient.ts                   # JSON-RPC 2.0 bidirectional transport
      AcpTypes.ts                    # ACP wire format type definitions
      SessionManager.ts              # Session history persistence
packages/cli/tests/
  executor/
    GeminiExecutor.test.ts
    acp/
      AcpClient.test.ts
      SessionManager.test.ts
```

### Files to Modify (3 files, minimal)

```
packages/cli/src/
  types/config.ts          # Add optional executor config field
  executor/index.ts        # Add gemini branch, new createExecutor() export
  commands/start.ts        # Read executor type from config (2-line change)
packages/cli/src/client/
  MessageHandler.ts        # 1-line type annotation change only
```

---

## Phase 1: IExecutor Interface

**File:** `packages/cli/src/executor/IExecutor.ts`

```typescript
import { ToolUseInfo, ToolResultInfo } from '../types';

export interface ExecuteOptions {
  onStream?: (chunk: string) => void;
  onToolUse?: (toolUse: ToolUseInfo) => void;
  onToolResult?: (toolResult: ToolResultInfo) => void;
  onRedactedThinking?: () => void;
  onPlanMode?: (planContent: string) => void;
  timeout?: number;
}

export interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
  sessionAbbr?: string;
}

export interface IExecutor {
  // Required — all executors must implement
  execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult>;
  getCurrentWorkingDirectory(): string;
  setWorkingDirectory(targetPath: string): Promise<void>;
  resetContext(): void;
  abort(): Promise<boolean>;
  destroy(): Promise<void> | void;

  // Optional — MessageHandler already uses 'method' in executor checks for these
  isWaitingInput?(): boolean;
  sendInput?(input: string): boolean;
  compact?(onStream?: (chunk: string) => void): Promise<ExecuteResult>;
  compactWhenFull?(onStream?: (chunk: string) => void): Promise<ExecuteResult>;
  isProcessRunning?(): boolean;
  getSessionId?(): string | null;
}
```

**MessageHandler.ts change (1 line):**
```typescript
// Before:
constructor(private executor: ClaudeExecutor | ClaudePersistentExecutor, ...)
// After:
constructor(private executor: IExecutor, ...)
```

TypeScript verifies at compile time that `ClaudePersistentExecutor` and `ClaudeExecutor`
are structurally compatible with `IExecutor`. No changes to those files needed.

---

## Phase 2: ACP Protocol Layer

### Phase 2a: Type Definitions

**File:** `packages/cli/src/executor/acp/AcpTypes.ts`

Covers only the subset of ACP we need:

```typescript
// JSON-RPC 2.0 envelope types
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string; data?: unknown };
}
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ACP content block (subset)
export interface AcpContentBlock {
  type: 'text' | 'image' | 'resource_link' | 'resource';
  text?: string;
}

// session/update notification payload variants
export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; kind?: string; status?: string }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status: string; rawOutput?: string }
  | { sessionUpdate: 'plan'; content: AcpContentBlock[] }
  | { sessionUpdate: string; [key: string]: unknown };  // catch-all

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

// session/request_permission (agent -> client, expects response)
export interface AcpPermissionOption {
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}
export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string; title: string };
  options: AcpPermissionOption[];
}

// Method results
export interface AcpInitializeResult { protocolVersion: number }
export interface AcpNewSessionResult { sessionId: string }
export interface AcpPromptResult {
  sessionId: string;
  stopReason: 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal' | 'max_turn_requests';
}
```

### Phase 2b: ACP Client (bidirectional JSON-RPC transport)

**File:** `packages/cli/src/executor/acp/AcpClient.ts`

The core transport. Manages the child process and routes JSON-RPC messages.

```typescript
export interface AcpEventCallbacks {
  onTextChunk: (text: string) => void;
  onThoughtChunk?: (text: string) => void;
  onToolCall?: (toolCallId: string, title: string, kind?: string) => void;
  onToolResult?: (toolCallId: string, status: string, output?: string) => void;
  onPlan?: (text: string) => void;
  // Returns index of chosen option (0 = first option = typically allow_once)
  onPermissionRequest?: (title: string, options: AcpPermissionOption[]) => Promise<number>;
}

export class AcpClient {
  private child: ChildProcess;
  private pendingRequests = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private callbacks: AcpEventCallbacks;
  private rl: readline.Interface;

  constructor(
    geminiCommand: string,    // e.g. 'npx' or 'gemini'
    geminiArgs: string[],     // e.g. ['-y', '@google/gemini-cli', '--experimental-acp']
    cwd: string,
    callbacks: AcpEventCallbacks
  )

  // ACP lifecycle
  async initialize(): Promise<void>
  async newSession(cwd: string): Promise<string>           // returns sessionId
  async prompt(sessionId: string, text: string): Promise<AcpPromptResult>
  sendCancel(sessionId: string): void                      // notification, no response
  destroy(): void

  // Internal message routing
  private sendRequest(method: string, params: unknown): Promise<unknown>
  private sendNotification(method: string, params: unknown): void
  private handleLine(line: string): void
  private handleResponse(msg: JsonRpcResponse): void
  private handleNotification(msg: JsonRpcNotification): void
  private handleServerRequest(msg: JsonRpcRequest): void   // for request_permission
  private handleSessionUpdate(params: AcpSessionUpdateParams): void
  private async handlePermissionRequest(id: number, params: AcpRequestPermissionParams): Promise<void>
}
```

**Key implementation note — permission handling:**
When Gemini calls `session/request_permission`, `AcpClient` responds immediately with
`allow_once` (auto-approve) unless a custom `onPermissionRequest` callback is provided.
This is equivalent to running Gemini with `--yolo`.

**Why no npm package for ACP:**
The `agent-client-protocol` npm SDK is designed for full bidirectional use. We only need
to **send** a handful of methods and **receive** notifications. A manual JSON-RPC implementation
is ~150 lines and has zero external dependencies.

### Phase 2c: Session Manager

**File:** `packages/cli/src/executor/acp/SessionManager.ts`

Persists conversation history for multi-turn context. ACP `session/resume` is experimental,
so we use history replay (same approach as vibe-kanban).

Storage: `~/.remote-cli/gemini-sessions/{sessionId}.jsonl`
Each line: `{"role":"user"|"assistant","text":"...","ts":1234567890}`

```typescript
export class SessionManager {
  private baseDir: string;  // ~/.remote-cli/gemini-sessions/

  append(sessionId: string, role: 'user' | 'assistant', text: string): void
  buildResumeContext(sessionId: string): string  // formats history as context prefix
  clear(sessionId: string): void
  remove(sessionId: string): void
}
```

`buildResumeContext` produces:
```
=== PREVIOUS CONVERSATION ===
[User]: <previous prompt>
[Assistant]: <previous response>
...
=== NEW REQUEST ===
```
This is prepended to the new prompt when starting a fresh ACP session for continuity.

---

## Phase 3: GeminiExecutor

**File:** `packages/cli/src/executor/GeminiExecutor.ts`

Implements `IExecutor`. Uses `AcpClient` internally. One ACP process per working directory
(process is restarted on `setWorkingDirectory`).

```typescript
export interface GeminiExecutorOptions {
  model?: string;
  autoApprove?: boolean;         // default true
  initialWorkingDirectory?: string;
  geminiCommand?: string;        // default: 'npx'
  geminiVersion?: string;        // default: '@google/gemini-cli@latest'
}

export class GeminiExecutor implements IExecutor {
  private directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;
  private sessionManager: SessionManager;
  private currentSessionId: string | null = null;
  private acpClient: AcpClient | null = null;
  private isExecuting = false;
  private options: Required<GeminiExecutorOptions>;

  // IExecutor required
  async execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult>
  getCurrentWorkingDirectory(): string
  async setWorkingDirectory(targetPath: string): Promise<void>
  resetContext(): void
  async abort(): Promise<boolean>
  async destroy(): Promise<void>

  // Internal
  private async ensureClient(): Promise<{ client: AcpClient; sessionId: string }>
  private buildAcpCallbacks(options: ExecuteOptions): AcpEventCallbacks
  private buildGeminiArgs(): string[]
  private async startNewSession(): Promise<{ client: AcpClient; sessionId: string }>
}
```

**execute() flow:**
```
execute(prompt, options)
  1. ensureClient()
     ├── if no acpClient: spawn process, ACP handshake, new_session(cwd) -> sessionId
     └── return { client, sessionId }
  2. if sessionId had prior history: prepend sessionManager.buildResumeContext()
  3. sessionManager.append(sessionId, 'user', prompt)
  4. acpClient.prompt(sessionId, finalPrompt)
     ├── agent_message_chunk -> options.onStream(text)       [accumulate for output]
     ├── agent_thought_chunk -> (silently dropped)
     ├── tool_call           -> options.onToolUse({name, id, input})
     ├── tool_call_update (completed) -> options.onToolResult({tool_use_id, content, is_error})
     ├── plan                -> options.onPlanMode(text)
     └── request_permission  -> auto-approve (allow_once)
  5. sessionManager.append(sessionId, 'assistant', accumulatedOutput)
  6. return { success: true, output: accumulatedOutput }
```

**setWorkingDirectory:**
Terminates current ACP client (sends `session/cancel`, destroys child process),
clears `currentSessionId`. Next `execute()` call will create a fresh session in the new directory.

**resetContext:**
Clears `currentSessionId` and removes session history. Does NOT kill the process
(a new session is created on next execute in same directory).

**abort:**
Calls `acpClient.sendCancel(sessionId)` (notification, no response), then destroys
the client. Returns `true`.

---

## Phase 4: Wire into Factory and Config

### Config Change

**File:** `packages/cli/src/types/config.ts`

Add optional `executor` field:

```typescript
export interface GeminiExecutorConfig {
  model?: string;
  autoApprove?: boolean;   // default true; false = future Feishu approval flow
  command?: string;        // override CLI command (default: 'npx')
  version?: string;        // pin gemini-cli version (default: latest)
}

export interface ExecutorConfig {
  type: 'auto' | 'claude-persistent' | 'claude-spawn' | 'gemini';
  gemini?: GeminiExecutorConfig;
}

// In Config interface, add:
executor?: ExecutorConfig;
```

User configures via:
```bash
remote-cli config set executor.type gemini
remote-cli config set executor.gemini.model gemini-2.5-pro
```

### Factory Change

**File:** `packages/cli/src/executor/index.ts`

Add new `createExecutor` export alongside existing `createClaudeExecutor` (kept as-is):

```typescript
export function createExecutor(
  directoryGuard: DirectoryGuard,
  executorConfig: ExecutorConfig = { type: 'auto' },
  initialWorkingDirectory?: string
): IExecutor {
  switch (executorConfig.type) {
    case 'gemini':
      return new GeminiExecutor(directoryGuard, {
        model: executorConfig.gemini?.model,
        autoApprove: executorConfig.gemini?.autoApprove ?? true,
        initialWorkingDirectory,
      });
    case 'claude-persistent':
      return new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory);
    case 'claude-spawn':
      return new ClaudeExecutor(directoryGuard);
    case 'auto':
    default:
      return isRunningInsideClaudeCode()
        ? new ClaudeExecutor(directoryGuard)
        : new ClaudePersistentExecutor(directoryGuard, initialWorkingDirectory);
  }
}
```

### start.ts Change

**File:** `packages/cli/src/commands/start.ts` (~2 line change)

```typescript
// Before:
const executor = createClaudeExecutor(directoryGuard, 'auto', lastWorkingDirectory);

// After:
const executorConfig = config.get('executor') as ExecutorConfig ?? { type: 'auto' };
const executor = createExecutor(directoryGuard, executorConfig, lastWorkingDirectory);
```

### MessageHandler.ts Change (1 line)

**File:** `packages/cli/src/client/MessageHandler.ts`

```typescript
// Before (line ~25):
constructor(
  private wsClient: WebSocketClient,
  private executor: ClaudeExecutor | ClaudePersistentExecutor,
  ...
)

// After:
constructor(
  private wsClient: WebSocketClient,
  private executor: IExecutor,
  ...
)
```

Zero logic changes. All existing `'compactWhenFull' in this.executor` checks still work
because `IExecutor` declares these as optional methods.

---

## Phase 5: Tests

### Test Files

```
packages/cli/tests/
  executor/
    GeminiExecutor.test.ts       # Unit tests with mocked AcpClient
    acp/
      AcpClient.test.ts          # Unit tests with mock child process
      SessionManager.test.ts     # Persistence tests
  integration/
    gemini-workflow.test.ts      # End-to-end with mock ACP server script
```

### AcpClient Test Strategy

Test with a mock script (`tests/fixtures/mock-acp-server.mjs`) that speaks ACP:
- Verify JSON-RPC request/response correlation by `id`
- Verify `initialize` and `new_session` handshake
- Verify `session/update` stream → callbacks
- Verify `session/request_permission` → auto-approve response
- Verify cancel/destroy cleans up child process

### GeminiExecutor Test Strategy

Mock `AcpClient` constructor to inject a fake client:
- Test callback mapping: text chunks → `onStream`, tool calls → `onToolUse`
- Test `setWorkingDirectory` destroys old session and creates new one
- Test `resetContext` clears history without killing process
- Test `abort` calls cancel and destroys
- Test multi-turn continuity: second `execute` reuses same sessionId

### Coverage Target: 80%+

---

## Phase 6: Documentation

- Update `README.md` + `README_EN.md`: add Gemini CLI setup section
- Update `CLAUDE.md`: note `executor` config field
- Add Gemini auth requirement note (`gemini auth login` needed before first use)

---

## Implementation Order

| # | Phase | Files Created/Modified | Risk | Est. Complexity |
|---|-------|------------------------|------|-----------------|
| 1 | IExecutor interface | `executor/IExecutor.ts` (create) + `MessageHandler.ts` (1 line) | Low | XS |
| 2a | ACP type definitions | `executor/acp/AcpTypes.ts` (create) | Low | XS |
| 2b | ACP client | `executor/acp/AcpClient.ts` (create) | Medium | L |
| 2c | Session manager | `executor/acp/SessionManager.ts` (create) | Low | S |
| 3 | GeminiExecutor | `executor/GeminiExecutor.ts` (create) | Medium | M |
| 4 | Config + factory + start.ts | 3 files, minimal edits | Low | XS |
| 5 | Tests | 4 test files | Medium | M |
| 6 | Docs | README × 2, CLAUDE.md | Low | XS |

**Total new files: 7** (including test files)
**Files with minimal edits: 4** (`MessageHandler.ts` 1 line, `index.ts`, `start.ts`, `config.ts`)
**Unchanged: everything else**

---

## Feature Comparison

| Feature | ClaudePersistentExecutor | GeminiExecutor (v1) |
|---------|--------------------------|---------------------|
| Streaming text | ✅ | ✅ |
| Tool use events | ✅ | ✅ |
| Tool result events | ✅ | ✅ |
| Plan mode | ✅ stream-json specific | ✅ via ACP `plan` update |
| Redacted thinking | ✅ Claude-specific | ❌ N/A |
| Auto-compact | ✅ `/compact` command | ❌ ACP manages context internally |
| Session persistence | ✅ resume by session ID | ✅ history replay (JSONL) |
| Working dir change | ✅ process restart | ✅ new ACP session |
| Abort in-flight | ✅ SIGTERM | ✅ `session/cancel` notification |
| Interactive input | ✅ `sendInput()` | ❌ ACP handles this internally |
| Approval flow | N/A | ✅ auto-approve (v1); Feishu approval (future) |

---

## Open Questions (for future)

1. **Gemini auth detection:** Check `~/.gemini/oauth_creds.json` during `init` command
   and warn if missing. User must run `gemini auth login` first.

2. **Supervised approval:** When `autoApprove: false`, route `request_permission` to
   Feishu as an interactive button card. User approves from phone. Complex — defer to v2.

3. **ACP npm package:** The `agent-client-protocol` npm package exists but is designed
   for full bidirectional use. Our manual JSON-RPC (~150 lines) is simpler and dependency-free.
   Revisit if ACP protocol evolves significantly.

4. **Gemini CLI version pinning:** Test against a specific version. vibe-kanban uses
   `@google/gemini-cli@0.29.3`. Document minimum version requirement.

5. **`--experimental-acp` stability:** This flag is experimental and may change. Monitor
   Gemini CLI releases. The alternative is Gemini's `--output-format=stream-json` if it
   gains feature parity (currently unclear if it supports multi-turn sessions).
