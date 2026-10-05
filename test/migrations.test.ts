import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { applyPostgresMigrations, POSTGRES_MIGRATIONS } from "../src/migrations.js";
import { freshStorage, testDatabase } from "./helpers.js";

describe("migrations and persistence", () => {
	it("applies migrations idempotently", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			await applyPostgresMigrations(database);
			await applyPostgresMigrations(database);
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: 1 });
		} finally { await fixture.cleanup(); }
	});

	it("rolls back DDL and the version marker when a migration fails", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			await applyPostgresMigrations(database);
			await expect(applyPostgresMigrations(database, [...POSTGRES_MIGRATIONS, {
				version: 2, statements: ["CREATE TABLE migration_probe (value integer)", "SELECT * FROM missing_migration_table"],
			}])).rejects.toThrow();
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: 1 });
			expect(await database.get("SELECT to_regclass('migration_probe') AS relation", [])).toEqual({ relation: null });
			await applyPostgresMigrations(database);
		} finally { await fixture.cleanup(); }
	});

	it("rejects non-contiguous history and a newer schema without overwriting it", async () => {
		const fixture = await testDatabase();
		try {
			const database = fixture.createDatabase();
			await expect(applyPostgresMigrations(database, [{ version: 2, statements: [] }])).rejects.toThrow(/contiguous/);
			await applyPostgresMigrations(database, [...POSTGRES_MIGRATIONS, { version: 2, statements: [] }]);
			await expect(fixture.openStorage()).rejects.toThrow(/newer than supported/);
			expect(await database.get("SELECT version FROM durable_schema", [])).toEqual({ version: 2 });
			// Failed open must release its ownership lock and connection.
			await database.transaction.maintenance(async () => undefined);
		} finally { await fixture.cleanup(); }
	});

	it("restores records, document history and ID allocation after closing and reopening", async () => {
		const fixture = await freshStorage();
		try {
			const id = await fixture.storage.mintId<ConversationId>();
			const documentId = await fixture.storage.mintId<DocumentId>();
			const seq = await fixture.storage.commit([
				{ type: "conversation", value: { id } },
				{ type: "document.create", record: {
					id: documentId, kind: "test", scope: { kind: "conversation", conversationId: id }, history: "rewindable", fork: "initial",
				}, content: { kind: "base", version: 1, value: { count: 1 } } },
			], context);
			await fixture.storage.commit([{ type: "document.change", id: documentId,
				content: { kind: "base", version: 1, value: { count: 2 } } }], context);
			await fixture.storage.close(context);
			const { storage } = await fixture.openStorage();
			expect(await storage.conversation(id, context)).toEqual({ id });
			expect((await storage.document(documentId, seq, context))?.value).toEqual({ count: 1 });
			expect((await storage.document(documentId, "current", context))?.value).toEqual({ count: 2 });
			expect(await storage.mintId()).toBeGreaterThan(documentId);
			expect(await storage.commit([], context)).toBeGreaterThan(seq);
		} finally { await fixture.cleanup(); }
	});
});
