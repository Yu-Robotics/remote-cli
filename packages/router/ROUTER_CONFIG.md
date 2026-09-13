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

- **Feishu Encrypt Key**: For message encryption (optional)
- **Feishu Verification Token**: For webhook verification (optional)
- **Server Port**: Default is 3000
- **Server Host**: Default is 0.0.0.0
- **WebSocket Heartbeat Interval**: Default is 30000ms

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
cd packages/router
npm run build
npm run dev
```

### Production

```bash
npm run build -w @yu_robotics/remote-cli-router
remote-cli-router start
```

### Docker Compose

For a shared Router server, use the repository-root Compose configuration:

```bash
docker compose build
docker compose run --rm router config setup
docker compose up -d
```

The interactive setup writes configuration and bindings to the mounted `./data` directory. No App ID or App Secret is required in environment variables. Use `docker compose logs -f router` for logs and `docker compose down` to stop the service.

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
