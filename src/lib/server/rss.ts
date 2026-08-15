import { XMLParser } from 'fast-xml-parser';
import type { Feed, FeedResult, Item } from '$lib/types';

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	trimValues: true,
	// Feeds are wildly inconsistent about whether a single item is an array.
	isArray: (name) => name === 'item' || name === 'entry'
});

/** FNV-1a. Not security-relevant — this only has to be stable across days. */
function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	hellip: '…',
	mdash: '—',
	ndash: '–',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”'
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
		if (entity[0] === '#') {
			const code =
				entity[1] === 'x' || entity[1] === 'X'
					? parseInt(entity.slice(2), 16)
					: parseInt(entity.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: match;
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

function stripHtml(input: unknown, max = 600): string {
	if (input == null) return '';
	let s = String(typeof input === 'object' ? ((input as { '#text'?: string })['#text'] ?? '') : input);
	s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
	s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
	s = s.replace(/<[^>]+>/g, ' ');
	// Twice, because feeds routinely ship double-encoded entities (&amp;#8217;).
	// The second pass also catches tags revealed by the first, so strip again.
	s = decodeEntities(decodeEntities(s)).replace(/<[^>]+>/g, ' ');
	s = s.replace(/\s+/g, ' ').trim();
	return s.length > max ? s.slice(0, max).replace(/\s\S*$/, '') + '…' : s;
}

function text(v: unknown): string {
	if (v == null) return '';
	if (typeof v === 'string') return v.trim();
	if (typeof v === 'number') return String(v);
	if (typeof v === 'object') {
		const o = v as Record<string, unknown>;
		if (typeof o['#text'] === 'string') return o['#text'].trim();
	}
	return '';
}

/** Atom links are attribute-shaped and often several per entry. */
function pickLink(raw: Record<string, unknown>): string {
	const link = raw.link;
	if (typeof link === 'string') return link.trim();
	if (Array.isArray(link)) {
		const alt = link.find(
			(l) => typeof l === 'object' && l && ((l as never)['@_rel'] ?? 'alternate') === 'alternate'
		);
		const chosen = (alt ?? link[0]) as Record<string, unknown> | undefined;
		return String(chosen?.['@_href'] ?? '').trim();
	}
	if (link && typeof link === 'object') {
		const o = link as Record<string, unknown>;
		return String(o['@_href'] ?? o['#text'] ?? '').trim();
	}
	// RSS sometimes only carries a permalink guid.
	const guid = raw.guid;
	if (guid && typeof guid === 'object' && (guid as never)['@_isPermaLink'] !== 'false') {
		return text(guid);
	}
	return typeof guid === 'string' ? guid.trim() : '';
}

function parseDate(raw: Record<string, unknown>): Date | null {
	for (const key of ['pubDate', 'published', 'updated', 'dc:date', 'date']) {
		const v = text(raw[key]);
		if (!v) continue;
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) return d;
	}
	return null;
}

export type FetchFeedOptions = {
	windowHours: number;
	/** Hard cap on items returned, newest first, to keep payloads small. */
	limit?: number;
	signal?: AbortSignal;
};

export async function fetchFeed(feed: Feed, opts: FetchFeedOptions): Promise<FeedResult> {
	const base: FeedResult = { feedId: feed.id, name: feed.name, items: [] };
	let xml: string;

	try {
		const res = await fetch(feed.url, {
			signal: opts.signal,
			headers: {
				// Publishers behind bot protection (the Seattle Times among them)
				// 403 anything that self-identifies as a crawler, so present as an
				// ordinary browser. Feeds are published to be read.
				'user-agent':
					'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
				accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
				'accept-language': 'en-US,en;q=0.9'
			}
		});
		if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
		xml = await res.text();
	} catch (e) {
		return { ...base, error: e instanceof Error ? e.message : 'fetch failed' };
	}

	let raw: Record<string, unknown>;
	try {
		raw = parser.parse(xml) as Record<string, unknown>;
	} catch {
		return { ...base, error: 'unparseable XML' };
	}

	const channel =
		((raw.rss as Record<string, unknown>)?.channel as Record<string, unknown>) ??
		(raw.feed as Record<string, unknown>) ??
		((raw['rdf:RDF'] as Record<string, unknown>) ?? {});

	const entries = [
		...((channel.item as Record<string, unknown>[] | undefined) ?? []),
		...((channel.entry as Record<string, unknown>[] | undefined) ?? []),
		// RDF/RSS 1.0 puts items as siblings of channel.
		...(((raw['rdf:RDF'] as Record<string, unknown>)?.item as Record<string, unknown>[]) ?? [])
	];

	if (entries.length === 0) return { ...base, error: 'no items in feed' };

	const cutoff = Date.now() - opts.windowHours * 3600_000;
	const items: Item[] = [];

	for (const raw of entries) {
		const title = stripHtml(raw.title, 300);
		if (!title) continue;

		const published = parseDate(raw);
		// Undated items are kept — some feeds omit dates entirely, and dropping
		// them would silently empty those sources. The LLM gets told they're undated.
		if (published && published.getTime() < cutoff) continue;

		const link = pickLink(raw);
		const summary = stripHtml(
			raw['content:encoded'] ?? raw.description ?? raw.summary ?? raw.content ?? ''
		);

		items.push({
			hash: hash(`${title.toLowerCase()}|${link}`),
			feedId: feed.id,
			feedName: feed.name,
			title,
			link,
			summary,
			published: published ? published.toISOString() : null
		});
	}

	items.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
	return { ...base, items: items.slice(0, opts.limit ?? 25) };
}
