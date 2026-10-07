# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Corrected deployment, protocol, security, backend-switching, and release instructions; marked superseded plans and test reports as historical.

## [1.6.145] - 2026-10-07

### Changed
- Render each foreground tool call and its matching result as one collapsed row, updating its status in place while retaining bounded input, output, and per-file diff previews. Keep later text and worker slots stable; preserve unmatched results without guessing a pairing.
- Keep independent calls separate, including adapter ID reuse after a completed invocation. Remove previous tool copies before cross-card moves, including still-active and surplus pages, preserving worker context controls and retryable updates. Backend execution, protocol version, and approval flows are unchanged.

## [1.6.144] - 2026-10-07

### Added
- Show bounded public activity at the tail of the latest active coordinator card and below each managed worker's identity. Separate explicit Codex commentary and public reasoning summaries, public assistant updates, plan steps, and safe tool descriptions from answer text; never promote raw thinking or estimate completion percentages.
- Negotiate optional activity progress without a protocol-version change. Coalesce snapshots, preserve worker-result publication barriers, prioritize input and terminal states, discard late events, and leave older peers on their existing presentation.

## [1.6.143] - 2026-10-06

### Fixed
- Increase the Codex account-usage RPC timeout from five to ten seconds for `/status`, without adding retries or changing failure handling.

## [1.6.142] - 2026-10-05

### Added
- Allow unrestricted coordinators to delegate to their own backend through independent managed worker sessions. Preserve synthetic lane identities, isolated Git checkouts, shared-directory FIFO scheduling, explicit artifact integration, context-reset ownership, and existing task/concurrency budgets.

### Changed
- Report the coordinator backend's worker eligibility in discovery and status using the same admission policy, and align injected tool instructions. Do not advertise sandbox-restricted workers as eligible in the delegation menu. Keep restricted coordinators and read_only requests ineligible; native backend subagents and the Router wire protocol remain unchanged.

## [1.6.141] - 2026-10-05

### Fixed
- Include initialized local submodules and embedded repositories in private delegated snapshots, with staged, unstaged, and nonignored files captured through their own temporary indexes. Stream local Git objects without remote fetching or a repository-size cap; workers receive ordinary files rather than nested Git metadata or histories.
- Apply nested working-file changes through explicit artifact integration while preserving all source HEADs, indexes, and gitlinks. Include nested state in delivery revisions, reject changed repository identities and boundary replacements, preserve uncertain worker-created Git metadata for manual recovery, and keep uninitialized submodules empty without blocking unrelated work.
- Allow ordinary file/directory replacements and identify unsupported filesystem entries by repository-relative path and type. Cover nested snapshots, conflicts, state preservation, streamed transfer, artifact delivery, and guarded checkout reclamation/reuse with real temporary Git repositories.
- Preserve warm index stat caches and the original index timestamp so racy-clean detection still catches same-size edits; reuse completed local object transfers within each stable capture. Reject ancestor worktrees, external nested Git metadata, nested-local command filters, and partial-clone hydration. Keep unsupported no-change metadata pending until explicit retention, and wait for deterministic Git lifecycle signals in cancellation tests.
- Receive nested packs in a per-transfer quarantine and publish complete packs with indexes last. Clean failed and timed-out transfers after both processes exit without sweeping other operations. Discover embedded repositories exposed by gitlink replacements and support initialized submodules owned by linked-worktree metadata stores.

## [1.6.140] - 2026-10-05

### Fixed
- Reject assume-unchanged and skip-worktree index entries before capturing delegated Git checkpoints. Do not silently omit hidden edits, reinterpret absent sparse files as deletions, or modify the source index; preserve unresolved worker files for manual recovery.
- Keep managed Git baseline capture, checkout preparation, and repository-lock waits outside the native worker startup deadline. Await owned mutations before releasing execution capacity, and prevent late worker startup after cancellation.
- Bound accepted Git delegation and cancellation response waits below the tool adapter's timeout. Return the existing task ID and explicit pending status for later polling without aborting owned operations, pretending cleanup finished, or encouraging duplicate submission.
- Separate confirmed process shutdown from artifact collection. Slow collection no longer quarantines the source workspace or leaks global worker slots; collection and lane-persistence failures retain the affected lane while releasing unrelated capacity after Git operations settle. Preserve native-exit quarantine, individual Git command deadlines, non-Git FIFO scheduling, and old-peer compatibility.

