# Backend-neutral managed scheduling tools

## Goal

Allow the current foreground AI backend to turn a natural-language scheduling
request into a managed native task, then deliver an interactive management card
to the original thread. Preserve structured `/schedule` commands and the existing
scheduled-result outbox.

## Architecture

The execution path is:

`backend tool adapter -> authenticated turn scope -> shared schedule operations -> native schedule provider`

Tool registration and native timing are separate capabilities. The initial
native providers remain Claude and DSH. Other backends must return an explicit
unsupported result for creation until their native timing and autonomous result
delivery meet the existing admission requirements. No backend fallback or
framework-owned timer is introduced.

The framework captures user, device, thread, conversation generation, working
directory, backend, model, effort, and policy from the active turn. Model-provided
arguments contain task content and timing, or an existing task reference; they
cannot override execution identity or policy. Scheduling does not depend on the
managed delegation toggle and is not exposed to managed child workers.

## Implementation sequence

1. Extract a common tool registration and authenticated transport boundary while
   retaining delegation compatibility and native session identity. Register tools
   before a turn and avoid recycling a process for each unchanged configuration.
2. Implement shared capability, creation, listing, cancellation, and operation
   receipt handling. Reuse validation and native management for slash commands
   and model tools. Clarify ambiguous time or timezone requests before creation.
3. Deliver original-thread management cards without replacing assistant output.
   Reuse the existing card authorization and confirmation flow. Negotiate new
   transport behavior and retain text-command recovery for old peers or failed
   card delivery.
4. Verify the closed loop with synthetic native providers and mocked Feishu
   delivery, then run package builds, focused coverage, and regression suites.

## Required invariants

- Tool transport timeouts are not native creation failures. Use bounded operation
  receipts and stable request identities; a retry cannot create a second task.
- Do not automatically replay a model execution after an accepted scheduling
  mutation. Revalidate turn, connection, and context before starting operations.
- Abort and teardown close admission and safely settle or fence accepted work.
  Never report successful cancellation before native cleanup is confirmed.
- Restricted execution must not gain unrestricted scheduling privileges.
- No schedule catalog, native process, or result subscriber is initialized merely
  because a user chats or tools are advertised. No polling model turns are added.
- Preserve ordinary assistant output, queue/recovery behavior, delegation tools,
  old-peer fallback, and scheduled-result delivery acknowledgements.
- Card delivery failure does not undo native creation or justify creation retry;
  `/schedule list` remains the recovery path.

## Acceptance evidence

Cover Claude and DSH tool creation through card cancellation; delegation on and
off; unsupported backends; sandbox and old-peer rejection; foreign owners and
stale generations; connection replacement; lost replies and duplicate requests;
abort/recovery races; pending cleanup; and dormant ordinary chat.

Use portable isolated fixtures. Report the operating systems actually tested and
distinguish synthetic integration from live native or Feishu verification.

## Delivery boundary

Integrate and review worker artifacts explicitly. Synchronize version manifests,
release notes, and both READMEs with the final behavior. Leave changes uncommitted;
publication and deployment are outside this request.
