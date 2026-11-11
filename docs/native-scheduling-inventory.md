# Native scheduling inventory

Initially assessed on 2026-11-10 against remote-cli baseline `e2a0d053`
(1.6.231), with protocol eligibility rechecked on 2026-11-11 for the
1.6.232 implementation.
This inventory separates native product features, installed implementation
evidence, transport reachability, and executed integration tests. The current verdicts below use native runtime or complete implementation
evidence; missing documentation alone is not treated as proof of absence.

## Scope and implementation boundary

The intended workflow is create a one-shot task, let the native backend wake
without a new user message, return its result to the originating remote-cli
thread, inspect/cancel tasks, and extend the same capability-based interface to
recurring tasks. Native backends own timing. Router cron, periodic model prompts,
and third-party OS schedulers are outside this implementation boundary.

Installation does not prove authentication, feature entitlement, or runtime
availability. Pi and ZCode were absent during the initial inventory; the later
verification below inspected their official distributions. Native timer and
protocol probes are distinguished from real-provider and Feishu validation.

## Confirmed verdicts for all eight backends

The verdict is whether the native scheduler can deliver autonomous task outcomes
through the existing remote-cli backend transport. Supported native plugin
composition and event adapters are allowed; writing another scheduler, polling
models, patching the installed backend, or replacing its transport is not.
These are version-specific findings, not claims about all future releases.

| Backend and version | Native timing | Verdict and decisive evidence |
| --- | --- | --- |
| Claude Code 2.1.311 | Yes, native Cron tools and wakeup lifecycle | **Supported.** One-shot and recurring idle execution were verified; the implemented provider joins native lifecycle IDs to results. |
| Codex CLI 0.167.0 | No standalone scheduled-job engine | **Not supported.** Complete tool/feature/service inspection and real app-server dispatch show automation execution belongs to a client-supplied dynamic tool. Native sleep only waits inside a turn. [Verdict](codex-native-scheduling-verdict.md). |
| AGY 1.5.5 | Yes | **Not supported on the tested stream-json route.** Two daemon cron firings called the synthetic provider during 135.030 seconds idle with zero stdout frames; both responses appeared only after cleanup input and shared its result. Supported plugin/hooks do not expose the parent stream writer. [Fresh probe and option review](agy-1.5.5-scheduling-verdict.md). |
| DSH 0.2.1-rc.5 | Yes, first-party native scheduler | **Supported with an ACP host adapter.** Supported plugin overlays mount the native scheduler and translate public native events into ACP extension notifications. Fresh native timer probes delivered correlated success and failure while input remained idle. Stock ACP alone omits terminal events. [Verdict](agy-kimi-dsh-native-scheduling-verdict.md), [integrated provider and native tests](dsh-scheduling-implementation.md). |
| OpenCode 1.19.5 and 2.2.7 | Absent in 1.19.5; present in 2.2.7 | **Not supported over the current ACP bridge.** The installed 1.19.5 has no scheduler. The 2.2.7 scheduler runs natively, but ACP closes root-output subscriptions after each prompt; its background-child exception filters out root events. [1.19.5 inventory](opencode-pi-native-scheduling-verdict.md), [2.2.7 trace](opencode-2-native-scheduling-verdict.md). |
| Kimi 2.5.0 | Yes | **Not supported over current ACP.** Native output and terminal handlers require a matching active client-prompt driver. Complete supported configuration and method branches provide no bypass. [Verdict](agy-kimi-dsh-native-scheduling-verdict.md). |
| Pi coding-agent 1.5.2 | No built-in scheduler in this CLI | **Not supported.** Complete built-in tools, extensions, and runtime composition contain no native timed-job engine. Actual extracted-package RPC works; the durable timer library is a separate runtime. [Verdict](opencode-pi-native-scheduling-verdict.md). |
| ZCode 3.17.2 / bundled CLI 0.17.1 | Yes in the desktop host composition | **Not supported by standalone app-server.** Five real native management turns confirmed reverse host RPCs. Persistence, native timing, and dispatch belong to the separate desktop host/scheduler, not this CLI process. [Verdict](zcode-native-scheduling-verdict.md). |

Pi and ZCode were downloaded from official distributions and inspected/executed
in isolation. Their absence from the global installation is not a rejection
reason. Synthetic provider fixtures exercised native protocol and dispatch without
using credentials or relying on a model's verbal claim of capability.

## Backend admission

