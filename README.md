# pi-durable-postgres

A [PostgreSQL](https://www.postgresql.org/) storage backend for
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable),
the durable agent harness behind [Pi](https://earendil.com/posts/pi-durable/).

Validated against the upstream **storage conformance suite**. Includes a
`deleteConversation` utility that closes the biggest gap of the upstream
storages for hosted, GDPR-relevant use: complete, transactional per-conversation
deletion.

## Status

**Alpha — under active development.** The upstream `@earendil-works/pi-durable`
API is explicitly experimental and changes without notice; this package tracks
it and is re-validated with every release.

| `pi-durable-postgres` | validated against `@earendil-works/pi-durable` | storage conformance |
|---|---|---|
| 0.1.x | 1.0.0 – 1.0.2 | ✅ full suite |

## Why

Pi Durable ships memory, SQLite, and JSONL storage. For hosted applications that
already run PostgreSQL, a Postgres backend gives you:

- one backup, operations, and monitoring story (no second data store to secure),
- per-conversation deletion as a scoped `DELETE` (GDPR / right to erasure; the
  upstream storages have no purge API, and SQLite storage forces retention-window
  workarounds),
- SQL observability over live agent state.

The storage interface is small (~15 methods) and explicitly designed for custom
backends; this package implements it with the same semantics as the reference
SQLite core, with a driver-independent facade so `pg`, `postgres.js`, or Bun can
be adapted.

## Usage

```bash
npm install pi-durable-postgres @earendil-works/pi-durable @earendil-works/chord pg
```

```typescript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodePostgresStorage } from "pi-durable-postgres";

const models = createModels();
models.setProvider(anthropicProvider());

const harness = await Harness.open(
  await openNodePostgresStorage({ config: { connectionString: process.env.DATABASE_URL } }),
  { models, registry: createRegistry() },
  BACKGROUND_CONTEXT,
);

const root = await harness.root(BACKGROUND_CONTEXT);
// … conversations persist and resume across restarts, in your Postgres.
```

## Deletion

```typescript
import { nodePostgresDatabase, deleteConversation } from "pi-durable-postgres";
import pg from "pg";

const pool = new pg.Pool({ connectionString });
const database = nodePostgresDatabase(pool);

// Remove one conversation with all entries, tasks, submissions, documents,
// and revisions — one transaction, all rows or none.
await deleteConversation(database, conversationId);

// Or a conversation and everything forked from it.
await deleteConversation(database, conversationId, { includeForks: true });
```

Session-scoped documents are shared across the storage and are never removed by
this utility; hosts that use them should add their own lifecycle. Deleting a
conversation with forks is rejected unless `includeForks: true`, because fork
ancestry reads would otherwise break.

## Design notes

- **Records are stored as JSON-encoded `text`**, parsed client-side — no `jsonb`
  key reordering or Unicode normalization on the round trip. Hosts that need
  server-side JSON queries can add a generated `jsonb` column later without
  touching the storage contract.
- **Indexed string columns** (`kind`, `key_value`, `request_id`) store the
  JSON-encoded string, exactly like the upstream SQLite core, so identifiers
  with lone UTF-16 surrogates stay lossless and equality matches upstream.
- **Snapshot reads**: multi-statement reads that must observe one committed
  state (`document()` materialization) run in a `REPEATABLE READ` transaction,
  mirroring the snapshot behavior the SQLite core gets from its implicit
  transactions. Writes run at the database default.
- **Single owner**: one process owns a database at a time, as upstream requires;
  PostgreSQL does not lift this. Use one long-lived runner process per storage,
  exactly like the SQLite and JSONL backends.
- **bigint discipline**: all IDs and sequences are BIGINT and always inside
  JavaScript's safe integer range; the `pg` adapter installs an int8 parser so
  values arrive as numbers, and rejects out-of-range values.

## Development

```bash
pnpm install
docker compose up -d        # postgres:17 on localhost:5433
pnpm test                   # conformance suite + deletion tests
pnpm lint:types
pnpm build
```

CI runs the same suites on GitHub Actions against a Postgres service container.
The conformance suite is the acceptance gate: every upstream `pi-durable`
release must pass it before this package's compatibility row is updated.

## Contributing

PRs welcome — especially:

- adapters for other drivers (`postgres.js`, Bun `sql`, Cloudflare Hyperdrive)
  behind the same `PostgresDatabase` facade,
- benchmark results against the upstream `bench:storage` suite,
- conformance findings on new `pi-durable` releases.

## License

[MIT](./LICENSE)
