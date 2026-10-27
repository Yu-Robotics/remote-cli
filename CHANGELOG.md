# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Corrected deployment, protocol, security, backend-switching, and release instructions; marked superseded plans and test reports as historical.

## [1.6.190] - 2026-10-27

### Fixed
- Serialize shared Kimi and OpenCode permission decisions with the nested ACP v1 outcome for approvals, rejections, cancellations, and error paths. Preserve fail-closed validation, manual approval settings, interactive questions, and existing backend session bindings; native permission modes and the Router protocol are unchanged.

### Tests
- Exercise real Kimi/OpenCode executors and ACP NDJSON transport against a schema-validating synthetic agent, covering automatic approval, manual allow-once/allow-always, denial/cancellation, and interactive question selection/skip. Retain DSH interoperability checks and malformed-selection regression coverage.

## [1.6.189] - 2026-10-26

### Fixed
- Persist each Feishu user's selected thread per bound device with prompt FIFO durable writes, so Router restarts and A→B→A device switches restore selection without changing native sessions or the protocol-v1 CLI contract. Keep known replies independent, reject expired parent routes and stale card controls, and fence selection intents against late New Thread responses and ownership changes. Bind thread controls on actual delivered continuation cards and require a validated complete catalog before adopting a New Thread selection.
- Reset a deleted selection only after a fresh authoritative catalog or an exactly correlated legacy missing-thread response; notify the user and never replay the failed message. Quarantine malformed optional preferences without disabling valid bindings or silently overwriting raw data, and preserve the previous selection when persistence fails. A narrow `/thread list` recovery path uses the existing legacy status response to refresh selection controls without executing a prompt.

### Tests
- Cover real Router/store reconstruction with legacy registration, per-user/device isolation and A→B→A restoration, `/clear` and reconnects, unbind/rebind, FIFO preference commits, stale intents and catalogs, card provenance, exact deletion handling without replay, durable uncertainty, malformed preferences, actual continuation finalization and replies, and New Thread creation versus selection persistence failures.

## [1.6.188] - 2026-10-26

### Fixed
- Apply each device unbind in one durable snapshot, covering the user record, reverse ownership mapping, active-device fallback, and last-device deletion. A failed replacement now preserves both ownership representations instead of leaving a listed device without its mapping.

### Tests
- Cover active, inactive, and last-device unbinds, pre-replacement failure coherence in memory and after reload, and queued storage mutations that must not resurrect removed ownership.

## [1.6.187] - 2026-10-26

### Fixed
- Validate binding-file structure and supported versions before adopting data, migrating legacy records, or removing expired codes. Preserve malformed files without replacement and block reads and writes on the rejected instance instead of silently publishing empty bindings.
- Retain valid version-1 records and versionless single-device migrations, including empty legacy stores and opaque dictionary keys. Keep parser input out of reported errors and preserve protocol-v1 CLI compatibility.

### Tests
- Cover malformed roots, collections, nested records, timestamps and versions, byte-preserving failure, blocked post-failure access, valid legacy/current reloads, private parser diagnostics, and recovery through a fresh instance after repair.

## [1.6.186] - 2026-10-26

### Fixed
- Make the Pi inactivity watchdog the `ExecuteOptions.inactivityTimeout` window (10 minutes by default), re-armed by every Pi event so a long tool chain no longer fails exactly 10 minutes after the prompt. An extension-UI prompt suspends the watchdog until the user answers while a positive hard limit stays armed, and a dialog that Pi resolves on its own timer re-arms the watchdog. A positive `ExecuteOptions.timeout` is a one-shot hard limit and a non-finite one arms nothing, while `inactivityTimeout: 0` / `timeout: 0` each disable only their own deadline, matching the Agy and Codex executors.
- Claim remote-cli's own failure reason before Pi settles its aborted turn, so a deadline or an explicit `/abort` no longer surfaces Pi's raw `Request aborted`. A turn already failing is never failed twice, overlapping deadline and `/abort` paths send a single `abort`, `/abort` waits for the in-flight cleanup instead of releasing the turn early, and cleanup of a settled turn no longer aborts, recycles, or cancels the input dialog of a turn started afterwards.

