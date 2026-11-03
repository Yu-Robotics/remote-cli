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

From Router 1.6.205, `/api/feishu/card-callback` is removed; configure card actions through the native long connection. Public `/health` responses contain status, timestamp, and connection count without device identifiers. Binding requests and unregistered WebSocket connections use bounded admission, including a fixed registration deadline. HTTP 429 binding refusals include `Retry-After`. Peer budgets use the direct socket address, ignoring `X-Forwarded-For`, so clients behind one proxy share a budget. Existing configuration and legacy CLI registration remain supported.

### Public Ingress Budgets

Router 1.6.205 uses fixed budgets without requiring new configuration fields:

| Resource | Limit |
|---|---|
| HTTP request body | 16 KiB |
| HTTP request / request headers | 30 seconds / 15 seconds |
| WebSocket message, including fragmented assembly | 16 MiB |
| Unregistered WebSocket message / registration deadline | 16 KiB / 30 seconds, independent of heartbeats |
| Pending WebSocket connections | 512 globally / 64 per direct peer |
| New WebSocket connections per minute | 4096 globally / 256 per direct peer |
| Unregistered wire frames | 64 total / 16 per second per connection, including control and continuation frames |
| Binding attempts per 5 minutes | 4096 globally / 128 per direct peer / 3 per device ID |
| Unexpired persisted binding codes | 4096 globally / 3 per device ID |
| Rate-counter entries | 8192; live entries are never evicted to admit a new key |

Binding refusals return HTTP 429 and `Retry-After: 300`; exceeding WebSocket admission or frame budgets terminates the connection. Counters are process-local; persisted binding-code caps survive restarts. Expired codes are reclaimed during successful binding-code writes. Device IDs select target budgets, not authenticated identities. Shared proxies and NATs share the direct-peer budgets; forwarded headers cannot create additional peer allowances.

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

The container uses `/router-data` as its home directory, so configuration and bindings live in `./router-data/.remote-cli-router/` on the host. Create `./router-data` before setup; on Linux, set `ROUTER_UID` and `ROUTER_GID` in `.env` to its owner's IDs. Set `ROUTER_PORT` before setup and enter the same port in the wizard. The Compose service uses `restart: always`; explicit `docker compose down` still removes the container. No App ID or App Secret is required in environment variables. See [Docker Compose](README.md#docker-compose-recommended-for-shared-routers) for the complete setup sequence.

User-device bindings and the selected thread for each user/device pair persist across Router restarts in `JsonStore` (`bindings.json`). Device switching restores that device's saved selection; it does not reset native sessions. Historical card-routing maps remain in memory, so a persisted selection does not restore arbitrary old-card reply routes. Task recovery rebuilds routing for reported tasks on usable surviving cards or new recovery cards; it does not persist all Router state or recover a restarted CLI's in-memory task state.

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
