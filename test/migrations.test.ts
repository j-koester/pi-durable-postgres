import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import type { ConversationId, DocumentId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { applyPostgresMigrations, CURRENT_POSTGRES_SCHEMA_VERSION, POSTGRES_MIGRATIONS } from "../src/migrations.js";
import { freshStorage, testDatabase, touch } from "./helpers.js";

describe("migrations and persistence", () => {
	it("applies migrations idempotently", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			await applyPostgresMigrations(database);
			await applyPostgresMigrations(database);
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: CURRENT_POSTGRES_SCHEMA_VERSION });
		} finally { await fixture.cleanup(); }
	});

	it("rolls back DDL and the version marker when a migration fails", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			await applyPostgresMigrations(database);
			await expect(applyPostgresMigrations(database, [...POSTGRES_MIGRATIONS, {
				version: CURRENT_POSTGRES_SCHEMA_VERSION + 1,
				statements: ["CREATE TABLE migration_probe (value integer)", "SELECT * FROM missing_migration_table"],
			}])).rejects.toThrow();
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: CURRENT_POSTGRES_SCHEMA_VERSION });
			expect(await database.get("SELECT to_regclass('migration_probe') AS relation", [])).toEqual({ relation: null });
			await applyPostgresMigrations(database);
		} finally { await fixture.cleanup(); }
	});

	it("upgrades a version 1 schema so tasks can sleep (Pi Durable 1.4.0)", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			const insert = (id: number) => database.run(
				"INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES ($1, 1, 'k', 'sleeping', false, false, '{}')",
				[id],
			);
			await applyPostgresMigrations(database, POSTGRES_MIGRATIONS.slice(0, 1));
			await expect(insert(2)).rejects.toThrow(/tasks_status_check/);
			await applyPostgresMigrations(database);
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: CURRENT_POSTGRES_SCHEMA_VERSION });
			await expect(insert(2)).resolves.toBe(1);
		} finally { await fixture.cleanup(); }
	});

	it("rejects non-contiguous history and a newer schema without overwriting it", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			await expect(applyPostgresMigrations(database, [{ version: CURRENT_POSTGRES_SCHEMA_VERSION + 1, statements: [] }])).rejects.toThrow(/contiguous/);
			await applyPostgresMigrations(database, [...POSTGRES_MIGRATIONS, { version: CURRENT_POSTGRES_SCHEMA_VERSION + 1, statements: [] }]);
			await expect(fixture.openStorage()).rejects.toThrow(/newer than supported/);
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: CURRENT_POSTGRES_SCHEMA_VERSION + 1 });
			// Failed open must release its ownership lock and connection.
			await database.transaction.maintenance(async () => undefined);
		} finally { await fixture.cleanup(); }
	});

	it("restores records, document history and ID allocation after closing and reopening", async () => {
		const fixture = await freshStorage();
		try {
			const id = await fixture.storage.mintId<ConversationId>();
			const documentId = await fixture.storage.mintId<DocumentId>();
			const seq = await commitWrites(fixture.storage, [
				{ type: "conversation", value: { id } },
				{ type: "document.create", record: {
					id: documentId, kind: "test", scope: { kind: "conversation", conversationId: id }, history: "rewindable", fork: "initial",
				}, content: { kind: "base", version: 1, value: { count: 1 } } },
			], context);
			await commitWrites(fixture.storage, [{ type: "document.change", id: documentId,
				content: { kind: "base", version: 1, value: { count: 2 } } }], context);
			await fixture.storage.close(context);
			const { storage } = await fixture.openStorage();
			expect(await storage.conversation(id, context)).toEqual({ id });
			expect((await storage.document(documentId, seq, context))?.value).toEqual({ count: 1 });
			expect((await storage.document(documentId, "current", context))?.value).toEqual({ count: 2 });
			expect(await storage.mintId()).toBeGreaterThan(documentId);
			expect(await touch(storage)).toBeGreaterThan(seq);
		} finally { await fixture.cleanup(); }
	});
});