## [1.6.139] - 2026-10-05

### Fixed
- Remove the fixed 128 MiB repository-size and 10,000-file limits from delegated Git input snapshots, filtered trees, artifact collection, and checkout reclamation verification. Large repositories keep their complete staged, unstaged, and nonignored untracked input without a replacement size configuration.
- Preserve path and entry validation, artifact ownership and reference checks, streamed byte hashing before reclamation, parent index and branch isolation, and existing Git command deadlines and output-buffer limits. Add regression coverage for large committed and untracked files and complete artifact integration, reclamation, and reuse beyond the former limits.

## [1.6.138] - 2026-10-05

### Fixed
- Validate settled worker artifact receipts independently of source-workspace contention, avoiding spurious closeout failures and extra coordinator turns. Keep ownership, reference, recovery, cancellation, and receipt-integrity checks; history reconciliation still requires the source lease.
- Keep a superseded shared-directory lane non-reusable after a context-clear retry, without deleting another worker's conversation. Persist pooling mode for independent Git lanes and preserve ambiguous legacy duplicate contexts instead of scheduling automatic deletion.
- Return reused Git lanes to ready after failures before checkout preparation starts. Continue preserving uncertain prepared lanes, and distinguish executor setup failures from checkout failures in recovery diagnostics.

## [1.6.137] - 2026-10-05

### Added
- Add an owner-bound Clear context control outside delegated Worker card details after successful or failed execution. Reset only the exact idle lane's native continuation, retaining workspaces, artifacts, archived transcripts, authentication, and settings without replaying the task or resetting the coordinator.
- Negotiate optional workerContextReset support and require CLI acknowledgement before confirming success. Persist reset intents and context epochs, serialize reset with lane acquisition, reject stale or unsafe targets, and permit explicit retries after interrupted resets. Keep controls consistent across streaming, continuation cards, and thread-footer refreshes with a bounded ephemeral Router cache; legacy peers remain compatible.

## [1.6.136] - 2026-10-05

### Added
- Enforce artifact closeout before successful coordinator completion. Drain accepted tasks and tool calls, reconcile historical delivery under existing ownership guards, then inspect durable receipts rather than cached results. Pending changes, missing or invalid receipts, failed collection, and unretained recovery state prevent success; verified no-change, applied, and deliberately retained outcomes need no further decision.
- Resume the same coordinator session for at most two artifact-closeout rounds per request, combining unread worker results when available. Preserve attachments, result acknowledgement, approval/input, model recovery, and cancellation boundaries; new workers do not reset the budget. An unresolved final check returns bounded task IDs and artifact references as a failure, pausing queued execution while preserving recoverable output. No new wire messages, implicit merging, automatic cross-request replay, or non-Git lifecycle changes.

## [1.6.135] - 2026-10-05

### Added
- Automatically reclaim verified delegated Git checkout directories after successful no-change tasks or durable artifact application. Preserve native conversation pointers, stable lane paths, immutable artifacts, and private input/output/history references; recreate absent, unregistered owned paths from fresh delivery input when the lane is reused.
- Persist present/reclaiming/reclaimed checkout state and exact output receipts. Resolve interrupted intents only from verified intact checkouts or confirmed absent/unregistered paths; never infer ownership from a missing legacy directory, overwrite occupied reclaimed paths, prune registrations, or sweep historical workspaces.
- Recognize successful pending worker outcomes as historically delivered when their recorded artifact snapshot commit is an ancestor of delivery HEAD, including after a later revert. Persist the observed HEAD and repair interrupted pending-marker clears; reconcile guarded inspection, ready-lane admission, and idle turn closure without content-subset heuristics, automatic merges, staging, commits, or changes to patch-only apply. Keep replacement-object bypass, owner/ref checks, fail-soft errors, and independent safe-reclamation verification.

### Changed
- Independently bound and hash actual tracked bytes, modes, and symlink targets before checkout deletion, accounting for ignored files, extra directories, unknown entries, and Git index flags. Preserve pending, retained, failed/cancelled, locked, or unresolved recovery workspaces. Transformed bytes that cannot be proven equivalent fail closed.
- Serialize lane lifecycle and Git worktree metadata operations within the CLI process. Await optional reclamation outside the worker-stop deadline before marking a lane ready; cleanup failure does not change a successful task or artifact application. Native backend execution, non-Git FIFO scheduling, and Router protocol remain unchanged.
- Keep full byte verification outside the shared repository guard so independent lanes can start during a slow audit. Isolate a reused Git lane whose checkout preparation fails without discarding its existing native context; preserve lazy recovery of valid interrupted-removal receipts.

