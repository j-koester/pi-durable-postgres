import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { deferred, freshStorage, touch } from "./helpers.js";

describe("single-owner advisory lock", () => {
	it("blocks a second owner on another connection until the first closes", async () => {
		const fixture = await freshStorage();
		try {
			await expect(fixture.openStorage()).rejects.toThrow(/only one owner is supported|in use/);
			// The refused owner must not have touched the first owner's data or lock.
			await expect(touch(fixture.storage)).resolves.toBeTypeOf("number");
			await expect(fixture.openStorage()).rejects.toThrow(/in use/);
			await fixture.storage.close(context);
			const second = await fixture.openStorage();
			await expect(touch(second.storage)).resolves.toBeTypeOf("number");
		} finally { await fixture.cleanup(); }
	});

	it("fails closed when the owner's connection is killed with pg_terminate_backend", async () => {
		const fixture = await freshStorage();
		try {
			const kept = await fixture.storage.mintId<ConversationId>();
			await expect(
				fixture.storage.commit([[{ type: "conversation", value: { id: kept } }]], () => undefined, context),
			).resolves.toEqual({ stored: 1 });
			const pid = (await fixture.database.get<{ pid: number }>("SELECT pg_backend_pid() AS pid", []))!.pid;
			const killer = fixture.createDatabase();
			await expect(killer.get<{ terminated: boolean }>("SELECT pg_terminate_backend($1) AS terminated", [pid]))
				.resolves.toEqual({ terminated: true });

			// Every later call rejects, so the Harness fails its Session; nothing reconnects or reports a receipt.
			const lost = await fixture.storage.mintId<ConversationId>();
			const receive = vi.fn();
			await expect(fixture.storage.commit([[{ type: "conversation", value: { id: lost } }]], receive, context)).rejects.toThrow();
			expect(receive).not.toHaveBeenCalled();
			await expect(fixture.storage.conversation(kept, context)).rejects.toThrow();
			await expect(fixture.storage.commit([[{ type: "conversation", value: { id: lost } }]], receive, context)).rejects.toThrow(/connection/i);
			expect(receive).not.toHaveBeenCalled();

			// The server released the dead session's lock, so a new owner takes over and sees only what was durable.
			const second = await fixture.openStorage();
			await expect(second.storage.conversation(kept, context)).resolves.toEqual({ id: kept });
			await expect(second.storage.conversation(lost, context)).resolves.toBeUndefined();
			// The fenced-off first owner still cannot write next to the new owner.
			await expect(touch(fixture.storage)).rejects.toThrow();
			await expect(touch(second.storage)).resolves.toBeTypeOf("number");
		} finally { await fixture.cleanup(); }
	});

	it("rejects a commit whose connection is killed while it waits on a lock, storing nothing", async () => {
		const fixture = await freshStorage();
		const release = deferred();
		try {
			const pid = (await fixture.database.get<{ pid: number }>("SELECT pg_backend_pid() AS pid", []))!.pid;
			const blocker = fixture.createDatabase();
			const killer = fixture.createDatabase();
			const held = deferred();
			// Another session holds the metadata row, so the owner's commit blocks on its final UPDATE.
			const holding = blocker.transaction(async (transaction) => {
				await transaction.get("SELECT next_seq FROM durable_metadata WHERE singleton = 1 FOR UPDATE", []);
				held.resolve();
				await release.promise;
			});
			await held.promise;
			const id = await fixture.storage.mintId<ConversationId>();
			const receive = vi.fn();
			const commit = fixture.storage.commit([[{ type: "conversation", value: { id } }]], receive, context);
			const settled = commit.then(() => "stored", () => "rejected");
			await vi.waitFor(async () => {
				const row = await killer.get<{ waiting: boolean }>(
					"SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
					[pid],
				);
				expect(row?.waiting).toBe(true);
			});
			await killer.get("SELECT pg_terminate_backend($1)", [pid]);
			await expect(settled).resolves.toBe("rejected");
			expect(receive).not.toHaveBeenCalled();
			release.resolve();
			await holding;
			const second = await fixture.openStorage();
			await expect(second.storage.conversation(id, context)).resolves.toBeUndefined();
		} finally { release.resolve(); await fixture.cleanup(); }
	});
});
