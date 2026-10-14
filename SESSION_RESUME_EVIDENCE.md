# Session Resume Native Evidence and Implementation Status

## 1.6.165 Pi-only hardening validation

The hardening changes are based on feature checkpoint `7544039`. Native behavior
changes are limited to Pi. Claude Code and Codex executors, native settings,
history handling, and existing read-only catalog adapters are unchanged.

- Full project build passed.
- Full CLI suite passed: 139 files, 2,826 tests.
- Focused lifecycle and catalog coverage passed: 13 files, 229 tests. The measured
  scope is `PiExecutor`, `SessionControl`, `SessionLocalInfo`, and `PiSessionCatalog`:
  91.44% statements, 80.69% branches, and 95.87% functions. This is not whole-CLI coverage.
- Regressions cover same-file concurrent confirmations, pointer write/rename
  failure and restart behavior, settings conflicts, custom agent directories,
  literal Pi reopen arguments, and non-Pi discovery without executor creation.
- Actual `PiClient` transport code with mocked children verifies cancellation
  during connection startup, no identity/abort RPC restart after cancellation,
  confirmed final exit, and busy protection through rollback and cleanup.
- Independent Codex probes found startup/destroy and abort/rollback races during
  review. Both were fixed and the final narrow follow-up approved their closure.
- AGY review was attempted twice, but both requests failed with a network EOF;
  neither attempt supplies an approval or independent correctness evidence.

Pi is not installed on the validation host. No live Pi, provider, or Feishu
acceptance is claimed for this hardening. In-daemon reservations do not exclude
unmanaged terminals or other CLI instances; uncertain process cleanup retains
the file quarantine until client restart after confirmed Pi exit. Pointer writes
are mandatory for successful control actions, not a crash-recoverable transaction.

The initial `1.6.161` records below are historical. Release `1.6.162` removes the release action and uses automatic adopted-session reload before each remote prompt; the former release-based round trip is not the current user workflow.

## Scope

This is the M0 evidence record for the cross-backend session handoff project. It records bounded, no-prompt capability probes and the first routing/configuration foundation in package `1.6.161`; it does not certify native session handoff or all-backend completion.

No real user transcript was read. No backend was installed, authentication changed, credential copied, native user store migrated, model task sent, or service deployed. Native runtime experimentation used an owned temporary directory, synthetic session data, an isolated Pi agent directory, and a credential-free environment. Owned probe processes exited and their temporary data was removed.

## Native availability and interface evidence

| Backend | Local availability/version | Evidence obtained | Remaining blockers |
| --- | --- | --- | --- |
| Pi | Available, `1.2.0` | Help exposes exact-file/session-ID/session-dir options. Synthetic exact-file RPC startup answered `get_state` with matching file/ID and `isStreaming: false` without any prompt. Orderly stdin closure exited with code 0. | Native loading changed the synthetic file despite no prompt; determine which metadata/migration writes occurred and ensure preservation/recovery/ownership before real adoption. Shared storage settings parity, strict binding registry, leases, retention and local round-trip remain unimplemented. |
| Claude Code | Available, `2.1.260` | Help exposes `--resume`, `--session-id`, input/output formats. | Native history metadata, no-prompt identity handshake, local round-trip, sandbox/preservation and release still need synthetic verification. Help is not certification. |
| Codex | Available, `0.162.1` | `app-server --help` succeeds and exposes supported tooling/stdio transport. `app-server generate-json-schema` documents `thread/list` (cwd/archived/sourceKinds filters), `thread/read`, and `thread/resume`. Read-only discovery of local rollout headers plus the native name index is implemented (`1.6.161`) without starting the app server. | Strict no-prompt identity handshake via `thread/resume`, release/close semantics, local reopen guidance, and history-preserving handoff still require isolated native probes; message counts remain unavailable without a verified transcript reader. |
| OpenCode | Available, `1.18.32` | Help exposes ACP, session management, export, and exact local `--session` selection. | Metadata list/detail, ACP native identity, strict restore/release, local round-trip require isolated verification. |
| AGY | Unavailable | Repository transport inspected; no native executable probe. | All native certification blocked; original store/HOME/delegation configuration and retention remain major design gates. |
| Kimi | Unavailable | Repository ACP integration inspected; no native executable probe. | Native metadata, identity, local reopen and release unverified. |
| ZCode | Unavailable | Official adapter source inspected; no native executable probe. | Native listing/workspace identity/authentication/reopen and release unverified. |
| DSH | Unavailable | Repository strict-resume fallback/log suppression constraints inspected; no native executable probe. | Native resumability/list/profile/local reopen plus strict fallback bypass unverified. |

