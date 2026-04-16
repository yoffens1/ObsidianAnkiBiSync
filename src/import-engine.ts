import { App, Notice, TFile, TFolder, FuzzySuggestModal } from 'obsidian';
import { AnkiConnect, NoteInfo } from './anki-connect';
import { AnkiBiSyncSettings } from './settings';
import { updateFrontmatter } from './frontmatter-utils';

/** Modal exactly like Obsidian's command palette for selecting a deck */
class DeckSuggestModal extends FuzzySuggestModal<string> {
	private readonly decks: string[];
	private readonly onChoose: (deck: string) => void;

	constructor(app: App, decks: string[], onChoose: (deck: string) => void) {
		super(app);
		this.decks = decks;
		this.onChoose = onChoose;
		this.setPlaceholder('Type to search Anki decks to import...');
	}

	getItems(): string[] {
		return this.decks;
	}

	getItemText(deck: string): string {
		return deck;
	}

	onChooseItem(deck: string, evt: MouseEvent | KeyboardEvent): void {
		this.onChoose(deck);
	}
}

export class ImportEngine {
	private readonly app: App;
	private readonly anki: AnkiConnect;
	private readonly settings: AnkiBiSyncSettings;

	constructor(app: App, anki: AnkiConnect, settings: AnkiBiSyncSettings) {
		this.app = app;
		this.anki = anki;
		this.settings = settings;
	}