## [1.6.134] - 2026-10-04

This stage summary consolidates confirmed source changes from 1.6.90 through 1.6.133, including Git-confirmed changes whose per-version notes were missing. It replaces the available entries in that range, not Git history, and is not a complete npm publication ledger. Version 1.6.134 reorganizes release documents, synchronizes package versions, and permits up to six summary bullets in build-time and bundled-artifact validation; backend execution and Router behavior are unchanged.

### Added
- Integrate DeepSeek Harness (DSH) through its native persistent ACP server, with model and reasoning-effort controls, cancellation, permission prompts, context reporting when available, and isolated coordinator/worker sessions. Keep native capability boundaries: images require advertised support, and unsupported interactive slash commands, plan mode, and elicitation do not fall back to another backend.
- Preserve DSH session pointers across backend switches and restarts. Recover explicitly non-resumable sessions with an honest fresh-session notice; retain pointers on authentication, provider, network, rate-limit, timeout, or directory-mismatch failures. Summarize-then-reset compaction uses a private, durable handoff rather than claiming native transcript compaction, and refuses to summarize unavailable original context.
- Show DSH official recharge and bonus wallet balances in `/status` when native account authentication makes them available. Retain native precision and currency, distinguish balances from token usage or plan quota, and use a short-lived account-query process without creating a model turn or changing the ACP conversation.
- Receive file attachments up to 20 MiB through explicit device enrollment and a same-Router HTTPS download path. Transfer file bytes from Feishu to a private Router spool and CLI staging area; WebSocket messages contain only bounded references, hashes, sizes, and authorization metadata. Enforce authenticated device ownership, actual byte limits, hashes, deadlines, storage quotas, and explicit failure feedback without weakening legacy text/image support.
- Extract bounded previews from text/code, CSV, JSON, YAML, textual PDF, DOCX main-body text, and XLSX cells, retaining page/sheet/cell provenance. Keep parsing off the control event loop, bound expanded archives and output, and never execute macros or formulas. OCR, protected documents, legacy Office formats, and general archive extraction remain unsupported; saved, parsed, partial, and unsupported outcomes stay distinct.
- Stage files for a subsequent instruction or a reply to their status card, including instructions with images, rather than starting a model task on file upload alone. Pin queued attachments, bind references to the admitted device/thread/directory, expose `/files` and `/files clear`, and preserve active references during cleanup. Backend tools retain their normal permissions when reading original or preview paths outside the project.
- Persist isolated delegated-worker lanes separately from direct backend sessions, retaining only each lane's own earlier delegated context. Reuse requires confirmed process exit and valid session state; directory changes invalidate the old workspace generation, and failed lane cleanup remains retryable rather than silently freeing uncertain ownership.
- Accept multiple independent delegated tasks in one coordinator request, with individual cancellation, queued status, bounded queue waits, cumulative admission limits, and automatic collection of all results. Retain source-workspace ownership while the queue drains; queued work has no execution timestamp or progress card before it starts.
- Run Git workers in reusable per-lane worktrees with bounded snapshots of staged, unstaged, and nonignored untracked input. Refresh every detached task checkout to an explicit baseline while preserving native lane identity. Non-Git directories use code-enforced FIFO serial scheduling and are never initialized as Git repositories implicitly; worktrees are not process sandboxes.
- Preserve immutable worker artifacts under private Git references and expose revision-guarded inspection, integration, or retention. Preflight conflicts in a separate recovery worktree; applying changes never stages, commits, or pushes the delivery workspace. Pending artifacts or unknown dirty files block lane reuse. File application is not atomic: preserve before/target snapshots and a durable pending receipt for manual recovery after an incomplete apply, and validate captured tree limits after Git filters and both rename endpoints against the selected-directory scope.
- Attach bounded execution-scoped model and reasoning-effort metadata to AI responses, terminal recovery, and each delegated worker's progress/results. Distinguish backend reports, configured selections, defaults, and unavailable values without extra model requests. Keep launch preferences stable, retain final worker snapshots before cleanup, and never substitute coordinator settings or attribute a model to an unstarted queued task.
- Show compact gray model/effort notes below Completed on main replies and outside collapsed worker details. Preserve metadata through long-output splitting, thread-button refresh, and optional protocol-v1 fields, while legacy peers and local control commands retain their existing display.
- Add standalone CLI upgrade notices with cumulative bundled notes, offline delivery, negotiated capabilities, and a silent baseline on first adoption. Advance notification progress only after acknowledged delivery, retain skipped-upgrade ranges, and keep maintenance cards separate from thread selection and task routing.
- Add hourly, status-only Codex weekly-quota inspection and notification-only reminders using existing file-backed ChatGPT credentials. Do not send model prompts, create user threads, refresh credentials, or probe other backends. Missing/expired credentials, unsupported native APIs, and failed samples remain unavailable evidence; the experimental native token-handoff API is not a compatibility guarantee.

