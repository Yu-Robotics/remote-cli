# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Code Language Requirement

**CRITICAL: All code, comments, documentation, commit messages, variable names, and any text in this repository MUST be written in English only.**

- NO Chinese characters are allowed in any source files, comments, or documentation
- All JSDoc comments must be in English
- All error messages and user-facing strings must be in English
- Commit messages must be in English
- Variable names, function names, and identifiers must use English words
- Code review comments and PR descriptions must be in English

This is a **strictly enforced** rule - any pull request containing Chinese text will be rejected.

### Communication vs Code

- **During conversation**: You may communicate in any language (Chinese, English, etc.)
- **Code submissions**: All code, comments, documentation, and commit messages MUST be in English
- **Consistency**: Maintain the same language within a conversation context for better understanding

## README Synchronization Requirement

**CRITICAL: When modifying any README file, you MUST update ALL README files to maintain consistency.**

This project maintains two README files:
- `README.md` - Chinese documentation (default)
- `README_EN.md` - English documentation

**Rules:**
1. **Always modify both files** when updating documentation
2. **Keep section structure identical** - same order, same hierarchy
3. **Keep content equivalent** - English and Chinese should convey the same information
4. **Update links** - Ensure cross-references between READMEs are correct
5. **Verify both files** before committing

**Example:** If you add a new feature to Features section in README.md, you MUST also add it to README_EN.md in the same position.

## Version Bump Requirement

**CRITICAL: When bumping version numbers, you MUST update ALL package.json files to maintain consistency.**

This project maintains version numbers in three locations:
- `package.json` - Root package version
- `packages/cli/package.json` - CLI package (`@yu_robotics/remote-cli`)
- `packages/router/package.json` - Router package (`@yu_robotics/remote-cli-router`)

**Rules:**
1. **Always update all three package.json files** when bumping versions
2. **Keep versions synchronized** - all packages must use the same version number
3. **Commit together** - version bumps must be committed as a single commit
4. **Verify before pushing** - ensure all version numbers match

**Example:** When bumping from 1.1.0 to 1.1.1:
```bash
# Update all three package.json files
# package.json
# packages/cli/package.json
# packages/router/package.json

# Verify
npm run build

# Commit as single commit
git commit -m "chore: bump version to 1.1.1"
```

## Testing Requirement

**CRITICAL: All code changes MUST include corresponding test coverage.**

- **For new features**: Write unit tests, integration tests, and update E2E tests if needed
- **For bug fixes**: Add regression tests that verify the fix
- **For refactoring**: Ensure existing tests pass and add new tests for changed behavior
- **For new files**: Create corresponding test files in the `tests/` directory
- **Minimum coverage**: 80% code coverage (enforced by testing.md)

**Test file organization:**
- Unit tests: `packages/*/tests/*.test.ts` - Test individual components
- Command tests: `packages/*/tests/commands/*.test.ts` - Test CLI commands
- Integration tests: `packages/*/tests/integration/*.test.ts` - Test complete workflows

Every commit that modifies source code MUST include the corresponding test changes. Test files are an integral part of the project and must be committed together with the source code.

## Project Overview

This is a remote CLI tool that allows developers to control Claude Code CLI from their mobile phones via Feishu (飞书) messaging. The system enables developers to write code remotely when away from their computers, providing a mobile-friendly interface to Claude Code's capabilities.

**Core Architecture:**
- **Monorepo structure** with two main packages:
  - `packages/cli`: Local client that runs on the developer's machine
  - `packages/router`: Routing server that manages user binding and message forwarding via Feishu
- **Local client** connects to a router server via WebSocket and executes Claude Code commands
- **Security model**: Directory whitelisting + command filtering + device authentication

## Development Commands

### Building
```bash
# Build all packages
npm run build

# Build specific workspace
npm run build -w @yu_robotics/remote-cli        # CLI package
npm run build -w @yu_robotics/remote-cli-router # Router package
```