Native versions above are local observations, not newly selected minimum supported versions. Probes did not list real conversations. The Pi synthetic file change means a successful no-prompt identity response is insufficient to treat startup as a read-only or safely transferable operation.

## First implementation increment

- Reserve `/resume`, `/r`, and `/session` as program-owned controls before executor construction, working-directory changes, task admission, and native slash passthrough.
- Remove ordinary-text natural-language resume substitution across all eight backends.
- Return explicit disabled/unverified responses; no native adapter is enabled and no history discovery, loading, binding, release, or managed launcher is available yet.
- Add disabled-by-default typed master/per-backend configuration flags, exact boolean CLI parsing, known-backend path validation and malformed-config rejection without replacing unrelated configuration.
- Add a metadata-only response route so reporting unavailable session control does not lazily construct a backend.
- Preserve protocol version 1 and all native executors, pointer formats and worker lifecycle behavior.

An early exact-file Pi switching sketch was removed before handoff because it lacked confirmation, durable ownership, history preservation and protected lifecycle integration. The implementing change does not expose that unsafe path.

## Validation

- Final focused CLI tests: eight files, **332 tests passed**, including session gate, both text/real Feishu slash envelopes, configuration validation/default retention, MessageHandler/concurrency, factory, and CLI protocol compatibility.
- New gate module coverage: **100% statements, branches, functions and lines** in a focused coverage run; this is not whole-package coverage certification.
- CLI TypeScript build and packaged release-note validation passed.
- Full workspace build blocked in Router by missing installed `diff` and `markdown-it` dependencies. Router protocol suite also cannot load `diff`.
- Full CLI run: **126 files passed, two files failed; 2664 tests passed, 11 failed**. Ten document-extraction failures report missing installed `pdfjs-dist`/`yauzl`; one delegation file-reader/reclamation race failed under concurrent suite load. These files were not modified by this increment. The reclamation suite passed all 29 tests on an isolated repeat, indicating a concurrency/load-sensitive failure rather than a stable passing full-suite result. No claim is made that all baseline tests pass.
- No dependency installation was performed to repair environment gaps.

## Next work and blockers

1. Finish M0 native no-prompt metadata/identity/strict-failure evidence on available backends, including Pi's startup writes.
2. Integrate canonical account-local registry/authorization/provenance/lease primitives with native lifecycle, enrollment and worker attribution; finish crash-lock reconciliation and bounded storage lifecycle before enabling any chooser or native load.
3. Implement strict adapters and retained native history/fresh identity semantics; protect reset/cwd/delete/backend/restart paths.
4. Implement owner/snapshot-bound confirmation and read-only local reopen helper, then certify full native local/remote round trips.
5. Retain all eight targets; unavailable native backends remain explicit blockers, not silent Pi-only scope reduction.
6. Optional cards and managed local launchers follow verified text flows and native ownership guards.

Do not interpret `sessionSharing.enabled: true` as working native handoff. It stores opt-in intent only until a verified adapter and ownership/retention implementation exist.


## End-to-end Feishu verification

Strict Pi adoption was first verified only to the point where a prompt reached Pi. A private Feishu test instance then completed the full path: Router command envelope, thread routing, CLI handling, Pi RPC and a real model call.

**Setup.** A separate test device ran with its own temporary `HOME`, its own configuration (an empty workspace as cwd, `sessionSharing.enabled`, `executor.type = pi`) and two fabricated Pi sessions. It connected to the already configured Router; the primary device and its configuration were not modified.

