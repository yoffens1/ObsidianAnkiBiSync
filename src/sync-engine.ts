/**
 * sync-engine.ts — Core bidirectional sync orchestrator for Anki BiSync
 *
 * Push:  Obsidian MD → Anki (creates/updates/deletes Anki notes)
 * Pull:  Anki → Obsidian MD (updates headings, bodies, per-card metadata)
 */

import { App, Notice, TFile } from 'obsidian';
import { AnkiConnect, AddNoteParams, CardInfo, NoteInfo } from './anki-connect';
import { buildAnkiNote, buildTags, compareNoteFields, getFilenameTag, resolveConflict } from './card-mapper';
import { updateFrontmatter } from './frontmatter-utils';
import { ParsedCard, ParsedFile, buildCardMetadataBlock, parseMarkdownFile } from './parser';
import { AnkiBiSyncSettings } from './settings';
import { Mutex, calculateNextReviewDate, formatDate } from './utils';

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface SyncResult {
	file: string;
	cardsCreated: number;
	cardsUpdated: number;
	cardsDeleted: number;
	cardsSuspended: number;
	errors: string[];
}

export interface VaultSyncResult {
	filesProcessed: number;
	cardsCreated: number;
	cardsUpdated: number;
	cardsDeleted: number;
	cardsSuspended: number;
	errors: string[];
}

export interface PullResult {
	filesUpdated: number;
	cardsUpdated: number;
	errors: string[];
}

export type ProgressCallback = (current: number, total: number, cardsProcessed: number) => void;

// ─── Anki Model Definition ────────────────────────────────────────────────────

const OBSIDIAN_BISYNC_MODEL_CSS = `
.obsidian-front {
  font-size: 1.2em;
  font-weight: 600;
  line-height: 1.5;
}
.obsidian-back {
  margin-top: 1em;
  line-height: 1.6;
}
.obsidian-back code {
  background: rgba(0,0,0,0.08);
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-family: monospace;
}
.obsidian-back pre {
  background: rgba(0,0,0,0.06);
  padding: 0.8em;
  border-radius: 6px;
  overflow-x: auto;
}
.source {
  font-size: 0.75em;
  color: #888;
  margin-top: 2em;
  border-top: 1px solid #eee;
  padding-top: 0.5em;
}
`.trim();

// ─── Sync Engine ──────────────────────────────────────────────────────────────

export class SyncEngine {
	private readonly anki: AnkiConnect;
	private readonly app: App;
	private readonly settings: AnkiBiSyncSettings;
	private readonly mutex = new Mutex();

	constructor(app: App, anki: AnkiConnect, settings: AnkiBiSyncSettings) {
		this.app = app;
		this.anki = anki;
		this.settings = settings;
	}

	// ── Public Entry Points ────────────────────────────────────────────────────

	/** Sync a single file: push to Anki, then pull if bi-sync enabled. */
	async syncFile(
		file: TFile,
		onProgress?: ProgressCallback
	): Promise<SyncResult> {
		const release = await this.mutex.acquire();
		try {
			return await this._syncFile(file, onProgress);
		} finally {
			release();
		}
	}

	/** Sync all vault files in configured sync folders. */
	async syncVault(onProgress?: ProgressCallback): Promise<VaultSyncResult> {
		const release = await this.mutex.acquire();
		try {
			return await this._syncVault(onProgress);
		} finally {
			release();
		}
	}

	/** Pull Anki → Obsidian for all files. */
	async pullFromAnki(): Promise<PullResult> {
		const release = await this.mutex.acquire();
		try {
			return await this._pullFromAnki();
		} finally {
			release();
		}
	}

	private getDeckNameForFile(file: TFile): string {
		const parentPath = file.parent?.path;
		if (parentPath && parentPath !== '/' && parentPath !== '') {
			return parentPath.split('/').join('::');
		}
		return this.settings.defaultDeck;
	}

	// ── Internal: Vault Sync ───────────────────────────────────────────────────

