/**
 * frontmatter-utils.ts — Safe read/write of Obsidian frontmatter
 *
 * Uses Obsidian's built-in `app.fileManager.processFrontMatter()` API
 * for atomic, safe YAML frontmatter modifications.
 */

import { App, TFile } from 'obsidian';

export interface FrontmatterUpdates {
	cards?: number;
	lastAnkiSynced?: string;
	next_review?: string | null;
	[key: string]: unknown;
}

/**
 * Update frontmatter fields atomically using Obsidian's processFrontMatter API.
 * Other fields are left untouched.
 */
export async function updateFrontmatter(
	app: App,
	file: TFile,
	updates: FrontmatterUpdates
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => {
		for (const [key, value] of Object.entries(updates)) {
			if (value === undefined) continue;
			if (value === null) {
				delete fm[key];
			} else {
				fm[key] = value;
			}
		}
	});
}

/**
 * Read a specific frontmatter field from a file.
 * Returns null if the field doesn't exist or frontmatter is missing.
 */
export async function readFrontmatterField(
	app: App,
	file: TFile,
	field: string
): Promise<unknown> {
	// Use Obsidian's metadata cache for reading (faster, no file I/O)
	const metadata = app.metadataCache.getFileCache(file);
	return metadata?.frontmatter?.[field] ?? null;
}
