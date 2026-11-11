# Codex 0.167.0: standalone native scheduling verdict

Reviewed 2026-11-11 against remote-cli checkpoint `197acdb3`.

## Verdict

**NO: Codex 0.167.0 standalone app-server does not provide the requested native
one-shot/recurring job scheduler.** No supported process feature flag installs
such an engine. This verdict covers the existing app-server transport and excludes
desktop/cloud orchestration, client-owned timers, and model-driven polling loops.

Native model-tool management was explicitly investigated. App-server can relay
client-supplied automation tools, but the client must execute them. Native
`clock.sleep` can delay an active turn; it is not a scheduled-job service.
The conclusion rests on exact-version registration/dispatch code and live native
dispatch tests, not missing documentation or an unsuccessful keyword search.

## Version and reproducible inspection

- Installed CLI: `codex-cli 0.167.0`; platform package:
  `@openai/codex` version `0.167.0-linux-x64`.
- Native executable SHA-256:
  `cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda`.
- Exact official source: `openai/codex`, tag `rust-v0.167.0`, annotated tag object
  `cb41599ccbe371272892f156286a236aa097bada`, commit
  `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`. Its archive was fetched and inspected
  in an isolated temporary directory. All source references below use that commit.
- Generated the complete installed protocol with
  `codex app-server generate-json-schema --experimental --out <temporary-dir>`:
  **180 client methods, 11 server requests, 86 server notifications**, across 470
  JSON files. The combined schema SHA-256 was
  `486c7c8daa5dc7f3ab2a1fb56de5316804caf7a4210fda1dc28d3f0f4e90cfe1`.
  The nonexperimental generation has 106/10/86 methods respectively; all three
  method sets exactly match the tagged source's checked-in schema snapshots.
  No schedule CRUD operation exists in either generation. This only closes the
  direct-RPC route; the tool route was checked separately below.

