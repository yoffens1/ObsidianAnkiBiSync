/**
 * main.ts — Anki BiSync Plugin entry point
 *
 * Registers commands, ribbon icon, sync-on-save event, and auto-sync interval.
 */

import { Notice, Plugin, TFile } from 'obsidian';
import { AnkiConnect } from './anki-connect';
import { AnkiBiSyncSettingTab, AnkiBiSyncSettings, DEFAULT_SETTINGS } from './settings';
import { SyncEngine, createSyncNotice } from './sync-engine';
import { ImportEngine } from './import-engine';
import { debounce } from './utils';

export default class AnkiBiSyncPlugin extends Plugin {
	settings!: AnkiBiSyncSettings;
	anki!: AnkiConnect;
	private syncEngine!: SyncEngine;
	private importEngine!: ImportEngine;

	// Persistent references for cleanup
	private autoSyncIntervalId: ReturnType<typeof setInterval> | null = null;
	private debouncedSyncOnSave!: (file: TFile) => void;

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	async onload(): Promise<void> {
		await this.loadSettings();

		// Init AnkiConnect + SyncEngine
		this.anki = new AnkiConnect(
			this.settings.ankiConnectUrl,
			this.settings.ankiConnectApiKey
		);
		this.syncEngine = new SyncEngine(this.app, this.anki, this.settings);
		this.importEngine = new ImportEngine(this.app, this.anki, this.settings);

		// Debounced save handler
		this.debouncedSyncOnSave = debounce(
			async (file: TFile) => {
				if (!this.settings.syncOnSave) return;
				if (!this.syncEngine.shouldSyncFile(file)) return;
				try {
					const result = await this.syncEngine.syncFile(file);
					const total = result.cardsCreated + result.cardsUpdated;
					new Notice(
						`✓ Saved & synced "${file.basename}": ${total} card(s) updated`,
						3000
					);
				} catch (err) {
					console.error('[AnkiBiSync] Sync-on-save error:', err);
				}
			},
			500
		) as (file: TFile) => void;

		// Register commands
		this.registerCommands();

		// Ribbon icon
		this.addRibbonIcon('refresh-cw', 'Anki BiSync: Sync vault', async () => {
			await this.runVaultSync();
		});

		// Sync-on-save event
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.debouncedSyncOnSave(file);
				}
			})
		);

		// Settings tab
		this.addSettingTab(new AnkiBiSyncSettingTab(this.app, this));

		// Auto-sync interval
		this.updateAutoSync();

		console.log('[AnkiBiSync] Plugin loaded');
	}

	onunload(): void {
		if (this.autoSyncIntervalId !== null) {
			clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
		console.log('[AnkiBiSync] Plugin unloaded');
	}

	// ── Settings ───────────────────────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Re-initialize AnkiConnect client (called when URL or API key changes). */
	reinitAnkiConnect(): void {
		this.anki = new AnkiConnect(
			this.settings.ankiConnectUrl,
			this.settings.ankiConnectApiKey
		);
		this.syncEngine = new SyncEngine(this.app, this.anki, this.settings);
		this.importEngine = new ImportEngine(this.app, this.anki, this.settings);
	}

	/** Called when syncOnSave toggle changes — no-op since handler checks setting at call time. */
	updateSyncOnSave(): void {
		// Handler already guards with `if (!this.settings.syncOnSave) return`
	}

	/** Start or clear the auto-sync interval based on settings. */
	updateAutoSync(): void {
		if (this.autoSyncIntervalId !== null) {
			clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}

		const minutes = this.settings.autoSyncInterval;
		if (minutes > 0) {
			this.autoSyncIntervalId = setInterval(
				() => {
					this.runVaultSync().catch((err) => {
						console.error('[AnkiBiSync] Auto-sync error:', err);
					});
				},
				minutes * 60 * 1000
			);
		}
	}

	// ── Commands ───────────────────────────────────────────────────────────────

	private registerCommands(): void {
		// Sync current file
		this.addCommand({
			id: 'sync-current',
			name: 'Anki BiSync: Sync current file',
			hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'a' }],
			editorCallback: async (_editor, view) => {
				const file = view.file;
				if (!file) {
					new Notice('⚠ No active file to sync.', 4000);
					return;
				}
				await this.runFileSync(file);
			},
		});

		// Sync entire vault
		this.addCommand({
			id: 'sync-vault',
			name: 'Anki BiSync: Sync entire vault',
			callback: async () => {
				await this.runVaultSync();
			},
		});

		// Pull from Anki
		this.addCommand({
			id: 'pull-from-anki',
			name: 'Anki BiSync: Pull from Anki',
			callback: async () => {
				await this.runPullFromAnki();
			},
		});

		// Test AnkiConnect connection
		this.addCommand({
			id: 'test-connection',
			name: 'Anki BiSync: Test AnkiConnect',
			callback: async () => {
				try {
					const version = await this.anki.version();
					new Notice(`✓ AnkiConnect v${version} is running!`, 5000);
				} catch (err) {
					new Notice(
						`⚠ AnkiConnect not reachable. Is Anki running with AnkiConnect installed?\n${err instanceof Error ? err.message : String(err)}`,
						10000
					);
				}
			},
		});
	}

	// ── Sync Runners ──────────────────────────────────────────────────────────

	/** Sync a single file with progress notice. */
	async runFileSync(file: TFile): Promise<void> {
		// Check AnkiConnect is reachable
		const reachable = await this.anki.isReachable();
		if (!reachable) {
			new Notice('⚠ AnkiConnect not reachable. Is Anki running?', 10000);
			return;
		}

		const notice = new Notice(`🔄 Syncing "${file.basename}"…`, 0);
		try {
			const result = await this.syncEngine.syncFile(file);
			notice.hide();
			const total = result.cardsCreated + result.cardsUpdated;
			const errStr = result.errors.length > 0 ? ` (${result.errors.length} errors)` : '';
			new Notice(
				`✓ Synced "${file.basename}": ${result.cardsCreated} created, ` +
				`${result.cardsUpdated} updated, ${result.cardsSuspended + result.cardsDeleted} removed${errStr}`,
				5000
			);
			if (result.errors.length > 0) {
				console.warn('[AnkiBiSync] Sync errors:', result.errors);
			}
		} catch (err) {
			notice.hide();
			new Notice(
				`⚠ Sync failed: ${err instanceof Error ? err.message : String(err)}`,
				10000
			);
		}
	}

	/** Sync entire vault with live progress notice. */
	async runVaultSync(): Promise<void> {
		// Check AnkiConnect is reachable
		const reachable = await this.anki.isReachable();
		if (!reachable) {
			new Notice('⚠ AnkiConnect not reachable. Is Anki running?', 10000);
			return;
		}

		const files = this.syncEngine.getFilesToSync();
		const total = files.length;

		if (total === 0) {
			new Notice('No files found in sync folders.', 4000);
			return;
		}

		const progressNotice = createSyncNotice();
		progressNotice.update(0, total, 0);

		try {
			const result = await this.syncEngine.syncVault(
				(current, _total, cards) => {
					progressNotice.update(current, total, cards);
				}
			);

			const totalCards = result.cardsCreated + result.cardsUpdated;
			progressNotice.complete(totalCards, result.filesProcessed, result.errors.length);

			if (result.errors.length > 0) {
				console.warn('[AnkiBiSync] Vault sync errors:', result.errors);
			}
		} catch (err) {
			progressNotice.error(
				`Vault sync failed: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/** Pull from Anki with notice. */
	async runPullFromAnki(): Promise<void> {
		const reachable = await this.anki.isReachable();
		if (!reachable) {
			new Notice('⚠ AnkiConnect not reachable. Is Anki running?', 10000);
			return;
		}

		const notice = new Notice('🔄 Pulling from Anki…', 0);
		try {
			const result = await this.syncEngine.pullFromAnki();
			notice.hide();
			new Notice(
				`✓ Pull complete: ${result.cardsUpdated} cards updated across ${result.filesUpdated} files`,
				5000
			);
			if (result.errors.length > 0) {
				console.warn('[AnkiBiSync] Pull errors:', result.errors);
			}
		} catch (err) {
			notice.hide();
			new Notice(
				`⚠ Pull failed: ${err instanceof Error ? err.message : String(err)}`,
				10000
			);
		}
	}

	/** Trigger import flow from UI */
	async initiateAnkiImport(): Promise<void> {
		const reachable = await this.anki.isReachable();
		if (!reachable) {
			new Notice('⚠ AnkiConnect not reachable. Is Anki running?', 10000);
			return;
		}
		
		await this.importEngine.initiateImport();
	}
}