All eight entries are represented in a typed capability registry. Creation uses
the same registry as `/schedule capabilities`, so each unsupported backend
returns its own transport/native-capability gap without silently selecting
Claude or starting another scheduler. A supported entry still requires native
runtime capability checks; installation and product documentation alone do not
satisfy admission. Unknown backend keys are rejected.

Existing tasks keep their captured native session when the foreground backend
changes. List and cancel operate on those tasks independently of the newly
selected backend, including when that backend is temporarily unsupported.

The earlier Claude-only admission update passed both package builds and 233 selected tests
on Linux, including all scheduling tests and test-runner configuration tests.
Scheduling coverage was 98.43% statements/lines, 89.07% branches, and 100%
functions. This supplements the earlier full-suite evidence below; native
macOS/Windows and real Feishu delivery were not run in this pass. At the time of that
validation, version 1.6.232 was an uncommitted, unreleased change set.

The [independent host-boundary review](scheduling-host-adapter-boundaries.md)
checks that OpenCode and ZCode remain ineligible even when applying the same
supported native plugin/event-adapter standard used for DSH.

## Dormant scheduling for ordinary users

Connection and reconnection check for an existing catalog without creating one.
When no catalog exists, ordinary chat, control, and update paths do not initialize
ScheduleService, register delivery listeners, or start native schedule processes.
Explicit schedule management initializes the service on demand. Existing catalogs
still restore interrupted-job status and retry their pending-result outbox.
Initialization is shared across first use and reconnect and guarded against
shutdown races. Malformed catalogs fail scheduling recovery without blocking chat.
Regression tests cover these boundaries with scheduling negotiation enabled and
disabled, including ordinary recovery and queue behavior.

A subsequent shutdown regression reproduced loss of an offline recurring result
when native cleanup emitted `stopped`. Shutdown now preserves completed outbox
entries while real ownership changes and explicit cancellation still discard
them. Handler-level tests cover stop, restart, reconnect, and acknowledgement
for both supported backends without recreating native jobs. The fix passed 368
focused tests with 98.85% scheduling line coverage and 88.30% branch coverage;
a subsequent early-create/shutdown regression passed with all 56 service tests.
Independent follow-up checks found no remaining blocker in that scope.

The final dormant-initialization revision passed both package builds and the full
Linux CLI suite: 221 files, 5,202 passed tests, and 14 conditional skips. The Router
regression selection passed 463 tests across four files; the preceding full Router
run passed 1,905 tests. These local results do not claim native macOS/Windows or
real Feishu execution. Release CI supplies separate cross-platform evidence.

## Final combined acceptance on Linux

The integrated 1.6.232 change set enables Claude and DSH through the shared
command/catalog/outbox path and accepts both backend identities in Router
scheduled-result validation. Backend identity cannot change between the admitted
start and its result. The six rejected backends retain explicit version-scoped
reasons, including the fresh AGY 1.5.5 native probe linked above.

- Both package builds passed. All versions and lockfile entries remain 1.6.232;
  the native-schedule sections of both READMEs match.
- The full CLI suite passed 221 files and 5,186 tests, with 14 deliberate
  platform/capability/native-probe skips. After the independent review fixes,
  318 focused scheduling/handler tests passed, including six new regressions.
- Final scheduling-module coverage: 98.85% statements/lines, 88.23% branches,
  and 99.35% functions. Each new DSH source module exceeds 80% line and branch
  coverage.
- The final Router full suite passed 72 files and 1,871 tests. Its 52 scheduled
  result tests run all admission, original-thread routing, error, reconnect,
  deduplication, and acknowledgement scenarios for both Claude and DSH.
- Five concurrent, isolated real DSH 0.2.1-rc.5 probes passed through the compiled
  host bridge, ScheduleService, persistent outbox, and ScheduleDeliveryClient
  with in-memory Router receipts. They verified once success, native failure,
  timezone-specific cancellation, nested-schedule rejection, and a recurring
  firing. One-shots used the shared command contract's minute alignment. Every
  process tree exited and each owned native store was removed.
- Independent review findings were fixed: native same-turn tool context no
  longer creates/replaces an occurrence, and failed service shutdown cleanup can
  be retried while admission stays closed. Regression cases still reject foreign
  agents, wrong turns, and context without a schedule occurrence.

Native probes use deterministic model fixtures. Real Feishu delivery,
authenticated DSH inference, and native macOS/Windows runs were not performed.
These are execution-test boundaries, not unresolved backend eligibility
verdicts. That validation pass did not commit, push, publish, or deploy.