### Changed
- Enable managed delegation by default for new and existing threads with no saved preference; explicit off remains off through upgrades, context resets, backend switches, and restarts. Exposing delegation tools does not automatically launch workers.
- Restrict managed delegation to a different backend without changing native backend subagent tools. Unrestricted coordinators launch unrestricted workers; sandboxed coordinators have no eligible cross-backend targets until policy translation is supported. Discovery and launch enforce the same policy.
- Raise the shared starting/running worker limit from three to five. Git-backed requests can occupy five isolated execution slots; additional accepted tasks remain queued, non-Git requests still run one worker at a time, and the cumulative 12-task limit spans coordinator continuations without refunds for failures or cancellation.
- Use real worker tool activity for liveness timeouts, with separate idle and tool-idle deadlines, rather than treating a quiet stdout stream as proof that a worker stalled. UI text and card heartbeats do not extend execution liveness.
- Enrich the local CLI's Linux/macOS startup PATH with verified runtime and conventional installation directories, preserving inherited precedence. Use the same command resolution for startup checks, backend menus, delegation, and auxiliary queries, honor explicit executable overrides, and preserve ZCode's native empty-command discovery without falling back from a nonempty invalid override. Valid existing services do not need reinstallation; startup does not source shell profiles, install tools, or rewrite their service files.
- Render nested/live worker activity and results as rich Markdown, with independent per-worker text, elapsed/tool activity, consistent icons, and compact mobile layouts. Keep detailed activity collapsed, separate result labels from worker Markdown, preserve stable update slots and card-wide table limits, and make the delegation status menu easier to scan.
- Label standalone task notifications as Background task, retain their originating thread and task identity, collapse result/output-path details by default, and keep short failures visible. This presentation is separate from foreground replies and managed-worker cards.
- Show thread/workspace headers on initial streaming and continuation cards before final completion, preserving reply provenance rather than waiting for the terminal card update.
- Bundle concise Chinese user summaries alongside English technical details at build time. Validate matching nonempty current-version entries, one short heading and one to six single-line user bullets, stable feature tags/titles, and bounded package payloads; never fetch, translate, or summarize release notes with a model at runtime. Version 1.6.134 raises the per-release bullet limit from three to six while retaining the 2 KiB summary budget.
- Aggregate the entire pending device-upgrade range by feature, removing exact duplicate items only. Keep available summaries and technical details collapsed and paged, report bounded-overview omissions, and preserve legacy-peer fallback, first-adoption silence, and protocol version 1. This release represents the consolidated 1.6.90-1.6.133 range with the 1.6.134 stage summary rather than reconstructing a per-device subset of those changes.
- Use the title "Codex Reset" with a target emoji and "Weekly quota reset: 100%". Explain why to send Codex a normal task without verification or activation steps, remove the sampling-disclaimer footer and redundant Dismiss button, and retain passive validated legacy callbacks. Eligibility requires two roughly hourly zero-usage observations with approximately seven days remaining and a deadline that advances with the sampling interval; it is a snapshot heuristic, not confirmation of a provider reset or a guarantee that one request starts a usage window.