### Tests
- Cover the deadline-versus-abort ordering, continuous tool activity that outlasts the watchdog window, the hard limit that events cannot extend, a single abort while the failure is in flight, a waiting input dialog that suspends the watchdog without cancelling the hard limit, a dialog that Pi resolves itself, a dialog still open when the turn settles, concurrent `/abort` cleanup, an `/abort` still clearing the queue when a successor starts, the cleared watchdog after a settled turn, the disabled, non-finite and default deadlines, and cleanup ownership after settlement.

## [1.6.185] - 2026-10-26

### Fixed
- Validate Router task-output recipients against current device ownership while retaining protocol-v1 registration, legacy response shapes, background notifications, and owner-validated result recovery.
- Serialize competing device binding operations and binding-code consumption to prevent one device from being assigned to different users concurrently.
- Publish binding changes only after serialized atomic persistence succeeds; reject failed drafts, block uncertain replacements, preserve damaged input, and drain accepted writes early during shutdown while propagating failures after resource cleanup.
- Cancel ACP permission requests when the approval callback fails or returns an invalid selection instead of selecting the first option.
- Keep Codex execution fenced after an ambiguous turn-start failure until transport termination is confirmed, without automatically replaying uncertain work; allow an explicit `/abort` retry to recover after an unconfirmed stop.

### Tests
- Add regressions for recipient ownership, bound legacy clients, binding and storage races, failed approvals, and ambiguous native-turn cleanup.

## [1.6.184] - 2026-10-25

### Fixed
- Recover from a persisted Router PID equal to the new startup process, including Docker PID 1 after container recreation, while retaining ordinary stop/status process checks and rejecting another live PID.
- Register shutdown handling before asynchronous startup and use bounded cleanup for initialization failures and termination. Preserve replacement PID records and prevent interrupted initialization from continuing into a new server start.

### Tests
- Cover self-PID recovery, duplicate-process refusal, initialization failures, early signals, bounded shutdown, and ownership-safe cleanup with isolated fixtures.

## [1.6.183] - 2026-10-25

### Added
- Add two Easter-egg Tips explaining the passive Codex weekly-quota and banked-reset-credit increase notices, including their sampling limits and the distinction from resetting context or granting, claiming, or consuming credits.
- Expand the bundled catalog, native-card-based SVG/PNG illustrations, preview gallery, contact sheet, and download archive to 27 tutorials while preserving existing content and progress.

### Tests
- Cover passive notification copy and artwork, complete packaging, and preserved reading progress and opt-outs when upgrading from the 25-tip catalog.

## [1.6.182] - 2026-10-25

### Added
- Add eight illustrated tool-operation Tips for directory selection, named project threads, tool details, delegation controls and targeted worker resets, Codex speed and native goals, and backend-specific command sandboxing. Preserve the existing 17 topic IDs and reading progress.
- Expand the bundled catalog and editable SVG/PNG gallery to 25 tutorials, with a complete dynamically sized contact sheet and downloadable bundle.

### Tests
- Cover the expanded catalog, operation-specific prerequisites and illustrations, complete gallery coverage, and byte-identical packaged assets.

## [1.6.181] - 2026-10-25

### Changed
- Remove the separate example button from illustrated Tips. Show copyable example instructions directly below usage, alongside the illustration and inline usage notes, with only Next, Mastered, and Settings controls.
- Refresh previously delivered example and detail controls into the current card after normal ownership and expiry checks.

### Tests
- Cover inline examples, the three passive controls, and safe handling of both legacy callbacks without changing progress or preferences.

## [1.6.180] - 2026-10-25

### Changed
- Remove the extra detail button from illustrated Tips and show concise usage notes directly in the card body. Keep examples, next-tip navigation, progress marking, and subscription settings available.
- Refresh previously delivered detail controls into the simplified card after normal ownership and expiry validation.

### Tests
- Verify inline notes, the four remaining controls, example rendering, and safe handling of legacy detail callbacks.

## [1.6.179] - 2026-10-25

### Changed
- Enable daily illustrated Tips by default for new users and legacy default-off records, without requiring manual subscription. Preserve explicit opt-outs, mute deadlines, chosen frequencies, reading progress, and delivery timing protections.
- Update Tips settings and documentation to explain the default cadence and pause or stop controls.

