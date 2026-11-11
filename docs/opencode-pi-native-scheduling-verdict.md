# OpenCode and Pi native scheduling verdict

The later [OpenCode 2.2.7 review](opencode-2-native-scheduling-verdict.md) confirms native scheduling in that newer release and separately establishes its ACP output limitation.

Reviewed 2026-11-11. This replaces the **unverified** timing conclusions for the
versions below in `native-scheduling-backend-review.md`; it does not change runtime
support. Eligibility requires backend-owned one-shot/recurring task timing and
autonomous results over remote-cli's existing ACP/RPC transport. Model tools count
as a management interface. Writing a timer extension, asking a shell to sleep, or
using an external scheduler does not count.

| Runtime and transport | Native user-task scheduler in this runtime | Verdict under the requirement |
| --- | --- | --- |
| OpenCode 1.19.5, `opencode acp` | Absent from the complete built-in tools, service composition, and execution paths inspected | **Not supported** |
| `@earendil-works/pi-coding-agent` 1.5.2, `pi --mode rpc` | Absent from the complete built-in tools, built-in extensions, and CLI agent runtime inspected | **Not supported** |

These are version-scoped source conclusions, not claims that either project can
never support scheduling. Neither has native schedule create/list/cancel,
one-shot/periodic timing, timezone policy, persisted deadlines, missed-run recovery,
or scheduled-occurrence correlation to expose through an adapter in these runtimes.
Ordinary session persistence and background-result events are separate capabilities.

## Version and evidence provenance

