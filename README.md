# Remote CLI - Control Claude Code / AGY CLI / Codex CLI / OpenCode CLI / Kimi Code CLI / ZCode / Pi from Mobile via Feishu

[![npm version](https://img.shields.io/npm/v/@yu_robotics/remote-cli.svg)](https://www.npmjs.com/package/@yu_robotics/remote-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

Remote control your Claude Code, AGY CLI (Antigravity), Codex CLI (OpenAI), OpenCode CLI, Kimi Code CLI, ZCode, or Pi from anywhere using your mobile phone through Feishu (Lark) messaging. Continue coding when away from your computer with a mobile-friendly interface.

[中文文档](README_ZH.md)

## Features

- 🌍 **Remote Control**: Control your local development environment from anywhere via mobile phone
- 🔒 **Controlled Access**: Working-directory selection controls and device authentication
- 📱 **Mobile-Optimized**: Simplified commands and rich text formatting for Feishu
- 📝 **Readable Code Changes**: Edit operations show collapsible, line-aware diff previews inside the existing progress card
- 🤖 **Multi-backend Support**: Supports Claude Code (default), AGY CLI (Antigravity), Codex CLI (OpenAI), OpenCode CLI, Kimi Code CLI, ZCode, and Pi, switchable at any time
- 🧵 **Multi-session Management**: Create multiple independent chat threads to handle different tasks in parallel. Support switching and creating threads via Feishu card buttons.
- 🖥️ **Remote Machine Management**: Control remote servers or Docker containers via SSH directly through Feishu. Support `/search`, `/view`, `/replace` and other remote file operations.
- ⚡ **Persistent Process**: Long-running AI process with bidirectional streaming via stdio for faster response times
- 📂 **Working Directory Controls**: Threads can select only explicitly allowed local working directories
- 🚀 **Easy Setup**: One-command installation and initialization, supports background daemon mode (`-d`)

### Usage Examples

<table>
  <tr>
    <td><img src="example_0.jpg" alt="Usage Example 1" height="400" /></td>
    <td><img src="example_1.jpg" alt="Usage Example 2" height="400" /></td>
  </tr>
</table>

## Recommended Use Cases

### 🦞 Scenario 1: Remotely Fixing a Broken openclaw Config (Real World Example)

**Target Users**: [openclaw](https://github.com/openclaw/openclaw) users and heavy users of any self-modifying CLI tool

**Background**: [openclaw](https://github.com/openclaw/openclaw) is a self-hosted personal AI assistant that can sometimes corrupt its own config files during execution, causing it to fail to start. Previously, you'd have to sit down at your computer to diagnose and fix it manually. Now you just open Feishu from wherever you are:

```
You:  /cd ~/projects/.openclaw
      The config is broken again, please fix it

Bot:  📂 Switched to ~/projects/.openclaw
      🔍 Checking config files...
      🔧 Reading config.json...
      ✅ Found the issue: `apiEndpoints` field was written with an
         illegal null value
      📝 Restoring defaults and fixing the format...
      🧪 Validating config...passed
      ✅ Config fixed — openclaw can start normally now
```

You only need to send one message from your phone. Claude Code, AGY CLI, Codex CLI, OpenCode CLI, Kimi Code CLI, ZCode, or Pi handles the investigation, fix, and validation autonomously on your computer.

**This pattern applies broadly**:
- Emergency recovery when any CLI tool corrupts its own config
- Remote diagnosis of service crashes, config conflicts, or missing environment variables
- No IDE needed — one Feishu message and the AI handles it for you

### Scenario 2: Enterprise Teams (Intranet Deployment)

**Target Users**: Development teams with a unified Feishu organization

**Deployment**:
- Deploy a router server on the company intranet
- Team members install the CLI client on their local machines
- Provide unified service through the Feishu bot

**Advantages**:
- 🔒 **Secure**: Only Feishu external communication is needed; the router server and clients are within the internal network
- 🏢 **Centralized Management**: One Feishu bot serves the entire organization, with administrators managing centrally
- 💰 **Cost-Effective**: A single low-configuration server can support the whole team
- 🔐 **Device Isolation**: Each member can only control their own computer, with no access to others' devices

### Scenario 3: Individual Developers (Home Intranet)

**Target Users**: Independent developers, freelancers

**Deployment**:
- Deploy the router server on your home intranet (e.g., NAS, Raspberry Pi, or spare computer)
- Run the CLI client on your local development machine
- Provide service externally through Feishu

**Advantages**:
- 🏠 **Zero Public Exposure**: The router server doesn't need a public IP; it communicates via Feishu long connection
- 📱 **Access Anywhere**: Control your home computer from your phone via Feishu when you're out
- 💡 **Development Convenience**: Continue programming, check logs, and fix issues when temporarily away from your computer
- 🆓 **Completely Free**: No need to purchase cloud servers; utilize existing equipment

## Architecture

```
┌─────────────────┐         ┌──────────────────────────────┐
│  Feishu Server  │         │  Developer A's Work PC       │
│                 │         │  (Mac/Linux)                 │
│  Developer A's  │◀───────▶│  ┌─────────────────────────┐ │
│  Phone          │         │  │  remote-cli (local)     │ │
│  Private Chat   │         │  │  - WebSocket Client     │ │
│  with Bot       │         │  │  - AI CLI Executor      │ │
└─────────────────┘         │  │    (Claude/AGY/Codex/OpenCode/Kimi/ZCode/Pi)   │ │
        │                   │  │  - Security Directory   │ │
        │                   │  │    Guard                │ │
        │                   │  └──────────┬──────────────┘ │
        │                   │             ▼                 │
        │                   │  Claude Code / AGY / Codex / OpenCode / Kimi / ZCode / Pi  │
        ▼                   │  (Local AI Backend)           │
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

## Quick Start

```bash
# Install the CLI
npm install -g @yu_robotics/remote-cli

# Initialize and get binding code
remote-cli init --server https://your-router-server.com

# Add allowed directories
remote-cli config add-dir ~/projects

# Start the service
remote-cli start

# Install automatic startup for macOS or Linux
remote-cli service install

# Now send the binding code to your Feishu bot
# And start coding from your phone!
```

## Prerequisites

Before you begin, ensure you have:

- **Node.js** >= 18.0.0
- **npm** or **yarn** package manager
- **Claude Code CLI**, **AGY CLI** (Antigravity), **Codex CLI** (OpenAI), **OpenCode CLI**, **Kimi Code CLI**, **ZCode**, or **Pi** — at least one installed and configured
- Access to a **Feishu (Lark) bot** (your team should deploy a router server)

### Automatic Client Startup

After initialization, install a user-level startup service on macOS or Linux:

```bash
remote-cli service install
remote-cli service stop
remote-cli service start
remote-cli service status
remote-cli service uninstall
```

The installer captures the current Node.js executable, CLI entry point, `HOME`, `PATH`, and log paths. macOS uses a `LaunchAgent`; Linux uses a `systemd --user` service. `remote-cli stop` also stops an active managed service, while `remote-cli service stop` and `remote-cli service start` pause and resume it without removing automatic startup. The service runs as the current user, not root, so backend credentials and project access remain consistent with manual startup. On Linux, it starts after user login by default. To start it before login after reboot, enable user lingering explicitly with `loginctl enable-linger "$USER"`.

Non-interactive clients automatically catch up when they reconnect to a newer Router version. The client waits until all threads and confirmed queues are idle, installs the exact Router version from npm, and exits so its process supervisor can restart it. New commands received during the short installation window are rejected with a retry message. Interactive starts never auto-update. `--non-interactive` is intended for clients managed by systemd or a macOS LaunchAgent; manually using that flag also enables automatic update behavior. If npm installation or version verification fails, the existing process keeps running and retries later.

After upgrading from version 1.6.23 or earlier on Linux, run `remote-cli service install` again to regenerate the systemd unit with corrected path escaping.

## Router Server Deployment

> **Note**: Most users don't need to deploy the router server. Your team administrator should deploy one router server for the entire team to share.

The router server forwards messages between Feishu and local CLI clients.

### Prerequisites

- A server with at least **1 CPU core** and **1GB RAM**
- **Node.js** >= 18.0.0
- **Domain name** and SSL certificate (for public deployment with HTTPS)
- A **Feishu bot** created and configured

### Install Router Server

```bash
# Install from npm (recommended)
npm install -g @yu_robotics/remote-cli-router

# Or install from source
git clone <repository-url>
cd remote-cli
npm install
npm run build -w @yu_robotics/remote-cli-router
cd packages/router
npm link
```

### Configure Router Server

```bash
remote-cli-router config
```

You will be prompted for:
- **Feishu App ID** (required)
- **Feishu App Secret** (required)
- Feishu Encrypt Key (optional)
- Feishu Verification Token (optional)
- Server Port (default: 3000)

### Setup Feishu Bot

1. Go to [Feishu Open Platform](https://open.feishu.cn/)
2. Create a new app
3. Enable **Bot** capabilities
4. Configure permissions:
   | Permission | Description | API Scope |
   |------------|-------------|-----------|
   | 获取与发送单聊、群组消息 | Get and send single/group messages | `im:message` |
   | 读取用户发给机器人的单聊消息 | Read user's private messages to bot | `im:message.p2p_msg:readonly` |
   | 以应用的身份发消息 | Send messages as bot | `im:message:send_as_bot` |
5. Enable **Long Connection** in Event & Callback section
6. Subscribe to event: `im.message.receive_v1` ([Receive Message v2.0](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive))
7. Enable message card callback: `card.action.trigger` (for interactive card buttons)
8. Get credentials (App ID, App Secret) and publish the app

### Start Router Server

```bash
# Start the service
remote-cli-router start

# Or use PM2 for production
pm2 start remote-cli-router --name router -- start
```

### Docker Compose Deployment (Recommended for Shared Routers)

Docker is recommended for the shared Router server because it keeps Node.js and Router dependencies isolated. The local client should not normally run in Docker: it needs direct access to local project files and the installed Claude Code, AGY, Codex, OpenCode, Kimi Code CLI, ZCode, or Pi binaries.

```bash
# From the repository root
docker compose build

# Optional: choose a host/container port before setup
cp .env.example .env
# Edit ROUTER_PORT if 3000 is already in use. On Linux, also set
# ROUTER_UID=$(id -u) and ROUTER_GID=$(id -g) in .env.

# Create the bind-mounted directory as the current user
mkdir -p router-data

# Configure Feishu credentials interactively and persist them in ./router-data
docker compose run --rm router config setup

# Start the Router in the background
docker compose up -d
```

The setup wizard stores configuration and bindings in `./router-data`, so they survive container recreation. Compose runs the container with `ROUTER_UID` and `ROUTER_GID`; these values must match the owner of `./router-data` to avoid bind-mount permission errors. `ROUTER_PORT` controls both the host port and the Router's container port, and must match the port entered during setup. Router logs are available with `docker compose logs -f router`; stop it with `docker compose down`. Open the configured port only to the trusted internal network, or place the Router behind an HTTPS reverse proxy for public access.

### Nginx Configuration (Production)

If using a domain with HTTPS, configure Nginx as a reverse proxy:

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/ssl/cert.pem;
    ssl_certificate_key /path/to/ssl/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

### Client Server Address Guide

When initializing the client, you need to specify the router server address. The address format depends on your deployment method:

| Deployment | Server Address Example | Description |
|-----------|----------------------|-------------|
| **Local/Intranet** | `http://127.0.0.1:3000` | Router and client on same machine |
| **LAN** | `http://192.168.1.100:3000` | Use internal IP + port |
| **Public** | `https://your-domain.com` | Use domain with HTTPS |

**Initialization examples:**

```bash
# Local deployment
remote-cli init --server http://127.0.0.1:3000

# LAN deployment
remote-cli init --server http://192.168.1.100:3000

# Public deployment
remote-cli init --server https://your-domain.com
```

## Installation

### From npm (Recommended)

```bash
npm install -g @yu_robotics/remote-cli
```

Or using yarn:

```bash
yarn global add @yu_robotics/remote-cli
```

### From Source

```bash
# Clone the repository (replace with actual repository URL)
git clone <repository-url>
cd remote-cli

# Install dependencies
npm install

# Build all packages
npm run build

# Link the CLI globally
cd packages/cli
npm link
```

## Usage

### 1. Initialize

Generate a unique device ID and binding code:

```bash
remote-cli init --server https://your-router-server.com
```

Example output:
```
✔ Initializing remote CLI...
✔ Device ID: dev_darwin_a1b2c3d4e5f6
✔ Binding code: ABC-123-XYZ

Please bind your device in Feishu:
1. Open Feishu and find the bot
2. Send: /bind ABC-123-XYZ
3. Wait for confirmation

Binding code expires in 5 minutes.
```

### 2. Bind Device in Feishu

Open your Feishu app and send the binding code to the bot:

```
/bind ABC-123-XYZ
```

### 3. Configure Security

Add allowed directories where Claude Code can operate:

```bash
# Add a single directory
remote-cli config add-dir ~/projects

# Add multiple directories
remote-cli config add-dir ~/work ~/code/company-repos

# View current configuration
remote-cli config show
```

### 4. Start Service

```bash
remote-cli start
```

### 5. Check Status

```bash
remote-cli status
```

### 6. Stop Service

```bash
remote-cli stop
```

## Slash Commands

Once connected, use these commands in Feishu:

### Core Management

| Command | Description |
|---------|-------------|
| `/help` | Show help information |
| `/status` | Show backend, model, effort, queue, and thread status |
| `/context` | Show current session context and queue diagnostics |
| `/skills` | List available skills for the active backend |
| `/abort` | Abort the currently executing task in this thread |
| `/queue` | Inspect or manage confirmed messages waiting in thread queues |
| `/clear` | Clear conversation context for this thread |
| `/new` | Alias for `/clear`; start a fresh conversation in this thread |
| `/compact` | Compress conversation history to save tokens |
| `/model [name]` | List models for the active backend or set this thread's model |
| `/effort [auto|level]` | Show or set per-thread reasoning effort for Codex/AGY/OpenCode/Kimi/ZCode/Pi |
| `/cd <dir>` | Change working directory for this thread |
| `/backend` | List backends and show the current thread's effective backend |
| `/bind <码>` | Bind a new device |
| `/unbind` | Unbind all devices |
| `/device` | List and switch between bound devices |

### Multi-session (Threads)

Start multiple independent sessions simultaneously.

| Command | Description |
|---------|-------------|
| `/thread list` | List all threads and their status |
| `/thread new [name]` | Create a new session thread |
| `/thread delete <name>`| Delete an idle thread |

*Tip: Reply directly to a card message from a specific thread to continue the conversation in that thread.*

### Backend Switching

Backend selection supports both global and per-thread modes:

| Command | Description |
|---------|-------------|
| `/backend` | List installed backends and show the current thread's effective backend |
| `/backend <index>` | Switch all threads to the selected backend and clear per-thread overrides |
| `/backend <index> @` | Switch only the current thread to the selected backend |
| `/backend default @` | Clear the current thread's override and follow the global backend |

The backend index follows the order shown by `/backend` (Claude Code, Codex CLI, OpenCode CLI, Kimi Code CLI, ZCode, Pi, then AGY CLI when installed). Per-thread backend choices are persisted in `threads.json`. Different threads can use different backends and execute concurrently. A backend switch is rejected while the affected thread is running; a global switch is rejected while any thread is running. Backend session data is preserved when switching, so returning to a backend can resume its previous session.

### Command Queues

Each thread executes one command at a time because Claude Code, AGY, Codex, OpenCode, Kimi Code, ZCode, and Pi sessions are sequential. If a normal message is sent while its thread is busy, remote-cli shows a Feishu confirmation card instead of queueing it immediately. The message is queued only after clicking **Add to queue**; clicking **Cancel** or waiting for the confirmation to expire discards it.

With a CLI and Router that support queue-start notifications, confirming a message keeps a static queue receipt. When the task actually starts, a new execution card appears at the bottom of the chat with its thread, working directory, task preview, and remaining queue count. Progress and results stay on that new card, and the old receipt points to it. Older clients retain the waiting-card behavior. Queued work remains in memory; this does not make queues persistent across service restarts.

`/queue` lists active and pending queues. `/queue clear` removes confirmed and awaiting-confirmation messages for the current thread. `/abort` stops the current task and clears that thread's queue. A message sent while abort cleanup is still running waits for cleanup and then starts normally, so it is not discarded with the old task. Backend or execution-context changes are rejected while a thread is busy, and a successful backend switch clears affected queues. When the active task finishes, the first confirmed queued message starts even if the active task ended with a backend error such as model capacity. If a task that was taken from the queue fails, the remaining queue pauses; use `/queue continue` to resume or `/abort` to discard the remaining messages. Queues are in-memory and are discarded on service restart.

### Image Input

You can send a standalone image or a rich-text message containing both text and images to the Feishu bot. remote-cli downloads the image resources and forwards the text and images together to the active Claude Persistent, Codex App Server, OpenCode ACP, Kimi Code ACP, ZCode app-server, or Pi RPC backend. AGY currently accepts text only and will not process image attachments. Ordinary file attachments are not supported yet.

Codex App Server generated images are also forwarded back to Feishu. Codex emits the generated image through its app-server protocol; the CLI sends it to Router, Router uploads it to Feishu, and the image is rendered in the existing Card 2.0 response. This requires both CLI and Router versions with image forwarding support. Upgrading only Router is backward-compatible, but an older CLI will not generate or send image events; upgrading only CLI is also safe, but an older Router will ignore the optional image stream and still show the text response.

All backends can also send a local image generated during a task when the tool result or final response includes its path or a Markdown image link, such as `chart.png` or `![chart](./chart.png)`. The file must be inside an allowed working directory and no larger than 2 MiB. The CLI reads the file and reuses the same image stream; Router uploads it and renders it in the current Card 2.0 response. This path-based fallback is useful for charts and screenshots and does not require the backend to emit a native image event.

### Models and Reasoning Effort

`/model` and `/effort` apply to the current thread and are stored separately for each backend:

| Command | Description |
|---------|-------------|
| `/model` | Show the current backend, selected model, and available models |
| `/model <name>` | Set the model for the current thread and backend |
| `/effort` | Show the current reasoning effort and backend-supported levels |
| `/effort <auto|level>` | Set or clear (`auto`) the current thread's effort override |

Model listing is backend-specific: Claude Code uses `claude --print /model`, AGY uses `agy models`, Codex app-server uses its authenticated model catalog, OpenCode and Kimi Code use ACP session configuration options, ZCode uses its official app-server catalog, and Pi uses RPC `get_available_models`. Reasoning effort is currently supported by Codex, AGY, OpenCode, Kimi Code, ZCode, and Pi; Claude Code returns an unsupported message. `auto` removes the per-thread override and restores the selected model's or backend's default effort.

### Remote Machine Management

Control remote servers or Docker through `remote-cli` proxies.

| Command | Description |
|---------|-------------|
| `/machines` | List all configured remote machines |
| `/machine add` | Add a new remote machine (SSH) |
| `/containers <ID>`| List Docker containers on a specific machine |
| `/search <ID> <path>`| Search files on a remote machine/container |
| `/view <ID> <path>` | View remote file content |
| `/replace <ID> <path>`| Replace a remote file (with automatic backup) |
| `/backups <ID>` | View file backup history |
| `/restore <ID>` | Restore a file from backup |
| `/proxy set/show` | Configure global access proxy |

### AI CLI Commands Passthrough

Slash commands that remote-cli does not handle itself are forwarded to the active AI backend, with per-backend support:

- **Claude Code**: full passthrough via `claude <cmd> --print` — all commands/skills work, e.g. `/commit`, `/review`, `/test`
- **AGY CLI (Antigravity)**: only the read-only informational commands that agy answers locally are forwarded (`agy -p "<cmd>"`): `/skills`, `/usage`, `/config`, `/changelog`, `/agents`, `/permissions`, `/hooks`, `/credits`. Other commands (including `/compact`, which agy does not intercept outside its TUI) are rejected with a clear message
- **Codex CLI (OpenAI)**: no passthrough — remote-cli uses the app-server API rather than the interactive TUI slash-command layer, so backend-specific slash commands are rejected
- **OpenCode CLI** and **Kimi Code CLI**: slash commands are sent through their persistent ACP sessions; remote-cli still handles shared commands such as `/model`, `/effort`, `/compact`, and `/abort` itself
- **ZCode**: slash commands use the persistent official app-server session; remote-cli maps `/skills` to ZCode's `/skill` and handles `/model`, `/effort`, `/compact`, and `/abort` directly
- **Pi**: extension commands, prompt templates, and `/skill:name` skills advertised by RPC `get_commands` are sent through the persistent `pi --mode rpc` session; `/skills` lists Pi skills. Built-in TUI-only commands are rejected. remote-cli still handles `/model`, `/effort`, `/compact`, and `/abort` itself

The built-in commands (`/help`, `/status`, `/context`, `/skills`, `/clear`, `/new`, `/compact`, `/model`, `/cd`, `/thread`, `/backend`, `/abort`) work across all backends. `/new` is an exact alias for `/clear`: it keeps the current remote-cli thread, working directory, backend, model, and effort settings while starting a fresh backend conversation. `/effort` controls the per-thread reasoning effort for Codex, AGY, OpenCode, Kimi Code, ZCode, and Pi; Claude Code support is not implemented yet.
`/context` works across all backends and reports the active session, model, working directory, and queue state. Pi additionally reports the official RPC session totals and current context-window usage; other backends retain the transport-availability message when exact usage is unavailable. `/skills` uses the native informational command for Claude, AGY, OpenCode, and Kimi Code, maps to ZCode's native `/skill` command, lists Pi skills via RPC, and discovers local `SKILL.md` files for Codex under `.agents/skills` and `~/.codex/skills`.

### Example Workflow

1. **Bind a new device:**
   ```
   /bind ABC-123-XYZ
   ```

2. **Check device status:**
   ```
   /status
   ```

3. **Switch to a specific device:**
   ```
   /device switch dev_darwin_a1b2c3d4
   ```
   Or use index for quick switch:
   ```
   /device 1
   ```

4. **Ask AI to help:**
   ```
   Review the authentication code in src/auth.ts and suggest improvements
   ```

5. **Use Claude Code built-in commands:**
   ```
   /commit
   ```

## Advanced Usage

### Use threads as independent workspaces

Create one thread per project, incident, or goal instead of mixing unrelated work in one conversation:

```text
/thread new api-debug
/cd ~/workspace/api
/thread new docs
/cd ~/workspace/docs
```

Replying to a completed Feishu card routes the message back to that card's thread. Thread buttons show the last component of each thread's working directory alongside its backend, making parallel workspaces easier to distinguish. Automatically generated names such as `thread-2` are shown as their sequence number, such as `2`, while custom names remain unchanged. When a long response spans multiple cards, every continuation card repeats the thread and working-directory header. `/thread list` shows the current state of every thread, while `/status` gives a compact overview of active backends, models, working directories, and queues.

Long streaming replies refresh only cards with changed content. Queued tasks combine incoming text while a refresh is pending, so card updates do not build up a backlog of intermediate text. Tool results, images, and the final response retain their order.

Thread switch panels use larger, bold text for `Reply from:` with the reply's full thread name and workspace, and for `Switch thread`. Under `Switch thread`, a check mark (`✓`) and primary button styling identify the destination of new top-level messages when the card is finalized or clicked. Selected buttons remain clickable. Switching updates only the clicked card; other historical cards retain their last displayed selection.

### Combine global and per-thread backends

Use `/backend <index>` when the whole workspace should move together. Use `/backend <index> @` when only the current thread needs a different backend:

```text
/backend
/backend 2 @
/backend default @
```

The first form changes the global backend and clears per-thread overrides. The `@` form creates or changes only the current thread's override. This is useful when one thread uses Codex for repository changes while another stays on Claude Code for review. Different threads can run at the same time, but a thread itself remains sequential.

### Use the queue as an explicit handoff

When a thread is busy, a normal message first creates a confirmation card instead of entering the queue silently. Confirm only when you know the message belongs to that thread. The card changes to an accepted or cancelled state after the decision, and repeated clicks are ignored. Use `/queue` to inspect pending confirmations and confirmed messages, `/queue clear` to discard them, and `/abort` to stop the active task and clear the thread queue.

For a safer workflow, send context-changing commands such as `/model`, `/effort`, `/cd`, `/compact`, `/clear`, or `/new` only after the current task and queue have finished. These commands are intentionally not queued behind ordinary messages.

### Select model and reasoning effort deliberately

Keep model and effort choices local to the thread when comparing backends:

```text
/model
/model <name>
/effort
/effort medium
/effort auto
```

Codex, AGY, OpenCode, Kimi Code, ZCode, and Pi expose native effort controls. Claude Code has native thinking and effort controls in its own CLI, but remote-cli's built-in `/effort` currently reports Claude as unsupported. Model catalogs and accepted effort levels vary by backend, so verify the result with `/status` or `/context` after switching.

## Expert Usage

### Operate one shared Router for a team

The recommended team topology is one Router on an internal server and one client process on each developer machine:

```text
Feishu <-> Router (Docker Compose) <-> local CLI clients
```

The Router stores Feishu configuration and device bindings in its persistent `./router-data` directory. Clients keep project files, backend sessions, and Claude Code/AGY/Codex/OpenCode/Kimi Code/ZCode/Pi installations locally. Do not put the client in Docker unless you deliberately mount every project directory and backend credential it needs.

Update a Compose deployment without losing bindings:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 router
```

Do not use `docker compose down -v` for routine updates. Back up `./router-data` before upgrades and restrict the exposed Router port to the trusted network.

### Preserve or intentionally reset backend sessions

Each thread maintains separate session state for Claude, AGY, Codex, OpenCode, Kimi Code, ZCode, and Pi. Switching backends does not delete the previous backend's session, so a thread can return to its earlier conversation. Use `/clear` or its `/new` alias when you intentionally want a fresh context; use `/backend default @` when a thread should follow future global backend changes.

### Diagnose a remote task systematically

When a task appears stuck, inspect in this order:

1. Run `/status` to verify the active thread, backend, working directory, and running state.
2. Run `/context` to inspect session and queue details.
3. Run `/queue` to distinguish confirmed messages from requests still waiting for card confirmation.
4. Use `/abort` only when you intend to stop the current task and discard that thread's queue.
5. On the Router host, inspect `docker compose logs -f router` or the service manager logs.

This separates a backend execution problem from a routing problem, a stale card, or a message that was never confirmed into the queue.

## Security

### Working Directory Selection

Only directories explicitly added to the whitelist can be selected as a thread's working directory:

```bash
remote-cli config add-dir ~/safe/directory
```

### Execution Trust Model

remote-cli does not install a global Claude Code `PreToolUse` hook and does not sandbox AI backend processes. A backend process inherits the permissions of the operating-system user running remote-cli and may access paths outside the selected working directory. For stronger isolation, run remote-cli under a dedicated OS account or inside a container or virtual machine.

### Device Authentication

- Each device generates a **unique ID** based on machine hardware
- Binding codes **expire after 5 minutes**
- Each user can only control **their bound devices**
- Unbind at any time: `/unbind` in Feishu

## Known Behaviors

### Safety-Filtered Reasoning (Claude 3.7 Sonnet)

When using Claude 3.7 Sonnet, you may occasionally see a message like:
`💭 Some reasoning was filtered by safety systems`

This is normal behavior when Claude's internal reasoning triggers safety filters. The encrypted reasoning is preserved for session continuity, and response quality is not affected. Claude 4 models do not produce these notifications.

## Troubleshooting

### Service won't start

```bash
# Check if already running
remote-cli status

# View logs
remote-cli logs

# Restart
remote-cli stop
remote-cli start
```

### Connection issues

```bash
# Check network
ping your-router-server.com

# Verify configuration
remote-cli config show

# Re-initialize
remote-cli init --server https://your-router-server.com --force
```

### Binding code expired

```bash
# Generate new binding code
remote-cli init --force
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

## Appendix

### Configuration Reference

#### Local Client Config (`~/.remote-cli/config.json`)

```json
{
  "deviceId": "dev_xxx",
  "serverUrl": "https://your-router-server.com",
  "security": {
    "allowedDirectories": ["/path/to/project"]
  },
  "executor": {
    "type": "agy",
    "agy": {
      "model": "gemini-3.8-flash-low",
      "autoApprove": true,
      "command": "agy"
    }
  },
  "machines": {},
  "remote": {}
}
```

- `executor.type`: Global default backend. Options are `auto` (Claude Persistent), `claude-persistent`, `agy`, `codex`, `opencode`, `kimi`, `zcode`, `pi`. Per-thread overrides are managed with `/backend <index> @`.
- `executor.agy`: 
    - `model`: Model slug from `agy models` (e.g. `gemini-3.8-flash-low`). Unset = agy default. Invalid slugs are rejected by agy with a clear error.
    - `autoApprove`: Automatically approve tool permissions via `--dangerously-skip-permissions` (default true).
    - `command`: agy binary to invoke (default `agy`).
- `executor.opencode`:
    - `model`: Provider/model identifier exposed by `/model`. Unset = OpenCode session default.
    - `autoApprove`: Automatically choose the first allow option for ACP tool permission requests (default true); false relays the request through the mobile input flow.
    - `command`: OpenCode binary to invoke (default `opencode`).
- `executor.kimi`:
    - `model`: Model alias exposed by `/model`. Unset = Kimi Code session default.
    - `autoApprove`: Automatically choose the first allow option for ACP tool permission requests (default true); false relays the request through the mobile input flow.
    - `command`: Kimi Code binary to invoke (default `kimi`).
- `executor.zcode`:
    - `model`: Model ID exposed by the authenticated ZCode catalog. Unset = ZCode session default.
    - `autoApprove`: Run ZCode sessions in `yolo` mode and automatically approve tool permissions (default true). When false, sessions use `build` mode and permission requests are relayed through the mobile input flow. Questions and plan approvals are always relayed.
    - `command`: Official `zcode` command or bundled `zcode.cjs` path. When unset, remote-cli checks `PATH` and standard ZCode desktop installation paths.
- `executor.pi`:
    - `model`: Model as `provider/id` or a bare id from `/model`. Unset = Pi session default.
    - `provider`: Optional provider when `model` is a bare id (for example `google`).
    - `autoApprove`: Pass `--approve` to Pi so non-interactive RPC runs trust project-local resources (default true). When false, remote-cli passes `--no-approve`. Pi extension UI dialogs are always relayed through the mobile input flow.
    - `command`: Pi binary to invoke (default `pi`).
- `executor.codex`:
    - `model`: Model selected for Codex turns. Unset = codex default. Use `/model` in Feishu to query the authenticated account's available models.
    - `autoApprove`: Use `approvalPolicy: never` with full access (default true). When false, app-server approval requests are relayed through the existing mobile input flow.
    - `command`: codex binary to invoke (default `codex`).

When loading configuration from remote-cli 1.6.30 or earlier, `executor.type: claude-spawn` is automatically migrated to `claude-persistent`, and the removed `executor.codex.transport` field is discarded. Codex always uses app-server.

#### Using AGY CLI (Antigravity)

```bash
# 1. Install and authenticate (opens browser for Google OAuth)
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy  # first launch walks through login

# 2. Switch backend (Can also use /backend command in Feishu)
remote-cli config set executor.type agy

# 3. Optionally pin a model (list valid slugs with: agy models)
remote-cli config set executor.agy.model gemini-3.8-flash-low
```

#### Using OpenCode CLI

```bash
# 1. Install and authenticate
npm install --global @opencode/cli
opencode auth login

# 2. Switch backend (Can also use /backend in Feishu)
remote-cli config set executor.type opencode

# 3. Optionally pin a provider/model from /model
remote-cli config set executor.opencode.model opencode/nemotron-3.5-lightning-free
```

The OpenCode backend runs one persistent `opencode acp` process per active thread. It preserves the ACP session id across messages, backend switches, and service restarts. `/model` and `/effort` use ACP session options, `/compact` uses OpenCode's native command, `/abort` sends ACP cancellation, and image messages are sent as native ACP image content. With `autoApprove: true`, tool permission requests select the first allow option; with `false`, users answer them through the mobile input flow. Model questions are always relayed to the user and can be answered by option name or number.

#### Using Kimi Code CLI

```bash
# 1. Install and authenticate
npm install --global @moonshot-ai/kimi-code
kimi login

# 2. Switch backend (Can also use /backend in Feishu)
remote-cli config set executor.type kimi

# 3. Optionally select a model after login
# Use /model in Feishu to see the authenticated catalog.
```

The Kimi Code backend runs one persistent `kimi acp` process per active thread. It stores resumable session pointers under `~/.remote-cli/kimi-sessions/`, sends image inputs through ACP, maps `/effort` to Kimi's `thinking` session option, forwards native slash commands, and uses ACP cancellation for `/abort`. Model questions are relayed to the mobile input flow even when tool permissions are auto-approved. Run `kimi login` before selecting the backend.

#### Using ZCode

```bash
# 1. Install the official ZCode desktop app or CLI, then authenticate
# https://zcode.z.ai/en/docs/install
zcode login

# 2. Switch backend (Can also use /backend in Feishu)
remote-cli config set executor.type zcode

# 3. Optionally select a model after login
# Use /model in Feishu to see the authenticated catalog.
```

The ZCode backend talks directly to the official `zcode app-server --stdio` protocol; it does not install or run an ACP bridge. It auto-discovers `zcode` on `PATH` and the bundled `zcode.cjs` in standard desktop installation paths. Session pointers are stored under `~/.remote-cli/zcode-sessions/`. `/model`, `/effort`, `/compact`, `/abort`, image input, native slash commands, tool events, permission prompts, model questions, and plan approvals are supported. The cross-backend `/skills` command is translated to ZCode's native `/skill` command.

When remote-cli launches a bundled `zcode.cjs` directly, use Node.js 22 or newer because the current official CLI uses `node:sqlite`. ZCode Start Plan authentication depends on a desktop-only captcha flow and is unavailable to a headless app-server client; use an authenticated GLM Coding Plan or API-key provider for remote-cli. The app-server protocol is shipped by ZCode but is not yet documented as a public compatibility contract, so a future ZCode upgrade may require an adapter update.

#### Using Pi

```bash
# 1. Install and authenticate (first launch opens provider login)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi  # complete provider login in the interactive TUI

# 2. Switch backend (Can also use /backend in Feishu)
remote-cli config set executor.type pi

# 3. Optionally pin a provider/model from /model
remote-cli config set executor.pi.model google/gemini-3-flash
```

The current Pi package requires Node.js 22.19.0 or newer. The Pi backend runs one persistent `pi --mode rpc` process per active thread. Session files are stored under `~/.remote-cli/pi-sessions/` so Feishu threads do not reuse interactive `~/.pi` sessions. `/model` uses RPC `get_available_models` / `set_model`, `/effort` maps to Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), `/compact` uses native RPC compaction, `/abort` sends RPC `abort`, `/context` uses RPC `get_session_stats`, and image messages are sent as Pi image content. Automatic provider retries are shown as progress without becoming part of the final model response. Changing the working directory starts a fresh Pi session because Pi stores the working directory in the session header. `autoApprove: true` trusts project-local Pi resources through the official `--approve` flag; extension UI dialogs are still relayed to the user, including labels and descriptions from compatible structured select options. Authenticate with interactive `pi` before selecting the backend.

#### Using Codex CLI (OpenAI)

```bash
# 1. Install and authenticate
npm install -g @openai/codex
codex login

# 2. Switch backend (Can also use /backend command in Feishu)
remote-cli config set executor.type codex

# 3. Optionally pin a model
remote-cli config set executor.codex.model gpt-5.2-codex
```

The Codex backend runs one persistent `codex app-server` process per active
remote-cli thread. Conversation continuity is preserved across messages,
working-directory changes, backend switches, and service restarts by resuming
the persisted Codex thread id. `/model` queries app-server's model catalog,
`/compact` uses native thread compaction, `/abort` interrupts the active turn,
and image messages are sent as Codex image inputs.
Generated Codex images are returned to Feishu when both the CLI and Router support image forwarding.

Codex app-server is the only supported Codex transport. Legacy `codex exec` configuration is migrated automatically during startup.
Startup also checks that the installed Codex CLI exposes `codex app-server --help` and prints an upgrade command when the installed Codex CLI is too old.

### Development

```bash
# Clone repository (replace with actual repository URL)
git clone <repository-url>
cd remote-cli

# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Run CLI in development mode
npm run cli:dev

# Run router in development mode
npm run router:dev
```

### Support

- Issues: Please submit via the project's Issue page
- Discussions: Please participate via the project's Discussion page

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes and user-visible changes.