## Timing, ownership, and recovery

- **Claude:** host-local timezone, minute resolution, and approximate execution
  with jitter. One-shots near `:00`/`:30` can fire early; recurring jitter can
  reach 30 minutes. Recurring tasks normally expire after seven days. Resume
  restores eligible tasks, excluding overdue one-shots; recurring schedules do
  not replay downtime. Durable creation is separately gated, and a requested
  durable task may be returned as session-only. Check the returned state.
- **AGY:** native timezone-prefixed cron was accepted and listed, but actual
  timezone/DST firing and restart durability remain unverified. In the live
  recurring probe, results surfaced only after a new input; standalone
  occurrence completion was not established.
- **DSH:** intervals are at least 60 seconds. Daily/weekly/cron use explicit
  IANA zones, skip DST gaps, and use the earlier overlap instant. Restart keeps
  only the latest missed recurring occurrence. The host must run. A receipt
  proves inbox delivery, not model completion. Separate Session/task writes
  can duplicate delivery after a crash; restoration failures have no automatic
  retry timer. Deleting a task does not retract messages already queued.
- **Kimi:** host-local timezone, seven-day recurring expiry, busy deferral and
  missed-run coalescing. Restoring the original session restarts its scheduler;
  a stopped process cannot fire. Native core correlation does not mean ACP
  delivers those events to a client.
- **ZCode:** the app must remain open and the computer awake. Missed one-time
  runs are skipped. Recurring catch-up/crash guarantees were not established.

The existing executor callbacks generally belong to a user-initiated turn and
are cleared at completion. An autonomous run needs its own execution context,
original-thread ownership, lifecycle/terminal correlation, approval handling,
and delivery recovery. A background task notification is not a schedule result.

## Pilot acceptance gates

1. Observe native scheduling tools and lifecycle support in the actual process;
   reject unavailable capabilities without substituting a scheduler.
2. Create a bounded one-shot with a synthetic response, keep the process idle,
   observe its autonomous start/output/completion, and join its native IDs.
3. Verify list/cancel using actual native tool results, including errors and
   ambiguity; model prose alone must never be a creation receipt.
4. Establish original-thread delivery, separate foreground/autonomous turns,
   approval behavior, cancellation races, shutdown, and reconnect handling.
5. Extend only proven behavior to recurring jobs and the common interface.
   Expose limitations for every backend rather than advertising universal
   scheduling support. Test the adapter with deterministic protocol fixtures
   and separately report native end-to-end evidence.

## Evidence

The initial inventory used official documentation, installed package/executable
source, version/help output, and remote-cli adapters. It did not execute models
or create schedules. Subsequent live-probe evidence is recorded separately.

### Initial eligibility recheck (superseded by the confirmed verdicts above)

The [AGY protocol review](agy-scheduling-protocol-review.md) records three live
synthetic probes through the existing stream-json transport. Native management
worked, but autonomous recurring delivery failed in the tested workflow. The
one-shot response shared setup completion, so it also lacks a verified separate
occurrence boundary. All probe processes exited; no Feishu message was sent.

The [six-backend review](native-scheduling-backend-review.md) distinguishes
Kimi's confirmed upstream idle-output filter, DSH's missing host composition and
completion contract, and the unverified native paths in Codex, OpenCode, Pi,
and ZCode. Local filtering or Cron deny flags alone are not proof that a native
protocol cannot work. These six were inspected without model runs. That initial pass did not establish another adapter. The subsequent DSH
composition probe above supersedes its rejection: a supported host plugin can
translate native terminal events over ACP without adding a scheduler.

### Bounded Claude native probe

A fresh Claude Code 2.1.311 stream-json process advertised `CronCreate`,
`CronList`, `CronDelete`, `msg_lifecycle_v1`, `request_marker_lists_v1`, and
`lifecycle_wakeup_source_v1`. With stdin held open, both a recurring job and a
one-shot fired autonomously and returned only synthetic text. Native deletion
cancelled the recurring job after one firing and another one-shot before it
fired. The completed one-shot auto-deleted. Final native listing was empty and
all probe processes exited. No Feishu message was sent by this probe.

The observed sequence was `command_lifecycle` started with
`wakeup_source: schedule_wakeup`, assistant output, a terminal `result`, then
`command_lifecycle` completed with the same command UUID. The idle result had
neither `user_message_uuid` nor `user_message_uuids`, and no
`scheduled_task_fire` frame appeared. Overlapping management prompts could fold
into one result containing both request UUIDs. Therefore the initial adapter
uses one job per native process, serial management turns, and a permanent
lifecycle listener. It does not infer job identity from an absent result field.

