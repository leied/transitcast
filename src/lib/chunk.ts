/** Rough conversion between characters of prose and minutes of speech. */
export const CHARS_PER_MINUTE = 900;

export function estimateMinutes(chars: number): number {
	return Math.round((chars / CHARS_PER_MINUTE) * 10) / 10;
}

/**
 * Split spoken text into TTS-sized pieces on sentence boundaries.
 *
 * MeloTTS doesn't document a maximum input length and fails opaquely when it's
 * unhappy, so this stays well clear of any limit. Smaller chunks cost nothing
 * extra — speech is billed per audio minute, not per request — and they make a
 * single upstream failure cheaper to retry or skip.
 *
 * Splitting on sentences rather than a hard character count matters: a cut
 * mid-sentence is audible as a swallowed word at the seam.
 */
export function chunkForTts(text: string, max = 480): string[] {
	const clean = text.replace(/\s+/g, ' ').trim();
	if (!clean) return [];
	if (clean.length <= max) return [clean];

	// Keep the delimiter attached to the sentence it ends.
	const sentences = clean.match(/[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g) ?? [clean];
	const out: string[] = [];
	let current = '';

	for (const sentence of sentences) {
		const s = sentence.trim();
		if (!s) continue;

		if (s.length > max) {
			// A single sentence longer than the budget — fall back to commas,
			// then to a hard cut, so we never emit an oversized chunk.
			if (current) {
				out.push(current);
				current = '';
			}
			let rest = s;
			while (rest.length > max) {
				const window = rest.slice(0, max);
				const at = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
				const cut = at > max * 0.4 ? at + 1 : window.lastIndexOf(' ');
				const idx = cut > 0 ? cut : max;
				out.push(rest.slice(0, idx).trim());
				rest = rest.slice(idx).trim();
			}
			if (rest) current = rest;
			continue;
		}

		if (current && current.length + s.length + 1 > max) {
			out.push(current);
			current = s;
		} else {
			current = current ? `${current} ${s}` : s;
		}
	}

	if (current) out.push(current);
	return out;
}
