# Native-session scheduling

## Requested behavior

Scheduled work should behave as closely as supported transports allow to a
user creating a schedule in the backend's own CLI conversation. The scheduling
adapter must preserve native conversation identity, not replace that identity
with a summary, a copied transcript, or a separate snapshot session.

This supersedes the separate-session design introduced in 1.6.232. Implementation
and verification are in progress; this document does not describe released behavior.

## Implementation sequence

1. Verify native create/list/cancel and autonomous occurrence events for an
   existing Claude or DSH conversation. Keep the public scheduling tool contract
   backend-neutral and make unavailable native operations explicit.
2. Connect scheduling to the foreground executor's native session. Preserve
   native turn ordering, current conversation context, and later conversation
   updates. Avoid reentrant model turns while a managed tool is waiting.
3. Connect native job identity and occurrence completion to the existing owner,
   thread, management cards, and acknowledged result outbox. Reconcile supported
   native lifecycle transitions without replaying task creation.
4. Verify context continuity and lifecycle boundaries, integrate the changes,
   synchronize package versions and user documentation, and leave the result
   uncommitted for review.

## Acceptance boundaries

- A task referring to earlier conversation content runs in that conversation.
  Later foreground turns and recurring occurrences use the same native history,
  subject to the backend's own context management.
- Multiple schedules can share a conversation without sharing task identities,
  duplicate creation, or confusing one occurrence's output with another turn.
  DSH may batch due reminders into a single native turn; a shared batch answer
  must not be presented as separately generated per-job answers.
- Native scheduling alone owns timing. No framework timer, polling prompt, or
  invented transcript substitutes for native execution.
- Creating a schedule from a model tool cannot deadlock waiting for a second
  model turn in the same conversation. Pending receipts are not success.
- Cancel only the requested job. Do not terminate the shared conversation or
  unrelated schedules to implement per-job cancellation.
  Distinguish cancelling future firings from interrupting an occurrence already
  accepted by the native conversation; do not suppress its terminal outcome.
- Preserve authenticated ownership and original-thread delivery. Never adopt a
  foreign native job because it happens to appear in a native task listing.
- Recover only native state whose identity and ownership can be established.
  Report unsupported restoration honestly; do not silently recreate lost jobs.
- Old catalog entries must not be silently moved into a new native conversation.
  Preserve completed-result delivery and explain legacy interrupted records.
- Unused scheduling must not add model turns, create task stores, or degrade
  ordinary chat, existing tools, recovery, and old-peer behavior.
- Tests must force relevant foreground/background interleavings and cover
  cancellation, disconnects, resets, session changes, and partial failures.

## Evidence requirements

Report source-level capability evidence separately from synthetic tests and
live native execution. Linux checks do not establish macOS or Windows execution.
Real user schedules and external message delivery are not required for this
implementation review. Publication and deployment require a separate request.