### Fixed
- Validate incomplete or incompatible tool parameters before specialized card formatting, using bounded text or no-parameters fallbacks without interrupting later tool events or task completion.
- Retry confirmed Feishu Markdown-parser failures as literal text, preserve that mode on later updates and thread-button refreshes, and retain table-limit fallback without treating unrelated failures as parse errors.
- Require successful recovery-notice delivery before acknowledging reuse of a surviving card, avoid duplicate notices within a recovery round, and retain originating thread information through recovery and continuation cards.
- Reset every backend's remote-cli session binding when a thread changes to a different normalized working directory, preserve backend-native history and thread preferences, and keep a same-directory selection a no-op.
- Distinguish a deleted or inaccessible selected working directory from a missing backend executable, refuse fallback execution in another directory, and cover remaining executor and passthrough startup paths with actionable errors.
- Refresh Codex's model catalog and idle app-server after a native CLI version change while preserving the conversation binding, and improve model-recovery card delivery without replaying accepted worker launches.
- Retain bounded worker results through coordinator continuations and terminal failures without replaying the original request, attachments, or completed workers. Keep execution-scoped result acknowledgement separate from worker completion, suppress premature coordinator output while results are pending, and prevent stale worker progress from overwriting unrelated cards.
- Deduplicate ACP tool updates and keep reasoning/thought chunks out of answer text, final output, and delegated summaries for Kimi, OpenCode, ZCode, and DSH, while preserving separate native reasoning handling. Generate unique, paired Pi fallback tool IDs so concurrent tool calls cannot collide or report an unrelated result.
- Filter bounded standalone Claude Code model-recognition stderr diagnostics for SDK queries and session-title generation, including delegated-worker streaming/results and slash-command error details. Preserve actual API/authentication errors, nonzero exits, assistant text, unknown sources, malformed records, and other backends; raw local stderr and telemetry behavior are unchanged.
- Refuse ambiguous plain-text input when multiple workers are waiting, retain request-specific approval routing, and require confirmed cleanup before releasing occupied slots or workspace ownership.
- Keep queued diagnostic records out of live terminal pruning, reconcile unfinished records as interrupted after restart without replaying tasks, and make retained worker-lane cleanup retryable.
- Persist acknowledged Codex reminder suppression across CLI upgrades, restarts, reconnects, and credential refreshes using a private account/bucket fingerprint ledger. Only valid non-candidate observations rearm reminders; unavailable probes do not. Wait for accepted acknowledgement writes on shutdown, preserve corrupt/unavailable storage without affecting normal messaging, and do not claim exactly-once delivery across crashes.

### Security
- Disable DSH's official extra session-log attachment and OTel telemetry paths independently with a private temporary configuration overlay and the native telemetry-disable flag. Leave existing profiles, credentials, and other backends untouched and remove the overlay after process exit. Normal model requests still send task context to the selected provider and native local history remains; this is not an offline mode or a guarantee about third-party plugins.

### Maintenance
- Require staged-change and outgoing-commit privacy checks before publication, and sanitize documentation references without changing functional behavior.
- Remove redundant presentation/fixture assertions while retaining behavioral regression coverage, clean temporary test fixtures reliably, and make ZCode discovery assertions portable across aliased filesystem paths.

## [1.6.60] - 2026-09-25

### Added
- Interactive Codex approval cards with Allow, Deny, and conditional persistent directory grants.
- Additive capability negotiation and request-scoped approval responses, with text fallback for older routers or card delivery failures.

### Fixed
- Bind approval buttons to their original user, device, thread, and request; invalidate completed requests and reject duplicate or stale clicks.
- Restore pending approvals with fresh cards after reconnecting, and show decisions only after CLI acknowledgement.

## [1.6.59] - 2026-09-25

### Added
- Opt-in Codex native sandbox policies with per-thread directory grants, network controls, and development-friendly temporary/download/cache access.
- `/sandbox` configuration commands and explicit, persistent writable-directory approval through `remember` for native Codex permission requests.

### Security
- Apply sandbox policy on thread creation, session restoration, working-directory changes, and every turn. Restricted modes relay privilege-expansion requests instead of auto-approving them.
- Retain grants across conversation resets and backend switches; revoke them when a thread is deleted. Existing defaults and other backend execution policies are unchanged.

## 1.6.55 - 2026-09-25

### Fixed
- Separated recovery acknowledgement timeouts from retry backoff so ongoing output cannot trigger early retries or count the same failure twice.
- Reset the failure budget after successful recovery and retained output isolation when a recovery round is paused; a later connection can retry bounded task metadata.
- Required a usable card before acknowledging recovery, recreated missing or finalizing cards, and retried terminal delivery failures without creating duplicate recovery cards.
- Isolated retained Markdown, the reconnection notice, and resumed plain text when reusing a card, while restoring its thread reply route.

