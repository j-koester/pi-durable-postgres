import type { PostgresDatabase } from "./database.js";
import { lockMaintenance } from "./locking.js";

export type PostgresMigration = {
	readonly version: number;
	readonly statements: readonly string[];
};

/**
 * Port of the pi-durable SQLite initial schema. Design decisions:
 *
 * - Records are stored as JSON-encoded `text`, parsed client-side. This keeps
 *   byte-level round-trips faithful (no `jsonb` key reordering, no surrogate
 *   normalization). Hosts that need server-side JSON
 *   queries can add an expression index or a generated `jsonb` column later
 *   without changing the storage contract.
 * - Indexed string columns (`kind`, `key_value`, `request_id`) store the
 *   JSON-encoded string, exactly like the SQLite reference, so IDs with lone
 *   surrogates stay lossless and equality semantics match upstream.
 * - All numeric IDs and sequences are BIGINT and are always inside JavaScript's
 *   safe integer range; the facade must return them as numbers.
 */
const INITIAL_SCHEMA: readonly string[] = [
	`CREATE TABLE durable_metadata (
		singleton integer PRIMARY KEY CHECK (singleton = 1),
		next_id bigint NOT NULL,
		next_seq bigint NOT NULL
	)`,
	`INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, 2, 1)`,
	`CREATE TABLE record_ids (
		id bigint PRIMARY KEY,
		record_type text NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	)`,
	`CREATE TABLE conversations (
		id bigint PRIMARY KEY,
		owner_conversation_id bigint,
		owner_task_id bigint,
		record text NOT NULL
	)`,
	"CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id)",
	"CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id)",
	`CREATE TABLE entries (
		id bigint PRIMARY KEY,
		conversation_id bigint NOT NULL,
		head bigint,
		commit_seq bigint NOT NULL,
		record text NOT NULL
	)`,
	"CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC)",
	"CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL",
	`CREATE TABLE tasks (
		id bigint PRIMARY KEY,
		conversation_id bigint NOT NULL,
		kind text NOT NULL,
		status text NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested boolean NOT NULL,
		background boolean NOT NULL,
		record text NOT NULL
	)`,
	"CREATE INDEX tasks_by_status ON tasks (status, id)",
	"CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)",
	"CREATE INDEX tasks_by_kind ON tasks (kind, id)",
	"CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)",
	"CREATE INDEX tasks_by_background ON tasks (background, id)",
	`CREATE TABLE submissions (
		id bigint PRIMARY KEY,
		conversation_id bigint NOT NULL,
		request_id text,
		status text NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record text NOT NULL
	)`,
	"CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)",
	"CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id)",
	"CREATE INDEX submissions_by_status ON submissions (status, id)",
	`CREATE TABLE documents (
		id bigint PRIMARY KEY,
		kind text NOT NULL,
		family smallint NOT NULL CHECK (family IN (0, 1)),
		key_value text NOT NULL,
		scope_kind text NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id bigint NOT NULL,
		created_at bigint NOT NULL,
		retired_at bigint,
		record text NOT NULL
	)`,
	`CREATE INDEX documents_by_address
		ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
	"CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id)",
	"CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id)",
	`CREATE TABLE document_revisions (
		document_id bigint NOT NULL,
		seq bigint NOT NULL,
		kind text NOT NULL CHECK (kind IN ('base', 'delta')),
		version integer NOT NULL,
		content text NOT NULL,
		PRIMARY KEY (document_id, seq)
	)`,
	"CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC)",
];

/** Immutable, ordered schema history. Append new migrations after the initial schema ships. */
export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
	{ version: 1, statements: INITIAL_SCHEMA },
];

export const CURRENT_POSTGRES_SCHEMA_VERSION = POSTGRES_MIGRATIONS.at(-1)?.version ?? 0;

type SchemaRow = { readonly version: number };

/** Apply all pending schema migrations atomically. */
export async function applyPostgresMigrations(
	database: PostgresDatabase,
	migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS,
): Promise<void> {
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1) {
			throw new Error("pi-durable-postgres migrations must have contiguous versions starting at 1");
		}
	}

	await database.transaction(async (transaction) => {
		// Reentrant for the owning storage; excludes migrations from other connections.
		await lockMaintenance(transaction);
		await transaction.exec(`CREATE TABLE IF NOT EXISTS durable_schema (
			singleton integer PRIMARY KEY CHECK (singleton = 1),
			version integer NOT NULL CHECK (version >= 0)
		)`);
		await transaction.run(
			"INSERT INTO durable_schema (singleton, version) VALUES (1, 0) ON CONFLICT (singleton) DO NOTHING",
			[],
		);
		const row = await transaction.get<SchemaRow>("SELECT version FROM durable_schema WHERE singleton = 1", []);
		if (row === undefined) throw new Error("pi-durable-postgres schema metadata is missing");
		const currentVersion = migrations.at(-1)?.version ?? 0;
		if (row.version > currentVersion) {
			throw new Error(
				`pi-durable-postgres schema version ${row.version} is newer than supported version ${currentVersion}`,
			);
		}
		for (const migration of migrations) {
			if (migration.version <= row.version) continue;
			for (const statement of migration.statements) await transaction.exec(statement);
			await transaction.run("UPDATE durable_schema SET version = $1 WHERE singleton = 1", [migration.version]);
		}
	});
}
