# Live conversation deletion: integration design

**Status: proposal, not an implemented API.** Pi Durable 1.0.2 and 1.0.3 have been
inspected for this design; neither provides the needed public lifecycle API.
The current PostgreSQL helper is maintenance-only.

## Goal

Delete a selected conversation and an explicitly authorized dependency closure
without shutting down unrelated conversations. The accepted deletion intent must
survive a crash, prevent accidental resurrection, and finish idempotently.

Durability applies to the deletion decision as well as ordinary writes. Retaining
conversation contents indefinitely is not a requirement of durable execution.

## Why a storage DELETE is insufficient

Pi Durable owns a serialized mutation line, loaded document trackers, watches,
submission admission, running tasks and recovery scheduling. SQL cannot evict
these objects or prevent a still-running invocation from using a previously
loaded document.

The public 1.0.2 / 1.0.3 interfaces expose:

- Session.commit / close / subscribeCommits / subscribeClose;
- Conversation.abort (including background work when requested);
- Harness task abort/wait operations;
- Storage.commit and reads.

They do not expose a coordinated per-conversation seal, purge, tracker eviction,
watch invalidation or durable deletion-recovery protocol. SessionImpl contains
internal methods such as unloadDocuments/readOnLine, but those are not a supported
purge lifecycle and are not a basis for a public guarantee.

Neither calling abort then DELETE nor blocking new HTTP requests alone closes
all races. A low-level storage rejection can also be treated as a fatal Harness
storage failure rather than a normal "conversation deleted" outcome.

## Proposed lifecycle (requires upstream integration)

1. **Admit and persist intent on the Session mutation line.**
   Authenticate/authorize in the host. Determine the dependency closure under the
   same ordering as creation/forking. Seal all affected conversations against new
   submissions, forks and tasks. Persist an operation ID and target IDs without
   copying the conversation's payload into a separate deletion log.
2. **Quiesce affected work.**
   Signal cancellation, including background and owned subagent work. Wait for
   invocations and their normal abort/finalization commits to drain. New work stays
   sealed; unrelated conversations may progress. Do not erase underneath a task
   that ignored cancellation. Report pending/blocked instead of false success.
3. **Finalize on the mutation line.**
   Revalidate the closure and external task dependencies. Purge records atomically,
   update runtime task state, evict affected document trackers, and terminate or
   invalidate watches and handles through a documented publication contract.
4. **Complete idempotently.**
   Publish a deletion result only after persistence. Define whether/how long minimal
   ID-only deletion receipts are retained; no conversation payload belongs in them.
   The host still owns account-level access restrictions and deletion of external data.
5. **Recover before scheduling.**
   Reopen must recognize unfinished intents before normal task recovery/resume.
   Resume quiescing/purging, never ordinary work for a sealed target. Repeating the
   same operation ID returns its existing progress/result.

A database transaction alone cannot make adoption into runtime caches crash-atomic.
The persistent phase markers and recovery rules are part of this contract.

## Responsibilities

| Layer | Responsibilities |
|---|---|
| Host application | Authorization, account request admission, copied/external data, retention policy |
| Harness / Session | Seal, cancel/drain, dependency coordination, cache/watch invalidation, recovery |
| Storage backend | Atomic purge, persistent intents/receipts as required by the upstream contract |

Do not place arbitrary application code inside a SQL transaction to fake this
integration. Do not hold the global mutation line while awaiting task completion:
those tasks may need that line to terminate.

## Policy questions for the eventual API

- Fork descendants and task-owned descendants are different edges; expose their
  inclusion clearly rather than silently deleting another owner's data.
- A surviving task may wait on work in the target closure. Reject, cancel or
  explicitly include it according to an upstream-defined policy.
- Existing raw references in application document payloads cannot be inferred by
  the storage. The host must maintain its own referential/data-retention policy.
- Deleting the reserved root must not silently recreate it through an old handle.
  Root recreation needs an explicit policy for a live-delete API.
- An external HTTP request or tool side effect cannot necessarily be cancelled or
  undone. Deleting local records does not reverse an email, payment or remote file.

## Acceptance tests before claiming live deletion support

- New submissions, forks and child tasks racing with seal.
- Foreground/background tasks and cancellation-ignoring tools.
- Shared descendants reachable through ownership and ancestry.
- Surviving task dependencies, retained session documents, unrelated conversations.
- Already-loaded document state, watch callbacks and stale handles.
- Crashes after admission, during draining, before/after purge commit, before result.
- Duplicate requests and restart recovery before any task resumes.
- Lost database connection / uncertain COMMIT outcome.
- Authorization boundaries and restoration from backups.

The preferred next implementation step is an upstream public lifecycle API,
validated against multiple storage backends. This repository implements the
PostgreSQL half only once that coordination contract exists. No upstream changes,
issue or pull request have been submitted by this work.