## [1.6.53] - 2026-09-24

### Added
- Added task recovery after Router restarts or WebSocket disconnections. Compatible clients report task metadata and resume later output on new cards with a gap notice, without buffering or replaying disconnected output.
- Added bounded, in-memory completion receipts for tasks that finish offline; automatic CLI updates wait for pending results to be acknowledged or expire.

### Fixed
- Counted Markdown and nested tables during card splitting, with a conservative three-table budget and readable text fallbacks for indivisible content.
- Retried a card rejected by Feishu's table limit once as text and retained that mode for subsequent updates to the same card.
- Reduced verbose per-chunk split logging during long replies.

## [1.6.51] - 2026-09-24

### Added
- Streamed Claude Code text incrementally instead of waiting for completed content blocks, without duplicating already streamed text.

## 1.6.31–1.6.50 — Source History Summary

This summary was reconstructed from repository commits. It records merged code changes rather than a complete per-version npm publication history; the dates above are source commit dates.

- Removed the legacy Claude spawn and Codex exec transports, with configuration migration to the maintained backends.
- Added the official ZCode app-server and Pi RPC backends, then improved Pi session controls, extension interactions, and command discovery.
- Made `/new` an alias for `/clear` within the current thread.
- Improved thread button wrapping, numeric ordering, workspace labels, continuation headers, and the distinction between a reply's source thread and the selected destination.
- Moved queued tasks to fresh execution cards, preserved confirmed queue order, and reported paused queues with recovery commands.
- Allowed all backends to return local image files through paths or Markdown links, with a 2 MiB forwarding limit.
- Avoided repeatedly updating unchanged cards in long replies; allowed thread listing and creation while another task is running.
- Added Codex background task completion cards and colored, line-aware diff previews.

## [1.6.30] - 2026-09-17

### Fixed
- Continued with the first confirmed queued message when the active task ends with a backend error, including temporary model-capacity failures.

## [1.6.29] - 2026-09-16

### Added
- Added a Kimi Code backend using the official persistent `kimi acp` server, with resumable sessions, model and thinking controls, image input, slash commands, cancellation, and permission handling.

## [1.6.28] - 2026-09-16

### Added
- Added an OpenCode backend using a persistent `opencode acp` process, with resumable per-thread sessions, native model and effort controls, image input, slash commands, compaction, cancellation, tool updates, and permission handling.

## [1.6.27] - 2026-09-16

### Removed
- Removed legacy Gemini backend remnants.

## [1.6.26] - 2026-09-14

### Added
- Added automatic CLI version catch-up for installed Linux systemd services and macOS LaunchAgents after reconnecting to a newer Router.
- Added idle draining so automatic updates never interrupt active thread work; automatic updates apply whenever the client runs with `--non-interactive`.

### Changed
- Protocol incompatibility responses now trigger exact Router-version resolution and managed automatic update attempts instead of requiring unconditional manual recovery.

## [1.6.25] - 2026-09-14

### Fixed
- Forwarded images embedded in Feishu rich-text posts together with their accompanying text to Claude Persistent and Codex App Server backends.
- Preserved available images when another image in the same rich-text message cannot be downloaded.

## [1.6.24] - 2026-09-14

### Fixed
- Fixed Linux systemd user units that quoted `WorkingDirectory` and output paths with shell-style syntax, causing systemd to reject otherwise valid absolute paths.
- Correctly quoted complete `Environment` assignments and escaped paths containing spaces or systemd specifier characters.

## [1.6.23] - 2026-09-14

### Fixed
- Fixed a race where a message sent while `/abort` was still closing a backend process could remain in the Processing state indefinitely.
- Serialized per-thread abort cleanup with subsequent messages and prevented an older command from clearing a newer command's busy state.

## [1.6.22] - 2026-09-14

### Added
- Added `remote-cli service start` and `remote-cli service stop` to control an installed user service without removing automatic startup.
- Added new-file previews for `Write` tool calls in Feishu progress cards.

