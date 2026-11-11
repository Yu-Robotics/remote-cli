# AGY 1.5.4 native scheduling protocol review

Reviewed 2026-11-11 against remote-cli checkpoint `a4689a1d`.

## Recommendation

**Do not enable an AGY scheduling provider yet.** Native scheduling and
model-mediated management work through the existing stream-json transport.
However, the recurring probe produced no autonomous stdout frames during a
135-second idle window. Two scheduled responses became visible only when the
next user message was submitted, and were bundled into that message's result.
One dedicated process per job would isolate ownership, but would not fix this
delivery boundary. Sending periodic prompts to retrieve results would violate
the native-only, no-polling requirement.

This is a verified failure of the tested headless workflow, not a claim that
AGY lacks native scheduling or that a direct CRUD RPC is necessary.

## Evidence and scope

- Installed `agy --version`: **1.5.4**. Executable SHA-256:
  `c77851d1fc99b45bb7fc1dc4cddf09f5b668418cc498f92a09c73cddbc696343`.
- Fetched official [schedule documentation](https://antigravity.google/docs/commands/schedule),
  [headless protocol](https://antigravity.google/docs/cli/headless/),
  [permissions](https://antigravity.google/docs/permissions), and
  [sidecars](https://antigravity.google/docs/sidecars). The schedule documentation
  explicitly supports asking the agent to create, list, and cancel schedules.
  The headless reference documents one result per submitted turn and rejects
  `control_request`/`control_response`; that does not exclude model-tool CRUD.
  Persistent sidecars are a separate, app-scoped capability.
- Installed executable inspection found compiled `ScheduleTool.startTimer`,
  `startCron`, `continueCron`, `cronJitter`, and `ManageTaskTool.list/kill/status`
  symbols. Reproducible symbol-string byte offsets include `startTimer`
  41246315, `startCron` 41246672, and `ManageTaskTool.kill` 41235055.
  Print-mode symbols include `runStreamInput` at 46878620 and
  `streamJSONEmitter.emitResult` at 46872153. These corroborate implementation
  presence; symbol names alone do not establish control flow or wire support.
  Full native source was not available in the inspected executable.
- The existing [AgyExecutor](../packages/cli/src/executor/AgyExecutor.ts)
  uses stream-json at lines 854-868. Lines 957-958 and 1002-1005 discard updates
  and results without an active command. A dedicated provider could remove that
  local restriction, but cannot recover frames the native CLI does not emit.
  The [provider contract](../packages/cli/src/scheduling/types.ts), lines 16-33,
  requires independently correlated occurrence completion and confirmed stop.

Three fresh live processes used the existing stdin/stdout protocol, with stdin
held open. Only synthetic text and native `schedule`/`manage_task` tools were
requested and observed. Session-only `--settings` denied file reads/writes,
commands, web actions, and MCP calls; slash expansion was disabled. No model or
agent override was selected. Output inspection retained only event metadata,
synthetic-marker checks, and extracted receipt facts, not raw transcripts.

## Native protocol observations

| Operation | Verified observation | Remaining qualification |
| --- | --- | --- |
| Discovery | `init.init.tools` advertised `schedule` and `manage_task`. | Capability must be checked in each new process. |
| One-shot | `schedule` received `DurationSeconds: 30`; its synthetic response appeared without another stdin message. | Setup and timer output shared the first `result`, with `num_turns: 1`; this did not establish a separate occurrence result after setup completion. |
| Recurring | A native `* * * * *` job was listed; two synthetic scheduled responses later appeared in conversation order before the cleanup user-input step. | No idle frames or per-occurrence terminal results were emitted. |
| Create/list receipts | Actual `manage_task` list steps returned native task records after creation. | `schedule` did not return a standalone creation receipt containing a job ID. Use native task records, not assistant confirmation prose. |
| Cancellation | A 180-second timer and a future cron were each listed, cancelled with `manage_task` `Action: kill` / `TaskId`, then listed again. Native cancellation receipts and the exact empty-list text `No background tasks are currently running.` were observed for both. | Cancellation racing an executing occurrence was not tested. UUIDs embedded in list text must not automatically be treated as task IDs. |
| Timezone syntax | With process `TZ=UTC`, native creation/list/status accepted `CRON_TZ=Pacific/Honolulu 0 0 1 1 *`; listing retained the zone, and cancellation succeeded. | Actual firing in that zone, unprefixed-cron timezone selection, DST gaps/overlaps, and exact next-fire conversion remain unverified. |

The recurring request specified `IsDaemon=true` and `MaxIterations=2`.
Serialized `tool_info.parameters` exposed only `CronExpression` and `Prompt`;
the timer similarly omitted its requested `TimerCondition`. Thus those emitted
parameters cannot independently verify all requested policy fields. Two
recurring responses were observed, but the precise parameter round trip remains
unverified. Missing serialized fields are not evidence of unsupported tools.

The decisive recurring trace, expressed as derived metadata rather than a
transcript:

1. At 9.8 seconds: `schedule`, step 2, `ACTIVE`.
2. At 17.4 seconds: native `manage_task` list receipt, then setup
   `result(status=SUCCESS, num_turns=1)`.
3. For the following 135 seconds: stdin remained open and untouched; **zero
   stdout events** arrived.
4. At 152.4 seconds, immediately after submitting cleanup: previously unseen
   `system_message` steps 6/8/9 and synthetic `agent_response` steps 7/10
   arrived, followed by cleanup `user_input` step 11.
5. At 161.4 seconds: one `result(status=SUCCESS, num_turns=2)` included scheduled
   response text as well as cleanup-turn output. No separate terminal result
   identified either scheduled occurrence.

Observed system-message frames contained only `conversation_id`, `step_index`,
`state`, `step_type`, and `duration_seconds`; they exposed no schedule ID,
iteration, wakeup reason, or message content. Result frames exposed
`conversation_id`, `status`, `response`, `duration_seconds`, `num_turns`, and
`usage`. A conversation ID and step index identify stored steps, not an
unambiguous scheduled-run success boundary.

## Eligibility gates and smallest viable adapter

| Gate | Assessment |
| --- | --- |
| Native timers and cron, without a replacement scheduler | Pass: documentation, executable evidence, and real tool execution. |
| Management over existing transport with native receipts | Pass for tested create/list/status/cancel route; no direct CRUD RPC required. |
| Autonomous results while stdin is idle | **Fail for tested recurring workflow**; responses surfaced only on the next submitted turn. |
| Distinct one-shot and recurring occurrence completion | **Not established**: one-shot output shared setup result; recurring outputs shared cleanup result. |
| Exact requested rule, timezone, and daemon/cap policy verification | Partial: native timezone-prefixed syntax accepted; execution semantics and omitted parameters need verification. |
| Cancellation races, failed shutdown, reconnect and restart policy | Not tested here; must pass adapter acceptance before enablement. Documentation scopes native schedules to the conversation, distinct from persistent sidecars. |

After an upstream fix or supported native option supplies autonomous output and
occurrence completion over the same stream-json transport, the smallest adapter
would own one fresh process per job, serialize model-tool management, validate
native list/cancel receipts, retain a permanent event listener, and translate
verified run boundaries into the existing schedule service events. It must fail
closed on ambiguous policy/receipt data and retain process ownership until exit
is confirmed. Simply forwarding late `AgyExecutor` output, interpreting every
assistant message as completion, or periodically prompting the model is not an
eligible implementation. No transport swap was investigated or proposed.

## Cleanup and verification

The cancellation/timezone probe obtained two native cancellation receipts and
two exact empty-list receipts. The firing probes issued cleanup list requests
before closing. All three live processes exited with code 0 after stdin closed;
their process-group existence checks found no remaining group. Consequently no
probe process remains to run a conversation-scoped timer. Two earlier startup
attempts rejected an invalid session-setting value before `init`, without
creating jobs; that override was removed for the successful probes.

No Feishu/external messages, shell tools, file tools, installs, configuration or
authentication edits, commits, or deployments were performed. Native synthetic
conversation persistence was not inspected or deleted. Repository status was
clean before and after the probes; the only intended file addition is this
report. This evidence establishes the transport blocker, not a production
adapter or general AGY scheduling failure.