### Testing
```bash
# Run all tests
npm test

# Run tests for CLI package only
npm test -w @yu_robotics/remote-cli

# Run tests with coverage
npm run test:coverage -w @yu_robotics/remote-cli

# Run a single test file
npm test -- DirectoryGuard.test.ts

# Run tests for a specific command
npm test -- commands/init.test.ts

# Run integration tests
npm test -- integration/full-workflow.test.ts
```

### Development Mode
```bash
# Run CLI in dev mode (with file watching)
npm run cli:dev

# Run router in dev mode
npm run router:dev
```

## Architecture Decisions

### ConfigManager Pattern (CRITICAL for Tests)

The ConfigManager uses a **static factory pattern** that reads configuration from disk on initialization:

```typescript
// Each call creates a NEW instance reading from disk
const config1 = await ConfigManager.initialize();
config1.set('key', 'value');
await config1.save();

// This will see the NEW value because it reads from disk again
const config2 = await ConfigManager.initialize();
config2.get('key'); // Returns 'value'
```

**Why this matters for tests:**
- Commands like `startCommand()` and `stopCommand()` modify config and save it to disk
- Any `config` variable you hold in memory becomes **stale** after commands run
- You MUST call `ConfigManager.initialize()` again to see updated values
- Example: After `startCommand()`, reload config to verify `service.running` changed:
  ```typescript
  await startCommand();
  // OLD: const running = config.get('service.running'); // WRONG - stale!
  // NEW: Must reload
  const freshConfig = await ConfigManager.initialize();
  const running = freshConfig.get('service.running'); // Correct
  ```

### Test Isolation on macOS

The CLI uses `os.homedir()` to locate the config directory (`~/.remote-cli/`). On macOS, `os.homedir()` does NOT respect `process.env.HOME` changes. Tests must mock it:

```typescript
import os from 'os';
import { vi } from 'vitest';

// Mock os.homedir() to respect process.env.HOME for isolated tests
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || os.homedir());
```

Without this mock, tests will write to the real home directory and contaminate each other.

### Security Architecture

**DirectoryGuard** is the gatekeeper for all file system operations:
1. **Path normalization**: Converts `~`, relative paths, and absolute paths to canonical form
2. **Whitelist enforcement**: Only allows operations within directories specified in `config.security.allowedDirectories`
3. **Path traversal prevention**: Blocks `../../etc/passwd` style attacks

The security model has **three layers**:
1. **Directory whitelist**: `DirectoryGuard.isAllowed()` checks working directories
2. **Command filtering**: `CommandFilter` blocks dangerous bash commands (planned, not yet implemented)
3. **Device authentication**: Router server binds devices to specific users via Feishu binding flow

## Key Implementation Patterns

### Message Flow
```
User's Phone → Feishu → Router Server → WebSocket → Local CLI → Claude Code
                                                                      ↓
User's Phone ← Feishu ← Router Server ← WebSocket ← Local CLI ← Results
```

### Error Handling
- Commands return `{ success: boolean, message?: string, data?: any }`
- Always provide user-friendly error messages
- For validation errors, include what was expected vs what was provided

### Testing Strategy
The test suite follows TDD principles:
- **Unit tests**: Test individual components (`DirectoryGuard`, `ConfigManager`, `WebSocketClient`)
- **Command tests**: Test CLI commands in isolation with mocked dependencies
- **Integration tests**: Test complete workflows (init → start → stop)
- **Coverage requirement**: 80%+ per testing.md

Integration tests validate:
- Full user journey (init, start, status, stop)
- Config persistence across operations
- Error handling (network failures, missing configs)
- Binding flow simulation

## File Structure Conventions

### Source Code Organization
```
packages/cli/src/
  commands/      # CLI command implementations (init, start, stop, status, config)
  client/        # WebSocket client and message handling
  config/        # Configuration management
  executor/      # AI CLI integration (ClaudeExecutor, ClaudePersistentExecutor, GeminiExecutor, IExecutor, acp/)
  hooks/         # Claude Code hooks and Feishu notification adapter
  security/      # Directory guard (CommandFilter planned, not yet implemented)
  types/         # TypeScript type definitions
  utils/         # Utility functions (FeishuMessageFormatter, stripAnsi)

packages/router/src/
  binding/       # User-device binding management (BindingManager)
  commands/      # Router CLI commands (config, start, stop, status)
  config/        # Router configuration management
  feishu/        # Feishu API client and long connection handler (FeishuLongConnHandler)
  storage/       # Data persistence (JsonStore, MemoryStore)
  types/         # TypeScript type definitions
  utils/         # Utility functions (PidManager)
  websocket/     # WebSocket connection hub
```

