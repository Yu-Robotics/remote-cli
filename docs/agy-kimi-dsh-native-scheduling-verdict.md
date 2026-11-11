# Native scheduling verdict: AGY, Kimi, and DSH

Reviewed 2026-11-11 at remote-cli checkpoint
`197acdb382fc65f4016929a3bdc12ceba464a705`. This report supersedes the eligibility
conclusions for these three versions in [the backend review](native-scheduling-backend-review.md).
It preserves the measurements in [the AGY protocol review](agy-scheduling-protocol-review.md).

## Decision

| Pinned backend and transport | Verdict | Decisive evidence |
| --- | --- | --- |
| DSH **0.2.1-rc.5**, ACP stdio | **Supported as an implementable provider route**, using the first-party scheduler plus a host event adapter loaded through supported `--patch` composition. Not available from stock ACP configuration alone. | Two fresh native processes mounted the required first-party services without a web server. Native timers fired while ACP input was idle. An event-only plugin communicated correlated native success and failure terminal events as ACP extension notifications on the same stdout. |
| Kimi **2.5.0**, ACP stdio | **Not supported through the current CLI's supported settings.** | The installed ACP implementation requires a matching active prompt driver for assistant, tool, and terminal events. All session configuration branches and the CLI bootstrap were inspected; none changes that filter. |
| AGY **1.5.4**, stream-json | **Not supported for provider enablement on the established stream-json route.** | The existing 135-second idle probe emitted no frames; scheduled output appeared only after the next input, without separate occurrence completion. The inspected supported options and plugin surfaces supply no stream subscription/completion mode. Closed-source internals limit the stronger claim that every conceivable combination is impossible. |

“Supported” here means a concrete native timing and result-delivery integration
is possible without replacing the scheduler, changing transport, or patching the
installed backend. It does **not** mean a provider is implemented, production
tested, or enabled in this checkout. A transport adapter may translate native
events; it must not implement timers, prompt polling, or infer success from prose.

## Version and source identity

All three installed `--version` outputs were checked again. DSH's relevant
package manifests, including its ACP, scheduler, controller, tools, and agent
loop packages, all report **0.2.1-rc.5**. DSH citations below use installed package
names relative to the distribution's `node_modules/@deepseek-ai/`; line numbers
refer to the distributed JavaScript, not inferred upstream source locations.

| Inspected artifact | SHA-256 |
| --- | --- |
| AGY executable, 1.5.4 | `c77851d1fc99b45bb7fc1dc4cddf09f5b668418cc498f92a09c73cddbc696343` |
| Kimi executable, 2.5.0 | `289a8d33e5e76d7a280ebf273855b9b2d941c09fa6828cccf993c0666886fd6c` |
| `dsh-acp/lib/index.js` | `9df25827fbf2ac7c0b168f22e5bea151153c1492ef118511be96688dc3039989` |
| `dsh-schedule/lib/index.js` | `022b9f191b6ca0f4b0f26625afc49f375933068a42712c0a75e94e439d7e6d0e` |
| `dsh-api-session-controller/lib/index.js` | `a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386` |
| `dsh-agent-loop/lib/index.js` | `cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033` |

