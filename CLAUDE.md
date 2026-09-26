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
- `README.md` - English documentation (default)
- `README_ZH.md` - Chinese documentation

**Rules:**
1. **Always modify both files** when updating documentation
2. **Keep section structure identical** - same order, same hierarchy
3. **Keep content equivalent** - English and Chinese should convey the same information
4. **Update links** - Ensure cross-references between READMEs are correct
5. **Verify both files** before committing

**Example:** If you add a new feature to Features section in README.md, you MUST also add it to README_ZH.md in the same position.

**Customer-facing change rule:** Any change that affects user-visible behavior, commands, configuration, backend usage, help text, setup steps, or operational workflows MUST include a review of `README.md` and `README_ZH.md`. Update both files when the change requires documentation, even if the initial code change does not touch a README file. Keep the two files structurally aligned and verify them before committing.

## Version Bump Requirement

**CRITICAL: When bumping version numbers, you MUST update ALL package.json files to maintain consistency.**

**CRITICAL: After completing any source-code change that affects actual runtime behavior, you MUST proactively bump the project version before handing off the change. This does not apply to comment-only changes or test-only changes.**

Behavior changes include new commands, changed command semantics, backend behavior, protocol handling, user-visible output, configuration behavior, and operational workflows. The version bump must be included in the same change set and kept synchronized across all package manifests and the lockfile when applicable.

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
- **Minimum coverage**: 80% code coverage

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
- **Security model**: Working-directory selection controls + device authentication; backend processes retain OS user permissions; Codex supports opt-in native command sandboxing

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
npm test -w @yu_robotics/remote-cli -- DirectoryGuard.test.ts

# Run tests for a specific command
npm test -w @yu_robotics/remote-cli -- commands/init.test.ts

# Run integration tests
npm test -w @yu_robotics/remote-cli -- integration/full-workflow.test.ts
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

// Capture the original function before mocking to avoid recursive fallback.
const originalHomedir = os.homedir.bind(os);
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir());
```

Without this mock, tests will write to the real home directory and contaminate each other.

### Security Architecture

**DirectoryGuard** validates working-directory selections and explicitly guarded local image reads:
1. **Path normalization**: Resolves `~`, relative paths, and absolute paths
2. **Whitelist enforcement**: Checks selected paths against `config.security.allowedDirectories`
3. **Scope**: These checks do not intercept arbitrary file access or shell commands inside backend processes

The security model has **two application-level layers**:
1. **Directory whitelist**: `DirectoryGuard.isSafePath()` checks working directories
2. **Device authentication**: Router server binds devices to specific users via Feishu binding flow

remote-cli does not install a global Claude Code `PreToolUse` hook. DirectoryGuard controls which working directory a thread may select, but it is not a process sandbox; AI backend processes inherit the permissions of the operating-system user.

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
- **Coverage requirement**: 80%+ (unit + integration + E2E)

Integration tests validate:
- Full user journey (init, start, status, stop)
- Config persistence across operations
- Error handling (network failures, missing configs)

## CLAUDE.md and AGENTS.md Link Requirement

**CRITICAL: When creating a new `CLAUDE.md` at any directory level, you MUST also create an `AGENTS.md` symbolic link next to it that points to that `CLAUDE.md`.**

- The `AGENTS.md` link must live in the same directory as the new `CLAUDE.md`
- The link target should be the sibling `CLAUDE.md` file (for example: `AGENTS.md -> CLAUDE.md`)
- Do this for every new `CLAUDE.md`, including nested package or subdirectory files
- Binding flow simulation

## File Structure Conventions

### Source Code Organization
```
packages/cli/src/
  commands/      # CLI command implementations (init, start, stop, status, config)
  client/        # WebSocket client and message handling
  config/        # Configuration management
  executor/      # AI CLI integration (ClaudePersistentExecutor, AgyExecutor, CodexAppServerExecutor, PiExecutor, IExecutor)
  hooks/         # Claude Code hooks and Feishu notification adapter
  security/      # Directory guard and legacy Claude hook cleanup
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

