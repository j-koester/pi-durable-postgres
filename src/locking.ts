import type { PostgresExecutor } from "./database.js";

// Advisory locks are database-local. The schema name separates independent stores.
// Keep this namespace stable across releases. All tables must live in current_schema().
export const STORAGE_LOCK_KEY_SQL = "hashtextextended('pi-durable-postgres:' || current_schema(), 0)";

/** Hold the schema lock until the transaction settles; never wait behind an active runner. */
export async function lockMaintenance(transaction: PostgresExecutor): Promise<void> {
	const row = await transaction.get<{ readonly acquired: boolean | null }>(
		`SELECT pg_try_advisory_xact_lock(${STORAGE_LOCK_KEY_SQL}) AS acquired`,
		[],
	);
	if (row?.acquired !== true) {
		throw new Error("Storage is in use or its schema does not exist; close the owning Harness before maintenance");
	}
}
