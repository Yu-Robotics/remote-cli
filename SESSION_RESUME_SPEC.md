# Cross-Backend Session Resume Specification

## Status and authority

Release `1.6.165` implements read-only discovery for Pi, Codex and Claude Code,
and native session connection and detach for Pi only. Adopted Pi sessions reload
before each remote turn; there is no release action. Pi `1.2.0` was
verified with synthetic native sessions and a manual Feishu continuation test.
These observations are not a minimum-version or all-platform support matrix.

This document distinguishes the current contract from future requirements.
Cross-process ownership, managed local launching, durable operation recovery,
other backend connections and fully verified bidirectional handoff are **not
implemented**. An unused registry/lease prototype was removed from this change.
The daemon reserves Pi files during connection and serializes Pi confirmations
with settings admission. This is not an OS lock or cross-process ownership guarantee.

- Baseline: `5df21c1`, package version `1.6.159`.
- Implementation backlog: [Session Resume Plan](SESSION_RESUME_PLAN.md).
- Native observations and validation: [Evidence Record](SESSION_RESUME_EVIDENCE.md).
- Future targets: Claude Code, Codex, AGY, OpenCode, Kimi, ZCode, Pi and DSH.

MUST and MUST NOT express requirements. Future requirements are not claims about
this release. Installation, authentication, migration, deployment and publication
require their own authorization; this specification does not authorize them.

## 1. Product boundary

A remote-cli thread may explicitly connect to the selected backend's native
session. The backend remains authoritative for its history, active branch,
compaction and custom entries. Resume MUST NOT reconstruct history from output
buffers, translate between backends, replay old requests, or prompt a model to
pretend that it remembers a different conversation.

Current Pi connection is an exact native load, not attachment to a running
terminal or transfer of its process. Idle windows may stay open, but the user
must ensure that only one side executes at a time. Before returning to a local
window, use native `/resume` to reload the same file; remote turns reload
automatically. Automatic local refresh, writer exclusion and process takeover
are unavailable.

The feature does not provide cloud synchronization, transcript merging,
cross-project adoption, automatic fork, worker-history import or an OS sandbox.
Backend tools retain the ordinary permissions and resources of their runtime.
Discovery does not send historical prompts to Feishu. A later real turn still
sends native context to its configured model provider under normal backend rules.

### Current backend matrix

| Backend | Read-only chooser | Connect/detach | Remaining native work |
| --- | --- | --- | --- |
| Pi | Implemented | Implemented | Local-to-remote reacquisition round trip, platform/version coverage and managed ownership. |
| Codex | Implemented | Unavailable | No-prompt `thread/resume` identity, strict failure, release and local round trip. |
| Claude Code | Implemented | Unavailable | No-prompt initialization, exact identity, sandbox/approval parity and safe release. |
| OpenCode | Unavailable | Unavailable | Listing currently mutates its SQLite store; find a verified read-only alternative. |
| AGY | Unavailable | Unavailable | Original-store discovery, strict conversation load and safe HOME/delegation handling. |
| Kimi | Unavailable | Unavailable | Independent native discovery, ACP identity, retention and local reopen evidence. |
| ZCode | Unavailable | Unavailable | Official app-server discovery, workspace identity, restore and close evidence. |
| DSH | Unavailable | Unavailable | Native discovery/resumability, strict fallback suppression and local reopen evidence. |

Binary availability or generic ACP resume support is insufficient certification.
Unavailable backends MUST return a limitation, never a simulated resume or a
fresh session labelled as restored. Completion of the wider eight-backend goal
requires separate evidence for every advertised backend and direction.

## 2. Local opt-in and native stores

Sharing defaults to disabled for new and existing configurations. Local setup:

```bash
remote-cli config set sessionSharing.enabled true
remote-cli config set sessionSharing.backends.pi.enabled true
```

Only boolean master/per-backend flags are implemented. An unset backend flag
follows the enabled master; an explicit backend-off or master-off blocks new
chooser/connection actions. Invalid configuration fails closed without replacing
unrelated settings. Restart the service after local configuration edits.

Remote commands cannot enable sharing, grant new working directories or accept
native store paths. Existing Pi bindings remain inspectable and
detachable after sharing is disabled; disabling discovery MUST NOT authorize
history deletion. Blocking every already-connected turn on configuration changes
is a future lifecycle requirement, not a guarantee of the current gate.

### Native metadata readers

