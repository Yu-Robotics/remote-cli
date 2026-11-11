# DSH native scheduling provider

## Integration boundary and remaining limits

The provider and packaged host plugins are integrated through the existing
`NativeScheduleProvider` contract. Backend types, capability registration,
ScheduleService persistence, MessageHandler dispatch, and result delivery retain
the selected Claude or DSH backend. Both READMEs and synchronized 1.6.232
manifests/release notes are included in the same uncommitted change set.

The native target is DSH **0.2.1-rc.5**. Verification uses synthetic model streams,
not authenticated inference or Feishu delivery. Native macOS and Windows runs,
live credentials/provider configuration, DST transitions, and load behavior
remain unverified. Linux process-group proof and the existing macOS/Windows
managed launch and exit-proof implementations are reused. These contain tracked
process groups/Jobs; they do not sandbox arbitrary model filesystem access or
processes deliberately escaping a POSIX process group.

Scheduled work uses native permission policy. ACP permission requests receive a
cancelled outcome; unknown client RPCs are rejected. The adapter does not change
global approval settings or silently grant unattended access. Native schedule,
plugin reconfiguration, PTC code, and subagent management tools are denied by a
monotonic native tool guard. Other ordinary native tools remain subject to their
normal policy. Arbitrary OS actions are not globally intercepted.

## Implementation

- `DshNativeScheduleProvider.ts` owns one ordinary ACP session/process and a
  fresh scope per schedule. It never calls `session/prompt`, resumes sessions,
  reopens retained stores, or implements a scheduling clock. The only local
  timers are finite management and shutdown deadlines.
- `dsh/launch.ts` writes a private process-local overlay. Session JSONL, session
  query, native scheduler/domain storage, and attachments use owned paths.
  `HOME`, `DSH_HOME`, credential files, and native profiles retain normal native
  loading. No credentials are read or copied by the adapter. Both existing DSH
  privacy overlay controls and the telemetry environment opt-out are applied.
- The overlay mounts the six first-party services established in the
  [native verdict](agy-kimi-dsh-native-scheduling-verdict.md): connection,
  file-upload, workspace, session-controller, schedule, and tool-schedule. It
  does not mount a web server or replace ACP with HTTP/SSE.
- `ScopePlugin.ts` gates native scheduler activation. It verifies canonical
  private roots, actual native JSON/JSONL routing, an empty session root, and
  absence of the native `schedule.json` store before releasing the scheduler.
  Other native domains can initialize fresh metadata concurrently. The bridge
  separately verifies an empty native schedule catalog before releasing ACP.
- `HostBridge.ts` observes the same stdin bytes as stock ACP with a bounded NDJSON
  parser. `_remote_cli/native_schedule_command` notifications carry version,
  private scope nonce, monotonic request ID, operation, and exact session
  ownership. Stock ACP ignores these unknown notifications; the bridge ignores
  standard ACP RPCs. Versioned receipts and occurrence events use
  `_remote_cli/native_schedule_event` on the same stdout, one JSON write per line.
- Native `ctx.schedule.create/list/catalog/delete` supplies authoritative CRUD.
  Receipts must match the exact prompt/title, native ID, one-shot instant, or
  cron field semantics plus explicit IANA timezone. Cron validation compares
  field sets and Vixie DOM/DOW star semantics; it never computes firing times.
- Native schedule-source framing identifies the schedule and occurrence.
  `agent/inbox/claimed` binds its native message to the actual turn. Native
  assistant events contribute bounded text; `turn/end` supplies success/failure.
  Terminal extension events include their own output, since native ACP text
  may arrive later. Reasoning, raw provider exceptions, stderr, and arbitrary
  native diagnostic strings are not forwarded or retained by the adapter.
- The provider checks scope, protocol version, ordered sequence, session/job
  ownership, turn/message/occurrence matching, duplicate terminals, and size
  bounds. Native catalog changes trigger event-driven ownership checks, not
  polling. Unexpected rows or sessions fail closed and trigger cleanup.

## Lifecycle and cleanup

One-shot completion stops the dedicated process and removes its inactive native
row. A fired one-shot remains visible through the native catalog while its turn
is executing, so a list operation cannot prematurely interrupt that turn.
Recurring work remains alive until native cancellation or stop. A management
cancel also cancels the native agent; an already-running occurrence can report
its native aborted result before confirmed shutdown.

