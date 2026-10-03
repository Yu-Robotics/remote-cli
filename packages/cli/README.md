# @yu_robotics/remote-cli

Remote control Claude Code, AGY CLI, Codex CLI, OpenCode CLI, Kimi Code CLI, ZCode, or Pi from anywhere using your mobile phone through Feishu (Lark) messaging.

## Features

- **Remote Control**: Control your local development environment from anywhere via mobile
- **Access Controls**: Working-directory allowlist and user-device binding
- **Mobile-Optimized**: Simplified commands and rich text formatting for Feishu
- **Readable Code Changes**: Edit operations show collapsible, line-aware diff previews inside the existing progress card
- **Multi-Backend Support**: Supports Claude Code, AGY CLI (Antigravity), Codex CLI (OpenAI), OpenCode CLI, Kimi Code CLI, ZCode, and Pi
- **Image Input and Output**: Forward Feishu images to supported backends and return Codex native image output. All backends can return local images through file paths or Markdown image links; files must be inside an allowed directory and no larger than 2 MiB. AGY does not accept image input.
- **Multi-session (Threads)**: Create independent chat threads to parallelize tasks
- **Remote Machine Management**: Control remote servers or Docker via SSH
- **Persistent Process**: Long-running AI process with bidirectional streaming
- **Automatic Updates**: Install the newer Router's exact version when idle. Manual clients keep running and use the update on their next start; supervised non-interactive clients exit for an immediate restart.
- **Task Recovery**: With a compatible Router, running tasks resume output on a usable surviving card or a new card with an output-gap notice. Recovery retries use bounded backoff; disconnected output is not buffered or replayed, even after recovery is paused.

Router 1.6.117 and newer explicitly label standalone background-task notifications **Background task**. The status, originating thread name (or thread ID when no name is provided), and abbreviated task ID remain visible, while **View details** is collapsed by default and contains the rich Markdown result and optional output path. Failed tasks also show a short, literal failure summary outside the panel. This changes only the Router presentation: the CLI protocol, foreground replies, delegated-worker cards, and reply-to-thread routing remain unchanged.

## Prerequisites

