# AGY 1.5.5 native scheduling verdict

Rechecked against remote-cli checkpoint `f7135b3f505f2092a19d2506e260f31a59b30ea2`.

## Decision

**AGY 1.5.5 is not supported for remote-cli's required native one-shot plus recurring scheduling closed loop over the existing stream-json transport.** Native scheduling works, including a verified daemon cron. The CLI does not emit its recurring output while stdin is idle, and later combines multiple occurrences with the next submitted turn's terminal result. A permanent remote-cli listener or one process per schedule cannot recover absent native frames.

This is fresh native-runtime evidence for **1.5.5**, superseding the version scope of the [1.5.4 probe](agy-scheduling-protocol-review.md) and [previous options review](agy-kimi-dsh-native-scheduling-verdict.md#agy-supported-options-do-not-supply-the-missing-stream-delivery-contract). It does not mean AGY lacks native timers or model-tool management.

Installed `agy --version`: **1.5.5**. Executable SHA-256, unchanged before and after probing:

`89f16bdb87f62e6d07484c52e6bafe76a81b0fd13d740110c77dc3c3c8d8d8b6`

## Isolation and fixture

Each process had fresh private HOME, profile, XDG, temporary and working directories. Nothing was copied from the user's authentication, settings, plugins or conversations. The documented [Gemini API-key mode and custom endpoint](https://antigravity.google/docs/install#using-a-gemini-api-key) supplied the model path: session-only `modelProvider: gemini`, a synthetic noncredential, `GOOGLE_GEMINI_BASE_URL` pointing at a loopback HTTP fixture, and a custom model using native function calls. The [published settings schema](https://antigravity.google/schemas/v1/settings.json) documents these provider/custom-model settings. Non-loopback proxy traffic was rejected by the fixture.

The fixture emitted deterministic Gemini-compatible function calls and text, not inference. AGY itself executed `schedule` and `manage_task`. File, command, web and MCP tools were denied through session settings; slash expansion was disabled. No real account, provider inference, external message or project mutation was involved.

All runs used `--input-format stream-json --output-format stream-json`, with stdin held open. During the measured recurring idle window, the client sent **no input**, and the fixture sent nothing unsolicited: it responded only to HTTP requests initiated by AGY. There was no replacement timer or periodic prompting. The only later user input requested cleanup.

## Decisive recurring measurement

The fixture requested native `schedule` with `CronExpression: "* * * * *"`, `IsDaemon: true`, `ExactTiming: true`, and a synthetic notification prompt. Native `manage_task` list returned one schedule with the requested cron/prompt and **`isDaemon: true`**. Thus this run resolves the earlier uncertainty about whether daemon mode was actually applied. There was no iteration cap that could stop the job before observation.

Elapsed times below are seconds from native process spawn. These are derived event measurements, not a transcript.

| Time | Observation |
| --- | --- |
| 2.380 | Native list receipt contained one daemon schedule. |
| 2.393 | Setup completed with `result`, `status: SUCCESS`, `num_turns: 1`; idle measurement began. |
| 42.108 | AGY independently called the loopback provider with the native scheduled-notification marker. The fixture returned occurrence 1's distinct text marker. Only one stdin user message had ever been sent. |
| 102.110 | A second native scheduled notification called the provider, 60 seconds later. The fixture returned occurrence 2's distinct marker; still only one stdin message. |
| 137.422 | **135.030 seconds idle, zero stdout frames**, despite both native scheduled executions. Client submitted its second and final input, requesting cleanup. |
| 137.434 | Previously unseen system steps 6/8 and response steps 7/9 arrived. Both occurrence markers appeared before cleanup's user-input step 10. |
| 137.453 | Native cleanup list/kill/list sequence reached the exact empty-task receipt: `No background tasks are currently running.` |
| 137.460 | One `result`, `status: SUCCESS`, `num_turns: 2`, contained **both scheduled responses and cleanup output**. No occurrence-specific terminal result had been emitted. |
| 137.488 | Native process exited 0 after stdin EOF; its process group was subsequently confirmed absent. |

The two unsolicited provider requests prove the native timer and agent loop actually ran; this was not a failed creation, missing model response, disabled daemon, or remote-cli output filter. The delayed stdout markers additionally prove those responses were retained and surfaced only when the next input reactivated stream output. Nine fixture requests covered setup tools, two scheduled responses and cleanup tools; none contacted a real inference service.

Late `system_message` frames carried only conversation ID, step index, state, step type and duration. Result payloads carried conversation ID, status, response, duration, submitted-turn count and usage. Neither supplied a native schedule/occurrence terminal identity. A synthetic marker is a diagnostic correlation aid, not an acceptable production completion identifier.

## One-shot and management checks

A separate process requested `DurationSeconds: 15`, `TimerCondition: "never"`, and a synthetic prompt. Native list confirmed the timer. AGY called the fixture for the timer notification at **15.227 seconds** without another stdin input. At **15.244 seconds**, its first terminal result contained both setup and occurrence output with `num_turns: 1`. This demonstrates working native one-shot timing, but does not demonstrate separate setup and occurrence terminal results. It does not repair the recurring failure above.

The one-shot cleanup list was empty and its process exited 0. For the recurring run, the fixture extracted the actual `taskId` from the native list, passed it to `manage_task` with `Action: kill`, and obtained an empty native list afterward. Management was performed through real native tools, not assistant confirmation prose or fabricated CRUD acknowledgments.

## Supported configuration and event-adapter boundary

The complete installed help and current official [headless protocol](https://antigravity.google/docs/cli/headless/), [CLI reference](https://antigravity.google/docs/cli/reference), [schedule](https://antigravity.google/docs/commands/schedule), [settings schema](https://antigravity.google/schemas/v1/settings.json), [plugins](https://antigravity.google/docs/plugins), [plugin authoring](https://antigravity.google/docs/build-plugins/) and [hooks](https://antigravity.google/docs/hooks?tab=cli) were rechecked.

- Print timeout, output/input formats, ownership/resume flags, model/agent selection, permissions and daemon/timing fields supply no supported autonomous-result subscription. The measured process already had unlimited print timeout, enabled schedule tools and confirmed daemon mode.
- Plugins can bundle agents, skills, rules, MCP servers and lifecycle hooks. Command-hook stdout is consumed as the hook's JSON response; it is not the parent stream-json notification writer. `Stop` exposes execution number, termination reason and `fullyIdle`, but its return controls stopping/continuation. It does not expose an occurrence-result emission API. A hook socket/file relay would add a separate result channel; forcing continuation would not fix the demonstrated idle-stream contract.
- Supported event-only plugins are allowed under this review, as with DSH. AGY's reviewed plugin/hook contract does not expose DSH's equivalent of a host ACP notification writer. Selecting a custom agent does not itself expose the outer stream-json emitter. The negative verdict is therefore not based solely on missing direct CRUD or remote-cli's turn-scoped listener.

Public pages are live documentation, not version-pinned implementation source. The **pinned executable and fresh native measurements** establish the current failure; this report does not infer every internal branch from keyword absence. Enablement requires a supported native stream/event-adapter seam that demonstrably emits autonomous, separately correlated occurrence outcomes on this same transport. No eligible route was established in the reviewed 1.5.5 interfaces.

## Verification and cleanup

Derived-evidence assertions checked two native firings with exactly one prior stdin message, a minimum 135-second zero-frame window, only two submitted-turn results, both late occurrence markers in the cleanup result, native cancellation followed by an empty list, and the bundled one-shot result.

A schema-discovery process created no jobs. An initial short recurring fixture run exposed a task-ID parser mismatch and was stopped before the final measurement; closing stdin terminated its native process with exit 0 and no remaining process group. The corrected full recurring run verified native kill plus empty list. The completed one-shot left an empty list. All four native processes exited 0, all recorded native process groups were absent, and all fixture HTTP servers closed. Session-only timers from the interrupted preflight cannot remain active after confirmed process exit.

Private probe scripts, synthetic runtime data, native diagnostic files and fetched documentation were removed. Only this English report was added; production code, tests, manifests and DSH implementation were untouched. No build was required. Timezone/DST, restart behavior, real-provider model selection and other operating systems were not tested; none explains or removes the directly observed stream-json blocker.
