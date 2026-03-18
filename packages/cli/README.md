# @yu_robotics/remote-cli

Remote control your [Claude Code](https://claude.ai/code) CLI from anywhere using your mobile phone through Feishu (Lark) messaging.

## Features

- **Remote Control**: Control your local development environment from anywhere via mobile
- **Secure**: Directory whitelisting, command filtering, and device authentication
- **Mobile-Optimized**: Simplified commands and rich text formatting for Feishu
- **Multi-Backend Support**: Supports Claude Code and Gemini CLI
- **Multi-session (Threads)**: Create independent chat threads to parallelize tasks
- **Remote Machine Management**: Control remote servers or Docker via SSH
- **Persistent Process**: Long-running AI process with bidirectional streaming

## Prerequisites

- **Node.js** >= 18.0.0
- **Claude Code CLI** installed and configured
- Access to a Feishu (Lark) bot connected to a [remote-cli-router](https://www.npmjs.com/package/@yu_robotics/remote-cli-router) server

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
| `remote-cli config show` | View configuration |
| `remote-cli config add-dir <path>` | Add allowed directory |

## Feishu Bot Commands

### Core Management

| Command | Description |
|---------|-------------|
| `/help` | Show help information |
| `/status` | View status and all threads |
| `/abort` | Abort executing task in current thread |
| `/clear` | Clear context for this thread |
| `/compact` | Compress history to save tokens |
| `/cd <dir>` | Change working directory for this thread |
| `/backend` | List and switch AI backends |
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

All commands/skills supported by local Claude Code or Gemini CLI are passed through directly, for example:
- `/commit` - Commit code changes
- `/review` - Code review
- `/test` - Run tests
- And all other built-in AI engine commands

## Security

- **Directory whitelisting**: Only explicitly allowed directories are accessible
- **Command filtering**: Dangerous commands are automatically blocked
- **Device authentication**: Each device has a unique hardware-based ID
- **Binding codes**: Expire after 5 minutes

## Documentation

For full documentation including router server deployment, see the [project README](https://github.com/xiaoyu/remote-cli#readme).

## License

MIT
