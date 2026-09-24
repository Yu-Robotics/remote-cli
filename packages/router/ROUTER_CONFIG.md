# Router Configuration Guide

## Overview

The router server uses a JSON-based persistent storage system instead of Redis. All data (bindings and configurations) are stored in local JSON files in `~/.remote-cli-router/`.

## Configuration

### Interactive Setup

Run the interactive configuration wizard:

```bash
remote-cli-router config
# or
remote-cli-router config setup
```

### Required Fields

- **Feishu App ID**: Your Feishu application ID (required)
- **Feishu App Secret**: Your Feishu application secret (required)

### Optional Fields

- **Feishu Encrypt Key** and **Verification Token**: Retained in the wizard for compatibility; the current long-connection handler uses App ID and App Secret and does not read these fields
- **Server Port**: Default is 3000
- **Server Host**: Default is 0.0.0.0
- **WebSocket Heartbeat Interval**: Default is 30000ms

Enable Feishu **Long Connection** mode and subscribe to `im.message.receive_v1` and `card.action.trigger`. No public webhook endpoint is required. Clients must be able to reach the Router's HTTP and `/ws` endpoints; use TLS for public deployments.

### View Current Configuration

```bash
remote-cli-router config show
```

### Reset Configuration

```bash
remote-cli-router config reset
```

## Storage

### Configuration File

Configuration is stored at: `~/.remote-cli-router/config.json`

### Bindings Data

User bindings are stored at: `~/.remote-cli-router/bindings.json`

This file persists across router restarts, ensuring that user-device bindings are not lost.

## Deployment

### Development

```bash
# From the repository root
npm ci
cd packages/router
npm run build
npm run dev
```

### Production

```bash
npm install -g @yu_robotics/remote-cli-router
remote-cli-router config setup
remote-cli-router start
```

### Docker Compose

For a shared Router server, use the repository-root Compose configuration:

```bash
docker compose build
docker compose run --rm router config setup
docker compose up -d
```

The container uses `/router-data` as its home directory, so configuration and bindings live in `./router-data/.remote-cli-router/` on the host. Create `./router-data` before setup; on Linux, set `ROUTER_UID` and `ROUTER_GID` in `.env` to its owner's IDs. Set `ROUTER_PORT` before setup and enter the same port in the wizard. No App ID or App Secret is required in environment variables. See [Docker Compose](README.md#docker-compose-recommended-for-shared-routers) for the complete setup sequence.

User-device bindings persist across Router restarts. The Router's active thread selection and historical card routing are held in memory. Task recovery rebuilds routing for reported tasks on new cards; it does not persist all Router state or recover a restarted CLI's in-memory task state.

## Differences from Redis-based Approach

| Feature | Redis | JSON Files |
|---------|-------|------------|
| **Data Persistence** | Requires Redis server running | Built-in, no external dependencies |
| **Scalability** | High (distributed) | Limited (single instance) |
| **Setup Complexity** | Moderate (need Redis) | Low (just run the CLI) |
| **Best For** | High-concurrency, multi-instance | Low-concurrency, single instance |

## Notes

- JSON storage uses debounced writes (1 second delay) to minimize disk I/O
- Data is automatically loaded on startup and cleaned up (expired binding codes are removed)
- On graceful shutdown, data is flushed to disk immediately