### Fixed
- Made `remote-cli stop` stop an active systemd user service or macOS LaunchAgent instead of only updating local configuration.
- Fixed macOS service status reporting for loaded services that have exited.
- Improved edit previews for multiple separate changes and Markdown content containing code fences.
- Made the Docker Router run with configurable host UID/GID values to prevent bind-mount permission errors.

## [1.6.21] - 2026-09-14

### Improved
- Improved code-change rendering in Feishu cards with inline diff previews for edit operations.
- Diff output uses line-aware truncation and a larger display budget instead of the generic short command-output limit.
- Preserved the existing progress card layout while keeping code changes inside collapsible sections.

## [1.6.20] - 2026-09-13

### Added
- Added `remote-cli service install`, `service uninstall`, and `service status` for macOS LaunchAgents and Linux systemd user services.
- Service installation captures the current Node.js path, CLI entry point, HOME, PATH, and log paths so automatic startup uses the same user context.
- Automated service startup uses non-interactive version checks and restarts on failure.

## [1.6.19] - 2026-09-13

### Added
- Added Codex app-server generated image forwarding from the CLI to Router.
- Added Feishu Card 2.0 image rendering for generated images.
- Added regression coverage for Codex image events, Feishu uploads, and Router forwarding.

## [1.6.18] - 2026-09-13

### Fixed
- Updated the Docker health check to follow the configured `ROUTER_PORT` instead of always probing port `3000`.

## [1.6.17] - 2026-09-13

### Fixed
- Made the Docker Compose Router port configurable through `ROUTER_PORT`.
- Kept the host port and container port synchronized so changing the setup port no longer leaves Compose bound to port `3000`.

## [1.6.16] - 2026-09-13

### Changed
- Renamed the Router container data home from `/data` to `/router-data` to make the container path distinct from host data directories.
- Changed the host-side bind mount from `./data` to `./router-data` for a clearer deployment layout.
- Existing deployments should move their `data` directory to `router-data` before restarting.

## [1.6.15] - 2026-09-13

### Fixed
- Fixed Feishu image downloads by using the SDK resource `writeFile` API before forwarding images to supported backends.
- Added a Router regression test for the Feishu image resource download path.

## [1.6.14] - 2026-09-13

### Added
- Docker and Docker Compose deployment for the shared Router server.
- Interactive container setup that persists Feishu credentials and device bindings in `./data`.
- Docker health checks and documented container log management.

### Changed
- Recommended running the Router in Docker while keeping local clients on their host machines so they can access local project files and AI CLI binaries.

## [1.6.12] - 2026-09-12

### Added
- Queue confirmation cards now update after a queue request is processed.
- Repeated clicks on the same queue confirmation are detected and do not resend the command.

## [1.6.11] - 2026-09-10

### Fixed
- Replaced the unsupported Card 2.0 `action` container in queue confirmation cards with supported button layouts.
- Queue confirmation cards no longer remain stuck in the Processing state because of invalid card payloads.

## [1.6.10] - 2026-09-09

### Added
- Added `/status`, `/context`, and `/skills` commands across supported backends.
- Added queue diagnostics to status and context output.

## [1.6.9] - 2026-09-09

### Added
- Added per-thread backend overrides using `/backend <index> @`.
- Added `/backend default @` to return a thread to the global backend.
- Threads using different backends can execute concurrently.

## [1.6.8] - 2026-09-08

### Fixed
- Enabled the experimental Codex app-server APIs required for native model, reasoning effort, compaction, and interruption controls.

## [1.6.7] - 2026-09-08

### Added
- Added Codex reasoning effort controls and prioritized Codex in the backend list.
- Added AGY reasoning effort support.

### Fixed
- Coalesced streaming card updates and improved final thread-switch card refresh behavior.

## [1.6.1] - 2026-09-07

### Added
- Added the persistent Codex app-server backend with session resume and streaming support.
- Added backend-aware model selection and per-thread reasoning effort storage.

### Fixed
- Removed the global Claude Code security hook that caused repeated PreToolUse errors.

## [1.1.39] - 2026-03-20

### Added
- **Multi-session Threads**: True parallel multi-thread support with per-thread executors
- Feishu Card 2.0 integration for thread switching and creation
- **Gemini CLI Support**: Alternative AI backend via ACP (Agent Client Protocol)
- Gemini automatic quota fallback to Flash models
- **Remote Machine Management**: SSH and Docker control via chat commands
- **Redacted Thinking Handling**: Support for safety-filtered reasoning in Claude 3.7 Sonnet
- **Security Hooks**: Directory-based security via Claude Code native hooks

