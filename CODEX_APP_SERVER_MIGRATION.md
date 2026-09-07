# Codex App Server Migration Plan

## Goal

Replace the default Codex `exec` transport with `codex app-server` in one release while preserving the current remote-cli user experience. Keep the existing `exec` implementation as an explicit emergency fallback for at least one release. Claude Code and AGY behavior must remain unchanged.

## Compatibility Contract

| User feature | Required app-server behavior | Acceptance condition |
|---|---|---|
| Normal prompts | Start or resume one Codex thread per remote-cli thread, then start a turn | Context survives subsequent messages and service restarts |
| `/thread list` | Keep using `ThreadManager` summaries | Names, ordering, and idle/running/error states remain unchanged |
| `/thread new` | Create remote-cli metadata lazily; start Codex only on first use | The new thread inherits the caller's working directory and has independent context |
| Card thread switching | Keep router card and reply routing unchanged | Commands reach the selected remote-cli thread |
| Parallel threads | Use an isolated app-server process per active remote-cli thread | A busy or failed thread does not block another thread |
| `/thread delete` | Stop the executor and remove remote-cli session mapping | Busy/default-thread protections remain; no new destructive Codex history deletion |
| `/model` | Call `model/list` and show the current and available models | The list reflects the authenticated user's catalog |
| `/model <id>` | Validate and store the model under `thread.models.codex` | The choice is thread-local and survives restarts and backend switches |
| `/clear` | Detach from the current Codex thread and start fresh on next use | Model and working directory remain unchanged |
| `/compact` | Call `thread/compact/start` and wait for completion events | Success is reported only after native compaction completes |
| Automatic compact | Detect structured context-window errors | Retry at most once and only when no side effect may be duplicated |
| `/abort` | Call `turn/interrupt`; kill only as a timeout fallback | The turn ends and the same Codex thread remains resumable |
| `/cd` | Validate locally and pass the directory on every turn | Context and model remain unchanged |
| `/backend` | Destroy the process without deleting the session pointer | Switching away and back resumes the backend-specific conversation |
| Images | Convert incoming base64 images to temporary local files and send `localImage` inputs | Images are no longer silently discarded and temporary files are cleaned up |
| Streaming and tools | Map app-server item and delta events to existing callbacks | Text is not duplicated; tool cards reach a terminal state |
| Approvals | Resolve app-server server requests without hanging | Auto-approve preserves current behavior; interactive mode accepts mobile replies |
| Unknown slash commands | Preserve the current Codex rejection behavior | Slash commands are never accidentally sent as model prompts |

## Architecture

The first implementation keeps `ThreadExecutorPool` unchanged. Each lazily-created Codex executor owns one app-server child process and one Codex thread ID. This preserves per-thread failure isolation and parallelism without introducing shared runtime state into Claude or AGY paths.

New components:

- `CodexAppServerClient`: stdio JSON-RPC transport, initialization, request correlation, server-request handling, timeouts, and child-process lifecycle.
- `CodexAppServerExecutor`: `IExecutor` implementation for thread, turn, model, compaction, interruption, attachments, and event mapping.
- `CodexExecutor`: the current one-shot implementation, retained as an explicit fallback.
- `createExecutor`: selects `CodexAppServerExecutor` by default and `CodexExecutor` only when `transport: exec` is configured.

The CLI-router wire format remains unchanged. An optional `IExecutor.listModels()` method is additive and only used when a backend implements it.

## Session Migration

Continue reading and writing `~/.remote-cli/codex-sessions/<remoteThreadId>.json` with the existing `{ id, savedAt }` shape. Existing IDs are passed to `thread/resume`. Resume failures must not overwrite the stored ID or silently start a fresh conversation; the user receives a `/clear` recovery hint.

Before release, verify both directions against a supported Codex CLI version:

1. A thread created by `codex exec` resumes through app-server.
2. A thread created by app-server resumes through `codex exec resume`.

Session files should be written atomically. Normal service shutdown and backend switching must preserve them.

## Security and Approvals

- `autoApprove: true` maps to `approvalPolicy: never` and `dangerFullAccess`, matching the current bypass behavior.
- `autoApprove: false` leaves Codex policy defaults in control and responds to command/file approval requests through the existing waiting-input channel.
- Working directories remain subject to `DirectoryGuard`.
- Unsupported server requests are declined or failed explicitly; none may remain pending indefinitely.
- The migration does not broaden the router protocol or change Claude/AGY security behavior.

## Delivery Sequence

1. Add compatibility tests for current thread, model, clear, compact, abort, backend-switch, and shutdown behavior.
2. Implement and unit-test the app-server JSON-RPC client.
3. Implement thread start/resume, turn execution, streaming, tool mapping, and process recovery.
4. Implement model discovery and switching, native compaction, interruption, and images.
5. Implement approval and user-input handling.
6. Validate session interoperability with the retained exec transport.
7. Make app-server the default Codex transport and expose `executor.codex.transport: exec` for rollback.
8. Run all CLI/router tests, coverage, protocol snapshots, and builds.
9. Update both README files with equivalent structure and content.

## Release Gates

- Existing Codex conversations resume successfully through app-server.
- Every feature in the compatibility table has unit or integration coverage.
- Claude and AGY test suites have no regressions.
- CLI-router protocol snapshots remain unchanged.
- No active or queued command can remain unresolved after abort, timeout, crash, destroy, or malformed protocol input.
- Normal shutdown and backend switching preserve session data.
- The explicit exec fallback can resume an app-server-created thread.
- New and changed code meets the repository coverage requirement.