- **Node.js** >= 18.0.0
- **Claude Code CLI**, **AGY CLI**, **Codex CLI**, **OpenCode CLI**, **Kimi Code CLI**, **ZCode**, or **Pi** installed and configured
- Access to a Feishu (Lark) bot connected to a [remote-cli-router](https://www.npmjs.com/package/@yu_robotics/remote-cli-router) server

The client is normally installed and run directly on the developer's machine rather than in Docker, so it can access local project directories and the installed AI CLI binaries. Docker is recommended for the shared Router server instead.

## Installation

Sending local image files requires a Router with image forwarding support and
the bot application's `im:resource` permission. Router 1.6.85 and newer render
local and URL-based Markdown image references as captions; the uploaded image
is rendered separately using its Feishu image key. Code examples are preserved.
Router 1.6.89 also handles images inside Markdown lists and quoted containers
without mistaking ordinary indentation for code.

Router 1.6.90 also handles tool events with missing or incompatible parameters
using a bounded summary, or a no-parameters placeholder when input is missing.
Subsequent output continues normally. This display fix requires only a Router
upgrade and works with older CLIs without changing backend execution.

Router 1.6.91 retries confirmed Markdown parse errors (`11311`) once with the
affected card's Markdown shown as literal code text. It retains that format
for later updates and thread-button refreshes; other cards keep their normal
formatting. This requires only a Router upgrade and works with older CLIs.

Router 1.6.92 waits for a successful recovery-notice update before acknowledging
reuse of a surviving card. Failed updates can retry within the same recovery
round without duplicating the notice. Router update-failure logs identify the
affected card and Feishu error codes without logging the card body. This works
with older recovery-capable CLIs and requires only a Router upgrade.

```bash
npm install -g @yu_robotics/remote-cli
```

## Quick Start

### 1. Initialize

```bash
remote-cli init --server https://your-router-server.com
```

### 2. Bind Device in Feishu

Send the binding code to the Feishu bot:

```
/bind ABC-123-XYZ
```

### 3. Configure Allowed Directories

```bash
remote-cli config add-dir ~/projects ~/work
```

### 4. Start the Service

```bash
remote-cli start
```

### 5. Send Commands via Feishu

```
Help me fix TypeScript errors in ~/projects/my-app
```

Manual starts automatically install updates when tasks and queues are idle, without exiting the running client. Updates take effect on the next start. Use `remote-cli service install` for automatic startup and supervised restarts after updates. If the Router rejects the running protocol, restart the manual client after installation to reconnect. See [Automatic Client Startup](../../README.md#automatic-client-startup) for update behavior and recovery.

From CLI 1.6.119, Linux and macOS startup append deterministic backend installation directories to the inherited `PATH`, preserving existing executable and Node precedence. Valid old systemd units and LaunchAgents need only a restarted upgraded client, not reinstallation; broken Node or CLI startup paths still require repair. Later installs into covered directories are visible to a fresh `/backend`, with up to 30 seconds of delegation discovery caching. Custom locations use `executor.<backend>.command`, preferably an absolute real executable; ZCode preserves native unset/empty-command discovery. No shell profiles, runtime-version scans, or new version-manager shim directories are used. See [Backend Executable Discovery](../../README.md#backend-executable-discovery).

## Commands

| Command | Description |
|---------|-------------|
| `remote-cli init -s <url>` | Initialize and generate binding code |
| `remote-cli start` | Start the background service |
| `remote-cli stop` | Stop the service |
| `remote-cli status` | Check service status |
| `remote-cli service install` | Install automatic startup for macOS or Linux |
| `remote-cli service start` | Start an installed user-level service |
| `remote-cli service stop` | Stop it without removing automatic startup |
| `remote-cli service uninstall` | Remove automatic startup |
| `remote-cli service status` | Check the user-level startup service |
| `remote-cli config show` | View configuration |
| `remote-cli config add-dir <path>` | Add allowed directory |

Linux users upgrading from version 1.6.23 or earlier should run `remote-cli service install` again to regenerate the systemd unit with corrected path escaping.

## Feishu Bot Commands

### Core Management

| Command | Description |
|---------|-------------|
| `/help` | Show help information |
| `/status` | Show backend, model, effort, delegation, queue, and thread status |
| `/context` | Show current session context and queue diagnostics |
| `/skills` | List available skills for the active backend |
| `/abort` | Abort executing task in current thread |
| `/queue` | Inspect or manage confirmed messages waiting in thread queues |
| `/clear` | Clear context for this thread |
| `/new` | Alias for `/clear`; start a fresh conversation in this thread |
| `/compact` | Compress history to save tokens |
| `/cd <dir>` | Change directory; a different directory starts fresh conversations for this thread |
| `/model [name]` | List models for the active backend or set this thread's model |
| `/effort [auto|level]` | Show or set Codex/AGY/OpenCode/Kimi/ZCode/Pi reasoning effort |
| `/sandbox [on/off/read-only/default]` | Configure the current Codex or Claude Code thread sandbox, directory grants, and networking |
| `/backend` | List backends and show the current thread's effective backend |
| `/delegation [on|off]` | Inspect or enable delegation between installed agent backends in this thread |
| `/backend <index>` | Switch all threads and clear per-thread backend overrides |
| `/backend <index> @` | Switch only the current thread |
| `/backend default @` | Clear the current thread override and follow the global backend |
| `/bind <code>` | Bind a new device |
| `/unbind` | Unbind all devices |
| `/device` | List and switch between bound devices |

### Threads & Machines

Use `/delegation on` in an existing thread to let its selected backend assign
bounded tasks to other installed, authenticated backends. Claude Code, Codex,
Pi, AGY, OpenCode, Kimi Code, and ZCode can coordinate or work. From CLI 1.6.95,
same-backend delegation is rejected before launching a worker; discovery marks
the current backend unavailable as a worker. Use the current backend directly
or its native subagents, if supported. Workers return results to the original conversation and use
its working directory; they do not create extra thread buttons. `/delegation`
shows discovery and restrictions; `/delegation off` disables the feature. The
setting is off by default and persists per thread. Start with one trial thread;
never-enabled threads skip managed tools, prompt changes, and delegation
configuration. Turning it off cleans only backends used for delegation, including
when resumed after a CLI restart or a backend switch, while preserving their
conversations.

`/status` shows `Delegation: on/off (current thread)` for the thread receiving
the command. Reading this setting does not initialize delegation or start workers.

From CLI 1.6.118, `/status` shows DSH's official recharge and bonus wallet balances when available. Native official-account sign-in is required; API-key-only or custom-provider setup does not supply these wallets. Amounts retain their native decimal precision and currency; balances are not token usage or plan quota. The query does not create or change an ACP conversation. Its owned process uses the same log-upload and telemetry suppression as the DSH executor, is stopped after the query, and omits the balance section on failure or timeout. No other backend or Router protocol changes are required.

CLI 1.6.94 and newer show each finished worker as a result block in the existing
reply card, with a colored status label, backend name, short task description,
and elapsed time. Failed, timed-out, cancelled, and interrupted tasks include a
bounded reason; the coordinator still receives the existing task result. This
uses the existing text stream and works with older Routers. It adds no probes,
cooldowns, retries, or changes to ordinary non-delegated sessions.

CLI 1.6.95 no longer aborts workers because their intermediate text or tool
results exceed a cumulative output threshold. Individual results remain bounded
to 32 KiB and combined result continuations to 64 KiB. Oversized result text
keeps its beginning and end with an explicit truncation marker and flag;
truncation does not change the task's success or failure status. These limits
bound retained delegation results, not backend output buffers. Worker timeouts,
cancellation, and cleanup still apply. This requires a local CLI upgrade and
works with existing Routers.

Child progress, approvals, and questions use the existing reply flow. `/abort`
stops managed children as well as the parent. While delegated results remain
missing from the active execution, the CLI suppresses coordinator prose/plans/images and displays
program-owned progress and real input prompts. An early coordinator return keeps
the request busy: the CLI waits, then resumes the same session with bounded
terminal results before draining the queue. Original requests and attachments
are not replayed. CLI 1.6.89 retains results until a coordinator execution succeeds.
Existing model recovery and automatic compaction can retry a result continuation
if that execution accepted no new worker launch. If it still fails, bounded
completed worker results appear as plain text alongside the failure; workers
are not restarted. This is not automatic recovery on a later request or across
disconnects/restarts. Abort and shutdown stop continuation and suppress this
failure-result fallback. A failed execution that launched a new worker is never
replayed automatically.

Workers follow the coordinator's
remote-cli sandbox policy: with no coordinator sandbox, `inherit` launches
unrestricted workers, ignoring separate target sandbox settings without changing
them. Research tasks should put no-write requirements in the objective instead
of enabling a sandbox. Other backend approval options retain their behavior.
Sandboxed coordinators have no eligible managed workers: same-backend delegation
is disabled and cross-backend sandbox translation remains unsupported. Saved
sandbox policies are not weakened. `read_only` remains recognized for
compatibility but is unavailable; discovery reports the rejection reason.
There is one
active child per parent and at most three per CLI process, with overlapping
workspaces serialized and bounded time/output. Workspace reservations apply to
delegation-enabled work; opted-out threads keep ordinary workspace access, so
use separate workspaces for independent writers. See
[Cross-backend Delegation](../../README.md#cross-backend-delegation) for limits,
recovery, context transfer, and permission behavior.

| Command | Description |
|---------|-------------|
| `/thread list/new/delete` | Manage session threads |
| `/machines` | List configured remote machines |
| `/machine add/remove/show` | Manage remote SSH machines |
| `/containers <ID>` | List Docker containers on a machine |
| `/search/view/replace` | Remote file operations |
| `/backups/restore` | Manage remote file backups |

### AI CLI Commands Passthrough

Backend-specific commands are forwarded only where the active backend supports them. The built-in `/status`, `/context`, and `/skills` commands provide a consistent remote view across backends. On Pi, `/context` includes official RPC session totals and current context-window usage, and automatic provider retries are shown as progress without changing the final model response.
- `/commit` - Commit code changes
- `/review` - Code review
- `/test` - Run tests
- And all other built-in AI engine commands

## Advanced Usage

Use one thread per project or task so each thread keeps its own working directory, backend session, model, and queue. Use `/backend <index>` for a global switch, or `/backend <index> @` to override only the current thread. `/backend default @` removes that override.

With CLI 1.6.93 or newer, `/cd` to a different normalized directory clears saved conversation bindings for every backend in that thread, including inactive ones. Returning to the old directory does not restore its previous conversation. Selecting the same directory preserves context; backend switching without a directory change still resumes conversations. Thread identity, model, effort, sandbox grants, delegation settings, and native history files remain intact. Separate plans should use separate threads, even when they share a directory. This change requires a CLI upgrade and works with existing Routers.

Thread switch panels show `Reply from:` with the reply's full thread name and workspace. Under `Switch thread`, a check mark (`✓`) and primary button styling identify the destination of new top-level messages when the card is finalized or clicked. Selected buttons remain clickable. Switching updates only the clicked card; other historical cards retain their last displayed selection.

With a CLI and Router that support queue-start notifications, confirming a message keeps a static queue receipt. When the task actually starts, a new execution card appears at the bottom of the chat with its thread, working directory, task preview, and remaining queue count. Progress and results stay on that new card, and the old receipt points to it. Older clients retain the waiting-card behavior. Queued work remains in memory; this does not make queues persistent across service restarts.

When a thread is busy, ordinary messages require confirmation before they enter its queue. Use `/queue` to inspect pending work, `/queue clear` to discard queued messages, and `/abort` to stop the active task and clear that thread's queue. A message received during abort cleanup waits and starts after the backend is safe to reuse. A backend failure in the active task still advances to the first confirmed queued message; a failure in a task taken from the queue pauses the remaining queue. Context-changing commands such as `/model`, `/effort`, `/cd`, `/compact`, `/clear`, and its `/new` alias are handled separately rather than queued as ordinary messages. Feishu thread buttons show automatic names such as `thread-2` as their sequence number, such as `2`; routing continues to use the full internal name. Continuation cards repeat the thread and working-directory header of the original card.

## Expert Usage

For a shared deployment, run the Router with Docker Compose on an internal server and run one CLI client on each developer machine. Keep project directories and Claude Code, AGY, Codex, OpenCode, Kimi Code, ZCode, or Pi credentials on the client machine; the Router persists its configuration and bindings in `./router-data`. On Linux, create that directory as the deployment user and set `ROUTER_UID` and `ROUTER_GID` in `.env` to `id -u` and `id -g` so the container can write to the bind mount.

To update a Router deployment without losing bindings:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 router
```

When diagnosing a task, check `/status`, then `/context`, then `/queue`. Use `/abort` only when you intend to discard the active task and queued messages.

## Security

Codex and Claude Code permission requests use interactive cards when both CLI and Router support them. Choose Allow once, Deny, or (for explicit directory grants) Always allow. Buttons stay bound to the original request and are invalidated when it finishes. Pending approvals get new cards after reconnecting; older routers and card delivery failures retain text replies.

When the Router reports that an approval card could not be delivered, CLI 1.6.88 and newer show the requested action in a code block above the text reply instructions. This also applies to delegated worker approval requests, which never offer persistent grants.

Codex supports an opt-in native sandbox through `/sandbox on`, `/sandbox read-only`, and `/sandbox off`. Use `/sandbox allow <directory>` to save extra writable directories for the current thread, `remove <directory>` to revoke them, and `network on|off` to control networking. The workspace-write default allows cross-project reads, networking, and writes to the current project, dedicated temporary/download directories, and common package caches. Grants survive conversation resets and backend switches. See [Codex sandbox configuration](../../README.md#optional-codex-sandbox) for boundaries, approval choices, and configuration defaults. Other backends retain their existing behavior.

Claude Code also supports opt-in `/sandbox` policies. Workspace-write mode automatically permits ordinary file edits inside the workspace and explicitly authorized writable directories through a process-scoped native hook. Real file destinations are checked, and native deny/ask rules remain effective. Outside writes, protected files, and all read-only-mode file modifications still require approval. Startup verifies the hook before sending a task and fails if native hook restrictions prevent it from running. Missing Linux dependencies (`bubblewrap` and `socat` on `PATH`) stop execution instead of falling back to full access. Permission cards use text replies (`yes` / `no`, or a request ID when several approvals are pending) if cards are unavailable. Pending approvals expire when the task ends or the process stops. Sandboxed commands can access network domains without per-domain approval by default; `/sandbox network on` restores this behavior while preserving filesystem isolation, native domain deny rules, and administrator-managed restrictions. Previously saved network-off settings remain disabled until explicitly changed. `/sandbox network off` overrides saved domain allowlists for sandboxed commands; it does not block Claude API traffic or in-process web tools. See [Claude sandbox configuration](../../README.md#optional-claude-code-sandbox).

- **Directory whitelisting**: Controls which working directory a thread can select; it is not a process sandbox
- **Backend permissions**: AI processes inherit the operating-system user's permissions. remote-cli does not install a global Claude security hook or automatically filter backend shell commands.
- **Device authentication**: Each device has a unique hardware-based ID
- **Binding codes**: Expire after 5 minutes

## Documentation

For full documentation including router server deployment, see the [project README](https://github.com/Yu-Robotics/remote-cli#readme).

## License

MIT

## Changelog

See the project [CHANGELOG.md](../../CHANGELOG.md) for release notes and user-visible changes.
