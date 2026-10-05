/**
 * Promise-based PostgreSQL facade for the portable pi-durable Postgres storage.
 *
 * The contract mirrors the portable SQLite core of `@earendil-works/pi-durable`
 * (`/storage/sqlite`): promise-based `exec`, `run`, `get`, `all`, `transaction`,
 * `close`. A transaction callback receives a transaction executor; all work in
 * the transaction must use it, and the handle expires when the callback settles.
 * Adapters must queue unrelated operations until the transaction finishes. Do not
 * call the outer facade from inside a transaction callback: that would deadlock.
 *
 * Implementations MUST return PostgreSQL `bigint` (int8) columns as JavaScript
 * numbers, not strings, without changing other database clients' parsers.
 * All IDs and sequence numbers in the durable storage are safe
 * integers and use BIGINT columns.
 *
 * Placeholders are positional: `$1`, `$2`, … with the parameters passed as one
 * array. `exec` takes no parameters and runs exactly one statement.
 *
 * `run` returns the number of affected rows when the driver provides it; the
 * portable storage ignores the count, but utilities (deletion) rely on it.
 */
export interface PostgresExecutor {
	/** Run exactly one statement without parameters. */
	exec(sql: string): Promise<void>;
	/** Run one statement with positional parameters; resolves with the affected row count. */
	run(sql: string, params: readonly unknown[]): Promise<number>;
	/** Run one query and return the first row, or undefined when there is none. */
	get<T>(sql: string, params: readonly unknown[]): Promise<T | undefined>;
	/** Run one query and return all rows. */
	all<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]>;
}

/** Callable transaction entry point with a stable-snapshot variant for multi-statement reads. */
export interface PostgresTransaction {
	/** Begin at the default isolation level (read committed); use for writes and general work. */
	<T>(callback: (transaction: PostgresExecutor) => Promise<T>): Promise<T>;
	/** Begin with a stable snapshot (repeatable read); use for multi-statement reads that must observe one committed state. */
	snapshot<T>(callback: (transaction: PostgresExecutor) => Promise<T>): Promise<T>;
	/**
	 * Exclusive maintenance transaction. Reject while any storage owns this schema,
	 * including a storage opened on this facade. Hold the same advisory lock used
	 * by acquireOwnership until commit/rollback. See docs/adapters.md.
	 */
	maintenance<T>(callback: (transaction: PostgresExecutor) => Promise<T>): Promise<T>;
}

export interface PostgresDatabase extends PostgresExecutor {
	transaction: PostgresTransaction;
	/** Exclusively claim the database/schema until close; fail fast if already owned. */
	acquireOwnership(): Promise<void>;
	/** Seal admission, drain admitted operations, release ownership and resources. Idempotent. */
	close(): Promise<void>;
}
