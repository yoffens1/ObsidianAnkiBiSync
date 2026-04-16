/**
 * parser.ts — Markdown file parser for Anki BiSync
 *
 * Parses frontmatter + ## heading sections from Obsidian markdown files.
 * Each ## Heading becomes one flashcard: Front = heading, Back = body.
 * Per-card metadata lines (`next_review: ...`, `reviewed: N times`) are
 * extracted and stripped from the Back content before sending to Anki.
 */

import { extractMOCName, generateCardID, slugify, deduplicateSlug } from './utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedCard {
	/** Raw heading text (without ##) */
	heading: string;
	/** Slugified heading for CardID generation */
	headingSlug: string;
	/** Full CardID: {filename_slug}::{heading_slug} */
	cardID: string;
	/** Body text WITH per-card metadata lines stripped — sent to Anki as Back */
	body: string;
	/** Body text as it appears in the file (including metadata lines) */
	rawBody: string;
	/** 1-indexed line number where the ## heading line is */
	headingLine: number;
	/** 1-indexed line number where the body content starts (line after heading) */
	bodyStartLine: number;
	/** 1-indexed line number of the last line of this section (inclusive) */
	endLine: number;
}

export interface ParsedFile {
	/** Parsed frontmatter as key-value map */
	frontmatter: Record<string, unknown>;
	/** All flashcard sections */
	cards: ParsedCard[];
	/** Tags from frontmatter `tags:` field */
	tags: string[];
	/** MOC name extracted from parent field (null if missing/doesn't match) */
	parentMOC: string | null;
	/** Resolved Anki deck name */
	deckName: string;
	/** Line number where frontmatter ends (the closing ---), 1-indexed */
	frontmatterEndLine: number;
}

// ─── Frontmatter Parsing ─────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter, frontmatterEndLine, bodyContent }.
 */
function extractFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	frontmatterEndLine: number;
	bodyContent: string;
	bodyStartLine: number;
} {
	const lines = content.split('\n');

	// Check if file starts with frontmatter delimiter
	if (lines[0]?.trim() !== '---') {
		return { frontmatter: {}, frontmatterEndLine: 0, bodyContent: content, bodyStartLine: 1 };
	}

	// Find the closing ---
	let closingIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === '---') {
			closingIdx = i;
			break;
		}
	}

	if (closingIdx === -1) {
		// No closing delimiter found — no frontmatter
		return { frontmatter: {}, frontmatterEndLine: 0, bodyContent: content, bodyStartLine: 1 };
	}

	const yamlLines = lines.slice(1, closingIdx);
	const frontmatter = parseSimpleYaml(yamlLines.join('\n'));

	const bodyStartLine = closingIdx + 2; // 1-indexed, line after closing ---
	const bodyContent = lines.slice(closingIdx + 1).join('\n');

	return { frontmatter, frontmatterEndLine: closingIdx + 1, bodyContent, bodyStartLine };
}

/**
 * Minimal YAML parser supporting the subset used in Obsidian frontmatter.
 * Handles: string values, arrays (- item), booleans, numbers, quoted strings.
 * Not a full YAML parser — handles common Obsidian patterns only.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = yaml.split('\n');
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? '';
		// Skip blank lines and comments
		if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

		// Key: value
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) { i++; continue; }

		const key = line.slice(0, colonIdx).trim();
		const rawValue = line.slice(colonIdx + 1).trim();

		if (rawValue === '' || rawValue === null) {
			// Could be a block — check next lines for array items
			const items: string[] = [];
			i++;
			while (i < lines.length && (lines[i] ?? '').match(/^\s*-\s/)) {
				const item = (lines[i] ?? '').replace(/^\s*-\s*/, '').trim();
				items.push(unquoteYamlString(item));
				i++;
			}
			result[key] = items.length > 0 ? items : null;
		} else {
			result[key] = parseYamlValue(rawValue);
			i++;
		}
	}

	return result;
}

function parseYamlValue(raw: string): unknown {
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	if (raw === 'null' || raw === '~') return null;
	if (/^\d+$/.test(raw)) return parseInt(raw, 10);
	if (/^\d+\.\d+$/.test(raw)) return parseFloat(raw);
	// Inline array: [a, b, c]
	if (raw.startsWith('[') && raw.endsWith(']')) {
		const inner = raw.slice(1, -1).trim();
		if (inner === '') return [];
		return inner.split(',').map((s) => unquoteYamlString(s.trim()));
	}
	return unquoteYamlString(raw);
}

function unquoteYamlString(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

// ─── Tag Extraction ───────────────────────────────────────────────────────────

function extractTags(frontmatter: Record<string, unknown>): string[] {
	const tagsRaw = frontmatter['tags'];
	if (!tagsRaw) return [];
	if (Array.isArray(tagsRaw)) {
		return tagsRaw.map((t) => String(t)).filter((t) => t.length > 0);
	}
	if (typeof tagsRaw === 'string' && tagsRaw.trim()) {
		return [tagsRaw.trim()];
	}
	return [];
}

// ─── Per-card Metadata Extraction ────────────────────────────────────────────

const NEXT_REVIEW_RE = /^`next_review:\s*(.+?)`\s*$/m;
const REVIEWED_RE = /^`reviewed:\s*(\d+)\s*times?\s*`\s*$/m;

function extractCardMetadata(rawBody: string): {
	cleanBody: string;
} {
	let cleanBody = rawBody;

	cleanBody = cleanBody.replace(NEXT_REVIEW_RE, '');
	cleanBody = cleanBody.replace(REVIEWED_RE, '');

	// Trim trailing whitespace / blank lines from clean body
	cleanBody = cleanBody.replace(/\n+$/, '').trimEnd();

	return { cleanBody };
}

// ─── Section Splitting ────────────────────────────────────────────────────────

/**
 * Test whether a line starts a new ## heading (but not ### or deeper).
 */
function isH2Line(line: string): boolean {
	return /^## /.test(line);
}

/**
 * Check if a line position is inside a fenced code block.
 * Returns the set of line indices (0-based) that are inside code fences.
 */
function buildCodeBlockSet(lines: string[]): Set<number> {
	const inCode = new Set<number>();
	let inFence = false;
	let fenceChar = '';

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
		if (!inFence && fenceMatch) {
			inFence = true;
			fenceChar = fenceMatch[1] ?? '```';
			inCode.add(i);
		} else if (inFence) {
			inCode.add(i);
			if (line.startsWith(fenceChar) && line.trim() === fenceChar) {
				inFence = false;
				fenceChar = '';
			}
		}
	}
	return inCode;
}