| Backend | Implemented resolution and source |
| --- | --- |
| Pi | Exact `PI_CODING_AGENT_SESSION_DIR`, then project/global native `sessionDir` settings, then the default per-project store. Native agent settings respect `PI_CODING_AGENT_DIR`. The remote-cli Pi store is also scanned. |
| Codex | `CODEX_HOME` or the default native home; active and archived rollout headers plus the native session-name index. |
| Claude Code | `CLAUDE_CONFIG_DIR` or the default native config root; encoded project directories and bounded transcript-head metadata. |

Listing MUST NOT start a backend, model, login flow, extension or project filter.
A native list command that creates databases, locks, logs or settings is not a
read-only implementation. Metadata readers validate canonical native roots and
workspace equality before transmission. DirectoryGuard authorizes the thread's
working-directory selection; it is not a backend filesystem sandbox.

Readers are bounded. The shared scanner limits retained files per store and has
an additional recursive scan budget; backend-specific header/settings limits
remain explicit. Pi counts can be lower bounds; Codex/Claude counts are unavailable
rather than inferred from full transcripts. Menu limits are not native history
size limits. A strict wall-clock catalog deadline remains future work.

Missing optional stores are empty. Existing unreadable stores or exhausted scan
bounds report incomplete coverage. Ambiguous duplicate native IDs are hidden.
Locally configured root aliases may be canonicalized; file symlinks are rejected.
Malformed IDs, mismatched workspaces and synthetic/delegated/sidechain histories
are excluded. Durable synthetic attribution after pointer deletion remains an
open requirement; name-prefix filtering alone is not a complete provenance model.

## 3. Identity and command routing

Remote thread IDs and native session IDs are different identifiers. Native IDs
are backend-scoped, bounded opaque values, never shell source or filesystem paths.
IDs, names and directory encodings alone are insufficient workspace evidence.

`MessageHandler` intercepts `/resume`, `/r` and `/session` before executor
construction, ordinary shortcut expansion, working-directory changes or native
slash passthrough. This applies to both text and real Router slash envelopes.
`/continue` and unrelated backend extension commands retain their existing roles.

Router device selection and reply/active-thread resolution remain unchanged.
A session command normally affects the existing selected thread. It never creates
a user-facing thread or switches the global backend implicitly. Browsing another
backend does not switch the thread; Pi connection requires an already-Pi thread.

### Implemented text commands

| Command | Current behavior |
| --- | --- |
| `/resume`, `/r` | List the selected backend's sessions for the current workspace. |
| `/resume backend <key>` | Browse another implemented catalog without switching the backend. |
| `/resume page <menu-token> <page>` | Page the original snapshot without rescanning storage. |
| `/resume search <menu-token> <text>` | Search snapshot name/ID metadata into a new snapshot. |
| `/resume select <menu-token> <row>` | Select the snapshot's globally numbered row for confirmation. |
| `/resume id <native-id>` | Exact lookup in the current backend/workspace, followed by confirmation. |
| `/resume confirm <token>` | Consume and revalidate a Pi connection confirmation. |
| `/resume cancel <token>` | Cancel a connection draft without changing history or binding. |
| `/session` | Inspect the current Pi binding or report an unavailable/unbound state. |
| `/session detach` | Display a confirmation to forget the Pi association. |
| `/session confirm <token>` | Apply the matching detach draft. |
| `/session cancel <token>` | Cancel the detach draft. |

Bare-ID shorthand, `/resume backend <key> <id>`, automatic backend switching,
`/session operation`, interactive session cards and managed local launch are not
implemented. Unsupported syntax or backend capability MUST fail explicitly.

### Menus and confirmation

Menus show eight rows per page. Each snapshot/confirmation uses a random
12-character base64url token with a five-minute lifetime. The CLI bounds each
in-memory collection to 64 entries. Tokens are scoped to the originating user,
thread and canonical workspace; confirmations are action-specific and single-use.
They are not durable operation IDs or native credentials.

Displayed rows contain sanitized, bounded names/IDs, source, modification time
and available message counts. No prompt excerpts, old assistant/tool content,
credentials, unrelated workspaces or native locators are sent in the chooser.
Session names may themselves be private; local opt-in authorizes their display
to the bound Feishu user. An unnamed row uses an ID, not its first prompt.

Selection is mutation-free. Ordinary messages continue in the current
conversation while a draft is pending; only successful connection changes the
binding. Pi confirmation describes the chosen session,
replacement of an existing connection, history preservation, no-task loading,
current model/effort overrides and the need to keep the other side idle.
It warns that native local `/resume` is still required and concurrent writes may
create separate branches.
Confirmation re-resolves the candidate rather than trusting a path from chat.
The file revision fingerprint is `dev:ino:size:mtimeMs`; a detected change since
selection requires a new selection. This is not a content hash or writer lock.