### Tests
- Cover automatic delivery without enrollment, legacy preference migration, and preservation of explicit stops, pauses, progress, and restart behavior.

## [1.6.178] - 2026-10-25

### Added
- Bundle 17 illustrated Chinese scenario tips with deterministic manual browsing and passive Feishu cards. Each tip includes a distinct packaged PNG redrawn from the real settings or task-card UI, an editable SVG, and a copyable example that is never executed by a card action. All examples use synthetic content.
- Add Router-owned explicit daily or twice-weekly subscriptions, timezone settings, permanent opt-out, and timed mute controls. Deduplicate per user across devices; skip recent activity, observed tasks, offline users, and exhausted catalogs.
- Persist private preferences and pre-dispatch delivery intent. Suppress ambiguous sends after failures or restarts, validate card ownership and expiry, and stop scheduling before Router shutdown.

### Tests
- Cover content and packaging, subscription and delivery state transitions, failure recovery, action validation, transport isolation, and Router integration with mocked Feishu APIs.

## [1.6.177] - 2026-10-24

### Changed
- Make `/clear` and `/new` reset every direct backend session binding and managed worker continuation owned by the current thread, including inactive backends and parallel worker lanes. Preserve files, artifacts, archived transcripts, settings, and other threads.
- Persist reset intent before clearing native pointers. After intent is saved, failed or interrupted resets remain retryable and prevent old context from resuming, including after CLI restarts; running, queued, and uncertain worker activity refuses an unsafe reset.
- Reject incomplete worker inventories and unconfirmed native exits. Bound shutdown waits while preserving reset intent and process ownership for safe retries.
- Join retained reset cleanup during service shutdown, preserve conversation data and reset intent, and propagate shutdown failures before automatic restart.
- Keep single-worker card clearing and explicit `/delegation reset [backend]` available with their existing scopes. This CLI change uses the existing Router protocol.

### Tests
- Add regressions for both aliases, all-backend and multiple-worker isolation, reset failure/retry/restart handling, admission guards, and preservation of artifacts and settings. Verify that Pi workers start with a fresh native identity after pointer-only clearing while their archived transcripts remain available.

## [1.6.176] - 2026-10-24

### Added
- Add a separate Speed section to model settings when the selected Codex model exposes native service tiers. Preserve native tier names and descriptions, with explicit Standard and Follow native config choices.
- Persist speed independently per thread and backend, including future delegated workers, and apply sticky speed policy before activating native goals.
- Negotiate model speed settings independently so older peers and backends without native speed controls retain their existing model behavior.

### Safety
- Validate speed against the selected model, reject incompatible model changes, and restore native configured speed explicitly instead of retaining a previous sticky override. Untouched threads send no new speed parameters or settings requests.
- Keep speed reset available after tier removal. Require an upgrade or explicit conversation reset when a downgraded Codex protocol cannot safely clear a saved tier.

## [1.6.175] - 2026-10-24

### Fixed
- Refresh Kimi Code's native managed model catalog automatically when listing models, so newly available models can appear without opening the native terminal or signing in again.
- Bound refresh requests and local server cleanup, coalesce concurrent refreshes, and report discovery failures instead of silently presenting stale metadata as refreshed.
- Reload an idle Kimi ACP process before applying discovered aliases while preserving its conversation binding, including choices discovered by temporary settings previews.

### Tests
- Cover native refresh ordering, new model discovery, failure and timeout handling, concurrent requests, and preservation of ordinary backend execution.

## [1.6.174] - 2026-10-24

### Changed
- Restore directly visible thread-switch buttons and the new-thread button on completed cards, removing the thread folding panel while preserving reply attribution and routing behavior.
- Increase the recursive card element budget from 150 to 180 tagged nodes, retaining completion reserves and the existing size and table limits.

### Tests
- Cover visible thread controls through finalization and refresh, switching callbacks, and recursive pagination boundaries at the new limit.

## [1.6.173] - 2026-10-24

