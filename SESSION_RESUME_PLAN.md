# Cross-Backend Session Resume Implementation Plan

## Status and authority

Release `1.6.165` adds read-only Pi/Codex/Claude Code catalogs and Pi native
connection and detach, with adopted history reloaded before every remote turn.
The release action and released-state gate are removed. All eight backends remain future targets;
other backend connections and verified bidirectional handoff are unavailable.

- Baseline: `5df21c1`, package version `1.6.159`.
- Contract and limitations: [Session Resume Specification](SESSION_RESUME_SPEC.md).
- Native observations: [Evidence Record](SESSION_RESUME_EVIDENCE.md).
- The unused registry/lease prototype was removed; it has no runtime integration.

Checkboxes below apply only to their stated scope. Pi transport tests are not
proof of another backend, a managed local launcher or crash-safe ownership.
Future milestones are not authorized implementation, installation, authentication,
migration, deployment or publication instructions.

## 1. Delivered implementation

### Routing and configuration

- [x] Intercept `/resume`, `/r` and `/session` before ordinary shortcuts, executor
  construction, working-directory changes, queue admission and slash passthrough.
- [x] Remove the model-prompt pretend-resume shortcut without changing `/continue`.
- [x] Add disabled-by-default master/per-backend sharing flags and strict boolean
  validation; invalid existing settings do not reset unrelated configuration.
- [x] Retain thread summaries in executor-free replies so the response card resolves
  its heading through the existing protocol version 1 envelope.

### Read-only catalogs

- [x] Implement the shared bounded scanner, canonical store/workspace checks,
  sanitized labels, newest-first ordering and duplicate-ID exclusion.
- [x] Distinguish missing optional storage from unreadable or truncated coverage.
- [x] Pi: native directory/settings precedence, current-workspace filtering,
  remote-cli store discovery and synthetic-pointer exclusion.
- [x] Codex: active/archived rollout headers, native name index, `CODEX_HOME`,
  and sub-agent/delegated-worker exclusion without starting app-server.
- [x] Claude Code: bounded project metadata, `CLAUDE_CONFIG_DIR`, recorded
  workspace checks and sidechain exclusion without starting Claude Code.
- [x] Report counts as unavailable or lower bounds instead of reading entire
  transcripts or inventing totals.

### Text chooser and local helper

- [x] Page eight rows at a time and search original snapshot name/ID metadata.
- [x] Use random, scoped five-minute menu and action tokens with bounded in-memory
  retention; selection is mutation-free and confirmation is single-use.
- [x] Implement `/resume id` and globally numbered snapshot-row selection for Pi.
- [x] Keep cross-backend browsing read-only; connecting Pi requires a Pi thread.
- [x] Keep native locators out of the chooser and session-control responses.
- [x] Add daemon-free `remote-cli session show --thread <name> --backend <key>`
  with local-only verified reopen guidance and explicit missing-history output.

### Pi native lifecycle

- [x] Load the exact file and verify `get_state` ID/file without a model prompt.
- [x] Refuse mismatching/missing/streaming sessions and retain the old association
  on failed adoption; recheck adopted identity when the process is recreated.
- [x] Omit adopted `--name` so user-owned native names are not overwritten.
- [x] Detect another recorded remote thread holder and native revision changes
  between selection and confirmation. This is not a writer lease.
- [x] Preserve ordinary/adopted foreground history on reset and thread-data
  deletion; assign independent IDs to fresh conversations without changing
  worker/metadata cleanup.
- [x] Verify A -> `/new` -> independent B -> confirmed `/resume` back to A;
  unconfirmed drafts do not redirect ordinary messages and reset/restart does
  not resurrect retained history.
- [x] Reload and verify adopted native history before each remote turn without
  release/reacquisition commands; ignore legacy released flags after restart.
- [x] Remove `/session release` from command grammar, executor controls and help;
  retain detach and explain the single-active-side/local-resume requirement.
- [x] Confirm detach before forgetting the association and allocating a fresh ID.
- [x] Keep existing bindings inspectable/detachable when discovery is off.
- [x] Reject session mutation when tasks or queue confirmations are pending;
  finish thread operations and resume queue draining afterward.