	private async _syncVault(onProgress?: ProgressCallback): Promise<VaultSyncResult> {
		const files = this.getFilesToSync();
		const total = files.length;

		const result: VaultSyncResult = {
			filesProcessed: 0,
			cardsCreated: 0,
			cardsUpdated: 0,
			cardsDeleted: 0,
			cardsSuspended: 0,
			errors: [],
		};

		// Ensure model exists once before processing files
		try {
			await this.ensureModelExists();
		} catch (err) {
			const msg = `Failed to ensure Anki model exists: ${err instanceof Error ? err.message : String(err)}`;
			result.errors.push(msg);
			return result;
		}

		let cardsProcessed = 0;
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (!file) continue;

			onProgress?.(i, total, cardsProcessed);

			try {
				const fileResult = await this._syncFile(file, undefined, /* skipModelCheck */ true);
				result.cardsCreated += fileResult.cardsCreated;
				result.cardsUpdated += fileResult.cardsUpdated;
				result.cardsDeleted += fileResult.cardsDeleted;
				result.cardsSuspended += fileResult.cardsSuspended;
				result.errors.push(...fileResult.errors);
				cardsProcessed += fileResult.cardsCreated + fileResult.cardsUpdated;
			} catch (err) {
				result.errors.push(
					`${file.path}: ${err instanceof Error ? err.message : String(err)}`
				);
			}

			result.filesProcessed++;
		}

