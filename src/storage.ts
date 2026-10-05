import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import { StorageRejected, type Storage } from "@earendil-works/pi-durable";
import type {
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
	Page,
	Seq,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "@earendil-works/pi-durable";
import type { PostgresDatabase, PostgresExecutor } from "./database.js";
import { applyPostgresMigrations } from "./migrations.js";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type RecordIdRow = { readonly record_type: TableName };
type JsonRow = { readonly record: string };
type EntryJsonRow = { readonly record: string; readonly commit_seq: number };
type RevisionRow = {
	readonly seq: number;
	readonly kind: DocumentContent["kind"];
	readonly version: number;
	readonly content: string;
};
type IdRow = { readonly id: number };
type MetadataRow = { readonly next_id: number; readonly next_seq: number };
type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
	content?: DocumentContent;
	retire: boolean;
};
type ScopeColumns = {
	readonly scopeKind: DocumentRecord["scope"]["kind"];
	readonly ownerId: number;
};

/** Apply an erased ID brand at a trusted numeric allocation or decoding boundary. */
const idFromNumber = <I extends Id<string>>(value: number): I => value as I;

/** Apply the erased commit-sequence brand at a trusted storage boundary. */
const seqFromNumber = (value: number): Seq => value as Seq;

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value) as string;
// Indexed identities are stored JSON-encoded so lone UTF-16 surrogates stay lossless.
const encodeIndexedString = (value: string): string => JSON.stringify(value);

const cursorId = <I extends Id<string>>(cursor: Cursor | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
	return idFromNumber<I>(after);
};

const page = <T extends { readonly id: Id<string> }>(values: readonly T[], limit: number): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	if (values.length <= limit) return { items };
	return { items, next: { after: items.at(-1)!.id } };
};

const scopeColumns = (scope: DocumentRecord["scope"]): ScopeColumns => {
	switch (scope.kind) {
		case "session":
			return { scopeKind: "session", ownerId: 0 };
		case "conversation":
			return { scopeKind: "conversation", ownerId: scope.conversationId };
		case "task":
			return { scopeKind: "task", ownerId: scope.taskId };
	}
};

const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => {
	const scope = scopeColumns(address.scope);
	return {
		kind: encodeIndexedString(address.kind),
		...scope,
		family: address.key === undefined ? 0 : 1,
		keyValue: encodeIndexedString(address.key ?? ""),
	};
};

const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
	const parts = addressParts(address);
	return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

const writeId = (write: StorageWrite): Id<string> | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id;
		case "document.create":
		case "document.copy":
			return write.record.id;
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

/** PostgreSQL implementation of the durable storage contract. */
export class PostgresStorage implements Storage {
	private readonly db: PostgresDatabase;
	private nextId: number;
	private closed = false;
	private closing: Promise<void> | undefined;
	private admittedReads = 0;
	private readsDrained: (() => void) | undefined;

	private constructor(db: PostgresDatabase, nextId: number) {
		this.db = db;
		this.nextId = nextId;
	}

	/** Initialize storage over an owned PostgreSQL database facade. */
	static async open(db: PostgresDatabase): Promise<PostgresStorage> {
		try {
			await applyPostgresMigrations(db);
			const metadata = await db.get<MetadataRow>(
				"SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1",
				[],
			);
			if (metadata === undefined) throw new Error("pi-durable-postgres metadata is missing");
			return new PostgresStorage(db, metadata.next_id);
		} catch (error) {
			try {
				await db.close();
			} catch {
				// Preserve the initialization failure.
			}
			throw error;
		}
	}