### Fixed
- Forward recognized Codex native, MCP, and dynamic-tool image results directly to response cards without requiring Markdown. Prefer inline bytes and allow explicit native saved paths only through the local directory policy; omit image bytes from tool diagnostics.
- Drain admitted image uploads before Router response finalization, including ordinary replies. Bound image work and fence late results after timeout, cancellation, disconnect, or stream replacement.
- Deduplicate images by decoded content within a reply, retain changed content at the same path, and harden local reads with canonical-path checks, regular-file verification, bounded reads, and format validation. Keep image failures separate from task success.

### Tests
- Cover structured image variants, inline/file/Markdown deduplication, read and upload limits, finalization ordering, late results, filesystem boundaries, and unchanged text and goal behavior.

## [1.6.172] - 2026-10-23

### Added
- Support Codex native `/goal`, `/goal <objective>`, `/goal pause`, `/goal resume`, and `/goal clear`, with optional explicit token budgets on activation or resume. Goal state and continuation remain owned by Codex's thread-goal APIs, without prompt-based continuation loops.
- Keep goal output, approvals, activity, and thread admission attached across native continuation turns. Status and stop controls remain available during execution; unsupported backends fail without forwarding goal text to a model.

### Changed
- Initially require managed delegation disabled and an empty queue before activating a goal. Preserve native goal state on process loss and require explicit recovery; avoid accidentally resuming goals through status queries. Threads that never use native goals retain their existing execution path.

### Tests
- Cover command parsing, explicit budgets, native lifecycle transitions, multi-turn output ownership, stop and recovery behavior, unsupported versions, queue/settings exclusion, and unchanged ordinary execution.

## [1.6.171] - 2026-10-23

### Fixed
- Use the native Feishu Card 2.0 collapsible panel for completed-card thread controls. Expanding or collapsing the list requires no application callback or message PATCH, avoiding the previous PATCH-before-callback-response path that could immediately revert the expansion.
- Keep thread selection and New controls inside the panel, with reply-source information outside it. Hidden controls remain included in recursive card budgets; existing backend execution, thread routing, and protocol behavior are preserved.

### Tests
- Cover native panel payloads, generated non-default thread selections, reply-source preservation, recursive budgets, and existing card fallback and Worker controls.

## [1.6.170] - 2026-10-22

### Reverted
- Revert the 1.6.169 thread-card presentation change, restoring the always-visible thread controls and 150-node recursive card budget from 1.6.168.

## [1.6.168] - 2026-10-18

### Added
- Open bare `/cd` as a directory-only browser when both peers negotiate `directoryCards` and `settingsCards`. Navigate child/parent/root directories without executing a backend; apply only with Use this directory and preserve text `/cd <path>` for all peers.
- Bind bounded local listings to owner, thread/configuration, allowlist, expiry, canonical roots, directory and ancestor identities. Omit symbolic-link directories, stop at the nearest allowed root, explicitly report partial listings, and reuse budgeted card rendering and exact-request receipts.

### Changed
- Serialize card and text directory changes through shared settings admission, reject active/queued/delegated work, and preserve existing all-backend context reset, same-directory no-op, and delegation workspace-generation cleanup. External filesystem races and bind mounts remain outside the application-level isolation guarantee.

### Tests
- Cover directory-only browsing, roots, busy navigation, changed identities/ancestors, symlinks, stale/forged/expired selections, duplicate Apply, text compatibility, card budgets, and optional capability negotiation.

## [1.6.167] - 2026-10-17

### Fixed
- Expand terminal Worker card summaries from 1000 bytes to 4 KiB for Router 1.6.167 or newer, retain UTF-8-safe beginning/end excerpts, and accept the full summary through Router validation and rendering. Older or unknown Routers retain the legacy budget; strict version precedence excludes 1.6.167 prereleases, and current registration metadata is rechecked after reconnect. Full delegated results and continuations retain their existing 32 KiB and 64 KiB limits.
- Render worker result excerpts containing standalone omission markers as escaped literal text with a separate explanation, preventing head/tail splices from reinterpreting orphaned Markdown fences, links, tables, or card markup. Intact result Markdown and streaming activity formatting remain unchanged.

### Tests
- Cover larger ASCII/Unicode summaries, retained conclusions, legacy omission markers, Markdown and card-tag safety, Router boundary validation, and atomic Worker pagination under node, size, and table budgets.

## [1.6.166] - 2026-10-14