### Fixed
- Fixed Gemini session persistence after `/abort` commands
- Improved test isolation on macOS by mocking `os.homedir()`
- Fixed memory leaks in thread management
- Resolved race conditions in busy lock and session cleanup

## [1.1.0] - 2026-03-10

### Added
- Initial support for multiple devices per user account
- Switch between active devices via `/device` command
- Device ID collision protection in Router

## [1.0.3] - 2026-02-18

### Fixed
- Fixed failing tests by updating mocks
- Prevented process crash when working directory doesn't exist
- Validated working directory exists before spawning Claude process
- Fixed `/clear` command from stopping Claude process

## [1.0.2] - 2026-02-17

### Added
- Persistent Claude process with stream-json I/O for better performance
- Git worktree integration for session isolation
- Worktree slash commands (`/worktree list`, `/worktree cleanup`, `/main`)
- Auto-detection of nested Claude sessions

### Fixed
- Improved error handling for WebSocket connections
- Fixed session resumption logic

## [1.0.1] - 2026-02-16

### Added
- Feishu message formatting with rich text cards
- Progress indicators for long-running operations
- Directory whitelisting security feature
- Command filtering for dangerous operations

### Fixed
- WebSocket reconnection logic
- Configuration persistence issues

## [1.0.0] - 2026-02-15

### Added
- Initial release of Remote CLI
- Local client package (`@yu_robotics/remote-cli`)
- Router server package (`@yu_robotics/remote-cli-router`)
- WebSocket-based communication between client and router
- Device binding mechanism with Feishu
- Basic CLI commands: `init`, `start`, `stop`, `status`, `config`
- Security features: DirectoryGuard, command filtering
- Message handling with slash command support
- Claude Code integration via Agent SDK
- Comprehensive test suite (80%+ coverage)

[Unreleased]: https://github.com/Yu-Robotics/remote-cli/compare/7822b5a857c134fb5790e84be69526a81891bec9...main
[1.6.53]: https://github.com/Yu-Robotics/remote-cli/commit/7822b5a857c134fb5790e84be69526a81891bec9
[1.6.51]: https://github.com/Yu-Robotics/remote-cli/commit/2db07de81b88c866d29def2ad6b9b44b8a44fe51
[1.6.30]: https://github.com/Yu-Robotics/remote-cli/commit/29a5d4a9b787f77e15a68d3f21b6da492c934f01
[1.6.29]: https://github.com/Yu-Robotics/remote-cli/commit/f7173bc6240cfd5fd68cccfc17390bac23681591
[1.6.28]: https://github.com/Yu-Robotics/remote-cli/commit/786943a43d7970ebe01847576664c4bfa46e9398
[1.6.27]: https://github.com/Yu-Robotics/remote-cli/commit/5141df2879d785842cd47d241e16d4d26406433a
[1.6.21]: https://github.com/Yu-Robotics/remote-cli/compare/v1.6.20...v1.6.21
[1.6.14]: https://github.com/Yu-Robotics/remote-cli/compare/v1.6.12...v1.6.14
[1.6.12]: https://github.com/Yu-Robotics/remote-cli/compare/v1.6.11...v1.6.12
[1.6.11]: https://github.com/Yu-Robotics/remote-cli/compare/v1.6.10...v1.6.11
[1.6.10]: https://github.com/Yu-Robotics/remote-cli/compare/v1.6.9...v1.6.10
[1.6.9]: https://github.com/Yu-Robotics/remote-cli/compare/v1.6.8...v1.6.9
[1.6.8]: https://github.com/Yu-Robotics/remote-cli/compare/v1.6.7...v1.6.8
[1.6.7]: https://github.com/Yu-Robotics/remote-cli/compare/v1.6.1...v1.6.7
[1.6.1]: https://github.com/Yu-Robotics/remote-cli/compare/v1.1.39...v1.6.1
[1.1.39]: https://github.com/Yu-Robotics/remote-cli/compare/v1.0.3...v1.1.39
[1.0.3]: https://github.com/Yu-Robotics/remote-cli/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Yu-Robotics/remote-cli/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Yu-Robotics/remote-cli/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Yu-Robotics/remote-cli/releases/tag/v1.0.0