Read-only controls need no executor and may run while ordinary work is busy.
Connection/detach reject running or queued work and pending queue
confirmations; they use thread operations and resume queue draining afterward.
Complete settings/approval/delegation/maintenance admission and durable context
revision binding remain future hardening requirements.

## 4. Pi native lifecycle contract

`PiExecutor` uses the existing RPC transport and exact `--session <file>` launch.
It stops the previous owned runtime before loading the selected session and checks
`get_state` for the expected session ID and canonical file. Connecting sends no
`prompt`. A mismatching, missing or streaming session is refused; the previous
association is kept on failure. Identity checks persist on adopted process restart,
so a missing adopted file cannot silently become a fresh conversation.

Pi may append ordinary native metadata during startup even without a prompt.
Resume is therefore not a read-only native operation. Adopted launches omit
`--name`, which would append `session_info` and rename user-owned history.
Older-format migration and arbitrary extension startup behavior need separate
version-specific evidence; startup identity alone does not certify them.

The per-thread Pi pointer records `adopted`. Legacy `released` flags are ignored. Adopted history is
preserved by reset and thread-data deletion. Detach stops the owned process,
forgets the file association and allocates a fresh identity for the next turn.
Foreground Pi reset and thread-data deletion preserve ordinary and adopted
native history. `/new` and `/clear` remain aliases: they remove the current
association and choose an independent new native ID without changing the remote
thread or preferences. The next prompt materializes the new session; the old
one remains discoverable. Worker/metadata cleanup retains its disposable rules.

Each adopted prompt first stops the owned idle RPC process, reopens the exact
session file and verifies native ID/file before dispatch. Local appends are thus
loaded without another remote chooser or release step. Busy preparation blocks
overlapping turns/context changes; abort/reset/shutdown cancel before dispatch.
Private non-adopted sessions and delegated workers retain their persistent mode.
The association remains reserved by its pointer. Pointer scans detect other
recorded thread holders, not atomic cross-process admission or native exclusivity.

From `1.6.165`, connection reserves the canonical Pi file before asynchronous
startup across threads in one daemon. Connection and detach succeed only after
their pointer write succeeds; write failure retains the previous association.
An unknown or unconfirmed cleanup outcome quarantines the selected file until
client restart after confirmed Pi exit. Pi confirmations share settings admission
and reject queued work, active delegated tasks, and automatic updates. These guards
do not change Claude Code or Codex executors, settings, or native histories.

`remote-cli session show --thread <name> --backend <key>` reads only local pointer
metadata and works without a daemon or backend process. Verified native reopen
commands are printed on the computer, never as native paths in Feishu. Missing
history is reported explicitly. Reopen guidance is not a verified local-return
round trip or a managed writer lease.

### Current limitations

- Plain terminal Pi is unmanaged. Keep the other side idle while executing and
  resume the file before the next local turn. There is no force takeover.
- Different CLI instances/config roots can evade pointer-based conflict checks.
- Confirmation tokens do not persist across restart and are not idempotent receipts.
- Current pointer writes are not a crash-recoverable, multi-record transaction.
- Config/enrollment/binding revisions and all context barriers are not uniformly
  captured by the current confirmation scope.
- Effective launch resources and global/per-thread model choices can differ from
  the original local session. Restoration is not identical runtime reconstruction.
- Delegation instructions, when enabled, become part of subsequent user turns.
  Old approvals, worker handles and tool results are not restored as live actions.
- Do not downgrade with adopted pointers still present: older deletion code may
  unlink user-owned native history. Detach using the new version first.

## 5. Requirements before extending support

These requirements are future release gates, not an implemented schema or a
promise that a registry/lease API already exists. No particular module names,
state directory layout or durable operation record format is prescribed here.

### Cooperative ownership and recovery

A future managed implementation MUST use an account-local canonical conflict
identity across device registrations, config-root aliases and physical session
aliases. Acquire ownership before native startup, migration, compaction or any
other potentially writing metadata operation. Some database backends may require
store-level rather than per-session exclusion.

Recovery requires independent parent/child exit evidence and process-generation
checks. Parent death, a quiet file, elapsed TTL or heartbeat loss is not sufficient.
Unknown or unconfirmed ownership remains blocked. Never kill unrelated processes,
remove unknown locks or expose remote force takeover.