### Fixed
- Normalize Claude native tool-result content blocks to text before forwarding; ignore embedded media and unknown payloads instead of passing them to string-only consumers.
- Exclude native tool-result payloads from raw stdout logging before normalization.
- Ignore non-string input in local-image detection and contain optional image-forwarding failures without terminating the CLI or failing an otherwise successful task. Preserve web-result exclusions and directory/size checks.

### Tests
- Cover mixed Claude content blocks, malformed image-detector input, asynchronous tool-result scan failures, final-output failures, and subsequent task execution.

## [1.6.165] - 2026-10-14

### Fixed
- Reserve a selected Pi session file before asynchronous startup across threads in one daemon. Failed or unknown cleanup keeps the file quarantined until recovery; this is not an OS or cross-process writer lock.
- Require successful pointer persistence before acknowledging Pi connection or detach. Failed writes retain the previous association; cancelled startup cannot commit a new connection.
- Serialize Pi session confirmations with settings admission and reject context changes during queued work, active delegated tasks, or automatic updates. Claude Code and Codex remain read-only catalogs with unchanged executor and history behavior.
- Discover default Pi sessions under `PI_CODING_AGENT_DIR`, fail closed for unresolved agent roots, and shell-quote Pi-only local reopen guidance.

### Tests
- Add concurrent-confirmation, persistence-failure, restart, cancellation, settings-conflict, custom-directory, and non-Pi read-only regressions.

## [1.6.164] - 2026-10-14

### Fixed
- Give newly created Pi foreground sessions a default name based on their independent native session ID, not the reusable remote thread ID. `/new` sessions are distinguishable in `/resume`, and reopening a persisted file no longer appends `--name` or overwrites names assigned locally. Adopted sessions and synthetic runtime naming remain unchanged. Existing duplicate names are not rewritten automatically.

## [1.6.163] - 2026-10-14

### Changed
- Pi foreground `/new` and `/clear` now remove only the current association and preserve native session history for `/resume`. Fresh conversations use independent random IDs rather than the stable remote thread ID, so retained files cannot resurrect cleared context, including after restart before the next prompt.
- Pi foreground thread-data deletion also preserves native history. Delegated-worker and temporary metadata runtimes retain their disposable cleanup and thread-ID behavior.

### Tests
- Cover foreground A to `/new` to independent B, ordinary messages remaining in B during an unconfirmed resume draft, and confirmed native switching back to A. Cover reset/restart identity separation and unchanged synthetic-runtime cleanup.

## [1.6.162] - 2026-10-13

### Changed
- Remove `/session release`, the executor release operation and the persisted released-state gate. Existing adopted pointers with an old released flag remain usable; `/session detach` still confirms association removal without deleting native history.
- Reload and verify the exact adopted Pi session before every remote prompt, including native slash prompts, so sequential local writes are visible without another remote resume or release step. Idle local Pi windows may remain open, but must resume the same file before their next turn. Simultaneous writing is unsupported and can create separate native branches; no automatic local refresh or writer exclusion is claimed.
- Reserve remote turn preparation against overlapping execution/context changes and cancel preparation before prompt dispatch on abort/reset/shutdown. Keep legacy private sessions and worker execution unchanged.

### Fixed
- Synchronize the lockfile package versions with all package manifests.

## [1.6.161] - 2026-10-13

### Added
- Reserve `/resume`, `/r` and `/session` as program-owned native session controls before executor construction, working-directory changes, queue admission or backend slash passthrough, and remove the misleading natural-language resume shortcut. Local session sharing stays disabled by default; enabling it never makes an unverified adapter available.
- Add read-only native session discovery for Pi, Codex and Claude Code: `/resume` lists the current workspace's sessions (bounded reads, no backend process, no transcript text, no symlink following), hiding synthetic, delegated-worker, sidechain and ambiguous duplicate entries and reporting incomplete coverage. Message counts stay unavailable where they cannot be read safely.
- Add paging and search to the read-only list: each list is a snapshot with an unguessable 12-character token, eight rows per page and a five-minute lifetime, bound to the requesting user, thread and workspace; `/resume page` and `/resume search` never reread native stores.
- Connect a thread to an existing Pi session and continue its history. `/resume select` or `/resume id` shows a confirmation naming the session and any binding it replaces, and `/resume confirm` connects it. The loaded identity is verified through Pi RPC state without sending a prompt, so a silently substituted session is refused and the previous conversation is restored.
- Add `/session` binding status, `/session release` (stop the owned Pi process and block remote work so a local Pi can take over) and `/session detach` (forget the association after confirmation). Adopted native history is user-owned: `/clear`, detach and `/thread delete` never delete it. A session held by another remote-cli thread, or changed locally after selection, is refused.
- Add `remote-cli session show --thread <name> --backend <key>`: a read-only, daemon-free helper printing exact native reopen guidance.

