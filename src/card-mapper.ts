/**
 * card-mapper.ts — Maps between ParsedCard (MD) and Anki note structures
 */

import { AddNoteParams, NoteInfo } from './anki-connect';
import { ParsedCard, ParsedFile } from './parser';
import { sanitizeFilenameTag } from './utils';
import { AnkiBiSyncSettings } from './settings';

export interface FieldDiff {
	frontChanged: boolean;
	backChanged: boolean;
	tagsChanged: boolean;
	sourceChanged: boolean;
	newFront: string;
	newBack: string;
	newTags: string[];
	newSource: string;
}

/**
 * Build the Anki note creation params from a parsed card.
 *
 * @param card       Parsed card from MD
 * @param parsed     Parsed file context (for deck, tags)
 * @param vaultName  Obsidian vault name
 * @param filePath   Vault-relative file path (e.g. "Notes/Linux/Processes.md")
 * @param modelName  Anki note model name
 */
export function buildAnkiNote(
	card: ParsedCard,
	parsed: ParsedFile,
	vaultName: string,
	filePath: string,
	modelName: string,
	settings: AnkiBiSyncSettings
): AddNoteParams {
	const tags = buildTags(parsed.tags, filePath, card.heading, settings);
	const source = buildSourceField(parsed, vaultName, filePath);

	return {
		deckName: parsed.deckName,
		modelName,
		fields: {
			Front: card.heading,
			Back: card.body,
			Source: source,
			ObsidianPath: filePath,
			CardID: card.cardID,
		},
		tags,
		options: {
			allowDuplicate: true,
			duplicateScope: 'deck',
			duplicateScopeOptions: {
				deckName: parsed.deckName,
				checkChildren: false,
				checkAllModels: false,
			},
		},
	};
}

/**
 * Construct the unified Source field containing path, aliases, and sources metadata.
 */
export function buildSourceField(parsed: ParsedFile, vaultName: string, filePath: string): string {
	let sourceData = '';
	if (parsed.frontmatter) {
		const sourcesRaw = parsed.frontmatter['sources'];
		const aliasesRaw = parsed.frontmatter['aliases'];
		
		if (sourcesRaw) {
			const sourceStr = Array.isArray(sourcesRaw) ? sourcesRaw.join(', ') : String(sourcesRaw);
			if (sourceStr && sourceStr !== '[]') sourceData += `<br><b>Sources:</b> ${sourceStr}`;
		}
		if (aliasesRaw) {
			const aliasStr = Array.isArray(aliasesRaw) ? aliasesRaw.join(', ') : String(aliasesRaw);
			if (aliasStr && aliasStr !== '[]') sourceData += `<br><b>Aliases:</b> ${aliasStr}`;
		}
	}
	return sourceData ? `${vaultName}::${filePath}${sourceData}` : `${vaultName}::${filePath}`;
}

/**
 * Build the tag array for an Anki card.
 * Combines tags from various sources based on user settings.
 */
export function buildTags(
	frontmatterTags: string[], 
	filePath: string, 
	heading: string,
	settings: AnkiBiSyncSettings
): string[] {
	const allTags = new Set<string>();

	if (settings.tagFromMeta) {
		for (const tag of frontmatterTags) {
			if (tag.trim()) allTags.add(tag.trim());
		}
	}
	
	if (settings.tagFromFolder) {
		const dirStr = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
		if (dirStr && dirStr !== '/') {
			const folderParts = dirStr.split('/');
			for (const fp of folderParts) {
				const sanitized = sanitizeFilenameTag(fp);
				if (sanitized) allTags.add(sanitized);
			}
		}
	}

	if (settings.tagFromFile) {
		const fileName = filePath.split('/').pop()?.replace(/\.md$/, '');
		if (fileName) {
			const sanitized = sanitizeFilenameTag(fileName);
			if (sanitized) allTags.add(sanitized);
		}
	}
	
	if (settings.tagFromHeading) {
		const sanitized = sanitizeFilenameTag(heading);
		if (sanitized) allTags.add(sanitized);
	}
	
	return Array.from(allTags);
}

/**
 * Compare an existing Anki note's fields with the current local card.
 * Returns what has changed and the new values.
 */
export function compareNoteFields(
	ankiNote: NoteInfo,
	card: ParsedCard,
	parsed: ParsedFile,
	filePath: string,
	vaultName: string,
	settings: AnkiBiSyncSettings
): FieldDiff {
	const ankiFront = ankiNote.fields['Front']?.value ?? '';
	const ankiBack = ankiNote.fields['Back']?.value ?? '';
	const ankiTags = new Set(ankiNote.tags);
	const ankiSource = ankiNote.fields['Source']?.value ?? '';

	const newTags = buildTags(parsed.tags, filePath, card.heading, settings);
	const newTagSet = new Set(newTags);
	const newSource = buildSourceField(parsed, vaultName, filePath);

	const tagsChanged =
		newTags.some((t) => !ankiTags.has(t)) ||
		Array.from(ankiTags).some((t) => !newTagSet.has(t));

	return {
		frontChanged: ankiFront.trim() !== card.heading.trim(),
		backChanged: ankiBack.trim() !== card.body.trim(),
		tagsChanged,
		sourceChanged: ankiSource.trim() !== newSource.trim(),
		newFront: card.heading,
		newBack: card.body,
		newTags,
		newSource,
	};
}

/**
 * Determine conflict resolution strategy.
 * Returns "anki" if Anki's version is newer, "obsidian" if obsidian is newer.
 *
 * @param ankiMod      Anki note mod field (unix timestamp)
 * @param fileMtimeSec File modification time in seconds since epoch
 * @param lastSynced   lastAnkiSynced timestamp from frontmatter (unix seconds)
 */
export function resolveConflict(
	ankiMod: number,
	fileMtimeSec: number,
	lastSynced: number
): 'anki' | 'obsidian' {
	// If Anki was modified after the last sync and the file was also modified after last sync,
	// pick whichever is more recent.
	const ankiModifiedAfterSync = ankiMod > lastSynced;
	const fileModifiedAfterSync = fileMtimeSec > lastSynced;

	if (ankiModifiedAfterSync && fileModifiedAfterSync) {
		// Both changed — most recent wins
		return ankiMod > fileMtimeSec ? 'anki' : 'obsidian';
	}
	if (ankiModifiedAfterSync) return 'anki';
	return 'obsidian';
}

