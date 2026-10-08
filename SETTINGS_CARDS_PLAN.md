# Interactive Backend, Model, and Effort Settings

## Status and approval gate

- Baseline: `64682b4` (`1.6.151`). This plan is approved for implementation.
- AGY approved the plan; Claude Code approved subject to the two binding
  requirements below, recorded before runtime edits.
- Resolve the effective sandbox using the real parent thread ID and inject that
  policy explicitly into any synthetic metadata executor configuration.
- Mirror Claude preference updates and clearing in both `models.claude` and the
  legacy `model` field on active and inactive backend paths.
- Implementation, local validation, and artifact integration are authorized.
- Do not install missing backends, change authentication, deploy, commit, or push.

## 1. Product contract

### Backend card

- Bare `/backend` opens a dedicated settings card, not a model execution.
- List all eight supported backends using stable backend IDs and readable labels.
- Show the effective backend and whether it follows a global or thread setting.
- Uninstalled backends are visible but disabled, with an installation reason.
- Installation does not establish authentication, quota, or model entitlement.
- Scope defaults to `Current thread`. `All threads on this device` is opt-in.
- Selecting a backend or scope edits a draft only. `Confirm` applies the draft.
- Preserve the existing current-thread follow-global operation.
- Warn that a global switch clears thread backend overrides and queued messages,
  as the existing command does. It does not clear native conversations or lanes.
- Never translate a stale displayed ordinal into a new backend selection.

### Model and effort cards

- Bare `/model` and `/effort` open dedicated cards for the original thread.
- Default the target backend to the thread's effective coordinator backend.
- Allow choosing another installed target backend without switching the coordinator.
- Show configured selection, effective/native selection when known, and defaults
  distinctly. Never label the first catalog entry as the current model.
- Model and effort choices are buttons; clicking a choice submits it immediately.
- There is no additional confirmation for these single-choice operations.
- A pending request is not success. Mark applied only after a matching CLI result.
- Include clear/default actions only when the adapter can preserve their semantics.
- After model changes, obtain the model's current effort choices again.
- Unsupported controls, unknown defaults, failed catalogs, and empty catalogs
  remain explicit; do not invent model IDs or universal effort levels.
- Paginate large catalogs and preserve exact opaque choice values internally.

### Worker preferences and scope

- Reuse existing per-thread, per-backend `models` and `efforts` preferences.
- An inactive target backend update changes future configuration only; it does
  not replace the coordinator executor or alter a running/queued worker instance.
- Reject settings mutations while the affected parent thread is busy, including
  delegated work and pending execution, rather than interrupting work.
- Future workers read the existing preference path at their normal launch point.
- Same-backend coordinator and Worker preferences remain shared in this change.
  Separate Worker override profiles are not introduced implicitly.
- Existing parameterized slash commands retain their meanings and error behavior.
  In particular, `/backend <index>` remains global and the `@` form thread-local;
  only the new card's draft defaults to current-thread scope.

## 2. Catalog and adapter work

Normalize backend capabilities into typed model and effort choices with stable
values, display labels, availability, source, and explicit error information.
Keep provider data separate from account credentials and native transcripts.

| Backend | Model source | Effort source and required work |
| --- | --- | --- |
| Codex | App-server `model/list`, paginated JSON | Use native supported/default efforts; preserve existing native setters. |
| OpenCode | ACP model config option | Use the active model's effort option and refresh after changes. |
| Kimi | ACP model config option | Preserve native thinking values and the existing automatic setting. |
| DSH | ACP model config option | Preserve model-specific efforts and absence of a control. |
| ZCode | Native settings adapted through ZCodeClient | Preserve provider-qualified model values and returned reasoning levels. |
| Pi | RPC `get_available_models` | Query `get_available_thinking_levels` for the selected model, not a global constant. |
| Claude Code | SDK/control initialize model directory | Add catalog support only through a verified native interface; add native effort support without turning settings into a model prompt. |
| AGY | `agy models` tab-delimited rows | Parse only the verified two-column format; preserve supported effort flags and automatic clearing. |