Use the current [CLI types](packages/cli/src/types/index.ts), [Router types](packages/router/src/types/index.ts), [WebSocketClient](packages/cli/src/client/WebSocketClient.ts), and [Router dispatcher](packages/router/src/server.ts) as the protocol reference. The Router's generic `WSMessage` envelope does not describe every wire message: registration uses nested `data`, while commands, streaming output, and final responses carry their payload fields at the top level.

- Registration exchanges the protocol version and optional capabilities such as `queueStarted`, `taskRecovery`, and `approvalCards`.
- `threadId` associates commands and output with a remote-cli thread; a backend's session ID is a separate identifier.
- Streaming supports text, tools, images, filtered-thinking notices, and plan messages. Background tasks use separate `task_notification` cards.
- Queue-start and task-recovery messages establish fresh execution cards before subsequent output is routed to them. Recovery sends metadata and later output, not a replay of disconnected output.
- Follow the Protocol Versioning section below and both compatibility test files when changing the wire format.

### Redacted Thinking Handling

`ClaudePersistentExecutor` recognizes `redacted_thinking` messages and assistant content blocks. It invokes `onRedactedThinking()` instead of streaming encrypted content. The Router receives `streamType: 'redacted_thinking'` and renders a filtered-reasoning notice.

Claude Code owns API history and session persistence. The executor's output buffer is not an API transcript: assistant blocks add a truncated diagnostic marker rather than the original encrypted block. Do not use this buffer to reconstruct API history or claim that remote-cli replays encrypted reasoning itself.

The [historical investigation](REDACTED_THINKING_ANALYSIS.md) records the original analysis and proposed tests; its model-specific assumptions are not a current backend support matrix.

## AGY CLI (Antigravity) Support

