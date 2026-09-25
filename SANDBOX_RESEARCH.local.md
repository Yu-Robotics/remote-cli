# 各 AI 后端沙箱机制调研(remote-cli 可用性分析)

> 调研日期:2026-09-25(当日晚间补充 Claude 实测验证)
> 状态:本地研究笔记,不入库
> 背景:remote-cli 当前安全模型 = DirectoryGuard(应用层目录白名单)+ 设备认证,backend 进程本身不沙箱化(CLAUDE.md 明确 "backend processes are not sandboxed")。本调研回答:各后端有没有沙箱机制,能不能利用起来?
>
> **2026-09-25 晚更新:Codex 沙箱已落地(ed1bb14,含批准卡片),Claude 方案已在真机端到端验证可行,见附录 A。**

## TL;DR

**能利用。** Codex 和 Claude Code 的 OS 级沙箱已成熟,可直接接入;AGY 有沙箱但带已知坑;OpenCode/Kimi 只有规则级权限;Pi/ZCode 基本没有,需外部容器兜底。

| 后端 | OS 级沙箱 | 机制 | remote-cli 现状 |
|---|---|---|---|
| Codex | ✅ 最完善 | Seatbelt (macOS) / Bubblewrap+Landlock+seccomp (Linux) / DACL (Windows) | **已接入(ed1bb14)**:`CodexSandbox` + `/sandbox` 命令 + 批准卡片 |
| Claude Code | ✅ 完善(2025.11 引入) | sandbox-runtime:Seatbelt (macOS) / Bubblewrap+socat (Linux);文件系统+网络双隔离 | **已实测验证可行**,见附录 A |
| AGY | ⚠️ 有但有坑 | `--sandbox` + `proceed-in-sandbox` 权限预设 | 默认 `autoApprove=true` 传 `--dangerously-skip-permissions`,**恰好触发沙箱失效 bug** |
| OpenCode | ❌ 无 OS 级 | 规则级权限:allow/ask/deny 按工具/路径/命令模式 | 已在转发权限请求 |
| Kimi Code | ❌ 无 OS 级 | ACP 权限流,配置级 | 同上 |
| ZCode | ❌ 未见 | 未找到公开沙箱文档 | — |
| Pi | ❌ 官方明确没有 | 官方建议外部隔离:Gondolin micro-VM / Docker / OpenShell | — |

---

## 1. Codex CLI(最成熟,改动最小)

### 机制

- **三个独立开关**(不是一个总开关):
  - `sandbox_mode` (-s):`read-only` / `workspace-write` / `danger-full-access`
  - `approval_policy` (-a):`untrusted` / `on-request` / `never`
  - `sandbox_workspace_write.network_access`:true/false,**默认关网**
- OS 强制:macOS Seatbelt(`sandbox-exec` + SBPL profile);Linux Bubblewrap 管线 + Landlock(文件系统)+ seccomp(系统调用/网络过滤);Windows Restricted Tokens + DACL
- `workspace-write` 下 `.git/`、`.agents/`、`.codex/` 仍保持只读保护
- 环境变量标记:子进程里设 `CODEX_SANDBOX_NETWORK_DISABLED`、`CODEX_SANDBOX=seatbelt`
- 注意:macOS Seatbelt 不支持嵌套——外层再包一层 sandbox 会把 Codex 自己的沙箱打挂

### remote-cli 接入点

app-server 协议的 `sandboxPolicy` 是我们自己传参(`CodexAppServerExecutor.ts:167`),当前:

```typescript
sandboxPolicy: { type: 'dangerFullAccess' }   // 无沙箱
```

改为:

```typescript
sandboxPolicy: {
  type: 'workspaceWrite',
  networkAccess: false,               // 做成配置项;远程跑 npm install/git push 需要开
  writableRoots: [thread working dir] // 直接复用 DirectoryGuard 的目录白名单!
}
```

