import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { freshStorage } from "./helpers.js";

describe("batched commit", () => {
	it("stores the batches before a refused one, numbers them in order and skips the rest", async () => {
		const fixture = await freshStorage();
		try {
			const [a, b, c] = [
				await fixture.storage.mintId<ConversationId>(),
				await fixture.storage.mintId<ConversationId>(),
				await fixture.storage.mintId<ConversationId>(),
			];
			const receipts: [number, number][] = [];
			const result = await fixture.storage.commit(
				[
					[{ type: "conversation", value: { id: a } }],
					[{ type: "conversation", value: { id: b } }],
					// Durable's own check: an ID already claimed by another record.
					[{ type: "conversation", value: { id: a } }],
					[{ type: "conversation", value: { id: c } }],
				],
				(index, seq) => receipts.push([index, seq]),
				context,
			);
			expect(result.stored).toBe(2);
			expect(String((result.refused as Error).message)).toContain(`ID ${a} already belongs to conversation`);
			expect(receipts.map(([index]) => index)).toEqual([0, 1]);
			expect(receipts[1]![1]).toBe(receipts[0]![1] + 1);
			await expect(fixture.storage.conversation(b, context)).resolves.toEqual({ id: b });
			await expect(fixture.storage.conversation(c, context)).resolves.toBeUndefined();
		} finally { await fixture.cleanup(); }
	});

	it("rejects the whole call, with no receipt, when the database fails rather than a check", async () => {
		const fixture = await freshStorage();
		try {
			const id = await fixture.storage.mintId<ConversationId>();
			const task = await fixture.storage.mintId<TaskId<null>>();
			const receive = vi.fn();
			await expect(
				fixture.storage.commit(
					[
						[{ type: "conversation", value: { id } }],
						// Not a refusal: the schema's status check fails inside PostgreSQL.
						[{ type: "task", value: {
							id: task, conversationId: id, kind: "k", version: 1, input: null, background: false,
							abortRequested: false, state: { status: "bogus" as "pending", checkpoint: {} },
						} }],
					],
					receive,
					context,
				),
			).rejects.toThrow(/tasks_status_check/);
			expect(receive).not.toHaveBeenCalled();
			await expect(fixture.storage.conversation(id, context)).resolves.toBeUndefined();
		} finally { await fixture.cleanup(); }
	});

	it("stores a sleeping task (Pi Durable 1.4.0 status)", async () => {
		const fixture = await freshStorage();
		try {
			const id = await fixture.storage.mintId<ConversationId>();
			const task = await fixture.storage.mintId<TaskId<null>>();
			const result = await fixture.storage.commit(
				[[
					{ type: "conversation", value: { id } },
					{ type: "task", value: {
						id: task, conversationId: id, kind: "k", version: 1, input: null, background: false,
						abortRequested: false, state: { status: "sleeping", until: 1, checkpoint: {} },
					} },
				]],
				() => undefined,
				context,
			);
			expect(result).toEqual({ stored: 1 });
			expect((await fixture.storage.scanTasks({ status: "sleeping" }, 10, undefined, context)).items.map((t) => t.id)).toEqual([task]);
		} finally { await fixture.cleanup(); }
	});
});
