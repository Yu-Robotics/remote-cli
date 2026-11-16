# Schedule recovery validation for 1.6.252

## Review-fix scope

This review-fix checkout starts at `271357c7e737e7a4e6ce9c3297ff5951f0c437d7`.
It addresses the two independently reported P2 blockers in the integrated candidate.
All package manifests and the lockfile remain at `1.6.252`.
The coordinator's AGY process-discovery exclusion is preserved. Retained-host code,
original native session pointers/history, result delivery, and ACK isolation are
preserved. No remote hosts, native sessions, publication, commits, pushes, or
sub-agents were used for this work.

## Admission contention and untouched siblings

`ScheduleService` now acquires thread admission before consuming a clean checkpoint
or registering a recovery runtime. A refusal at this boundary leaves the sibling
interrupted and pending with its original clean handoff and native-absence evidence.
It does not invoke native reconciliation. An actual admitted restoration failure
still becomes quarantined and is not retried.

Exact settlement releases the failed runtime's admission and schedules another
recovery pass after the current pass finishes. That pass selects only pending rows
and rechecks owner, configuration, foreground readiness, and admission. A newer
lock can defer the sibling again without consuming its checkpoint. Successful
reconciliation persists the handle's current recovery identity.

Synthetic regressions cover two clean suspended jobs, the first timing out and the
second never being admitted, late settlement, automatic sibling recovery, ordinary
chat and a later sibling occurrence in the same host. Provider-neutral service
regressions cover a newer foreground lock and two catalog restarts before recovery.
The failed job remains quarantined throughout. Existing late-result and durable ACK
coverage remains in the focused run.

## Ownership incarnation and historical obligations

Ownership receipts now carry an optional `ownerToken`, distinct from the per-host
receipt token. The ownership incarnation survives a proven clean handoff; explicit
rearm from a dirty receipt creates a new incarnation and archives the original
receipt unchanged. The global historical uncertainty flag is retained.

`describe()` remains free of reservation side effects because it can precede
`reserveForNewJob()`. The returned handle captures the actually admitted owner
incarnation once, after reservation. Its identity getter does not borrow a later
host's token. Creation, successful restoration, and orderly handoff persist this
identity. Old uncertain or unattributed jobs cannot use a new incarnation's clean
or live proof for recovery or cancellation. Archived receipts are diagnostic only;
no native authorization reads them.

Retained cancellation and reviewed cleanup accept proof for the exact job owner.
Reviewed batches evaluate each record independently. History purge preserves the
optional owner token in its deletion-only selector, so restart does not lose that
attribution. The selector retains no task text or replay permission. The catalog
accepts legacy selectors and validates new token syntax.

Production executor/provider regressions exercise legacy dirty rearm, normal new
creation, clean handoff, executor/catalog restart, optional clean recovery followed
by another handoff, failed synchronous preflight, and retained cancellation. The
new job succeeds and the old job still reports predecessor uncertainty, even with
empty native inventories. Tests also verify unchanged archived bytes, the same
session, exact reviewed-removal proof, owner-token persistence after history purge,
and refusal to reuse old proof. Live-host exclusion tests remain unchanged.

## Earlier candidate evidence (historical)

The preceding implementation report described input `178ce54` (parent `ba8f68d`),
not this review-fix checkout. It reported **584 tests in 14 suites** and
**246/249 changed instrumented lines covered (98.80%)**. Those are earlier receipts,
not results of this run and not evidence that these two interleavings were covered.
Its reported focused line coverage was 98.47% for `ScheduleService`, 98.44% for
`ClaudeScheduleOwnership`, 100% for `ClaudeScheduleProcesses`, and 94.14% for
`ClaudeSessionSchedules`. The prior selected-file aggregate was 65.82%, including
large unrelated executor/handler surfaces. These historical figures are not reused
as current coverage claims.

## Current verification

Run from the repository root:

