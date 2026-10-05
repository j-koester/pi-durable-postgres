import pg from "pg";
import type { Pool, PoolClient } from "pg";
import type { PostgresDatabase, PostgresExecutor, PostgresTransaction } from "./database.js";
import { lockMaintenance, STORAGE_LOCK_KEY_SQL } from "./locking.js";
import { PostgresStorage } from "./storage.js";

function parseInt8AsNumber(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`bigint value out of range: ${value}`);
	return parsed;
}

/** Query-local parsing: never mutate pg's global registry or a caller's pool configuration. */
const storageTypes: pg.CustomTypesConfig = {
	getTypeParser: (oid, format) =>
		oid === 20 && format !== "binary" ? parseInt8AsNumber : pg.types.getTypeParser(oid, format),
};

function executorOver(client: PoolClient, assertActive: () => void): PostgresExecutor {
	const query = async (text: string, params: readonly unknown[] = []): Promise<pg.QueryResult> => {
		assertActive();
		return client.query({ text, values: [...params], types: storageTypes });
	};
	return {
		exec: async (sql) => { await query(sql); },
		run: async (sql, params) => (await query(sql, params)).rowCount ?? 0,
		get: async (sql, params) => (await query(sql, params)).rows[0],
		all: async (sql, params) => (await query(sql, params)).rows,
	};
}

type Isolation = "read committed" | "repeatable read";

/**
 * One pinned connection and one FIFO queue per pool. Transactions hold the queue;
 * close seals admission and drains it before ending the pool. Pinning also keeps
 * the storage ownership lock on the same PostgreSQL session as every write.
 */
class PoolDatabase implements PostgresDatabase {
	private client: PoolClient | undefined;
	private tail: Promise<void> = Promise.resolve();
	private closing: Promise<void> | undefined;
	private failure: Error | undefined;
	private ownsStorage = false;

	constructor(private readonly pool: Pool) {}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing !== undefined) return Promise.reject(new Error("PostgresDatabase is closed"));
		const result = this.tail.then(() => {
			this.assertHealthy();
			return operation();
		});
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	private assertHealthy(): void {
		if (this.failure !== undefined) {
			throw new Error("PostgresDatabase connection failed; close and reopen the storage", { cause: this.failure });
		}
	}

	private async connection(): Promise<PoolClient> {
		this.assertHealthy();
		if (this.client === undefined) {
			this.client = await this.pool.connect();
			// A disconnected owner must never reconnect silently and lose its lock.
			this.client.on("error", (error: Error) => { this.failure = error; });
		}
		return this.client;
	}

	acquireOwnership(): Promise<void> {
		return this.enqueue(async () => {
			if (this.ownsStorage) throw new Error("This database already owns an open storage");
			const executor = executorOver(await this.connection(), () => this.assertHealthy());
			const row = await executor.get<{ readonly acquired: boolean | null }>(
				`SELECT pg_try_advisory_lock(${STORAGE_LOCK_KEY_SQL}) AS acquired`,
				[],
			);
			if (row?.acquired !== true) {
				throw new Error("Storage is in use or its schema does not exist; only one owner is supported");
			}
			this.ownsStorage = true;
		});
	}

	private withTransaction<T>(
		isolation: Isolation,
		callback: (transaction: PostgresExecutor) => Promise<T>,
		maintenance = false,
	): Promise<T> {
		return this.enqueue(async () => {
			// Session locks are reentrant, so reject maintenance on the owning facade too.
			if (maintenance && this.ownsStorage) {
				throw new Error("Storage is in use; close the owning Harness before maintenance");
			}
			const client = await this.connection();
			let active = true;
			const executor = executorOver(client, () => {
				this.assertHealthy();
				if (!active) throw new Error("PostgreSQL transaction handle is no longer active");
			});
			try {
				await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
				if (maintenance) await lockMaintenance(executor);
				const result = await callback(executor);
				active = false;
				await client.query("COMMIT");
				return result;
			} catch (error) {
				active = false;
				try {
					await client.query("ROLLBACK");
				} catch (rollbackError) {
					// Do not reuse a connection whose transaction state is uncertain.
					this.failure = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
				}
				throw error;
			} finally {
				active = false;
			}
		});
	}

	readonly transaction: PostgresTransaction = Object.assign(
		<T>(callback: (transaction: PostgresExecutor) => Promise<T>) => this.withTransaction("read committed", callback),
		{
			snapshot: <T>(callback: (transaction: PostgresExecutor) => Promise<T>) =>
				this.withTransaction("repeatable read", callback),
			maintenance: <T>(callback: (transaction: PostgresExecutor) => Promise<T>) =>
				this.withTransaction("read committed", callback, true),
		},
	);

	exec(sql: string): Promise<void> {
		return this.enqueue(async () => executorOver(await this.connection(), () => this.assertHealthy()).exec(sql));
	}

	run(sql: string, params: readonly unknown[]): Promise<number> {
		return this.enqueue(async () => executorOver(await this.connection(), () => this.assertHealthy()).run(sql, params));
	}

	get<T>(sql: string, params: readonly unknown[]): Promise<T | undefined> {
		return this.enqueue(async () => executorOver(await this.connection(), () => this.assertHealthy()).get<T>(sql, params));
	}

	all<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> {
		return this.enqueue(async () => executorOver(await this.connection(), () => this.assertHealthy()).all<T>(sql, params));
	}

	close(): Promise<void> {
		this.closing ??= this.tail.then(async () => {
			try {
				// Await server acknowledgement before a healthy close resolves. Merely
				// destroying the socket races the next owner's try-lock against backend cleanup.
				if (this.client !== undefined && this.ownsStorage && this.failure === undefined) {
					await this.client.query(`SELECT pg_advisory_unlock(${STORAGE_LOCK_KEY_SQL})`);
				}
			} finally {
				// Never return a previously owning session to an application pool.
				this.client?.release(true);
				await this.pool.end();
			}
		});
		return this.closing;
	}
}

export type NodePostgresStorageOptions = {
	/** Existing pool to own exclusively. Do not use or end it outside this adapter. */
	readonly pool?: Pool;
	/** Passed to new Pool; ignored when pool is given. Use a fixed search_path for schema isolation. */
	readonly config?: pg.PoolConfig;
};

const databases = new WeakMap<Pool, PostgresDatabase>();

/**
 * Wrap an exclusively owned pool. Repeated calls for the same pool return the same
 * facade and queue. close() ends the pool. Do not change search_path after wrapping.
 */
export function nodePostgresDatabase(pool: Pool): PostgresDatabase {
	let database = databases.get(pool);
	if (database === undefined) {
		database = new PoolDatabase(pool);
		databases.set(pool, database);
	}
	return database;
}

/**
 * Open storage using pg. Owns the pool and one pinned connection until close().
 * A database/schema advisory lock rejects other owners and unsafe maintenance.
 * Requires a direct connection or session pooling, not transaction pooling.
 */
export async function openNodePostgresStorage(
	options: NodePostgresStorageOptions = {},
): Promise<PostgresStorage> {
	const pool = options.pool ?? new pg.Pool(options.config);
	return PostgresStorage.open(nodePostgresDatabase(pool));
}
