# Retained native continuity and drained-host retirement

The retained runtime can now explicitly stop a drained AGY host after its once job completed and its cron was explicitly cancelled, without a management prompt. It joins the original native process group, consumes late exit callbacks, durably confirms cleanup, and then releases ownership. Frontend replacement still retains the native host and does not use this stop path.

Both final Linux native acceptance runs passed on the corrected production build: Claude Code 2.1.311 and AGY 1.5.9. Both retained the original native process, conversation, definition identities and MCP endpoint through frontend replacement. Both subsequently stopped through the product API with exit code 0 and the exact original process group absent. Native versions identify the experiments; no version gate was added.

## Product changes and safety boundary

Only these product files changed:

- `packages/cli/src/scheduling/ScheduleService.ts:781`: `canRetireDrainedHosts`, `beginDrainedHostRetirement` and `finishDrainedHostRetirement` separate synchronous admission from actual retirement proof. Admission requires an initialized, healthy, current owner; completed once jobs or cancelled definitions with cancellation intent and exact removal evidence; no recovery state, live occurrences, pending output, mutation, cleanup obligation or outstanding operation. Catalogue terminal state alone is insufficient.
- `packages/cli/src/sessionHost/RetainedRuntime.ts:318`: explicit stop fences commands, managed tools and new native occurrence admission, then directly destroys/joins the existing executor pool. Owner validity and callback ingestion remain intact through group exit. The runtime drains its native journal before finalizing service cleanup and closing bridges, delivery and journal resources. Overlapping stop calls join the same promise; a failed exit retains the same executor and ownership locks for explicit retry.

AGY invalidates its definition inventory after process exit. The service therefore retains the exact pre-exit deletion receipt during admission and only combines it with confirmed retirement afterward. It does not reinterpret an empty inventory as an empty queue, recreate definitions, call provider release/recovery, or certify cancellation as occurrence retirement.

The new admission also fences the service's ordinary mutation/restart APIs. Unexpected new or unjoined native work during retirement is rejected and remains in the retained runtime's durable event journal. Persistence faults retain ownership and do not launch provider cleanup. A failed durable write is not automatically cleared on retry. This is explicit shutdown of already-drained work, not a new crash/reboot recovery or legacy migration policy.

## Regression verification

Added six controlled regressions in the existing `ScheduleService.test.ts` and `SessionHostRuntime.test.ts`:

1. Completed once plus cancelled-after-fired AGY-like cron remains `retirementConfirmed=false` until executor retirement; cancellation cleanup is certified only after exit, including inventory invalidation at exit.
2. Failed exact exit keeps the writer lock, rejects commands/new wakes and retains cancellation ownership; retry uses the same executor. Late exit callbacks enter the durable journal before teardown and are fully consumed.
3. Live work, admitted execution, pending Router ACK and native mutation refuse stop without touching the executor.
4. Concurrent stop callers join one shutdown operation.
5. Missing native deletion receipt or missing retirement proof refuses finalization; no list/cancel/stop management is repeated during retirement.
6. Persistence failure and unexpected late occurrence callbacks remain fenced; no provider cleanup is invoked to erase uncertainty.

These are synthetic state-machine tests, not native process-exit evidence. The separate native runs below supply that evidence.

Focused coverage command, **330 passed**:

```sh
npm test -w @yu_robotics/remote-cli -- tests/SessionHostRuntime.test.ts tests/ScheduleService.test.ts tests/ScheduleRecovery.test.ts tests/SchedulePurge.test.ts tests/MessageHandler.schedule.test.ts --coverage --coverage.include=src/sessionHost/RetainedRuntime.ts --coverage.include=src/scheduling/ScheduleService.ts --coverage.reporter=text --coverage.reporter=json-summary --coverage.reportsDirectory=coverage-retained-final
```

| Module | Statements / lines | Branches | Functions |
| --- | ---: | ---: | ---: |
| ScheduleService | 97.79% | 91.21% | 97.67% |
| RetainedRuntime | 98.33% | 80.32% | 96.55% |
| Combined | 97.88% | 89.51% | 97.39% |

The sanitized relative-path coverage summary is `retained-host-final-coverage.json`. The generated coverage directory was removed.

Broader regression command, **476 passed, 1 failed**:

```sh
npm test -w @yu_robotics/remote-cli -- SessionHost ScheduleService ScheduleRecovery ThreadExecutorPool AgyExecutor AgySessionSchedules AgyScheduleHost AgyRecovery --coverage --coverage.include=src/sessionHost/RetainedRuntime.ts --coverage.include=src/scheduling/ScheduleService.ts --coverage.reporter=text --coverage.reporter=json-summary --coverage.reportsDirectory=coverage-retained-final
```

The failure is `ClaudeScheduleRecovery.test.ts:165`, `uses real handler and updater after installation (failure=true, skippedOnce=false)`: expected `active`, received `interrupted`. It reproduces in the three-case focused run and with **the original checkpoint ScheduleService** resolved through a temporary Vitest alias. The temporary baseline module/config were removed. `MessageHandler.endAutomaticUpdate(failed=true)` now preserves the failed-update recovery fence instead of automatically restoring schedules, while this older test still expects restoration. This is a pre-existing snapshot mismatch, outside the targeted retained-host stop fix; neither that policy nor the test was changed here. The other two installer cases pass. The 476 passing broad cases include executor pool, AGY executor/provider, host process/IPC, supervisor contract, shared recovery and DSH recovery coverage. Do not describe the entire suite as green.

Both builds passed:

```sh
npm run build -w @yu_robotics/remote-cli
npm run build -w @yu_robotics/remote-cli-router
```

## Native acceptance and preserved failed attempts