```sh
npm run build
npm test -w @yu_robotics/remote-cli -- ClaudeScheduleRecovery.test.ts ScheduleRecovery.test.ts ScheduleService.test.ts SchedulePurge.test.ts MessageHandler.schedule.test.ts scheduling/ClaudeScheduleOwnership.test.ts scheduling/ClaudeScheduleProcesses.test.ts scheduling/ClaudeSessionSchedules.test.ts scheduling/AgyScheduleHost.test.ts scheduling/AgySessionSchedules.test.ts scheduling/SessionScheduleClient.test.ts ClaudePersistentExecutor.scheduling.test.ts scheduling/ScheduleDeliveryClient.test.ts TestScheduling.test.ts scheduling/ScheduleCleanup.test.ts scheduling/SchedulePurgeVerification.test.ts ReviewedNativeCleanup.test.ts --coverage --coverage.reporter=json --coverage.reporter=text --coverage.reportsDirectory=coverage/review-fixes --coverage.include=src/scheduling/ScheduleService.ts --coverage.include='src/scheduling/claude/*.ts' --coverage.include=src/executor/ClaudePersistentExecutor.ts --coverage.include=src/client/MessageHandler.ts --coverage.include=src/scheduling/ScheduleCleanup.ts --coverage.include=src/scheduling/SchedulePurgeVerification.ts
```

Final Linux result: **735 tests passed in 18 suites** (123.72 seconds).
Both workspace builds passed, including release-summary validation and Router asset
packaging. `git diff --check` passed. Manifest and lockfile versions were verified
as `1.6.252`; neither the coordinator's process-discovery source/test nor the
manifests changed in this delta.

Current V8 coverage:

| Module | Lines | Branches | Functions |
| --- | ---: | ---: | ---: |
| ScheduleService | 99.24% | 92.66% | 100% |
| ClaudeScheduleOwnership | 98.55% | 92.16% | 100% |
| ClaudeScheduleProcesses | 100% | 96.92% | 100% |
| ClaudeSessionSchedules | 94.14% | 86.44% | 98.30% |
| ScheduleCleanup | 100% | 97.43% | 100% |
| SchedulePurgeVerification | 100% | 96.46% | 100% |

Intersecting this checkout's `git diff --unified=0` added lines with Istanbul line
counters gives **75/75 covered changed instrumented lines (100%)** across six
runtime files: MessageHandler 3/3, ClaudePersistentExecutor 8/8, ScheduleCleanup
3/3, SchedulePurgeVerification 5/5, ScheduleService 31/31, and
ClaudeScheduleOwnership 25/25. The type-only `NativeCleanupSession` interface
change is outside instrumentation. This exceeds 80% relevant changed-line coverage;
it is not a repository-wide coverage claim. The selected-file aggregate is
**66.47% lines**, including unrelated handler/executor behavior.

The initial runs caught a repeated persistence attempt after a catalog fault; the
recovery diagnostic now respects the existing fault fence. Test development also
caught an incorrect reload-helper call and a missing lifecycle terminal introduced
while editing a fixture; both were corrected and their targeted regressions passed.
The public-chat fixture registers managed tools before creating schedules so a
later configuration change does not recycle the host under test. A coverage rerun
also exposed a 20 ms deadline racing the healthy setup in the existing late-sibling
test. That fixture now establishes the healthy job under a longer setup deadline,
then applies the short deadline only to the intended stalled restore. The exact
no-recycle and late-terminal assertions remain intact. The targeted coverage check
and final complete rerun both passed.

## Limits and delivery

All execution in this worker was on Linux, using synthetic native transport,
isolated temporary homes, and fixture process inventories. Both workspace builds
ran on Linux. macOS/Windows native execution and actual backend acceptance remain
unverified here; parser/path mocks are not native platform evidence. Independent
native validation on the pre-review-fix candidate does not validate this delta.

Unknown live hosts and incomplete inventories still block admission. Historical
external effects remain unknown. Failed attempts are never replayed, and a stalled
host with active siblings, admitted work, or uncertain mutations cannot be recycled
just to release a fence. An old job without an incarnation cannot obtain new proof
from an archived diagnostic; its uncertainty remains visible.

README variants were reviewed and updated equivalently for pending siblings and
new-job proof after clean handoff. The existing 1.6.252 changelog and user summary
were clarified without changing versions. Changed source, tests, and documentation
are the captured delivery; generated dependencies, builds, and coverage files are
not required artifacts. Added fixtures use synthetic identifiers and portable
paths. Manual diff review and an added-line pattern check found no credential-shaped
literals, deployment IPv4 literals, or private home paths. Review of this diff is not a repository-history or binary secret audit.