The CLI supports AGY CLI (Google Antigravity's agentic CLI, binary `agy`) as an alternative AI backend via its Claude-Code-style **stream-json** protocol.

### Setup

AGY CLI is auto-detected if already installed on the local machine (`agy --version`). No installation is performed by remote-cli.

1. Install and authenticate AGY CLI (Google OAuth in browser):
   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   agy  # first launch walks through login
   ```

2. Switch backend via Feishu chat (no manual config needed):
   ```
   /backend
   /backend <index>
   /backend <index> @
   ```

   Use the index shown by `/backend`. The command without `@` switches all
   threads and clears per-thread overrides; adding `@` switches only the
   current thread. Use `/backend default @` to follow the global backend again.

3. The successful `/backend` response applies the switch to future commands immediately; no service restart is required. A global switch is rejected while any thread is running.

### Executor Config Fields (`executor` in config)

| Field | Values | Default | Description |
|-------|--------|---------|-------------|
| `executor.type` | `auto`, `claude-persistent`, `agy`, `codex`, `opencode`, `kimi`, `zcode`, `pi` | `auto` | Which AI CLI backend to use (managed via `/backend` command) |
| `executor.agy.model` | model slug from `agy models` (e.g. `gemini-3.8-flash-low`) | *(unset)* | Model to use. Must be a slug from `agy models`; invalid slugs are rejected by agy with a clear error. Unset = agy default. |
| `executor.agy.autoApprove` | `true`/`false` | `true` | Auto-approve tool permissions via `--dangerously-skip-permissions` |
| `executor.agy.command` | binary command | `agy` | Override agy binary |

### Architecture (AGY)

```
packages/cli/src/executor/
  IExecutor.ts              # Shared interface for all executor backends
  AgyExecutor.ts            # stream-json executor (implements IExecutor)
  compactHandoff.ts         # Shared summarize-then-reset compact (prompt + seed wrapper)
```

AgyExecutor uses a **persistent stream-json process** — a single long-lived agy subprocess (`--input-format=stream-json --output-format=stream-json`) that maintains its own context across turns. Wire format (verified against agy 1.1.9):

- **In** (stdin, one NDJSON line per turn): `{"event":"user","message":{"content":"..."}}` — text blocks only; image attachments are dropped with a warning.
- **Out** (stdout NDJSON): `init` (carries `conversation_id`), `step_update` (`agent_response` text deltas → `onStream`; `tool` steps with `tool_info` → `onToolUse`/`onToolResult`; `user_input`/`system_message`/`checkpoint` ignored), `result` (terminal; `status` SUCCESS/ERROR/INTERRUPTED/CANCELED → command completion).
- **Resume**: the `conversation_id` is persisted per thread (`~/.remote-cli/agy-sessions/<threadId>.json`) and passed via `--conversation <id>` when respawning (process crash, `setWorkingDirectory`, abort).
- **Per-thread data isolation**: agy stores all conversations under `$HOME/.gemini/antigravity-cli` — one global store shared by every thread, so a fresh agent could read other threads' transcripts when asked to recall past chats (cross-thread memory bleed). The executor therefore spawns agy with `HOME=~/.remote-cli/agy-homes/<threadId>`: auth/config files (`oauth_creds.json`, `settings.json`, ...) and program directories (`bin`, `builtin`, `cache`, `updater`) are symlinked from the real `~/.gemini`, while `brain/` and `conversations/` are per-thread. On first use the thread's existing conversation is migrated (copied) into its HOME so resume keeps working. If agy rewrites a symlinked credential file (token refresh), the fresher copy is synced back to the master and re-linked on the next spawn. Setup failure falls back to the shared HOME. `/thread delete` removes the thread HOME.
- **Abort**: the protocol has no cancel request (`control_request` is unsupported), so abort kills the process; the next command resumes the conversation.
- AGY tool names map to Claude-style names for the router's tool cards (`run_command`→Bash, `view_file`→Read, etc.); unknown tools pass through unchanged.
- `/model` is supported: `setModel()` stores the model and recycles the agy process (immediately when idle, deferred until the running command finishes when busy); the conversation id survives, so context is preserved. MessageHandler persists the choice per backend (`thread.models.agy`), and the factory gives the per-thread model precedence over `executor.agy.model`. Bare `/model` lists available models via `agy models` (verified live: prints `slug<TAB>Display Name` lines — note `agy -p "/model"` only lists one model, use `agy models` for the full list).

Known gaps vs Claude backend: no `task_notification`-style background task events (stream-json emits `init`/`step_update`/`result` only) and no native hook events. AGY relies on DirectoryGuard for working-directory selection and `--dangerously-skip-permissions` for tool approvals.

**Slash passthrough (AGY)**: `executeSlashCommand` is backend-aware. agy's stream-json protocol explicitly refuses CLI-answered slash commands (`status: ERROR`, "...answered by the CLI itself and is unavailable with --input-format stream-json; run it as its own --print /help invocation" — verified against agy 1.1.26), so whitelisted read-only commands (`/help` `/model` `/skills` `/usage` `/config` `/changelog` `/agents` `/permissions` `/hooks` `/credits` — see `MessageHandler.AGY_PASSTHROUGH_COMMANDS`) are forwarded as a one-shot `agy -p "<cmd>"`. These are all read-only: agy rejects arguments ("takes no arguments"), so `/model <slug>` cannot set a model this way (use the built-in `/model`, which goes through `setModel()`). `/compact` is explicitly refused — verified live that outside the TUI the model role-plays a compaction while history stays intact. Anything else is rejected with the supported list.

**Reasoning effort (AGY)**: agy 1.1.27 exposes native `--effort low|medium|high` session options. The built-in `/effort` command stores the override per backend in `thread.efforts.agy`; `auto` clears it so the next process omits `--effort`. Like `/model`, changing effort recycles the persistent process immediately when idle or after the active command completes, while `--conversation <id>` preserves context.

**Compact**: agy intercepts `/compact` only in its interactive TUI — over stream-json it reaches the model as plain text (verified live against agy 1.1.9: the model role-played a compaction and the transcript kept full history; internal auto-compaction still runs when the window fills). `compactWhenFull()` therefore does **summarize-then-reset** (see `executor/compactHandoff.ts`): ask the current conversation for a dense handoff summary → reset → wrap the summary into the next prompt (consumed once). Summary failure falls back to a plain reset with an honest warning. `/clear` (resetContext) discards any pending seed.

---

## Codex CLI (OpenAI) Support

The CLI supports OpenAI's Codex CLI (binary `codex`) as an alternative AI backend via the persistent **`codex app-server`** transport.

### Setup

Codex CLI is auto-detected if already installed on the local machine (`codex --version`). No installation is performed by remote-cli.

1. Install and authenticate:
   ```bash
   npm install -g @openai/codex
   codex login
   ```

2. Switch backend via Feishu chat (no manual config needed):
   ```
   /backend
   /backend <index>
   /backend <index> @
   ```

   Use the index shown by `/backend`. The command without `@` switches all
   threads and clears per-thread overrides; adding `@` switches only the
   current thread. Use `/backend default @` to follow the global backend again.

3. The successful `/backend` response applies the switch to future commands immediately; no service restart is required. A global switch is rejected while any thread is running.

### Executor Config Fields (`executor` in config)

| Field | Values | Default | Description |
|-------|--------|---------|-------------|
| `executor.type` | `auto`, `claude-persistent`, `agy`, `codex`, `opencode`, `kimi`, `zcode`, `pi` | `auto` | Which AI CLI backend to use (managed via `/backend` command) |
| `executor.codex.model` | model name (e.g. `gpt-5.2-codex`) | *(unset)* | Model passed as `-m`. Unset = codex default. |
| `executor.codex.autoApprove` | `true`/`false` | `true` | Use full access unless a restricted sandbox mode is configured; restricted modes relay approvals |
| `executor.codex.sandbox` | Optional sandbox configuration object | *(unset)* | Native mode, networking, development directories, and extra writable roots; see README |
| `executor.codex.command` | binary command | `codex` | Override codex binary |
| `executor.claude.sandbox` | Optional sandbox configuration object | *(unset)* | Native mode, networking, and extra writable roots for Claude Code; see README |
| `executor.claude.command` | binary command | `claude` | Override claude binary |

### Architecture (Codex)

```
packages/cli/src/executor/
  CodexAppServerExecutor.ts # persistent app-server executor (implements IExecutor)
```

CodexAppServerExecutor keeps one app-server process per active thread. It uses app-server requests for turns, model catalog lookup, reasoning effort updates, compaction, and turn interruption. The persisted Codex thread id is resumed after process recreation, working-directory changes, backend switches, and service restarts.

- `/model` stores the selection under `thread.models.codex`; bare `/model` queries the app-server model catalog. `/effort` stores the per-thread override under `thread.efforts.codex`; `auto` clears it and restores the selected model's default reasoning effort.
- Startup verifies that the installed Codex CLI exposes `codex app-server --help` and prints an upgrade command when it does not.
- Configurations from remote-cli 1.6.30 or earlier are migrated on load: `claude-spawn` becomes `claude-persistent`, and `executor.codex.transport` is removed.

Known gaps vs Claude backend: no native Claude hook events. The app-server path supports Codex image inputs.

Codex background command and sub-agent completion events also produce standalone task cards through `onTaskNotification`. This tracking is process-local and depends on the events exposed by the installed Codex version; see [Background Task Notifications](README.md#background-task-notifications) for the supported behavior.

**Slash passthrough (Codex)**: none — app-server has no interactive TUI slash-command protocol, so backend-specific slash commands are rejected. remote-cli's built-in commands (`/clear`, `/compact`, `/model`, `/effort`, ...) are handled locally.

**Compact**: `/compact` uses app-server thread compaction.

**Approval cards**: Codex and Claude Code emit optional `onApprovalRequest`/`onApprovalResolved` callbacks. `MessageHandler` negotiates `approvalCards` and forwards request IDs independently of task-output recovery; pending approvals are replayed on registration. Router `ApprovalCards` owns rendering and validates the original user, device, card, and request before returning an `approval_response`. Only a CLI `approval_resolved` acknowledgement marks the card approved; terminal events invalidate remaining requests. Old peers and failed card creation retain text input. Claude uses one-time approvals, with `yes` / `no` text fallback and request IDs to disambiguate concurrent approvals. Its pending requests capture the original resolution callback and expire with their task or process. Other backends do not emit these callbacks yet.

**Sandbox**: `/sandbox` works for Codex and Claude Code threads. `CodexSandbox.ts` resolves native thread/turn policies and persists per-thread overrides in `~/.remote-cli/codex-sandbox/`. Workspace-write permits broad reads and networking, with writes to the current workspace, dedicated temporary/download paths, common caches, and explicit directory grants. Restricted modes never automatically accept requests to widen permissions. Native permission requests support `remember` for persistent writable-directory grants. Conversation resets retain these settings; deleting a thread revokes them. See [Optional Codex sandbox](README.md#optional-codex-sandbox). The Claude Code variant lives in `executor/claude/ClaudeSandbox.ts` (overrides in `~/.remote-cli/claude-sandbox/`); it injects native sandbox settings and an embedded permission-prompt MCP server (`executor/claude/approvalMcpServer.ts`) at process spawn, so policy changes recycle the Claude process and restricted mode omits `--dangerously-skip-permissions`. Claude's OS sandbox covers Bash-family commands. In workspace-write mode, `filePolicyHook.ts` uses the local socket to request a `ClaudeFilePolicy.ts` path decision before native permission evaluation; ordinary files inside the workspace or explicit writable roots are allowed, while outside writes and protected paths ask. Native deny/ask rules retain precedence. A SessionStart handshake verifies the process-scoped hook before any task is sent; disabled hooks fail startup. Read-only mode retains blanket file approvals. No global or project hook files are installed. Sandboxed command networking is enabled by default with a native domain wildcard; explicit native denials and managed domain restrictions still apply. `/sandbox network off` injects a deny-all rule, and stored network-off overrides survive later `/sandbox on` calls. Network policy changes retain filesystem isolation and approval for unsandboxed commands. See [Optional Claude Code sandbox](README.md#optional-claude-code-sandbox).

---

## OpenCode CLI Support

The CLI supports OpenCode through a persistent `opencode acp` child process. `AcpClient` implements the ACP JSON-RPC transport without an extra runtime dependency. `OpenCodeExecutor` configures the shared `AcpExecutor`, which owns session persistence and maps session updates onto `IExecutor` callbacks.

- Session pointers are stored per thread under `~/.remote-cli/opencode-sessions/` and loaded after process recreation or backend switches.
- `/model` and `/effort` read and update ACP session configuration options.
- `/compact` is sent through the ACP prompt protocol, `/abort` sends `session/cancel`, and image inputs use ACP image content blocks.
- Tool permission requests choose an allow option when `executor.opencode.autoApprove` is true and are relayed through the mobile input flow when it is false. Ask-user choices are always relayed and accept an option name or number.
- OpenCode-specific slash commands, including `/skills`, are sent through ACP.

Architecture:

```
packages/cli/src/executor/
  OpenCodeExecutor.ts       # OpenCode-specific ACP configuration
  AcpExecutor.ts            # Shared execution and session persistence
  acp/AcpClient.ts          # ACP process and JSON-RPC transport
  acp/AcpTypes.ts           # ACP transport types
```

## Kimi Code CLI Support

The CLI supports Kimi Code through its official persistent `kimi acp` server. `KimiExecutor` configures the shared ACP execution path for Kimi-specific session storage and the `thinking` configuration option.

- Install with `npm install --global @moonshot-ai/kimi-code` and authenticate with `kimi login`.
- Session pointers are stored per thread under `~/.remote-cli/kimi-sessions/`.
- `/model` uses the ACP model option; `/effort` maps to Kimi's `thinking` option, where `auto` sends `on` so Kimi chooses the model's default effort.
- Image inputs, slash commands, tool events, permission requests, ask-user choices, and cancellation use ACP.

Architecture:

```
packages/cli/src/executor/
  KimiExecutor.ts           # Kimi-specific ACP configuration
  AcpExecutor.ts            # Shared persistent executor implementation
  acp/AcpClient.ts          # ACP process and JSON-RPC transport
```

## ZCode Support

The official ZCode backend uses `zcode app-server --stdio`, including the bundled `zcode.cjs` entry point when discovered. It does not use an ACP bridge. `ZCodeExecutor` reuses `AcpExecutor` through the `zcode/ZCodeClient.ts` transport adapter, with launch discovery in `zcode/ZCodeCommand.ts`.

Session pointers live under `~/.remote-cli/zcode-sessions/`. Model and effort controls, compaction, cancellation, images, permission prompts, and model questions use the ZCode transport. `/skills` maps to ZCode's native `/skill`. See [Using ZCode](README.md#using-zcode) for installation and authentication constraints.

## Pi Agent Support

The CLI supports Pi (`@earendil-works/pi-coding-agent`, binary `pi`) through its persistent `--mode rpc` JSONL transport.

- Pi currently requires Node.js 22.19.0 or newer. Install with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` and authenticate with interactive `pi`.
- Session pointers are stored per thread under `~/.remote-cli/pi-sessions/`; RPC session files live in `~/.remote-cli/pi-sessions/store/` so Feishu threads do not reuse interactive `~/.pi` sessions.
- `/model` uses RPC `get_available_models` / `set_model` (`provider/id`). `/effort` maps to Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); `auto` clears the override.
- `/compact` uses RPC `compact`, `/abort` sends `abort`, and image inputs use Pi image content blocks.
- `/skills` lists Pi skills via `get_commands`. Extension commands, prompt templates, and `/skill:name` skills advertised by that RPC call are sent as RPC prompts; TUI-only built-ins are rejected.
- `executor.pi.autoApprove` controls Pi's official project trust flags: true passes `--approve`, while false passes `--no-approve`. Extension UI dialogs are always relayed through the mobile input flow because their meaning is extension-defined.
- Changing the working directory starts a fresh Pi session because the session header owns its original working directory.