**Native continuation verified.** After `/resume` -> `/resume select` -> `/resume confirm`, a normal chat message was appended to the adopted native file as ordinary `user`/`assistant` entries. The pre-existing fixture entries were untouched (same header ID and cwd, same order), no `session_info` rename was appended, and no new session file appeared.

**Diagnosis notes.**

- Fabricated sessions must use the block-array `content` shape that Pi writes. A plain-string `content` makes Pi fail with `Cannot read properties of undefined (reading 'length')`.
- The default provider of the test account returned `403` outside remote-cli as well. The test instance was therefore configured with another model through `executor.pi.model`.
- A suspected leak of inherited `PI_*` variables was ruled out. Pi 1.2.0 started with `PI_SESSION_FILE`, `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` set to other values reported its own fresh session, model and thinking level. No code change was made.
- With delegation enabled (the default), the delegation instructions are prepended to each user message, so they appear in the adopted history. This applies to every backend and is unchanged here.

**Validation.** `PiExecutor.adoption.test.ts`, `integration/pi-session-resume.test.ts` (including queued-work refusal, queue draining after adoption and a session-control failure path), the session suites and the CLI build pass.

## Native local/remote/local/remote round-trip probe

A separate synthetic test used Pi 1.2.0, a real configured model and the built CLI without reading user transcripts or copying `auth.json`. Only the selected provider configuration was available in the private test home; its credential was supplied through an environment variable. Extensions, MCP, skills, context files and tools were disabled, and delegation was disabled on the test thread.

The native local leg used Pi's one-shot CLI, not a hand-written JSONL fixture. The remote leg used the real `MessageHandler`, `ThreadExecutorPool` and Pi RPC executor. Command/response delivery was captured in-process, so this probe **did not exercise Feishu or Router transport**.

Verified sequence:

1. Native local Pi created one session and remembered a random local sentinel.
2. `/resume` selection and confirmation loaded that ID/file without adding a user turn.
3. A remote prompt recalled the local sentinel and added a different remote sentinel.
4. `/session release` stopped remote access. A subsequent remote prompt failed without changing the native file.
5. The local `session show` helper produced guidance for that exact file.
6. Native local Pi reopened the file, recalled both earlier sentinels and added a third local-return sentinel.
7. Remote selection and confirmation reloaded the same file and a real prompt recalled all three sentinels.

The native store contained exactly one session throughout. The header ID and canonical cwd stayed the same, and the existing byte prefix was preserved after each continuation. Native record counts progressed from 6 to 8 to 10 to 12. This proves a sequential manual round trip in the tested local harness, not automatic writer coordination, TUI behavior, all-platform support or a complete Feishu bidirectional test.

### Live Feishu round-trip result

The same sequence was subsequently repeated on a separate live test device through the configured Router and Feishu. Native local Pi first created the session and its random local marker. The user selected and confirmed it in Feishu; a model response recalled that marker and added a different remote marker. After the user sent `/session release`, native local Pi reopened the exact file, recalled both markers and added a third local-return marker. The local process exited before the next remote connection.

The user then selected and confirmed the session again in Feishu and asked for all three markers without including their values. The returned local-return marker exactly matched the private expected value, which had not been disclosed to the user or included in the final prompt. The persisted final assistant message also contained all three markers.

Final checks confirmed the same native ID/file/canonical workspace, one session file, preserved history and a remote-ready adopted pointer after reacquisition. The primary device configuration was unchanged. This verifies **sequential manual native-CLI/Feishu/native-CLI/Feishu continuation** for the tested Pi 1.2.0 model and isolated environment. It does not certify the interactive TUI picker, concurrency prevention, crash recovery, other models/platforms/backends or arbitrary extension startup behavior. No runtime code changed during this verification.

## Two native Pi processes on one session

Two Pi 1.2.0 RPC processes opened the same synthetic JSONL session successfully. The probe used native `bash` commands to add distinguishable context entries without provider calls; it disabled extensions, MCP, skills and context-file discovery and cleaned up both processes and their owned temporary store. The observations were reproduced on a second run.