- Support ACP flat and grouped select options; reject unsupported shapes clearly.
- Do not scrape TUI output, run a model to generate a menu, or infer option lists.
- AGY parsing is bounded, deterministic delimiter parsing, with malformed and
  duplicate rows handled explicitly. Text-command fallback remains available.
- Check Claude's installed control protocol before relying on SDK declarations.
  Never send `/model` or `/effort` as a natural-language substitute for a setter.
- Claude effort support must respect installed-version/model capability; native
  clamping or organization limits must not be reported as an exact applied value
  without evidence. If the capability cannot be established, show unavailable.
- Metadata reads must not switch the active thread, use a parent's pointer as a
  preview pointer, clear native context, or start an inference turn.
- For an inactive backend, use an isolated, short-lived metadata executor with
  a synthetic identity, no delegation bridge/lifecycle hooks, and preserved
  effective sandbox policy. Do not reuse managed-worker privilege overrides.
- Resolve Codex and Claude saved sandbox overrides against the real thread ID
  before constructing a preview; inject the resolved policy into its config.
  A synthetic-ID policy lookup must never replace the parent's effective policy.
- Prefer bounded one-shot metadata commands when sufficient, especially AGY
  catalogs, without creating temporary backend homes or inference sessions.
- Shut down metadata executors in `finally`; clean only their own temporary
  pointers/data after confirmed exit. Never delete parent or Worker state.
- Apply bounded metadata deadlines and release resources after failure. Start
  with a 10-second request deadline and bounded output; no persistent polling.
- Pi and ZCode are absent locally. Their protocol/fixture tests are not live
  acceptance. They stay disabled here and are not automatically installed.

## 3. CLI ownership and mutation semantics

- Factor settings operations into one application-owned service used by both
  cards and existing textual mutations; avoid two inconsistent command paths.
- Keep thread/backend targets explicit and validate ownership and existence.
- Read-only catalog selection changes the view only, not persisted preferences.
- Capture an opaque snapshot ID with immutable thread, cwd/generation, backend,
  relevant configuration revision, option values, expiry, and operation kind.
- Revalidate installation, snapshot revision, choices, context, and busy state
  after awaited catalog work and immediately before any side effect.
- Serialize settings writes with execution admission and other settings writes;
  a check followed by an unguarded asynchronous setter is insufficient.
- A global backend change uses a device-wide admission barrier and checks every
  affected thread. Thread-local changes use the matching thread barrier.
- Successful application requires both native acceptance (where applicable)
  and preference persistence. On uncertain or partial failure, show an explicit
  error, invalidate affected snapshots, and never claim automatic rollback.
- Changing inactive backend preferences must not leak a temporary executor into
  ThreadExecutorPool or modify its coordinator backend/session identity.
- Mirror Claude model writes and clearing into the legacy `thread.model` field.
- Bound snapshot and request-receipt storage by capacity and TTL. Duplicate
  request IDs with the same operation return the recorded result; altered
  payloads must not be treated as retries of the original operation.
- Lost acknowledgements are unknown/pending, not success. Do not automatically
  retry an operation under a new identity or replay it after service restart.
- Typed settings commands and thread/backend/context changes invalidate affected
  snapshots too. Deleted threads and old cwd/generation snapshots fail closed.

## 4. Protocol and Router card layer

- Add a negotiated `settingsCards` capability, optional typed menu payloads,
  and explicit settings-action/result messages. Keep protocol version 1.
- CLI sends structured menus only to a capable Router. Router exposes controls
  only for a capable CLI. Old peers continue using current text commands/output.
- Transport requests bind an original thread ID and opaque snapshot ID, not an
  arbitrary slash command string or the user's subsequently active thread.
- Reuse existing authenticated connection checks and current-connection guards.
- Add a dedicated SettingsCards controller rather than adding settings elements
  to the growing model execution card or tool disclosure array.
- Bind actions to the original user, device, thread, delivered card, menu kind,
  snapshot, and allowed choice set. Browser callback values are untrusted.
- Draft edits and pagination cannot cause settings writes. Confirmation is a
  distinct action for backend scope/selection only.