Durable transition intents and bounded terminal receipts must preserve the old
association until target identity and metadata commit are verified. Persistence
failure must not be reported as durable success. Native startup and metadata
writes are not atomic; uncertain outcomes require recovery, not automatic rollback
or replay. Authentication/enrollment revisions must survive reconnect without
allowing a rebound owner to reuse another owner's pending action.

Use existing thread admission before a short metadata guard. Do not hold the
global guard across native calls, scans, hashing, liveness probes, process waits
or callbacks. Deadline responses may return pending while ownership stays held;
read-only status and abort must remain responsive without recursively acquiring
the same mutation lock.

### Native adapters and current policy

Each new adapter MUST prove read-only discovery, canonical store/workspace
resolution, exact no-prompt identity verification, no-fresh failure handling,
history-safe release and native local reopen independently. Generic ACP load
support is not proof of compatible storage, listing, deletion or replay behavior.

Historical notifications MUST NOT become fresh Feishu text, tools, images,
approvals or task output. Live startup login/permission/extension input is different:
safely stop or report required local setup, never silently approve or leave it
hidden. Autonomous model/tool work during loading invalidates no-task connection.

Use the real thread's current sandbox/approval/resource policy. No cross-backend
adoption may silently weaken it. History is not authorization to replay approvals
or grant filesystem/network access. AGY global HOME access must not redirect
remote-cli delegation/settings writers into the user's real configuration.

Strictness must survive restart, backend return, settings changes and recovery.
Compaction must preserve native identity; AGY/DSH summarize-reset fallback must
not run for an explicitly adopted history. Preserve pending continuation seeds
with their original context, never inject them into another adopted session.
DSH's existing telemetry/log suppression remains mandatory for new transports.

### Local round trips and optional cards

Bidirectional support requires a same-native-session test with distinguishable
sentinels: local work, remote continuation, local reload/continuation, and
remote refresh/continuation on the same session. Idle windows may stay open
under the explicit single-active-side assumption.
A remote-only prompt test or a saved pointer does not prove that round trip.

A managed launcher additionally needs native exclusive ownership or a verified
guard covering native session replacement, reload and extension switching.
An unguarded TUI wrapper must remain labelled manual/unmanaged. No global hooks,
credential copying or automatic store migration are part of that product contract.

Current text commands use existing protocol version 1 envelopes. Optional cards
must negotiate additive capabilities, validate original user/device/card/thread
and snapshot revisions, and show success only after CLI acknowledgement. Old
peers retain text fallback. Breaking envelope or handshake changes require the
repository's protocol-version review, not an assumption of compatibility.

## 6. Verification and release checklist

The [implementation plan](SESSION_RESUME_PLAN.md) tracks completion, and the
[evidence record](SESSION_RESUME_EVIDENCE.md) distinguishes automated tests,
synthetic native probes and manual Feishu results. A future interface name or
checkbox is never proof of native behavior.

Current regression coverage must retain these scenarios:

- Real slash envelopes and ordinary text reach program controls, never prompts.
- Disabled/invalid configuration fails closed without changing unrelated state.
- Bounded catalogs enforce workspace/privacy rules, exclusions and honest gaps.
- Page/search rows remain snapshot-bound; expired/wrong-scope tokens do not mutate.
- Selection/cancellation do not construct a runtime or send a task.
- Missing/mismatching/native-error loads preserve the old association.
- Successful Pi connection verifies exact file/ID before the next real prompt.
- Foreground history survives clear, new, detach and thread deletion; reset uses
  a fresh independent ID, including after restart before the next prompt.
- Every adopted remote prompt reloads the exact file; legacy released flags do
  not block restart. Removed release syntax never reaches native slash passthrough.
- Running/queued work blocks context change; queue draining resumes afterward.
- Errors produce bounded command responses rather than crashing message handling.
- Native fixtures use Pi's block-array message shape, not invented transcripts.

Future gates additionally cover multi-process contention, crash recovery,
revocation/rebind, hard-link and config aliases, out-of-band writers, all context
barriers, historical-event filtering, live startup input, identity-preserving
compaction and independently verified local round trips per backend/platform.

Source changes require corresponding tests. Runtime releases synchronize all
three package manifests and applicable lockfile entries, both READMEs, English
CHANGELOG and the approved localized summary. Review exact staged changes and
new artifacts for secrets/private data before every commit, and the outgoing
commit range before any push. Sanitized summaries are not proof of exhaustive
privacy or binary/OCR coverage. No force-push or remote history rewrite is
implicitly authorized by this document.
