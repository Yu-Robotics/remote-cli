# OpenCode 2.2.7 native scheduling verdict

Verified on 2026-11-11. Scope: native timed jobs with autonomous results over
remote-cli's existing OpenCode ACP transport.

**Verdict: not supported over the shipped ACP bridge. Native scheduling itself
is supported in OpenCode 2.2.7.** This differs materially from the installed
1.19.5 runtime, which has no built-in scheduler.

## Version and evidence

The public npm registry identifies `@opencode/cli@2.2.7` as the current package,
with repository `anomalyco/opencode`. The older `opencode-ai` package remains at
1.19.5. The complete official `v2.2.7` source archive was downloaded and inspected;
its root and CLI manifests both identify 2.2.7. Archive SHA-256:
`493e29d872f1cd9604ef3de609f0278e093c0f8066719e4166efc6544d16f34d`.

Source archive: <https://codeload.github.com/anomalyco/opencode/tar.gz/refs/tags/v2.2.7>.

## Native timing: supported

- [Native scheduler](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/schedule.ts#L63)
  implements create/list/get/pause/resume/remove and a native due-time loop.
  It stores jobs in SQLite and elects one scheduler leader per database.
- [Built-in tool plugin](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/tool/plugin/schedule.ts#L54)
  registers `schedule_create`, `schedule_list`, `schedule_pause`,
  `schedule_resume`, and `schedule_delete`. Native configuration enables them
  through `experimental.schedules`; no replacement timer is needed.
- [Server startup](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/server/src/process.ts#L118)
  starts the scheduler for every server process, including standalone servers.
  The [ACP launcher](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/commands/handlers/acp.ts#L27)
  starts that native standalone server, so default tool visibility is not the
  decisive limitation.
- [Native wake admission](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/schedule.ts#L259)
  submits a session prompt with a stable schedule/run-derived message ID and
  `metadata.schedule` containing the job ID, run, and due time.

## Existing ACP result path: not supported while idle

The complete ACP event-subscription paths were inspected, including the child
session extension and persistent catalog/selection listeners:

1. [ACPTurn.open](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/acp/turn.ts#L77)
   opens the output event subscription. The call is acquired by `run` for a
   client `session/prompt` at lines 363-383.
2. [ACPTurn.handoff](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/acp/turn.ts#L307)
   closes that subscription when the request ends and no child remains open.
   A later native schedule wake has no root-output listener in the ACP bridge.
3. The child-work exception does not provide a root schedule listener:
   [background interpretation](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/acp/turn.ts#L141)
   discards root `SessionUpdate` output, and lines 203-209 fold only events
   belonging to tracked children while in background mode.
4. The persistent [session listener](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/acp/sessions.ts#L53)
   explicitly filters to model/agent selection changes. The
   [catalog listener](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/acp/catalog.ts#L67)
   only reloads catalog entries. Neither forwards autonomous model output.
5. [Turn translation](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/acp/translate.ts#L125)
   also waits for delivery of the current client prompt's input ID before
   emitting its turn's ordinary output. A dedicated remote-cli session cannot
   repair missing native bridge events.

This is an explicit source-level transport limitation, not a conclusion from
missing documentation or a keyword search. It applies to autonomous work after
the creation request has completed; coincidental firing during an active request
does not establish reliable scheduled delivery.

## Integration boundary and verification limits

The native HTTP API has experimental schedule CRUD and an event stream. An
adapter using those APIs is a distinct transport integration and may be viable,
but it is not the current ACP contract requested here. Alternatively, upstream
ACP would need a permanent autonomous-session output and completion path.
Changing remote-cli's own idle listener or enabling the native schedule flag
does not supply that missing bridge path.

This follow-up used complete tagged source and public package metadata. It did
not execute the 2.2.7 binary, create jobs, access credentials, alter global
installation/configuration, or send messages. The downloaded scratch source was
removed after the evidence was recorded. The separate 1.19.5/Pi review records
its own source and runtime checks.
