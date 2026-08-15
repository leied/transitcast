import type { Config, Item, Section } from '$lib/types';
import { CHARS_PER_MINUTE } from '$lib/chunk';
import type { ChatMessage } from './llm';

const SYSTEM = `You write a personal spoken news brief. Your output is fed straight into a text-to-speech engine and listened to on a bus, so it must be written for the ear.

Hard rules:
- Plain spoken prose only. No markdown, no bullet points, no headings, no emoji, no URLs, no parentheticals.
- Write numbers, dates and symbols the way they should be said out loud: "twenty twenty six", "about three hundred million dollars", "twelve percent".
- Expand abbreviations the first time unless they are always said as letters.
- Never state a fact that is not in the supplied items. If an item is thin, say less rather than guessing.
- Attribute contested claims to whoever reported them.
- No sign-offs, no "stay tuned", no filler transitions like "in other news" unless it genuinely reads well.`;

function ageLabel(published: string | null, now: number): string {
	if (!published) return 'undated';
	const hours = Math.round((now - new Date(published).getTime()) / 3600_000);
	if (hours < 1) return 'just now';
	if (hours === 1) return '1h ago';
	return `${hours}h ago`;
}

export function buildSectionMessages(
	cfg: Config,
	section: Section,
	items: Item[],
	now = Date.now()
): ChatMessage[] {
	const targetChars = Math.round(section.minutes * CHARS_PER_MINUTE);

	const list = items
		.map(
			(it, i) =>
				`${i} | ${it.feedName} | ${ageLabel(it.published, now)} | ${it.title}${
					it.summary ? ` — ${it.summary}` : ''
				}`
		)
		.join('\n');

	const today = new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
		timeZone: cfg.timezone
	}).format(new Date(now));

	return [
		{ role: 'system', content: SYSTEM },
		{
			role: 'user',
			content: `LISTENER
${cfg.about}

TODAY
${today}

SECTION
${section.title}

EDITORIAL DIRECTION
${section.prompt}

TARGET
About ${section.minutes} minute${section.minutes === 1 ? '' : 's'} of speech, roughly ${targetChars} characters across all segments combined.

ITEMS
${list || '(no items)'}

Return JSON shaped exactly like:
{"segments":[{"title":"three or four word label","text":"the spoken prose","sources":[0,3]}]}

- "sources" holds the indexes of the items a segment draws on.
- Merge items covering the same story into a single segment.
- Cut anything not worth the listener's time. Fewer, better segments is the goal — returning two strong segments beats six weak ones.
- If nothing here is worth airing today, return {"segments":[]}. That is a valid and useful answer.`
		}
	];
}