- Downloaded and extracted the complete official source archives for
  [OpenCode v1.19.5](https://codeload.github.com/anomalyco/opencode/tar.gz/refs/tags/v1.19.5)
  and [Pi v1.5.2](https://codeload.github.com/earendil-works/pi/tar.gz/refs/tags/v1.5.2).
  Inspected executable composition, all built-in tool registrations, optional
  built-in modules, prompt loops, timers, and the actual transport dispatchers.
- Anonymous npm registry metadata reports
  [`opencode-ai`](https://registry.npmjs.org/opencode-ai) latest **1.19.5**,
  published 2026-10-28. The separate
  [`@opencode/cli`](https://registry.npmjs.org/@opencode%2fcli) package now reports
  **2.2.7**, published 2026-11-10. This review deliberately covers the requested
  1.19.5, **not 2.2.7**; do not apply its negative verdict to the latter.
- [`@earendil-works/pi-coding-agent`](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent)
  latest is **1.5.2**, published 2026-11-10. Downloaded its official npm tarball,
  verified SHA-512 against registry `dist.integrity`, and ran the extracted bundled
  executable, which returned `1.5.2`. No dependency installation was necessary.
  This is the package remote-cli currently recommends in
  `packages/cli/src/executor/PiExecutor.ts:107`.
- The legacy
  [`@mariozechner/pi-coding-agent`](https://registry.npmjs.org/@mariozechner%2fpi-coding-agent)
  latest is **0.73.1**, published 2026-05-07. Its distribution was also downloaded
  and integrity-checked to distinguish package identities. The definitive Pi
  runtime review and executable probe here target current **1.5.2**, not every
  historical Pi release. Local installation absence is not the rejection reason.

## OpenCode 1.19.5: background execution, no native scheduled tasks

1. **Complete tool registration:**
   [`tool/registry.ts:182-258`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/tool/registry.ts#L182)
   assembles invalid, shell, read, glob, grep, edit, write, task, webfetch,
   todowrite, websearch, skill, and apply_patch, plus conditional question,
   experimental execute/code-mode, LSP, and plan_exit. `all()` returns exactly
   this built-in list plus discovered custom tools/plugin tools. MCP tools are
   externally supplied. There is no hidden native timer tool available merely
   by enabling an existing built-in flag.
2. **Optional modules and startup:**
   [`plugin/index.ts:65-90`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/plugin/index.ts#L65)
   enumerates built-in provider/authentication plugins. Project bootstrap loads
   configuration, plugins, LSP, formatting, VCS, snapshots, and project services
   ([`project/bootstrap.ts:17-53`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/project/bootstrap.ts#L17)).
   The HTTP runtime's complete service composition includes background jobs and
   session execution, not a schedule service
   ([`httpapi/server.ts:225-268`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/server/routes/instance/httpapi/server.ts#L225)).
3. **The plausible counterexample is real, but is not scheduling:**
   [`core/background-job.ts:64-98,114-124,173-248`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/background-job.ts#L64)
   accepts an effect to run, immediately forks it, and stores jobs in a scoped,
   process-local map. There is no deadline, recurrence, timezone, or durable
   due-job record. `wait.timeout` bounds a wait; it does not schedule a new task.
   [`tool/task.ts:226-297`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/tool/task.ts#L226)
   really can inject a completed background subagent result into its parent and
   start another parent turn. This is a completion wakeup, not a clock wakeup.
   A subagent running `sleep`/cron would supply the missing scheduler externally.
4. **Prompt and timer paths:**
   [`session/prompt.ts:1052-1129,1343-1347`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/prompt.ts#L1052)
   starts processing submitted input and exits after the latest user turn is
   answered. Inspection of both `packages/opencode/src` and `packages/core/src`
   found timers for retries, tool deadlines, locks, model-catalog refresh,
   cleanup, UI/network maintenance, and event reconnection. Their callbacks do
   not constitute a user-task due queue. For example,
   [`models-dev.ts:256-257`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/models-dev.ts#L256)
   refreshes the catalog and
   [`acp/service.ts:989-1007`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/acp/service.ts#L989)
   uses a zero-delay timer only to advertise available commands.
5. **Actual transport:** remote-cli uses ACP
   (`packages/cli/src/executor/OpenCodeExecutor.ts:77-78`).
   [`cli/cmd/acp.ts:19-64`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/cli/cmd/acp.ts#L19)
   connects ACP to the ordinary local server;
   [`acp/agent.ts:32-86`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/acp/agent.ts#L32)
   enumerates session, configuration, prompt, and cancel methods. The
   [HTTP API assembly](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/server/routes/instance/httpapi/api.ts#L49)
   provides no additional native scheduling route. Crucially,
   [`acp/event.ts:93-104,191-250`](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/acp/event.ts#L93)
   forwards updates for known sessions without requiring a pending prompt.
   Do not reject OpenCode for an inability to emit idle content. However, idle
   status only resolves local prompt waiters, and no native timed occurrence
   exists to correlate or deliver in the first place.

The documented [GitHub schedule example](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/web/src/content/docs/github.mdx#L113)
uses GitHub Actions cron to launch OpenCode. The
[ecosystem scheduler](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/web/src/content/docs/ecosystem.mdx#L45)
uses third-party launchd/systemd integration. Neither is native timing inside ACP.
**No qualifying adapter can be implemented for 1.19.5 without adding a scheduler
outside this backend runtime.**

## Pi 1.5.2: RPC events exist, CLI-native scheduling does not

1. **Complete core tool inventory:**
   [`core/tools/index.ts:95-105,182-225`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/index.ts#L95)
   declares and constructs exactly read, bash, powershell, edit, write, grep,
   find, and ls. Tool construction is an exhaustive switch/map, not a sampled
   help list.
2. **All optional built-in extensions:**
   [`extensions/index.ts:1-14`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/extensions/index.ts#L1)
   contains llama.cpp, codemode, tool-search, and MCP. The CLI supplies that
   complete list to its resource loader
   ([`main.ts:615,833-854`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/main.ts#L615)).
   These provide model management, tool execution/search, and external MCP
   connections; none implements timed user tasks. Codemode's sandbox explicitly
   has no timers
   ([`extensions/codemode/tool.ts:123`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/extensions/codemode/tool.ts#L123)).
   Loading an external timer tool or writing an extension is a different solution.
3. **Runtime and wakeups:**
   [`core/sdk.ts:403-474`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/sdk.ts#L403)
   composes `Agent` and `AgentSession`, with extension hooks and cache warming.
   [`agent-loop.ts:287-331`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent-loop.ts#L287)
   drains tool/steering/follow-up work and ends; follow-up means queued input,
   not a deadline. Extensions may request continuation or initiate an idle turn.
   The genuine recurring timer in
   [`cache-warmer.ts:209-277`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/cache-warmer.ts#L209)
   refreshes an existing model cache and records usage. It does not execute user
   tasks or run a tool loop. Other inspected CLI timers handle retries,
   timeouts, output backpressure, UI refresh, and MCP connection maintenance.
4. **RPC is not the missing primitive:** remote-cli launches `--mode rpc`
   (`packages/cli/src/executor/pi/PiTypes.ts:71-74`). The complete
   [`RpcCommand` union](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20)
   and [`rpc-mode.ts:407-738`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L407)
   dispatch prompt/queue/session/model/tool-related operations, without a timed
   task operation or fallback scheduler. Model-mediated timing is also ruled
   out by the complete tool/extension inventory above, not by missing CRUD alone.
   [`rpc-mode.ts:362-367`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L362)
   forwards subscribed session events, including `agent_settled`, regardless of
   an outstanding RPC prompt. remote-cli's own `PiExecutor.ts:1117-1118` drops
   events without `activeTurn`; fixing that would expose events, not add timing.
5. **Separate durable harness:**
   [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/package.json#L1)
   is a separate library with
   [persisted sleeps and scheduler resume](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md#L140)
   and an actual [timer implementation](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/src/timers.ts#L13).
   It is not a dependency of the
   [coding-agent package](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/package.json#L43),
   nor imported by the inspected coding-agent/agent source. `pi --mode rpc`
   constructs the AgentSession runtime, not this Harness. Adopting it would
   introduce a different runtime/host and task definitions, not enable an
   existing native CLI scheduling feature.

**No qualifying adapter can be implemented for Pi coding-agent 1.5.2 without
adding scheduling logic or changing the runtime requirement.**

## Executable verification and limits

The extracted Pi bundle passed `--version` and `--help`. A bounded, no-auth,
offline `--mode rpc` probe used a fresh scratch home/config/session directory,
an allowlisted environment without credentials, `--no-session`, and disabled
extensions, skills, prompt templates, themes, context files, and project trust.
It returned:

- `get_state`: success, `isStreaming: false`, `pendingMessageCount: 0`, no session file.
- `get_commands`: success, empty list under the explicitly disabled discovery.
- `schedule_list`: `success: false`, `Unknown command: schedule_list`.

The last response only corroborates the inspected dispatcher; an invented method
being rejected is **not** the proof of scheduler absence. Optional built-ins were
reviewed separately in source, rather than inferred absent from this isolated probe.
All probe processes exited with code 0. No prompts, native tasks, external messages,
or authenticated operations were needed because neither qualifying route exists.
No user configuration/history was used. Scratch downloads and probe state were
removed; only this report is delivered. No source/tests were changed or tests run.
Executable probes ran on Linux only; no macOS/Windows or live result-delivery
validation is claimed. A future native feature or OpenCode 2.2.7 needs its own review.
