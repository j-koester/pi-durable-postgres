# Changelog

## Unreleased

- Ported to Pi Durable, Chord and Pi AI 1.5.2, pinned exactly (peer and dev). See `docs/port-1.5.md`.
- `commit(batches, receive, context)` returns a `CommitResult`: all batches in one transaction, one seq each, the first
  refused batch ends the call, receipts after `COMMIT`. A database failure rejects the call instead of refusing a batch.
- Invalid read requests (unknown conversation, malformed cursor or scan order) throw `StorageRequestError`; a malformed
  cursor is no longer ignored. `StorageRejected` no longer exists upstream.
- Schema version 2 allows the `sleeping` task status. Databases migrated by this release cannot be opened by earlier ones.
- Connection `end` now also marks the owner failed. New tests: ownership lock and fail-closed behaviour under
  `pg_terminate_backend`, batched commit refusals, the version 2 migration.

## 0.1.1 — 2026-10-05

- Re-validated against Pi Durable, Chord and Pi AI 1.0.3. Upstream changes include
  ExecutionEnv APIs, configurable progress commits and output handling; the
  storage contract and reference backends are unchanged. Full conformance and
  regression suites pass.
- Peer pins moved from 1.0.2 to 1.0.3 per the pinned-peer maintenance policy.
- Fixed the consumer smoke test's stale Pi AI 1.0.2 pin: it now uses the declared
  development dependency, avoiding incompatible duplicate model-registry types.
- Documented progress-write tuning and confirmed that 1.0.3 still has no public
  live-deletion lifecycle API.

## 0.1.0 — 2026-10-05

Initial alpha, published as npm `@netzlabor/pi-durable-postgres` and source repository
`j-koester/pi-durable-postgres`.

- PostgreSQL storage validated against Pi Durable and Chord 1.0.2.
- Query-local bigint parsing, serialized adapter operations, expired transaction
  handles, graceful draining on close and fail-closed connection handling.
- Exclusive database/schema ownership and guarded maintenance deletion.
- Correct graph traversal for shared fork/ownership descendants.
- Transactional migration and deletion failure regression tests.
- Isolated per-test schemas and type-checking of both source and tests.
- Scoped public packaging, automatic prepack build, consumer tarball smoke test,
  corrected tag-triggered CI publishing and retained upstream MIT attribution.

### Limitations / pre-release API changes

- Live deletion is a design goal, not implemented. The helper now rejects while
  storage is open; close the Harness and use a fresh maintenance facade.
- Custom PostgresDatabase adapters must implement ownership and maintenance locking.
- The Node adapter exclusively owns its pool and pins one PostgreSQL connection;
  transaction-pooled proxies are not supported.
- Experimental upstream peer versions are pinned instead of accepting every 1.x release.