### Test Organization
```
packages/cli/tests/
  *.test.ts              # Unit tests (named after source file)
  commands/              # Command-specific tests
  integration/           # Full workflow integration tests

packages/router/tests/
  *.test.ts              # Unit tests for router components
```

## Implementation Notes

### Router Server
The router server is fully implemented with:
- `websocket/ConnectionHub.ts`: Manage WebSocket connections from local clients
- `binding/BindingManager.ts`: Manage user-device bindings with JSON file storage
- `feishu/FeishuClient.ts`: Feishu API wrapper for sending messages
- `feishu/FeishuLongConnHandler.ts`: Feishu long connection handler (receives messages from Feishu and routes to clients)
- `storage/JsonStore.ts`: Persistent JSON file storage (replaces Redis)
- `storage/MemoryStore.ts`: In-memory storage with TTL support
- `utils/PidManager.ts`: Server process management

### WebSocket Protocol
The CLI and router use different message type systems:

**CLI side** (`packages/cli/src/types/index.ts`):
```typescript
// Incoming from router
interface IncomingMessage {
  type: 'command' | 'status' | 'ping';
  messageId: string;
  content?: string;
  workingDirectory?: string;
  openId?: string;
  timestamp: number;
  isSlashCommand?: boolean;
}

// Outgoing to router
interface OutgoingMessage {
  type: 'result' | 'progress' | 'status' | 'pong';
  messageId: string;
  success?: boolean;
  output?: string;
  error?: string;
  timestamp: number;
  openId?: string;
}
```

**Router side** (`packages/router/src/types/index.ts`):
```typescript
enum MessageType {
  COMMAND = 'command',
  RESPONSE = 'response',
  BINDING_REQUEST = 'binding_request',
  BINDING_CONFIRM = 'binding_confirm',
  HEARTBEAT = 'heartbeat',
  ERROR = 'error',
  NOTIFICATION = 'notification'
}

interface WSMessage {
  type: MessageType;
  messageId: string;
  timestamp: number;
  data: any;
}
```

### Redacted Thinking Handling

When AI models' internal reasoning is flagged by safety systems, some or all of the thinking
block is encrypted and returned as a `redacted_thinking` block. This applies to Claude 3.7 Sonnet
and Gemini models.

**Implementation**:
- `redacted_thinking` message type and content block type are fully supported in the CLI and Router
- Encrypted content is stored in output buffer for API continuity but NOT displayed to users
- Users see a friendly notification via Feishu Card 2.0: "💭 Some reasoning was filtered by safety systems"
- Session continuity is maintained - the AI can use the redacted reasoning in future turns
- The encrypted block must be preserved unmodified when passed back to the API

**Architecture**:
1. **CLI Side**: `ClaudePersistentExecutor` detects `redacted_thinking` type in stream
2. **Callback**: Triggers `onRedactedThinking()` callback (not `onStream` - encrypted content not shown)
3. **Storage**: Encrypted content stored in output buffer for session continuity
4. **Router Side**: Receives `streamType: 'redacted_thinking'` message
5. **Feishu Display**: `createRedactedThinkingElement()` renders user-friendly note card

**Testing**:
To test redacted thinking handling in development, use Anthropic's magic test string:
```
ANTHROPIC_MAGIC_STRING_TRIGGER_REDACTED_THINKING_46C9A13E193C177646C7398A98432ECCCE4C1253D5E2D82641AC0E52CC2876CB
```

**References**:
- Anthropic Extended Thinking documentation
- Claude 3.7 Sonnet safety features
- Gemini thinking modes

## Gemini CLI Support

The CLI supports Gemini CLI as an alternative AI backend via ACP (Agent Client Protocol).

### Setup

1. Install Gemini CLI and authenticate:
   ```bash
   npx @google/gemini-cli auth login
   ```

