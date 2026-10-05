import type { PostgresDatabase, PostgresExecutor } from "./database.js";

export type DeleteConversationOptions = {
	/**
	 * Delete conversations forked from the target (and their subtrees) as well.
	 * When false (default), deleting a conversation that has forks is rejected,
	 * because fork ancestry reads would break.
	 */
	readonly includeForks?: boolean;
};

export type DeleteConversationResult = {
	/** Conversation ids removed, deepest forks first, target last. */
	readonly conversationIds: readonly number[];
	readonly deleted: {
		readonly conversations: number;
		readonly entries: number;
		readonly tasks: number;
		readonly submissions: number;
		readonly documents: number;
		readonly documentRevisions: number;
	};
};

/**
 * Permanently delete one conversation with everything it owns: entries, tasks,
 * submissions, conversation-scoped documents, documents owned by its tasks, and
 * all document revisions. One transaction, all rows or none.
 *
 * Notes:
 * - Attached conversations (forks and subagent conversations created in this
 *   conversation or by its tasks) are separate conversations. By default the
 *   call is rejected when any exist; pass `includeForks: true` to remove the
 *   whole subtree.
 * - Session-scoped documents (scope `session`) are shared across the storage
 *   and are never deleted here.
 * - The global `record_ids` ownership table is cleaned for every removed record.
 */
export async function deleteConversation(
	database: PostgresDatabase,
	conversationId: number,
	options: DeleteConversationOptions = {},
): Promise<DeleteConversationResult> {
	return database.transaction(async (tx) => {
		const conversationIds: number[] = [];
		await collectConversationTree(tx, conversationId, options.includeForks ?? false, conversationIds, new Set());

		const entryIds = await collectIds(tx, "SELECT id FROM entries WHERE conversation_id = ANY($1)", conversationIds);
		const taskIds = await collectIds(tx, "SELECT id FROM tasks WHERE conversation_id = ANY($1)", conversationIds);
		const submissionIds = await collectIds(
			tx,
			"SELECT id FROM submissions WHERE conversation_id = ANY($1)",
			conversationIds,
		);
		const documentIds = (
			await tx.all<{ readonly id: number }>(
				`SELECT id FROM documents WHERE
					(scope_kind = 'conversation' AND owner_id = ANY($1))
					OR (scope_kind = 'task' AND owner_id IN (SELECT id FROM tasks WHERE conversation_id = ANY($1)))
				ORDER BY id`,
				[[...conversationIds]],
			)
		).map((row) => row.id);

		const revisions = documentIds.length
			? await tx.run("DELETE FROM document_revisions WHERE document_id = ANY($1)", [documentIds])
			: 0;
		if (documentIds.length) await tx.run("DELETE FROM documents WHERE id = ANY($1)", [documentIds]);

		const entries = await tx.run("DELETE FROM entries WHERE conversation_id = ANY($1)", [conversationIds]);
		const submissions = await tx.run("DELETE FROM submissions WHERE conversation_id = ANY($1)", [conversationIds]);
		const tasks = await tx.run("DELETE FROM tasks WHERE conversation_id = ANY($1)", [conversationIds]);
		const conversations = await tx.run("DELETE FROM conversations WHERE id = ANY($1)", [conversationIds]);

		const removedRecordIds = [...conversationIds, ...entryIds, ...taskIds, ...submissionIds, ...documentIds];
		await tx.run("DELETE FROM record_ids WHERE id = ANY($1)", [removedRecordIds]);

		return {
			conversationIds,
			deleted: {
				conversations,
				entries,
				tasks,
				submissions,
				documents: documentIds.length,
				documentRevisions: revisions,
			},
		};
	});
}

/**
 * Collect a conversation and, with `includeSubtree`, everything attached below it:
 * forks (via the record's `parent` edge), subagent conversations created in it
 * (owner conversation edge), and conversations created by its tasks (owner task
 * edge). Fork and parent edges live in the record JSON; the columns cover the
 * creator edges.
 */
async function collectConversationTree(
	tx: PostgresExecutor,
	conversationId: number,
	includeSubtree: boolean,
	order: number[],
	seen: Set<number>,
): Promise<void> {
	if (seen.has(conversationId)) throw new Error(`Conversation tree is cyclic at ${conversationId}`);
	seen.add(conversationId);
	const exists = await tx.get<{ readonly id: number }>("SELECT id FROM conversations WHERE id = $1", [
		conversationId,
	]);
	if (exists === undefined) throw new Error(`Unknown conversation: ${conversationId}`);
	const children = await tx.all<{ readonly id: number }>(
		`SELECT id FROM conversations
			WHERE owner_conversation_id = $1
				OR owner_task_id IN (SELECT id FROM tasks WHERE conversation_id = $1)
				OR (record::jsonb -> 'parent' ->> 'conversationId')::bigint = $1
			ORDER BY id`,
		[conversationId],
	);
	for (const child of children) {
		if (!includeSubtree) {
			throw new Error(
				`Conversation ${conversationId} has attached conversations (for example ${child.id}); pass includeForks: true to remove the subtree`,
			);
		}
		await collectConversationTree(tx, child.id, includeSubtree, order, seen);
	}
	order.push(conversationId);
}

async function collectIds(tx: PostgresExecutor, sql: string, conversationIds: readonly number[]): Promise<number[]> {
	const rows = await tx.all<{ readonly id: number }>(sql, [[...conversationIds]]);
	return rows.map((row) => row.id);
}
