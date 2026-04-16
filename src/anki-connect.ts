/**
 * anki-connect.ts — Typed wrapper around AnkiConnect API v6
 * Uses standard fetch() since AnkiConnect is localhost.
 */

// ─── Type Definitions ────────────────────────────────────────────────────────

export interface NoteFieldValue {
	value: string;
	order: number;
}

export interface NoteInfo {
	noteId: number;
	modelName: string;
	fields: Record<string, NoteFieldValue>;
	tags: string[];
	cards: number[];
}

export interface CardInfo {
	cardId: number;
	note: number;
	deckName: string;
	interval: number;
	due: number;
	reps: number;
	lapses: number;
	type: number;  // 0=new, 1=learning, 2=review, 3=relearning
	queue: number;
	mod: number;
	factor: number;
}

export interface DuplicateScopeOptions {
	deckName: string;
	checkChildren: boolean;
	checkAllModels: boolean;
}

export interface AddNoteOptions {
	allowDuplicate: boolean;
	duplicateScope: string;
	duplicateScopeOptions: DuplicateScopeOptions;
}

export interface AddNoteParams {
	deckName: string;
	modelName: string;
	fields: Record<string, string>;
	tags: string[];
	options: AddNoteOptions;
}

export interface UpdateNoteParams {
	id: number;
	fields: Record<string, string>;
	tags?: string[];
}

export interface CardTemplateParams {
	Name: string;
	Front: string;
	Back: string;
}

export interface CreateModelParams {
	modelName: string;
	inOrderFields: string[];
	css: string;
	isCloze: boolean;
	cardTemplates: CardTemplateParams[];
}

export interface Action {
	action: string;
	params?: Record<string, unknown>;
}

// ─── AnkiConnect Client ───────────────────────────────────────────────────────

export class AnkiConnect {
	private readonly url: string;
	private readonly apiKey: string;
	private readonly timeoutMs = 10_000;

	constructor(url = 'http://127.0.0.1:8765', apiKey = '') {
		this.url = url;
		this.apiKey = apiKey;
	}

	// ── Core invoker ──────────────────────────────────────────────────────────

	private async invoke<T = unknown>(
		action: string,
		params?: Record<string, unknown>
	): Promise<T> {
		const body: Record<string, unknown> = { action, version: 6 };
		if (params !== undefined) body['params'] = params;
		if (this.apiKey) body['key'] = this.apiKey;

		// Timeout via AbortController
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

		let response: Response;
		try {
			response = await fetch(this.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (err: unknown) {
			clearTimeout(timeoutId);
			if (err instanceof Error && err.name === 'AbortError') {
				throw new Error('AnkiConnect request timed out after 10 seconds.');
			}
			throw new Error(
				`AnkiConnect unreachable: ${err instanceof Error ? err.message : String(err)}`
			);
		}
		clearTimeout(timeoutId);

		const data = (await response.json()) as { result: T; error: string | null };
		if (data.error) throw new Error(`AnkiConnect error [${action}]: ${data.error}`);
		return data.result;
	}

	/** Invoke with one retry on network error */
	private async invokeWithRetry<T = unknown>(
		action: string,
		params?: Record<string, unknown>
	): Promise<T> {
		try {
			return await this.invoke<T>(action, params);
		} catch (err) {
			// Retry once for transient failures
			return await this.invoke<T>(action, params);
		}
	}

	// ── Meta ──────────────────────────────────────────────────────────────────

	async version(): Promise<number> {
		return this.invokeWithRetry<number>('version');
	}

	// ── Decks ─────────────────────────────────────────────────────────────────

	async deckNames(): Promise<string[]> {
		return this.invokeWithRetry<string[]>('deckNames');
	}

	async createDeck(deck: string): Promise<number> {
		return this.invokeWithRetry<number>('createDeck', { deck });
	}

	// ── Models ────────────────────────────────────────────────────────────────

	async modelNames(): Promise<string[]> {
		return this.invokeWithRetry<string[]>('modelNames');
	}

	async createModel(params: CreateModelParams): Promise<unknown> {
		return this.invokeWithRetry<unknown>('createModel', params as unknown as Record<string, unknown>);
	}

	async modelFieldNames(modelName: string): Promise<string[]> {
		return this.invokeWithRetry<string[]>('modelFieldNames', { modelName });
	}

	// ── Notes ─────────────────────────────────────────────────────────────────

	async findNotes(query: string): Promise<number[]> {
		return this.invokeWithRetry<number[]>('findNotes', { query });
	}

	async notesInfo(notes: number[]): Promise<NoteInfo[]> {
		return this.invokeWithRetry<NoteInfo[]>('notesInfo', { notes });
	}

	async addNote(note: AddNoteParams): Promise<number | null> {
		return this.invokeWithRetry<number | null>('addNote', { note: note as unknown as Record<string, unknown> });
	}

	async addNotes(notes: AddNoteParams[]): Promise<(number | null)[]> {
		return this.invokeWithRetry<(number | null)[]>('addNotes', { notes: notes as unknown as Record<string, unknown>[] });
	}

	async updateNote(note: UpdateNoteParams): Promise<void> {
		await this.invokeWithRetry<null>('updateNote', { note: note as unknown as Record<string, unknown> });
	}

	async updateNoteFields(note: { id: number; fields: Record<string, string> }): Promise<void> {
		await this.invokeWithRetry<null>('updateNoteFields', { note: note as unknown as Record<string, unknown> });
	}

	async deleteNotes(notes: number[]): Promise<void> {
		await this.invokeWithRetry<null>('deleteNotes', { notes });
	}

	async changeDeck(cards: number[], deck: string): Promise<void> {
		if (cards.length === 0) return;
		await this.invokeWithRetry<null>('changeDeck', { cards, deck });
	}

	async addTags(notes: number[], tags: string): Promise<void> {
		await this.invokeWithRetry<null>('addTags', { notes, tags });
	}

	async removeTags(notes: number[], tags: string): Promise<void> {
		await this.invokeWithRetry<null>('removeTags', { notes, tags });
	}

	async getTags(): Promise<string[]> {
		return this.invokeWithRetry<string[]>('getTags');
	}

	// ── Cards ─────────────────────────────────────────────────────────────────

	async cardsInfo(cards: number[]): Promise<CardInfo[]> {
		return this.invokeWithRetry<CardInfo[]>('cardsInfo', { cards });
	}

	async findCards(query: string): Promise<number[]> {
		return this.invokeWithRetry<number[]>('findCards', { query });
	}

	async suspend(cards: number[]): Promise<boolean> {
		return this.invokeWithRetry<boolean>('suspend', { cards });
	}

	// ── Batch ─────────────────────────────────────────────────────────────────

	/**
	 * Execute multiple actions in a single HTTP request for performance.
	 * Returns an array of results in the same order as the input actions.
	 */
	async multi(actions: Action[]): Promise<unknown[]> {
		return this.invokeWithRetry<unknown[]>('multi', {
			actions: actions as unknown as Record<string, unknown>[],
		});
	}

	/**
	 * Convenience: batch findNotes queries via multi action.
	 * Returns an array of note ID arrays matching the order of queries.
	 */
	async findNotesMulti(queries: string[]): Promise<number[][]> {
		const actions: Action[] = queries.map((query) => ({
			action: 'findNotes',
			params: { query },
		}));
		const results = await this.multi(actions);
		return results.map((r) => (Array.isArray(r) ? (r as number[]) : []));
	}

	/**
	 * Check if AnkiConnect is reachable.
	 */
	async isReachable(): Promise<boolean> {
		try {
			await this.version();
			return true;
		} catch {
			return false;
		}
	}
}