Kimi's readable reference is commit
[`41c341434ae24e45bfe0f2232ec11b80531ac717`](https://github.com/MoonshotAI/kimi-code/tree/41c341434ae24e45bfe0f2232ec11b80531ac717).
The critical compiled bodies were independently found in the installed
executable: `settleDriver` at byte 138007508, `driverFor` at 138007729,
`onTurnEnded` at 138012598, `setSessionConfigOption` at 138035132, and `setMode`
at 138018952. This corroborates the decisive version-specific branches; it is
not a claim that every byte of that executable matches the reference checkout.

## DSH: supported composition and authoritative event adapter

### The full first-party dependency closure can run with ACP

`dsh --help` advertises repeatable `--patch <path>` overlays after profile layers.
`dsh-app-boot/README.md` documents plugin rows, process-local module resolution,
and configuration replacement. This is a supported host plugin entry point.
No upstream modification, browser runtime, HTTP/SSE transport, or replacement
scheduler is necessary.

The successful overlay inserted these first-party packages into `dsh acp`:

```yaml
- insert:
    - id: connection
      name: '@deepseek-ai/dsh-client-connection'
    - id: file-upload
      name: '@deepseek-ai/dsh-client-file-upload'
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: session-controller
      name: '@deepseek-ai/dsh-api-session-controller'
    - id: schedule
      name: '@deepseek-ai/dsh-schedule'
    - id: tool-schedule
      name: '@deepseek-ai/dsh-tool-schedule'
```

The base already supplies agents, sessions, JSONL persistence, storage-domain,
attachments, commands, model services, session query/projections, and Typert.
The controller's **complete** required service list is in
`dsh-api-session-controller/lib/index.js:2917-2929`. Workspace supplies
`workspaceRegistry`; file-upload supplies `fileUploads` and requires
`connection` (`dsh-client-file-upload/lib/index.js:157-161`). Crucially,
`dsh-client-connection/lib/index.js:1022-1040` provides carrier-neutral registries
and mounts browser routes **only if `webServer` exists**. The probe mounted no
web server. Describing the controller as “Web-only, therefore impossible over
ACP” would be incorrect.

The scheduler's required services are declared at
`dsh-schedule/lib/index.js:1969-1975`. `resolveAgent` accepts the already-live
ordinary ACP agent (`dsh-api-session-controller/lib/index.js:365-368`); it does
not require that Web created it. Native child agents are explicitly excluded,
so a provider must create an ordinary top-level ACP session even when remote-cli
internally calls the process a worker.

The actual management paths are `dsh-tool-schedule/lib/index.js:496-646`:
`schedule_create/list/delete/update` call the native service for the caller's
session and return native JSON receipts. A missing direct ACP schedule CRUD
method is not a blocker. The probe used the same public `ctx.schedule.create`
service directly to eliminate model tool-selection uncertainty; it did not
exercise a live model's selection of those tools.

### What stock ACP loses, and how the supported plugin seam recovers it

The native route is fully traceable:

1. `dsh-schedule/lib/index.js:1493-1650` owns timing, serialization, due-task
   grouping, recurring advancement, and `setTimeout`. It resolves the session,
   constructs a message with `source.kind = "schedule"`, calls `agent.followup`,
   and requires an acknowledged session flush. Its delivery history records
   inbox admission, **not model success**.
2. `dsh-agent-loop/lib/index.js:99-110` publishes `agent/inbox/claimed` with the
   actual message and allocated turn. Native reminder framing at
   `dsh-schedule/lib/index.js:1393-1417` includes schedule ID and occurrence time;
   recurring framing carries a structured JSON array. Check the native source
   kind before parsing this framing; ordinary user/model text is not provenance.
3. `dsh-agent-loop/lib/index.js:936-1036` records `turn/start`, executes steps,
   and appends `turn/end` in `finally`. Completion, blocked execution, token
   exhaustion, errors, and cancellation have distinct native reasons.
   `dsh-session/lib/index.js:1580-1592` publishes committed log events to
   `session/event` observers. This is a declared public plugin event
   (`dsh-session/lib/types/index.d.ts:61`), not transcript scraping.
4. `dsh-acp/lib/index.js:879-927` forwards assistant/tool output even without an
   active prompt. Its `turn/end` branch only updates an existing prompt's state;
   `:929-936` associates that prompt with its admitted message. The complete
   request routing at `:1361-1366` and configuration schema at `:1102-1106`
   offer no autonomous terminal subscription. `agent/status` and `agent/error`
   handlers also do not publish an idle terminal result. Mounting only the six
   first-party packages above therefore does **not** complete the provider.

A small host plugin can subscribe to those native events and emit an
underscore-prefixed JSON-RPC notification on the existing ACP stdout. This is
an **adapter extension**, not an existing first-party DSH notification.
[ACP explicitly permits custom notifications beginning with `_`](https://agentclientprotocol.com/protocol/extensibility#custom-notifications).
The probe used `_remote_cli/native_schedule_probe`, with one complete JSON line
per `process.stdout.write`. It neither intercepted stdin nor changed the native
ACP module. No custom timer, scheduler, or repeated prompt was present.

The supported combination is therefore **native scheduler + supported host
plugin composition + permitted ACP extension**. If the requirement were instead
“only already-shipped standard ACP notifications, with no event adapter,” DSH
would fail at step 4. That narrower requirement must not be confused with the
allowed native-composition route evaluated here.

### Fresh bounded probes

Two isolated processes used `dsh acp --patch <absolute-overlay-path>`. Each had
fresh process-local `HOME` and `DSH_HOME` directories and telemetry disabled.
No existing credentials or settings were copied. The overlay added the six
first-party rows above and an absolute-path diagnostic host plugin. The ACP
row additionally injected the plugin's readiness service, ensuring all observers
were installed before `session/new`.

The diagnostic plugin's entire role was:

- On `session/created`, call native `schedule.create` with a synthetic title,
  prompt, and `after_seconds: 2`; retain the returned native ID.
- Subscribe to `agent/inbox/claimed` and `session/event` and relay schedule
  source, session, message, turn, and native terminal reason as ACP extensions.
- Intercept the documented `llm/stream` waterfall
  (`dsh-llm/lib/types/index.d.ts:32-47`) with a deterministic fixture. Success
  emitted a text block and `finish: {kind: "stop"}`; failure threw
  `Error("Synthetic provider failure")`. No real model, model tools, network
  inference, file tools, shell tools, or user data were involved.
- After native `turn/end`, delete the exact native schedule and list remaining
  active schedules. The client then closed stdin and awaited process exit.

The client submitted **only** ACP `initialize` and `session/new`; it never sent
`session/prompt`. Both processes had a 30-second overall deadline and bounded
shutdown escalation, which was not needed.

| Observation, seconds after process spawn | Success fixture | Failure fixture |
| --- | --- | --- |
| `initialize` response | 1.426 | 1.057 |
| Native create receipt relayed by plugin | 1.482 | 1.080 |
| `session/new` response | 1.490 | 1.084 |
| Native schedule inbox claim, while stdin idle | 3.451 | 3.082 |
| Native `turn/end` relayed by plugin | 3.489, `completed` | 3.178, `error`, code `UNKNOWN` |
| Standard ACP assistant text | 3.491, exact synthetic marker | None |
| Native delete/list receipt | 3.506, `deleted: true`, remaining 0 | 3.192, `deleted: true`, remaining 0 |
| Exit after stdin close | 0; process group absent | 0; process group absent |

Both traces were checked for equal create/claim/terminal session identity and
equal claim/terminal turn identity. The failure trace also carried the native
`agent/error` event before `turn/end`. A delivery receipt or assistant assertion
could not have distinguished these outcomes; the native terminal event did.

### Implementable provider route and required boundaries

Use one dedicated native process and ordinary ACP session per job, with owned
storage and the overlay above. Load an event-only provider plugin through an
absolute `--patch` plugin row and require a versioned readiness notification.
Use native model-tool receipts for management, or expose the same native service
through a separately implemented ACP extension; the latter is not a shipped
DSH CRUD endpoint. Preserve native authentication configuration without editing
global settings. Empty probe homes worked because inference was synthetic.

The adapter must bind native schedule ID plus occurrence time to the actual
scheduled message ID, then to the claimed turn. Collect output from native
`assistant/message` events for that turn and include the bounded result in the
terminal extension. **Do not finalize by concatenating ACP text received so far:**
the success probe's native terminal notification preceded standard ACP text.
Do not call an assistant chunk, `tool_call_update: completed`, or native enqueue
receipt a completed occurrence. Preserve non-success native terminal reasons;
on process death or missing terminal evidence, report interruption/unknown.

The provider needs a permanent extension listener. Current
[`AcpClient.ts:255`](../packages/cli/src/executor/acp/AcpClient.ts#L255)
ignores notifications other than `session/update`, and ordinary executors have
turn-scoped consumers. These are implementable local adapter changes, not native
scheduler or transport impossibilities. No such changes were made here.

Use native delete and verify its receipt before declaring cancellation. Deletion
leaves already-queued input intact (`dsh-schedule/lib/index.js:2154-2180`);
`session/cancel` also handles autonomous work (`dsh-acp/lib/index.js:865-870`).
Confirm child exit before releasing ownership. DSH schedules are **durable**:
process exit alone stops present execution but does not delete stored tasks.
Never reopen a retained job store automatically after stop or failed cleanup.
Cold controller restoration can also create an agent not owned by the ACP
session map; establish session ownership before allowing resumed delivery.

Source inspection covers recurring grouping, missed-occurrence coalescing,
rearming, disposal, error/cancel terminal branches, and durable receipts. These
probes establish mounting, real native one-shot timing, same-ACP delivery, and
success/failure correlation. They do not establish live-model CRUD, recurring
load, timezone/DST firing, restart races, descendant completion policy, or a
production-grade adapter. Acceptance tests remain necessary when implementing it.

## Kimi: no supported setting bypasses the ACP driver filter

The exhaustive relevant branch chain is:

- [CLI `acp` entry](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/apps/kimi-code/src/cli/sub/acp.ts#L30):
  only login/region options; forwards home and client/auth identity into
  `runAcpServer`. Root environment-selection flags are explicitly rejected.
  No CLI plugin/composition or autonomous-event option is passed.
- [Bootstrap](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/acp-server/src/start.ts#L94):
  creates the fixed engine, ACP session bridge, and client filesystem/terminal
  environment. `extraSeeds`, custom streams, and `disableAuth` are embedding/test
  APIs, not supported `kimi acp` flags. Replacing this bootstrap would be a new
  host implementation, not a session setting in the existing executable.
- [Session creation and configuration](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/acp-server/src/server.ts#L472):
  `set_config_option` accepts exactly `model`, `mode`, and `thinking`; unknown
  IDs are rejected. `set_mode` and legacy `set_model` converge on the same
  setters. [`setMode`](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/acp-server/src/session.ts#L1131)
  changes plan and permission state, not event attribution. Never Ask/auto mode
  therefore does not solve autonomous delivery.
- [All turn subscriptions](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/acp-server/src/session.ts#L294)
  feed `dispatchTurnEvent`. [`driveLaunch`, `settleDriver`, and `driverFor`](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/acp-server/src/session.ts#L690)
  allocate a driver only for a client launch, clear it at settlement, and require
  exact turn equality. Early buffering only covers the admitted launch-ID race.
  Assistant, thinking, tool start/delta/progress/result, and
  [`turn.ended`](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/acp-server/src/session.ts#L937)
  all return without a matching driver. No configuration predicate guards this
  filter. Independent compaction/title/catalog notifications do not carry cron
  occurrence completion.
- [Complete ACP method registration](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/acp-server/src/server.ts#L702)
  adds no autonomous subscription extension. Load/resume/replay can retrieve
  history but do not install a different ongoing event driver.
- [All cron settings](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/agent-core-v2/src/features/cron/configSection.ts)
  are debug, jitter, staleness, disable, manual tick, clock, and polling interval.
  Their environment equivalents control native timing only. Native cron is
  enabled by default. [`deliverFire`](https://github.com/MoonshotAI/kimi-code/blob/41c341434ae24e45bfe0f2232ec11b80531ac717/packages/agent-core-v2/src/features/cron/cronService.ts#L180)
  submits directly to the agent loop with cron origin; it does not allocate an
  ACP driver. `tickCron` at line 285 skips a running agent, so holding a user
  turn open is not a supported workaround either.

There is no need to ask a model to create another timer to settle this question:
the installed code drops its result irrespective of those settings. An upstream
ACP autonomous-turn projection or a new supported CLI host-plugin seam is
required. A custom engine bootstrap, HTTP/KAP transport, transcript polling, or
manual tick driver does not satisfy this task's current-protocol requirement.

## AGY: supported options do not supply the missing stream delivery contract

The executable hash exactly matches the earlier live review. Its existing
135-second zero-frame idle measurement and delayed, bundled recurring results
are reused, **not rerun or presented as a new experiment**. Native timing and
model-mediated management are already established.

The current installed `--help` was checked in full, together with the official
[headless reference](https://antigravity.google/docs/cli/headless/),
[CLI reference](https://antigravity.google/docs/cli/reference),
[settings schema](https://antigravity.google/schemas/v1/settings.json),
[schedule options](https://antigravity.google/docs/commands/schedule),
[plugins](https://antigravity.google/docs/plugins),
[hooks](https://antigravity.google/docs/hooks?tab=cli), and
[sidecars](https://antigravity.google/docs/sidecars/).

| Relevant supported surface | Why it does not establish a qualifying solution |
| --- | --- |
| `--input-format`, `--output-format`, `--print`, `--print-timeout` | Stream input runs each submitted user turn and emits its result. The default timeout is already zero, meaning no turn timeout; increasing it does not install idle subscriptions or occurrence results. JSON/text are different output envelopes, not a stream-json fix. |
| `--conversation`, `--continue`, `--project`, `--new-project`, `--add-dir` | Select session/workspace ownership. Dedicated ownership cannot recover frames absent from stdout. |
| `--agent`, `--model`, `--effort`, `--mode`, permission/sandbox flags | Select execution behavior or tool authorization. They do not expose a different stream event contract. Permissions already allowed the native schedule/manage-task tools in the prior probe. |
| `--settings` and the published settings schema | No idle-output or autonomous-turn subscription key is documented. `notifications` means bell/desktop notification; `hideActiveItems` and `verbosity` affect display; `queuedMessages` controls incoming-message handling. None is a scheduled-result stream API. |
| `IsDaemon`, `MaxIterations`, `TimerCondition` native tool fields | Control task lifetime/cancellation/caps, not terminal result framing. The earlier probe requested daemon/cap behavior, but omitted serialized parameters mean exact round-trip verification remains incomplete. Do not turn that omission into proof the fields are unsupported, or claim daemon behavior was conclusively tested. |
| Plugin skills, agents, MCP, lifecycle hooks | No documented plugin hook into the stream-json emitter. Hook stdout is consumed as hook JSON. `Stop` exposes `executionNum`, `terminationReason`, and `fullyIdle`, but its return controls stop/continue; it does not emit a correlated stream-json occurrence result. Returning `continue` to keep asking/waiting is not evidence of native autonomous delivery. A separate hook socket/file relay would be a different result channel. |
| Sidecar `builtin: schedule`, remote agent/control | Persistent sidecars are a distinct host capability. No documented mapping joins their runs to the local stream-json conversation's occurrence/result frames. Remote-control or a separate agent API is not the current transport route. |
| `--json-schema`, logging, slash expansion, interactive prompt flags | Affect formatting, diagnostics, or invocation mode. They do not establish idle event delivery; interactive execution changes the tested transport. |

These live documentation pages are not versioned source for 1.5.4. The pinned
executable's flags and the earlier pinned live trace are the version-specific
evidence. The executable is stripped and full emitter/control-flow source was
not available; compiled symbol names do not prove an exhaustive internal branch
analysis. The precise remaining evidence gap is whether a supported native
option actually changes **both** idle emission and per-occurrence terminal
correlation. No such option was found in the complete public surfaces above.
Consequently there is no defensible provider route to enable now, rather than
a claim that AGY's native scheduler does not exist or can never be integrated.

[`AgyExecutor.ts:855`](../packages/cli/src/executor/AgyExecutor.ts#L855) already
uses the required stream-json flags. Removing its local idle filter would not
repair the observed upstream silence. A qualifying revision/option must show
autonomous frames after setup has completed, no further stdin prompts, distinct
occurrence terminal outcomes, and confirmed native cancellation. The earlier
one-shot result bundled with setup is insufficient for that contract.

## Verification and preserved boundaries

- Fresh evidence: installed versions/hashes/help; DSH distributed implementation
  and full relevant service/event path; Kimi routing/config/cron sources and
  installed decisive code bodies; official protocol and AGY option/plugin docs;
  two Linux synthetic DSH native-process probes.
- Reused evidence: the explicitly identified AGY live report. No new AGY or Kimi
  model invocation, schedule, or authentication operation was performed.
- Both DSH probes obtained native deletion plus empty active-list receipts,
  exited with code 0, and had no remaining process group. All probe scripts,
  downloaded sources, and isolated runtime data were removed from this checkout.
- Only this English report was added. Existing reports and runtime sources remain
  unchanged. No commit, push, deployment, delegation, external message, global
  configuration/authentication edit, or model-driven shell/file action occurred.
- No production integration, live-model acceptance, or native macOS/Windows run
  is claimed. No build was needed for this report-only change. The remaining DSH
  work is implementing and testing the provider described above; Kimi requires
  an upstream/supported-host change, and AGY requires the missing native delivery
  evidence or a backend fix.