**关键洞察**:approval_policy 和 sandbox 是独立开关——保持 `never` 批准(手机远程没法点确认),由沙箱兜底安全。沙箱替代弹窗成为控制机制,这正是远程场景需要的形态。

建议配置:`executor.codex.sandbox: 'workspace-write' | 'read-only' | 'danger-full-access'`,默认值从裸奔改为 `workspace-write`。

---

## 2. Claude Code(完善,注入即可用)

### 机制

- 基于 Anthropic 开源的 **sandbox-runtime**(GitHub: anthropics/sandbox-runtime)
- macOS:Seatbelt(系统自带,零安装);Linux/WSL2:需要 `bubblewrap` + `socat` 两个包;Windows 原生不支持(走 WSL2)
- **只裹 Bash/PowerShell/Monitor 类命令及其子进程**;Read/Edit/MCP/hooks 仍在宿主机跑
- 默认策略:写限制在工作目录 + 会话 $TMPDIR;读较宽(可用 `sandbox.credentials` 屏蔽 SSH 密钥/.env/AWS 配置等,v2.1.187+);网络走 socat 代理 + 域名白名单,**默认零域名预放行**
- `auto-allow` 模式:沙箱内命令不再弹确认(官方称减少 ~84% 权限弹窗)——远程场景必开
- 关键设置项:
  - `sandbox.enabled` — 总开关
  - `sandbox.mode` — `auto-allow` / `regular`
  - `sandbox.allowUnsandboxedCommands` — 关掉 `dangerouslyDisableSandbox` 逃逸口
  - `sandbox.failIfUnavailable` — bwrap 缺失时硬失败而非降级(v2.1.216+)
  - `sandbox.network.allowedDomains` / `strictAllowlist` / `allowManagedDomainsOnly`
  - `sandbox.excludedCommands` — 永远不走沙箱的命令(如 `docker *`)
  - `sandbox.credentials` + `mask` 模式(v2.1.199+)— 凭据文件遮蔽

### remote-cli 接入点

官方支持非交互注入,加在 ClaudePersistentExecutor 的启动参数里:

```bash
claude --settings '{"sandbox": {"enabled": true, "allowUnsandboxedCommands": false}}'
```

注意事项:
- Linux 上需检测 `bwrap`/`socat` 是否安装,缺失时警告(或配合 `failIfUnavailable`)
- `--dangerously-skip-permissions` 与沙箱可共存:前者管"不弹窗",后者在 spawn 时由 OS 强制
- 域名白名单在远程场景的语义:新域名默认弹确认——手机上没法点,需要预配置 `allowedDomains` 或接受断网跑

建议配置:`executor.claude.sandbox: true` 时注入 `--settings`。

---

## 3. AGY(Antigravity)——有沙箱,但有致命组合坑

### 机制

- `--sandbox` CLI flag:启用终端沙箱(会话级)
- `settings.json`(`~/.gemini/antigravity-cli/settings.json`):
  - `enableTerminalSandbox`(默认 false)
  - `allowNonWorkspaceAccess`(默认 false)
  - `permissions.allow` / `permissions.deny` 列表,语法如 `command(git)`、`read_file(/path)`、`command(rm -rf)`
- 权限预设四档:`request-review`(默认)/ `proceed-in-sandbox` / `always-proceed` / `strict`
- IDE 侧还有独立的 "Sandbox Network Access" 网络开关

### ⚠️ 已知坑(直接影响 remote-cli)

**GitHub issue #36:`--sandbox` 与 `--dangerously-skip-permissions` 同用时,沙箱被静默失效**——agent 可通过 `bypassSandbox: true` 绕过,而该请求会被 auto-approve。

remote-cli 的 AgyExecutor 默认 `autoApprove=true` → 恰好传了 `--dangerously-skip-permissions` → 如果直接加 `--sandbox`,**会得到一个假的安全感**。

### 接入方式

开沙箱时必须:`autoApprove=false` + 权限预设 `proceed-in-sandbox`(沙箱内自动执行,不弹窗)。
建议:配置 `executor.agy.sandbox: true` 时强制覆盖 autoApprove 并打警告。allow/deny 列表可映射 DirectoryGuard 目录。