First ran the exact requested historical fixture, unchanged:

```sh
python3 output/retained-host-native-probe.py claude --output output/retained-host-final-claude.json
python3 output/retained-host-native-probe.py agy --output output/retained-host-final-agy.json
python3 output/retained-host-native-verify.py output/retained-host-final-claude.json
python3 output/retained-host-native-verify.py output/retained-host-final-agy.json
```

Both runs reached continuity, successful native in-turn MCP, ACK retry and clean product shutdown, but exited 1 at the historical assertion that a direct bridge request *outside* any invocation should succeed. The current coordinator guard correctly returned `No admitted native invocation owns this tool request.` The original verifier rejects both failed artifacts. They remain unchanged and are not counted as passing acceptance runs.

New versioned fixtures retain the same isolation, real native timer flow, fake model actions, compiled production components and default 250 ms frontend polling. The only behavior observations changed are: assert out-of-turn rejection; independently verify genuine in-turn native MCP receipts; measure explicit stop separately from preceding authorized cancellation; retain the final catalog and stronger exit checks. No occurrence events or process-exit receipts are injected. The original frontend fixture is reused.

```sh
python3 output/retained-host-native-final-v2-probe.py claude --output output/retained-host-final-v2-claude.json
python3 output/retained-host-native-final-v2-probe.py agy --output output/retained-host-final-v2-agy.json
python3 output/retained-host-native-final-v2-verify.py output/retained-host-final-v2-claude.json output/retained-host-final-v2-agy.json
python3 output/retained-host-native-final-v2-verify.py --self-test output/retained-host-final-v2-claude.json output/retained-host-final-v2-agy.json
```

Both native commands and independent verification passed. The verifier's two test methods accept both artifacts and reject 30 corrupted variants. Its first self-test attempt exposed a malformed synthetic corruption row missing `action`; that test row was fixed, without changing native evidence or the actual verification rules.

| Observed fact | Claude | AGY |
| --- | ---: | ---: |
| Lifecycle interval, milliseconds from fixture start | 37,967–140,760 | 16,289–140,792 |
| Gap deadline observation | 140,706 | 140,739 |
| Provider requests during lifecycle | 0 | 0 |
| Native protocol/management operations during lifecycle | 0 | 0 |
| Setup / foreground fake-provider requests | 7 | 7 |
| Auxiliary fake-provider requests | 0 | 1 |
| Scheduled-content fake-provider requests | 4 | 3 |
| Explicit cancellation teardown fake-provider requests | 3 | 6 |
| Native terminal results | 1 once + 2 cron | 1 once + 2 cron |
| Successful actual native MCP receipt | Yes | Yes |
| Original-result delivery attempts after dropped ACK | 2 | 2 |
| Additional provider requests during ACK retry observation | 0 | 0 |
| Explicit stop interval | 156,363–156,431 ms | 157,314–157,355 ms |
| Provider / native-management calls during explicit stop | 0 / 0 | 0 / 0 |
| Native parent exit / signal | 0 / none | 0 / none |
| Exact original native process group absent | Yes | Yes |

The setup and explicit schedule cancellation use the existing authorized management flow against a deterministic fake model. They are counted separately; **no claim is made that cancellation itself is model-free**. Frontend lifecycle and subsequent drained-host stop are the zero-inference intervals.

The first genuine scheduled request was held across frontend A's exit and frontend B's attachment. The native once deadline passed during that gap. Release yielded the original occurrence result, the once result and the next cron result without identity replacement. AGY legitimately joined native reminders into a batch; three terminal events do not imply three independent inference sessions. The separate frontend B process loaded version 1.6.249 command logic and handled the subsequent status command while the retained runtime remained truthfully 1.6.248.

Each artifact contains native binary and compiled runtime hashes, exact synthetic identities, provider request timestamps, native receipts/callbacks, delivery attempts, snapshots, frontend terminals and cleanup receipts. Version 2 additionally records the compiled ScheduleService and fixture hashes. The final compiled hashes match the tested files. `retained-host-final-checks.json` summarizes derived checks and source hashes.

## Isolation, cleanup and limits

All four runs used Bubblewrap `--unshare-all`, a fresh disposable HOME/config/history/workspace and isolated loopback fake provider. The mount set excludes host HOME/auth, clears inherited environment and mounts only required executables/dependencies/compiled application read-only. Each fixture checked that its private network had no external route. No external model, live account, Router/Feishu, service manager, Docker, PS2 or user schedule was used.

All frontend children exited 0 and were joined. All four product host stops succeeded, native parents exited 0, exact native process groups were absent, and no native executable survived before namespace exit. Fake provider listeners/connections closed, Bubblewrap namespaces were joined, and disposable roots were removed. No SIGKILL fallback was needed for these runs.

Only Linux x64 executed. Real Router/Feishu delivery, actual OS-supervised frontend replacement, package installation, macOS/Windows, legacy-session migration, crash/reboot recovery and uncertain admitted work remain unverified or outside scope. Pending output, uncertain exit or durable-write failure still deliberately blocks final ownership release. The known baseline Claude installer-failure recovery test remains a coordinator follow-up.

Exact source/test diffs and all new artifacts were reviewed for privacy. Native identities and prompts belong only to synthetic fixtures; fixture credentials are redacted or explicitly synthetic; artifact paths are generic or repository-relative; loopback endpoints are not deployment endpoints. The two email-pattern matches are the native binary's public Claude attribution address, not personal fixture data. Pattern checks are supplemental to manual review, not a repository-wide secrecy guarantee. No historical output, manifest, release documentation, launcher, supervisor or unrelated protocol source was changed. No commit, push or deployment was performed.
