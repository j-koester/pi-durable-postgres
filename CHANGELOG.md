# Changelog

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
