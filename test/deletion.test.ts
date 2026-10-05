import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { deleteConversation } from "../src/delete.js";
import { freshStorage } from "./helpers.ts";

async function countRows(database: Awaited<ReturnType<typeof freshStorage>>["database"], table: string): Promise<number> {
	const row = await database.get<{ readonly count: number }>(`SELECT count(*)::int AS count FROM ${table}`, []);
	return row?.count ?? 0;
}

describe("deleteConversation", () => {
	it("rejects a conversation that has forks, then deletes fork and parent with all owned records", async () => {
		const { storage, database } = await freshStorage();
		try {
			const conversationA = await storage.mintId<number>();
			const entry1 = await storage.mintId<number>();
			const entry2 = await storage.mintId<number>();
			const task1 = await storage.mintId<number>();
			const submission1 = await storage.mintId<number>();
			const documentConversation = await storage.mintId<number>();
			const conversationB = await storage.mintId<number>();
			const entry3 = await storage.mintId<number>();
			const documentTask = await storage.mintId<number>();

			const writes: StorageWrite[] = [
				{ type: "conversation", value: { id: conversationA } },
				{ type: "entry", value: { id: entry1, conversationId: conversationA, kind: "app.test" } },
				{ type: "entry", value: { id: entry2, conversationId: conversationA, kind: "app.test" } },
				{
					type: "task",
					value: {
						id: task1,
						conversationId: conversationA,
						kind: "app.test.task",
						version: 1,
						input: {},
						background: false,
						abortRequested: false,
						state: { status: "pending", checkpoint: {} },
					},
				},
				{
					type: "submission",
					value: { id: submission1, conversationId: conversationA, type: "input", status: "queued" },
				},
				{
					type: "document.create",
					record: {
						id: documentConversation,
						kind: "app.test.doc",
						scope: { kind: "conversation", conversationId: conversationA },
						history: "rewindable",
						fork: "initial",
					},
					content: { version: 1, kind: "base", value: { hello: "world" } },
				},
				{
					type: "conversation",
					value: { id: conversationB, parent: { conversationId: conversationA, at: entry1 } },
				},
				{ type: "entry", value: { id: entry3, conversationId: conversationB, kind: "app.test" } },
				{
					type: "document.create",
					record: {
						id: documentTask,
						kind: "app.test.doc",
						scope: { kind: "task", taskId: task1 },
					},
					content: { version: 1, kind: "base", value: { owned: true } },
				},
			];
			await storage.commit(writes, BACKGROUND_CONTEXT);

			// The parent has an attached fork: rejected by default.
			await expect(deleteConversation(database, conversationA)).rejects.toThrow(/attached conversations/);

			// The childless fork can be deleted alone.
			const forkResult = await deleteConversation(database, conversationB);
			expect(forkResult.conversationIds).toEqual([conversationB]);
			expect(forkResult.deleted.conversations).toBe(1);
			expect(forkResult.deleted.entries).toBe(1);
			expect(forkResult.deleted.documents).toBe(0);

			// Now the parent goes, taking entries, task, submission, and both documents.
			const parentResult = await deleteConversation(database, conversationA);
			expect(parentResult.conversationIds).toEqual([conversationA]);
			expect(parentResult.deleted).toEqual({
				conversations: 1,
				entries: 2,
				tasks: 1,
				submissions: 1,
				documents: 2,
				documentRevisions: 2,
			});

			// Storage reads confirm the removal.
			await expect(storage.conversation(conversationA, BACKGROUND_CONTEXT)).resolves.toBeUndefined();
			await expect(storage.task(task1, BACKGROUND_CONTEXT)).resolves.toBeUndefined();
			await expect(
				storage.scanSubmissions({ conversationId: conversationA }, 10, undefined, BACKGROUND_CONTEXT),
			).resolves.toEqual({ items: [] });
			await expect(
				storage.scanTasks({ conversationId: conversationA }, 10, undefined, BACKGROUND_CONTEXT),
			).resolves.toEqual({ items: [] });
			await expect(
				storage.findDocument(
					{ kind: "app.test.doc", scope: { kind: "conversation", conversationId: conversationA } },
					"current",
					BACKGROUND_CONTEXT,
				),
			).resolves.toBeUndefined();

			// The ID ownership table no longer knows the removed records.
			expect(await countRows(database, "record_ids")).toBe(0);
			expect(await countRows(database, "entries")).toBe(0);
			expect(await countRows(database, "tasks")).toBe(0);
			expect(await countRows(database, "submissions")).toBe(0);
			expect(await countRows(database, "documents")).toBe(0);
			expect(await countRows(database, "document_revisions")).toBe(0);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	});

	it("rejects an unknown conversation", async () => {
		const { storage, database } = await freshStorage();
		try {
			await expect(deleteConversation(database, 999)).rejects.toThrow(/Unknown conversation/);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	});
});
