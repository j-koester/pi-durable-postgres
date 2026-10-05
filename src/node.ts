import pg from "pg";
import type { Pool } from "pg";
import type { PostgresDatabase, PostgresExecutor, PostgresTransaction } from "./database.js";
import { PostgresStorage } from "./storage.js";

/**
 * `pg` returns int8 (bigint) as strings by default; the storage needs numbers.
 * Installs the parser process-wide (node-postgres has one global type registry).
 */
function parseInt8AsNumber(): void {
	pg.types.setTypeParser(20, (value: string) => {
		const parsed = Number.parseInt(value, 10);
		if (!Number.isSafeInteger(parsed)) throw new Error(`bigint value out of range: ${value}`);
		return parsed;
	});
}

/** Pool and PoolClient share this call surface. */
type Queryable = {
	query(text: string, values?: readonly unknown[]): Promise<pg.QueryResult>;
};

const executorOver =
	(queryable: Queryable): PostgresExecutor => ({
		exec: async (sql) => {
			await queryable.query(sql);
		},
		run: async (sql, params) => {
			const result = await queryable.query(sql, [...params]);
			return result.rowCount ?? 0;
		},
		get: async (sql, params) => {
			const result = await queryable.query(sql, [...params]);
			return result.rows[0];
		},
		all: async (sql, params) => {
			const result = await queryable.query(sql, [...params]);
			return result.rows;
		},
	});

type Isolation = "read committed" | "repeatable read";

class PoolDatabase implements PostgresDatabase {
	private readonly pool: Pool;
	private readonly poolExecutor: PostgresExecutor;

	constructor(pool: Pool) {
		this.pool = pool;
		this.poolExecutor = executorOver(pool);
	}

	private async withTransaction<T>(
		isolation: Isolation,
		callback: (transaction: PostgresExecutor) => Promise<T>,
	): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
			const result = await callback(executorOver(client));
			await client.query("COMMIT");
			return result;
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// Preserve the original failure.
			}
			throw error;
		} finally {
			client.release();
		}
	}

	readonly transaction: PostgresTransaction = Object.assign(
		<T>(callback: (transaction: PostgresExecutor) => Promise<T>) => this.withTransaction("read committed", callback),
		{
			snapshot: <T>(callback: (transaction: PostgresExecutor) => Promise<T>) =>
				this.withTransaction("repeatable read", callback),
		},
	);

	exec(sql: string): Promise<void> {
		return this.poolExecutor.exec(sql);
	}

	run(sql: string, params: readonly unknown[]): Promise<number> {
		return this.poolExecutor.run(sql, params);
	}

	get<T>(sql: string, params: readonly unknown[]): Promise<T | undefined> {
		return this.poolExecutor.get<T>(sql, params);
	}

	all<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> {
		return this.poolExecutor.all<T>(sql, params);
	}

	close(): Promise<void> {
		return this.pool.end().then(() => undefined);
	}
}

export type NodePostgresStorageOptions = {
	/** Existing `pg` pool to own. When omitted, one is created from `config`. */
	readonly pool?: Pool;
	/** `pg` connection configuration passed to `new Pool(...)`; ignored when `pool` is given. */
	readonly config?: pg.PoolConfig;
};

/** Wrap a `pg` pool in the database facade used by storage and utilities. */
export function nodePostgresDatabase(pool: Pool): PostgresDatabase {
	parseInt8AsNumber();
	return new PoolDatabase(pool);
}

/**
 * Open a pi-durable storage over a PostgreSQL database using `pg`.
 * The returned storage owns the pool; `close()` ends it.
 *
 * One process owns a database at a time; there is no cross-process locking.
 */
export async function openNodePostgresStorage(
	options: NodePostgresStorageOptions = {},
): Promise<PostgresStorage> {
	const pool = options.pool ?? new pg.Pool(options.config);
	const database = nodePostgresDatabase(pool);
	return PostgresStorage.open(database);
}
