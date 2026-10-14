# Session Handoff Native Evidence and Implementation Status

## Scope

This is the M0 evidence record for the cross-backend session handoff project. It records bounded, no-prompt capability probes and the first routing/configuration foundation in package `1.6.160`; it does not certify native session handoff or all-backend completion.

No real user transcript was read. No backend was installed, authentication changed, credential copied, native user store migrated, model task sent, or service deployed. Native runtime experimentation used an owned temporary directory, synthetic session data, an isolated Pi agent directory, and a credential-free environment. Owned probe processes exited and their temporary data was removed.

## Native availability and interface evidence

| Backend | Local availability/version | Evidence obtained | Remaining blockers |
| --- | --- | --- | --- |
| Pi | Available, `1.2.0` | Help exposes exact-file/session-ID/session-dir options. Synthetic exact-file RPC startup answered `get_state` with matching file/ID and `isStreaming: false` without any prompt. Orderly stdin closure exited with code 0. | Native loading changed the synthetic file despite no prompt; determine which metadata/migration writes occurred and ensure preservation/recovery/ownership before real adoption. Shared storage settings parity, strict binding registry, leases, retention and local round-trip remain unimplemented. |
| Claude Code | Available, `2.1.260` | Help exposes `--resume`, `--session-id`, input/output formats. | Native history metadata, no-prompt identity handshake, local round-trip, sandbox/preservation and release still need synthetic verification. Help is not certification. |
| Codex | Available, `0.162.1` | `app-server --help` succeeds and exposes supported tooling/stdio transport. `app-server generate-json-schema` documents `thread/list` (cwd/archived/sourceKinds filters), `thread/read`, and `thread/resume`. Read-only discovery of local rollout headers plus the native name index is implemented (`1.6.160`) without starting the app server. | Strict no-prompt identity handshake via `thread/resume`, release/close semantics, local reopen guidance, and history-preserving handoff still require isolated native probes; message counts remain unavailable without a verified transcript reader. |
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
