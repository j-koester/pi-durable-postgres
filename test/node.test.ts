import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { PostgresExecutor } from "../src/database.js";
import { nodePostgresDatabase } from "../src/node.js";
import { PostgresStorage } from "../src/storage.js";
import { deferred, freshStorage, testDatabase } from "./helpers.js";

describe("node-postgres adapter", () => {
	it("uses query-local bigint parsing without changing global or unrelated pool parsers", async () => {
		const fixture = await testDatabase();
		const other = new pg.Pool(fixture.config);
		try {
			const parser = pg.types.getTypeParser(20);
			const before = (await other.query("SELECT 42::bigint AS n")).rows[0].n;
			const database = fixture.createDatabase();
			expect(await database.get("SELECT 42::bigint AS n", [])).toEqual({ n: 42 });
			expect(pg.types.getTypeParser(20)).toBe(parser);
			expect((await other.query("SELECT 42::bigint AS n")).rows[0].n).toBe(before);
			expect((await other.query("SELECT 9223372036854775807::bigint AS n")).rows[0].n).toBe("9223372036854775807");
			await expect(database.get("SELECT 9223372036854775807::bigint AS n", [])).rejects.toThrow(/out of range/);
			await expect(database.get("SELECT 1::bigint AS n", [])).resolves.toEqual({ n: 1 });
		} finally { await other.end(); await fixture.cleanup(); }
	});

	it("shares the facade and queue when wrapping the same pool twice", async () => {
		const fixture = await testDatabase();
		const pool = new pg.Pool(fixture.config);
		const database = nodePostgresDatabase(pool);
		try {
			expect(nodePostgresDatabase(pool)).toBe(database);
			await expect(database.get("SELECT 1::int AS n", [])).resolves.toEqual({ n: 1 });
		} finally { await database.close(); await fixture.cleanup(); }
	});

	it("serializes outside operations, drains them on close, and rejects new work", async () => {
		const fixture = await testDatabase();
		const gate = deferred();
		try {
			const database = fixture.createDatabase();
			const entered = deferred();
			const order: string[] = [];
			const transaction = database.transaction(async (tx) => {
				await tx.get("SELECT 1::int AS n", []);
				entered.resolve();
				await gate.promise;
				order.push("transaction");
			});
			await entered.promise;
			const read = database.get("SELECT 2::int AS n", []).then((row) => { order.push("read"); return row; });
			const next = database.transaction(async () => { order.push("next transaction"); });
			const close = database.close().then(() => { order.push("close"); });
			await expect(database.exec("SELECT 1")).rejects.toThrow(/closed/);
			await expect(database.transaction(async () => undefined)).rejects.toThrow(/closed/);
			await setImmediate();
			expect(order).toEqual([]);
			gate.resolve();
			await Promise.all([transaction, next, close]);
			await expect(read).resolves.toEqual({ n: 2 });
			expect(order).toEqual(["transaction", "read", "next transaction", "close"]);
			await database.close();
		} finally { gate.resolve(); await fixture.cleanup(); }
	});

	it.each([false, true])("expires transaction handles after callback settlement (rollback=%s)", async (rollback) => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			let escaped: PostgresExecutor | undefined;
			const transaction = database.transaction(async (tx) => {
				escaped = tx;
				if (rollback) throw new Error("rollback requested");
			});
			if (rollback) await expect(transaction).rejects.toThrow("rollback requested");
			else await transaction;
			await expect(escaped!.exec("SELECT 1")).rejects.toThrow(/no longer active/);
			await expect(escaped!.run("SELECT 1", [])).rejects.toThrow(/no longer active/);
			await expect(escaped!.get("SELECT 1", [])).rejects.toThrow(/no longer active/);
			await expect(escaped!.all("SELECT 1", [])).rejects.toThrow(/no longer active/);
			await expect(database.get("SELECT 1::int AS n", [])).resolves.toEqual({ n: 1 });
		} finally { await fixture.cleanup(); }
	});

	it("rolls back failed transactions and remains usable", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			await database.exec("CREATE TABLE probe (value integer)");
			await expect(database.transaction(async (tx) => {
				await tx.run("INSERT INTO probe VALUES ($1)", [1]);
				throw new Error("stop");
			})).rejects.toThrow("stop");
			await expect(database.all("SELECT * FROM probe", [])).resolves.toEqual([]);
			await database.run("INSERT INTO probe VALUES ($1)", [2]);
			await expect(database.all("SELECT * FROM probe", [])).resolves.toEqual([{ value: 2 }]);
		} finally { await fixture.cleanup(); }
	});

	it("keeps a repeatable-read snapshot across an external commit", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			const other = fixture.createDatabase();
			await database.exec("CREATE TABLE probe (value integer)");
			await database.run("INSERT INTO probe VALUES ($1)", [1]);
			await database.transaction.snapshot(async (tx) => {
				expect(await tx.get("SELECT * FROM probe", [])).toEqual({ value: 1 });
				await other.run("UPDATE probe SET value = $1", [2]);
				expect(await tx.get("SELECT * FROM probe", [])).toEqual({ value: 1 });
			});
			expect(await database.get("SELECT * FROM probe", [])).toEqual({ value: 2 });
		} finally { await fixture.cleanup(); }
	});

	it("settles a storage read queued behind a commit before shutdown completes", async () => {
		const fixture = await freshStorage();
		try {
			const id = await fixture.storage.mintId<ConversationId>();
			const commit = fixture.storage.commit([{ type: "conversation", value: { id } }], context);
			const read = fixture.storage.conversation(id, context);
			const close = fixture.storage.close(context);
			await Promise.all([commit, close]);
			await expect(read).resolves.toEqual({ id });
			await expect(fixture.storage.conversation(id, context)).rejects.toThrow(/closed/);
		} finally { await fixture.cleanup(); }
	});

	it("rejects a second owner without closing the first and releases ownership on close", async () => {
		const fixture = await freshStorage();
		try {
			await expect(PostgresStorage.open(fixture.database)).rejects.toThrow(/already been opened/);
			await expect(fixture.openStorage()).rejects.toThrow(/in use/);
			await expect(fixture.storage.commit([], context)).resolves.toBeTypeOf("number");
			await fixture.storage.close(context);
			// A successful close must acknowledge unlock, not just enqueue socket destruction.
			for (let attempt = 0; attempt < 8; attempt++) {
				const { storage } = await fixture.openStorage();
				await expect(storage.commit([], context)).resolves.toBeTypeOf("number");
				await storage.close(context);
			}
		} finally { await fixture.cleanup(); }
	});

	it("allows separate schemas to have independent owners", async () => {
		const first = await freshStorage();
		try {
			const second = await freshStorage();
			try {
				await expect(first.storage.commit([], context)).resolves.toBeTypeOf("number");
				await expect(second.storage.commit([], context)).resolves.toBeTypeOf("number");
			} finally { await second.cleanup(); }
		} finally { await first.cleanup(); }
	});

	it("rejects opening a storage during maintenance", async () => {
		const fixture = await testDatabase();
		const gate = deferred();
		try {
			const entered = deferred();
			const maintenance = fixture.createDatabase().transaction.maintenance(async () => {
				entered.resolve();
				await gate.promise;
			});
			await entered.promise;
			await expect(fixture.openStorage()).rejects.toThrow(/in use/);
			gate.resolve();
			await maintenance;
			await expect(fixture.openStorage()).resolves.toBeDefined();
		} finally { gate.resolve(); await fixture.cleanup(); }
	});

	it("fails closed after losing its pinned connection instead of silently reconnecting", async () => {
		const fixture = await freshStorage();
		try {
			const pid = (await fixture.database.get<{ pid: number }>("SELECT pg_backend_pid() AS pid", []))!.pid;
			await fixture.createDatabase().get("SELECT pg_terminate_backend($1)", [pid]);
			await expect(fixture.database.get("SELECT 1", [])).rejects.toThrow();
			await expect(fixture.database.get("SELECT 1", [])).rejects.toThrow();
		} finally { await fixture.cleanup(); }
	});
});