---

## 4. OpenCode / Kimi Code —— 只有规则级权限

### OpenCode

- 权限系统:`allow` / `ask` / `deny` 规则,按工具(bash/edit/read/webfetch)和路径/命令模式匹配
- **无 OS 级沙箱**,规则不阻止进程内的任意文件访问,只是工具调用层的拦截
- remote-cli 已在 ACP 层转发其权限请求(autoApprove 或手机确认)

接入方式:预置 opencode 配置的 deny/ask 规则(如工作目录外写操作 deny)。弱于 OS 级,但有胜于无。

### Kimi Code

- ACP 权限流与 OpenCode 类似;配置文件级权限
- 未找到 OS 级沙箱

### ZCode

- 未找到公开沙箱/权限文档,按"无"处理

---

## 5. Pi —— 官方明确没有,文档指外部隔离

- 官方:无内建权限系统,进程以启动用户权限裸跑
- 官方文档(containerization.md)推荐的隔离方式:
  - **Gondolin 扩展**:pi 和认证留在宿主机,工具调用路由进本地 Linux micro-VM
  - **Docker**:整个 pi 进程跑容器里
  - **OpenShell**:策略控制的沙箱
- 可选扩展(`packages/coding-agent/examples/extensions/sandbox/`):用 `@anthropic-ai/sandbox-runtime`(seatbelt/bubblewrap),`pi -e ./sandbox` 启用
- remote-cli 现状:`--approve` / `--no-approve` 只是项目信任 flag,不是沙箱

接入方式:文档化 Docker 运行方式;或评估 sandbox-runtime 扩展的成熟度。

---

## 6. 后端无关的兜底方案

**Anthropic 的 sandbox-runtime 是独立开源包**(bubblewrap/seatbelt 封装),理论上可以裹住任何后端进程(agy/pi/opencode 整个进程)。Pi 官方扩展就是这么干的。这为所有无沙箱后端提供了统一选项。

**Docker 容器**是所有后端的终极兜底,代价是开发环境隔离带来的便利性问题(依赖、凭据、SSH 都要映射进去)。

---

## 7. 建议落地顺序

1. **Codex**(改动最小收益最大):`executor.codex.sandbox` 配置项,默认从 `dangerFullAccess` 改为 `workspace-write`,`writableRoots` 复用 DirectoryGuard
2. **Claude**:`executor.claude.sandbox: true` 时注入 `--settings`;启动检测 bwrap/socat
3. **AGY**:开沙箱时强制 `autoApprove=false` + `proceed-in-sandbox`,警告 #36
4. **OpenCode/Kimi**:预置 allow/deny 规则(规则级,弱于 OS 级)
5. **Pi/ZCode**:文档化 Docker 运行方式

## 参考来源