	async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		this.assertOpen();
		const documentActions = this.prepareDocumentActions(writes);
		const candidateNextId = this.candidateNextId(writes);
		const seq = await this.db.transaction(async (transaction) => {
			const metadata = await transaction.get<MetadataRow>(
				"SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1",
				[],
			);
			if (metadata === undefined) throw new Error("pi-durable-postgres metadata is missing");
			const committedSeq = seqFromNumber(metadata.next_seq);
			await this.checkGlobalIds(transaction, writes);
			await this.checkDocumentActions(transaction, documentActions);
			for (const write of writes) await this.applyTableWrite(transaction, write, committedSeq);
			await this.applyDocumentActions(transaction, documentActions, committedSeq);
			await transaction.run(
				"UPDATE durable_metadata SET next_id = $1, next_seq = $2 WHERE singleton = 1",
				[Math.max(metadata.next_id, candidateNextId), committedSeq + 1],
			);
			return committedSeq;
		});
		this.nextId = Math.max(this.nextId, candidateNextId);
		return seq;
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return idFromNumber<I>(this.nextId++);
	}

	async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>("SELECT record FROM conversations WHERE id = $1", [id]);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		this.assertOpen();
		const clauses = ["id > $1"];
		const params: unknown[] = [cursorId(cursor) ?? -1];
		if (query.ownerConversationId !== undefined) {
			clauses.push("owner_conversation_id = $" + (params.push(query.ownerConversationId)));
		}
		if (query.ownerTaskId !== undefined) {
			clauses.push("owner_task_id = $" + (params.push(query.ownerTaskId)));
		}
		const limitIndex = params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM conversations WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${limitIndex}`,
			params,
		);
		return page(
			rows.map((row) => parseJson<ConversationRecord>(row.record)),
			limit,
		);
	}

	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		return this.admitRead(() => this.readEntry(idOrConversationId, idOrContext, context));
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.admitRead(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId));
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.admitRead(() => this.readEntries(query, limit, cursor));
	}

	private async readEntry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		const id =
			context === undefined
				? idFromNumber<EntryId>(idOrConversationId)
				: typeof idOrContext === "number"
					? idFromNumber<EntryId>(idOrContext)
					: undefined;
		if (id === undefined) throw new TypeError("Storage.entry() requires an entry ID");
		let conversation: ConversationRecord | undefined;
		if (context !== undefined) {
			const conversationId = idFromNumber<ConversationId>(idOrConversationId);
			conversation = await this.readConversation(conversationId);
			if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`);
		}
		const row = await this.db.get<EntryJsonRow>(
			"SELECT record, commit_seq FROM entries WHERE id = $1",
			[id],
		);
		if (row === undefined) return undefined;
		const entry = parseJson<EntryRecord>(row.record);
		if (conversation !== undefined) {
			let upperEntryId = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at);
				conversation = (await this.readConversation(conversation.parent.conversationId))!;
			}
			if (entry.id > upperEntryId) return undefined;
		}
		return { entry, commitSeq: seqFromNumber(row.commit_seq) };
	}

	private async readLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		let conversation = await this.readConversation(conversationId);
		if (conversation === undefined) throw new Error(`Unknown conversation: ${conversationId}`);
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			const row =
				upper === undefined
					? await this.db.get<JsonRow>(
							"SELECT record FROM entries WHERE conversation_id = $1 AND head IS NOT NULL ORDER BY id DESC LIMIT 1",
							[conversation.id],
						)
					: await this.db.get<JsonRow>(
							"SELECT record FROM entries WHERE conversation_id = $1 AND head IS NOT NULL AND id <= $2 ORDER BY id DESC LIMIT 1",
							[conversation.id, upper],
						);
			if (row !== undefined) return parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
	}

	private async readEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new Error(`Unknown conversation: ${query.conversationId}`);
		const after = cursorId(cursor);
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		const values: EntryRecord[] = [];
		while (true) {
			const clauses = ["conversation_id = $1"];
			const params: unknown[] = [conversation.id];
			if (query.minEntryId !== undefined) {
				clauses.push(`id >= $${params.push(query.minEntryId)}`);
			}
			if (upper !== undefined) {
				clauses.push(`id <= $${params.push(upper)}`);
			}
			const limitIndex = params.push(limit + 1 - values.length);
			const rows = await this.db.all<JsonRow>(
				`SELECT record FROM entries WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT $${limitIndex}`,
				params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = (await this.readConversation(conversation.parent.conversationId))!;
		}
		return page(values, limit);
	}

	async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>("SELECT record FROM tasks WHERE id = $1", [id]);
		return row === undefined ? undefined : parseJson<StoredTask>(row.record);
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		this.assertOpen();
		const clauses = ["id > $1"];
		const params: unknown[] = [cursorId(cursor) ?? -1];
		if (query.conversationId !== undefined) {
			clauses.push(`conversation_id = $${params.push(query.conversationId)}`);
		}
		if (query.kind !== undefined) {
			clauses.push(`kind = $${params.push(encodeIndexedString(query.kind))}`);
		}
		if (query.status !== undefined) {
			clauses.push(`status = $${params.push(query.status)}`);
		}
		if (query.abortRequested !== undefined) {
			clauses.push(`abort_requested = $${params.push(query.abortRequested)}`);
		}
		if (query.background !== undefined) {
			clauses.push(`background = $${params.push(query.background)}`);
		}
		const limitIndex = params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${limitIndex}`,
			params,
		);
		return page(
			rows.map((row) => parseJson<StoredTask>(row.record)),
			limit,
		);
	}

	async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>("SELECT record FROM submissions WHERE id = $1", [id]);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		this.assertOpen();
		const clauses = ["id > $1"];
		const params: unknown[] = [cursorId(cursor) ?? -1];
		if (query.conversationId !== undefined) {
			clauses.push(`conversation_id = $${params.push(query.conversationId)}`);
		}
		if (query.status !== undefined) {
			clauses.push(`status = $${params.push(query.status)}`);
		}
		const limitIndex = params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM submissions WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${limitIndex}`,
			params,
		);
		return page(
			rows.map((row) => parseJson<SubmissionRecord>(row.record)),
			limit,
		);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		this.assertOpen();
		const row = await this.db.get<JsonRow>(
			"SELECT record FROM submissions WHERE conversation_id = $1 AND request_id = $2",
			[conversationId, encodeIndexedString(requestId)],
		);
		return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
	}

	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		_context: Context,
	): Promise<DocumentRecord | undefined> {
		this.assertOpen();
		const parts = addressParts(address);
		if (at === "current") {
			const row = await this.db.get<JsonRow>(
				`SELECT record FROM documents
					WHERE kind = $1 AND scope_kind = $2 AND owner_id = $3 AND family = $4 AND key_value = $5
					AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`,
				[parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue],
			);
			return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
		}
		const row = await this.db.get<JsonRow>(
			`SELECT record FROM documents
				WHERE kind = $1 AND scope_kind = $2 AND owner_id = $3 AND family = $4 AND key_value = $5
				AND created_at <= $6 AND (retired_at IS NULL OR retired_at > $7)
				ORDER BY created_at DESC LIMIT 1`,
			[parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue, at, at],
		);
		return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
	}

	async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		this.assertOpen();
		// The record and revision queries must observe one committed state; a commit between them can replace the base.
		// The snapshot transaction gives both reads one stable state.
		return this.admitRead(() => this.db.transaction.snapshot((transaction) => this.materializeDocument(transaction, id, at)));
	}

	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		this.assertOpen();
		const scope = scopeColumns(query.scope);
		const clauses = ["scope_kind = $1", "owner_id = $2", "id > $3"];
		const params: unknown[] = [scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
		if (query.kind !== undefined) {
			clauses.push(`kind = $${params.push(encodeIndexedString(query.kind))}`);
		}
		if (query.at === "current") {
			clauses.push("retired_at IS NULL");
		} else {
			clauses.push(`created_at <= $${params.push(query.at)}`, `(retired_at IS NULL OR retired_at > $${params.push(query.at)})`);
		}
		const limitIndex = params.push(limit + 1);
		const rows = await this.db.all<JsonRow>(
			`SELECT record FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${limitIndex}`,
			params,
		);
		return page(
			rows.map((row) => parseJson<DocumentRecord>(row.record)),
			limit,
		);
	}

	close(_context: Context): Promise<void> {
		if (this.closing === undefined) {
			this.closed = true;
			this.closing = this.closeDatabase();
		}
		return this.closing;
	}

	private async closeDatabase(): Promise<void> {
		if (this.admittedReads > 0) {
			await new Promise<void>((resolve) => {
				this.readsDrained = resolve;
			});
		}
		await this.db.close();
	}

	/**
	 * Run a read that issues several queries. Close waits for admitted reads, so their later queries never reach a
	 * closed database. Single-query reads and transactions are already ordered before close by the database.
	 */
	private async admitRead<T>(read: () => Promise<T>): Promise<T> {
		this.assertOpen();
		this.admittedReads++;
		try {
			return await read();
		} finally {
			if (--this.admittedReads === 0) this.readsDrained?.();
		}
	}

	private async readConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		const row = await this.db.get<JsonRow>("SELECT record FROM conversations WHERE id = $1", [id]);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	private async materializeDocument(
		executor: PostgresExecutor,
		id: DocumentId,
		at: DocumentPoint,
	): Promise<StoredDocument | undefined> {
		const row = await executor.get<JsonRow>("SELECT record FROM documents WHERE id = $1", [id]);
		if (row === undefined) return undefined;
		const record = parseJson<DocumentRecord>(row.record);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new Error(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const base = await executor.get<RevisionRow>(
			`SELECT seq, kind, version, content FROM document_revisions
				WHERE document_id = $1 AND kind = 'base' AND seq <= $2 ORDER BY seq DESC LIMIT 1`,
			[id, upper],
		);
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		let value = parseJson<JsonObject>(base.content);
		const tail = await executor.all<RevisionRow>(
			`SELECT seq, kind, version, content FROM document_revisions
				WHERE document_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq`,
			[id, base.seq, upper],
		);
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = apply(value, parseJson<readonly Op[]>(revision.content)) as JsonObject;
		}
		return { record, version: base.version, value, deltasSinceBase: tail.length };
	}

	private candidateNextId(writes: readonly StorageWrite[]): number {
		let nextId = this.nextId;
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		return nextId;
	}

	private async checkGlobalIds(executor: PostgresExecutor, writes: readonly StorageWrite[]): Promise<void> {
		const claimed = new Map<Id<string>, TableName>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			const existing = (
				await executor.get<RecordIdRow>("SELECT record_type FROM record_ids WHERE id = $1", [id])
			)?.record_type;
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table)
					throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (
				write.type !== "document.create" &&
				write.type !== "document.copy" &&
				write.type !== "document.change" &&
				write.type !== "document.retire"
			) {
				continue;
			}
			const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.copy":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.copy = write.source;
					break;
				case "document.change":
					if (action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.content = write.content;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	private async checkDocumentActions(
		executor: PostgresExecutor,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
	): Promise<void> {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new StorageRejected(`Document copy ${id} source is changed in the copy batch`);
			}
			const row = await executor.get<JsonRow>("SELECT record FROM documents WHERE id = $1", [id]);
			const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = await executor.get<{ readonly version: number }>(
					"SELECT version FROM document_revisions WHERE document_id = $1 ORDER BY seq DESC LIMIT 1",
					[id],
				);
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (previous.version !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			const record = action.create ?? existing!;
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) live = (await this.currentDocumentId(executor, record)) === undefined ? 0 : 1;
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
	}

	private async currentDocumentId(
		executor: PostgresExecutor,
		address: DocumentAddress | DocumentCreate | DocumentRecord,
	): Promise<DocumentId | undefined> {
		const parts = addressParts(address);
		const id = (
			await executor.get<IdRow>(
				`SELECT id FROM documents
				WHERE kind = $1 AND scope_kind = $2 AND owner_id = $3 AND family = $4 AND key_value = $5 AND retired_at IS NULL
				LIMIT 1`,
				[parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue],
			)
		)?.id;
		return id === undefined ? undefined : idFromNumber<DocumentId>(id);
	}

	private async applyTableWrite(executor: PostgresExecutor, write: StorageWrite, seq: Seq): Promise<void> {
		switch (write.type) {
			case "conversation":
				await this.claimId(executor, write.value.id, "conversation");
				await executor.run(
					"INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES ($1, $2, $3, $4)",
					[
						write.value.id,
						write.value.owner?.conversationId ?? null,
						write.value.owner?.taskId ?? null,
						encodeJson(write.value),
					],
				);
				break;
			case "entry":
				await this.claimId(executor, write.value.id, "entry");
				await executor.run(
					"INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES ($1, $2, $3, $4, $5)",
					[
						write.value.id,
						write.value.conversationId,
						write.value.head ?? null,
						seq,
						encodeJson(write.value),
					],
				);
				break;
			case "task":
				await this.claimId(executor, write.value.id, "task");
				await executor.run(
					`INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
						VALUES ($1, $2, $3, $4, $5, $6, $7)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
						status = excluded.status, abort_requested = excluded.abort_requested,
						background = excluded.background, record = excluded.record`,
					[
						write.value.id,
						write.value.conversationId,
						encodeIndexedString(write.value.kind),
						write.value.state.status,
						write.value.abortRequested,
						write.value.background,
						encodeJson(write.value),
					],
				);
				break;
			case "submission":
				await this.claimId(executor, write.value.id, "submission");
				await executor.run(
					`INSERT INTO submissions (id, conversation_id, request_id, status, record) VALUES ($1, $2, $3, $4, $5)
						ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id,
						request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
					[
						write.value.id,
						write.value.conversationId,
						write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
						write.value.status,
						encodeJson(write.value),
					],
				);
				break;
			case "document.create":
			case "document.copy":
			case "document.change":
			case "document.retire":
				break;
		}
	}

	private async claimId(executor: PostgresExecutor, id: Id<string>, table: TableName): Promise<void> {
		await executor.run(
			"INSERT INTO record_ids (id, record_type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
			[id, table],
		);
	}

	private async applyDocumentActions(
		executor: PostgresExecutor,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
	): Promise<void> {
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				try {
					const stored = await this.materializeDocument(executor, action.copy.id, action.copy.at);
					if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
					const create = action.create!;
					if (
						stored.record.scope.kind !== "conversation" ||
						create.scope.kind !== "conversation" ||
						stored.record.kind !== create.kind ||
						stored.record.key !== create.key ||
						stored.record.history !== create.history ||
						stored.record.fork !== create.fork
					) {
						throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
					}
					content = { kind: "base", version: stored.version, value: stored.value };
				} catch (error) {
					if (error instanceof StorageRejected) throw error;
					throw new StorageRejected(`Document copy ${id} was rejected`, { cause: error });
				}
			}
			let record: DocumentRecord;
			if (action.create !== undefined) {
				record = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				};
				const parts = addressParts(record);
				await this.claimId(executor, id, "document");
				await executor.run(
					`INSERT INTO documents
						(id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
						VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[
						id,
						parts.kind,
						parts.family,
						parts.keyValue,
						parts.scopeKind,
						parts.ownerId,
						seq,
						action.retire ? seq : null,
						encodeJson(record),
					],
				);
			} else {
				const row = (await executor.get<JsonRow>("SELECT record FROM documents WHERE id = $1", [id]))!;
				record = parseJson<DocumentRecord>(row.record);
			}

			if (content !== undefined) {
				if (content.kind === "base" && isCurrentOnly(record)) {
					await executor.run("DELETE FROM document_revisions WHERE document_id = $1", [id]);
				}
				const encodedContent = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
				await executor.run(
					"INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES ($1, $2, $3, $4, $5)",
					[id, seq, content.kind, content.version, encodedContent],
				);
			}

			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq };
					await executor.run(
						"UPDATE documents SET retired_at = $1, record = $2 WHERE id = $3",
						[seq, encodeJson(record), id],
					);
				}
				if (isCurrentOnly(record)) {
					await executor.run("DELETE FROM document_revisions WHERE document_id = $1", [id]);
				}
			}
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("PostgresStorage is closed");
	}
}