- Serialize updates to each card; prevent repeated clicks while a request is
  pending. Old card revisions cannot silently apply a different operation.
- Disconnect/rebind/thread deletion invalidates live controls. Delayed results
  must not reactivate stale controls or mark another card/owner successful.
- Only the matching request's CLI success result updates the applied state.
- Refresh after a change issues fresh option/state metadata and invalidates old
  choice tokens. Do not reuse effort buttons from the previous model.
- Count nested tagged elements and serialized payload size, including headers,
  buttons, containers, controls, and footers. Use existing card budget helpers.
- Begin with at most eight model/effort choices per page. The 150 tagged-node
  budget is the application's conservative limit, not the platform's full limit.
- Escape labels and errors; bound strings, arrays, pages, and retained state.
- Card delivery failure must leave honest text fallback, not invisible success.

## 5. Implementation order and ownership

1. Review this plan with Claude Code and AGY; resolve contract and safety blockers.
2. Add shared choice types and isolated metadata support, backend normalization,
   deterministic AGY parsing, Pi actual-level queries, and verified Claude support.
3. Add settings service, execution-admission barriers, snapshots, setters, receipt
   handling, and compatible CLI/WebSocket messages with unit regressions.
4. Implement dedicated Router cards, authentication/action routing, draft versus
   immediate actions, pagination, state refresh, and text fallback.
5. Integrate independent artifacts explicitly after all accepted workers finish;
   review the combined diff and run focused tests before full package suites.
6. Update both root READMEs consistently, review package READMEs/help, add matching
   English/Chinese release summaries, and bump all manifests/lockfile together to
   the next unpublished patch release. Recheck the baseline version first.
7. Validate the final combined implementation and report tested versus untested
   boundaries. Do not commit, push, install, or deploy without another request.

If implementation is delegated, partition non-overlapping files and give each
worker this complete contract and current baseline. Shared types and integration
remain coordinator-owned. Review approval is not artifact delivery or live acceptance.

## 6. Validation matrix and completion criteria

- Backend card: current-thread default, global opt-in, draft-only selection,
  explicit Confirm, stable IDs, missing executables, follow-global, and busy guards.
- Models/efforts: click-to-submit, selecting another backend without switching,
  native value validation, default clearing, persistence/reload, and refreshed
  model-specific efforts across all eight mocked backend boundaries.
- Metadata: grouped ACP choices, duplicate/malformed AGY text, Unicode labels,
  unknown fields/unsupported controls, timeout, output bounds, and disposal.
- Claude: native catalog/control response fixtures, no prompt-based setter,
  session-preserving supported effort changes, and honest capability failure.
- Identity: synthetic previews cannot change parent/Worker pointers, native
  context, active backend, effective sandbox, or delegation registration.
- Races: task admission during awaits, concurrent text/card mutations, global
  switch while another thread runs, busy Workers, repeated clicks, stale cards,
  changed cwd/generation, deleted thread, rebind, and superseded socket results.
- Delivery: lost result/timeout, same-ID retry, mismatched-ID/payload result,
  disconnect during apply, card-creation failure, and bounded receipts/expiry.
- Pagination: actual nested element counts and JSON size at page boundaries,
  many long labels, selected-state refresh, and old-page action rejection.
- Compatibility: both protocol suites, old CLI/new Router, new CLI/old Router,
  and unchanged parameterized slash-command behavior.
- Run build, focused CLI/Router tests, relevant integration/compatibility tests,
  then complete suites with the repository's bounded Git-test concurrency.
- Target at least 80 percent coverage for new/changed units; report measured
  coverage instead of equating a passed suite with coverage.
- Reuse synthetic fixtures, isolated temporary directories, and the macOS
  homedir mocking convention. Do not read real credentials or native transcripts.
- Metadata-only installed-backend probes, if useful, are not model inference or
  Feishu acceptance. Pi/ZCode and live mobile behavior remain explicit limits.
- Privacy/language/diff checks cover all new files and generated release metadata.
- Completion means local verified behavior, documented compatibility and known
  limitations, explicit artifact disposition, and a version-synchronized change.