## [1.6.160] - 2026-10-14

### Changed
- Remove the backend card's Confirm section. Backend choices submit immediately using the selected scope, defaulting to Current thread, while Choose backend remains above Apply to. Scope buttons only change the next backend click's target; keep that scope within the same card after acknowledgement. Show only the acknowledged backend as selected, disable further changes while pending, and preserve exact-request retries and stale-revision validation. Follow global applies immediately to the original thread and restores the local scope to Current thread after acknowledgement. Existing CLI settings actions and text commands remain compatible.

## [1.6.159] - 2026-10-12

### Fixed
- Allow delegated `git worktree add` and `git checkout` commands up to 120 seconds so larger working trees can finish preparing. Other Git commands and nested object transfers retain their 15-second deadlines. Timeout messages identify the worktree subcommand and report elapsed time and the deadline without including paths or checkout references. Preserve child-exit waiting, kill escalation, output limits, task reservations and cancellation ordering.

## [1.6.158] - 2026-10-09

### Fixed
- Keep the completion note, optional execution metadata and thread controls with the final body item or complete worker group when they fit together within continuation-card node, size and table budgets. Avoid a preventable footer-only continuation, including replies without execution metadata; retain the body when refreshing thread controls. Oversized indivisible groups still respect capacity limits. Streaming, queue confirmations and bare settings cards retain their existing behavior.

## [1.6.157] - 2026-10-09

### Changed
- Restore colored status badges in the `/delegation` card's backend-availability section: blue for the coordinator, green for installed workers, orange for blocked workers, red for unavailable backends and neutral for unknown worker availability. Preserve literal detail escaping, card capacity accounting and acknowledged On/Off controls.

## [1.6.156] - 2026-10-09

### Added
- Add a thread-scoped `/delegation` settings card with blue checked On/Off controls and a separate backend-availability section. Clicks submit immediately, update selection only after durable CLI acknowledgement, and preserve pending/unknown states and exact-request retries. Running work and queued commands block mutation, not inspection or refresh; reset remains a separate text command.
- Negotiate `delegationCards` in addition to `settingsCards` on protocol v1. Older peers retain the existing delegation status text and parameterized commands. Reuse immutable snapshots, ownership checks, admission barriers and native cleanup for card/text toggles; distinguish the enabled preference from sandbox restrictions, installation, authentication and quota.

## [1.6.155] - 2026-10-09

### Changed
- Show all model and effort choices when the complete settings card fits its recursive node and UTF-8 JSON budgets. Paginate only oversized catalogs, packing each page by actual capacity instead of a fixed eight-choice limit. Count headers, sections, backend groups, navigation, notices and pending/retry controls, preserve every opaque choice and retain existing callback validation and single-card delivery.
- Highlight the drafted backend application scope in blue. Separate the current thread's main backend from other backends' worker preferences in model/effort cards, keeping the main role tied to the coordinator while viewing other targets. Preserve same-backend preference sharing, explicit backend confirmation and immediate acknowledged model/effort changes; no native request or protocol capability is added.

## [1.6.154] - 2026-10-09

