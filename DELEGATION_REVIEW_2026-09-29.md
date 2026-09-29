# Review of the September 29 Delegation Commits

## Scope and evidence

- Fixed point: `6c378be780827bf7a1cc792ba936e891679dc0e5`.
- Reviewed commits: `175cd22` (opt-in cross-backend delegation) and `22b13bc` (ordinary-thread isolation).
- Diff: `git diff 6c378be...22b13bc`.
- Product contract: `DELEGATION_PLAN.md`. Repository standards: `CLAUDE.md` and `CONTRIBUTING.md`.
- Verification on the reviewed checkout: `npm run build` passed; `npm test` passed with 1,293 CLI and 573 Router tests. Line coverage was 86.74% for CLI and 92.29% for Router. These results do not exercise the failure paths below.
- This is a code and test review. Live Feishu UI and macOS execution were not verified; the implementation plan already records those limits. No issue reference appears in either commit, so the in-repository plan is the specification used here.

## Standards

1. **P2 — Translate the new Chinese README section.** `README_ZH.md:440` describes `/delegation` in English, and `README_ZH.md:450-541` copies the entire new section in English. `CLAUDE.md` requires the English and Chinese READMEs to have equivalent content in their respective languages and aligned sections. Translate the command row and section while preserving their order and technical details.

2. **P2 — Update the architecture guide.** The new lifecycle and transport modules are introduced at `packages/cli/src/delegation/DelegationManager.ts:76` and throughout `packages/cli/src/delegation/`, but `CLAUDE.md` still has no delegation ownership or call-flow description. `CONTRIBUTING.md:148-151` calls for updating `CLAUDE.md` when architecture changes. Add the coordinator/worker boundary, bridge, persistent task records, and executor adapter responsibilities.

3. **P3 — Type the new protocol boundaries.** `packages/cli/src/delegation/DelegationBridge.ts:53`, `mcpServer.ts:17`, and `piExtension.ts:4,21` use avoidable `any` for input crossing HTTP, JSON-RPC, or Pi registration boundaries. `CONTRIBUTING.md:87-95` requires strict typing and reserves `any` for unavoidable cases. Parse external input as `unknown`, narrow it before use, and define a local Pi tool-registration interface. This is a standards finding, not a demonstrated runtime defect.

## Spec

1. **P1 — Do not release a Pi worker's workspace without confirmed exit.** `packages/cli/src/executor/pi/PiClient.ts:124` resolves `stop()` on a give-up timer even if the process never emits `exit`. `PiExecutor.destroy()` (`PiExecutor.ts:396-405`) awaits only that method and has no `waitForExit` implementation. Consequently, `DelegationManager.ts:189-201` can mark cleanup successful and release the workspace lease while the Pi process may still exist. Another managed task could then start in the same directory. `DELEGATION_PLAN.md:425-429` explicitly requires an interrupted result and retained lease/capacity whenever cleanup cannot be confirmed. Make unconfirmed stop reject or expose a confirmed-exit signal to the manager; cover the no-exit path in a regression test.

2. **P2 — Preserve the legacy Claude model setting for workers.** `DelegationManager.ts:138-139` passes only `parent.thread.models?.[backend]` to the executor factory. Ordinary thread execution also falls back to `thread.model` for Claude (`ThreadExecutorPool.ts:12-20`). A thread using that persisted legacy field can therefore run its coordinator with the chosen model while a delegated Claude worker silently uses the backend default. `DELEGATION_PLAN.md:353-355` says workers use the existing model selection. Share the model resolver with the thread pool or apply the same Claude fallback, and add a legacy-thread test.

3. **P2 — Fail before worker launch when the initial task record cannot be written.** `DelegationManager.ts:110-112` converts every `store.write()` failure to a warning; the initial `await save(task)` at `:267` then continues to `run()` at `:272`. If a write fails after directory initialization, such as on a full or read-only filesystem, the worker can edit files without a durable running record. A CLI restart cannot then mark that run interrupted, contrary to the persistent-state and reconciliation contract in `DELEGATION_PLAN.md:299-305,431-435`. Propagate initial-write failure and release the reserved capacity/workspace before returning an error; test a rejecting store.

Summary: 3 Standards findings (worst: P2 documentation gaps); 3 Spec findings (worst: P1 unconfirmed Pi cleanup).

## Follow-up resolution

All six findings were addressed on `codex/fix-delegation-review`:

- Pi RPC shutdown now reports an unconfirmed exit as an error, including when a kill signal fails. Delegation retains the workspace reservation after that error.
- Delegated Claude workers use the same legacy model fallback as ordinary threads.
- A failed initial task-record write stops worker launch and releases the reserved task capacity and workspace.
- The Chinese README delegation section was translated; the English and Chinese READMEs both document the initial-record behavior.
- `CLAUDE.md` now describes delegation ownership and the coordinator-to-worker path.
- The HTTP, JSON-RPC, and Pi extension boundaries parse external values as `unknown` and narrow them before use.

Verification: `npm run build` passed. CLI coverage passed with 1,297 tests and 86.72% line coverage; Router coverage passed with 573 tests and 92.29% line coverage.

## Second-review follow-up

MR !8 exposed two more Pi shutdown paths. A timeout could leave an unhandled
rejection when abort RPC and process cleanup both failed. A later `stop()` could
also report success after the first attempt lost its process reference, allowing
delegation cleanup to release the workspace while Pi was still alive.

The timeout and explicit abort paths now settle the active turn even when
cleanup fails. `PiClient` retains the unconfirmed process until its exit is
observed, rejects repeated cleanup attempts, and refuses a new start in the
meantime. A process-level delegation cancellation test checks that the workspace
remains blocked in this scenario.

Final verification: `npm run build` passed. CLI coverage passed with 1,301
tests and 87.11% line coverage; Router coverage passed with 573 tests and
92.29% line coverage.

## Third-review follow-up: session resets

The remaining P2 allowed `/clear` and `/new` to replace a `PiClient` that still
owned an unconfirmed process. The replacement lost the old client's startup
guard and could launch another Pi process in the same workspace.

`PiExecutor` now retains replaced clients until their shutdown is confirmed.
Session startup, recycling, and destruction all include these clients. Repeated
resets cannot discard a failed stop, late exit permits a later retry, and
destruction during a pending reset cannot start a replacement process.

The three regression tests fail on `a01b072` and pass with the fix. They cover
real Pi transport behavior with simulated child processes, unsuccessful shutdown
after reset, and destruction while waiting for exit. Version: 1.6.83.
Verification: both packages build successfully. All 1,304 CLI tests and 573
Router tests pass; line coverage is 87.15% for CLI and 92.29% for Router. The
standalone reset probe now reports `AFTER_CLEAR_BLOCKED`, and the earlier
timeout/crash and delegated workspace-retention probes still pass. These are
local simulations, not authenticated Pi model runs or production deployment.