- [x] Return a bounded session-control error rather than crash message handling.
- [x] Verify a real Feishu connection and subsequent model response using synthetic
  history on a separate test device; remove the owned test runtime and data.

## 2. Integration map

| Existing/new component | Implemented responsibility |
| --- | --- |
| `client/MessageHandler.ts` | Program-control dispatch, thread scope, admission hooks and safe response routing. |
| `session/SessionControl.ts` | Chooser, confirmation, binding inspection and detach orchestration. |
| `session/SessionMenu.ts` | Text grammar, bounded snapshots and action-specific confirmation tokens. |
| `session/SessionResumeService.ts` | Opt-in validation, backend availability and safe catalog rendering. |
| `session/SessionCatalog.ts`, `session/adapters/` | Bounded, read-only backend metadata discovery and Pi locator resolution. |
| `session/SessionLocalInfo.ts`, `commands/session.ts` | Daemon-free local pointer inspection and reopen guidance. |
| `executor/IExecutor.ts`, `executor/PiExecutor.ts` | Optional native control interface and strict Pi runtime/retention behavior. |
| Config types and config command | Local boolean opt-in with no implicit backend certification. |

Existing native executors remain the model transports. Do not add speculative
module boundaries, guessed SDK endpoints or duplicate global state authorities
until a reviewed implementation needs them.

## 3. Remaining lifecycle hardening

These are open work, not completed guarantees of this release:

Delivered Pi-only hardening in `1.6.165`: in-daemon canonical-file reservations,
mandatory connection/detach pointer writes with previous-association retention on
failure, settings admission, update/delegation/queue guards, cancellation and
unknown-cleanup quarantine. Claude Code and Codex retain read-only discovery
without executor, settings, or history changes.

- [ ] Integrate settings, approvals/input, delegation closeout, attachments,
  shutdown and automatic-update admission with session-context mutations.
- [ ] Bind drafts to backend/config/binding/enrollment revisions as well as the
  current user/thread/workspace scope; invalidate revoked or stale actions.
- [ ] Make operation persistence crash-recoverable across all affected records;
  synchronous Pi pointer-write failure is handled, not a durable transaction.
- [ ] Serialize physical session admission across processes/config aliases;
  in-daemon reservations do not establish cross-process exclusive ownership.
- [ ] Retain durable foreground/synthetic provenance after pointer removal so
  cleanup cannot relabel retained worker history as user history.
- [ ] Verify changed-cwd, inactive-backend deletion, settings metadata executors,
  compaction and native restart behavior across supported releases/platforms.
- [ ] Verify exact same-session local continuation followed by remote reacquisition
  using distinct synthetic sentinels; a remote-only turn does not prove this.
- [ ] Test malformed/older Pi formats, migration writes, custom entries, branches,
  images and extension startup input separately from a minimal RPC fixture.
- [ ] Bound catalog wall-clock work and strengthen file-change evidence where
  native formats permit it; the current stat fingerprint is not a content hash.
- [ ] Disclose saved-native versus global/per-thread model/resource differences
  and define opt-out behavior for already-connected ordinary turns.

Gate: no broader ownership, preservation or bidirectional claim until its native
and failure-injection cases pass. Preserve current worker isolation and sandbox
semantics while integrating these paths.

## 4. Backend expansion backlog

| Backend | Next evidence required before connection |
| --- | --- |
| Pi | Full local/remote/local/remote round trip; lifecycle and version/platform edge cases. |
| Codex | No-prompt app-server identity, strict missing-ID failure, archive/profile fidelity, release and local selector round trip. |
| Claude Code | Exact initialization without a prompt, native encrypted-history retention, current sandbox/approval hooks and safe release. |
| OpenCode | A read-only catalog alternative to the writing SQLite list command, exact ACP load identity and close-versus-delete behavior. |
| Kimi | Independent native catalog/profile lookup, strict ACP load/close, thinking controls and local reopen. |
| ZCode | Official app-server/desktop catalog, workspace keys, restore/close/subscription semantics and authentication limitations. |
| DSH | Native resumability and catalog, strict bypass of fresh/summary-seed recovery, exact local reopen and telemetry suppression. |
| AGY | Original-store/database/brain identity, strict missing-conversation behavior and a safe HOME/delegation strategy without global config writes. |