- [Claude Code Sandboxing 官方文档](https://code.claude.com/docs/en/sandboxing)
- [Claude Code 沙箱安全分层分析(2026)](https://bartlomiejkrupa.dev/articles/claude-code-security-sandboxing-2026/)
- [Simon Willison: Codex 沙箱实现分析](https://simonwillison.net/2025/Nov/9/codex-sandbox-investigation/)
- [Codex 沙箱 internals:Seatbelt/Bubblewrap/Landlock/Windows DACL](https://codex.danielvaughan.com/2026/05/03/codex-cli-sandbox-internals-seatbelt-bubblewrap-landlock-windows-dacl/)
- [Codex/Claude/Gemini 沙箱与批准模式对比](https://inventivehq.com/blog/ai-coding-cli-sandbox-approval-modes-compared)
- [AGY 权限官方文档](https://antigravity.google/docs/permissions/)
- [AGY issue #36:sandbox 被 skip-permissions 静默失效](https://github.com/google-antigravity/antigravity-cli/issues/36)
- [OpenCode 权限文档](https://open-code.ai/en/docs/permissions)
- [Pi 仓库(含 containerization.md)](https://github.com/earendil-works/pi)
- [agy-sbx-kit:AGY 的 Docker 沙箱套件](https://github.com/shelajev/agy-sbx-kit)
- [InfoQ:Anthropic 为 Claude Code 引入沙箱](https://www.infoq.com/news/2025/11/anthropic-claude-code-sandbox/)

---

## 附录 A:Claude 沙箱 + 批准卡片 —— 真机端到端验证(2026-09-25 晚)

在 S600(Ubuntu noble,arm64,bwrap 0.9.0 + socat 1.8.0,claude 2.1.276)上用 stream-json 双向模式实测:

### 验证结论:✅ 完全可行,交互模型与 Codex 版对齐

**探针 1(只开沙箱,无审批宿主)**:两条命令全部被拒(含工作区内写入)。
原因:当时 socat 未安装 → 沙箱不可用 → `allowUnsandboxedCommands:false` 堵死降级通道 → 全部拒绝。
**这是正确的 fail-closed 行为。**

**探针 2(裸 stream-json,无沙箱无 skip-permissions)**:写操作直接 `permission_denied`,**没有 control_request 发出**。
关键发现:CLI 二进制字符串证实部分 control_request 子类型 "host-forwarded-only; SSE is its only ingress" ——
stdin 通道拿不到 can_use_tool。**正确的审批通道是 `--permission-prompt-tool`,且该工具必须是 MCP 工具。**

**探针 3(MCP 审批通道)**:内嵌 stdio MCP server 暴露 `approval_prompt` 工具 +
`--permission-prompt-tool mcp__perm__approval_prompt`:
- 写操作触发 MCP 调用,参数为 `{tool_name: "Bash", input: {command, description}, tool_use_id}`
- 返回 `{"behavior":"allow","updatedInput":...}` → 命令执行;返回 `{"behavior":"deny","message":...}` → 拒绝且 Claude 能看到原因

**探针 4(沙箱 + MCP 审批组合,装好 socat 后)——完整复刻 Codex 交互模型:**
- 工作区内写入:**静默执行**,OS 沙箱强制,零审批调用
- 工作区外写入:bubblewrap 拦截(`Read-only file system`)→ Claude 走逃逸口重试 → **触发 MCP 审批** → 拒绝 → 文件未创建

### 对 remote-cli 的实现映射(对照 Codex 版)

| Codex 版组件 | Claude 版对应 |
|---|---|
| `CodexSandbox.ts`(每线程配置+持久化) | `ClaudeSandbox.ts`,大部分逻辑(校验/标准化/原子写)可复用 |
| `turnOptions` → app-server `sandboxPolicy`(每轮级) | spawn 参数 `--settings '{"sandbox":{...}}'`(**进程级**,改配置需回收进程,复用 `/model` 的既有回收模式) |
| app-server approval request 事件 | 内嵌 stdio MCP server + `--permission-prompt-tool`;收到调用即发 `onApprovalRequest` |
| Router `ApprovalCards`(批准卡片) | **直接复用,后端无关** |
| `/sandbox` 命令 | 同一命令,executor 分发即可 |

### 差异与限制(诚实清单)

1. **沙箱只裹 Bash 系命令**(Bash/PowerShell/Monitor);Write/Edit 是进程内操作不走 OS 沙箱——但它们会走 MCP 审批流,UX 一致
2. Linux 依赖 `bubblewrap` + `socat`,缺一则沙箱静默失效(有 stderr 警告;可配 `failIfUnavailable` 硬失败)
3. 沙箱配置是进程级(Codex 是每轮级),`/sandbox` 改配置要回收 claude 进程
4. 必须去掉 `--dangerously-skip-permissions`,否则审批通道永远不触发
5. 网络域名白名单的提示是否也走同一 MCP 审批通道——待验证(推测是)
6. `sandbox.credentials` 的凭据遮蔽(mask 模式)对无人值守远程场景很有价值,建议一并开启
