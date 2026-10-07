# @yu_robotics/remote-cli-router

Router server for [remote-cli](https://www.npmjs.com/package/@yu_robotics/remote-cli) — manages message forwarding between Feishu (Lark) and local CLI clients via WebSocket.

Backend executable discovery is local-client behavior. CLI 1.6.119 supplements Linux/macOS startup PATH and honors configured backend commands across detection and execution, preserving ZCode's native unset/empty-command lookup. Upgrade and restart the client to obtain this fix; upgrading only the Router does not repair an older client's environment. Valid client services need no reinstallation. The Router runtime, wire protocol, and existing compatibility requirements are unchanged. See [Backend Executable Discovery](../../README.md#backend-executable-discovery).

## Public Activity

From Router 1.6.145, a foreground tool result updates its original collapsed tool row rather than adding a second disclosure. Input, output, and per-file diff previews remain inside; later text and worker slots stay stable. Unknown IDs and orphan results are not guessed into another call. Existing CLI peers are compatible, and worker cards and approvals are unchanged. See [Code Change Previews](../../README.md#code-change-previews).

CLI and Router 1.6.144 negotiate optional `activityProgress` without a protocol
version bump. One mutable status row sits at the tail of the newest active main
card, after tools and workers, and moves when the reply paginates. Historical
pages do not retain a live Running row. Each worker shows its own bounded activity
below its identity. Input requests and final results win over progress; completion
preserves the terminal status, model/effort note, and thread controls. Raw thinking
is not displayed as activity and progress is not a percentage. Older clients keep
their existing cards. See [Public Activity](../../README.md#public-activity).

## Maintenance Notices

From CLI and Router 1.6.127, upgrade notices use concise Chinese summaries from `RELEASE_NOTES_ZH.md`, with one short title and bounded user-visible changes per release. `CHANGELOG.md` remains the English technical record. The CLI build requires matching current-version entries in both documents and bundles both, without online translation or model calls. New Routers show summaries directly and collapse technical details. Earlier maintenance-capable Routers show the summary in their existing collapsed panels; new Routers keep older CLI notes collapsed when no technical-details field is present. Cumulative ranges, silent first adoption, delivery acknowledgements, and protocol version 1 are unchanged.

From CLI and Router 1.6.128, upgrade cards group changes by stable feature tags across each device's full pending version range, not just the current detail page. Exact duplicate items are removed within a feature; distinct changes remain available in paged version records. Feature tags are stripped from display Markdown and never shown to users. The overview is bounded to 6 KiB, six features, and 12 items, with explicit omission counts; all bundled summaries and technical records remain in collapsed version details. Older metadata or insufficient overview space falls back to the existing per-version display. The optional overview preserves protocol version 1 and old-peer behavior, without model calls or changes to first adoption, notification progress, or acknowledgements.

CLI and Router 1.6.134 consolidate the available 1.6.90-1.6.133 release records and confirmed source history into one stage summary. Upgrade notices for devices with an existing notification baseline show that complete summary, not an exact per-device subset; some changes may have been delivered before. The old version sections in this range are no longer bundled or available through package-backed detail paging, but remain in Git history. Earlier changelog records are unchanged, first adoption stays silent, and subsequent releases resume normal incremental entries. From 1.6.134, each release may contain one to six summary bullets within the unchanged 2 KiB budget. This release changes release documents, package versions, and summary validation only; backend execution and Router behavior are unchanged.

Router and CLI 1.6.123 negotiate optional upgrade-notice and subscription-inspection capabilities without changing protocol version 1 or old-client traffic. Upgrade cards show cumulative bundled release-note ranges; first feature adoption is silent. The Router resolves the original device owner and acknowledges only after successful delivery and a private durable receipt. Receipt retention is 30 days and 1,000 entries; deduplication cannot guarantee exactly-once delivery across a Feishu-success/storage-write crash. View more requests the same bundled range from the connected compatible CLI, without external changelog fetches or persistent paging sessions.

Codex inspection and account state belong to the local CLI, not the Router. Its experimental native login API may change; unavailable inspection does not affect messaging. Subscription reminders are independent, notification-only cards, never user-thread output or routing controls. Backend-specific copy is selected by an optional backend identifier; legacy messages without it retain Codex handling, and unsupported identifiers are rejected. Codex explains possible reset-countdown drift and tells the user to send a normal task to start the next usage window, without verification steps. Its 100% weekly availability is a snapshot from the qualifying checks, not a live balance, confirmation that a reset occurred, or a guarantee about when a usage window starts. New reminder cards have no buttons; validated legacy Dismiss callbacks remain passive. There is no Send Hi button or automatic activation, and reminder actions never send model requests. Older peers remain usable. See [Maintenance Notices](../../README.md#maintenance-notices) for first-start, offline, privacy, and opt-out behavior.

From Router 1.6.125, quota reminder cards use the title **🎯 Codex Reset** and summary **Weekly quota reset: 100%**, without the sampling-disclaimer footer. From Router 1.6.126, new quota cards have no buttons; validated legacy Dismiss callbacks remain passive. Normal-task guidance and inspection criteria are unchanged.

From CLI 1.6.126, acknowledged quota-reminder suppression survives upgrades and restarts in a private local ledger under `~/.remote-cli/subscription-reminders/`, scoped to the Router and device. It stores only hashed account/bucket fingerprints, not tokens, raw account identifiers, credential metadata, reset timestamps, or quota observations. Credential refreshes do not clear suppression; only a valid non-candidate observation rearms that account. Missing/failed probes retain suppression. Sampling baselines remain in memory. Accepted acknowledgement writes finish before graceful shutdown; corrupt, unsafe, or unavailable storage pauses quota inspection and reminder delivery without erasing the ledger or affecting normal messaging.

Deduplication is not exactly once: a crash between card delivery and local acknowledgement persistence can still produce a duplicate. Earlier clients retain process-only suppression, and their delivery history cannot be recovered on first adoption of the ledger; one additional qualifying reminder is possible. The Router presentation change alone does not give an older CLI restart-safe suppression.

## Overview

The router server acts as a bridge between Feishu messaging and developer machines running the remote-cli client. It handles:

- **User-device binding** via Feishu bot commands
- **Message routing** between Feishu and connected CLI clients
- **Code-change rendering** with collapsible, line-aware diff previews inside streaming cards
- **Image message forwarding** for Feishu images to supported backends, plus Codex native image output and local image files returned by any backend
- **Client service management** is handled by the local CLI; the Router remains a separate long-running server process
- **Queued task cards** appear at execution time for capable clients, with the thread, workspace, task preview, and remaining queue count; older clients retain waiting cards
- **Delegated task progress** uses the existing reply and approval cards. With a supporting local CLI, Claude Code, Codex, Pi, AGY, OpenCode, Kimi Code, ZCode, and DSH can work within the selected thread; the Router does not run or select workers. From CLI 1.6.142, managed delegation accepts any eligible installed backend, including the coordinator backend through independent worker sessions. An unrestricted coordinator launches unrestricted workers; sandboxed coordinators have no eligible workers, including on the same backend, until scope-aware worker sandbox preservation is supported. Native backend task/subagent tools are unchanged. Other backend approval options still apply. This policy is enforced on the local CLI and requires upgrading it; the wire protocol remains unchanged. See [Cross-backend Delegation](../../README.md#cross-backend-delegation).
- **WebSocket connections** from local clients
- **Feishu long connection** for receiving and sending messages
- **Task recovery** with compatible clients: resume output on a usable surviving card or create a new one, with an independent gap notice and plain-text handling of resumed fragments; failed card creation or recovery-notice updates are not acknowledged as successful recovery
- **Table-aware card splitting** and a single text fallback retry for a card rejected by Feishu's table limit or Markdown parser

Router 1.6.91 extends the text fallback to confirmed Markdown parse errors
(`11311`). It retries the affected card once with Markdown shown as literal code
text, and retains that format for later updates and thread-button refreshes.
Other cards keep their normal formatting. Older CLIs remain compatible;
this fallback requires only a Router upgrade.

Router 1.6.92 requires successful recovery-notice delivery before acknowledging
reuse of a surviving card. A failed update can retry within the same recovery
round without duplicating the notice. Update-failure logs identify the root
reply, affected card ID and number, and Feishu error and trace codes without
logging the card body. Older recovery-capable CLIs remain compatible.

Router 1.6.90 checks tool parameters before using specialized card formatting.
Missing or incompatible fields fall back to a bounded parameter summary;
missing input shows a no-parameters placeholder. Later tool events and task
completion continue normally. Older CLIs remain compatible; backend execution
and the wire protocol are unchanged.

Supporting CLIs enforce delegated task completion locally: they suppress stale
coordinator prose while results are missing from the active execution and keep the parent request busy
until those results have reached the coordinator. Early returns trigger a
continuation in the same session, without replaying the original request or
attachments. The Router displays the existing task progress and reply events;
no new protocol capability is required for this completion barrier.

From CLI 1.6.129, one request may accept multiple independent delegated tasks
before collecting results, executing them in FIFO order with one active worker.
Queued tasks are independently cancellable and have no started progress card.
Their bounded status notices use the existing text channel, not a new wire phase;
old Routers remain compatible and old CLIs keep their existing behavior. The
12-task cumulative limit and one-hour queue deadline are enforced locally.
Other overlapping requests are rejected rather than globally queued. This does
not add peer communication or modify native backends or Router execution.
Sibling results are not explicitly forwarded; a reused same-backend lane retains
its own earlier task context. Uncertain native startup or exit retains the occupied
global slot until the local CLI restarts.

From CLI 1.6.139, Git delegation has no fixed repository size or file-count
limits during snapshots, artifact collection, or checkout verification. Git
command deadlines and buffered-output limits still apply. Path, ownership,
artifact-integrity, and unknown-file checks remain in place. This is local CLI
behavior; upgrading only the Router does not remove an older CLI's limits.

From CLI 1.6.141, local initialized submodules and embedded repositories also
contribute staged, unstaged, and nonignored working files. Their Git metadata and
history are not copied into the worker; explicit integration preserves every
source HEAD, index, and gitlink. Uninitialized submodule paths stay empty without
fetching a remote. Worker-created nested repositories or changes to those empty
paths require manual recovery and explicit retention, even with unchanged files.
Nested worktrees sharing an ancestor, external metadata pointers, partial clones,
and nested-local filter commands require recovery or exclusion. System/global
Git configuration remains trusted; the existing Git transfer deadline still applies.
A hard kill can leave a transfer quarantine requiring manual cleanup after its
processes exit. Tracked submodules also matched by outer ignore rules currently
fail admission; reconcile those rules before delegating.

From CLI 1.6.140, managed Git preparation, repository-lock waits, and artifact
collection are awaited separately from native startup/stop deadlines. Slots and
source reservations remain held until owned operations settle, even on cancellation;
no late worker is launched. Failed collection after confirmed exit preserves only
the affected lane and files for recovery rather than quarantining the source.
Individual Git command deadlines remain; cancellation may wait for Git to settle.
Slow launch/cancel tools return the accepted task ID and a pending status before
the adapter timeout; poll that ID with `remote_cli_result`, not a new delegation.
The response does not claim cancellation cleanup or workspace release is complete.
Checkpoints reject `assume-unchanged` and `skip-worktree` entries rather than
omitting hidden edits or treating missing sparse files as deletions. Resolve those
flags and sparse checkouts explicitly; the source index is never modified.
These changes require a CLI upgrade; Router protocol and native backends are unchanged.

From CLI 1.6.135, the local CLI automatically reclaims verified successful
no-change or successfully applied worker checkout directories and recreates them
at their stable lane paths when needed. Conversation pointers and artifact refs
are retained. Unknown or unresolved files remain for manual recovery. Failed
checkout recreation preserves existing native context; full byte audits do not
hold other lanes' repository metadata admission guard. Router messages, native
backends, and non-Git FIFO execution are unchanged; older
CLIs retain their existing lifecycle even when connected to a newer Router.
The upgraded CLI also recognizes successful worker snapshot commits already in
delivery HEAD's ancestry. A later revert does not reopen historical delivery.
Inspection, ready-lane admission, and idle closure reconcile only that thread's
owned lanes; safe file-reclamation checks remain independent. This is local CLI
behavior, not a Router-side merge, content comparison, or new protocol requirement.
From CLI 1.6.136, the CLI checks durable artifact disposition before successful
coordinator completion and can resume the same session for at most two closeout
rounds. Missing, invalid, pending, or unretained recovery state fails the final
response if unresolved, with task IDs and available output commits, while preserving
artifacts. A deliberate retain settles the decision without claiming delivery.
The Router renders existing progress/error messages; no new protocol, automatic
merge, or old-request replay is introduced. Older CLIs keep their current behavior.

From CLI 1.6.138, already settled artifact receipts are validated without requiring
an idle source workspace; another busy thread does not reopen completed delivery.
Pending or unverifiable outcomes still require closeout, and history reconciliation
still requires the source lease. Reused Git lanes remain reusable after confirmed
failures before checkout preparation starts; uncertain checkout or executor setup
continues to preserve the lane for manual recovery.

From CLI and Router 1.6.137, finished Worker cards expose **Clear context**
outside folded details, including failed tasks that established a worker lane.
The button disconnects only that worker's native conversation continuation.
It keeps the coordinator, other workers, workspace files, artifacts, login, and
settings intact; archived native transcripts are not erased. The next delegation
starts fresh, with no automatic retry of the failed task.
Only the original user can operate the control on its original device. Running
workers, unconfirmed shutdowns, and stale cards after lane reuse are rejected.
**Context cleared** appears only after CLI acknowledgement; timeouts and failures
allow explicit retry. An interrupted clear stays non-resumable until a retry
finishes. From CLI 1.6.138, retrying an old shared-directory lane's clear after a
replacement has been created clears only the old continuation, without reviving
that lane or scheduling the replacement for deletion. Ambiguous duplicate lanes
are preserved for manual recovery; independent Git worker lanes remain reusable.
Controls require both peers to advertise `workerContextReset`; old
peers retain their existing behavior. Card controls expire on Router restart,
after 24 hours, or when their bounded cache is evicted; use a newer card or the
existing thread-scoped `/delegation reset [backend]` command when idle.

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

CLI 1.6.89 can compact/retry result continuations that launched no new workers.
Results remain retained until the coordinator execution succeeds. If its reply
still fails, bounded completed worker results appear as plain text alongside the
failure; no new wire capability is required. Abort/shutdown suppress this fallback.
It does not provide automatic recovery on a later request or guarantee delivery
across disconnects/restarts.

Router 1.6.117 and newer explicitly label standalone background-task notifications **Background task**. The status, originating thread name (or thread ID when no name is provided), and abbreviated task ID remain visible, while **View details** is collapsed by default and contains the rich Markdown result and optional output path. Failed tasks also show a short, literal failure summary outside the panel. This changes only the Router presentation: the CLI protocol, foreground replies, delegated-worker cards, and reply-to-thread routing remain unchanged.

## Prerequisites

Image uploads require the bot application's `im:resource` permission. Publish
permission changes in the Feishu developer console before retrying an upload.
Router 1.6.85 and newer render local and URL-based Markdown image references as
captions, with uploaded images in separate card image components. Code examples
and inline Feishu `img_` keys are preserved. Older CLIs remain compatible.
Router 1.6.89 also recognizes Markdown list and quote boundaries, so images
inside those containers are filtered while actual code examples stay unchanged.

- A server reachable by your local CLI clients, with outbound access to Feishu
- **Node.js** >= 18.0.0
- For public deployments, a **domain name** and TLS reverse proxy for client connections; internal deployments can use HTTP on a trusted network
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

Configure the bot's **Long Connection** event mode with `im.message.receive_v1` and `card.action.trigger`. The Router opens the connection to Feishu; no inbound Feishu webhook URL is required. Encrypt Key and Verification Token are retained in the configuration wizard but are not used by the current long-connection handler.

### 2. Start the Server

```bash
remote-cli-router start
```

### 3. Deploy with PM2 (Production)

```bash
pm2 start remote-cli-router --name router -- start
```

### Docker Compose (Recommended for Shared Routers)

From the repository root, build the Router image and run the interactive setup once:

```bash
docker compose build
# Optional: copy .env.example to .env and set ROUTER_PORT first
mkdir -p router-data
docker compose run --rm router config setup
docker compose up -d
```

The `./router-data` bind mount stores Router data under the container's `/router-data` home directory (`/router-data/.remote-cli-router/`). On Linux, set `ROUTER_UID` and `ROUTER_GID` in `.env` to the output of `id -u` and `id -g`; they must match the directory owner. Set `ROUTER_PORT` before setup if port `3000` is unavailable; it must match the server port entered in the setup wizard. The Compose service uses `restart: always`, so Docker starts the Router again after unexpected exits and Docker daemon restarts; `docker compose down` still removes the container. Use `docker compose logs -f router` to inspect logs and `docker compose down` to stop the service. Run local clients directly on their host machines rather than in Docker so they can access project files and local AI CLI binaries.

Clients automatically install a newer Router's exact published npm version when their tasks and queues are idle. Manual clients continue running the old version until their next start; clients launched with `--non-interactive` exit for their supervisor to restart. A rejected CLI protocol requires a restart after installation. Publish the matching CLI package when upgrading the Router.

## Commands

| Command | Description |
|---------|-------------|
| `remote-cli-router config` | Interactive configuration |
| `remote-cli-router config show` | View current configuration |
| `remote-cli-router config reset` | Reset to defaults |
| `remote-cli-router start` | Start the server |
| `remote-cli-router stop` | Stop the server |
| `remote-cli-router status` | Check server status |

The Feishu command reference includes the cross-backend `/status`, `/context`, and `/skills` commands, the `/clear` and `/new` fresh-conversation aliases, plus per-thread queue controls. See the root [README](../../README.md) for the complete command and backend behavior reference.

CLI 1.6.93 makes `/cd` to a different directory start fresh conversations for all backends in that thread, including inactive ones. Returning to the old directory does not restore its old conversations. Same-directory `/cd` and backend-only switches preserve context. Thread settings and native history files remain intact. The CLI enforces this behavior without a protocol change; upgrading only the Router does not change an older CLI's directory behavior.

With CLI 1.6.84 or newer, `/status` also shows `Delegation: on/off (current thread)`.
The CLI reads this effective setting without initializing delegation or starting workers.

From CLI 1.6.121, new and existing threads without a saved delegation preference
default to on. Explicit `/delegation off` choices remain off across upgrades,
context resets, backend switches, and restarts; `/delegation on` re-enables it.
There is no historical thread migration or automatic worker launch. Upgrade
and restart the local CLI, not just the Router, to obtain the new default.
The Router protocol is unchanged, and older CLIs retain their existing default.

From CLI 1.6.118, `/status` shows DSH's official recharge and bonus wallet balances when available. Native official-account sign-in is required; API-key-only or custom-provider setup does not supply these wallets. Amounts retain their native decimal precision and currency; balances are not token usage or plan quota. The query does not create or change an ACP conversation. Its owned process uses the same log-upload and telemetry suppression as the DSH executor, is stopped after the query, and omits the balance section on failure or timeout. No other backend or Router protocol changes are required.
From CLI 1.6.120, Claude SDK `[claude-code:unrecognized_model]` diagnostics are omitted from Feishu streaming/results and Claude slash-command error details. CLI 1.6.124 also filters the `generate_session_title` source, including delegated Claude workers. Matching requires a bounded, standalone valid JSON record containing only a nonempty `model` string and a recognized `query_source` (`sdk` or `generate_session_title`); model names are not hard-coded. Unknown sources, additional payload fields, malformed records, actual API/authentication errors, exit status, and assistant reply text are retained. The persistent Claude process's raw stderr remains in local CLI logs; this presentation filter does not disable Claude Code telemetry or change the configured model, other backends, or the Router protocol.

Older CLIs keep their existing status output.

## Architecture

```
Mobile Phone -> Feishu -> Router Server -> WebSocket -> Local CLI -> AI Backend
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

## Advanced Usage

Use one Router for multiple trusted clients. Each client connects from the developer's machine, while the Router owns Feishu configuration, device bindings, routing, and thread switch state. Feishu thread buttons show automatic names such as `thread-2` as their sequence number, such as `2`, while callbacks retain the full internal name. Continuation cards repeat the thread and working-directory header of the original card. A thread can override its backend with `/backend <index> @`; `/backend <index>` changes the global backend and clears per-thread overrides.

Thread switch panels show `Reply from:` with the reply's full thread name and workspace. Under `Switch thread`, a check mark (`✓`) and primary button styling identify the destination of new top-level messages when the card is finalized or clicked. Selected buttons remain clickable. Switching updates only the clicked card; other historical cards retain their last displayed selection.

When a client thread is busy, the Router sends a confirmation card before accepting another message into its queue. `/queue` shows queue state, `/queue clear` discards queued messages, and `/abort` stops the active task and clears that thread's queue. Messages received while abort cleanup is in progress wait for the client backend to become safe before execution starts.

## Expert Usage

The recommended production layout is Docker Compose on an internal server with persistent `./router-data` storage:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 router
```

Back up `./router-data` before upgrades and do not use `docker compose down -v` for routine updates. Restrict the Router port to the trusted network. When diagnosing routing issues, inspect `/health` and the Router logs before restarting clients.

## Documentation

For full documentation, see the [project README](https://github.com/Yu-Robotics/remote-cli#readme).

## License

MIT

## Changelog

See the project [CHANGELOG.md](../../CHANGELOG.md) for release notes and user-visible changes.

## Approval Cards

When supported by the connected CLI, Codex and Claude Code permission requests appear as standalone cards with Allow once, Deny, and (for explicit directory grants) Always allow buttons. Buttons use the same column layout as thread-switch controls. Each button targets the original user, device, thread, and request. The card shows success only after the CLI confirms the decision. Completed requests cannot be approved again, and pending approvals receive fresh cards after reconnecting. After a Router crash, buttons on old cards may remain visible but are rejected as expired. Both CLI and Router must be upgraded to use this feature; unsupported peers and failed card delivery retain text approvals.

When the Router reports that an approval card could not be delivered, CLI 1.6.88 and newer show the requested action in a code block above the text reply instructions. This also applies to delegated worker approval requests, which never offer persistent grants.

Restricted Claude Code threads use the same approval card flow, titled Permission request, for outside writes, protected files, read-only-mode edits, and commands outside their native sandbox. Ordinary workspace and explicitly authorized directory edits in workspace-write mode do not create approval cards, unless a native ask rule requires one. If card creation fails, Claude accepts text replies without starting a new model turn; completed or expired requests cannot be approved later. The CLI enforces file boundaries before native allow rules; native deny and ask rules still apply. Sandboxed command networking is enabled by default, subject to native domain denials and administrator-managed restrictions; `/sandbox network off` disables it without changing the approval card flow. Missing sandbox dependencies stop execution on the CLI; the Router cannot override that startup failure. See [Claude sandbox configuration](../../README.md#optional-claude-code-sandbox).
