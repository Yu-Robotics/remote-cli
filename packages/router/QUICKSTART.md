# Router Server Quick Start Guide

## Installation

### For Development (Recommended)

If you're developing or testing the router locally:

```bash
# 1. Install locked dependencies from the repository root
npm ci

# 2. Build the router package
cd packages/router
npm run build

# 3. Create global symlink
npm link
```

This creates a global `remote-cli-router` command that points to your local development directory. Any changes you make will be reflected immediately after rebuilding.

**Verify installation:**
```bash
which remote-cli-router
# Should show: /usr/local/bin/remote-cli-router (or similar)

remote-cli-router --help
# Should display available commands
```

**To uninstall the link:**
```bash
cd packages/router
npm unlink
```

### For Production

Install the published package globally:

```bash
npm install -g @yu_robotics/remote-cli-router
```

## Configuration

Run the interactive configuration wizard:

```bash
remote-cli-router config
```

You'll be prompted for:

**Required:**
- Feishu App ID
- Feishu App Secret

**Optional (with defaults):**
- Feishu Encrypt Key
- Feishu Verification Token
- Server Port (default: 3000)
- Server Host (default: 0.0.0.0)
- WebSocket Heartbeat Interval (default: 30000ms)

Configuration is saved to `~/.remote-cli-router/config.json`.

### View Current Configuration

```bash
remote-cli-router config show
```

### Reset to Defaults

```bash
remote-cli-router config reset
```

## Starting the Server

### Foreground (for testing)

```bash
remote-cli-router start
```

Press Ctrl+C to stop, or use `remote-cli-router stop` from another terminal.

## Managing the Server

### Check Server Status

```bash
remote-cli-router status
```

Shows:
- Running status (running/not running)
- Process ID (PID)
- Server configuration (host, port)
- Connected devices count
- Uptime

### Stop the Server

```bash
remote-cli-router stop
```

Gracefully stops the running server. If the process doesn't stop within 10 seconds, it will be forcefully terminated.

### Background (recommended for production)

Using PM2:

```bash
# Install PM2 if not already installed
npm install -g pm2

# Start the router
pm2 start remote-cli-router --name router -- start

# View logs
pm2 logs router

# Stop the router
pm2 stop router

# Restart the router
pm2 restart router

# Start on boot
pm2 startup
pm2 save
```

### Docker Compose (recommended for a shared Router)

From the repository root:

```bash
docker compose build
docker compose run --rm router config setup
docker compose up -d
```

The setup wizard stores Router configuration and user-device bindings in `./router-data`. View logs with `docker compose logs -f router` and stop the service with `docker compose down`. Keep local clients outside Docker so they retain access to local project directories and AI CLI installations.

## Architecture

The router server consists of:

1. **HTTP Server (Koa)**
   - `/health` - Health check endpoint
   - `/api/version` - Router and protocol versions
   - `/api/bind/request` - Create a client binding code
   - `/api/feishu/card-callback` - HTTP card-action handler (not needed when using long-connection callbacks)

2. **WebSocket Server**
   - `/ws` - WebSocket endpoint for local clients
   - Handles device registration and message routing

3. **Data Storage (JSON)**
   - `~/.remote-cli-router/config.json` - Server configuration
   - `~/.remote-cli-router/bindings.json` - User-device bindings

4. **Feishu Long Connection**
   - Outbound WebSocket connection authenticated with App ID and App Secret
   - Receives message events and card-button callbacks without requiring an inbound webhook

## Endpoints

### GET /health

Returns server health and connection statistics:

```json
{
  "status": "ok",
  "timestamp": 1234567890,
  "connections": 3,
  "devices": ["dev_mac_xxx", "dev_linux_yyy", "dev_win_zzz"]
}
```

### Feishu Events

In the Feishu application console, enable **Long Connection** mode and subscribe to `im.message.receive_v1` and `card.action.trigger`. Messages and card actions arrive over the Router's outbound Feishu connection. There is no `/webhook/feishu` endpoint and no callback URL to configure. Internal deployments do not need a public domain solely for Feishu delivery; use TLS when exposing client connections publicly.

## WebSocket Protocol

Local clients connect to `/ws` and exchange JSON messages:

### Message Shapes

Registration uses `binding_request` / `binding_confirm` with a nested `data` payload, including the device ID, protocol version, and optional capability flags. Commands, streams, and final responses use top-level payload fields; do not wrap these fields in `data`.

For example, a Router command and its CLI response have these shapes:

```json
{
  "type": "command",
  "messageId": "msg_xxx",
  "timestamp": 1234567890,
  "openId": "ou_xxx",
  "threadId": "default",
  "content": "Fix TypeScript errors"
}
```

