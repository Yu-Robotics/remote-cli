# Remote CLI - 通过飞书远程控制 Claude Code / AGY CLI / Codex CLI / OpenCode CLI / Kimi Code CLI / ZCode / Pi

[![npm version](https://img.shields.io/npm/v/@yu_robotics/remote-cli.svg)](https://www.npmjs.com/package/@yu_robotics/remote-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

通过飞书（Lark）消息从手机上远程控制你的 Claude Code、AGY CLI（Antigravity）、Codex CLI（OpenAI）、OpenCode CLI、Kimi Code CLI、ZCode 或 Pi。即使不在电脑前，也能继续编程。

[English Documentation](README.md)

## 功能特性

- 🌍 **远程控制**：通过手机随时随地控制本地开发环境
- 🔒 **访问控制**：工作目录选择限制与设备认证
- 📱 **移动优化**：为飞书定制的简化命令和富文本格式
- 📝 **代码变更易读**：编辑操作会在原有进度卡片中显示可折叠、按行处理的 diff 预览
- 🤖 **多后端支持**：支持 Claude Code（默认）、AGY CLI（Antigravity）、Codex CLI（OpenAI）、OpenCode CLI、Kimi Code CLI、ZCode 和 Pi，可随时切换
- 🧵 **多会话管理**：支持创建多个独立的会话线程（Threads），并行处理不同任务。支持通过飞书卡片按钮快速切换和创建新线程。
- 🖥️ **远程机器管理**：支持通过 SSH 直接在飞书中控制远程服务器或 Docker 容器。支持 `/search`、`/view`、`/replace` 等远程文件操作。
- ⚡ **持久进程**：通过 stdio 双向流保持 AI 进程长期运行，极大提升响应速度
- 📂 **工作目录控制**：会话只能选择明确加入白名单的本地工作目录
- 🚀 **简单 setup**：一键安装和初始化，支持后台守护进程模式 (`-d`)

### 使用示例

<table>
  <tr>
    <td><img src="example_0.jpg" alt="使用示例 1" height="400" /></td>
    <td><img src="example_1.jpg" alt="使用示例 2" height="400" /></td>
  </tr>
</table>

## 推荐使用场景

### 🦞 场景一：远程修复 openclaw 配置损坏（真实案例）

**适用对象**：[openclaw](https://github.com/openclaw/openclaw) 用户及各类工具的重度使用者

**背景**：[openclaw](https://github.com/openclaw/openclaw) 是一款自托管的个人 AI 助手，但它有时会在运行过程中把自己的配置文件改坏，导致无法正常启动。以往你必须坐到电脑前才能手动排查修复。现在，你在外面直接打开飞书：

```
你：  /cd ~/projects/.openclaw
      配置文件又坏了，帮我修一下

Bot： 📂 已切换到 ~/projects/.openclaw
      🔍 检查配置文件...
      🔧 读取 config.json...
      ✅ 发现问题：`apiEndpoints` 字段被写入了非法的 null 值
      📝 恢复默认值并修复格式...
      🧪 验证配置合法性...通过
      ✅ 配置已修复，openclaw 可以正常启动了
```

整个过程你只需要在手机上发一条消息，Claude Code、AGY CLI、Codex CLI、OpenCode CLI、Kimi Code CLI、ZCode 或 Pi 在你的电脑上自主完成排查、修复、验证全流程。

**这个场景推广到更多工具**：
- 任何会自动修改配置的 CLI 工具损坏后的应急修复
- 远程排查服务崩溃、配置冲突、环境变量丢失等问题
- 不需要完整 IDE，只需一条飞书消息即可让 AI 代劳

### 场景二：企业团队（局域网内部署）

**适用对象**：有统一飞书组织的企业开发团队

**部署方式**：
- 在公司内网部署一台路由服务器
- 团队成员各自在本地电脑安装 CLI 客户端
- 通过飞书机器人统一提供服务

**优势**：
- 🔒 **安全可靠**：仅需开放飞书外网通信，路由服务器和客户端均在内部网络
- 🏢 **统一管理**：一个飞书机器人服务全组织，管理员集中管理
- 💰 **成本低廉**：单台低配置服务器即可支持整个团队
- 🔐 **设备隔离**：每个成员只能控制自己的电脑，无法访问他人设备

### 场景三：个人开发者（家庭内网）

**适用对象**：独立开发者、自由职业者

**部署方式**：
- 将路由服务器部署在家庭内网（如 NAS、树莓派或闲置电脑）
- 本地开发电脑运行 CLI 客户端
- 通过飞书向外提供服务

**优势**：
- 🏠 **零公网暴露**：路由服务器无需公网 IP，通过飞书长连接通信
- 📱 **随时随地**：外出时通过手机飞书控制家中电脑
- 💡 **开发便利**：临时离开电脑也能继续编程、查看日志、修复问题
- 🆓 **完全免费**：无需购买云服务器，利用现有设备即可

## 系统架构

```
┌─────────────────┐         ┌──────────────────────────────┐
│   飞书服务器     │         │      开发者 A 的工作电脑        │
│                 │         │      (Mac/Linux)             │
│   开发者 A 的    │◀───────▶│  ┌─────────────────────────┐ │
│   手机          │         │  │  remote-cli (本地)       │ │
│   与机器人私聊   │         │  │  - WebSocket 客户端      │ │
│                 │         │  │  - AI CLI 执行器         │ │
└─────────────────┘         │  │  - 安全目录守卫           │ │
        │                   │  └──────────┬──────────────┘ │
        │                   │             ▼                 │
        │                   │  Claude Code / AGY / Codex / OpenCode / Kimi / ZCode / Pi  │
        ▼                   │  (本地 AI 后端)               │
┌─────────────────┐         └──────────────────────────────┘
│   路由服务器     │
│  (团队部署)      │         ┌──────────────────────────────┐
│  ┌───────────┐  │         │      开发者 B 的工作电脑        │
│  │ Feishu WS │  │         │  ┌─────────────────────────┐ │
│  │ 处理器    │  │◀───────▶│  │  remote-cli (本地)       │ │
│  └───────────┘  │         │  └─────────────────────────┘ │
│  ┌───────────┐  │         └──────────────────────────────┘
│  │ WebSocket │  │
│  │   中心    │  │
│  └───────────┘  │
│  ┌───────────┐  │
│  │   绑定    │  │
│  │   注册表   │  │
│  └───────────┘  │
└─────────────────┘
```

## 快速开始

```bash
# 安装 CLI
npm install -g @yu_robotics/remote-cli

# 初始化并获取绑定码
remote-cli init --server https://your-router-server.com

# 添加允许的目录
remote-cli config add-dir ~/projects

# 启动服务
remote-cli start

# 在 macOS 或 Linux 上安装自动启动
remote-cli service install

# 现在将绑定码发送给飞书机器人
# 然后就可以用手机开始编程了！
```

## 环境要求

开始前，请确保你已安装：

- **Node.js** >= 18.0.0
- **npm** 或 **yarn** 包管理器
- **Claude Code CLI**、**AGY CLI**（Antigravity）、**Codex CLI**（OpenAI）、**OpenCode CLI**、**Kimi Code CLI**、**ZCode** 或 **Pi**——至少安装并配置其中一个
- 可访问的**飞书机器人**（团队应部署一个路由服务器）

### 客户端自动启动

初始化完成后，可以安装 macOS 或 Linux 的用户级自动启动服务：

```bash
remote-cli service install
remote-cli service stop
remote-cli service start
remote-cli service status
remote-cli service uninstall
```

安装器会自动记录当前 Node.js 可执行文件、CLI 入口、`HOME`、`PATH` 和日志路径。macOS 使用 `LaunchAgent`，Linux 使用 `systemd --user`。`remote-cli stop` 也会停止正在运行的托管服务；`remote-cli service stop` 和 `remote-cli service start` 可以在不移除自动启动配置的情况下暂停和恢复服务。服务以当前用户运行，不使用 root，因此 backend 登录信息和项目目录权限应与手动启动一致。Linux 默认在用户登录后启动；如果希望服务器重启后、登录前也启动，可以明确执行 `loginctl enable-linger "$USER"`。

non-interactive 客户端在重新连接到较新版本的 Router 时会自动追平版本。客户端会等待所有 thread 和已确认队列进入空闲状态，从 npm 安装与 Router 完全一致的版本，然后退出并由进程管理器重新启动。短暂安装期间收到的新命令会被拒绝，并提示稍后重试。交互式启动不会自动升级。`--non-interactive` 设计用于由 systemd 或 macOS LaunchAgent 管理的客户端；手动使用该参数也会启用自动升级行为。如果 npm 安装或版本校验失败，现有进程会继续运行并稍后重试。

When the Router restarts or its WebSocket connection drops, running backend processes continue. With CLI and Router 1.6.55 or newer, the CLI reconnects and resumes each task on a usable surviving card, or creates a new recovery card if the old card is missing or already finalizing. The Router acknowledges recovery only after a card is available; terminal recovery is acknowledged only after its result is delivered. Retained content, the output-gap notice, and resumed text are separate components. Output during disconnection or recovery is discarded, not buffered or replayed. The first resumed text segment uses plain text until a tool or image boundary so a partial code fence or table cannot consume the notice or later content.

Recovery requests are serialized. Each request waits up to 15 seconds for acknowledgement; failure triggers exponential backoff starting at 30 seconds and capped at five minutes. Incoming output cannot bypass that wait. After 20 consecutive failures, recovery for that task pauses for the current connection, while later output remains suppressed. Successful recovery resets the failure count, and a new connection starts another recovery round. Other tasks can recover once the paused task is skipped.

Tasks that finish offline report only their completion or failure status. The CLI retains at most 100 terminal records for up to 24 hours, in memory; restarting the CLI discards them. A graceful Router stop marks unfinished reply cards as interrupted while backend tasks continue. Automatic updates wait for pending results to be acknowledged, expire, or exhaust their recovery budget; paused records do not block an update. Older Router versions keep their previous reconnect behavior.

Linux 用户从 1.6.23 或更早版本升级后，需要再次执行 `remote-cli service install`，以使用正确的路径转义重新生成 systemd unit。

## 路由服务器部署

> **注意**：大多数用户不需要部署路由服务器。团队管理员应该部署一个路由服务器供整个团队共享。

路由服务器负责在飞书和本地客户端之间转发消息。

### 环境要求

- 至少 **1 核 CPU** 和 **1GB 内存** 的服务器
- **Node.js** >= 18.0.0
- **域名**和 SSL 证书（需要 HTTPS）用于公网部署
- 已创建和配置的**飞书机器人**

### 安装路由服务器

```bash
# 从 npm 安装（推荐）
npm install -g @yu_robotics/remote-cli-router

# 或从源码安装
git clone <repository-url>
cd remote-cli
npm install
npm run build -w @yu_robotics/remote-cli-router
cd packages/router
npm link
```

### 配置路由服务器

```bash
remote-cli-router config
```

你将需要输入：
- **飞书 App ID**（必需）
- **飞书 App Secret**（必需）
- 飞书 Encrypt Key（可选）
- 飞书 Verification Token（可选）
- 服务器端口（默认：3000）

### 设置飞书机器人

1. 访问[飞书开放平台](https://open.feishu.cn/)
2. 创建新应用
3. 启用**机器人**能力
4. 配置权限（权限管理）：
   | 权限 | 说明 | API Scope |
   |------|------|-----------|
   | 获取与发送单聊、群组消息 | 获取和发送单聊、群组消息 | `im:message` |
   | 读取用户发给机器人的单聊消息 | 读取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` |
   | 以应用的身份发消息 | 以应用的身份发送消息 | `im:message:send_as_bot` |
5. 在**事件与回调**部分开启**长连接**
6. 订阅事件：`im.message.receive_v1` ([接收消息 v2.0](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive))
7. 开启消息卡片回调：`card.action.trigger`（用于处理卡片上的交互按钮）
8. 获取凭证（App ID、App Secret）并发布应用

### 启动路由服务器

```bash
# 启动服务
remote-cli-router start

# 或使用 PM2 在生产环境运行
pm2 start remote-cli-router --name router -- start
```

### 使用 Docker Compose 部署（共享 Router 推荐）

共享 Router 服务器推荐使用 Docker，这样可以隔离 Node.js 和 Router 依赖。普通客户端不建议使用 Docker，因为客户端需要直接访问本机项目文件，以及本机安装的 Claude Code、AGY、Codex、OpenCode、Kimi Code CLI、ZCode 或 Pi。

```bash
# 在仓库根目录执行
docker compose build

# 可选：在配置前选择宿主机和容器使用的端口
cp .env.example .env
# 如果 3000 已被占用，请编辑 .env 设置 ROUTER_PORT。
# Linux 还需要把 ROUTER_UID 和 ROUTER_GID 设置为 id -u 与 id -g 的结果。

# 由当前用户创建 bind mount 目录
mkdir -p router-data

# 交互式配置飞书凭证，并保存到 ./router-data
docker compose run --rm router config setup

# 后台启动 Router
docker compose up -d
```

配置和绑定关系会保存到 `./router-data`，因此重建容器后仍然保留。Compose 使用 `ROUTER_UID` 和 `ROUTER_GID` 运行容器；它们必须与 `./router-data` 的所有者一致，才能避免 bind mount 权限错误。`ROUTER_PORT` 同时控制宿主机端口和 Router 容器端口，必须与配置向导中填写的端口一致。查看 Router 日志：`docker compose logs -f router`；停止服务：`docker compose down`。只应向可信内网开放配置的端口，公网部署时应放在 HTTPS 反向代理之后。

### Nginx 配置（生产环境）

如果使用域名和 HTTPS，需要配置 Nginx 反向代理：

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

### 客户端连接地址说明

客户端初始化时需要指定路由服务器地址，根据部署方式不同：

| 部署方式 | 服务器地址示例 | 说明 |
|---------|--------------|------|
| **本地/内网部署** | `http://127.0.0.1:3000` | 路由服务器和客户端在同一台机器 |
| **局域网部署** | `http://192.168.1.100:3000` | 使用内网 IP + 端口 |
| **公网部署** | `https://your-domain.com` | 使用域名，需配置 HTTPS |

**初始化示例：**

```bash
# 本地部署
remote-cli init --server http://127.0.0.1:3000

# 局域网部署
remote-cli init --server http://192.168.1.100:3000

# 公网部署
remote-cli init --server https://your-domain.com
```

## 安装

### 从 npm 安装（推荐）

```bash
npm install -g @yu_robotics/remote-cli
```

或使用 yarn：

```bash
yarn global add @yu_robotics/remote-cli
```

### 从源码安装

```bash
# 克隆仓库（请替换为实际的仓库地址）
git clone <repository-url>
cd remote-cli

# 安装依赖
npm install

# 构建所有包
npm run build

# 全局链接 CLI
cd packages/cli
npm link
```

## 使用方法

### 1. 初始化

生成唯一的设备 ID 和绑定码：

```bash
remote-cli init --server https://your-router-server.com
```

示例输出：
```
✔ Initializing remote CLI...
✔ Device ID: dev_darwin_a1b2c3d4e5f6
✔ Binding code: ABC-123-XYZ

请在飞书中绑定设备：
1. 打开飞书，找到机器人
2. 发送：/bind ABC-123-XYZ
3. 等待确认

绑定码将在 5 分钟后过期。
```

### 2. 在飞书中绑定设备

打开飞书应用，向机器人发送绑定码：

```
/bind ABC-123-XYZ
```

### 3. 配置安全设置

添加允许 Claude Code 操作的目录：

```bash
# 添加单个目录
remote-cli config add-dir ~/projects

# 添加多个目录
remote-cli config add-dir ~/work ~/code/company-repos

# 查看当前配置
remote-cli config show
```

### 4. 启动服务

```bash
remote-cli start
```

### 5. 查看状态

```bash
remote-cli status
```

### 6. 停止服务

```bash
remote-cli stop
```

## 快捷命令

连接后，在飞书中可以使用以下命令：

### 核心管理命令

| 命令 | 说明 |
|---------|-------------|
| `/help` | 显示帮助信息 |
| `/status` | 显示 backend、模型、思考等级、队列和线程状态 |
| `/context` | 显示当前会话上下文和队列诊断信息 |
| `/skills` | 列出当前 backend 可用的 skills |
| `/abort` | 中止当前线程正在运行的 AI 任务 |
| `/queue` | 查看或管理线程中已确认的排队消息 |
| `/clear` | 清除当前线程的对话上下文 |
| `/new` | `/clear` 的别名；在当前线程中开始全新对话 |
| `/compact` | 压缩对话历史以节省 Token |
| `/model [name]` | 列出当前 backend 的模型，或设置当前线程的模型 |
| `/effort [auto|level]` | 查看或设置 Codex/AGY/OpenCode/Kimi/ZCode/Pi 的线程思考等级 |
| `/cd <dir>` | 切换当前线程的工作目录 |
| `/backend` | 列出后端并显示当前线程实际使用的后端 |
| `/bind <码>` | 绑定新设备 |
| `/unbind` | 解绑所有设备 |
| `/device` | 列出及切换绑定的设备 |

### 多会话（Thread）管理

支持同时开启多个会话，互不干扰。

| 命令 | 说明 |
|---------|-------------|
| `/thread list` | 列出所有会话线程及其状态 |
| `/thread new [名]` | 创建一个新的会话线程 |
| `/thread delete <名>`| 删除指定的空闲线程 |

*提示：直接回复某个线程发出的卡片消息，即可在该线程中继续对话。*

### Backend 切换

Backend 选择同时支持全局模式和按线程模式：

| 命令 | 说明 |
|---------|-------------|
| `/backend` | 列出已安装的后端，并显示当前线程实际使用的后端 |
| `/backend <index>` | 将所有线程切换到指定后端，并清除各线程的独立覆盖设置 |
| `/backend <index> @` | 只将当前线程切换到指定后端 |
| `/backend default @` | 清除当前线程的覆盖设置，恢复跟随全局后端 |

Backend index 使用 `/backend` 显示的顺序（安装后通常为 Claude Code、Codex CLI、OpenCode CLI、Kimi Code CLI、ZCode、Pi、AGY CLI）。按线程选择会持久化到 `threads.json`。不同线程可以使用不同后端并行执行。受影响的线程正在执行时不会执行后端切换；任意线程正在执行时也不会执行全局切换。切换后端会保留各后端的会话数据，因此切回某个后端时可以恢复其之前的会话。

### 命令队列

每个 thread 同时只执行一条命令，因为 Claude Code、AGY、Codex、OpenCode、Kimi Code、ZCode 和 Pi 的会话都按顺序处理。如果在线程忙碌时发送普通消息，remote-cli 会先发送飞书确认卡片，不会直接入队。只有点击 **Add to queue** 后消息才会入队；点击 **Cancel** 或确认超时都会丢弃消息。

With a CLI and Router that support queue-start notifications, confirming a message keeps a static queue receipt. When the task actually starts, a new execution card appears at the bottom of the chat with its thread, working directory, task preview, and remaining queue count. Progress and results stay on that new card, and the old receipt points to it. Older clients retain the waiting-card behavior. Queued work remains in memory; this does not make queues persistent across service restarts.

`/queue` 会列出正在执行和等待中的队列。`/queue clear` 清除当前 thread 中已确认和等待确认的消息。`/abort` 会中止当前任务并清空该 thread 的队列。在 abort 清理尚未结束时发送的新消息会等待清理完成，然后正常开始执行，不会跟随旧任务一起被丢弃。thread 忙碌时不允许切换 backend 或修改执行上下文；成功切换 backend 后会清除受影响的队列。`/thread list` 和 `/thread new` 不受 thread 忙碌状态影响，因为它们不触碰该 thread 的执行上下文，所以即使 default thread 正在运行，卡片上的 **+ New** 按钮也能正常创建新 thread。当前任务结束后，即使它因模型容量等 backend 错误而失败，也会开始执行第一条已确认的排队消息。如果从队列中取出的任务失败，该 thread 的剩余队列会暂停；可以使用 `/queue continue` 继续，或使用 `/abort` 丢弃剩余消息。队列只保存在内存中，服务重启后会丢失。

New messages cannot bypass confirmed work already waiting in a thread queue, even when the executor is idle. They require queue confirmation and join behind the existing work. If a queued task fails, its error card explicitly reports that the remaining queue is paused, with confirmed and awaiting-confirmation counts. Use `/queue continue` to resume in order, or `/queue clear` to discard pending work. A failure with nothing left waiting does not pause future messages. Queue positions count confirmed waiting messages, excluding the running task; the confirmation card shows the count before the new message is added.

### Code Change Previews

Code edits use one collapsible preview per file, with the file path and added/deleted line counts in the header. Deleted lines are explicitly red and added lines green through Feishu rich text, independent of native `diff` syntax highlighting. A copyable diff preview preserves original spaces, tabs, and code characters; rich-text indentation is for display only.

Previews retain three lines of context around each change. Display budgets are shared across files and hunks, with explicit notices for omitted lines, hunks, or files. A diff-only tool result is displayed even without a text message. Codex file-change events retain file boundaries, and ACP old/new text is compared so unchanged lines are not presented as replacements. Snippet-relative line numbers and Write content previews are labeled; Write does not imply a new file when its previous contents are unavailable.

This changes display only. It does not merge tool calls with their results or alter backend execution. The Router upgrade enables the new previews for existing diff data; upgrading the CLI also preserves file names in Codex multi-file changes. Pi and AGY edit payload mappings are unchanged.

### Background Task Notifications

Claude Code and Codex can send a standalone task card when a background task finishes, even after the original reply has completed. Both use the same completed, failed, and stopped card styles, show the originating thread, and let you reply to the card to continue that thread. Foreground commands stay in their original response; duplicate completion events do not create duplicate Codex task cards.

Codex watches native command completion events and sub-agent terminal states. Command cards include the command, exit code when available, and an output excerpt; sub-agent cards use the reported result. It does not run another model turn to generate these cards. Native command notifications were verified with Codex 0.154.0; sub-agent event availability depends on the installed Codex version. Tracking lasts for the current executor process: clearing a conversation, switching its backend, or restarting/disconnecting the Codex process discards its watchers. This does not add durable background-task recovery or change AGY support.

### 图片输入

可以直接向飞书机器人发送单独的图片，也可以发送同时包含文字和图片的富文本消息。remote-cli 会下载图片资源，并将文字与图片一起转发给当前的 Claude Persistent、Codex App Server、OpenCode ACP、Kimi Code ACP、ZCode app-server 或 Pi RPC 后端。AGY 当前只接受文本，不会处理图片附件。普通文件附件暂不支持。

Codex App Server 生成的图片也会转发回飞书。Codex 通过 app-server 协议返回生成图片，CLI 将图片发送给 Router，Router 上传到飞书，并在原有的 Card 2.0 响应中显示。该功能需要 CLI 和 Router 都升级到支持图片转发的版本。只升级 Router 是兼容的，但旧 CLI 不会生成或发送图片事件；只升级 CLI 也不会破坏兼容性，但旧 Router 会忽略可选的图片流消息，仍然显示文本响应。

所有 backend 也可以发送任务期间生成的本地图片，只要工具结果或最终回复中包含图片路径或 Markdown 图片链接，例如 `chart.png` 或 `![chart](./chart.png)`。文件必须位于允许的工作目录内，且不超过 2 MiB。CLI 会读取文件并复用同一条图片流，Router 上传到飞书并将其显示在当前 Card 2.0 回复卡片中。这个路径回退机制适用于图表和截图，不要求 backend 发出原生图片事件。

### 模型与思考等级

`/model` 和 `/effort` 作用于当前线程，并且会按 backend 分别保存：

| 命令 | 说明 |
|---------|-------------|
| `/model` | 显示当前 backend、已选模型和可用模型 |
| `/model <name>` | 为当前线程和当前 backend 设置模型 |
| `/effort` | 显示当前思考等级以及 backend 支持的等级 |
| `/effort <auto|level>` | 设置思考等级，使用 `auto` 清除线程覆盖值 |

模型列表由各 backend 分别提供：Claude Code 使用 `claude --print /model`，AGY 使用 `agy models`，Codex app-server 使用当前账号可用的模型目录，OpenCode 和 Kimi Code 使用 ACP 会话配置选项，ZCode 使用官方 app-server 模型目录，Pi 使用 RPC `get_available_models`。当前 Codex、AGY、OpenCode、Kimi Code、ZCode 和 Pi 支持 reasoning effort；Claude Code 会返回暂不支持。`auto` 会清除当前线程的覆盖值，恢复当前模型或 backend 的默认思考等级。

### 远程机器管理（Machine）

通过 `remote-cli` 代理控制远程服务器或 Docker。

| 命令 | 说明 |
|---------|-------------|
| `/machines` | 列出已配置的所有远程机器 |
| `/machine add` | 添加远程机器 (SSH) |
| `/containers <ID>`| 列出指定机器上的 Docker 容器 |
| `/search <ID> <路径>`| 在远程机器/容器中搜索文件 |
| `/view <ID> <路径>` | 查看远程文件内容 |
| `/replace <ID> <路径>`| 替换远程文件（自动备份） |
| `/backups <ID>` | 查看文件备份记录 |
| `/restore <ID>` | 从备份恢复文件 |
| `/proxy set/show` | 配置全局访问代理 |

### AI CLI 命令透传

remote-cli 自身不处理的斜杠命令会转发给当前 AI 后端，各后端支持程度不同：

- **Claude Code**：完整透传（`claude <cmd> --print`）——所有 commands/skills 指令可用，例如 `/commit`、`/review`、`/test`
- **AGY CLI (Antigravity)**：仅透传 agy 本地应答的只读信息类命令（`agy -p "<cmd>"`）：`/skills`、`/usage`、`/config`、`/changelog`、`/agents`、`/permissions`、`/hooks`、`/credits`。其他命令（包括 `/compact`——agy 在非交互模式下不会拦截它）会被拒绝并提示原因
- **Codex CLI (OpenAI)**：不透传——remote-cli 使用 app-server API，而不是交互式 TUI 的斜杠命令层，因此后端专属斜杠命令会被拒绝
- **OpenCode CLI** 和 **Kimi Code CLI**：斜杠命令通过各自的持久化 ACP 会话发送；`/model`、`/effort`、`/compact` 和 `/abort` 等通用命令仍由 remote-cli 自身处理
- **ZCode**：斜杠命令使用持久化的官方 app-server 会话；remote-cli 会把 `/skills` 映射为 ZCode 的 `/skill`，并直接处理 `/model`、`/effort`、`/compact` 和 `/abort`
- **Pi**：RPC `get_commands` 返回的扩展命令、提示模板和 `/skill:name` 技能通过持久化的 `pi --mode rpc` 会话发送；`/skills` 用于列出 Pi 技能。仅限 TUI 的内建命令会被拒绝。`/model`、`/effort`、`/compact` 和 `/abort` 仍由 remote-cli 自身处理

内建命令（`/help`、`/status`、`/context`、`/skills`、`/clear`、`/new`、`/compact`、`/model`、`/cd`、`/thread`、`/backend`、`/abort`）可用于所有后端。`/new` 是 `/clear` 的完全别名：它会保留当前 remote-cli thread、工作目录、backend、模型和思考等级设置，同时启动一个全新的 backend 对话。`/effort` 可按线程设置 Codex、AGY、OpenCode、Kimi Code、ZCode 和 Pi 的思考等级；Claude Code 暂未实现。
`/context` 可用于所有后端，会显示当前会话、模型、工作目录和队列状态。Pi 还会显示官方 RPC 返回的会话 Token 总计和当前上下文窗口用量；其他后端无法提供精确用量时，仍会显示传输层未提供该信息的提示。`/skills` 在 Claude、AGY、OpenCode 和 Kimi Code 上使用原生信息命令，在 ZCode 上映射为原生 `/skill` 命令，在 Pi 上通过 RPC 列出技能；Codex 则扫描 `.agents/skills` 和 `~/.codex/skills` 下的本地 `SKILL.md` 文件。

### 示例工作流程

1. **绑定新设备：**
   ```
   /bind ABC-123-XYZ
   ```

2. **查看设备状态：**
   ```
   /status
   ```

3. **切换到指定设备：**
   ```
   /device switch dev_darwin_a1b2c3d4
   ```
   或使用序号快速切换：
   ```
   /device 1
   ```

4. **让 AI 帮忙：**
   ```
   审查 src/auth.ts 中的认证代码并提出改进建议
   ```

5. **使用 Claude Code 内置命令：**
   ```
   /commit
   ```

## 进阶用法

### 用 thread 隔离不同工作目标

建议为不同项目、故障或目标分别创建 thread，避免把无关任务混在同一个上下文中：

```text
/thread new api-debug
/cd ~/workspace/api
/thread new docs
/cd ~/workspace/docs
```

直接回复某张已经完成的飞书卡片，消息会继续路由到该卡片所属的 thread。Thread 按钮会同时显示各 thread 工作目录的最后一级名称和所用 backend，便于区分并行 workspace。自动生成的 `thread-2` 等名称会在按钮上只显示序号，例如 `2`，自定义名称保持不变。长回复被拆分成多张卡片时，每张续卡都会重复显示 thread 和工作目录头部。`/thread list` 可以查看所有 thread 的状态，`/status` 可以快速查看当前 backend、模型、工作目录和队列。

Long streaming replies refresh only cards with changed content. Queued tasks combine incoming text while a refresh is pending, so card updates do not build up a backlog of intermediate text. Tool results, images, and the final response retain their order.

Card splitting also counts tables embedded in Markdown and nested components, with a conservative budget of three tables per card. Large Markdown blocks split at table boundaries; excess tables inside indivisible containers remain readable as code text. If Feishu still rejects a card with a table-limit error, the Router retries that card once as text and preserves text mode for later updates. Other cards retain their normal formatting. This applies to every backend and requires Router 1.6.53 or newer.

Claude Code streams text into response cards as it is generated. Completed content blocks do not repeat text that has already streamed, and tool cards continue to use complete tool calls.

线程切换面板的两行说明文字使用 emoji 和加粗关键词、正文大小的字体：`📍 Reply from:` 显示回复所属线程的完整名称和工作目录，`🗂️ Switch thread` 标记切换区域。在 `Switch thread` 下方，对勾（`✓`）和主色按钮样式标识出卡片 finalize 或点击后新的顶层消息将发往的线程。已选中的按钮仍可点击。切换只更新被点击的卡片；其他历史卡片保留各自最后显示的选择状态。

### 组合使用全局和按线程 backend

当所有 thread 都要切换时使用 `/backend <index>`；只有当前 thread 需要特殊 backend 时使用 `/backend <index> @`：

```text
/backend
/backend 2 @
/backend default @
```

不带 `@` 的形式会修改全局 backend，并清除各 thread 的独立覆盖。带 `@` 的形式只创建或修改当前 thread 的覆盖。例如，一个 thread 可以使用 Codex 修改仓库，另一个 thread 同时使用 Claude Code 做审查。不同 thread 可以并行执行，但单个 thread 内部仍然按顺序执行。

### 把队列当作显式交接机制

thread 忙碌时，普通消息会先生成确认卡片，不会静默进入队列。只有确认消息确实属于这个 thread 时，才点击加入队列。确认后卡片会变成“已加入”或“已取消”状态，重复点击会被忽略。使用 `/queue` 查看待确认和已确认消息，使用 `/queue clear` 清除它们，使用 `/abort` 中止当前任务并清空该 thread 的队列。

为了避免上下文混乱，建议等当前任务和队列都处理完后，再发送 `/model`、`/effort`、`/cd`、`/compact`、`/clear` 或 `/new` 等会改变执行上下文的命令。这些命令不会排在普通消息后面执行。

### 有意识地选择模型和思考等级

在比较不同 backend 时，可以将模型和思考等级限制在当前 thread：

```text
/model
/model <name>
/effort
/effort medium
/effort auto
```

Codex、AGY、OpenCode、Kimi Code、ZCode 和 Pi 提供原生 effort 控制。Claude Code 自身支持 thinking 和 effort，但 remote-cli 内建的 `/effort` 目前会提示 Claude 暂不支持。不同 backend 的模型列表和 effort 等级可能不同，切换后可以用 `/status` 或 `/context` 确认实际状态。

## 资深用法

### 为团队维护一个共享 Router

推荐的团队拓扑是一台内网服务器运行 Router，每位开发者在自己的机器上运行一个客户端：

```text
飞书 <-> Router（Docker Compose）<-> 各开发者本地 CLI 客户端
```

Router 的飞书配置和设备绑定关系保存在持久化的 `./router-data` 目录中。客户端则在本机保留项目文件、backend 会话，以及 Claude Code/AGY/Codex/OpenCode/Kimi Code/ZCode/Pi 的安装和登录状态。除非你明确挂载所有项目目录和 backend 凭证，否则不要把客户端放进 Docker。

更新 Compose 部署且不丢失绑定关系：

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 router
```

日常更新不要使用 `docker compose down -v`。升级前建议备份 `./router-data`，并且只向可信内网开放 Router 端口。

### 保留或主动重置 backend 会话

每个 thread 都分别保存 Claude、AGY、Codex、OpenCode、Kimi Code、ZCode 和 Pi 的会话状态。切换 backend 不会删除之前 backend 的会话，因此可以切回并继续之前的上下文。需要全新上下文时使用 `/clear` 或其别名 `/new`；希望某个 thread 重新跟随全局 backend 时使用 `/backend default @`。

### 系统化排查远程任务

任务看起来卡住时，建议按以下顺序排查：

1. 使用 `/status` 确认当前 thread、backend、工作目录和运行状态。
2. 使用 `/context` 查看会话和队列详情。
3. 使用 `/queue` 区分已经确认的消息和仍在等待卡片确认的消息。
4. 只有确定要中止当前任务并丢弃该 thread 队列时，才使用 `/abort`。
5. 在 Router 服务器上查看 `docker compose logs -f router` 或对应的服务管理器日志。

这样可以区分 backend 执行问题、Router 路由问题、旧卡片状态问题，以及消息根本没有确认入队的情况。

## 安全机制

### 工作目录选择

只有显式添加到白名单的目录才能被选为会话工作目录：

```bash
remote-cli config add-dir ~/safe/directory
```

### 执行信任模型

remote-cli 不再安装全局 Claude Code `PreToolUse` hook，也不会对 AI 后端进程提供沙箱。后端进程会继承运行 remote-cli 的操作系统用户权限，因此可能访问所选工作目录之外的路径。如需更强隔离，请使用专用操作系统账户运行 remote-cli，或将其部署在容器或虚拟机中。

### 设备认证

- 每台设备基于机器硬件生成**唯一 ID**
- 绑定码**5 分钟后过期**
- 每个用户只能控制**自己绑定的设备**
- 随时解绑：在飞书中发送 `/unbind`

## 常见已知行为

### 安全过滤推理块 (Claude 3.7 Sonnet)

当你使用 Claude 3.7 Sonnet 时，偶尔会看到如下消息：
`💭 部分推理过程已被安全系统过滤`

这是正常现象，说明 Claude 的内部推理触发了安全过滤机制。加密的推理内容会被完整保留以维持会话上下文的连贯性，不影响响应质量。Claude 4 及更高版本的模型通常不会出现此提示。

## 常见问题

### 服务无法启动

```bash
# 检查是否已在运行
remote-cli status

# 查看日志
remote-cli logs

# 重启
remote-cli stop
remote-cli start
```

### 连接问题

```bash
# 检查网络
ping your-router-server.com

# 验证配置
remote-cli config show

# 重新初始化
remote-cli init --server https://your-router-server.com --force
```

### 绑定码过期

```bash
# 生成新的绑定码
remote-cli init --force
```

## 贡献指南

我们欢迎贡献！请查看 [CONTRIBUTING.md](CONTRIBUTING.md) 了解指南。

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。

---

## 附录

### 配置参考

#### 本地客户端配置（`~/.remote-cli/config.json`）

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

- `executor.type`: 全局默认后端。可选值 `auto`（Claude Persistent）、`claude-persistent`、`agy`、`codex`、`opencode`、`kimi`、`zcode`、`pi`。按线程的覆盖设置通过 `/backend <index> @` 管理。
- `executor.agy`: 
    - `model`: 模型 slug，取自 `agy models` 列表（如 `gemini-3.8-flash-low`）。不填则用 agy 默认模型。无效 slug 会被 agy 拒绝并返回明确错误。
    - `autoApprove`: 是否通过 `--dangerously-skip-permissions` 自动同意工具权限（默认 true）。
    - `command`: agy 二进制命令（默认 `agy`）。
- `executor.opencode`:
    - `model`: `/model` 显示的 provider/model 标识。不填则使用 OpenCode 会话默认值。
    - `autoApprove`: 是否自动选择 ACP 工具权限请求中的第一个允许选项（默认 true）；设为 false 时通过移动端输入流程转发请求。
    - `command`: OpenCode 二进制命令（默认 `opencode`）。
- `executor.kimi`:
    - `model`: `/model` 显示的模型别名。不填则使用 Kimi Code 会话默认值。
    - `autoApprove`: 是否自动选择 ACP 工具权限请求中的第一个允许选项（默认 true）；设为 false 时通过移动端输入流程转发请求。
    - `command`: Kimi Code 二进制命令（默认 `kimi`）。
- `executor.zcode`:
    - `model`: 已登录 ZCode 模型目录中提供的模型 ID。不填则使用 ZCode 会话默认模型。
    - `autoApprove`: 以 `yolo` 模式运行 ZCode 会话并自动批准工具权限（默认 true）。设为 false 时使用 `build` 模式，并通过移动端输入流程转发权限请求。模型提问和计划审批始终转发给用户。
    - `command`: 官方 `zcode` 命令或内置 `zcode.cjs` 路径。不填时，remote-cli 会检查 `PATH` 和 ZCode 桌面应用的标准安装路径。
- `executor.pi`:
    - `model`: `/model` 返回的 `provider/id` 或裸模型 ID。不填则使用 Pi 会话默认模型。
    - `provider`: 当 `model` 是裸 ID 时的可选 provider（例如 `google`）。
    - `autoApprove`: 向 Pi 传递 `--approve`，让非交互 RPC 进程信任项目本地资源（默认 true）。设为 false 时传递 `--no-approve`。Pi 扩展 UI 对话框始终通过移动端输入流程转发。
    - `command`: Pi 可执行文件（默认 `pi`）。
- `executor.codex`:
    - `model`: Codex turn 使用的模型。不填则使用 codex 默认模型。可以在飞书中使用 `/model` 查询当前账号可用的模型。
    - `autoApprove`: 使用 `approvalPolicy: never` 和完全访问权限（默认 true）。设为 false 时，app-server 的审批请求会通过现有移动端输入流程转发。
    - `command`: codex 二进制命令（默认 `codex`）。

加载 remote-cli 1.6.30 或更早版本的配置时，`executor.type: claude-spawn` 会自动迁移为 `claude-persistent`，已移除的 `executor.codex.transport` 字段会被丢弃。Codex 始终使用 app-server。

#### 使用 AGY CLI（Antigravity）

```bash
# 1. 安装并认证（会打开浏览器进行 Google OAuth 登录）
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy  # 首次启动会引导登录

# 2. 切换后端（也可通过飞书 /backend 指令切换）
remote-cli config set executor.type agy

# 3. 可选：指定模型（用 agy models 查看有效 slug 列表）
remote-cli config set executor.agy.model gemini-3.8-flash-low
```

#### 使用 OpenCode CLI

```bash
# 1. 安装并认证
npm install --global @opencode/cli
opencode auth login

# 2. 切换后端（也可以在飞书中使用 /backend 命令）
remote-cli config set executor.type opencode

# 3. 可选：从 /model 返回的列表中指定 provider/model
remote-cli config set executor.opencode.model opencode/nemotron-3.5-lightning-free
```

OpenCode 后端为每个活跃 thread 运行一个持久化的 `opencode acp` 进程，并在消息、后端切换和服务重启后恢复 ACP session id。`/model` 和 `/effort` 使用 ACP 会话选项，`/compact` 使用 OpenCode 原生命令，`/abort` 发送 ACP 取消请求，图片消息作为 ACP 图片内容发送。`autoApprove: true` 时会选择第一个工具权限允许选项；设为 `false` 时通过移动端输入流程转发。模型提问始终转发给用户，可回复选项名称或序号。

#### 使用 Kimi Code CLI

```bash
# 1. 安装并认证
npm install --global @moonshot-ai/kimi-code
kimi login

# 2. 切换后端（也可以在飞书中使用 /backend 命令）
remote-cli config set executor.type kimi

# 3. 登录后可选择模型
# 在飞书中使用 /model 查看当前账号的模型目录。
```

Kimi Code 后端为每个活跃 thread 运行一个持久化的 `kimi acp` 进程。可恢复的 session 指针保存在 `~/.remote-cli/kimi-sessions/`，图片输入通过 ACP 发送，`/effort` 映射到 Kimi 的 `thinking` 会话选项，原生斜杠命令通过 ACP 转发，`/abort` 使用 ACP 取消。即使工具权限自动批准，模型提问也始终通过移动端输入流程转发。切换到该后端前需先运行 `kimi login`。

#### 使用 ZCode

```bash
# 1. 安装官方 ZCode 桌面应用或 CLI，然后完成登录
# https://zcode.z.ai/en/docs/install
zcode login

# 2. 切换后端（也可以在飞书中使用 /backend 命令）
remote-cli config set executor.type zcode

# 3. 登录后可选择模型
# 在飞书中使用 /model 查看当前账号的模型目录。
```

ZCode 后端直接连接官方 `zcode app-server --stdio` 协议，不安装也不运行 ACP 代理。它会自动查找 `PATH` 中的 `zcode`，以及桌面应用标准安装路径内置的 `zcode.cjs`。可恢复的 session 指针保存在 `~/.remote-cli/zcode-sessions/`。该后端支持 `/model`、`/effort`、`/compact`、`/abort`、图片输入、原生斜杠命令、工具事件、权限确认、模型提问和计划审批。跨后端的 `/skills` 会映射为 ZCode 原生 `/skill` 命令。

remote-cli 直接启动内置 `zcode.cjs` 时，需要使用 Node.js 22 或更高版本，因为当前官方 CLI 使用了 `node:sqlite`。ZCode Start Plan 的认证依赖桌面端验证码流程，headless app-server 客户端无法完成；remote-cli 应使用已认证的 GLM Coding Plan 或 API Key provider。app-server 协议由 ZCode 自身提供，但目前还不是公开的兼容性规范，因此未来升级 ZCode 后可能需要同步更新适配层。

#### 使用 Pi

```bash
# 1. 安装并登录（首次启动会打开 provider 登录）
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi  # 在交互式 TUI 中完成 provider 登录

# 2. 切换后端（也可以在飞书中使用 /backend 命令）
remote-cli config set executor.type pi

# 3. 可选：指定 /model 中的 provider/model
remote-cli config set executor.pi.model google/gemini-3-flash
```

当前 Pi 包要求 Node.js 22.19.0 或更高版本。Pi 后端为每个活跃 thread 运行一个持久化的 `pi --mode rpc` 进程。会话文件保存在 `~/.remote-cli/pi-sessions/`，避免占用交互式 `~/.pi` 会话。`/model` 使用 RPC 的 `get_available_models` / `set_model`，`/effort` 映射到 Pi 的 thinking 等级（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`），`/compact` 使用原生 RPC 压缩，`/abort` 发送 RPC `abort`，`/context` 使用 RPC `get_session_stats`，图片消息作为 Pi 图片内容发送。provider 自动重试时会显示进度，但不会把提示混入最终模型回答。由于 Pi 会把工作目录写入会话头，切换工作目录时会启动新的 Pi 会话。`autoApprove: true` 通过官方 `--approve` 参数信任项目本地资源；扩展 UI 对话框仍会转发给用户，并能显示兼容的结构化选择项中的标签与说明。切换到该后端前需先用交互式 `pi` 完成登录。

#### 使用 Codex CLI（OpenAI）

```bash
# 1. 安装并登录
npm install -g @openai/codex
codex login

# 2. 切换后端（也可以在飞书中使用 /backend 命令）
remote-cli config set executor.type codex

# 3. 可选：指定模型
remote-cli config set executor.codex.model gpt-5.2-codex
```

Codex 后端为每个活跃的 remote-cli thread 运行一个持久化的
`codex app-server` 进程。通过恢复已持久化的 Codex thread id，在消息之间、
工作目录变更、后端切换和服务重启后保持会话连续性。`/model` 查询 app-server
模型目录，`/compact` 使用原生 thread 压缩，`/abort` 中断当前 turn，图片消息也会
作为 Codex 图片输入发送。

Codex app-server 是唯一支持的 Codex transport。启动时会自动迁移旧的 `codex exec` 配置。
启动时还会通过 `codex app-server --help` 检查已安装 Codex CLI 的能力；如果版本过旧，会显示升级命令。

### 开发

Run `npm ci` from the repository root after pulling dependency changes, before building or publishing either workspace. `npm publish` runs build and test checks but does not install missing dependencies.

```bash
# 克隆仓库（请替换为实际的仓库地址）
git clone <repository-url>
cd remote-cli

# Install locked workspace dependencies
npm ci

# 构建所有包
npm run build

# 运行测试
npm test

# 以开发模式运行 CLI
npm run cli:dev

# 以开发模式运行路由服务器
npm run router:dev
```

### 支持

- 问题反馈：请通过项目的 Issue 页面提交
- 讨论交流：请通过项目的 Discussion 页面参与

## 更新日志

详细版本记录和用户可见变更请查看 [CHANGELOG.md](CHANGELOG.md)。