Architecture:

```
packages/cli/src/executor/
  PiExecutor.ts             # IExecutor implementation and session persistence
  pi/PiClient.ts            # pi --mode rpc JSONL transport
  pi/PiTypes.ts             # RPC helpers and launch args
```

## Backend Switching and Session Persistence

Each backend keeps its own per-thread session pointer (claude session file, `~/.remote-cli/agy-sessions/<threadId>.json`, `~/.remote-cli/codex-sessions/<threadId>.json`, `~/.remote-cli/opencode-sessions/<threadId>.json`, `~/.remote-cli/kimi-sessions/<threadId>.json`, `~/.remote-cli/zcode-sessions/<threadId>.json`, `~/.remote-cli/pi-sessions/<threadId>.json`). `ThreadExecutorPool.destroyThread(threadId, { deleteData })` controls whether that pointer is wiped:

- `/thread delete` → `deleteData: true` (default) — session data deleted.
- `/backend` switch (`switchBackend` → `destroyAll({ deleteData: false })`) — executor processes are torn down but session files are PRESERVED, so switching back to a backend resumes each thread's previous conversation on it.

Resume-failure behavior with a stale id (verified live): agy warns `conversation "<id>" not found` and transparently starts a fresh conversation; codex exits with `no rollout found for thread id` (user recovers with `/clear`).

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
