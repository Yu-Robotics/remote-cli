# Router Server Quick Start Guide

## Installation

### For Development (Recommended)

If you're developing or testing the router locally:

```bash
# 1. Build the router package
cd packages/router
npm run build

# 2. Create global symlink
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

Install globally once published to npm:

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
   - `/webhook/feishu` - Feishu webhook receiver

2. **WebSocket Server**
   - `/ws` - WebSocket endpoint for local clients
   - Handles device registration and message routing

3. **Data Storage (JSON)**
   - `~/.remote-cli-router/config.json` - Server configuration
   - `~/.remote-cli-router/bindings.json` - User-device bindings

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

### POST /webhook/feishu

Receives Feishu event webhooks. Automatically handles:
- URL verification challenges
- Message events (`im.message.receive_v1`)
- Command routing to bound devices

## WebSocket Protocol

Local clients connect to `/ws` and exchange JSON messages:

### Message Types

1. **Binding Request** (Client → Server)
```json
{
  "type": "binding_request",
  "messageId": "msg_xxx",
  "timestamp": 1234567890,
  "data": {
    "deviceId": "dev_mac_xxx"
  }
}
```

2. **Binding Confirmation** (Server → Client)
```json
{
  "type": "binding_confirm",
  "messageId": "msg_xxx",
  "timestamp": 1234567890,
  "data": {
    "success": true
  }
}
```

3. **Heartbeat** (Bidirectional)
```json
{
  "type": "heartbeat",
  "messageId": "msg_xxx",
  "timestamp": 1234567890,
  "data": {}
}
```

4. **Command** (Server → Client)
```json
{
  "type": "command",
  "messageId": "msg_xxx",
  "timestamp": 1234567890,
  "data": {
    "openId": "ou_xxx",
    "content": "Fix TypeScript errors",
    "workingDir": "~/projects/my-app"
  }
}
```

5. **Response** (Client → Server)
```json
{
  "type": "response",
  "messageId": "msg_xxx",
  "timestamp": 1234567890,
  "data": {
    "openId": "ou_xxx",
    "success": true,
    "output": "Fixed 3 TypeScript errors..."
  }
}
```

## Connection Management

- **Heartbeat Interval**: Configurable (default: 30 seconds)
- **Connection Timeout**: 2x heartbeat interval without response
- **Stale Cleanup**: Automatic cleanup every heartbeat interval
- **Reconnection**: Clients automatically reconnect on disconnect

## Security

### Directory Whitelisting

The router itself doesn't enforce directory restrictions - this is handled by the local client. The router only forwards commands.

### Device Authentication

Each device:
1. Generates a unique device ID based on machine characteristics
2. Creates a binding code (valid for 5 minutes)
3. User binds the code in Feishu with `/bind CODE`
4. Router stores the binding: `open_id → device_id`
5. All future messages from that user are routed to their device

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

### Feishu webhook not working

1. Verify webhook URL in Feishu console matches your domain
2. Ensure HTTPS/SSL is configured (Feishu requires HTTPS)
3. Check firewall allows inbound connections on server port
4. Review server logs for errors

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
- Redis alternatives (now using JSON storage)
- Monitoring and logging

## File Locations

- **Config**: `~/.remote-cli-router/config.json`
- **Bindings**: `~/.remote-cli-router/bindings.json`
- **PID File**: `~/.remote-cli-router/server.pid` (only when server is running)
- **Logs**: PM2 logs or stdout when running in foreground
