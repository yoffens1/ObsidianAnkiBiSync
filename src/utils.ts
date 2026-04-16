/**
 * utils.ts — Shared utility helpers for Anki BiSync
 */

/**
 * Slugify a string: lowercase, spaces → hyphens, strip non-alphanumeric.
 */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/\s+/g, '-')
		.replace(/[^a-zA-Z0-9-]/g, '');
}

/**
 * Generate a stable CardID for a given filename and heading.
 * Format: {filename_slug}::{heading_slug}
 */
export function generateCardID(filenameWithoutExt: string, heading: string): string {
	return `${slugify(filenameWithoutExt)}::${slugify(heading)}`;
}

/**
 * Sanitize a filename (without .md) into an Anki-compatible tag.
 * Spaces → underscores, special chars stripped.
 */
export function sanitizeFilenameTag(filenameWithoutExt: string): string {
	return filenameWithoutExt
		.replace(/\s+/g, '_')
		.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Extract MOC name from parent field value.
 * e.g. "[[MOC Linux]]" → "Linux"
 * Returns null if the pattern doesn't match.
 */
export function extractMOCName(parentField: string): string | null {
	const match = /\[\[MOC\s+(.+?)\]\]/.exec(parentField);
	return match?.[1]?.trim() ?? null;
}

/**
 * Format a Date as YYYY-MM-DD string.
 */
export function formatDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

/**
 * Parse a YYYY-MM-DD string into a Date.
 */
export function parseDate(dateStr: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
	if (!match) return null;
	const [, y, m, d] = match;
	if (y === undefined || m === undefined || d === undefined) return null;
	return new Date(Number(y), Number(m) - 1, Number(d));
}

/**
 * Ensure a slug is unique by appending -2, -3, etc. if it already exists.
 */
export function deduplicateSlug(slug: string, existing: Set<string>): string {
	if (!existing.has(slug)) return slug;
	let i = 2;
	while (existing.has(`${slug}-${i}`)) i++;
	return `${slug}-${i}`;
}

/**
 * Calculate next review date from Anki card scheduling data.
 * Anki review cards store `due` as a day offset from the collection creation date.
 * Learning/new cards store it as an epoch timestamp in seconds.
 * We use a best-effort calculation since AnkiConnect doesn't expose the collection epoch.
 *
 * @param due - Card due field
 * @param type - Card type: 0=new, 1=learning, 2=review, 3=relearning
 * @param interval - Card interval in days (for review cards)
 * @param mod - Card mod field (last modification, unix timestamp)
 */
export function calculateNextReviewDate(
	due: number,
	type: number,
	interval: number,
	mod: number
): Date {
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	if (type === 0) {
		// New card — not scheduled yet
		return today;
	} else if (type === 1 || type === 3) {
		// Learning or relearning — due is unix timestamp in seconds
		const d = new Date(due * 1000);
		d.setHours(0, 0, 0, 0);
		return d;
	} else {
		// Review card (type === 2) — due is an offset from collection creation.
		// Best estimate: use the mod timestamp as a recent reference point and add interval.
		// This is approximate but sufficient for displaying next_review in the MD file.
		const modDate = new Date(mod * 1000);
		modDate.setHours(0, 0, 0, 0);
		const nextDate = new Date(modDate);
		nextDate.setDate(nextDate.getDate() + interval);
		// If the computed date is in the past, fall back to today
		return nextDate >= today ? nextDate : today;
	}
}

/**
 * Simple debounce function.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<T extends (...args: any[]) => unknown>(
	fn: T,
	ms: number
): (...args: Parameters<T>) => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return function (...args: Parameters<T>) {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			fn(...args);
			timer = null;
		}, ms);
	};
}

/**
 * Simple async mutex to prevent concurrent syncs.
 */
export class Mutex {
	private locked = false;
	private queue: Array<() => void> = [];

	async acquire(): Promise<() => void> {
		return new Promise((resolve) => {
			const tryAcquire = () => {
				if (!this.locked) {
					this.locked = true;
					resolve(() => this.release());
				} else {
					this.queue.push(tryAcquire);
				}
			};
			tryAcquire();
		});
	}

	private release(): void {
		const next = this.queue.shift();
		if (next) {
			next();
		} else {
			this.locked = false;
		}
	}
}
