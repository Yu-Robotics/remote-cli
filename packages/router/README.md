# @yu_robotics/remote-cli-router

Router server for [remote-cli](https://www.npmjs.com/package/@yu_robotics/remote-cli) — manages message forwarding between Feishu (Lark) and local CLI clients via WebSocket.

## Overview

The router server acts as a bridge between Feishu messaging and developer machines running the remote-cli client. It handles:

- **User-device binding** via Feishu bot commands
- **Message routing** between Feishu and connected CLI clients
- **Code-change rendering** with collapsible, line-aware diff previews inside streaming cards
- **Image message forwarding** for Feishu images to supported backends, plus Codex native image output and local image files returned by any backend
- **Client service management** is handled by the local CLI; the Router remains a separate long-running server process
- **Queued task cards** appear at execution time for capable clients, with the thread, workspace, task preview, and remaining queue count; older clients retain waiting cards
- **WebSocket connections** from local clients
- **Feishu long connection** for receiving and sending messages
- **Task recovery** with compatible clients: resume output on a usable surviving card or create a new one, with an independent gap notice and plain-text handling of resumed fragments; failed card creation is not acknowledged as successful recovery
- **Table-aware card splitting** and a single text fallback retry for a card rejected by Feishu's table limit

## Prerequisites

- A server reachable by your local CLI clients, with outbound access to Feishu
- **Node.js** >= 18.0.0
- For public deployments, a **domain name** and TLS reverse proxy for client connections; internal deployments can use HTTP on a trusted network
- A **Feishu bot** with messaging permissions

## Installation

```bash
npm install -g @yu_robotics/remote-cli-router
```

## Quick Start

### 1. Configure

```bash
remote-cli-router config
```

You will be prompted for:
- Feishu App ID (required)
- Feishu App Secret (required)
- Feishu Encrypt Key (optional)
- Feishu Verification Token (optional)
- Server Port (default: 3000)

Configure the bot's **Long Connection** event mode with `im.message.receive_v1` and `card.action.trigger`. The Router opens the connection to Feishu; no inbound Feishu webhook URL is required. Encrypt Key and Verification Token are retained in the configuration wizard but are not used by the current long-connection handler.

### 2. Start the Server

```bash
remote-cli-router start
```

### 3. Deploy with PM2 (Production)

```bash
pm2 start remote-cli-router --name router -- start
```

### Docker Compose (Recommended for Shared Routers)

From the repository root, build the Router image and run the interactive setup once:

```bash
docker compose build
# Optional: copy .env.example to .env and set ROUTER_PORT first
mkdir -p router-data
docker compose run --rm router config setup
docker compose up -d
```

The `./router-data` bind mount stores Router data under the container's `/router-data` home directory (`/router-data/.remote-cli-router/`). On Linux, set `ROUTER_UID` and `ROUTER_GID` in `.env` to the output of `id -u` and `id -g`; they must match the directory owner. Set `ROUTER_PORT` before setup if port `3000` is unavailable; it must match the server port entered in the setup wizard. Use `docker compose logs -f router` to inspect logs and `docker compose down` to stop the service. Run local clients directly on their host machines rather than in Docker so they can access project files and local AI CLI binaries.

## Commands

| Command | Description |
|---------|-------------|
| `remote-cli-router config` | Interactive configuration |
| `remote-cli-router config show` | View current configuration |
| `remote-cli-router config reset` | Reset to defaults |
| `remote-cli-router start` | Start the server |
| `remote-cli-router stop` | Stop the server |
| `remote-cli-router status` | Check server status |

The Feishu command reference includes the cross-backend `/status`, `/context`, and `/skills` commands, the `/clear` and `/new` fresh-conversation aliases, plus per-thread queue controls. See the root [README](../../README.md) for the complete command and backend behavior reference.

## Architecture

```
Mobile Phone -> Feishu -> Router Server -> WebSocket -> Local CLI -> AI Backend
                                                                        |
Mobile Phone <- Feishu <- Router Server <- WebSocket <- Local CLI <- Results
```

## Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
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

## Health Check

```bash
curl https://your-domain.com/health
# {"status":"ok","timestamp":1234567890,"connections":0}
```

## Advanced Usage

Use one Router for multiple trusted clients. Each client connects from the developer's machine, while the Router owns Feishu configuration, device bindings, routing, and thread switch state. Feishu thread buttons show automatic names such as `thread-2` as their sequence number, such as `2`, while callbacks retain the full internal name. Continuation cards repeat the thread and working-directory header of the original card. A thread can override its backend with `/backend <index> @`; `/backend <index>` changes the global backend and clears per-thread overrides.

Thread switch panels show `Reply from:` with the reply's full thread name and workspace. Under `Switch thread`, a check mark (`✓`) and primary button styling identify the destination of new top-level messages when the card is finalized or clicked. Selected buttons remain clickable. Switching updates only the clicked card; other historical cards retain their last displayed selection.

When a client thread is busy, the Router sends a confirmation card before accepting another message into its queue. `/queue` shows queue state, `/queue clear` discards queued messages, and `/abort` stops the active task and clears that thread's queue. Messages received while abort cleanup is in progress wait for the client backend to become safe before execution starts.

## Expert Usage

The recommended production layout is Docker Compose on an internal server with persistent `./router-data` storage:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 router
```

Back up `./router-data` before upgrades and do not use `docker compose down -v` for routine updates. Restrict the Router port to the trusted network. When diagnosing routing issues, inspect `/health` and the Router logs before restarting clients.

## Documentation

For full documentation, see the [project README](https://github.com/Yu-Robotics/remote-cli#readme).

## License

MIT

## Changelog

See the project [CHANGELOG.md](../../CHANGELOG.md) for release notes and user-visible changes.

## Codex Approval Cards

When supported by the connected CLI, Codex permission requests appear as standalone cards with Allow, Deny, and (for explicit directory grants) Allow and remember directory buttons. Each button targets the original user, device, thread, and request. The card shows success only after the CLI confirms the decision. Completed requests cannot be approved again, and pending approvals receive fresh cards after reconnecting. After a Router crash, buttons on old cards may remain visible but are rejected as expired. Both CLI and Router must be upgraded to use this feature; unsupported peers and failed card delivery retain text approvals.

Restricted Claude Code threads use the same approval card flow for file modifications and commands outside their native sandbox. The CLI enforces these approvals even when native settings previously auto-approved writes. Missing sandbox dependencies stop execution on the CLI; the Router cannot override that startup failure. See [Claude sandbox configuration](../../README.md#optional-claude-code-sandbox).
