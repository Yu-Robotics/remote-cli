# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No unreleased changes.

## [1.6.24] - 2026-09-14

### Fixed
- Fixed Linux systemd user units that quoted `WorkingDirectory` and output paths with shell-style syntax, causing systemd to reject otherwise valid absolute paths.
- Correctly quoted complete `Environment` assignments and escaped paths containing spaces or systemd specifier characters.

## [1.6.23] - 2026-09-14

### Fixed
- Fixed a race where a message sent while `/abort` was still closing a backend process could remain in the Processing state indefinitely.
- Serialized per-thread abort cleanup with subsequent messages and prevented an older command from clearing a newer command's busy state.

## [1.6.22] - 2026-09-14

### Added
- Added `remote-cli service start` and `remote-cli service stop` to control an installed user service without removing automatic startup.
- Added new-file previews for `Write` tool calls in Feishu progress cards.

### Fixed
- Made `remote-cli stop` stop an active systemd user service or macOS LaunchAgent instead of only updating local configuration.
- Fixed macOS service status reporting for loaded services that have exited.
- Improved edit previews for multiple separate changes and Markdown content containing code fences.
- Made the Docker Router run with configurable host UID/GID values to prevent bind-mount permission errors.

## [1.6.21] - 2026-09-14

### Improved
- Improved code-change rendering in Feishu cards with inline diff previews for edit operations.
- Diff output uses line-aware truncation and a larger display budget instead of the generic short command-output limit.
- Preserved the existing progress card layout while keeping code changes inside collapsible sections.

## [1.6.20] - 2026-09-13

### Added
- Added `remote-cli service install`, `service uninstall`, and `service status` for macOS LaunchAgents and Linux systemd user services.
- Service installation captures the current Node.js path, CLI entry point, HOME, PATH, and log paths so automatic startup uses the same user context.
- Automated service startup uses non-interactive version checks and restarts on failure.

## [1.6.19] - 2026-09-13

### Added
- Added Codex app-server generated image forwarding from the CLI to Router.
- Added Feishu Card 2.0 image rendering for generated images.
- Added regression coverage for Codex image events, Feishu uploads, and Router forwarding.

## [1.6.18] - 2026-09-13

### Fixed
- Updated the Docker health check to follow the configured `ROUTER_PORT` instead of always probing port `3000`.

## [1.6.17] - 2026-09-13

### Fixed
- Made the Docker Compose Router port configurable through `ROUTER_PORT`.
- Kept the host port and container port synchronized so changing the setup port no longer leaves Compose bound to port `3000`.

## [1.6.16] - 2026-09-13

### Changed
- Renamed the Router container data home from `/data` to `/router-data` to make the container path distinct from host data directories.
- Changed the host-side bind mount from `./data` to `./router-data` for a clearer deployment layout.
- Existing deployments should move their `data` directory to `router-data` before restarting.

## [1.6.15] - 2026-09-13

### Fixed
- Fixed Feishu image downloads by using the SDK resource `writeFile` API before forwarding images to supported backends.
- Added a Router regression test for the Feishu image resource download path.

## [1.6.14] - 2026-09-13

### Added
- Docker and Docker Compose deployment for the shared Router server.
- Interactive container setup that persists Feishu credentials and device bindings in `./data`.
- Docker health checks and documented container log management.

### Changed
- Recommended running the Router in Docker while keeping local clients on their host machines so they can access local project files and AI CLI binaries.

## [1.6.12] - 2026-09-12

### Added
- Queue confirmation cards now update after a queue request is processed.
- Repeated clicks on the same queue confirmation are detected and do not resend the command.

## [1.6.11] - 2026-09-10

### Fixed
- Replaced the unsupported Card 2.0 `action` container in queue confirmation cards with supported button layouts.
- Queue confirmation cards no longer remain stuck in the Processing state because of invalid card payloads.

## [1.6.10] - 2026-09-09

### Added
- Added `/status`, `/context`, and `/skills` commands across supported backends.
- Added queue diagnostics to status and context output.

## [1.6.9] - 2026-09-09

### Added
- Added per-thread backend overrides using `/backend <index> @`.
- Added `/backend default @` to return a thread to the global backend.
- Threads using different backends can execute concurrently.

## [1.6.8] - 2026-09-08

### Fixed
- Enabled the experimental Codex app-server APIs required for native model, reasoning effort, compaction, and interruption controls.