Stop first attempts native deletion, then EOF, TERM, and KILL within bounded
waits. Transport close alone is insufficient: the existing process-group or
Windows Job tracker must prove exit before deleting the private scope and
emitting `stopped` with `exitConfirmed: true`. A failed native delete cannot
leave a resumable hidden job: confirmed exit plus removal of the exclusively
owned store stops it, and no code path ever resumes that store.

Unconfirmed exit or storage-identity/cleanup failure retains ownership and emits
`exitConfirmed: false`. Failed creation returns `NativeScheduleCleanupError`
with the cleanup handle. Explicit stop can be retried. Lost receipts,
interrupted turns, malformed frames, and unexpected exit never become success.
An interrupted occurrence reports failure with bounded generic text.

## Packaging and verification

All runtime plugins and helpers are TypeScript compiled by the existing CLI
`tsc` build into `dist/scheduling/dsh`. Existing npm `files: ["dist", ...]`
packages them automatically; no runtime temporary source generation, asset-copy
script, manifest edit, or new native dependency is required. The source provider
requires the built `.js` bridge at runtime, as the shipped CLI does.

Focused tests live under `packages/cli/tests/scheduling/`. They use canonical
`os.tmpdir()` fixtures and mocked home lookup, deterministic injected child
streams, native API fixtures, and explicit exit-proof failure/retry seams.
No test fixture contains credentials or transcripts.

Run the bounded native probes only after building the CLI, with exactly DSH
0.2.1-rc.5 installed:

```sh
npm run build -w @yu_robotics/remote-cli
DSH_SCHEDULING_INTEGRATION=1 npm test -w @yu_robotics/remote-cli -- tests/scheduling/DshNativeScheduleProvider.integration.test.ts
```

The native integration suite uses fresh empty authentication homes and a
supported `llm/stream` fixture plugin. It exercises the compiled artifact,
standard ACP initialization/new-session alongside extension CRUD, native
one-shot success/failure, cron creation/cancellation with an explicit timezone,
the native nested-schedule tool guard, and a real recurring firing. Every native
probe owns a finite deadline and uses the provider's confirmed cleanup. Native
recurrence can require waiting for the next minute; it is not accelerated with
a replacement timer or periodic model prompts.

### Worker verification before shared integration

Verification on Linux with Node 22.23.1 and DSH 0.2.1-rc.5:

- Full CLI build passed; the final TypeScript compilation also passed after
  adding rejection of late success frames following a protocol failure.
- 86 focused provider/protocol tests passed. V8 coverage across all five new
  source modules: 99.62% statements/lines, 86.15% branches, and 98.46% functions.
  Each new source module exceeds 80% line and branch coverage.
- All five real native integration scenarios passed in one run (50.85 seconds).
  Standard ACP and extension CRUD shared stdin/stdout successfully. Each probe
  confirmed process-tree exit and absence of its private scope afterward.
  The native success case was additionally rerun after the final failure-path
  hardening; failure-followed-by-success is covered by deterministic regressions.
- 186 existing tests passed across ClaudeNativeScheduleProvider, ScheduleService,
  DshExecutor, and ManagedProcessGroups.
- `npm pack --dry-run --json --ignore-scripts` confirmed the provider and all
  four compiled bridge/helper modules are included under `dist/scheduling/`.
- New deliverables were reviewed for whitespace, private paths, credentials,
  and retained diagnostics. Only synthetic fixtures are included. No tracked
  baseline files, shared registration files, manifests, or build scripts changed.

These results establish the adapter and synthetic native transport/lifecycle
path on Linux. They do not establish authenticated model behavior, cross-platform
native execution, or end-to-end routing before coordinator integration.

### Final coordinator integration

The native suite now exercises all five scenarios through ScheduleService,
its persisted catalog/outbox, and ScheduleDeliveryClient with an in-memory
Router receipt boundary. It uses minute-aligned one-shots and independent
concurrent scopes. All five passed after the shared integration and review
fixes; all process trees and native stores were retired. This does not send
real Feishu messages or replace native timing with a test clock.

Same-turn `tool-jobs` and `tool-registry` input is contextual and does not replace
the schedule occurrence join, including when native claim ordering puts context
before the scheduled message. Context alone cannot authorize a terminal result.
Failed service destruction can be retried without reopening admission or
repeating cleanup of already-stopped sibling jobs. Router scheduled-result
admission now accepts both supported backends and fences backend changes.

See the [final combined acceptance](native-scheduling-inventory.md#final-combined-acceptance-on-linux)
for current build, full-suite, focused regression, and coverage results.
