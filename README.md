# @netzlabor/pi-durable-postgres

A PostgreSQL storage backend for
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable).
This is an **SDK library**, not a Pi Coding Agent extension: install it with your
application's package manager, not `pi install`.

- **Source:** [j-koester/pi-durable-postgres](https://github.com/j-koester/pi-durable-postgres)
- **npm package:** `@netzlabor/pi-durable-postgres`
- **Status:** Alpha. Upstream Pi Durable is experimental; its API can change between releases.

## Compatibility

| Package | Pi Durable / Chord | Runtime | Database |
|---|---|---|---|
| 0.1.x | 1.0.2 / 1.0.2 | Node.js >=22.19.0 | PostgreSQL 17 tested |

CI targets Node 22.19.0 and 24. Peer versions are deliberately pinned to the
validated upstream release. Other PostgreSQL versions and drivers are not yet
validated. ESM JavaScript and TypeScript declarations are published; no CommonJS
build is provided.

## Why PostgreSQL?

For applications already operating PostgreSQL, this backend keeps agent state
within their existing database, backup and monitoring infrastructure. It passes
the upstream storage conformance suite and adds a transactional maintenance
helper for deleting a conversation and its dependent records.

**PostgreSQL does not make the Harness multi-writer.** One owner per database/schema
is enforced with an advisory lock. Unrelated schemas may have separate owners.

**Live deletion is not implemented yet.** The current delete helper refuses to run
while a storage owns the schema. Safe live deletion also needs Harness admission,
task, cache and watch coordination that Pi Durable 1.0.2 does not publicly expose.
See the [live-deletion design](docs/live-deletion.md) for the intended integration.

## Quick start

Install the alpha release:

```bash
npm install @netzlabor/pi-durable-postgres @earendil-works/pi-durable@1.0.2 @earendil-works/chord@1.0.2 @earendil-works/pi-ai@1.0.2
export DATABASE_URL='postgres://app:password@localhost:5432/agent_state'
```

```typescript
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodePostgresStorage } from "@netzlabor/pi-durable-postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL");

const storage = await openNodePostgresStorage({ config: { connectionString } });
try {
  const harness = await Harness.open(storage, {
    models: createModels(),
    registry: createRegistry(),
  }, context);
  try {
    const root = await harness.root(context);
    console.log("Persisted conversation:", root.id);
    // Register a model provider and choose an agent model before submitting inputs.
    // harness.resume() resumes interrupted work; opening alone does not start it.
  } finally {
    await harness.close(context);
  }
} finally {
  // Also handles a failed Harness.open(); closing storage twice is safe.
  await storage.close(context);
}
```

This example opens persisted state without a model API key or model request.
See the [upstream quick start](https://github.com/earendil-works/pi/tree/main/packages/durable#quick-start)
for configuring providers and submitting prompts.

## Configuration and operations

`openNodePostgresStorage({ config })` accepts a `pg.PoolConfig`. Alternatively,
`{ pool }` transfers **exclusive ownership** of an existing `pg.Pool`; it takes
precedence over `config`. Do not query, change `search_path`, or end that pool
outside the adapter. Closing storage ends the pool, including on initialization
failure. Supply a separate pool for unrelated application data.

The adapter pins **one connection** and serializes operations. `max: 1` is enough;
a larger pool does not increase storage concurrency. Use a direct PostgreSQL
connection or session pooling. **PgBouncer transaction pooling and reconnecting
proxies are not supported**, because ownership is a session advisory lock. A lost
connection fails closed; stop the Harness and explicitly reopen/recover it rather
than reusing its stale in-memory state.

### Schema isolation

Use a dedicated database or a pre-created, dedicated schema: table names such as
`tasks` and `documents` are not prefixed. For example, provision `CREATE SCHEMA durable`
with the application role as owner, then configure:

```typescript
const storage = await openNodePostgresStorage({ config: {
  connectionString,
  options: "-c search_path=durable",
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
} });
```

Keep every storage table in that schema; do not mix search paths or share the
schema with unrelated application tables. Advisory locks coordinate participating
adapters, **not arbitrary external SQL or older unguarded adapters**. Do not write
storage tables directly while a Harness owns them.

### Migrations, TLS and shutdown

- Opening storage automatically applies pending migrations atomically. Provision
  the database/schema first; the role needs the DDL and DML permissions required
  by these migrations. A newer unknown schema version is rejected, not downgraded.
- Configure TLS through `pg`'s `ssl` options according to the database provider.
  Do not disable certificate verification as a production default.
- Set appropriate connection and statement timeouts. Timeouts are failures, not
  automatic retries: a network failure during COMMIT can have an uncertain outcome.
- On shutdown, stop accepting application requests and await `harness.close(context)`.
  It closes storage after the Harness's admitted work settles. Database close drains
  already admitted operations and rejects new ones.

## Conversation deletion: maintenance only

Close the owning Harness completely and create a **new** pool/facade. Merely
waiting for one conversation to become idle is not enough: cached documents,
watches and task recovery still belong to the open Harness.

```typescript
import pg from "pg";
import { nodePostgresDatabase, deleteConversation } from "@netzlabor/pi-durable-postgres";

// First stop request admission and await harness.close(context).
// Use the SAME database and schema configuration as the closed storage.
const database = nodePostgresDatabase(new pg.Pool({ connectionString }));
try {
  const result = await deleteConversation(database, conversationId, {
    includeForks: true,
  });
  console.log(result.conversationIds, result.deleted);
} finally {
  await database.close();
}
// The application may now open a new Harness.
```

- `conversationId` must be a positive safe integer. Unknown conversations reject;
  the helper is not an idempotent live-deletion job API.
- By default, attached conversations cause rejection. `includeForks: true` includes
  **both forks and task-owned/subagent conversations**, recursively. Shared descendants
  are visited once; actual cycles are rejected. Surviving tasks whose owner or
  waiting dependency would be removed also cause rejection. Resolve those
  dependencies first; application-defined references in payloads remain the host's responsibility.
- Removes entries, tasks, submissions, conversation/task-scoped documents and their
  revisions, and the corresponding `record_ids`. It preserves allocation counters.
- Returns dependency-first `conversationIds` and counts for conversations, entries,
  tasks, submissions, documents and document revisions.
- Session-scoped documents and unrelated conversations remain. Copies of personal
  data elsewhere, application logs, backups/WAL, external services and effects of
  tool calls are outside its scope. This is **not a GDPR-compliance guarantee**.
- Deleting the reserved root does not prevent a future `harness.root()` from creating
  a new root. Hosts must enforce any account deletion or access policy themselves.

## API and design

| Export | Purpose |
|---|---|
| `openNodePostgresStorage(options?)` | Own a pool, claim the schema, migrate and open storage |
| `nodePostgresDatabase(pool)` | Own a pool behind the database facade; repeated wrapping returns the same facade |
| `PostgresStorage.open(database)` | Consume an owned adapter implementing `PostgresDatabase` |
| `applyPostgresMigrations(database, migrations?)` | Apply contiguous versioned migrations; excludes other owners |
| `deleteConversation(database, id, options?)` | Exclusive maintenance purge described above |
| `POSTGRES_MIGRATIONS`, `CURRENT_POSTGRES_SCHEMA_VERSION` | Schema history and current supported version |

The root entry point exposes everything. `/node` exposes the Node adapter;
`/core` omits the `pg` import for custom adapter implementations. Read the
[adapter contract](docs/adapters.md) before implementing another driver.

Records are JSON-encoded `text`; indexed string identities are JSON-encoded too,
so lone UTF-16 surrogates survive round trips. Multi-query document reads use a
`REPEATABLE READ` snapshot. ID/sequence results are parsed as safe JavaScript
integers with **query-local** parsers, never global `pg` mutations. Indexed strings
remain subject to PostgreSQL's B-tree index-entry size limits; do not use large
payloads as document keys, kinds or request IDs.

Public declarations include their `@types/pg` dependency. With `skipLibCheck: false`,
the current upstream `@google/genai` declarations additionally need their optional
`@modelcontextprotocol/sdk` peer (`^1.25.2`), even when Gemini is unused. Our strict
consumer smoke test installs that peer explicitly; it is not a storage dependency.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
docker compose up -d --wait  # PostgreSQL 17, loopback port 5433
pnpm lint:types             # source AND tests
pnpm test                   # upstream conformance + adapter/purge/migration regressions
pnpm test:package           # packs, installs and type-checks a fresh consumer (needs npm network access)
```

Override the test connection with `PI_DURABLE_POSTGRES_TEST_URL`. Each fixture
creates and drops only its own randomly named schema; existing tables are not
truncated. The test role needs schema creation privileges. Still use a disposable
development database, never production. The connection-loss test terminates only
its own fixture connection. Interrupted test processes may leave `durable_test_*`
schemas to remove manually.

`pnpm build` creates `dist`; `npm pack`/`npm publish` runs it automatically via
`prepack` (pnpm must be installed). Source files are included for declaration and
source maps. See [contributing](CONTRIBUTING.md), [release instructions](docs/releasing.md)
and the [changelog](CHANGELOG.md).

## License and attribution

[MIT](LICENSE). The storage core and initial schema are adapted from Pi Durable's
MIT-licensed SQLite implementation (validated against 1.0.2):
[storage](https://github.com/earendil-works/pi/blob/main/packages/durable/src/storage/sqlite/storage.ts)
and [migrations](https://github.com/earendil-works/pi/blob/main/packages/durable/src/storage/sqlite/migrations.ts).
The upstream copyright notice is retained in our license. PostgreSQL-specific
adapter, locking, maintenance and test changes are maintained in this repository.
