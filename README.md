# Remote CLI - 通过飞书远程控制 Claude Code / Gemini CLI

[![npm version](https://img.shields.io/npm/v/@yu_robotics/remote-cli.svg)](https://www.npmjs.com/package/@yu_robotics/remote-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

通过飞书（Lark）消息从手机上远程控制你的 Claude Code 或 Gemini CLI。即使不在电脑前，也能继续编程。

[English Documentation](README_EN.md)

## 功能特性

- 🌍 **远程控制**：通过手机随时随地控制本地开发环境
- 🔒 **安全可靠**：目录白名单、命令过滤、设备认证三重保护
- 📱 **移动优化**：为飞书定制的简化命令和富文本格式
- 🤖 **多后端支持**：支持 Claude Code（默认）和 Gemini CLI，可随时切换
- ⚡ **持久进程**：通过 stdio 双向流保持 AI 进程长期运行
- 🚀 **简单 setup**：一键安装和初始化

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

整个过程你只需要在手机上发一条消息，Claude Code 或 Gemini CLI 在你的电脑上自主完成排查、修复、验证全流程。

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
        │                   │  Claude Code / Gemini CLI    │
        ▼                   │  (本地 AI 后端)               │
┌─────────────────┐         └──────────────────────────────┘
│   路由服务器     │
│  (团队部署)      │         ┌──────────────────────────────┐
│  ┌───────────┐  │         │      开发者 B 的工作电脑        │
│  │ Webhook   │  │         │  ┌─────────────────────────┐ │
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

# 现在将绑定码发送给飞书机器人
# 然后就可以用手机开始编程了！
```

## 环境要求

开始前，请确保你已安装：

- **Node.js** >= 18.0.0
- **npm** 或 **yarn** 包管理器
- **Claude Code CLI** 或 **Gemini CLI**（至少安装并配置其中一个）
- 可访问的**飞书机器人**（团队应部署一个路由服务器）

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

### 设备管理命令

| 命令 | 说明 |
|---------|-------------|
| `/bind <绑定码>` | 绑定新设备 |
| `/status` | 查看所有设备状态 |
| `/unbind` | 解绑所有设备 |
| `/device` | 列出你绑定的所有设备 |
| `/device list` | 列出你绑定的所有设备 |
| `/device switch <设备ID或序号>` | 切换到指定设备 |
| `/device <设备ID或序号>` | 快速切换到指定设备 |
| `/device unbind <设备ID或序号>` | 解绑指定设备 |
| `/backend` | 列出可用 AI 后端并进行切换 |
| `/help` | 显示帮助信息 |

### AI CLI 命令透传

本地 Claude Code 或 Gemini CLI 支持的所有 commands/skills 指令会直接透传执行，例如：
- `/commit` - 提交代码变更
- `/review` - 代码审查
- `/test` - 运行测试
- `/clear` - 清除当前会话
- 以及其他所有 Claude Code 内置命令

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

## 安全机制

### 目录白名单

只有显式添加到白名单的目录才能访问：

```bash
remote-cli config add-dir ~/safe/directory
```

### 命令过滤

危险命令会被自动拦截：
- `rm -rf /`
- 系统文件的 `sudo` 操作
- 直接磁盘写入（`dd`、`mkfs`）
- Fork 炸弹等恶意模式

### 设备认证

- 每台设备基于机器硬件生成**唯一 ID**
- 绑定码**5 分钟后过期**
- 每个用户只能控制**自己绑定的设备**
- 随时解绑：在飞书中发送 `/unbind`

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
  "deviceId": "dev_darwin_xxx",
  "serverUrl": "https://your-router-server.com",
  "openId": "ou_xxx",
  "security": {
    "allowedDirectories": [
      "/Users/yourname/projects",
      "/Users/yourname/work"
    ]
  },
  "executor": {
    "type": "gemini",
    "gemini": {
      "model": "gemini-2.5-pro",
      "autoApprove": true
    }
  },
  "service": {
    "running": true,
    "startedAt": 1234567890,
    "pid": 12345
  }
}
```

`executor.type` 可选值：`auto`（默认，Claude）、`claude-persistent`、`claude-spawn`、`gemini`。

#### 使用 Gemini CLI

```bash
# 1. 安装并认证 Gemini CLI
npx @google/gemini-cli auth login

# 2. 切换到 Gemini 后端
remote-cli config set executor.type gemini

# 3. 可选：指定模型
remote-cli config set executor.gemini.model gemini-2.5-pro

# 4. 正常启动
remote-cli start
```

### 开发

```bash
# 克隆仓库（请替换为实际的仓库地址）
git clone <repository-url>
cd remote-cli

# 安装依赖
npm install

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
