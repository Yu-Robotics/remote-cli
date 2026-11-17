# Foreground native-session scheduling

## Behavior

Claude and DSH managed schedules use the foreground executor's actual native
conversation. Earlier discussion, later foreground messages, and recurring
occurrences share the backend's history, subject to its own compaction. Multiple
jobs in one thread share context; separate threads retain separate identities.
No copied transcript, generated summary, or forked task session is introduced.

## Native integration

Claude uses a two-phase operation: a scoped managed tool reserves an exact Cron
action, returns it to the foreground model, and validates its native tool receipt.
PreToolUse authorization checks the action, arguments, owner, and operation scope.
The model must perform the returned action in its current turn. The adapter never
waits for a second model turn inside that tool call. Unexecuted reservations fail
at foreground completion instead of blocking operation drain indefinitely.

Slash and card operations queue bounded management turns in the original Claude
session. Native command lifecycle IDs and an exact owned prompt marker distinguish
scheduled occurrences from foreground responses. Simultaneously due reminders
may form a native batch; their cards label the shared combined answer. A native
scheduled result cannot complete an unrelated foreground request.

DSH uses supported --patch composition and native ctx.schedule CRUD on the
foreground Agent, including while an MCP tool invocation is active. The bridge
loads the native scheduler only on explicit management and observes inbox claims
and durable session events. It buffers early creation events and associates
native projection identities with foreground or scheduled work. Native DSH may
combine foreground input and due reminders into one turn; those participants
share the turn's actual answer. The adapter preserves the actual foreground
terminal outcome rather than a later autonomous turn's outcome.

## Ownership and lifecycle

The framework captures authenticated user, thread, working directory, backend,
and conversation generation. Models cannot supply or replace that identity.
Native tool receipts and native job IDs establish ownership before success is
reported. Foreign jobs are never adopted from a task listing.

Cancellation removes the requested native job and prevents future firings; it
never kills the shared Agent or unrelated jobs. A queued or running reminder may
still execute under the backend's native semantics. Results from occurrences
already tracked as running remain deliverable after cancellation. Catalog state
and result acknowledgements remain distinct from native conversation history.

Native process recycling interrupts managed jobs. This implementation does not
restore jobs across CLI restarts or migrate legacy isolated jobs into a foreground
conversation. Claude uses non-durable native job creation; DSH directs the schedule
domain to fresh process-owned storage while leaving ordinary native session
history in its existing storage. The durable catalog retains interrupted states
and completed pending results. Schedule restoration is permanently cancelled. Preserving conversation history
alone is not execution permission.
Resumed Claude sessions without the managed scheduling hook disable native task
execution at launch, including restricted resumes and external compaction.
Managed resumes validate native hook policy; owned terminal events also wake
foreground messages waiting in the confirmed thread queue.

Claude recurring jobs require the effective native session timezone because
CronCreate has no per-job timezone field. One-shot timestamps are converted to
that timezone, and ambiguous clock-rollback instants are rejected. Native hook
policies and unsupported capabilities are reported rather than silently changed.

## Validation boundary

The implementation workers ran focused synthetic transport, executor, schedule,
outbox, and card regression suites on Linux. The Claude adapter measured 98.91%
line coverage and 87.65% branch coverage. The initial DSH modules measured 85.33%
aggregate line coverage; the native storage bootstrap also ran in a synthetic
Node child outside the V8 coverage process.

A bounded installed DSH 0.2.1-rc.5 smoke check loaded the compiled overlay,
initialized ACP, created an empty isolated session, and confirmed lazy native
service readiness. It used no credentials, prompt, or scheduled job and confirmed
child exit. Installed Claude 2.1.311 source informed the hook/lifecycle handling;
actual provider tool discovery, model receipts, and timed occurrences were not
exercised. Synthetic session identity tests do not establish model recall quality.

Coordinator integration includes both implementations, common-interface conflict
resolution, documentation, synchronized version manifests, and focused combined
regressions. No real model inference, Feishu sends, production restart, publication,
or deployment is part of this change. Native macOS and Windows execution remains
unverified for this revision.

## Host loss and cleanup admission (1.6.257)

Catalog versions 1–6 remain readable and writes remain v6. Startup marks only live
creating/active/running rows interrupted; existing errors, original ownership,
cleanup selectors and completed outbox results survive. No startup native CRUD or
model request and no exit-time scheduling RPC, checkpoint or handoff is performed.
An admitted CREATE may return after service destruction. The catalog kernel gate
stays owned only until that already-pending receipt settles so its exact native ID
and cleanup identity can be saved. Shutdown does not wait for it; OS process death
releases the gate. This is not a retained host or schedule continuation.

Historical uncertainty and live admission are distinct. Interrupted AGY/DSH rows
without a supported exact retained-cancellation route neither consume live capacity
nor trigger unavailable native management for list/purge. Their cancellation intent
and unresolved cleanup ledger are preserved; no absence or success is inferred.
DSH emits an awaited attribution event before native CREATE and returns the same
cleanup identity on success. The legacy `dsh-session-orderly-v1` / `reconstruct`
discriminators now identify deletion provenance only. They never grant restoration.
Both retained rows and purged cleanup entries fence their original session; genuinely
unattributed legacy entries remain unknown. Permanent session markers are retained.

Saved AGY ACP chat cannot safely resume even without a schedule-owner journal.
Native pending reminders are not reliably enumerable or vetoable before inference.
Explicit `/clear` may detach only an owner-free selection with no checkpoint lock:
it durably archives the selection and unconfirmed-retirement evidence, preserves
native history and legacy checkpoint evidence, and selects a fresh conversation.
Automatic compaction cannot perform this detachment. The archive continues to block
thread data erasure across subsequent sessions and restarts, including inactive
backend cleanup. ThreadManager uses the same selection-detachment helper, so a
reset without an instantiated AGY executor cannot bypass these guards. Scheduled ownership
still blocks reset; use a new thread for chat. Existing owned-host retirement and
in-turn purge ordering remain unchanged. No missing journal proves native absence.
For an inactive AGY executor, any owner journal, including `retired: true`, blocks
thread-wide `/clear` and `/cd` even on another backend. Use a new thread; the stored
flag alone is not accepted as current-process retirement evidence.

DSH failures before the refusal marker (including session startup and context
validation) are reported as not admitted. Existing refusal compaction removes only
that fresh attempt and retains its replay fence. Post-marker or ambiguous CREATE
failures continue to retain the original session guard.

Local catalog initialization does not depend on Router result capabilities. Older
Routers do not receive unsupported result frames, and pending completed results stay
in the outbox until a compatible connection. Corrupt catalogs remain fenced rather
than being treated as absent. No protocol shape changes are introduced.