- Both processes reported the same native session ID and file and stayed running.
- An entry appended by process A was visible to A but not to the already-open process B through `get_messages`. B's later entry was likewise absent from A's in-memory context.
- Both entries remained physically present as valid JSONL, but neither was an ancestor of the other: they belonged to different branches rather than one continuously shared context.
- A native `switch_session` back to the same file loaded B's latest branch. A then saw B's entry, while its earlier A entry was absent from the active context. B was not stopped and could append again; A did not automatically see that later append.
- The pre-existing byte prefix and single session header were preserved. The test did not demonstrate byte corruption, native writer exclusion, or automatic ownership transfer.

Consequently, native multi-open is supported in this tested version, but it is not automatic context synchronization or exclusive takeover. A future no-release workflow could reload before each alternating turn and let idle windows remain open. It must disclose branch behavior and unmanaged concurrency; it cannot promise that an ordinary local Pi process is prevented from writing. Model prompts, tools, compaction and interactive TUI behavior require additional tests before claiming equivalent semantics.

## No-release sequential switching (`1.6.162`)

A second real-Pi/model probe kept the native local RPC process and the remote executor open across alternating turns. It used the same isolated provider-only setup described above, no real transcripts or auth-file copies, no extensions/MCP/tools, and no simultaneous work. Remote command delivery was captured in-process, so this test did not exercise the live Router/Feishu UI.

1. Native local Pi created the session and its initial sentinel; remote selection/confirmation preserved the exact native ID/file and sent no prompt.
2. A remote model turn recalled the initial sentinel and added a remote sentinel.
3. `/session release` was rejected as removed syntax. No release or remote reconnect was performed.
4. A native local process opened the same file while the remote process remained idle, recalled both sentinels and added a local-return sentinel.
5. The next ordinary remote message, without another `/resume`, automatically restarted the owned RPC process, loaded the new local history and recalled all three sentinels. The native local process was still running.
6. That same local process used native `switch_session` to reload the file and continued successfully with all three sentinels.

Every step retained the native ID/file/cwd and existing byte prefix, with exactly one native file throughout. A local window still needs its own native resume/reload; the feature does not install a local extension or stop other writers. This verifies sequential no-release switching in the tested Pi 1.2.0/model environment, not synchronized concurrent collaboration or fully automatic two-sided refresh.

Regression tests cover local file appends observed after per-turn reload, mismatching identity and stop failures preventing prompt dispatch, overlapping preparation rejection, abort/reset before dispatch, legacy released pointers no longer blocking restart, removed command grammar and confirmed detach/history retention. Validation: 66 related files passed 1,367 cases; the focused Pi/session run passed 181 cases. PiExecutor line coverage was 85.44% and SessionControl line coverage was 100% in that focused run (not whole-package certification). The full CLI run passed 2,784 cases in 138 files; the existing DocumentExtractor suite failed 10 cases because PDF/archive dependencies are unavailable. No dependencies were installed. CLI build and bundled release-summary validation passed.

## Foreground Pi `/new` retention (`1.6.163`)

The shared `/new` command is deliberately an alias for `/clear`: reset the current thread's context while keeping its directory/backend/preferences. The original Claude, Codex, AGY and ACP reset paths remove remote continuation pointers rather than directly deleting native history. Pi's former reset path separately unlinked its JSONL and reused the stable thread ID; that backend-specific cleanup is changed here, not the shared alias.

Foreground Pi reset now preserves ordinary and adopted native history and selects an independent random ID for the next conversation. Foreground thread-data deletion removes its pointer but retains native history. Delegation workers and synthetic metadata runtimes retain their previous disposable cleanup and ID behavior.

A real Pi/model probe exercised the built `MessageHandler`, pool and executor against isolated synthetic history without Feishu transport:

1. An ordinary foreground prompt created A with an ID distinct from the remote thread.
2. `/new` preserved A's bytes, then the harness recreated its remote runtime before the next prompt.
3. A prompt created B with a different native ID and no A sentinel in B's persisted messages. The model confirmed that there was no earlier local marker.
4. `/resume id <A>` displayed a draft; an ordinary message before confirmation still used B, recalled B's marker and did not change A.
5. Confirmation restored A's exact ID/file. A subsequent real prompt recalled A's original marker. Both A and B remained in the read-only chooser with no history merge.