	public async initiateImport(): Promise<void> {
		let decks: string[];
		try {
			decks = await this.anki.deckNames();
		} catch (err) {
			new Notice(`Failed to fetch decks from Anki: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		if (decks.length === 0) {
			new Notice('No decks found in Anki.');
			return;
		}

		if (this.settings.importDeckDepth > 0) {
			decks = decks.filter(deck => deck.split('::').length <= this.settings.importDeckDepth);
		}

		if (decks.length === 0) {
			new Notice(`No decks found at or above depth level ${this.settings.importDeckDepth}.`);
			return;
		}

		// Prompt user
		new DeckSuggestModal(this.app, decks, async (selectedDeck) => {
			await this.importDeck(selectedDeck);
		}).open();
	}

	private async importDeck(deckName: string): Promise<void> {
		const notice = new Notice(`Importing deck "${deckName}"...`, 0);

		try {
			// Find all notes in this deck (including children)
			const noteIds = await this.anki.findNotes(`"deck:${deckName}"`);
			if (noteIds.length === 0) {
				notice.hide();
				new Notice(`Deck "${deckName}" has no notes.`);
				return;
			}

			// Batch fetch notes
			const notesInfo: NoteInfo[] = [];
			const CHUNK_SIZE = 100;
			for (let i = 0; i < noteIds.length; i += CHUNK_SIZE) {
				const chunk = noteIds.slice(i, i + CHUNK_SIZE);
				notesInfo.push(...(await this.anki.notesInfo(chunk)));
			}

			if (notesInfo.length === 0) {
				notice.hide();
				new Notice(`Could not retrieve note information for "${deckName}".`);
				return;
			}

			// Batch fetch cards to ascertain EXACT subdeck names
			const cardIdsToFetch: number[] = [];
			for (const n of notesInfo) {
				if (n.cards && n.cards.length > 0) {
					cardIdsToFetch.push(n.cards[0]!);
				}
			}

			const cardsInfo: import('./anki-connect').CardInfo[] = [];
			for (let i = 0; i < cardIdsToFetch.length; i += CHUNK_SIZE) {
				const chunk = cardIdsToFetch.slice(i, i + CHUNK_SIZE);
				cardsInfo.push(...(await this.anki.cardsInfo(chunk)));
			}

			const noteToDeckName = new Map<number, string>();
			for (const ci of cardsInfo) {
				noteToDeckName.set(ci.note, ci.deckName);
			}

			// Group notes by specific precise deck
			const deckGroups = new Map<string, NoteInfo[]>();
			for (const note of notesInfo) {
				const specificDeck = noteToDeckName.get(note.noteId) || deckName;
				if (!deckGroups.has(specificDeck)) {
					deckGroups.set(specificDeck, []);
				}
				deckGroups.get(specificDeck)!.push(note);
			}

			// Process each generic subdeck separately
			for (const [specificDeck, specificNotes] of deckGroups.entries()) {
				// Strip trailing optional suffixes when mapping to Obsidian hierarchy
				const pathParts = specificDeck.split('::').map(part => {
					let clean = part;
					if (clean.toLowerCase().endsWith('.folder')) clean = clean.substring(0, clean.length - 7);
					return clean;
				});

				let fileName = pathParts.pop() || 'ImportedDeck';
				if (fileName.toLowerCase().endsWith('.md')) fileName = fileName.substring(0, fileName.length - 3);
				
				// Create folders if they don't exist
				let currentFolder = this.app.vault.getRoot();
				let currentPathStr = '';

				for (const part of pathParts) {
					currentPathStr = currentPathStr ? `${currentPathStr}/${part}` : part;
					const abstractFile = this.app.vault.getAbstractFileByPath(currentPathStr);
					
					if (!abstractFile) {
						currentFolder = await this.app.vault.createFolder(currentPathStr);
					} else if (abstractFile instanceof TFolder) {
						currentFolder = abstractFile;
					} else {
						throw new Error(`Path collision: ${currentPathStr} is a file, not a folder.`);
					}
				}

				// Prepare file content
				const fullFilePath = currentPathStr ? `${currentPathStr}/${fileName}.md` : `${fileName}.md`;
				
				let mdBody = '';

				for (const note of specificNotes) {
					// Extract Front and Back aggressively
					const fieldKeys = Object.keys(note.fields).sort((a, b) => note.fields[a]!.order - note.fields[b]!.order);
					let front = note.fields['Front']?.value;
					let back = note.fields['Back']?.value;

					if (!front && fieldKeys.length > 0) {
						front = note.fields[fieldKeys[0]!]?.value;
					}
					if (!back && fieldKeys.length > 1) {
						back = note.fields[fieldKeys[1]!]?.value;
					}

					if (!front) front = 'Empty Front';
					if (!back) back = '';

					mdBody += `## ${front.trim()}\n${back.trim()}\n\n---\n\n`;
				}

				// Save exactly to this sub deck file
				const abstractTarget = this.app.vault.getAbstractFileByPath(fullFilePath);
				let file: TFile;
				let isNewFile = false;
				
				if (abstractTarget instanceof TFile) {
					const existingContent = await this.app.vault.read(abstractTarget);
					await this.app.vault.modify(abstractTarget, existingContent + '\n\n' + mdBody);
					file = abstractTarget;
				} else if (!abstractTarget) {
					// Create new file
					// Prevent redundant trailing newline separation before frontmatter injection
					file = await this.app.vault.create(fullFilePath, '\n\n' + mdBody);
					isNewFile = true;
				} else {
					throw new Error(`Target path ${fullFilePath} is not a file.`);
				}

				// Update specific file Frontmatter
				const d = new Date();
				const pad = (n: number) => n.toString().padStart(2, '0');
				const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
				const dayStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

				const updates: any = {};

				if (isNewFile) {
					let parentName = currentFolder.name;
					if (parentName === '/' || parentName === '') {
						parentName = fileName;
					}

					// Collect unique Anki tags, aliases, and sources from all imported notes
					const noteTags = new Set<string>();
					const noteAliases = new Set<string>();
					const noteSources = new Set<string>();

					for (const n of specificNotes) {
						for (const t of n.tags) {
							if (t) noteTags.add(t);
						}

						const sourceField = n.fields['Source']?.value || '';
						
						const aliasMatch = sourceField.match(/<br><b>Aliases:<\/b> (.*?)(?:<br>|$)/);
						if (aliasMatch && aliasMatch[1]) {
							const aliases = aliasMatch[1].split(',').map(s => s.trim()).filter(Boolean);
							for (const a of aliases) noteAliases.add(a);
						}

						const sourceMatch = sourceField.match(/<br><b>Sources:<\/b> (.*?)(?:<br>|$)/);
						if (sourceMatch && sourceMatch[1]) {
							const sources = sourceMatch[1].split(',').map(s => s.trim()).filter(Boolean);
							for (const src of sources) {
								if (src !== 'sites') noteSources.add(src);
							}
						}
					}

					let finalSources = Array.from(noteSources);
					if (finalSources.length === 0) finalSources.push('sites');

					updates.aliases = Array.from(noteAliases);
					updates.tags = Array.from(noteTags);
					updates.created = dayStr;
					updates.parent = `[[MOC ${parentName}]]`;
					updates.sources = finalSources;
				}

				updates.cards = specificNotes.length;
				updates.lastAnkiSynced = dateStr;
				
				await updateFrontmatter(this.app, file, updates);
			}

			notice.hide();
			new Notice(`Successfully imported entire deck tree for "${deckName}"`);

		} catch (err) {
			notice.hide();
			new Notice(`Import error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
