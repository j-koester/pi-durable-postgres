import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentId, EntryId, StorageWrite, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import type { PostgresDatabase } from "../src/database.js";
import { deleteConversation } from "../src/delete.js";
import type { PostgresStorage } from "../src/storage.js";
import { freshStorage } from "./helpers.js";

const tables = ["conversations", "entries", "tasks", "submissions", "documents", "document_revisions", "record_ids"] as const;
async function counts(database: PostgresDatabase) {
	return Object.fromEntries(await Promise.all(tables.map(async (table) => [
		table, (await database.get<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`, []))!.count,
	])));
}

async function seed(storage: PostgresStorage) {
	const root = await storage.mintId<ConversationId>();
	const task = await storage.mintId<TaskId<null>>();
	const entry = await storage.mintId<EntryId>();
	const submission = await storage.mintId<SubmissionId>();
	const document = await storage.mintId<DocumentId>();
	const taskDocument = await storage.mintId<DocumentId>();
	const child = await storage.mintId<ConversationId>();
	const childEntry = await storage.mintId<EntryId>();
	const writes: StorageWrite[] = [
		{ type: "conversation", value: { id: root } },
		{ type: "entry", value: { id: entry, conversationId: root, kind: "test" } },
		{ type: "task", value: {
			id: task, conversationId: root, kind: "test", version: 1, input: {}, background: false,
			abortRequested: false, state: { status: "pending", checkpoint: {} },
		} },
		{ type: "submission", value: { id: submission, conversationId: root, type: "input", status: "queued" } },
		{ type: "document.create", record: {
			id: document, kind: "test", scope: { kind: "conversation", conversationId: root }, history: "rewindable", fork: "initial",
		}, content: { kind: "base", version: 1, value: { personal: "data" } } },
		{ type: "document.create", record: { id: taskDocument, kind: "test", scope: { kind: "task", taskId: task } },
			content: { kind: "base", version: 1, value: {} } },
		{ type: "conversation", value: { id: child, parent: { conversationId: root, at: entry } } },
		{ type: "entry", value: { id: childEntry, conversationId: child, kind: "test" } },
	];
	await storage.commit(writes, context);
	return { root, task, entry, document, child, childEntry };
}

describe("deleteConversation (exclusive maintenance)", () => {
	it("rejects attached conversations, then removes child and parent with all owned rows", async () => {
		const fixture = await freshStorage();
		try {
			const { root, child, document } = await seed(fixture.storage);
			await fixture.storage.close(context);
			const database = fixture.createDatabase();
			await expect(deleteConversation(database, root)).rejects.toThrow(/attached conversations/);
			const childResult = await deleteConversation(database, child);
			expect(childResult.conversationIds).toEqual([child]);
			expect(childResult.deleted.entries).toBe(1);
			const result = await deleteConversation(database, root);
			expect(result.deleted).toEqual({ conversations: 1, entries: 1, tasks: 1, submissions: 1, documents: 2, documentRevisions: 2 });
			expect(Object.values(await counts(database))).toEqual(tables.map(() => 0));
			const reopened = await fixture.openStorage();
			await expect(reopened.storage.conversation(root, context)).resolves.toBeUndefined();
			await expect(reopened.storage.document(document, "current", context)).resolves.toBeUndefined();
		} finally { await fixture.cleanup(); }
	});

	it("deletes the full graph exactly once when ownership and ancestry overlap", async () => {
		const fixture = await freshStorage();
		try {
			const { root, child, childEntry, task } = await seed(fixture.storage);
			const fork = await fixture.storage.mintId<ConversationId>();
			await fixture.storage.commit([{ type: "conversation", value: {
				id: fork, owner: { conversationId: root, taskId: task }, parent: { conversationId: child, at: childEntry },
			} }], context);
			await fixture.storage.close(context);
			const database = fixture.createDatabase();
			const result = await deleteConversation(database, root, { includeForks: true });
			expect(result.conversationIds).toEqual([fork, child, root]);
			expect(result.deleted.conversations).toBe(3);
			expect(Object.values(await counts(database))).toEqual(tables.map(() => 0));
		} finally { await fixture.cleanup(); }
	});

	it("preserves unrelated conversations and shared session documents", async () => {
		const fixture = await freshStorage();
		try {
			const { root } = await seed(fixture.storage);
			const unrelated = await fixture.storage.mintId<ConversationId>();
			const shared = await fixture.storage.mintId<DocumentId>();
			await fixture.storage.commit([
				{ type: "conversation", value: { id: unrelated } },
				{ type: "document.create", record: { id: shared, kind: "shared", scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { keep: true } } },
			], context);
			await fixture.storage.close(context);
			await deleteConversation(fixture.createDatabase(), root, { includeForks: true });
			const { storage } = await fixture.openStorage();
			await expect(storage.conversation(unrelated, context)).resolves.toEqual({ id: unrelated });
			expect((await storage.document(shared, "current", context))?.value).toEqual({ keep: true });
		} finally { await fixture.cleanup(); }
	});

	it("refuses deletion on both the owning facade and a separate connection while storage is open", async () => {
		const fixture = await freshStorage();
		try {
			const { root } = await seed(fixture.storage);
			const before = await counts(fixture.database);
			for (const database of [fixture.database, fixture.createDatabase()]) {
				await expect(deleteConversation(database, root, { includeForks: true })).rejects.toThrow(/in use/);
			}
			expect(await counts(fixture.database)).toEqual(before);
			await expect(fixture.storage.commit([], context)).resolves.toBeTypeOf("number");
			await fixture.storage.close(context);
			await expect(deleteConversation(fixture.createDatabase(), root, { includeForks: true })).resolves.toBeDefined();
		} finally { await fixture.cleanup(); }
	});

	it("rolls back every deletion when a later statement fails", async () => {
		const fixture = await freshStorage();
		try {
			const { root } = await seed(fixture.storage);
			await fixture.storage.close(context);
			const database = fixture.createDatabase();
			const before = await counts(database);
			const maintenance = database.transaction.maintenance;
			const spy = vi.spyOn(database.transaction, "maintenance").mockImplementation((callback) => maintenance((tx) => callback({
				...tx,
				run: async (sql, params) => {
					if (sql.startsWith("DELETE FROM tasks")) throw new Error("injected deletion failure");
					return tx.run(sql, params);
				},
			})));
			try {
				await expect(deleteConversation(database, root, { includeForks: true })).rejects.toThrow("injected deletion failure");
			} finally { spy.mockRestore(); }
			expect(await counts(database)).toEqual(before);
			await expect(deleteConversation(database, root, { includeForks: true })).resolves.toBeDefined();
		} finally { await fixture.cleanup(); }
	});

	it("rejects a real graph cycle without deleting any rows", async () => {
		const fixture = await freshStorage();
		try {
			const { root, child } = await seed(fixture.storage);
			await fixture.storage.close(context);
			const database = fixture.createDatabase();
			// Deliberately corrupt the creator edge to exercise defensive cycle detection.
			await database.run("UPDATE conversations SET owner_conversation_id = $1 WHERE id = $2", [child, root]);
			const before = await counts(database);
			await expect(deleteConversation(database, root, { includeForks: true })).rejects.toThrow(/cyclic/);
			expect(await counts(database)).toEqual(before);
		} finally { await fixture.cleanup(); }
	});

	it.each(["wait", "owner"] as const)("rejects surviving task %s dependencies", async (edge) => {
		const fixture = await freshStorage();
		try {
			const { root, task } = await seed(fixture.storage);
			const outside = await fixture.storage.mintId<ConversationId>();
			const dependent = await fixture.storage.mintId<TaskId<null>>();
			await fixture.storage.commit([
				{ type: "conversation", value: { id: outside } },
				{ type: "task", value: {
					id: dependent, conversationId: outside, kind: "dependent", version: 1,
					input: { unicode: "\ud800" }, background: false, abortRequested: false,
					...(edge === "owner" ? { owner: task } : {}),
					state: edge === "wait"
						? { status: "waiting", checkpoint: {}, on: [task], policy: "allSettled" }
						: { status: "pending", checkpoint: {} },
				} },
			], context);
			await fixture.storage.close(context);
			const database = fixture.createDatabase();
			const before = await counts(database);
			await expect(deleteConversation(database, root, { includeForks: true })).rejects.toThrow(/Surviving task/);
			expect(await counts(database)).toEqual(before);
		} finally { await fixture.cleanup(); }
	});

	it("rejects unknown and invalid IDs without changing data", async () => {
		const fixture = await freshStorage();
		try {
			await fixture.storage.close(context);
			const database = fixture.createDatabase();
			await expect(deleteConversation(database, 999)).rejects.toThrow(/Unknown conversation/);
			for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
				await expect(deleteConversation(database, id)).rejects.toThrow(/positive safe integer/);
			}
		} finally { await fixture.cleanup(); }
	});
});
