# @yu_robotics/remote-cli

Remote control your [Claude Code](https://claude.ai/code) CLI from anywhere using your mobile phone through Feishu (Lark) messaging.

## Features

- **Remote Control**: Control your local development environment from anywhere via mobile
- **Secure**: Directory whitelisting, command filtering, and device authentication
- **Mobile-Optimized**: Simplified commands and rich text formatting for Feishu
- **Readable Code Changes**: Edit operations show collapsible, line-aware diff previews inside the existing progress card
- **Multi-Backend Support**: Supports Claude Code and Gemini CLI
- **Image Input and Output**: Forward standalone images and mixed text-image Feishu posts to Claude Persistent and Codex App Server backends, and forward Codex App Server generated images back through Router
- **Multi-session (Threads)**: Create independent chat threads to parallelize tasks
- **Remote Machine Management**: Control remote servers or Docker via SSH
- **Persistent Process**: Long-running AI process with bidirectional streaming
- **Non-Interactive Auto-Update**: Reconnect to a newer Router, wait for idle work, install its exact version, and exit for the process supervisor to restart

## Prerequisites

- **Node.js** >= 18.0.0
- **Claude Code CLI** installed and configured
- Access to a Feishu (Lark) bot connected to a [remote-cli-router](https://www.npmjs.com/package/@yu_robotics/remote-cli-router) server

The client is normally installed and run directly on the developer's machine rather than in Docker, so it can access local project directories and the installed AI CLI binaries. Docker is recommended for the shared Router server instead.

## Installation

```bash
npm install -g @yu_robotics/remote-cli
```

## Quick Start

### 1. Initialize

```bash
remote-cli init --server https://your-router-server.com
```

### 2. Bind Device in Feishu

Send the binding code to the Feishu bot:

```
/bind ABC-123-XYZ
```

### 3. Configure Allowed Directories

```bash
remote-cli config add-dir ~/projects ~/work
```

### 4. Start the Service

```bash
remote-cli start
```

### 5. Send Commands via Feishu

```
Help me fix TypeScript errors in ~/projects/my-app
```

## Commands

| Command | Description |
|---------|-------------|
| `remote-cli init -s <url>` | Initialize and generate binding code |
| `remote-cli start` | Start the background service |
| `remote-cli stop` | Stop the service |
| `remote-cli status` | Check service status |
| `remote-cli service install` | Install automatic startup for macOS or Linux |
| `remote-cli service start` | Start an installed user-level service |
| `remote-cli service stop` | Stop it without removing automatic startup |
| `remote-cli service uninstall` | Remove automatic startup |
| `remote-cli service status` | Check the user-level startup service |
| `remote-cli config show` | View configuration |
| `remote-cli config add-dir <path>` | Add allowed directory |

Linux users upgrading from version 1.6.23 or earlier should run `remote-cli service install` again to regenerate the systemd unit with corrected path escaping.

## Feishu Bot Commands

### Core Management

| Command | Description |
|---------|-------------|
| `/help` | Show help information |
| `/status` | Show backend, model, effort, queue, and thread status |
| `/context` | Show current session context and queue diagnostics |
| `/skills` | List available skills for the active backend |
| `/abort` | Abort executing task in current thread |
| `/queue` | Inspect or manage confirmed messages waiting in thread queues |
| `/clear` | Clear context for this thread |
| `/compact` | Compress history to save tokens |
| `/cd <dir>` | Change working directory for this thread |
| `/model [name]` | List models for the active backend or set this thread's model |
| `/effort [auto|low|medium|high]` | Show or set Codex/AGY reasoning effort |
| `/backend` | List backends and show the current thread's effective backend |
| `/backend <index>` | Switch all threads and clear per-thread backend overrides |
| `/backend <index> @` | Switch only the current thread |
| `/backend default @` | Clear the current thread override and follow the global backend |
| `/bind <码>` | Bind a new device |
| `/unbind` | Unbind all devices |
| `/device` | List and switch between bound devices |

### Threads & Machines

| Command | Description |
|---------|-------------|
| `/thread list/new/delete` | Manage session threads |
| `/machines` | List configured remote machines |
| `/machine add/remove/show` | Manage remote SSH machines |
| `/containers <ID>` | List Docker containers on a machine |
| `/search/view/replace` | Remote file operations |
| `/backups/restore` | Manage remote file backups |

### AI CLI Commands Passthrough

All commands/skills supported by local Claude Code or Gemini CLI are passed through directly where the backend protocol supports them. The built-in `/status`, `/context`, and `/skills` commands provide a consistent remote view across backends.
- `/commit` - Commit code changes
- `/review` - Code review
- `/test` - Run tests
- And all other built-in AI engine commands

## Advanced Usage

Use one thread per project or task so each thread keeps its own working directory, backend session, model, and queue. Use `/backend <index>` for a global switch, or `/backend <index> @` to override only the current thread. `/backend default @` removes that override.

When a thread is busy, ordinary messages require confirmation before they enter its queue. Use `/queue` to inspect pending work, `/queue clear` to discard queued messages, and `/abort` to stop the active task and clear that thread's queue. A message received during abort cleanup waits and starts after the backend is safe to reuse. Context-changing commands such as `/model`, `/effort`, `/cd`, `/compact`, and `/clear` are handled separately rather than queued as ordinary messages.

## Expert Usage

For a shared deployment, run the Router with Docker Compose on an internal server and run one CLI client on each developer machine. Keep project directories and Claude Code, AGY, or Codex credentials on the client machine; the Router persists its configuration and bindings in `./router-data`. On Linux, create that directory as the deployment user and set `ROUTER_UID` and `ROUTER_GID` in `.env` to `id -u` and `id -g` so the container can write to the bind mount.

To update a Router deployment without losing bindings:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 router
```

When diagnosing a task, check `/status`, then `/context`, then `/queue`. Use `/abort` only when you intend to discard the active task and queued messages.

## Security

- **Directory whitelisting**: Only explicitly allowed directories are accessible
- **Command filtering**: Dangerous commands are automatically blocked
- **Device authentication**: Each device has a unique hardware-based ID
- **Binding codes**: Expire after 5 minutes

## Documentation

For full documentation including router server deployment, see the [project README](https://github.com/xiaoyu/remote-cli#readme).

## License

MIT

## Changelog

See the project [CHANGELOG.md](../../CHANGELOG.md) for release notes and user-visible changes.
