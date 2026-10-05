import pg from "pg";
import type { Pool } from "pg";
import type { PostgresStorage } from "../src/index.js";
import { applyPostgresMigrations } from "../src/migrations.js";
import { nodePostgresDatabase, openNodePostgresStorage } from "../src/node.js";

const connectionString =
	process.env.PI_DURABLE_POSTGRES_TEST_URL ?? "postgres://postgres:postgres@localhost:5433/postgres";

function parseInt8(pool: Pool): void {
	pool.types.setTypeParser(20, (value: string) => {
		const parsed = Number.parseInt(value, 10);
		if (!Number.isSafeInteger(parsed)) throw new Error(`bigint value out of range: ${value}`);
		return parsed;
	});
}

/** Truncate every storage table and reseed the metadata row. */
export async function resetSchema(pool: Pool): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"TRUNCATE document_revisions, documents, submissions, tasks, entries, conversations, record_ids, durable_metadata",
		);
		await client.query("INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, 2, 1)");
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

/**
 * Open a storage over a fresh pool on the shared test database, with a clean schema.
 * The returned storage owns its pool; closing the storage ends it. The `database`
 * facade wraps the same pool for host utilities (deletion) without owning it.
 */
export async function freshStorage(): Promise<{
	storage: PostgresStorage;
	database: ReturnType<typeof nodePostgresDatabase>;
}> {
	const pool = new pg.Pool({ connectionString, max: 2 });
	const database = nodePostgresDatabase(pool);
	// Idempotent: creates the schema on the first run against an empty database.
	await applyPostgresMigrations(database);
	await resetSchema(pool);
	const storage = await openNodePostgresStorage({ pool });
	return { storage, database };
}

export { connectionString };