### Changed
- Separate backend, model and effort cards into numbered functional sections with subtitles and dividers. Mark the drafted backend, applied backend and selected scope explicitly; keep Confirm separate. Model/effort cards separate the target backend, native choices and secondary actions, checking configured or known effective selections without guessing defaults. Include all new section elements in recursive node and byte accounting; retain existing validation, acknowledgements and old-peer behavior.
- Accept both tab-delimited and formatted multi-space AGY model catalogs, preserving opaque native IDs and exact current-model matching. Reject empty, unusable and oversized responses explicitly instead of silently producing an empty or truncated menu. Query native metadata only; never prompt a model to invent catalog entries.
- Bound filesystem verification to eight concurrent checks and drain all started work before propagating failure. Share complete ancestor-validation promises within each checkpoint pass, and give checkout byte readers independent buffers up to 1 MiB each. Preserve every file hash, symlink/mode check, HEAD/index recheck, both working-file passes and both reclamation audits; do not cache state across captures or relax production deadlines.
- Replace real startup/stop waits in mocked Claude executor tests with controlled clocks. Advance the nested transfer timeout only after real producer/receiver startup and a nonempty partial pack, retaining process-exit and quarantine-cleanup assertions. Generate document ZIP fixture CRCs with a lookup table while preserving identical archive bytes, full expansion-bomb payloads and the full publish test suite. Use at most four isolated Git test processes only on hosts with at least eight available CPUs; lower-core limits and ordinary test deadlines are unchanged.

## [1.6.153] - 2026-10-09

### Changed
- Keep real Git suites in isolated processes while allowing up to two Git forks on hosts with at least four available CPUs and one to four lightweight threads. Reuse only pristine test fixture templates, copying repository metadata and files into independent owned directories for every test. The publish lifecycle still runs the entire suite without changing production Git checks or ordinary deadlines.
- Fill Codex shell-call labels for absent and native unknown command actions with bounded fixed operation descriptions. Simple allowlisted programs receive labels such as Run npm command; compound or unrecognized commands stay generic. Preserve native read/search/list descriptions and every operation in compound action sets. Never copy shell arguments, complete paths, execution output, or turn-level reasoning into fallback headings, and do not claim model-authored purpose summaries.
- Forward optional public native titles and allow later action metadata to enrich a pending tool row before its first result. Suppress duplicate starts after a result so repeated completion updates retain the original invocation. Reuse existing tool metadata, compact heading limits, asynchronous status updates, and card-element accounting without a wire-version change or extra model call.

## [1.6.152] - 2026-10-08

### Added
- Negotiate standalone backend, model, and effort settings cards on protocol version 1. Backend selection defaults to the original current thread; selecting a backend or device-wide scope only edits a draft until Confirm. Model and effort choices submit immediately, including preferences for an inactive target backend without switching the coordinator. Missing backends remain disabled; unavailable native catalogs and model-specific effort controls are explicit rather than generated from prompts.
- Bind immutable choices to the original owner, device, thread, working context and configuration revision. Serialize native changes and persistence with affected command admission, invalidate stale menus, and acknowledge only confirmed changes. Bound snapshot and retry receipts, paginate choices with recursive card-node and byte accounting, and preserve parameterized text-command semantics and older-peer fallbacks. No backend installation, credential mutation, live deployment or inference is performed to build menus.

### Changed
- Use native structured model and effort metadata, including grouped ACP choices, model-specific Pi thinking levels, bounded AGY model rows, and capability-gated Claude control initialization. Keep configured selections distinct from native reports and defaults. Isolated metadata identities inherit policy resolved under the real thread ID, never share coordinator/Worker pointers, and clean up only their own confirmed-exited data. Claude model updates also maintain its legacy preference field.
- Bound ACP control requests without timing out normal inference, preserve opaque native IDs, refresh Claude capabilities per process, and reject incompatible model/effort changes rather than silently changing a second preference. Release known temporary ACP sessions before transport shutdown and defer own-pointer cleanup after a timed-out query until settlement and confirmed exit.

## [1.6.151] - 2026-10-08

### Changed
- Reduce delegated Git checkpoint subprocesses by reading paths, conflict stages, and hidden-entry flags together from each private index. Resolve the source index path once per pass and audit identical content-addressed trees once per capture; retain both full working-file passes, source HEAD/index rechecks, copied-index timestamps, nested-repository validation, and independent checkout byte audits. Reject existing zero-byte indexes instead of treating corrupt metadata as missing; legitimate missing and serialized zero-entry indexes remain supported. No state is cached across captures and Git deadlines are unchanged.
- Bound real Git integration suites to one isolated process alongside at most two lightweight test threads. Keep ordinary test and hook deadlines unchanged; give historical delivery the same explicit 30-second budget as other Git suites. Release controlled lifecycle gates in finally blocks, cover slow collection and early assertion failure, and guard subprocess counts against regressions.

