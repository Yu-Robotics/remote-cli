# Retained native host integration closeout

Candidate: remote-cli 1.6.248. At the validation checkpoint, the change was local only: no commit, push, publication or deployment had been performed. The final retirement artifact `f3384a53383dceea0eef86e714456e79f8a7c195` was inspected and explicitly applied through managed integration. The subsequent user-authorized commit/push uses a non-main branch because a version increase on GitHub main automatically selects npm publication; publication and deployment remain excluded.

## Delivered behavior

- The experimental retained-host path keeps native processes, schedules, MCP/hooks and durable delivery with an independently supervised runtime. Replacing its command frontend does not invoke model-mediated schedule management.
- Explicit shutdown of a drained host now fences new work, joins the original native process groups, persists late callbacks and only then releases ownership. Unconfirmed exit retains the same handles for retry.
- Failed legacy automatic updates release the global chat lock while retaining affected thread fences. Retry and reconnect do not start model-mediated recovery merely to unlock chat.
- All three package manifests and the lockfile use 1.6.248. Both README files, the English changelog and Chinese release summary describe the experimental path and its limits.

## Combined verification

The coordinator ran the following after integration:

```sh
npm test -w @yu_robotics/remote-cli -- SessionHost RetainedHostLauncher PinnedHostBundle AutomaticUpdater MessageHandler ScheduleService ScheduleRecovery SchedulePurge ThreadExecutorPool AgyExecutor AgySessionSchedules AgyScheduleHost AgyRecovery WebSocketClient TestScheduling commands/start.test.ts
npm run build
python3 output/retained-host-native-final-v2-verify.py --self-test output/retained-host-final-v2-claude.json output/retained-host-final-v2-agy.json
git diff --check
```

Results: 29 test files passed, **1,183 tests passed and one platform-specific test skipped**. Both workspace builds, release-summary packaging, the independent native-evidence verifier and whitespace checks passed. These are affected-suite results, not a claim that the entire repository test suite or three-platform CI ran.

The final worker measured ScheduleService line/branch coverage of 97.79%/91.21% and RetainedRuntime coverage of 98.33%/80.32%. The coordinator verified that both integrated source hashes still match the native-tested source recorded in `retained-host-final-checks.json`. Subsequent changes only updated a test and documentation.

The prior worker report preserves a failed Claude installer-recovery assertion. Investigation confirmed that it expected automatic recovery after installation failure, contrary to the candidate's explicit failure policy. The integration regression now verifies the production dispatcher rejects affected foreground work, update admission remains fenced, and reconnect creates neither another native host nor any native request. All 56 Claude recovery tests passed in the combined run. The earlier report and failed experiment records remain unchanged as historical evidence.

## Native evidence and boundaries

[The native validation report](retained-host-final-native-validation.md) records real Claude and AGY executables running in isolated Linux namespaces with deterministic loopback providers. Both retained process, session, task and MCP identities across frontend replacement; one once occurrence and two cron occurrences completed; ACK retry redelivered results without re-execution. Frontend lifecycle and drained-host stop each made zero inference or native-management calls. Both exact original process groups exited. The coordinator revalidated the stored evidence; it did not repeat those experiments.

The original probe expected an out-of-invocation MCP request to succeed and therefore failed under the new invocation guard. Its failures remain preserved. The separately versioned final probe checks rejection outside an invocation and successful actual native MCP inside it. Explicit schedule cancellation preceding stop still uses the existing backend management flow and is not claimed to be model-free.

Publication note: the historical probe/verifier commands in the native validation report reference earlier local files that are not included in this commit. They are historical references, not runnable instructions for this checkout. The final v2 probe, runner, verifier and shared frontend fixture are included. To repeat a native experiment, choose a fresh output filename: the probe deliberately refuses to overwrite committed evidence. Offline verification of the included v2 JSON files remains runnable as shown above.

This is opt-in support for **new retained-host sessions**, with a limited command profile. Existing monolithic sessions cannot be migrated automatically, and their legacy handoff is not converted into model-free continuity. Host crash/reboot replay is unsupported. The runtime remains pinned while the frontend changes, so this is not an upgrade of the already-running native runtime itself.

Only Linux executed. Actual package installation and OS-supervised replacement, live Router/Feishu delivery, and native macOS/Windows acceptance remain unverified. Windows host supervision is explicitly unsupported. The production incident must not be described as fixed by deployment on the strength of this local candidate.

## Privacy and preservation

The delivered reports and final native artifact set were inspected for credential and identifying-data patterns, with manual classification of matches. The apparent home paths refer to the isolated synthetic `/probe/home/workspace` fixture; loopback endpoints and fixture credentials are synthetic. This is not a repository-wide secrecy claim. No existing historical output was rewritten. Before the authorized commit/push, a separate read-only review also examined the 44 changed source/document files and 12 selected evidence files; it found no secrets or private identifiers. Unrelated historical output is excluded from staging. Server-side GitLab automation was not independently audited.
