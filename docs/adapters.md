# PostgreSQL adapter contract

Import the driver-independent facade and storage through
`@netzlabor/pi-durable-postgres/core`. The supported implementation is currently
the Node `pg` adapter; another driver must satisfy this entire contract before
claiming compatibility.

## Queries and transactions

- Use positional `$1`, `$2`, ... parameters as one array.
- `exec` executes one statement without parameters.
- `run` returns the affected row count (required by maintenance deletion).
- `get` returns the first row or undefined; `all` returns all rows.
- Return int8 result columns as safe JavaScript numbers. Reject out-of-range values.
  Parsing must be local to storage queries, not a process-global registry mutation.
- Queue operations in admission order. A transaction holds the queue throughout
  its async callback. Its executor is the only way to run statements inside it.
  Do not call or await the outer facade from its transaction callback.
- Expire a transaction executor when its callback settles, on success or error.
  Calls on an expired executor must reject without issuing SQL.
- Ordinary transactions use READ COMMITTED. `transaction.snapshot` uses
  REPEATABLE READ so multi-query materialization sees one committed state.
- Roll back on callback/query failure. Preserve the original error, but do not
  reuse a connection if rollback failed and its state is uncertain.

## Ownership and maintenance

All records for a store reside in one fixed `current_schema()`. Advisory locks
are database-local; the schema contributes to the stable lock key:

```sql
hashtextextended('pi-durable-postgres:' || current_schema(), 0)
```

- `acquireOwnership()`: use `pg_try_advisory_lock(key)` on a pinned connection.
  Hold the session lock until close. Fail fast on contention or a missing schema.
- All of an owner's writes must use that session. Do not transparently reconnect
  if it disconnects: the ownership lock may have been lost.
- `transaction.maintenance`: reject if the facade itself already owns a store;
  session advisory locks are reentrant, so SQL alone cannot detect this case.
  Otherwise acquire `pg_try_advisory_xact_lock(key)` inside the transaction and
  reject if unavailable. Hold it until commit/rollback.
- Migrations acquire the same transaction-level lock, reentrantly when opening
  the owning storage. This excludes other stores/migrations from the schema.
- The lock protocol is cooperative. Arbitrary SQL and old adapters that do not
  participate are not protected. Do not run those writers alongside a Harness.

This blocks unsafe purges until a supported live-delete lifecycle exists. It is
not multi-process scheduling, authorization, or row-level security.

## Close and resource ownership

Seal admission synchronously when close is called. Drain all already admitted
queries/transactions before closing the connection and ending the owned pool.
New operations reject; repeated close calls share the same result.

An admitted multi-statement storage read can issue later queries while close is
pending. PostgresStorage tracks those reads before invoking database.close().
A database adapter must still drain its admitted single queries and transactions.

PostgresStorage.open consumes its facade and acquires ownership before schema
initialization. Failure closes resources. Do not reuse a consumed facade to open
another storage; create a fresh one. Repeated wrapping of the same pg Pool returns
the same facade so queues/ownership cannot accidentally diverge.

## Tests

Run the upstream storage conformance suite plus adapter-specific tests for
transaction expiry, serialization, snapshot consistency, failure handling,
shutdown, ownership contention and maintenance. Conformance alone does not
exercise a driver's resource and locking lifecycle.