The probe used explicitly session-only jobs and disabled transcript persistence.
It did not test native durable restoration, Feishu delivery, or native Windows
and macOS execution. Existing authentication remained available with safe mode;
removing all settings sources did not preserve authentication in this setup.

### Earlier Claude implementation acceptance

The initial implementation adds `/schedule after`, `/schedule at`,
`/schedule cron`, `/schedule list`, `/schedule cancel`, and capability reporting.
The service persists immutable ownership and bounded pending results, while the
Claude native process owns timing. Explicit list requests reconcile the native
inventory; there is no recurring management polling. Context/directory/sandbox
changes require cancellation of active jobs. Unconfirmed process exit retains
cleanup ownership and blocks automatic update/context admission.

On 2026-11-11, the combined implementation was exercised with real Claude
processes and an in-memory Router receipt boundary. Both one-shot and recurring
jobs autonomously invoked a harmless Node command through the ordinary Bash
tool and returned synthetic text. The provider, catalog service, and delivery
client preserved the original synthetic owner/thread and waited for result
acknowledgements. The recurring job was cancelled after its first delivery; the
one-shot reached completed state. Both native processes exited and temporary
state was removed. This test did not send real Feishu messages.

Linux verification: both package builds passed; all 218 CLI test files passed
(5,068 tests, nine platform/capability skips), and all 72 Router test files passed
(1,845 tests). The first CLI full-suite attempt forced the fork pool and failed
the test that explicitly requires the configured thread pool; the normal
repository configuration passed. Native macOS and Windows execution and real
Feishu delivery remain unverified. No commit, publication, or deployment is part
of this implementation task.

After the full-suite run, the final shutdown-retry and late-exit fixes passed all
196 focused scheduling tests and CLI compilation. Scheduling-module coverage was
98.38% statements/lines, 88.82% branches, and 100% functions. Those tests include
native protocol fixtures, command/ownership integration, result receipts,
disconnection retries, and cleanup admission; they do not substitute for native
macOS/Windows or real Feishu execution.

The first adapter is session-only and text-result oriented. It does not copy the
foreground conversation, restore native jobs after a process restart, provide
managed delegation inside scheduled tasks, or negotiate interactive approvals
for them. Restricted sandbox configurations are rejected. Local result outbox
retries and bounded process-local Router deduplication do not provide
exactly-once delivery across crashes.

- Claude: [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks),
  [Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript),
  [headless operation](https://code.claude.com/docs/en/headless). Installed
  2.1.311 source contains `command_lifecycle`, `wakeup_source`,
  `scheduled_task_fire`, and optional result user-message UUIDs; a cron-job ID
  must not be assumed to appear on every wire event.
- Codex: [CLI scheduling](https://learn.chatgpt.com/docs/automations.md?surface=cli),
  [app scheduling](https://learn.chatgpt.com/docs/automations.md?surface=app),
  [app-server](https://learn.chatgpt.com/docs/app-server.md).
- AGY: [schedule](https://antigravity.google/docs/commands/schedule),
  [headless protocol](https://antigravity.google/docs/cli/headless/),
  [sidecars](https://antigravity.google/docs/sidecars).
- DSH: installed first-party `@deepseek-ai/dsh-schedule/README.md`,
  `lib/index.js`, and `lib/typert.remote-client.d.ts`; composition in
  `@deepseek-ai/dsh-app-boot/lib/index.js`; handlers in
  `@deepseek-ai/dsh-acp/lib/index.js`, all from the installed rc.5 distribution.
- OpenCode: [versioned ecosystem](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/web/src/content/docs/ecosystem.mdx),
  [versioned server contract](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/web/src/content/docs/server.mdx).
- Kimi: [official tools](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/tools.html#scheduled-tasks),
  [ACP turn filtering](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/acp-server/src/session.ts#L758),
  [native service](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/agent-core-v2/src/features/cron/cronService.ts#L280).
- Pi: [extensions](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/extensions.md),
  [RPC contract](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/modes/rpc/rpc-types.ts),
  [separate durable harness](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md).
- ZCode: [automations](https://zcode.z.ai/en/docs/automations),
  [changelog](https://zcode.z.ai/en/changelog).

Versioned upstream sources and current product documentation are not evidence
that an unavailable local binary supports the same behavior. Native platform
testing, authenticated availability, and Feishu delivery require separate
verification.