```json
{
  "type": "response",
  "messageId": "msg_xxx",
  "timestamp": 1234567890,
  "openId": "ou_xxx",
  "threadId": "default",
  "success": true,
  "output": "Fixed 3 TypeScript errors..."
}
```

These examples are not the complete protocol. See the [CLI types](../cli/src/types/index.ts), [Router dispatcher](src/server.ts), and [protocol versioning rules](../../CLAUDE.md#protocol-versioning) before implementing a client. Streaming, background task notifications, queue-start events, and task-recovery acknowledgments have their own fields and capability requirements.

## Connection Management

- **Heartbeat Interval**: Configurable (default: 30 seconds)
- **Connection Timeout**: 3x heartbeat interval without incoming activity
- **Stale Cleanup**: Automatic cleanup every heartbeat interval
- **Reconnection**: Clients automatically reconnect on disconnect

With task-recovery support on both sides, a reconnecting CLI reports running tasks and starts new recovery cards after the Router acknowledges them. Backends keep running during a Router outage. Old cards remain as they were; disconnected output is dropped, not buffered or replayed, and the new card marks the gap. The CLI retains only bounded final-status metadata for tasks completed while disconnected (at most 100 records for up to 24 hours, in memory). CLI restarts lose this recovery state. See [Automatic Startup and Recovery](../../README.md#automatic-client-startup) for operational limits.

## Security

### Directory Whitelisting

The client checks allowed working directories. This is not a sandbox for backend file access or shell commands; backend processes retain the operating-system user's permissions. The Router does not enforce a filesystem allowlist on the client.

### Device Authentication

Each device:
1. Generates a unique device ID based on machine characteristics
2. Creates a binding code (valid for 5 minutes)
3. User binds the code in Feishu with `/bind CODE`
4. Router stores the user's device list and active device; each device can belong to only one user
5. New top-level messages go to the selected device; replies to known cards can retain that card's device and thread routing

### Data Persistence

- **Bindings persist across restarts** (stored in JSON file)
- **Binding codes expire** after 5 minutes
- **Stale bindings** can be manually removed by unbinding in Feishu

## Troubleshooting

### Server won't start

1. Check if server is already running:
```bash
remote-cli-router status
```

2. Check configuration:
```bash
remote-cli-router config show
```

Ensure App ID and App Secret are set.

3. Check if port is already in use:
```bash
lsof -i :3000  # or your configured port
```

### Cannot stop server

If `remote-cli-router stop` fails:

1. Find the process manually:
```bash
ps aux | grep remote-cli-router
```

2. Kill the process:
```bash
kill -TERM <PID>  # Or kill -9 <PID> if TERM doesn't work
```

3. Clean up stale PID file:
```bash
rm ~/.remote-cli-router/server.pid
```

### Feishu messages or card buttons not working

1. Verify App ID and App Secret and enable the bot's Long Connection mode
2. Subscribe to `im.message.receive_v1` and `card.action.trigger`, grant the required permissions, and publish the app
3. Check outbound connectivity from the Router to Feishu; a public inbound webhook is not used
4. Check Router logs for Feishu connection or API errors; test `/health` separately to verify the client-facing server

### Devices not connecting

1. Check if server is running:
```bash
remote-cli-router status
```

2. Check WebSocket endpoint is accessible: `ws://your-domain:port/ws`
3. Verify firewall allows WebSocket connections
4. Check device logs for connection errors

### Messages not routing

1. Verify device is connected (check `/health` endpoint)
2. Confirm user has bound their device in Feishu
3. Check that binding hasn't expired
4. Review server logs for routing errors

## Development

### Run in dev mode

```bash
cd packages/router
npm run dev
```

This uses `tsx watch` for hot reload during development. It automatically restarts the server when you modify source files.

**Note:** After running `npm link`, you can use either:
- `npm run dev` - Run with hot reload (recommended during development)
- `remote-cli-router start` - Run the built version (for testing production behavior)

If the `remote-cli-router` command is not found, run `npm link` first (see Installation section above).

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/` directory.

### Test API

```bash
# Health check
curl http://localhost:3000/health

# Should return:
# {
#   "status": "ok",
#   "timestamp": 1234567890,
#   "connections": 0,
#   "devices": []
# }
```

## Production Deployment

See [README.md](../../README.md) section "Router Server Deployment" for:
- Docker deployment with docker-compose
- Nginx reverse proxy configuration
- SSL/TLS setup
- Persistent JSON storage and Docker data-directory permissions
- Monitoring and logging

## File Locations

- **Config**: `~/.remote-cli-router/config.json`
- **Bindings**: `~/.remote-cli-router/bindings.json`
- **PID File**: `~/.remote-cli-router/server.pid` (only when server is running)
- **Logs**: PM2 logs or stdout when running in foreground
