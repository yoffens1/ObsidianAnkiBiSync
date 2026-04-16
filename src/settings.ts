/**
 * settings.ts — Plugin settings interface + settings tab UI
 */

import { App, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type AnkiBiSyncPlugin from './main';

// ─── Settings Interface ───────────────────────────────────────────────────────

export interface AnkiBiSyncSettings {
	// Connection
	ankiConnectUrl: string;
	ankiConnectApiKey: string;

	// Sync folders
	syncFolders: string[];
	excludeFolders: string[];

	// Behavior
	syncOnSave: boolean;
	autoSyncInterval: number; // minutes, 0 = disabled
	biSyncEnabled: boolean;
	deleteOrSuspend: 'delete' | 'suspend';

	// Deck
	defaultDeck: string;
	deckAddSuffixes: boolean;
	deckUppercaseFolders: boolean;

	// Note model
	noteModelName: string;

	// Tags
	syncTagsFromAnki: boolean;
	tagFromHeading: boolean;
	tagFromFile: boolean;
	tagFromFolder: boolean;
	tagFromMeta: boolean;

	// Import Options
	importDeckDepth: number;
}

export const DEFAULT_SETTINGS: AnkiBiSyncSettings = {
	ankiConnectUrl: 'http://127.0.0.1:8765',
	ankiConnectApiKey: '',
	syncFolders: ['/'],
	excludeFolders: ['templates', '.obsidian'],
	syncOnSave: false,
	autoSyncInterval: 0,
	biSyncEnabled: true,
	deleteOrSuspend: 'suspend',
	defaultDeck: 'Obsidian',
	deckAddSuffixes: true,
	deckUppercaseFolders: false,
	noteModelName: 'ObsidianBiSync',
	syncTagsFromAnki: false,
	tagFromHeading: false,
	tagFromFile: false,
	tagFromFolder: true,
	tagFromMeta: true,
	importDeckDepth: 1,
};

// ─── Settings Tab ─────────────────────────────────────────────────────────────

export class AnkiBiSyncSettingTab extends PluginSettingTab {
	private readonly plugin: AnkiBiSyncPlugin;

	constructor(app: App, plugin: AnkiBiSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Anki BiSync Settings' });

		// ── Connection ─────────────────────────────────────────────────────────

		containerEl.createEl('h3', { text: 'Connection' });

		new Setting(containerEl)
			.setName('AnkiConnect URL')
			.setDesc('URL for the AnkiConnect add-on (default: http://127.0.0.1:8765)')
			.addText((text) =>
				text
					.setPlaceholder('http://127.0.0.1:8765')
					.setValue(this.plugin.settings.ankiConnectUrl)
					.onChange(async (value) => {
						this.plugin.settings.ankiConnectUrl = value.trim() || 'http://127.0.0.1:8765';
						await this.plugin.saveSettings();
						this.plugin.reinitAnkiConnect();
					})
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Optional AnkiConnect API key (leave blank if not set)')
			.addText((text) =>
				text
					.setPlaceholder('(optional)')
					.setValue(this.plugin.settings.ankiConnectApiKey)
					.onChange(async (value) => {
						this.plugin.settings.ankiConnectApiKey = value.trim();
						await this.plugin.saveSettings();
						this.plugin.reinitAnkiConnect();
					})
			);

		new Setting(containerEl)
			.setName('Test Connection')
			.setDesc('Verify that AnkiConnect is reachable and check its version')
			.addButton((btn) =>
				btn
					.setButtonText('Test Connection')
					.setCta()
					.onClick(async () => {
						btn.setButtonText('Testing…');
						btn.setDisabled(true);
						try {
							const version = await this.plugin.anki.version();
							new Notice(`✓ AnkiConnect v${version} is reachable!`, 4000);
						} catch (err) {
							new Notice(
								`⚠ AnkiConnect not reachable: ${err instanceof Error ? err.message : String(err)}`,
								8000
							);
						} finally {
							btn.setButtonText('Test Connection');
							btn.setDisabled(false);
						}
					})
			);

		// ── Sync Folders ───────────────────────────────────────────────────────

		containerEl.createEl('h3', { text: 'Sync Folders' });

		const allFolders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
		const root = this.app.vault.getRoot();
		if (!allFolders.find((f) => f.path === root.path)) {
			allFolders.unshift(root);
		}

		const renderFolderList = (
			container: HTMLElement,
			folders: string[],
			saveCallback: (newFolders: string[]) => Promise<void>
		) => {
			container.empty();
			const listContainer = container.createDiv({ cls: 'anki-bisync-folder-list', attr: { style: 'margin-bottom: 1em;' } });
			for (const folder of folders) {
				const item = listContainer.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; margin-bottom: 4px; background: var(--background-secondary-alt); border-radius: 4px;' } });
				item.createSpan({ text: folder });
				const removeBtn = item.createEl('button', { text: 'Remove' });
				removeBtn.onclick = async () => {
					const newFolders = folders.filter((f) => f !== folder);
					await saveCallback(newFolders);
				};
			}
		};

		const syncFoldersContainer = containerEl.createDiv();
		const renderSyncFolders = () => {
			renderFolderList(syncFoldersContainer, this.plugin.settings.syncFolders, async (newFolders) => {
				this.plugin.settings.syncFolders = newFolders;
				await this.plugin.saveSettings();
				renderSyncFolders();
			});
		};

		new Setting(containerEl)
			.setName('Add folder to sync')
			.setDesc('Select a folder to add to the sync list. Use "/" for the entire vault.')
			.addDropdown((dd) => {
				dd.addOption('', '-- Select a folder --');
				for (const f of allFolders) {
					const displayPath = f.path === '/' || f.path === '' ? '/' : f.path;
					dd.addOption(displayPath, displayPath);
				}
				dd.onChange(async (value) => {
					if (value && !this.plugin.settings.syncFolders.includes(value)) {
						this.plugin.settings.syncFolders.push(value);
						await this.plugin.saveSettings();
						renderSyncFolders();
					}
					dd.setValue(''); // reset dropdown
				});
			});

		renderSyncFolders();

		const excludeFoldersContainer = containerEl.createDiv();
		const renderExcludeFolders = () => {
			renderFolderList(excludeFoldersContainer, this.plugin.settings.excludeFolders, async (newFolders) => {
				this.plugin.settings.excludeFolders = newFolders;
				await this.plugin.saveSettings();
				renderExcludeFolders();
			});
		};

		new Setting(containerEl)
			.setName('Add folder to exclude')
			.setDesc('Select a folder. These folders will never be synced.')
			.addDropdown((dd) => {
				dd.addOption('', '-- Select a folder --');
				for (const f of allFolders) {
					const displayPath = f.path === '/' || f.path === '' ? '/' : f.path;
					dd.addOption(displayPath, displayPath);
				}
				dd.onChange(async (value) => {
					if (value && !this.plugin.settings.excludeFolders.includes(value)) {
						this.plugin.settings.excludeFolders.push(value);
						await this.plugin.saveSettings();
						renderExcludeFolders();
					}
					dd.setValue(''); // reset dropdown
				});
			});

		renderExcludeFolders();

		// ── Behavior ───────────────────────────────────────────────────────────

		containerEl.createEl('h3', { text: 'Behavior' });

		new Setting(containerEl)
			.setName('Sync current file on save')
			.setDesc(
				'Automatically sync the active file when you save it (Ctrl+S). ' +
				'Uses a 500ms debounce to avoid triggering on every keystroke.'
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnSave)
					.onChange(async (value) => {
						this.plugin.settings.syncOnSave = value;
						await this.plugin.saveSettings();
						this.plugin.updateSyncOnSave();
					})
			);

		new Setting(containerEl)
			.setName('Enable bi-directional sync (Anki → Obsidian)')
			.setDesc(
				'After pushing to Anki, pull back any changes made in Anki ' +
				'(edited card text, review scheduling data) into your MD files.'
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.biSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.biSyncEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('On heading deletion')
			.setDesc(
				'What to do in Anki when a ## heading is removed from your MD file.'
			)
			.addDropdown((dd) =>
				dd
					.addOption('suspend', 'Suspend card')
					.addOption('delete', 'Delete card')
					.setValue(this.plugin.settings.deleteOrSuspend)
					.onChange(async (value: string) => {
						this.plugin.settings.deleteOrSuspend = value as 'delete' | 'suspend';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Auto-sync interval (minutes)')
			.setDesc('Automatically sync the vault at this interval. Set to 0 to disable.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 5)
					.setValue(this.plugin.settings.autoSyncInterval)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.autoSyncInterval = value;
						await this.plugin.saveSettings();
						this.plugin.updateAutoSync();
					})
			);

		new Setting(containerEl)
			.setName('Pull tags from Anki')
			.setDesc(
				'When pulling from Anki, sync any new tags added in Anki back to the ' +
				'file frontmatter `tags:` field.'
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncTagsFromAnki)
					.onChange(async (value) => {
						this.plugin.settings.syncTagsFromAnki = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Tag Generation ─────────────────────────────────────────────────────

		containerEl.createEl('h3', { text: 'Tag Generation Settings' });
		containerEl.createEl('p', {
			text: 'Choose which information should be automatically converted to Anki tags when syncing notes.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('Tags based on frontmatter meta info')
			.setDesc('Create Anki tags from the tags defined in the Obsidian YAML block (`--- tags: ---`).')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tagFromMeta)
					.onChange(async (value) => {
						this.plugin.settings.tagFromMeta = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Tags based on folder name')
			.setDesc('Create Anki tags from the folders the file resides in.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tagFromFolder)
					.onChange(async (value) => {
						this.plugin.settings.tagFromFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Tags based on MD file name')
			.setDesc('Create an Anki tag for the Markdown file name itself.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tagFromFile)
					.onChange(async (value) => {
						this.plugin.settings.tagFromFile = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Tags based on headings')
			.setDesc('Create an Anki tag based on the text of the ## block heading.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.tagFromHeading)
					.onChange(async (value) => {
						this.plugin.settings.tagFromHeading = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Defaults ───────────────────────────────────────────────────────────

		containerEl.createEl('h3', { text: 'Defaults' });

		new Setting(containerEl)
			.setName('Default deck name')
			.setDesc(
				'Fallback deck name when no [[MOC ...]] parent is found in frontmatter.'
			)
			.addText((text) =>
				text
					.setPlaceholder('Obsidian')
					.setValue(this.plugin.settings.defaultDeck)
					.onChange(async (value) => {
						this.plugin.settings.defaultDeck = value.trim() || 'Obsidian';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Append .folder and .md suffixes to decks')
			.setDesc('If enabled, Anki decks generated from Obsidian structure will append ".folder" and ".md" to clarify their source type.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.deckAddSuffixes)
					.onChange(async (value) => {
						this.plugin.settings.deckAddSuffixes = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Make folder names uppercase in decks')
			.setDesc('If enabled, Anki deck folders will be automatically converted to UPPERCASE (e.g. TestFolder -> TESTFOLDER).')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.deckUppercaseFolders)
					.onChange(async (value) => {
						this.plugin.settings.deckUppercaseFolders = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Note model name')
			.setDesc(
				'Anki note model name used for all BiSync cards. ' +
				'Change only if you want to use a different model name.'
			)
			.addText((text) =>
				text
					.setPlaceholder('ObsidianBiSync')
					.setValue(this.plugin.settings.noteModelName)
					.onChange(async (value) => {
						this.plugin.settings.noteModelName = value.trim() || 'ObsidianBiSync';
						await this.plugin.saveSettings();
					})
			);

		// ── Actions ────────────────────────────────────────────────────────────

		containerEl.createEl('h3', { text: 'Actions' });
		containerEl.createEl('p', {
			text: 'These buttons perform an immediate one-off sync. ' +
				'You can also use them from the command palette.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('Full vault sync')
			.setDesc('Push all MD files in sync folders to Anki now.')
			.addButton((btn) =>
				btn
					.setButtonText('Sync Vault Now')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						await this.plugin.runVaultSync();
						btn.setDisabled(false);
					})
			);

		new Setting(containerEl)
			.setName('Pull all from Anki')
			.setDesc('Pull Anki changes back to all MD files now.')
			.addButton((btn) =>
				btn
					.setButtonText('Pull from Anki Now')
					.onClick(async () => {
						btn.setDisabled(true);
						await this.plugin.runPullFromAnki();
						btn.setDisabled(false);
					})
			);

		new Setting(containerEl)
			.setName('Import deck from Anki')
			.setDesc('Download an existing deck from Anki and convert it into Obsidian Markdown files.')
			.addButton((btn) =>
				btn
					.setButtonText('Import Deck…')
					.onClick(async () => {
						await this.plugin.initiateAnkiImport();
					})
			);

		new Setting(containerEl)
			.setName('Import dropdown hierarchy depth')
			.setDesc('How many levels of subdecks to show in the Import dropdown (0 = show ALL subdecks).')
			.addSlider((slider) =>
				slider
					.setLimits(0, 5, 1)
					.setValue(this.plugin.settings.importDeckDepth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.importDeckDepth = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Info ───────────────────────────────────────────────────────────────

		containerEl.createEl('h3', { text: 'About' });
		const about = containerEl.createEl('div', { cls: 'anki-bisync-about' });
		about.createEl('p', {
			text: '⚠ Limitation: Renaming a ## heading changes its CardID. ' +
				'Anki will treat it as a new card, losing review history for the old heading.',
		});
		about.createEl('p', {
			text: '📄 Card format: ## Heading → Front, body text → Back. ' +
				'Per-card metadata (`next_review:`, `reviewed:`) is managed automatically.',
		});
	}
}