// ─── Main Parser ──────────────────────────────────────────────────────────────

/**
 * Parse an entire markdown file into structured frontmatter + flashcard sections.
 *
 * @param content     Full file content as a string
 * @param filename    Filename without .md extension (used for CardID + tag generation)
 * @param defaultDeck Fallback deck name if no parent MOC found
 */
export function parseMarkdownFile(
	content: string,
	filename: string,
	defaultDeck: string
): ParsedFile {
	const { frontmatter, frontmatterEndLine, bodyContent, bodyStartLine } =
		extractFrontmatter(content);

	const tags = extractTags(frontmatter);

	const parentRaw = frontmatter['parent'];
	const parentStr = typeof parentRaw === 'string' ? parentRaw : '';
	const parentMOC = parentStr ? extractMOCName(parentStr) : null;
	// Use defaultDeck strictly (which sync-engine dynamically sets to the folder path)
	const deckName = defaultDeck;

	// Split body into lines, tracking global line numbers
	const bodyLines = bodyContent.split('\n');
	const codeBlockLines = buildCodeBlockSet(bodyLines);

	// Find all ## heading positions (not inside code blocks)
	const headingPositions: number[] = [];
	for (let i = 0; i < bodyLines.length; i++) {
		if (!codeBlockLines.has(i) && isH2Line(bodyLines[i] ?? '')) {
			headingPositions.push(i);
		}
	}

	const cards: ParsedCard[] = [];
	const usedSlugs = new Set<string>();
	const filenameSlug = slugify(filename);

	for (let hi = 0; hi < headingPositions.length; hi++) {
		const hLineIdx = headingPositions[hi] ?? 0;
		const globalHeadingLine = bodyStartLine + hLineIdx; // 1-indexed

		const headingText = (bodyLines[hLineIdx] ?? '').replace(/^## /, '').trim();

		// Skip empty headings
		if (!headingText) {
			console.warn(`[AnkiBiSync] Skipping empty ## heading at line ${globalHeadingLine}`);
			continue;
		}

		// Determine section end (exclusive): next heading or end of body
		const nextHLineIdx =
			hi + 1 < headingPositions.length
				? (headingPositions[hi + 1] ?? bodyLines.length)
				: bodyLines.length;

		const sectionBodyLines = bodyLines.slice(hLineIdx + 1, nextHLineIdx);
		const rawBody = sectionBodyLines.join('\n');

		// Skip whitespace-only bodies
		if (!rawBody.trim()) {
			console.warn(
				`[AnkiBiSync] Skipping heading "${headingText}" — empty answer at line ${globalHeadingLine}`
			);
			continue;
		}

		// Extract and strip per-card metadata
		const { cleanBody } = extractCardMetadata(rawBody);

		// Generate unique slug
		const baseSlug = slugify(headingText);
		const headingSlug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(headingSlug);

		const cardID = `${filenameSlug}::${headingSlug}`;

		const bodyStartLineGlobal = globalHeadingLine + 1;
		const endLineGlobal = bodyStartLine + nextHLineIdx - 1;

		cards.push({
			heading: headingText,
			headingSlug,
			cardID,
			body: cleanBody.trim(),
			rawBody,
			headingLine: globalHeadingLine,
			bodyStartLine: bodyStartLineGlobal,
			endLine: endLineGlobal,
		});
	}

	return {
		frontmatter,
		cards,
		tags,
		parentMOC,
		deckName,
		frontmatterEndLine,
	};
}

// ─── Re-serialization Helpers ─────────────────────────────────────────────────

// (Removed buildCardMetadataBlock since we are discarding inline metadata generation)

/**
 * Serialize frontmatter back to YAML string.
 * Preserves ordering of known fields.
 */
export function serializeFrontmatter(fm: Record<string, unknown>): string {
	const lines: string[] = ['---'];

	for (const [key, val] of Object.entries(fm)) {
		if (val === null || val === undefined) {
			lines.push(`${key}:`);
		} else if (Array.isArray(val)) {
			lines.push(`${key}:`);
			for (const item of val) {
				lines.push(`  - ${item}`);
			}
		} else if (typeof val === 'boolean') {
			lines.push(`${key}: ${val}`);
		} else if (typeof val === 'number') {
			lines.push(`${key}: ${val}`);
		} else {
			const str = String(val);
			// Quote strings containing special YAML characters
			if (/[:#\[\]{}|>&*!,]/.test(str) || str.includes('"')) {
				lines.push(`${key}: "${str.replace(/"/g, '\\"')}"`);
			} else {
				lines.push(`${key}: ${str}`);
			}
		}
	}

	lines.push('---');
	return lines.join('\n');
}