		onProgress?.(total, total, cardsProcessed);
		return result;
	}

	// ── Internal: File Sync ────────────────────────────────────────────────────

	private async _syncFile(
		file: TFile,
		onProgress?: ProgressCallback,
		skipModelCheck = false
	): Promise<SyncResult> {
		const result: SyncResult = {
			file: file.path,
			cardsCreated: 0,
			cardsUpdated: 0,
			cardsDeleted: 0,
			cardsSuspended: 0,
			errors: [],
		};

		// Read and parse the file
		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch (err) {
			result.errors.push(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
			return result;
		}

		const filename = file.basename; // without .md
		let parsed: ParsedFile;
		try {
			parsed = parseMarkdownFile(content, filename, this.getDeckNameForFile(file));
		} catch (err) {
			result.errors.push(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
			return result;
		}

		if (parsed.cards.length === 0) {
			// No cards in this file — nothing to sync
			return result;
		}

		// Ensure Anki model and deck exist
		if (!skipModelCheck) {
			try {
				await this.ensureModelExists();
			} catch (err) {
				result.errors.push(`Model error: ${err instanceof Error ? err.message : String(err)}`);
				return result;
			}
		}

		try {
			await this.ensureDeckExists(parsed.deckName);
		} catch (err) {
			result.errors.push(`Deck error: ${err instanceof Error ? err.message : String(err)}`);
			return result;
		}

		// Push all cards
		const processedCardIDs: string[] = [];
		await this.pushCards(file, parsed, processedCardIDs, result);

		// Handle deletions
		await this.handleDeletions(file, parsed, processedCardIDs, result);

		// Pull Anki changes back to MD if bi-sync enabled
		if (this.settings.biSyncEnabled) {
			try {
				await this.pullCardsForFile(file, parsed);
			} catch (err) {
				result.errors.push(
					`Pull error: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}

		// Update frontmatter: cards count + lastAnkiSynced
		try {
			await updateFrontmatter(this.app, file, {
				cards: parsed.cards.length,
				lastAnkiSynced: new Date().toISOString().split('T')[0] ?? '',
			});
		} catch (err) {
			result.errors.push(
				`Frontmatter update error: ${err instanceof Error ? err.message : String(err)}`
			);
		}

		return result;
	}

	// ── Push Cards ────────────────────────────────────────────────────────────

	private async pushCards(
		file: TFile,
		parsed: ParsedFile,
		processedCardIDs: string[],
		result: SyncResult
	): Promise<void> {
		const vaultName = this.app.vault.getName();
		const filenameTag = getFilenameTag(file.path);

		// Batch: query all CardIDs at once using multi action
		const CHUNK_SIZE = 50;
		const cards = parsed.cards;

		for (let chunkStart = 0; chunkStart < cards.length; chunkStart += CHUNK_SIZE) {
			const chunk = cards.slice(chunkStart, chunkStart + CHUNK_SIZE);

			// Query existing notes via multi findNotes
			let existingNoteIdArrays: number[][];
			try {
				existingNoteIdArrays = await this.anki.findNotesMulti(
					chunk.map((c) => `"CardID:${c.cardID}"`)
				);
			} catch (err) {
				result.errors.push(
					`findNotes batch error: ${err instanceof Error ? err.message : String(err)}`
				);
				continue;
			}

			// Separate into new and existing
			const toCreate: AddNoteParams[] = [];
			const toUpdate: Array<{ noteId: number; card: ParsedCard }> = [];
			const noteIdsToFetch: number[] = [];
			const noteIdToCard = new Map<number, ParsedCard>();

			for (let i = 0; i < chunk.length; i++) {
				const card = chunk[i];
				if (!card) continue;
				const noteIds = existingNoteIdArrays[i] ?? [];
				processedCardIDs.push(card.cardID);

				if (noteIds.length === 0) {
					// New card
					toCreate.push(
						buildAnkiNote(card, parsed, vaultName, file.path, this.settings.noteModelName)
					);
				} else {
					// Existing card — need to check if fields changed
					const noteId = noteIds[0];
					if (noteId !== undefined) {
						noteIdsToFetch.push(noteId);
						noteIdToCard.set(noteId, card);
						toUpdate.push({ noteId, card });
					}
				}
			}

			// Create new notes
			if (toCreate.length > 0) {
				try {
					const createdIds = await this.anki.addNotes(toCreate);
					for (const id of createdIds) {
						if (id !== null) result.cardsCreated++;
						else result.errors.push('addNote returned null — possible duplicate or error');
					}
				} catch (err) {
					result.errors.push(
						`addNotes error: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			// Update existing notes — fetch current values first
			if (toUpdate.length > 0 && noteIdsToFetch.length > 0) {
				let notesInfo: NoteInfo[];
				try {
					notesInfo = await this.anki.notesInfo(noteIdsToFetch);
				} catch (err) {
					result.errors.push(
						`notesInfo error: ${err instanceof Error ? err.message : String(err)}`
					);
					continue;
				}

				// Move cards to correct deck if needed
				const allCardsToMove = notesInfo.flatMap(n => n.cards);
				if (allCardsToMove.length > 0) {
					try {
						await this.anki.changeDeck(allCardsToMove, parsed.deckName);
					} catch (err) {
						console.error(`[AnkiBiSync] changeDeck error:`, err);
					}
				}

				for (const noteInfo of notesInfo) {
					const card = noteIdToCard.get(noteInfo.noteId);
					if (!card) continue;

					const diff = compareNoteFields(noteInfo, card, parsed, filenameTag);
					if (diff.frontChanged || diff.backChanged || diff.tagsChanged) {
						try {
							await this.anki.updateNote({
								id: noteInfo.noteId,
								fields: {
									Front: diff.newFront,
									Back: diff.newBack,
									Source: `${vaultName}::${file.path}`,
									ObsidianPath: file.path,
									CardID: card.cardID,
								},
								tags: diff.newTags,
							});
							result.cardsUpdated++;
						} catch (err) {
							result.errors.push(
								`updateNote error for "${card.heading}": ${err instanceof Error ? err.message : String(err)}`
							);
						}
					}
				}
			}
		}
	}

	// ── Handle Deletions ──────────────────────────────────────────────────────

	private async handleDeletions(
		file: TFile,
		parsed: ParsedFile,
		processedCardIDs: string[],
		result: SyncResult
	): Promise<void> {
		const filenameTag = getFilenameTag(file.path);

		let ankiNoteIds: number[];
		try {
			ankiNoteIds = await this.anki.findNotes(
				`tag:${filenameTag} note:${this.settings.noteModelName}`
			);
		} catch (err) {
			result.errors.push(
				`findNotes for deletions error: ${err instanceof Error ? err.message : String(err)}`
			);
			return;
		}

		if (ankiNoteIds.length === 0) return;

		let notesInfo: NoteInfo[];
		try {
			notesInfo = await this.anki.notesInfo(ankiNoteIds);
		} catch (err) {
			result.errors.push(
				`notesInfo for deletions error: ${err instanceof Error ? err.message : String(err)}`
			);
			return;
		}

		const processedSet = new Set(processedCardIDs);
		const orphanedIds: number[] = [];
		const orphanedCardIds: number[] = [];

		for (const noteInfo of notesInfo) {
			const cardID = noteInfo.fields['CardID']?.value ?? '';
			if (cardID && !processedSet.has(cardID)) {
				orphanedIds.push(noteInfo.noteId);
				orphanedCardIds.push(...noteInfo.cards);
			}
		}

		if (orphanedIds.length === 0) return;

		if (this.settings.deleteOrSuspend === 'delete') {
			try {
				await this.anki.deleteNotes(orphanedIds);
				result.cardsDeleted += orphanedIds.length;
			} catch (err) {
				result.errors.push(
					`deleteNotes error: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		} else {
			// Suspend cards (not the notes directly)
			if (orphanedCardIds.length > 0) {
				try {
					await this.anki.suspend(orphanedCardIds);
					result.cardsSuspended += orphanedIds.length;
				} catch (err) {
					result.errors.push(
						`suspend error: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}
		}
	}

	// ── Pull Cards for a Single File ──────────────────────────────────────────

	private async pullCardsForFile(file: TFile, parsed: ParsedFile): Promise<void> {
		const filenameTag = getFilenameTag(file.path);

		// Find all Anki notes for this file
		let ankiNoteIds: number[];
		try {
			ankiNoteIds = await this.anki.findNotes(
				`tag:${filenameTag} note:${this.settings.noteModelName}`
			);
		} catch {
			return; // Ignore pull errors per file
		}

		if (ankiNoteIds.length === 0) return;

		let notesInfo: NoteInfo[];
		try {
			notesInfo = await this.anki.notesInfo(ankiNoteIds);
		} catch {
			return;
		}

		// Get card scheduling data for all associated card IDs
		const allCardIds = notesInfo.flatMap((n) => n.cards);
		let cardsInfoMap = new Map<number, CardInfo>();
		if (allCardIds.length > 0) {
			try {
				const cardsInfo = await this.anki.cardsInfo(allCardIds);
				for (const ci of cardsInfo) {
					cardsInfoMap.set(ci.cardId, ci);
				}
			} catch {
				// Scheduling data not critical — continue without it
			}
		}

		// Get file mtime and lastAnkiSynced for conflict resolution
		const fileMtimeSec = Math.floor(file.stat.mtime / 1000);
		const lastSyncedStr = parsed.frontmatter['lastAnkiSynced'];
		const lastSynced = lastSyncedStr
			? Math.floor(new Date(String(lastSyncedStr)).getTime() / 1000)
			: 0;

		// Map CardID → ParsedCard for quick lookup
		const cardByID = new Map<string, ParsedCard>();
		for (const card of parsed.cards) {
			cardByID.set(card.cardID, card);
		}

		// Track earliest next review date across all cards
		let earliestReview: Date | null = null;

		// Read current file content once
		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch {
			return;
		}

		let contentModified = false;

		for (const noteInfo of notesInfo) {
			const cardID = noteInfo.fields['CardID']?.value ?? '';
			const localCard = cardByID.get(cardID);
			if (!localCard) continue;

			// Get scheduling data from first associated card
			const firstCardId = noteInfo.cards[0];
			const cardInfo = firstCardId !== undefined ? cardsInfoMap.get(firstCardId) : undefined;

			// Calculate next review date
			let nextReviewDate: Date | null = null;
			if (cardInfo) {
				nextReviewDate = calculateNextReviewDate(
					cardInfo.due,
					cardInfo.type,
					cardInfo.interval,
					cardInfo.mod
				);
				if (earliestReview === null || nextReviewDate < earliestReview) {
					earliestReview = nextReviewDate;
				}
			}

			const ankiFront = noteInfo.fields['Front']?.value ?? '';
			const ankiBack = noteInfo.fields['Back']?.value ?? '';
			const ankiMod = cardInfo?.mod ?? 0;

			// Determine if Anki has newer data
			const winner = lastSynced > 0
				? resolveConflict(ankiMod, fileMtimeSec, lastSynced)
				: 'obsidian'; // First sync — trust Obsidian

			if (winner === 'anki') {
				const frontChanged = ankiFront.trim() !== localCard.heading.trim();
				const backChanged = ankiBack.trim() !== localCard.body.trim();

				if (frontChanged || backChanged || cardInfo) {
					const result = updateContentSection(
						content,
						localCard,
						frontChanged ? ankiFront : null,
						backChanged ? ankiBack : null,
						cardInfo ? formatDate(nextReviewDate ?? new Date()) : null,
						cardInfo ? (cardInfo.reps) : null
					);
					if (result !== null) {
						content = result;
						contentModified = true;
					}
				}
			} else {
				// Obsidian wins — but still update scheduling metadata
				if (cardInfo && nextReviewDate) {
					const result = updateContentSection(
						content,
						localCard,
						null, // no heading change
						null, // no body change
						formatDate(nextReviewDate),
						cardInfo.reps
					);
					if (result !== null) {
						content = result;
						contentModified = true;
					}
				}
			}
		}

		// Write modified content back to file
		if (contentModified) {
			try {
				await this.app.vault.modify(file, content);
			} catch (err) {
				console.error(`[AnkiBiSync] Failed to write back to ${file.path}:`, err);
			}
		}

		// Update frontmatter next_review with earliest date
		if (earliestReview) {
			try {
				await updateFrontmatter(this.app, file, {
					next_review: formatDate(earliestReview),
				});
			} catch {
				// Non-critical
			}
		}
	}

	// ── Pull All from Anki ─────────────────────────────────────────────────────

	private async _pullFromAnki(): Promise<PullResult> {
		const result: PullResult = {
			filesUpdated: 0,
			cardsUpdated: 0,
			errors: [],
		};

		const files = this.getFilesToSync();

		for (const file of files) {
			try {
				let content: string;
				try {
					content = await this.app.vault.read(file);
				} catch {
					continue;
				}

				const parsed = parseMarkdownFile(
					content,
					file.basename,
					this.getDeckNameForFile(file)
				);

				if (parsed.cards.length === 0) continue;

				await this.pullCardsForFile(file, parsed);
				result.filesUpdated++;
			} catch (err) {
				result.errors.push(
					`${file.path}: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}

		return result;
	}

	// ── Model and Deck Management ─────────────────────────────────────────────

	async ensureModelExists(): Promise<void> {
		const modelName = this.settings.noteModelName;
		const existingModels = await this.anki.modelNames();

		if (existingModels.includes(modelName)) return;

		await this.anki.createModel({
			modelName,
			inOrderFields: ['Front', 'Back', 'Source', 'ObsidianPath', 'CardID'],
			css: OBSIDIAN_BISYNC_MODEL_CSS,
			isCloze: false,
			cardTemplates: [
				{
					Name: 'Card 1',
					Front: "<div class='obsidian-front'>{{Front}}</div>",
					Back: "<div class='obsidian-back'>{{FrontSide}}<hr id='answer'>{{Back}}<div class='source'>📄 {{Source}}</div></div>",
				},
			],
		});
	}

	async ensureDeckExists(deckName: string): Promise<void> {
		const decks = await this.anki.deckNames();
		if (!decks.includes(deckName)) {
			await this.anki.createDeck(deckName);
		}
	}

	// ── File Selection ────────────────────────────────────────────────────────

	getFilesToSync(): TFile[] {
		const allFiles = this.app.vault.getMarkdownFiles();
		return allFiles.filter((file) => this.shouldSyncFile(file));
	}

	shouldSyncFile(file: TFile): boolean {
		const path = file.path;

		// Check excluded folders
		for (const excl of this.settings.excludeFolders) {
			const normalized = excl.replace(/^\/+|\/+$/g, '');
			if (normalized && path.startsWith(normalized + '/')) return false;
			if (normalized === path) return false;
		}

		// Check sync folders (default "/" = entire vault)
		if (
			this.settings.syncFolders.length === 0 ||
			this.settings.syncFolders.includes('/') ||
			this.settings.syncFolders.includes('')
		) {
			return true;
		}

		for (const folder of this.settings.syncFolders) {
			const normalized = folder.replace(/^\/+|\/+$/g, '');
			if (!normalized) return true; // root
			if (path.startsWith(normalized + '/') || path.startsWith(normalized)) return true;
		}

		return false;
	}
}

// ─── Surgical MD Content Update ───────────────────────────────────────────────

/**
 * Surgically update a specific section of a markdown file's content.
 * Returns the modified content string, or null if section not found.
 *
 * Finds the section by matching the heading line exactly, then replaces
 * the heading and/or body and updates/inserts metadata lines.
 */
function updateContentSection(
	content: string,
	card: ParsedCard,
	newHeading: string | null,
	newBody: string | null,
	nextReview: string | null,
	reviewedCount: number | null
): string | null {
	const lines = content.split('\n');

	// Find the heading line by its content (more robust than line number after edits)
	let headingLineIdx = -1;
	const targetHeading = `## ${card.heading}`;
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] ?? '').trim() === targetHeading.trim()) {
			headingLineIdx = i;
			break;
		}
	}

	if (headingLineIdx === -1) {
		console.warn(`[AnkiBiSync] Could not find heading "${card.heading}" in file for surgical update`);
		return null;
	}

	// Find the end of this section (next ## heading or end of file)
	let sectionEndIdx = lines.length;
	for (let i = headingLineIdx + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i] ?? '')) {
			sectionEndIdx = i;
			break;
		}
	}

	// Reconstruct the section
	const newLines: string[] = [];

	// Heading
	newLines.push(`## ${newHeading ?? card.heading}`);

	// Body — strip existing metadata lines first
	const bodyLines = lines.slice(headingLineIdx + 1, sectionEndIdx);
	const bodyWithoutMeta = bodyLines
		.join('\n')
		.replace(/^`next_review:\s*.+`\s*$/m, '')
		.replace(/^`reviewed:\s*\d+\s*times?\s*`\s*$/m, '')
		.trimEnd();

	const finalBody = newBody !== null ? newBody : bodyWithoutMeta;
	if (finalBody) {
		newLines.push(finalBody);
	}

	// Append metadata
	const metaBlock = buildCardMetadataBlock(nextReview, reviewedCount);
	if (metaBlock) {
		newLines.push(metaBlock.trimStart());
	}

	// Reconstruct the full content
	const before = lines.slice(0, headingLineIdx);
	const after = lines.slice(sectionEndIdx);

	return [...before, ...newLines, ...after].join('\n');
}

// ─── Progress Notice Helper ───────────────────────────────────────────────────

export function createSyncNotice(): {
	update: (current: number, total: number, cards: number) => void;
	complete: (cards: number, files: number, errors: number) => void;
	error: (msg: string) => void;
} {
	const notice = new Notice('', 0);

	return {
		update(current: number, total: number, cards: number) {
			notice.setMessage(
				`🔄 Anki BiSync: ${current}/${total} files | Cards: ${cards}`
			);
		},
		complete(cards: number, files: number, errors: number) {
			notice.hide();
			const errorStr = errors > 0 ? ` (${errors} errors)` : '';
			new Notice(
				`✓ Sync complete: ${cards} cards across ${files} files${errorStr}`,
				5000
			);
		},
		error(msg: string) {
			notice.hide();
			new Notice(`⚠ ${msg}`, 10000);
		},
	};
}
