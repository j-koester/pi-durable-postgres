# Port to Pi Durable 1.5.2: storage contract diff

Baseline: this adapter at e66d502 targets Pi Durable 1.1.0 (validated on 1.0.3 in 0.1.1). Target: `@earendil-works/pi-durable`
1.5.2 (pi repo tag v1.5.2, b4afddd), pinned exactly together with `@earendil-works/chord` and `@earendil-works/pi-ai`.
Paths below are in `earendil-works/pi` at v1.5.2, under `packages/durable/` (changelog entries: `CHANGELOG.md`).

## Contract changes and how the adapter handles them

| Change (since) | Where at v1.5.2 | Adapter |
|---|---|---|
| `commit(writes, context): Promise<Seq>` is now `commit(batches, receive, context): Promise<CommitResult>` (1.5.0) | `src/types.ts` (`Storage`, `CommitResult`); reference `src/storage/sqlite/storage.ts` (`commit`, `checkBatch`), `src/storage/sqlite/commit.ts` | `PostgresStorage.commit` stores all batches in one transaction, one seq each. Each batch is checked before it writes, against the earlier batches (same transaction). The first refusal ends the call: earlier batches commit, `{ stored, refused }` is returned. `receive(index, seq)` runs after `COMMIT`, in order. |
| A failing database call is not a refusal (1.5.0) | `src/storage/sqlite/storage.ts` (`watchCalls`, `CheckCalls`) | Checks run on an executor that records failed calls; a failed call rejects (unknown outcome, rolled back, no receipt), a thrown Durable check refuses. |
| Copy sources are resolved during the checks, not while writing (1.5.0) | `src/storage/sqlite/storage.ts` (`resolveCopies`), `src/storage/store/commit.ts` | `resolveCopies` runs inside `checkBatch`; `applyDocumentActions` only writes the resolved base. `StorageRejected` is gone, so a refusal is any thrown Error. |
| `mintId()` returns an ID greater than every ID minted since open and every stored ID, across reopen (1.5.0) | `src/types.ts` (`Storage.mintId`) | Unchanged and sufficient: `next_id` is read at open and raised by every committed explicit ID. Not persisted for IDs minted but never committed (allowed by the wording). |
| `StorageRejected` removed; `StorageRequestError` for invalid read requests, everything else fails the Session (1.2.0) | `src/errors.ts`, `src/storage/scan.ts` (`scanStart`) | Unknown conversation, bad cursor, bad or mismatched scan order, `entry()` without an ID, and history a document does not keep throw `StorageRequestError`. A malformed cursor is no longer treated as "no cursor". |
| New task status `sleeping` (1.4.0) | `src/storage/sqlite/migrations.ts` (schema version 2) | Migration 2 replaces `tasks_status_check`. A migrated schema is refused by 0.x adapters ("newer than supported"): no rollback past this release. |
| `ScanOrder` on all scans, cursors carry their order (1.1.0) | `src/storage/scan.ts` | Already implemented; error types aligned. |
| Optional `publishing(publish, context)` (1.5.0) | `src/types.ts` (`Storage.publishing`) | Not implemented: optional, the Session then publishes directly. |
| Chord root exports removed: `Context`, `JsonValue` | `src/storage/memory.ts` imports | Imports moved to `@earendil-works/chord/context` and `/json`. |
| Storage conformance: receipt checks, mixed-batch cases | `src/testing/storage-conformance.ts`, `src/testing/commit-writes.ts` | `checkReceipts` proxies `commit`; `commitWrites()` replaces direct single-batch commits in tests. Empty batches are never sent by the Session, so tests use `touch()`. |

## Watch and changes: no storage work

`watchEvents()` and its types were removed in 1.5.0 in favour of conversation views and `observeConversation`, `observeCommits`,
`Conversation.watch()` (`src/session/session.ts`, `src/harness/view.ts`). These are Session/Harness APIs fed by commit
publications (`CommitPublication`, `src/types.ts`) that the Session builds itself from what it commits. `Storage` has no
watch method, so the adapter needs no change. Deferred commits (`persistence: deferred`, spec 4.1) only change when `commit()`
is called, not its contract.

## Operating constraints (unchanged, documented)

- One owner per schema: session advisory lock on one pinned connection, fail closed on connection loss (`error` and `end`
  events), never reconnect. Tests: `test/ownership.test.ts`.
- Connect through the CNPG `-rw` service, or a `Pooler` in `session` mode. Transaction pooling breaks the session lock.
- Not ported: group-commit round-trip optimisation. A call costs several statements per batch, not a few per call.