The probe used the configured test model, no tools/extensions and no real user transcripts or copied auth files. Regression tests additionally cover reset/restart separation, native cwd changes, foreground thread deletion and unchanged worker/metadata cleanup. Related validation passed 1,372 tests across 66 files; CLI build and release-summary validation passed. Full CLI validation passed 2,789 cases with the same 10 existing DocumentExtractor failures caused by unavailable PDF/archive dependencies. This is native runtime/context evidence, not another live Feishu or interactive TUI test.

## Foreground session naming (`1.6.164`)

Independent foreground session IDs exposed a naming inconsistency: each `/new` session received `remote-cli-<thread-id>`, so different native files had identical display names. Fresh foreground names now use their native ID. Reopening an existing file omits `--name`, preserving locally assigned names; adopted and synthetic-runtime naming are unchanged. Existing duplicate names are not rewritten automatically. Focused Pi executor/adoption/integration tests passed 70 cases and CLI build/release-summary validation passed.

## Shared catalog scanner

The three implemented catalogs previously each carried their own copy of the listing loop: canonical root check, readdir, retained-count cap, duplicate handling and coverage notes. They had already drifted once (the Pi catalog treated an absent optional store as a coverage gap while the other two did not), so the rules now live in one place, `scanSessionCatalogs()` in `SessionCatalog.ts`:

- Store validation: a store that cannot be canonicalized is a gap only when it appears to exist; a dangling alias has nothing to read and is empty, while a symlink alias to a real store is canonicalized and read (verified by test).
- Bounds: the retained page is the newest slice of a sorted listing, and a recursive store also has a hard scan budget (`SESSION_CATALOG_SCAN_FILES`) so it stops instead of reading without limit. The Codex recursive depth is now a per-store `maxDepth` instead of an adapter-local constant.
- Reporting: each adapter passes an `onGap` callback, so wording stays backend-specific while the trigger conditions are shared and testable.
- Ordering and duplicates remain shared: newest modified first, id ascending, and IDs found under two stores are ambiguous and hidden.

Adapters now supply only their stores and their record parser. `PiSessionCatalog.ts`, `CodexSessionCatalog.ts` and `ClaudeSessionCatalog.ts` each lost their local listing loop, and the Codex test fixture was corrected to the verified flat `archived_sessions` layout plus explicit modification times so it no longer depends on two writes landing in different timestamp ticks.

Validation: `SessionCatalog.test.ts` grew to 7 cases covering flat/recursive scanning, bounded retention, alias handling, duplicate exclusion, throwing readers and gap reporting. `SessionCatalog.ts` and all three adapters plus `adapters/index.ts` report 100% statements/lines/functions (branches 92.59% / 90.47% / 87.06% / 77.41% respectively); the focused session suites pass **127 tests**. CLI build and release-summary validation pass.



Verified against the installed Claude Code `2.1.260` and the existing local project stores (structure only; no transcript body was read for the repository artifact).

| Field | Evidence |
| --- | --- |
| Store layout | `<config-dir>/projects/<encoded-cwd>/<session-id>.jsonl`, where `<config-dir>` is `CLAUDE_CONFIG_DIR` when set and otherwise `~/.claude`. The local variable is exported by the installed binary, and `claude --version` succeeds with both a redirected `HOME` and a redirected `CLAUDE_CONFIG_DIR` without creating files. |
| Directory encoding | Leading separator dropped and `/`, `\\`, `:` replaced with `-`: `/home/user/project` maps to `-home-user-project`, verified to match every local project directory. |
| Identity | The file stem equals the `sessionId` present in every transcript record, and every inspected transcript used a single session ID. The catalog therefore requires file stem, record `sessionId` and single-session consistency to agree. |
| Workspace | There is no header record: the first `cwd` field appeared at bytes 570-2659 across observed transcripts, so a bounded head (256 KiB) is read rather than a 64 KiB header. The containing directory must additionally encode the recorded workspace, so a copied transcript cannot be relabelled to another project. |
| Display name | Taken from the native `last-prompt` record; no prompt excerpts from `user`/`assistant` records are read or returned. |
| Sidechains/sub-agents | Marked by `"isSidechain":true` records; excluded. No `agent-*.jsonl` transcript existed locally, and the binary contains no `agent-<name>.jsonl` pattern, so sidechain flagging plus the directory/stem checks are the verified filters. |
| Message counts | Unavailable from the bounded head; reported as `messages unavailable` rather than reading transcript bodies. |
| Encrypted reasoning | Native history keeps it; the bounded head reader never reconstructs or returns API history. |