2. Configure remote-cli to use Gemini:
   ```bash
   remote-cli config set executor.type gemini
   remote-cli config set executor.gemini.model gemini-2.5-pro  # optional
   ```

3. Start the service as normal:
   ```bash
   remote-cli start
   ```

### Executor Config Fields (`executor` in config)

| Field | Values | Default | Description |
|-------|--------|---------|-------------|
| `executor.type` | `auto`, `claude-persistent`, `claude-spawn`, `gemini` | `auto` | Which AI CLI backend to use |
| `executor.gemini.model` | any Gemini model name | (Gemini default) | Gemini model to use |
| `executor.gemini.autoApprove` | `true`/`false` | `true` | Auto-approve tool permissions |
| `executor.gemini.command` | CLI command | `npx` | Override Gemini CLI command |
| `executor.gemini.version` | npm version spec | `@google/gemini-cli@latest` | Pin Gemini CLI version |

### Architecture (Gemini)

```
packages/cli/src/executor/
  IExecutor.ts              # Shared interface for all executor backends
  GeminiExecutor.ts         # ACP-based executor (implements IExecutor)
  acp/
    AcpClient.ts            # JSON-RPC 2.0 bidirectional transport over stdio
    AcpTypes.ts             # ACP wire format type definitions
    SessionManager.ts       # JSONL-based session history persistence
```

Session history is stored in `~/.remote-cli/gemini-sessions/{sessionId}.jsonl` and replayed
as context when creating new ACP sessions (since ACP `session/resume` is experimental).

Tool permissions are auto-approved by default (`allow_once`), equivalent to `--yolo`.

---

## Common Pitfalls

1. **Forgetting to reload ConfigManager**: Always call `initialize()` again after commands that modify config
2. **Not mocking os.homedir()**: Tests will fail on macOS without the homedir mock
3. **Path handling**: Always use DirectoryGuard for path validation - never trust user input directly
4. **WebSocketClient state**: The client maintains connection state - always check `isConnected` before sending

## Protocol Versioning

The CLI and Router communicate over WebSocket using a versioned protocol. Breaking changes to the wire format MUST be managed carefully because users run the CLI locally and may not upgrade immediately.

### Key constants

| Constant | Location | Purpose |
|---|---|---|
| `PROTOCOL_VERSION` | `packages/cli/src/types/index.ts` | Version this CLI speaks |
| `PROTOCOL_VERSION` | `packages/router/src/types/index.ts` | Current router version |
| `MIN_SUPPORTED_CLI_VERSION` | `packages/router/src/types/index.ts` | Oldest CLI version the router accepts |

### What requires a version bump

**Do NOT bump — these are safe (additive) changes:**
- Adding a new optional field to any message
- Adding a new message type that the other side can safely ignore
- Relaxing a field constraint (required → optional)

**MUST bump `PROTOCOL_VERSION` in both packages AND bump `MIN_SUPPORTED_CLI_VERSION` in router:**
- Removing or renaming any field
- Changing a field's type or semantics
- Removing a message type
- Changing the handshake sequence

### How to bump

1. Increment `PROTOCOL_VERSION` in `packages/cli/src/types/index.ts`
2. Increment `PROTOCOL_VERSION` in `packages/router/src/types/index.ts`
3. Set `MIN_SUPPORTED_CLI_VERSION` in `packages/router/src/types/index.ts` to the new version
4. Update the snapshot tests in `packages/*/tests/compatibility/protocol-compat.test.ts`
5. Announce to users: they must upgrade before the new router is deployed

### Change detector tests

`packages/router/tests/compatibility/protocol-compat.test.ts` and
`packages/cli/tests/compatibility/protocol-compat.test.ts` are **wire format snapshot tests**.
If changes to the code cause these tests to fail, stop and ask:
> "Is this a breaking wire format change? Do I need to bump the protocol version?"

## References

- See [PLAN.md](PLAN.md) for complete implementation plan with architecture diagrams, security design, and deployment strategies
- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk` version ^0.2.0
- Testing requirements: Minimum 80% coverage (unit + integration + E2E)