Native investigation uses owned synthetic stores and metadata-only probes first.
A genuine context-continuation test may require an authorized provider call.
Missing binaries, undocumented methods and incompatible releases remain explicit
blockers; do not install/authenticate silently or infer one backend from another.

Gate per backend: prove workspace/store resolution, read-only discovery, exact
no-prompt identity, history-safe stop, strict failure and native local reopen.
Record exact versions/platforms and disclosed unsupported directions.

## 5. Deferred ownership and UI milestones

### Cooperative ownership and durable recovery

- [ ] Design one canonical account-local physical conflict scope independent of
  Router/device registration and config-root aliases.
- [ ] Acquire before native startup or any writing metadata query; account for
  store-level databases and parent/child ownership uncertainty.
- [ ] Prove exit before recovery; PID reuse, inaccessible process evidence and
  expired heartbeats must not authorize takeover.
- [ ] Use durable intents/receipts for multi-record transitions, bounded retention,
  original-owner authorization and idempotent outcome inspection.
- [ ] Keep metadata guards short and outside native calls, scans and shutdown waits;
  bounded pending responses must retain ownership while work settles.

The removed prototype is not a dependency to resurrect automatically. Choose
schemas, module names and filesystem layout only when integration is reviewed.

### Managed local launcher

- [ ] Require remote release, then acquire cooperating ownership before exact launch.
- [ ] Verify native session switching, reload and extension paths cannot escape it.
- [ ] Preserve normal local trust/auth behavior without inheriting remote approvals.

An unguarded TUI remains unmanaged; a wrapper alone is not exclusive ownership.

### Optional Router cards

- [ ] Negotiate additive capability/message fields without changing protocol 1.
- [ ] Validate original owner/device/card/thread/snapshot independently at Router
  and CLI; card clicks change only drafts until confirmation.
- [ ] Update visible state only after matching CLI acknowledgement, retain text
  fallback and reject stale callbacks.

No new wire names or card implementation are reserved by this plan. These are
future work and do not block the currently tested text UI.

## 6. Validation and release

Current focused regression command:

```bash
npx vitest run packages/cli/tests/session packages/cli/tests/executor \
  packages/cli/tests/integration packages/cli/tests/MessageHandler.test.ts \
  packages/cli/tests/commands packages/cli/tests/compatibility \
  packages/cli/tests/ConfigManager.test.ts
npm run build -w @yu_robotics/remote-cli
```

Retain command-scope/expiry/fail-closed tests, native-format fixtures, exact
adoption failure tests, no-prompt assertions, history-preserving reset/deletion,
per-turn refresh/restart behavior and queued-work refusal/draining. New runtime modules
require unit/integration coverage under the repository's coverage policy.

Future tests add process contention, orphan children, alias/store conflicts,
crash/persistence injection, stale enrollment and binding revisions, historical
notification suppression, live startup input and full local round trips.

- [x] Align root READMEs and help with current commands and limitations.
- [x] Synchronize version `1.6.164` in all manifests and applicable lockfile entries.
- [x] Add English CHANGELOG and validated localized release summary.
- [x] Record native probes, manual Feishu results and environment blockers.
- [ ] Recheck exact staged changes and all new artifacts before every commit.
- [ ] Audit the whole outgoing range before any push; do not claim a scanner proves
  absence of private data, and state binary/OCR or unavailable-ref limitations.

Do not commit raw logs, credentials, real user/device/session IDs or deployment
paths. Generalize fixtures; do not probe discovered credentials against services.
Publication, MR creation, deployment and remote history rewriting require explicit
permission. Local commit restructuring does not imply permission to push.

Before downgrade, finish work and detach adopted bindings with the new
version. Older executors may delete files referenced by adopted pointers; there
is no automatic native-history rollback, repair or credential rotation.