Implementation: shared bounds and rules stay in `SessionCatalog.ts`; `ClaudeSessionCatalog.ts` implements the reader; `session/adapters/index.ts` is now the single registry that defines `CATALOG_BACKENDS` and the `/resume` dispatch. Connecting to a session, release and detach remain unavailable on every backend.

Validation: `ClaudeSessionCatalog.test.ts` adds 10 cases, and a bounded smoke run over the two locally existing project stores returned 4 candidates with 4 display names and `complete: true`. `ClaudeSessionCatalog.ts` and `adapters/index.ts` reach 100% statements/lines/functions.

## Read-only local `session show` helper

The required pre-Gate-G4 helper is implemented as `packages/cli/src/session/SessionLocalInfo.ts` plus the `remote-cli session show --thread <name> --backend <key>` command. It reads only the pointer records remote-cli already wrote under `~/.remote-cli/<backend>-sessions/<threadId>.json`, with bounded single-link regular-file reads and canonical path handling. It never starts a backend or a model turn, never writes, and it reports `missing` history explicitly instead of suggesting a native picker that would create an empty conversation.

Reopen commands are emitted only for flags verified against the installed releases in this environment: Claude Code `--resume <id>`, Codex `codex resume <session-id>`, OpenCode `--session <id>`, Pi `--session <file|id>`. AGY, Kimi, ZCode and DSH indicate that reopen guidance is not verified on this release rather than guessing a command. The output states explicitly that remote-cli does not verify history preservation on native reopen and does not hold an ownership lease over a plain terminal process. Feishu `/session` supplies only the generic helper invocation, never a locator.

Validation: `SessionLocalInfo.test.ts` (8 cases) and `commands/session-show.test.ts` (5 cases) pass; `SessionLocalInfo.ts` reaches 100% statements/lines/functions with 95.31% branches, and `commands/session.ts` reaches 100% on all four metrics. A packaged-CLI smoke run in a synthetic HOME printed verified Pi guidance for a recorded pointer, an explicit "no persisted session pointer" message for an absent one, and a non-zero exit with a listed backend set for an unknown backend key.

Implementation: `SessionCatalog.ts` holds the shared bounds, canonical-path checks, private-file validation, label sanitization and synthetic-identity rule; `CodexSessionCatalog.ts` implements the Codex reader; `formatCatalog()` renders the shared menu. `/resume backend codex` lists Codex while the thread's backend stays unchanged, and `CATALOG_BACKENDS` now covers `pi` and `codex`. Connecting to a session, release and detach remain unavailable on every backend.

Validation: eleven focused session/command suites passed **127 tests** (session suites) plus **5 command cases**; MessageHandler, message-flow, config and protocol compatibility suites passed **385 tests** (counted separately); a full CLI run passed **2769 tests across 138 files**, with the pre-existing `DocumentExtractor` suite (10 cases) still failing because `pdfjs-dist`/`yauzl` are not installed in this environment (unchanged by this increment; no dependency was installed). The focused increment adds 46 catalog cases (10 Claude Code, 8 Codex, 5 shared primitives, 14 Pi, 9 gate/config regressions in the Codex/Claude suites) on top of the previously recorded registry suites; session-module coverage stays at 100% statements/lines/functions for every catalog, `SessionCatalog.ts`, `adapters/index.ts` and `SessionResumeService.ts`. A bounded smoke run over the three locally existing recorded workspaces returned 12 candidates with 12 display names and no duplicate or synthetic entries; the same scan for this repository's workspace (no Codex history) returned an explicit empty result. Session-module coverage: 100% statements/lines/functions for `SessionCatalog.ts`, `CodexSessionCatalog.ts` and `SessionResumeService.ts`, 87.78% branches for `CodexSessionCatalog.ts`.
