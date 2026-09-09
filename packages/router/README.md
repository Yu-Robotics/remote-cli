# @yu_robotics/remote-cli-router

Router server for [remote-cli](https://www.npmjs.com/package/@yu_robotics/remote-cli) — manages message forwarding between Feishu (Lark) and local CLI clients via WebSocket.

## Overview

The router server acts as a bridge between Feishu messaging and developer machines running the remote-cli client. It handles:

- **User-device binding** via Feishu bot commands
- **Message routing** between Feishu and connected CLI clients
- **WebSocket connections** from local clients
- **Feishu long connection** for receiving and sending messages

## Prerequisites

- A cloud server with at least **1 CPU core** and **1GB RAM**
- **Node.js** >= 18.0.0
- A **domain name** with SSL certificate (HTTPS required for Feishu)
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

### 2. Start the Server

```bash
remote-cli-router start
```

### 3. Deploy with PM2 (Production)

```bash
pm2 start remote-cli-router --name router -- start
```

## Commands

| Command | Description |
|---------|-------------|
| `remote-cli-router config` | Interactive configuration |
| `remote-cli-router config show` | View current configuration |
| `remote-cli-router config reset` | Reset to defaults |
| `remote-cli-router start` | Start the server |
| `remote-cli-router stop` | Stop the server |
| `remote-cli-router status` | Check server status |

The Feishu command reference includes the cross-backend `/status`, `/context`, and `/skills` commands, plus per-thread queue controls. See the root [README](../../README.md) for the complete command and backend behavior reference.

## Architecture

```
Mobile Phone -> Feishu -> Router Server -> WebSocket -> Local CLI -> Claude Code
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

## Documentation

For full documentation, see the [project README](https://github.com/xiaoyu/remote-cli#readme).

## License

MIT