Official documentation was fetched before native inspection:
[CLI scheduling](https://learn.chatgpt.com/docs/automations.md?surface=cli),
[desktop scheduling](https://learn.chatgpt.com/docs/automations.md?surface=app),
and [app-server](https://learn.chatgpt.com/docs/app-server.md).
The desktop documentation requires the app to remain running for local scheduled
tasks; the CLI page directs management to web/desktop. These product statements
support the distinction but are not the sole basis for the verdict.

## Decisive implementation boundaries

| Path in the exact source | Finding |
| --- | --- |
| `codex-rs/core/src/tools/spec_plan.rs:122-185`, `1187-1206`, `1244-1598` | The native router assembles core tools, MCP tools, registered extension tools, client dynamic tools, and hosted tool specifications. The complete core registration branches cover shell, MCP resources, utilities, and collaboration; they do not register a scheduled-job handler. This includes feature/model-gated and deferred tools, not just the default visible tool names. |
| `codex-rs/app-server/src/extensions.rs:52-142`; `core/src/tools/spec_plan.rs:352-367`, `693-721` | The app-server's complete extension composition installs queue, goals, history, skills, MCP/plugins, web/image, and other listed services. No timer-job service is composed. Hosted tool specifications add web search, not a local scheduling engine. |
| `codex-rs/features/src/lib.rs:344-347`, `1856-1861` | `in_app_local_automation` is explicitly a **requirements-only desktop permission gate**, defaulting to true. It is not a scheduler-loader switch. Its production references are its declaration and feature specification; enabling it does not register tools or start a scheduling service. |
| `codex-rs/core-plugins/src/remote.rs:302-318`, `640-654`, `1559`; `app-server/src/request_processors/plugins.rs:2352-2364` | `scheduled_tasks` is remote plugin release/catalog data copied into the outgoing `PluginDetail`. This path transports task templates to a consumer; it does not create or execute local jobs. `app-server-protocol/src/protocol/v2/plugin.rs:763-805` defines the metadata shape. |
| `codex-rs/core/src/tools/handlers/tool_search.rs:482-501`; `core/src/tools/spec_plan.rs:1603-1632` | The source's `codex_app.automation_update` example is a **test fixture for client-supplied dynamic tools**, not a native automation implementation. Dynamic functions are registered as external runtimes, including namespaced/deferred functions. |
| `codex-rs/core/src/tools/handlers/dynamic.rs:145-159`, `190-240`; `app-server/src/bespoke_event_handling.rs:1112-1140` | Dynamic execution waits for a client response. App-server sends `item/tool/call` with thread, turn, call, namespace, tool, and arguments. The host/client owns the implementation; naming a tool `automation_update` does not install native timing. |
| `codex-rs/core/src/tools/registry.rs:767-785`, `1148-1152` | Calls without a registered runtime explicitly return `unsupported call: ...`; there is no fallback that creates an automation from the tool name. |

The native time-related alternatives were also followed:

- `core/src/tools/spec_plan.rs:1383-1408` gates `clock.sleep` through
  `features.sleep_tool` and model/config policy. `core/src/tools/handlers/sleep.rs:26-58`,
  `102-158` implements a duration-only wait of at most 12 hours, inside the current
  turn, interrupted by new input. It exposes no prompt/job registration, cron,
  timezone, durable occurrence, or job list/delete contract. Repeated model calls
  to this primitive would construct a model-driven scheduling loop.
- `ext/goal/src/tool.rs:43-60` accepts objective/token-budget/status, not a due
  time. `ext/goal/src/runtime.rs:436-497` continues an active goal when idle using
  `turn_trigger: "goal"`. This proves autonomous turns are possible, but does not
  provide a native timed job.

## Live installed-runtime verification

Used the real installed app-server over stdio with fresh ephemeral threads and an
isolated temporary Codex home. A loopback Responses fixture supplied deterministic
synthetic model outputs and captured the actual registered tool schemas. No real
model API, existing authentication, coordinator conversation, or stored history
was used. The fixture implemented **no scheduler** and created no jobs.

`initialize` with `experimentalApi: true` succeeded. Paginated
`experimentalFeature/list` returned all **201 features**, matching the source's
201 feature definitions. The runtime confirmed `in_app_local_automation`, `apps`,
`plugins`, `goals`, and `sleep_tool` enabled. Sleep used its supported
`mode = "always_on"`; Code Mode was disabled to inspect direct tool dispatch.
These temporary settings use the same feature configuration accepted by process
overrides; no global settings were changed.

| Probe | Actual protocol/result facts |
| --- | --- |
| Standalone native registry | `thread/start` without dynamic tools, then `turn/start`. The fixture attempted `codex_app.automation_update` in list mode. Native dispatch returned an `unsupported call:` tool result; no `item/tool/call` was sent to the client. The turn completed. Captured native tools included goals and `clock.sleep`, but no automation tool. |
| Client-owned automation name | A fresh `thread/start` supplied a canonical `dynamicTools` namespace containing `automation_update`. The same function call now emitted exactly one `item/tool/call` to the client. The client returned a synthetic unsuccessful result explicitly stating that no scheduler/job existed; that result reached the model fixture and the turn completed. |
| Native time primitive | Another fresh thread invoked `clock.sleep(duration_ms: 25)`. It executed locally, returned `Sleep completed.`, emitted no client dynamic request, and completed the original turn. This positively distinguishes native timing from the external automation tool. |

The fixture's model ID was synthetic, so this is a native registration/dispatch
test, not a claim about a production model's willingness or account entitlement.
Complete source inspection covers the other model/feature registration branches.
One initial dynamic-tool request used a mixed legacy/canonical schema and was
rejected before execution; the corrected canonical request produced the verified
client handoff above.

## Adapter consequence and cleanup

There is no eligible create/list/cancel/occurrence contract to implement for this
version. A dedicated process would preserve isolation but would not add the
missing scheduler. Using desktop/cloud automation, implementing the supplied
dynamic tool in remote-cli, or looping over `clock.sleep` would change the required
architecture. A future native job service and its authoritative occurrence
contract are needed; unavailable evidence is **not** the remaining blocker here.

Both probe app-server parents exited with code 0. Remaining owned helper processes
were terminated; the final process-group check found zero live members. Loopback
servers were closed. No scheduled jobs, goals, external messages, file/command
tool actions, installs, authentication/global-setting edits, commits, or deployments
were performed. Temporary source, schemas, fixture state, and isolated homes were
removed after verification. Only this report is retained; preexisting repository
files remain unchanged.