## [1.6.7] - 2026-09-08

### Added
- Added Codex reasoning effort controls and prioritized Codex in the backend list.
- Added AGY reasoning effort support.

### Fixed
- Coalesced streaming card updates and improved final thread-switch card refresh behavior.

## [1.6.1] - 2026-09-07

### Added
- Added the persistent Codex app-server backend with session resume and streaming support.
- Added backend-aware model selection and per-thread reasoning effort storage.

### Fixed
- Removed the global Claude Code security hook that caused repeated PreToolUse errors.

## [1.1.39] - 2026-03-20

### Added
- **Multi-session Threads**: True parallel multi-thread support with per-thread executors
- Feishu Card 2.0 integration for thread switching and creation
- **Gemini CLI Support**: Alternative AI backend via ACP (Agent Client Protocol)
- Gemini automatic quota fallback to Flash models
- **Remote Machine Management**: SSH and Docker control via chat commands
- **Redacted Thinking Handling**: Support for safety-filtered reasoning in Claude 3.7 Sonnet
- **Security Hooks**: Directory-based security via Claude Code native hooks

### Fixed
- Fixed Gemini session persistence after `/abort` commands
- Improved test isolation on macOS by mocking `os.homedir()`
- Fixed memory leaks in thread management
- Resolved race conditions in busy lock and session cleanup

## [1.1.0] - 2026-03-10

### Added
- Initial support for multiple devices per user account
- Switch between active devices via `/device` command
- Device ID collision protection in Router

## [1.0.3] - 2026-02-18

### Fixed
- Fixed failing tests by updating mocks
- Prevented process crash when working directory doesn't exist
- Validated working directory exists before spawning Claude process
- Fixed `/clear` command from stopping Claude process

## [1.0.2] - 2026-02-17

### Added
- Persistent Claude process with stream-json I/O for better performance
- Git worktree integration for session isolation
- Worktree slash commands (`/worktree list`, `/worktree cleanup`, `/main`)
- Auto-detection of nested Claude sessions

### Fixed
- Improved error handling for WebSocket connections
- Fixed session resumption logic

## [1.0.1] - 2026-02-16

### Added
- Feishu message formatting with rich text cards
- Progress indicators for long-running operations
- Directory whitelisting security feature
- Command filtering for dangerous operations

### Fixed
- WebSocket reconnection logic
- Configuration persistence issues

## [1.0.0] - 2026-02-15

### Added
- Initial release of Remote CLI
- Local client package (`@yu_robotics/remote-cli`)
- Router server package (`@yu_robotics/remote-cli-router`)
- WebSocket-based communication between client and router
- Device binding mechanism with Feishu
- Basic CLI commands: `init`, `start`, `stop`, `status`, `config`
- Security features: DirectoryGuard, command filtering
- Message handling with slash command support
- Claude Code integration via Agent SDK
- Comprehensive test suite (80%+ coverage)

[Unreleased]: https://github.com/xiaoyu/remote-cli/compare/v1.6.14...HEAD
[1.6.21]: https://github.com/xiaoyu/remote-cli/compare/v1.6.20...v1.6.21
[1.6.14]: https://github.com/xiaoyu/remote-cli/compare/v1.6.12...v1.6.14
[1.6.12]: https://github.com/xiaoyu/remote-cli/compare/v1.6.11...v1.6.12
[1.6.11]: https://github.com/xiaoyu/remote-cli/compare/v1.6.10...v1.6.11
[1.6.10]: https://github.com/xiaoyu/remote-cli/compare/v1.6.9...v1.6.10
[1.6.9]: https://github.com/xiaoyu/remote-cli/compare/v1.6.8...v1.6.9
[1.6.8]: https://github.com/xiaoyu/remote-cli/compare/v1.6.7...v1.6.8
[1.6.7]: https://github.com/xiaoyu/remote-cli/compare/v1.6.1...v1.6.7
[1.6.1]: https://github.com/xiaoyu/remote-cli/compare/v1.1.39...v1.6.1
[1.1.39]: https://github.com/xiaoyu/remote-cli/compare/v1.0.3...v1.1.39
[1.0.3]: https://github.com/xiaoyu/remote-cli/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/xiaoyu/remote-cli/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/xiaoyu/remote-cli/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/xiaoyu/remote-cli/releases/tag/v1.0.0
