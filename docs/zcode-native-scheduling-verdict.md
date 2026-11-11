# ZCode native scheduling verdict

Verified on 2026-11-11 against remote-cli checkpoint `197acdb382fc65f4016929a3bdc12ceba464a705`.

## Decision

**ZCode has real native scheduling, but its standalone `app-server --stdio` is not a self-contained scheduling host.** In the tested official distribution, native Cron tools delegate CRUD back to their protocol client. ZCode's desktop host supplies automation persistence; a separate desktop scheduler supplies the clock and dispatches work through that host. Bare app-server does not start this composition.

This replaces the earlier binary-unavailable finding with an implementation-backed verdict. Removing remote-cli's Cron denylist and retaining idle callbacks are necessary adapter changes, but cannot supply the missing host services. A dedicated CLI session has the same dependency. This is a host-composition limitation of this version, not a claim that native Cron tools are absent or that headless scheduling is fundamentally impossible.

## Distribution and evidence pins

- Official pages fetched: [installation](https://zcode.z.ai/en/docs/install), [automations](https://zcode.z.ai/en/docs/automations), and [release v3.17.2](https://github.com/zai-org/ZCode/releases/tag/v3.17.2).
- Current official desktop release inspected: **3.17.2**, published `2026-11-04T10:41:06Z`; release build source reported as `e6b675b40abb79e1d38d98d4e8750d0859cfedd9`.
- Downloaded [official Linux x64 DEB](https://cdn-zcode.z.ai/zcode/electron/releases/3.17.2/linux-x64/ZCode-3.17.2-linux-x64.deb), 206,818,476 bytes, SHA-256 `86ec7b2a795c46ae56e7313504300a337c33c68267c28f96a03726a4f5aff575`. Extracted locally with `dpkg-deb -x`; no installation or desktop launch.
- Bundled `resources/glm/zcode.cjs --version`: **0.17.1**. File size 15,408,074 bytes; SHA-256 `d9afd58d694f98a5279bf548cdc7646413c125762e86730605a6071f9e0346d6`.
- Public source citations below are pinned to export commit **`a9fe401eede6e6e5e01be9048679c206fe6f02d9`**, distinct from the release build SHA. The shipped CLI and extracted desktop ASAR were also inspected to corroborate the decisive composition; public-source line numbers are not presented as a byte-for-byte release-source match.

## Positive implementation evidence

| Boundary | Evidence and consequence |
|---|---|
| Native tools | [`cron.ts:65–187`](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/apps/zcode-cli/packages/core/src/tool/handlers/cron.ts#L65): CronCreate/List/Update/Delete call an injected `AutomationPort`. These are implemented tools, not model prose or third-party extensions. |
| App-server wiring | [`server-operations.ts:3616`](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L3616) installs `createProtocolAutomationPort`. [`automation-port.ts:35–232`](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/automation-port.ts#L35) implements CRUD with `context.requestClient(...)`. These are **server-to-client requests**, not scheduling RPCs serviced by the CLI. |
| Ownership guard | The same port checks `automation/checkTaskBinding` before Create, falling back to `automation/list` only for method-not-found. Unknown binding fails closed. An automation turn or an already bound session cannot create another automation. A real adapter must preserve these guards. |
| Host CRUD | [`zcodeAgentService.ts:1353`](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/services/src/zcode-agent/zcodeAgentService.ts#L1353) constructs `AutomationRepo` and `AutomationService`. Reverse-request handlers at lines 3273, 3480, 3534 and 3576 perform Create/List/Update/Delete. The service computes schedule state and persists it; the CLI does not independently fulfill these calls. |
| Native clock | [`desktopCronScheduler.ts:61–69`](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/desktop/src/main/desktopCronScheduler.ts#L61) forks the scheduler using Electron `utilityProcess`. [`scheduler/index.ts:33–89`](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/desktop/src/scheduler/index.ts#L33) owns the repository and due-job claims; lines 431–449 initialize it and start a 20-second interval. This is ZCode's native clock, outside app-server. |
| Native dispatch | Scheduler sends `cron-dispatch-request` through its parent port. [`desktopCronScheduler.ts:107–140`](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/desktop/src/main/desktopCronScheduler.ts#L107) forwards to a local host or explicitly returns `no local host available`. [`host/index.ts:1110–1129`](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/desktop/src/host/index.ts#L1110) installs outcome tracking and sends the prompt with `clientMode: "desktop-continuous"`, `automationId`, and a run-specific trace. |
| Persistent event listener | [`server-operations.ts:2056–2081`](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts#L2056) supports subscription/replay using `afterSeq`; lines 3276–3321 forward live `session/event` notifications. This transport can deliver host-dispatched turns without a remote-cli pending prompt. It does not itself generate scheduled turns. |

The shipped CLI contains the same reverse-CRUD implementation (`function Kyi`, byte offset 14,972,596, line 15533). In the extracted ASAR, `out/main/index.js` contains `spawnCronScheduler` at byte 630,469, `out/host/index.js` contains `automationCreate` handling at byte 536,284, and `out/scheduler/index.js` contains the native 20-second clock initialization near byte 1,123,023. Offsets refer to the pinned downloaded files and corroborate the positive ownership chain above; keyword absence is not the basis of the verdict.

## Bounded native protocol verification

Ran the unmodified downloaded CLI with `node zcode.cjs app-server --stdio`, without remote-cli's Cron denylist. A documented custom-provider configuration pointed to a deterministic loopback OpenAI-compatible fixture. HOME, user profile, storage, provider configuration and cwd were isolated. Plugins, hooks, skills, memory, MCP and subagents were disabled. No real credentials, login, paid model, project files or external messaging were used.

The fixture supplied native tool calls for four management turns: CronList, CronCreate, CronUpdate and CronDelete. The actual CLI executed the tool handlers. The fixture client rejected all automation CRUD requests with JSON-RPC `-32601`; only the Create binding check received `{ "bound": false }` so the subsequent Create request could be observed. **No host receipts were fabricated, and no schedule was created.**

Observed request order and inputs, with synthetic identifiers:

| Model tool input | Actual CLI-to-client method and parameter shape |
|---|---|
| `CronList {}` | `automation/list {}` |
| `CronCreate {title:"Synthetic probe",delayMinutes:10,recurring:false,prompt:"Return exactly SYNTHETIC_ZCODE_PROBE. Use no tools."}` | First `automation/checkTaskBinding {targetTaskId:SESSION}`; then `automation/create` with `cronExpr`, `relativeDelayMinutes`, `prompt`, `title`, `recurring`, `mode`, `modelSelection`, `targetTaskId`. The port source sets the relative-delay placeholder cron to `* * * * *`; the host computes the actual schedule. |
| `CronUpdate {id:"synthetic-automation",title:"Synthetic probe update",prompt:...}` | `automation/update {automationId:"synthetic-automation",title:...,prompt:...}` |
| `CronDelete {id:"synthetic-automation"}` | `automation/delete {automationId:"synthetic-automation"}` |

Sanitized wire structure (IDs replaced; event payloads abbreviated):

```json
{"id":"server-N","method":"automation/list","params":{}}
{"id":"server-N","error":{"code":-32601,"message":"Synthetic probe client does not provide desktop automation hosting."}}
{"method":"session/event","params":{"type":"turn.started","sessionId":"SESSION","turnId":"TURN","traceId":"TRACE","eventId":"EVENT-1","seq":1,"deliveryKind":"desktop-continuous","timestamp":0,"payload":{}}}
{"method":"session/event","params":{"type":"tool.updated","sessionId":"SESSION","turnId":"TURN","payload":{"kind":"error"}}}
{"method":"session/event","params":{"type":"turn.completed","sessionId":"SESSION","turnId":"TURN","traceId":"TRACE","eventId":"EVENT-2","seq":21,"deliveryKind":"desktop-continuous","timestamp":0,"payload":{"response":"SYNTHETIC_ZCODE_DONE"}}}
```

All four native tools produced `tool.updated` errors carrying the fixture's host rejection, followed by completed management turns. **`turn.completed` is not a CRUD success receipt.** The four-turn run made nine loopback model requests, including a native auxiliary request. A separate single-turn run made two requests and confirmed `turnId` on the **event envelope**, absent from `payload`, for both start and completion. Both CLI processes closed on stdin EOF and exited 0. There were no waiting-for-fire or polling prompts.

This proves tool reachability, reverse RPC direction, error propagation and event shape against the real distribution. It does not claim successful host CRUD, a real-provider model evaluation, or autonomous firing in a composition that was not launched. Authentication and external model network access were not blockers: the native host dependency was reached directly.

## Scheduling and recovery semantics

- [Native tool schema](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/apps/zcode-cli/packages/contracts/src/tools/automation.ts#L34): five-field cron uses the local timezone; `delayMinutes` supplies relative one-shots; `recurring:false` defaults to one dispatch, while recurring schedules can carry explicit intervals. This strict CronCreate schema has no per-job IANA-zone argument. Do not promise arbitrary caller zones without a host-level mapping and DST verification.
- Persistence belongs to the host's automation repository, separate from CLI session persistence. Restarting a bare CLI does not recreate the scheduler. A subscription/replay cursor recovers events; it is not a due-job clock or a run ledger.
- [Scheduler lines 125–159](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/desktop/src/scheduler/index.ts#L125) skip an initially missed window older than five minutes. Missed one-shots are finalized, rather than silently moved to another occurrence. The repository and native host must remain authoritative for retry/restart decisions.
- Native run identity is `${automationId}:${scheduledAt}` ([scheduler line 77](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/desktop/src/scheduler/index.ts#L77)); the host uses that run ID as the prompt trace ([host line 1068](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/desktop/src/host/index.ts#L1068)). Dispatch acknowledgment and successful model completion are separate states. Host outcome tracking starts before prompt submission.

## Adapter boundary and recommendation

There is **no complete adapter using only the existing standalone app-server process** in this release. Answering reverse CRUD from a remote-cli-owned database and adding a timer would replace native scheduling and violate the native-only requirement. Merely returning successful JSON to the CLI would create a false scheduling receipt.

The concrete native route, if a different hosting composition is approved, is to reuse ZCode's AutomationService/Repo, scheduler utility process, dispatch host and outcome ledger together. Either the official desktop composition must run, or an upstream-supported headless host must expose these same services. Extracting the scheduler bundle alone does not provide its parent-port dispatcher, host task/model services or persistence lifecycle. No standalone app-server switch that supplies this composition was established; implementing a custom headless composition is additional integration work, not enabling a dormant CLI Cron loop.

With such a host, the smallest transport adapter would:

1. Bridge native reverse automation requests to the owning host, including binding checks and real CRUD receipts; retain native recursion restrictions and workspace ownership.
2. Maintain an event subscription beyond management-turn completion. Join automation ID, run trace, session ID and **envelope** turn ID; deduplicate by native event/run identity and restore `afterSeq` cursors on reconnect. Verify replay limits and host run outcomes before promising delivery recovery.
3. Map each automation to its original remote-cli/Feishu thread and execution generation. Dispatch receipts must not be reported as completed tasks. Cancellation must reconcile an already dispatched occurrence separately from deleting future runs.

Current remote-cli changes would include removing the denylist at `packages/cli/src/executor/zcode/ZCodeCommand.ts:72`, replacing the pending-prompt-only gate at `ZCodeClient.ts:375`, and reading envelope `turnId` instead of `payload.turnId`. These are concrete transport gaps, **not evidence of native impossibility**. No source changes were made here.

## Verification and remaining scope

Only Linux x64 was executed. Official distribution download, version/help inspection, source/bundle composition inspection and the five synthetic management turns above completed. No autonomous schedule was created, so no cancellation cleanup was necessary. Both probe subprocesses exited successfully; loopback servers closed; downloaded/extracted distributions, isolated configs/databases and probe scripts were removed. Only this report remains in the checkout.

Real-provider behavior, a full desktop/headless-host deployment, autonomous firing/result delivery, reconnect replay limits, and macOS/Windows execution remain untested. These are explicit limits of the proposed alternate composition; they do not leave the tested bare-app-server host dependency unresolved. No repository tests were run because runtime source was unchanged.