## [1.6.150] - 2026-10-08

### Added
- Notify about Codex Banked Reset balance increases using the existing independent startup/hourly status read and native `rateLimitResetCredits.availableCount`. First observations and account switches are silent; compare each valid count with the previous valid count for that account, not a historical maximum. Decreases update the baseline without notifying, and missing or invalid fields remain unknown rather than zero.
- Reuse standalone, notification-only quota cards and delivery acknowledgements, with previous/current balances and the increase. Keep banked-credit events separate from weekly quota delivery suppression, cancel pending notices on observed consumption/account changes, and retry only the latest pending event. Retain up to 1,000 banked delivery receipts in Router memory until notice expiry, including in-flight reservations, so lost-ACK retries across CLI reconnects revalidate ownership and acknowledge the existing card instead of sending duplicates; action bindings remain connection-scoped. A new additive `bankedResetReminder` capability prevents old Routers from mislabeling banked-credit notices. No extra native read, model request, credit consumption, expiry warning, or persisted balance is introduced.

## [1.6.149] - 2026-10-07

### Changed
- Forward AGY's native per-call `toolSummary` and fallback `toolAction` as tool descriptions while preserving explicit descriptions and titles. Terminal results keep the original invocation identity and do not synthesize new calls or copy execution-wide activity into labels.
- Describe Codex's structured `commandActions` as file reads, searches, and directory listings. Use file basenames only, omit raw commands and search arguments, and leave absent, unknown, or partly unknown action sets unlabeled. Reserve omitted-label counts within the existing 60-character heading budget. Reuse existing description fields and compact headings without additional model calls, protocol changes, or card elements.
- Preserve Codex's native web search, open-page, and find-in-page actions and result entries instead of reporting empty output. Foreground tools show up to five bounded titles, source links, and snippets in the existing output node, with explicit omitted-entry counts and distinct missing, unsupported, and empty-result notices. An additive optional result preview retains a plaintext fallback for older Routers; source links are revalidated and result text is rendered literally. Delayed result updates keep the original invocation slot and recursive pagination limits.
- Accept AGY's native lowercase `query` as well as legacy `Query`, and preserve non-string tool outputs as JSON alongside any supplied failure explanation instead of discarding either. Add web-result passthrough regressions for Claude, shared ACP backends (OpenCode, Kimi, ZCode, DSH), and Pi without assuming unavailable native samples were verified.
- Treat structured web previews and recognized web-tool results as display data, not local-image instructions; repeated results retain their origin until an explicit new call reuses the ID. Ordinary local-tool image forwarding remains available. Prefix every native fallback field so untrusted snippets cannot close older Routers' fixed code fences.

## [1.6.148] - 2026-10-07

### Changed
- Use a consistent dot in every foreground tool heading: green after success, blue while awaiting a result, and red after failure. Preserve per-call labels, explicit expanded status text, fixed-slot asynchronous updates, and recursive card-node counts without adding elements.

## [1.6.147] - 2026-10-07

### Changed
- Prefer meaningful backend-provided per-call descriptions and titles in foreground tool headings, falling back to file basenames and omitting redundant tool-name labels. Preserve ACP call/update titles and explicit AGY/Pi parameter labels that tool mapping previously discarded; never synthesize a call to refresh a terminal-result title.
- Carry optional tool labels over the existing version-1 stream without new capabilities or model calls. Keep execution-wide activity separate, retain fixed-slot asynchronous result updates, and verify unchanged recursive card-node budgets through pagination and shrink.

## [1.6.146] - 2026-10-07

### Changed
- Use one compact foreground tool heading for Bash and other tools: a gray success dot, pending hourglass, or gray failure cross, followed by the tool name and an optional bounded public description or file basename. Keep raw commands out of headings and move full tool IDs and explicit status labels into the existing expanded details.
- Preserve input, result, diff previews, stable call identities, and existing cross-card cleanup. Verify recursive tagged-node counts at the card boundary through delayed results, activity tails, and completion controls; no multi-call aggregation, execution, or wire-protocol change.

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
